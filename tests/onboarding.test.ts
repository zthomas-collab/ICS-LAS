import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "@/server/db";
import { runIn } from "@/server/db/context";
import {
  confirmEmail,
  consumeSignIn,
  registerOrganization,
  requestSignIn,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from "@/server/modules/identity";
import { decideOrganization, grantPlatformRole, listMyOrganizations, listOrganizationsForReview } from "@/server/modules/organizations";
import { createSite } from "@/server/modules/sites";
import { queryMap } from "@/server/modules/map";
import { freshDb } from "./helpers/db";
import { ASHEVILLE_BBOX, site } from "./helpers/fixtures";

/** End-to-end at the service layer: registration → email confirmation → verification → publication. */
let db: Driver;
let adminId: string;

const latestLink = async (email: string, path: string) => {
  const rows = await runIn(db, { kind: "system" }, (tx) =>
    tx.query<{ body_text: string }>(
      `SELECT body_text FROM notification_jobs WHERE recipient_email = $1 ORDER BY created_at DESC LIMIT 1`,
      [email],
    ),
  );
  const m = rows[0]?.body_text.match(new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`));
  if (!m) throw new Error("no link");
  return m[1];
};

const registration = {
  displayName: "[TEST] Mountain Relief",
  legalName: "[TEST] Mountain Relief Inc.",
  orgType: "NONPROFIT",
  contactName: "Test Rep",
  email: "rep@example.test",
  website: "https://example.test",
  registrationNotes: "501(c)(3) determination letter available; state registration 12345.",
  primaryServiceType: "FOOD",
  additionalServiceTypes: ["WATER"],
  directoryConsent: "on",
  publicPhone: "(555) 010-0199",
};

beforeAll(async () => {
  db = await freshDb();
  adminId = await grantPlatformRole(db, { email: "admin@example.test", role: "PLATFORM_ADMIN", reason: "test bootstrap" });
});
afterAll(async () => db?.close());

describe("organization onboarding (SOP-001)", () => {
  let orgId: string;
  let repId: string;
  let session: string;

  it("rejects invalid registration input", async () => {
    await expect(registerOrganization(db, { ...registration, email: "not-an-email" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(registerOrganization(db, { ...registration, website: "javascript:alert(1)" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("registers a pending org and queues a confirmation email (no session yet)", async () => {
    ({ orgId } = await registerOrganization(db, registration));
    const orgs = await runIn(db, { kind: "system" }, (tx) => tx.query<{ status: string }>("SELECT status::text FROM organizations WHERE id = $1", [orgId]));
    expect(orgs[0].status).toBe("PENDING_EMAIL");
    // Unconfirmed registrants cannot request sign-in links (not verified) — and the response is identical.
    await expect(requestSignIn(db, registration.email)).resolves.toBeUndefined();
  });

  it("email confirmation is single-use, moves org to PENDING_VERIFICATION and opens SOP-001", async () => {
    const token = await latestLink(registration.email, "/auth/confirm");
    const r = await confirmEmail(db, token);
    session = r.sessionToken;
    repId = r.userId;
    await expect(confirmEmail(db, token)).rejects.toMatchObject({ code: "VALIDATION" });
    const mine = await listMyOrganizations(db, repId);
    expect(mine).toMatchObject([{ id: orgId, status: "PENDING_VERIFICATION", role: "ORG_ADMIN", membershipStatus: "ACTIVE" }]);
    const sop = await runIn(db, { kind: "system" }, (tx) =>
      tx.query<{ status: string }>("SELECT status FROM sop_executions WHERE subject_id = $1 AND sop_code = 'SOP-001'", [orgId]),
    );
    expect(sop).toEqual([{ status: "OPEN" }]);
  });

  it("a pending org cannot publish and its rep is not an admin", async () => {
    await expect(createSite(db, repId, orgId, site())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listOrganizationsForReview(db, repId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(decideOrganization(db, repId, { orgId, decision: "APPROVED", evidenceSummary: "self-approval attempt", primaryServiceType: "FOOD" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a platform admin approves with recorded evidence; SOP-001 completes", async () => {
    const queue = await listOrganizationsForReview(db, adminId);
    expect(queue.map((o) => o.id)).toContain(orgId);
    await expect(decideOrganization(db, adminId, { orgId, decision: "APPROVED", evidenceSummary: "" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(decideOrganization(db, adminId, { orgId, decision: "APPROVED", evidenceSummary: "No type chosen" })).rejects.toMatchObject({ code: "VALIDATION" });
    await decideOrganization(db, adminId, { orgId, decision: "APPROVED", evidenceSummary: "Verified IRS determination letter and state registry.", primaryServiceType: "FOOD" });
    await expect(decideOrganization(db, adminId, { orgId, decision: "APPROVED", evidenceSummary: "double approve", primaryServiceType: "FOOD" })).rejects.toMatchObject({ code: "CONFLICT" });
    const rows = await runIn(db, { kind: "system" }, (tx) =>
      tx.query<{ status: string; v: number; sop: string }>(
        `SELECT o.status::text, (SELECT count(*)::int FROM organization_verifications WHERE org_id = o.id) AS v,
                (SELECT status FROM sop_executions WHERE subject_id = o.id) AS sop FROM organizations o WHERE id = $1`,
        [orgId],
      ),
    );
    expect(rows[0]).toEqual({ status: "APPROVED", v: 1, sop: "COMPLETED" });
  });

  it("the approved org publishes a site that anonymous visitors can find (criteria 1, 2)", async () => {
    await createSite(db, repId, orgId, site({ name: "[TEST] Relief Hub" }));
    const r = await queryMap(db, null, ASHEVILLE_BBOX);
    expect(r.sites.map((s) => s.name)).toEqual(["[TEST] Relief Hub"]);
    expect(r.sites[0].orgName).toBe(registration.displayName);
  });

  it("suspension unpublishes immediately; reinstatement restores", async () => {
    await decideOrganization(db, adminId, { orgId, decision: "SUSPENDED", evidenceSummary: "Complaint under review (SOP-011)." });
    expect((await queryMap(db, null, ASHEVILLE_BBOX)).sites).toHaveLength(0);
    await decideOrganization(db, adminId, { orgId, decision: "REINSTATED", evidenceSummary: "Complaint resolved." });
    expect((await queryMap(db, null, ASHEVILLE_BBOX)).sites).toHaveLength(1);
  });

  it("sessions resolve, and revocation is immediate", async () => {
    expect((await resolveSession(db, session))?.id).toBe(repId);
    await revokeSession(db, session);
    expect(await resolveSession(db, session)).toBeNull();
    await requestSignIn(db, registration.email);
    const t = await latestLink(registration.email, "/auth/callback");
    const s2 = (await consumeSignIn(db, t)).sessionToken;
    await expect(consumeSignIn(db, t)).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await resolveSession(db, s2))?.email).toBe(registration.email);
    await revokeAllSessions(db, repId, adminId);
    expect(await resolveSession(db, s2)).toBeNull();
  });

  it("expired sign-in links are rejected", async () => {
    await requestSignIn(db, registration.email);
    const t = await latestLink(registration.email, "/auth/callback");
    await runIn(db, { kind: "system" }, (tx) => tx.query("UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE consumed_at IS NULL"));
    await expect(consumeSignIn(db, t)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("garbage or oversized session tokens resolve to no user", async () => {
    expect(await resolveSession(db, "nope")).toBeNull();
    expect(await resolveSession(db, "x".repeat(500))).toBeNull();
    expect(await resolveSession(db, undefined)).toBeNull();
  });
});
