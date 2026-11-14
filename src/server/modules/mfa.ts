import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { decryptSecret, encryptSecret, generateSecret, otpauthUri, verifyTotp } from "../totp";
import { assertExecutive } from "./access";
import { parseOrThrow } from "./identity";
import { brandName, hashToken, writeAudit } from "./shared";

/**
 * Authenticator-app MFA.
 *
 * Model: a session belonging to an MFA-enrolled user stays unusable (reported as "pending") until the
 * second factor is verified for that session. So any usable session of an enrolled user is verified, and
 * the privileged-role checks only need to know whether the user is enrolled.
 * Users who hold privileged roles must enroll wherever MFA enforcement is on (always in production).
 */

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const RECOVERY_CODE_COUNT = 10;

const codeSchema = z.string().trim().min(6).max(20);

type UserRow = {
  id: string;
  email: string;
  mfa_secret_enc: string | null;
  mfa_pending_secret_enc: string | null;
  mfa_last_step: string | null;
  mfa_failed_attempts: number;
  mfa_locked_until: Date | null;
};

async function loadUser(tx: Tx, userId: string, forUpdate = true): Promise<UserRow> {
  const rows = await tx.query<UserRow>(
    `SELECT id, email, mfa_secret_enc, mfa_pending_secret_enc, mfa_last_step::text AS mfa_last_step,
            mfa_failed_attempts, mfa_locked_until
       FROM users WHERE id = $1 AND status = 'ACTIVE' ${forUpdate ? "FOR UPDATE" : ""}`,
    [userId],
  );
  if (!rows.length) throw new AppError("FORBIDDEN", "Account not available.");
  return rows[0];
}

function newRecoveryCode(): string {
  const raw = randomBytes(8).toString("hex").slice(0, 10); // 40 bits
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

function normalizeRecovery(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, "");
}

export type MfaStatus = { enrolled: boolean; recoveryCodesRemaining: number };

export async function getMfaStatus(driver: Driver, userId: string): Promise<MfaStatus> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    const u = await loadUser(tx, userId, false);
    const n = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    return { enrolled: u.mfa_secret_enc !== null, recoveryCodesRemaining: n[0].n };
  });
}

/** Starts (or restarts) enrollment: stores a pending secret and returns what the authenticator app needs. */
export async function beginMfaEnrollment(driver: Driver, userId: string): Promise<{ secret: string; uri: string }> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    const u = await loadUser(tx, userId);
    if (u.mfa_secret_enc) throw new AppError("CONFLICT", "Multi-factor authentication is already set up for this account.");
    const secret = generateSecret();
    await tx.query(`UPDATE users SET mfa_pending_secret_enc = $2 WHERE id = $1`, [userId, encryptSecret(secret)]);
    return { secret, uri: otpauthUri({ secret, account: u.email, issuer: brandName() }) };
  });
}

async function checkLock(u: UserRow): Promise<void> {
  if (u.mfa_locked_until && u.mfa_locked_until > new Date()) {
    throw new AppError("RATE_LIMITED", "Too many incorrect codes. Try again in a few minutes.");
  }
}

/** Counts a failure in its own committed transaction so a rolled-back request cannot reset the counter. */
async function recordFailure(driver: Driver, userId: string, action: string): Promise<void> {
  await runIn(driver, { kind: "system" }, async (tx) => {
    const r = await tx.query<{ mfa_failed_attempts: number }>(
      `UPDATE users SET mfa_failed_attempts = mfa_failed_attempts + 1,
              mfa_locked_until = CASE WHEN mfa_failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE mfa_locked_until END
        WHERE id = $1 RETURNING mfa_failed_attempts`,
      [userId, MAX_FAILURES, LOCK_MINUTES],
    );
    await writeAudit(tx, { actorUserId: userId, action, subjectType: "user", subjectId: userId, details: { failures: r[0]?.mfa_failed_attempts } });
  });
}

/** Confirms enrollment with the first code, activates MFA, and returns single-use recovery codes (shown once). */
export async function confirmMfaEnrollment(driver: Driver, userId: string, sessionToken: string, rawCode: unknown): Promise<string[]> {
  const code = parseOrThrow(codeSchema, rawCode);
  let failed = false;
  let result: string[] = [];
  try {
    result = await runIn(driver, { kind: "system" }, async (tx) => {
      const u = await loadUser(tx, userId);
      await checkLock(u);
      if (u.mfa_secret_enc) throw new AppError("CONFLICT", "Multi-factor authentication is already set up for this account.");
      if (!u.mfa_pending_secret_enc) throw new AppError("VALIDATION", "Start setup again to get a new QR code.");
      const step = verifyTotp(decryptSecret(u.mfa_pending_secret_enc), code);
      if (step === null) {
        failed = true;
        return [];
      }
      const session = await tx.query<{ id: string }>(
        `SELECT id FROM sessions WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
        [hashToken(sessionToken), userId],
      );
      if (!session.length) throw new AppError("UNAUTHENTICATED", "Sign in again.");
      await tx.query(
        `UPDATE users SET mfa_secret_enc = mfa_pending_secret_enc, mfa_pending_secret_enc = NULL, mfa_enrolled_at = now(),
                mfa_last_step = $2, mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = $1`,
        [userId, step],
      );
      await tx.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
      for (const c of codes) {
        await tx.query(`INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [userId, hashToken(normalizeRecovery(c))]);
      }
      // Other sessions pre-date the second factor: end them. This one is verified now.
      await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [userId, session[0].id]);
      await tx.query(`UPDATE sessions SET mfa_verified_at = now() WHERE id = $1`, [session[0].id]);
      await writeAudit(tx, { actorUserId: userId, action: "MFA_ENROLLED", subjectType: "user", subjectId: userId });
      return codes;
    });
  } catch (err) {
    throw fromDbError(err);
  }
  if (failed) {
    await recordFailure(driver, userId, "MFA_ENROLL_CODE_REJECTED");
    throw new AppError("VALIDATION", "That code is not correct. Check the app and try again.", { code: ["Incorrect code"] });
  }
  return result;
}

