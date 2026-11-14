import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "@/server/db";
import { runIn } from "@/server/db/context";
import { consumeSignIn, requestSignIn, resolveSession } from "@/server/modules/identity";
import { createCounty } from "@/server/modules/counties";
import { beginMfaEnrollment, confirmMfaEnrollment, getMfaStatus, operatorResetMfa, resetMfaForUser, verifyMfaChallenge } from "@/server/modules/mfa";
import { base32Decode, base32Encode, decryptSecret, encryptSecret, hotp, otpauthUri, stepAt, verifyTotp } from "@/server/totp";
import { freshDb } from "./helpers/db";
import { grantRole, makeUser } from "./helpers/fixtures";

describe("TOTP primitives (RFC 6238)", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));

  it("matches the RFC 6238 SHA-1 test vector", () => {
    expect(hotp(Buffer.from("12345678901234567890"), 1, 8)).toBe("94287082"); // T = 59 s
    expect(hotp(Buffer.from("12345678901234567890"), 1)).toBe("287082");
    expect(verifyTotp(secret, "287082", 59_000)).toBe(1);
  });

  it("accepts one step of clock drift but not more, and never a replayed step", () => {
    expect(verifyTotp(secret, "287082", 59_000 + 30_000)).toBe(1); // one step later
    expect(verifyTotp(secret, "287082", 59_000 + 90_000)).toBeNull(); // three steps later
    expect(verifyTotp(secret, "287082", 59_000, 1)).toBeNull(); // step 1 already used
    expect(verifyTotp(secret, "28708", 59_000)).toBeNull();
    expect(verifyTotp(secret, "abcdef", 59_000)).toBeNull();
  });

  it("base32 round-trips and builds a standard otpauth URI", () => {
    const buf = Buffer.from([1, 2, 3, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    const uri = otpauthUri({ secret: "ABC234", account: "a@example.test", issuer: "Crisis Compass" });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Crisis%20Compass%3Aa%40example\.test\?secret=ABC234&issuer=Crisis%20Compass/);
  });

  it("secrets are encrypted at rest with authenticated encryption", () => {
    const a = encryptSecret("JBSWY3DPEHPK3PXP");
    const b = encryptSecret("JBSWY3DPEHPK3PXP");
    expect(a).not.toContain("JBSWY3DPEHPK3PXP");
    expect(a).not.toBe(b); // fresh IV each time
    expect(decryptSecret(a)).toBe("JBSWY3DPEHPK3PXP");
    const tampered = a.slice(0, -2) + (a.endsWith("AA") ? "BB" : "AA");
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

let db: Driver;
let exec: string, user: string, other: string;
const emails = new Map<string, string>();

const latestToken = async (email: string) => {
  const rows = await runIn(db, { kind: "system" }, (tx) =>
    tx.query<{ body_text: string }>(`SELECT body_text FROM notification_jobs WHERE recipient_email = $1 ORDER BY created_at DESC LIMIT 1`, [email]),
  );
  return rows[0].body_text.match(/token=([A-Za-z0-9_-]+)/)![1];
};

/** A fresh session through the real sign-in path (single-use link). */
const signIn = async (email: string): Promise<string> => {
  await requestSignIn(db, email);
  return (await consumeSignIn(db, await latestToken(email))).sessionToken;
};

const currentCode = async (userId: string, offsetSteps = 0) => {
  const enc = (await runIn(db, { kind: "system" }, (tx) => tx.query<{ s: string }>(`SELECT mfa_secret_enc AS s FROM users WHERE id = $1`, [userId])))[0].s;
  return hotp(base32Decode(decryptSecret(enc)), stepAt(Date.now()) + offsetSteps);
};

/** Enrolls `userId` through the module API and returns recovery codes. */
async function enroll(userId: string, email: string): Promise<{ codes: string[]; token: string }> {
  const token = await signIn(email);
  const { secret } = await beginMfaEnrollment(db, userId);
  const code = hotp(base32Decode(secret), stepAt(Date.now()));
  return { codes: await confirmMfaEnrollment(db, userId, token, code), token };
}

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

beforeAll(async () => {
  db = await freshDb();
  [exec, user, other] = await Promise.all(["mfa-exec", "mfa-user", "mfa-other"].map((n) => makeUser(db, `${n}@example.test`)));
  emails.set(exec, "mfa-exec@example.test");
  emails.set(user, "mfa-user@example.test");
  emails.set(other, "mfa-other@example.test");
  await grantRole(db, exec, "PLATFORM_ADMIN");
});
afterAll(async () => db?.close());
afterEach(() => {
  delete process.env.REQUIRE_MFA_FOR_PRIVILEGED;
});

describe("enrollment and sign-in challenge", () => {
  it("a user without MFA signs in normally", async () => {
    const token = await signIn("mfa-user@example.test");
    const s = await resolveSession(db, token);
    expect(s).toMatchObject({ mfaEnrolled: false, mfaPending: false });
  });

  it("the secret is stored encrypted and enrollment needs a correct code", async () => {
    const token = await signIn("mfa-user@example.test");
    const { secret } = await beginMfaEnrollment(db, user);
    const stored = await runIn(db, { kind: "system" }, (tx) => tx.query<{ p: string }>(`SELECT mfa_pending_secret_enc AS p FROM users WHERE id = $1`, [user]));
    expect(stored[0].p).not.toContain(secret);
    expect(await code(confirmMfaEnrollment(db, user, token, "000000"))).toBe("VALIDATION");
    expect((await getMfaStatus(db, user)).enrolled).toBe(false);
    const codes = await confirmMfaEnrollment(db, user, token, hotp(base32Decode(secret), stepAt(Date.now())));
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(await getMfaStatus(db, user)).toEqual({ enrolled: true, recoveryCodesRemaining: 10 });
    const raw = await runIn(db, { kind: "system" }, (tx) => tx.query<{ c: string }>(`SELECT code_hash AS c FROM mfa_recovery_codes WHERE user_id = $1`, [user]));
    for (const c of codes) expect(raw.map((r) => r.c)).not.toContain(c); // only hashes are stored
    expect((await resolveSession(db, token))?.mfaPending).toBe(false); // the enrolling session is verified
    expect(await code(beginMfaEnrollment(db, user))).toBe("CONFLICT");
  });

  it("after enrollment a new sign-in is pending until the second factor is verified", async () => {
    const token = await signIn("mfa-user@example.test");
    expect((await resolveSession(db, token))?.mfaPending).toBe(true);
    expect(await code(verifyMfaChallenge(db, token, "123456"))).toBe("VALIDATION");
    expect((await resolveSession(db, token))?.mfaPending).toBe(true);
    await verifyMfaChallenge(db, token, await currentCode(user, 1));
    expect((await resolveSession(db, token))?.mfaPending).toBe(false);
  });

  it("a code cannot be replayed on another session", async () => {
    const replay = await currentCode(user, 1); // accepted in the previous test, so already used
    const token = await signIn("mfa-user@example.test");
    expect(await code(verifyMfaChallenge(db, token, replay))).toBe("VALIDATION");
    expect((await resolveSession(db, token))?.mfaPending).toBe(true);
  });

  it("enrollment ends sessions created before the second factor existed", async () => {
    const early = await signIn("mfa-other@example.test");
    const { codes, token } = await enroll(other, "mfa-other@example.test");
    expect(codes).toHaveLength(10);
    expect(await resolveSession(db, early)).toBeNull();
    expect(await resolveSession(db, token)).not.toBeNull();
  });
});

describe("recovery codes and lockout", () => {
  it("a recovery code works exactly once", async () => {
    // Reset and enroll again so the plaintext recovery codes are known to the test.
    await operatorResetMfa(db, "mfa-other@example.test", "test reset");
    const { codes: recovery } = await enroll(other, "mfa-other@example.test");
    const s1 = await signIn("mfa-other@example.test");
    await verifyMfaChallenge(db, s1, recovery[0]);
    expect((await resolveSession(db, s1))?.mfaPending).toBe(false);
    const s2 = await signIn("mfa-other@example.test");
    expect(await code(verifyMfaChallenge(db, s2, recovery[0]))).toBe("VALIDATION");
    await verifyMfaChallenge(db, s2, recovery[1]);
    expect((await getMfaStatus(db, other)).recoveryCodesRemaining).toBe(8);
  });

  it("five wrong codes lock the account, even against a correct code", async () => {
    const token = await signIn("mfa-other@example.test");
    for (let i = 0; i < 5; i++) expect(await code(verifyMfaChallenge(db, token, "000000"))).toBe("VALIDATION");
    expect(await code(verifyMfaChallenge(db, token, await currentCode(other, 1)))).toBe("RATE_LIMITED");
    expect((await resolveSession(db, token))?.mfaPending).toBe(true);
    await runIn(db, { kind: "system" }, (tx) => tx.query(`UPDATE users SET mfa_locked_until = now() - interval '1 minute' WHERE id = $1`, [other]));
    await verifyMfaChallenge(db, token, await currentCode(other, 1));
    expect((await resolveSession(db, token))?.mfaPending).toBe(false);
  });
});

describe("privileged roles", () => {
  it("where enforcement is on, an executive without MFA is locked out until enrolled", async () => {
    process.env.REQUIRE_MFA_FOR_PRIVILEGED = "true";
    expect(await code(createCounty(db, exec, { name: "Gated", state: "NC" }))).toBe("FORBIDDEN");
    await enroll(exec, "mfa-exec@example.test");
    expect(await code(createCounty(db, exec, { name: "Gated", state: "NC" }))).toBe("OK");
  });

  it("only an executive can reset someone else's MFA, and never their own", async () => {
    process.env.REQUIRE_MFA_FOR_PRIVILEGED = "true";
    expect(await code(resetMfaForUser(db, user, other, "pretending to be admin"))).toBe("FORBIDDEN");
    expect(await code(resetMfaForUser(db, exec, exec, "self reset attempt"))).toBe("FORBIDDEN");
    const live = await signIn("mfa-user@example.test");
    expect(live).toBeTruthy();
    await resetMfaForUser(db, exec, user, "Identity verified by video call");
    expect(await getMfaStatus(db, user)).toEqual({ enrolled: false, recoveryCodesRemaining: 0 });
    expect(await resolveSession(db, live)).toBeNull();
    const audit = await runIn(db, { kind: "system" }, (tx) => tx.query(`SELECT 1 FROM audit_logs WHERE action = 'MFA_RESET' AND subject_id = $1`, [user]));
    expect(audit).toHaveLength(1);
  });
});
