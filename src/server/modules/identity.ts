import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { ORG_TYPES } from "@/lib/domain";
import { appBaseUrl, enqueueEmail, hashToken, newToken, writeAudit } from "./shared";

/**
 * Identity module — DEV AUTH ADAPTER.
 * Email magic links + server-side sessions. This stands in for the managed
 * authentication provider (missing input M1) and MUST be replaced (with MFA for
 * privileged roles) before production. `assertDevAuthAllowed` enforces that.
 */

export const SESSION_TTL_HOURS = 12;
const EMAIL_CONFIRM_TTL_MIN = 60 * 24;
const SIGN_IN_TTL_MIN = 15;

export function assertDevAuthAllowed(): void {
  if (process.env.NODE_ENV === "production" && process.env.AUTH_PROVIDER !== "dev-magic-link-acknowledged-unsafe") {
    throw new Error("Dev magic-link auth is disabled in production. Configure the managed auth provider.");
  }
}

const serviceTypeCode = z.string().regex(/^[A-Z_]{2,40}$/, "Choose a service type");
export const serviceTypeList = z.preprocess(
  (v) => (v === undefined || v === "" ? [] : Array.isArray(v) ? v : [v]),
  z.array(serviceTypeCode).max(15),
);
export const checkbox = z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean());

export const registrationSchema = z.object({
  displayName: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2).max(200),
  orgType: z.enum(ORG_TYPES),
  contactName: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  website: z
    .string()
    .trim()
    .max(300)
    .regex(/^https?:\/\//, "Must start with http:// or https://")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  publicPhone: z.string().trim().max(40).optional(),
  description: z.string().trim().max(2000).optional(),
  registrationNotes: z.string().trim().min(10, "Tell us how we can verify your organization").max(2000),
  publicEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .max(254)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  primaryServiceType: serviceTypeCode,
  additionalServiceTypes: serviceTypeList,
  directoryConsent: checkbox,
});

export type RegistrationInput = z.infer<typeof registrationSchema>;

export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new AppError("VALIDATION", "Please correct the highlighted fields.", z.flattenError(r.error).fieldErrors as Record<string, string[]>);
  }
  return r.data;
}

async function upsertUser(tx: Tx, email: string, displayName: string): Promise<{ id: string; verified: boolean }> {
  const rows = await tx.query<{ id: string; email_verified_at: Date | null }>(
    `INSERT INTO users (email, display_name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email_verified_at`,
    [email, displayName],
  );
  return { id: rows[0].id, verified: rows[0].email_verified_at !== null };
}