/** Completes the sign-in second step for the session: a current authenticator code or a recovery code. */
export async function verifyMfaChallenge(driver: Driver, sessionToken: string, rawCode: unknown): Promise<void> {
  const code = parseOrThrow(codeSchema, rawCode);
  let failedUser: string | null = null;
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const s = await tx.query<{ id: string; user_id: string; mfa_verified_at: Date | null }>(
        `SELECT id, user_id, mfa_verified_at FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [hashToken(sessionToken)],
      );
      if (!s.length) throw new AppError("UNAUTHENTICATED", "Sign in again.");
      if (s[0].mfa_verified_at) return;
      const u = await loadUser(tx, s[0].user_id);
      await checkLock(u);
      if (!u.mfa_secret_enc) throw new AppError("VALIDATION", "Multi-factor authentication is not set up.");
      const last = u.mfa_last_step === null ? null : Number(u.mfa_last_step);
      const step = verifyTotp(decryptSecret(u.mfa_secret_enc), code, Date.now(), last);
      let ok = step !== null;
      let usedRecovery = false;
      if (!ok) {
        const used = await tx.query(
          `UPDATE mfa_recovery_codes SET used_at = now()
            WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
          [u.id, hashToken(normalizeRecovery(code))],
        );
        ok = used.length > 0;
        usedRecovery = ok;
      }
      if (!ok) {
        failedUser = u.id;
        return;
      }
      await tx.query(
        `UPDATE users SET mfa_failed_attempts = 0, mfa_locked_until = NULL, mfa_last_step = coalesce($2::bigint, mfa_last_step) WHERE id = $1`,
        [u.id, step],
      );
      await tx.query(`UPDATE sessions SET mfa_verified_at = now() WHERE id = $1`, [s[0].id]);
      await writeAudit(tx, { actorUserId: u.id, action: usedRecovery ? "MFA_RECOVERY_CODE_USED" : "MFA_VERIFIED", subjectType: "user", subjectId: u.id });
    });
  } catch (err) {
    throw fromDbError(err);
  }
  if (failedUser) {
    await recordFailure(driver, failedUser, "MFA_CODE_REJECTED");
    throw new AppError("VALIDATION", "That code is not correct.", { code: ["Incorrect code"] });
  }
}

/**
 * Lost device with no recovery codes: an executive removes the factor after verifying the person's
 * identity out of band. Ends all of that person's sessions; they must enroll again at next sign-in.
 */
export async function resetMfaForUser(driver: Driver, executiveId: string, targetUserId: unknown, reason: unknown): Promise<void> {
  const target = parseOrThrow(z.string().uuid(), targetUserId);
  const why = parseOrThrow(z.string().trim().min(5, "Record how identity was verified").max(2000), reason);
  if (target === executiveId) throw new AppError("FORBIDDEN", "Use a recovery code to regain access to your own account.");
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await assertExecutive(tx, executiveId);
      const r = await tx.query<{ id: string }>(
        `UPDATE users SET mfa_secret_enc = NULL, mfa_pending_secret_enc = NULL, mfa_enrolled_at = NULL, mfa_last_step = NULL,
                mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = $1 RETURNING id`,
        [target],
      );
      if (!r.length) throw new AppError("NOT_FOUND", "User not found.");
      await tx.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [target]);
      await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [target]);
      await writeAudit(tx, { actorUserId: executiveId, action: "MFA_RESET", subjectType: "user", subjectId: target, details: { reasonLength: why.length } });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}


/** Trusted operator path (server access required): same effect as resetMfaForUser without an executive session. */
export async function operatorResetMfa(driver: Driver, email: string, reason: string): Promise<void> {
  const why = parseOrThrow(z.string().trim().min(5).max(2000), reason);
  await runIn(driver, { kind: "system" }, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `UPDATE users SET mfa_secret_enc = NULL, mfa_pending_secret_enc = NULL, mfa_enrolled_at = NULL, mfa_last_step = NULL,
              mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE email = $1 RETURNING id`,
      [email.trim().toLowerCase()],
    );
    if (!r.length) throw new AppError("NOT_FOUND", "User not found.");
    await tx.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [r[0].id]);
    await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [r[0].id]);
    await writeAudit(tx, { actorUserId: null, action: "MFA_RESET_BY_OPERATOR", subjectType: "user", subjectId: r[0].id, details: { reasonLength: why.length } });
  });
}
