import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError } from "../errors";
import { parseOrThrow } from "./identity";
import { enqueueEmail, writeAudit } from "./shared";

export function privilegedMfaRequired(): boolean {
  const v = process.env.REQUIRE_MFA_FOR_PRIVILEGED;
  if (v === "true") return true;
  if (v === "false") return process.env.NODE_ENV === "production"; // cannot be disabled in production
  return process.env.NODE_ENV === "production";
}

/** Re-checks platform admin authority inside the transaction (never trusts cached session roles). */
export async function assertPlatformAdmin(tx: Tx, userId: string): Promise<void> {
  const rows = await tx.query<{ ok: boolean; mfa: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM role_assignments ra JOIN users u ON u.id = ra.user_id
                     WHERE ra.user_id = $1 AND ra.role = 'PLATFORM_ADMIN' AND u.status = 'ACTIVE'
                       AND ra.revoked_at IS NULL AND (ra.expires_at IS NULL OR ra.expires_at > now())) AS ok,
            EXISTS (SELECT 1 FROM users WHERE id = $1 AND mfa_enrolled_at IS NOT NULL) AS mfa`,
    [userId],
  );
  if (!rows[0]?.ok) throw new AppError("FORBIDDEN", "Platform administrator role required.");
  if (privilegedMfaRequired() && !rows[0].mfa) throw new AppError("FORBIDDEN", "Multi-factor authentication required.");
}

export type MyOrganization = {
  id: string;
  displayName: string;
  orgType: string;
  status: string;
  role: string;
  membershipStatus: string;
  publicationSuspended: boolean;
  isSynthetic: boolean;
};

export async function listMyOrganizations(driver: Driver, userId: string): Promise<MyOrganization[]> {
  return runIn(driver, { kind: "viewer", userId }, async (tx) => {
    const rows = await tx.query<{
      id: string; display_name: string; org_type: string; status: string; role: string;
      mstatus: string; publication_suspended: boolean; is_synthetic: boolean;
    }>(
      `SELECT o.id, o.display_name, o.org_type::text, o.status::text, m.role::text, m.status::text AS mstatus,
              o.publication_suspended, o.is_synthetic
         FROM organization_memberships m JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = ics.viewer_id() AND m.status <> 'REVOKED'
        ORDER BY o.display_name`,
    );
    return rows.map((r) => ({
      id: r.id, displayName: r.display_name, orgType: r.org_type, status: r.status, role: r.role,
      membershipStatus: r.mstatus, publicationSuspended: r.publication_suspended, isSynthetic: r.is_synthetic,
    }));
  });
}

export type PendingOrganization = {
  id: string;
  legalName: string;
  displayName: string;
  orgType: string;
  status: string;
  contactEmail: string;
  website: string | null;
  publicPhone: string | null;
  description: string | null;
  registrationNotes: string | null;
  createdAt: Date;
  sopDueAt: Date | null;
  publicationSuspended: boolean;
};

export async function listOrganizationsForReview(driver: Driver, adminUserId: string): Promise<PendingOrganization[]> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    await assertPlatformAdmin(tx, adminUserId);
    const rows = await tx.query<Record<string, unknown>>(
      `SELECT o.id, o.legal_name, o.display_name, o.org_type::text, o.status::text, o.contact_email, o.website,
              o.public_phone, o.description, o.registration_notes, o.created_at, o.publication_suspended,
              (SELECT min(due_at) FROM sop_executions e WHERE e.subject_id = o.id AND e.sop_code = 'SOP-001' AND e.status = 'OPEN') AS sop_due_at
         FROM organizations o
        WHERE o.status IN ('PENDING_VERIFICATION','APPROVED','SUSPENDED')
        ORDER BY (o.status = 'PENDING_VERIFICATION') DESC, o.created_at ASC
        LIMIT 200`,
    );
    return rows.map((r) => ({
      id: r.id as string, legalName: r.legal_name as string, displayName: r.display_name as string,
      orgType: r.org_type as string, status: r.status as string, contactEmail: r.contact_email as string,
      website: r.website as string | null, publicPhone: r.public_phone as string | null,
      description: r.description as string | null, registrationNotes: r.registration_notes as string | null,
      createdAt: r.created_at as Date, sopDueAt: r.sop_due_at as Date | null,
      publicationSuspended: r.publication_suspended as boolean,
    }));
  });
}

export const decisionSchema = z.object({
  orgId: z.string().uuid(),
  decision: z.enum(["APPROVED", "REJECTED", "SUSPENDED", "REINSTATED"]),
  evidenceSummary: z.string().trim().min(5, "Record the evidence or reason for this decision").max(4000),
});

const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  APPROVED: { from: ["PENDING_VERIFICATION"], to: "APPROVED" },
  REJECTED: { from: ["PENDING_VERIFICATION"], to: "REJECTED" },
  SUSPENDED: { from: ["APPROVED"], to: "SUSPENDED" },
  REINSTATED: { from: ["SUSPENDED"], to: "APPROVED" },
};

/** SOP-001 / SOP-012: platform admin verification decision. Suspension unpublishes immediately (read models filter on status). */
export async function decideOrganization(driver: Driver, adminUserId: string, raw: unknown): Promise<void> {
  const input = parseOrThrow(decisionSchema, raw);
  await runIn(driver, { kind: "system" }, async (tx) => {
    await assertPlatformAdmin(tx, adminUserId);
    const t = TRANSITIONS[input.decision];
    const rows = await tx.query<{ id: string; display_name: string; contact_email: string }>(
      `UPDATE organizations
          SET status = $2::org_status,
              approved_at = CASE WHEN $2 = 'APPROVED' THEN coalesce(approved_at, now()) ELSE approved_at END,
              suspended_at = CASE WHEN $2 = 'SUSPENDED' THEN now() WHEN $2 = 'APPROVED' THEN NULL ELSE suspended_at END
        WHERE id = $1 AND status::text = ANY($3::text[])
        RETURNING id, display_name, contact_email`,
      [input.orgId, t.to, t.from],
    );
    if (!rows.length) throw new AppError("CONFLICT", "The organization is not in a state that allows this decision.");
    await tx.query(
      `INSERT INTO organization_verifications (org_id, decision, reviewer_id, evidence_summary) VALUES ($1, $2, $3, $4)`,
      [input.orgId, input.decision, adminUserId, input.evidenceSummary],
    );
    if (input.decision === "APPROVED" || input.decision === "REJECTED") {
      await tx.query(
        `UPDATE sop_executions SET status = 'COMPLETED', completed_at = now(), completed_by = $2,
                evidence = jsonb_build_object('decision', $3::text)
          WHERE sop_code = 'SOP-001' AND subject_id = $1 AND status = 'OPEN'`,
        [input.orgId, adminUserId, input.decision],
      );
    }
    await writeAudit(tx, {
      actorUserId: adminUserId,
      actorOrgId: input.orgId,
      action: `ORG_${input.decision}`,
      subjectType: "organization",
      subjectId: input.orgId,
      details: { evidenceLength: input.evidenceSummary.length },
    });
    const messages: Record<string, string> = {
      APPROVED: "has been verified. You can now publish staging sites and resources.",
      REJECTED: "could not be verified. Reply to this email if you believe this is an error.",
      SUSPENDED: "has been suspended. Its listings are no longer published.",
      REINSTATED: "has been reinstated. Its published listings are visible again.",
    };
    await enqueueEmail(tx, {
      kind: `ORG_${input.decision}`,
      to: rows[0].contact_email,
      subject: `Organization status update: ${rows[0].display_name}`,
      body: `${rows[0].display_name} ${messages[input.decision]}`,
    });
  });
}

/** Trusted bootstrap/CLI path. Grants a platform role and records the grant. */
export async function grantPlatformRole(
  driver: Driver,
  opts: { email: string; displayName?: string; role: "PLATFORM_ADMIN" | "SECURITY_ADMIN" | "ROAD_VERIFIER"; reason: string; grantedBy?: string },
): Promise<string> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    const email = opts.email.trim().toLowerCase();
    const u = await tx.query<{ id: string }>(
      `INSERT INTO users (email, display_name, email_verified_at) VALUES ($1, $2, now())
       ON CONFLICT (email) DO UPDATE SET email_verified_at = coalesce(users.email_verified_at, now())
       RETURNING id`,
      [email, opts.displayName ?? email.split("@")[0]],
    );
    await tx.query(
      `INSERT INTO role_assignments (user_id, role, reason, granted_by)
       SELECT $1, $2::platform_role, $3, $4
        WHERE NOT EXISTS (SELECT 1 FROM role_assignments WHERE user_id = $1 AND role = $2::platform_role AND revoked_at IS NULL)`,
      [u[0].id, opts.role, opts.reason, opts.grantedBy ?? null],
    );
    await writeAudit(tx, {
      actorUserId: opts.grantedBy ?? null,
      action: "ROLE_GRANTED",
      subjectType: "user",
      subjectId: u[0].id,
      details: { role: opts.role, reason: opts.reason },
    });
    return u[0].id;
  });
}