async function issueToken(tx: Tx, userId: string, purpose: "EMAIL_CONFIRM" | "SIGN_IN", ttlMin: number, orgId?: string) {
  const token = newToken();
  await tx.query(
    `INSERT INTO auth_tokens (user_id, org_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
    [userId, orgId ?? null, purpose, hashToken(token), ttlMin],
  );
  return token;
}

/** Module C: organization registration. Creates PENDING_EMAIL org + ORG_ADMIN membership; queues confirmation email. */
export async function registerOrganization(driver: Driver, raw: unknown): Promise<{ orgId: string }> {
  const input = parseOrThrow(registrationSchema, raw);
  try {
    return await registerTx(driver, input);
  } catch (err) {
    throw fromDbError(err);
  }
}

async function registerTx(driver: Driver, input: RegistrationInput): Promise<{ orgId: string }> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    const user = await upsertUser(tx, input.email, input.contactName);
    const org = await tx.query<{ id: string }>(
      `INSERT INTO organizations (legal_name, display_name, org_type, contact_email, website, public_phone,
                                  description, registration_notes, created_by, public_email, requested_service_type,
                                  directory_consent_at, directory_consent_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $12 THEN now() END, CASE WHEN $12 THEN $9::uuid END)
       RETURNING id`,
      [
        input.legalName,
        input.displayName,
        input.orgType,
        input.email,
        input.website ?? null,
        input.publicPhone || null,
        input.description || null,
        input.registrationNotes,
        user.id,
        input.publicEmail ?? null,
        input.primaryServiceType,
        input.directoryConsent,
      ],
    );
    const orgId = org[0].id;
    const offered = Array.from(new Set([input.primaryServiceType, ...input.additionalServiceTypes]));
    await tx.query(
      `INSERT INTO organization_service_types (org_id, service_type) SELECT $1, unnest($2::text[])`,
      [orgId, offered],
    );
    await tx.query(
      `INSERT INTO organization_memberships (org_id, user_id, role, status) VALUES ($1, $2, 'ORG_ADMIN', 'INVITED')`,
      [orgId, user.id],
    );
    const token = await issueToken(tx, user.id, "EMAIL_CONFIRM", EMAIL_CONFIRM_TTL_MIN, orgId);
    await enqueueEmail(tx, {
      kind: "EMAIL_CONFIRM",
      to: input.email,
      subject: `Confirm your email for ${input.displayName}`,
      body:
        `Confirm your email to submit ${input.displayName} for verification:\n` +
        `${appBaseUrl()}/auth/confirm?token=${token}\n\nThis link expires in 24 hours. ` +
        `If you did not register, ignore this email.`,
    });
    await writeAudit(tx, {
      actorUserId: user.id,
      actorOrgId: orgId,
      action: "ORG_REGISTERED",
      subjectType: "organization",
      subjectId: orgId,
      details: { orgType: input.orgType },
    });
    return { orgId };
  });
}

async function consumeToken(tx: Tx, token: string, purpose: string) {
  const rows = await tx.query<{ id: string; user_id: string; org_id: string | null }>(
    `UPDATE auth_tokens SET consumed_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
      RETURNING id, user_id, org_id`,
    [hashToken(token), purpose],
  );
  if (rows.length === 0) throw new AppError("VALIDATION", "This link is invalid, expired, or has already been used.");
  const user = await tx.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [rows[0].user_id]);
  if (user[0]?.status !== "ACTIVE") throw new AppError("FORBIDDEN", "This account is disabled.");
  return rows[0];
}

async function createSession(tx: Tx, userId: string): Promise<string> {
  const token = newToken();
  await tx.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [userId, hashToken(token), SESSION_TTL_HOURS],
  );
  return token;
}

/** Consumes an email confirmation link: verifies email, moves org to PENDING_VERIFICATION, opens SOP-001, signs in. */
export async function confirmEmail(driver: Driver, token: string): Promise<{ sessionToken: string; userId: string }> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    const t = await consumeToken(tx, token, "EMAIL_CONFIRM");
    await tx.query(`UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`, [t.user_id]);
    if (t.org_id) {
      const moved = await tx.query<{ id: string }>(
        `UPDATE organizations SET status = 'PENDING_VERIFICATION' WHERE id = $1 AND status = 'PENDING_EMAIL' RETURNING id`,
        [t.org_id],
      );
      if (moved.length) {
        // Membership becomes active only once the registrant proves control of the email address.
        await tx.query(
          `UPDATE organization_memberships SET status = 'ACTIVE' WHERE org_id = $1 AND user_id = $2 AND status = 'INVITED'`,
          [t.org_id, t.user_id],
        );
        await tx.query(
          `INSERT INTO sop_executions (sop_code, subject_type, subject_id, initiated_by, due_at)
           VALUES ('SOP-001', 'organization', $1, $2, now() + interval '48 hours')`,
          [t.org_id, t.user_id],
        );
        await writeAudit(tx, {
          actorUserId: t.user_id,
          actorOrgId: t.org_id,
          action: "ORG_EMAIL_CONFIRMED",
          subjectType: "organization",
          subjectId: t.org_id,
        });
      }
    }
    return { sessionToken: await createSession(tx, t.user_id), userId: t.user_id };
  });
}

/** Always succeeds from the caller's perspective (no account enumeration). */
export async function requestSignIn(driver: Driver, rawEmail: unknown): Promise<void> {
  const email = parseOrThrow(z.string().trim().toLowerCase().email().max(254), rawEmail);
  await runIn(driver, { kind: "system" }, async (tx) => {
    const u = await tx.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1 AND status = 'ACTIVE' AND email_verified_at IS NOT NULL`,
      [email],
    );
    if (!u.length) return;
    const token = await issueToken(tx, u[0].id, "SIGN_IN", SIGN_IN_TTL_MIN);
    await enqueueEmail(tx, {
      kind: "SIGN_IN",
      to: email,
      subject: "Your ICS-LAS sign-in link",
      body: `Sign in: ${appBaseUrl()}/auth/callback?token=${token}\n\nThis link expires in ${SIGN_IN_TTL_MIN} minutes and works once.`,
    });
  });
}

export async function consumeSignIn(driver: Driver, token: string): Promise<{ sessionToken: string; userId: string }> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    const t = await consumeToken(tx, token, "SIGN_IN");
    await writeAudit(tx, { actorUserId: t.user_id, action: "SIGNED_IN", subjectType: "user", subjectId: t.user_id });
    return { sessionToken: await createSession(tx, t.user_id), userId: t.user_id };
  });
}

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  mfaEnrolled: boolean;
  platformRoles: string[];
};

export async function resolveSession(driver: Driver, sessionToken: string | undefined): Promise<SessionUser | null> {
  if (!sessionToken || sessionToken.length > 200) return null;
  return runIn(driver, { kind: "system" }, async (tx) => {
    const rows = await tx.query<{ id: string; email: string; display_name: string; mfa_enrolled_at: Date | null }>(
      `UPDATE sessions s SET last_seen_at = now()
         FROM users u
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.id = s.user_id AND u.status = 'ACTIVE'
       RETURNING u.id, u.email, u.display_name, u.mfa_enrolled_at`,
      [hashToken(sessionToken)],
    );
    if (!rows.length) return null;
    const roles = await tx.query<{ role: string }>(
      `SELECT DISTINCT role::text FROM role_assignments
        WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [rows[0].id],
    );
    return {
      id: rows[0].id,
      email: rows[0].email,
      displayName: rows[0].display_name,
      mfaEnrolled: rows[0].mfa_enrolled_at !== null,
      platformRoles: roles.map((r) => r.role),
    };
  });
}

export async function revokeSession(driver: Driver, sessionToken: string): Promise<void> {
  await runIn(driver, { kind: "system" }, (tx) =>
    tx.query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [hashToken(sessionToken)]),
  );
}

/** SOP-013: revoke all sessions for a user. */
export async function revokeAllSessions(driver: Driver, userId: string, actorUserId: string): Promise<void> {
  await runIn(driver, { kind: "system" }, async (tx) => {
    await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    await writeAudit(tx, { actorUserId, action: "SESSIONS_REVOKED", subjectType: "user", subjectId: userId });
  });
}
