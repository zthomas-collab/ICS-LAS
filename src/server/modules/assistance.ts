import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { MAX_DOCUMENTS_PER_APPLICATION, prepareDocument, scanDocument } from "../documents";
import { createTransport } from "../email";
import { AppError, fromDbError } from "../errors";
import type { Scanner } from "../scanner";
import type { ObjectStore } from "../storage";
import { loadAccess, type Access } from "./access";
import { checkbox, parseOrThrow } from "./identity";
import { privilegedMfaRequired } from "./organizations";
import { appBaseUrl, brandName, enqueueEmail, writeAudit } from "./shared";

/**
 * Public assistance applications (Phase 2). Holds personal information about residents, so:
 *  - reads run under the caller's identity (viewer context) and are filtered by row-level security;
 *  - writes run as trusted server code after an explicit authorization check, and status changes are
 *    validated and recorded by a database trigger (see migration 0010);
 *  - personal details are never put in email, logs or audit details.
 */

export const STATUSES = ["SUBMITTED", "UNDER_REVIEW", "INFO_REQUIRED", "APPROVED", "REFERRED", "IN_PROGRESS", "COMPLETED", "CLOSED"] as const;
export type AppStatus = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<AppStatus, string> = {
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  INFO_REQUIRED: "Additional information required",
  APPROVED: "Approved",
  REFERRED: "Referred to a resource provider",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  CLOSED: "Denied or closed",
};
export const CLOSURE_REASONS = ["DENIED", "CLOSED", "WITHDRAWN", "DUPLICATE"] as const;
export type ClosureReason = (typeof CLOSURE_REASONS)[number];
export const CLOSURE_LABELS: Record<ClosureReason, string> = {
  DENIED: "Denied",
  CLOSED: "Closed",
  WITHDRAWN: "Withdrawn by applicant",
  DUPLICATE: "Duplicate application",
};

const OPEN_LIMIT = 5;
const DAILY_LIMIT = 5;

// ---------------------------------------------------------------------------
// Readiness gate: this feature collects sensitive data, so production refuses to run it until the
// protections it depends on are actually configured.
// ---------------------------------------------------------------------------
export type ReadinessCheck = { id: string; label: string; ok: boolean; detail: string };

export function assistanceReadiness(env: Record<string, string | undefined> = process.env): { ready: boolean; checks: ReadinessCheck[] } {
  const prod = env.NODE_ENV === "production";
  const checks: ReadinessCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string) => checks.push({ id, label, ok, detail });
  add("flag", "Feature switched on", env.ASSISTANCE_ENABLED === "true" || (!prod && env.ASSISTANCE_ENABLED !== "false"),
    "Set ASSISTANCE_ENABLED=true when you are ready to accept applications.");
  let emailOk = !prod;
  try {
    emailOk = createTransport(env).delivers || !prod;
  } catch {
    emailOk = false;
  }
  add("email", "Email delivery configured", emailOk, "EMAIL_TRANSPORT=smtp with SMTP_URL and EMAIL_FROM, and the worker running (npm run notifications:send -- --watch).");
  add("auth", "Sign-in with MFA configured", !prod || (env.AUTH_PROVIDER === "magic-link-mfa" && Boolean(env.MFA_ENCRYPTION_KEY)),
    "AUTH_PROVIDER=magic-link-mfa and MFA_ENCRYPTION_KEY.");
  add("mfa", "MFA enforced for staff", prod || env.REQUIRE_MFA_FOR_PRIVILEGED !== "false", "Always on in production.");
  add("storage", "Private object storage", !prod || Boolean(env.S3_BUCKET), "S3_BUCKET (a private S3-compatible bucket). Without it, document uploads stay unavailable in production.");
  add("scanner", "Malware scanning", !prod || env.SCANNER === "clamd", "SCANNER=clamd with CLAMD_HOST. Without it, document uploads stay unavailable in production.");
  // Documents are optional: storage/scanner gaps disable uploads only. Everything else is mandatory.
  const mandatory = ["flag", "email", "auth", "mfa"];
  return { ready: checks.filter((c) => mandatory.includes(c.id)).every((c) => c.ok), checks };
}

export function documentsAvailable(env: Record<string, string | undefined> = process.env): boolean {
  const r = assistanceReadiness(env).checks;
  return r.filter((c) => c.id === "storage" || c.id === "scanner").every((c) => c.ok);
}

export function assertAssistanceEnabled(): void {
  if (!assistanceReadiness().ready) throw new AppError("FORBIDDEN", "Assistance applications are not available yet.");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const uuid = z.string().uuid();

/** Staff who handle personal data need MFA wherever MFA enforcement is on (always in production). */
async function assertPiiMfa(tx: Tx, userId: string): Promise<void> {
  if (!privilegedMfaRequired()) return;
  const r = await tx.query<{ mfa: boolean }>(`SELECT mfa_enrolled_at IS NOT NULL AS mfa FROM users WHERE id = $1 AND status = 'ACTIVE'`, [userId]);
  if (!r[0]?.mfa) throw new AppError("FORBIDDEN", "Multi-factor authentication is required to view applications.");
}

async function requireVerifiedUser(tx: Tx, userId: string): Promise<{ email: string }> {
  const r = await tx.query<{ email: string; verified: boolean }>(
    `SELECT email, email_verified_at IS NOT NULL AS verified FROM users WHERE id = $1 AND status = 'ACTIVE'`,
    [userId],
  );
  if (!r.length || !r[0].verified) throw new AppError("UNAUTHENTICATED", "Confirm your email address first.");
  return { email: r[0].email };
}

async function setActor(tx: Tx, a: { id: string | null; role: string; orgId?: string | null; note?: string | null; visible: boolean }): Promise<void> {
  await tx.query(
    `SELECT set_config('ics.actor_id', $1, true), set_config('ics.actor_role', $2, true), set_config('ics.actor_org', $3, true),
            set_config('ics.event_note', $4, true), set_config('ics.event_visible', $5, true)`,
    [a.id ?? "", a.role, a.orgId ?? "", a.note ?? "", a.visible ? "true" : "false"],
  );
}

async function notifyApplicant(tx: Tx, applicationId: string, applicantId: string, headline: string): Promise<void> {
  const u = await tx.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [applicantId]);
  if (!u.length) return;
  await enqueueEmail(tx, {
    kind: "APPLICATION_UPDATE",
    to: u[0].email,
    subject: `${brandName()}: update on your assistance application`,
    // No details about the situation: email is not a secure channel.
    body: `${headline}\n\nSign in to see the update: ${appBaseUrl()}/assistance/${applicationId}\n\nIf you did not apply for assistance, you can ignore this message.`,
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
export type Route = { ruleId: string | null; orgId: string | null; basis: string };

/**
 * Most specific active rule wins: a matching ZIP outranks a matching category, which outranks a county-wide rule;
 * ties go to the lower priority number. Falls back to the platform's default processing organization, then to
 * manual routing by the county administrators.
 */
export async function findRoute(tx: Tx, input: { countyId: string; zip: string; categoryCode: string }): Promise<Route> {
  const r = await tx.query<{ id: string; handler_org_id: string }>(
    `SELECT r.id, r.handler_org_id
       FROM application_routing_rules r JOIN organizations o ON o.id = r.handler_org_id
      WHERE r.active AND r.county_id = $1 AND (r.zip IS NULL OR r.zip = $2) AND (r.category_code IS NULL OR r.category_code = $3)
        AND o.status = 'APPROVED' AND NOT o.publication_suspended
      ORDER BY (r.zip IS NOT NULL)::int * 2 + (r.category_code IS NOT NULL)::int DESC, r.priority ASC, r.created_at ASC
      LIMIT 1`,
    [input.countyId, input.zip, input.categoryCode],
  );
  if (r.length) return { ruleId: r[0].id, orgId: r[0].handler_org_id, basis: "Matched a routing rule for this county, ZIP code and category." };
  const d = await tx.query<{ id: string }>(
    `SELECT o.id FROM platform_settings s JOIN organizations o ON o.id::text = trim(both '"' from s.value::text)
      WHERE s.key = 'assistance.default_processing_org_id' AND o.status = 'APPROVED' AND NOT o.publication_suspended`,
  );
  if (d.length) return { ruleId: null, orgId: d[0].id, basis: "No routing rule matched; the platform default processing organization was suggested." };
  return { ruleId: null, orgId: null, basis: "No routing rule matched; county administrators route this manually." };
}

// ---------------------------------------------------------------------------
// Applicant: submit and follow
// ---------------------------------------------------------------------------
export const applicationSchema = z.object({
  countyId: uuid,
  zip: z.string().trim().regex(/^[0-9]{5}$/, "Use a 5-digit ZIP code"),
  categoryCode: z.string().regex(/^[A-Z_]{2,40}$/, "Choose a type of assistance"),
  summary: z.string().trim().min(5, "Give a short title").max(140),
  situation: z.string().trim().min(10, "Tell us a little more about what happened").max(4000),
  householdSize: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? Number(v) : null))
    .refine((v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 50), "Enter a number from 1 to 50"),
  contactPhone: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || /^[0-9+()\-. xX]{7,40}$/.test(v), "Enter a valid phone number"),
  preferredContact: z.enum(["EMAIL", "PHONE"]).default("EMAIL"),
  consentShareProviders: checkbox,
});

export async function submitApplication(driver: Driver, userId: string, raw: unknown): Promise<string> {
  assertAssistanceEnabled();
  const input = parseOrThrow(applicationSchema, raw);
  if (input.preferredContact === "PHONE" && !input.contactPhone) {
    throw new AppError("VALIDATION", "Add a phone number or choose email.", { contactPhone: ["Required when you prefer phone"] });
  }
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      await requireVerifiedUser(tx, userId);
      const limits = await tx.query<{ open: number; today: number }>(
        `SELECT count(*) FILTER (WHERE status NOT IN ('COMPLETED','CLOSED'))::int AS open,
                count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS today
           FROM assistance_applications WHERE applicant_user_id = $1`,
        [userId],
      );
      if (limits[0].open >= OPEN_LIMIT || limits[0].today >= DAILY_LIMIT) {
        throw new AppError("RATE_LIMITED", "You have reached the limit for open applications. Please wait for an update or withdraw one before applying again.");
      }
      const county = await tx.query<{ name: string }>(`SELECT name FROM counties WHERE id = $1 AND active`, [input.countyId]);
      if (!county.length) throw new AppError("VALIDATION", "Choose your county.", { countyId: ["Unknown county"] });
      const cat = await tx.query<{ label: string }>(`SELECT label FROM assistance_categories WHERE code = $1 AND active`, [input.categoryCode]);
      if (!cat.length) throw new AppError("VALIDATION", "Choose a type of assistance.", { categoryCode: ["Unknown type"] });

      const route = await findRoute(tx, input);
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO assistance_applications (applicant_user_id, county_id, zip, category_code, summary, situation, household_size, contact_phone,
                                              preferred_contact, consent_share_providers, suggested_org_id, routing_rule_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [userId, input.countyId, input.zip, input.categoryCode, input.summary, input.situation, input.householdSize, input.contactPhone,
         input.preferredContact, input.consentShareProviders, route.orgId, route.ruleId],
      );
      const id = rows[0].id;
      await tx.query(
        `INSERT INTO assistance_application_events (application_id, actor_user_id, actor_role, event_type, to_status, note, applicant_visible)
         VALUES ($1, $2, 'APPLICANT', 'SUBMITTED', 'SUBMITTED', 'Application submitted.', true)`,
        [id, userId],
      );
      await tx.query(
        `INSERT INTO assistance_application_events (application_id, actor_role, event_type, note, applicant_visible)
         VALUES ($1, 'SYSTEM', 'ROUTED', $2, false)`,
        [id, route.basis],
      );
      await writeAudit(tx, { actorUserId: userId, action: "APPLICATION_SUBMITTED", subjectType: "assistance_application", subjectId: id,
        details: { countyId: input.countyId, category: input.categoryCode, routed: Boolean(route.orgId) } });

      await notifyApplicant(tx, id, userId, "We received your assistance application. You will get an email when its status changes.");
      // Tell the county's administrators there is work waiting. The email names only county and type, never the person.
      const admins = await tx.query<{ email: string }>(
        `SELECT DISTINCT u.email FROM county_admin_assignments a JOIN users u ON u.id = a.user_id
          WHERE a.county_id = $1 AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > now()) AND u.status = 'ACTIVE'`,
        [input.countyId],
      );
      for (const a of admins) {
        await enqueueEmail(tx, {
          kind: "APPLICATION_NEW",
          to: a.email,
          subject: `${brandName()}: new assistance application in ${county[0].name} County`,
          body: `A new application (${cat[0].label}) is waiting for review.\n\nReview it: ${appBaseUrl()}/admin/applications/${id}`,
        });
      }
      return id;
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export type ApplicationSummary = {
  id: string; summary: string; status: AppStatus; closureReason: ClosureReason | null; categoryLabel: string;
  countyName: string; zip: string; createdAt: Date; statusChangedAt: Date;
};

function toSummary(r: Record<string, unknown>): ApplicationSummary {
  return {
    id: r.id as string, summary: r.summary as string, status: r.status as AppStatus,
    closureReason: (r.closure_reason as ClosureReason | null) ?? null, categoryLabel: r.category_label as string,
    countyName: r.county_name as string, zip: r.zip as string, createdAt: r.created_at as Date, statusChangedAt: r.status_changed_at as Date,
  };
}

const SUMMARY_SELECT = `a.id, a.summary, a.status, a.closure_reason, a.zip, a.created_at, a.status_changed_at, c.label AS category_label, k.name AS county_name`;
const SUMMARY_FROM = `assistance_applications a JOIN assistance_categories c ON c.code = a.category_code JOIN counties k ON k.id = a.county_id`;

export async function listMyApplications(driver: Driver, userId: string): Promise<ApplicationSummary[]> {
  const rows = await runIn(driver, { kind: "viewer", userId }, (tx) =>
    tx.query<Record<string, unknown>>(
      `SELECT ${SUMMARY_SELECT} FROM ${SUMMARY_FROM} WHERE a.applicant_user_id = ics.viewer_id() ORDER BY a.created_at DESC LIMIT 100`,
    ),
  );
  return rows.map(toSummary);
}

export type TimelineEvent = { id: string; type: string; fromStatus: string | null; toStatus: string | null; note: string | null; actorRole: string; at: Date };
export type DocumentMeta = { id: string; displayName: string; contentType: string; byteSize: number; scanStatus: string; createdAt: Date };
export type ApplicationDetail = ApplicationSummary & {
  situation: string; householdSize: number | null; contactPhone: string | null; preferredContact: string; consentShareProviders: boolean;
  applicantName: string; applicantEmail: string; suggestedOrgId: string | null; referredOrgId: string | null; referredOrgName: string | null;
  events: TimelineEvent[]; documents: DocumentMeta[];
};

async function loadDetail(tx: Tx, id: string, perspective: "applicant" | "staff"): Promise<ApplicationDetail | null> {
  const r = await tx.query<Record<string, unknown>>(
    `SELECT ${SUMMARY_SELECT}, a.situation, a.household_size, a.contact_phone, a.preferred_contact, a.consent_share_providers,
            a.suggested_org_id, a.referred_org_id,
            (SELECT o.display_name FROM organizations o WHERE o.id = a.referred_org_id) AS referred_org_name
       FROM ${SUMMARY_FROM} WHERE a.id = $1`,
    [id],
  );
  if (!r.length) return null;
  const events = await tx.query<Record<string, unknown>>(
    `SELECT id, event_type, from_status, to_status, note, actor_role, created_at FROM assistance_application_events
      WHERE application_id = $1 ${perspective === "applicant" ? "AND applicant_visible" : ""} ORDER BY created_at, id`,
    [id],
  );
  const docs = await tx.query<Record<string, unknown>>(
    `SELECT id, display_name, content_type, byte_size, scan_status, created_at FROM assistance_documents WHERE application_id = $1 AND removed_at IS NULL ORDER BY created_at`,
    [id],
  );
  const x = r[0];
  return {
    ...toSummary(x),
    situation: x.situation as string, householdSize: x.household_size as number | null, contactPhone: x.contact_phone as string | null,
    preferredContact: x.preferred_contact as string, consentShareProviders: x.consent_share_providers as boolean,
    applicantName: "", applicantEmail: "",
    suggestedOrgId: x.suggested_org_id as string | null, referredOrgId: x.referred_org_id as string | null,
    referredOrgName: x.referred_org_name as string | null,
    events: events.map((e) => ({ id: e.id as string, type: e.event_type as string, fromStatus: e.from_status as string | null,
      toStatus: e.to_status as string | null, note: e.note as string | null, actorRole: e.actor_role as string, at: e.created_at as Date })),
    documents: docs.map((d) => ({ id: d.id as string, displayName: d.display_name as string, contentType: d.content_type as string,
      byteSize: d.byte_size as number, scanStatus: d.scan_status as string, createdAt: d.created_at as Date })),
  };
}

/** The applicant's own application. Anyone else gets NOT_FOUND (row-level security hides it). */
export async function getMyApplication(driver: Driver, userId: string, id: string): Promise<ApplicationDetail> {
  if (!uuid.safeParse(id).success) throw new AppError("NOT_FOUND", "Application not found.");
  const d = await runIn(driver, { kind: "viewer", userId }, async (tx) => {
    const own = await tx.query(`SELECT 1 FROM assistance_applications WHERE id = $1 AND applicant_user_id = ics.viewer_id()`, [id]);
    return own.length ? loadDetail(tx, id, "applicant") : null;
  });
  if (!d) throw new AppError("NOT_FOUND", "Application not found.");
  // Applicants never see the applicant fields of other people or internal routing details.
  return { ...d, suggestedOrgId: null };
}

const noteSchema = z.string().trim().min(2, "Write a short message").max(2000);

/** Applicant withdraws, or answers a request for more information. */
export async function withdrawApplication(driver: Driver, userId: string, id: string, note?: unknown): Promise<void> {
  const text = note ? parseOrThrow(noteSchema, note) : "Withdrawn by the applicant.";
  await changeAsApplicant(driver, userId, id, { to: "CLOSED", closure: "WITHDRAWN", note: text, from: ["SUBMITTED", "UNDER_REVIEW", "INFO_REQUIRED", "APPROVED"] });
}

export async function provideRequestedInfo(driver: Driver, userId: string, id: string, message: unknown): Promise<void> {
  const text = parseOrThrow(noteSchema, message);
  await changeAsApplicant(driver, userId, id, { to: "UNDER_REVIEW", note: text, from: ["INFO_REQUIRED"], infoProvided: true });
}

async function changeAsApplicant(
  driver: Driver, userId: string, id: string,
  o: { to: AppStatus; closure?: ClosureReason; note: string; from: AppStatus[]; infoProvided?: boolean },
): Promise<void> {
  if (!uuid.safeParse(id).success) throw new AppError("NOT_FOUND", "Application not found.");
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const a = await tx.query<{ status: AppStatus; county_id: string }>(
        `SELECT status, county_id FROM assistance_applications WHERE id = $1 AND applicant_user_id = $2 FOR UPDATE`, [id, userId]);
      if (!a.length) throw new AppError("NOT_FOUND", "Application not found.");
      if (!o.from.includes(a[0].status)) throw new AppError("CONFLICT", "This application cannot be changed in its current state.");
      if (o.infoProvided) {
        await tx.query(
          `INSERT INTO assistance_application_events (application_id, actor_user_id, actor_role, event_type, note, applicant_visible)
           VALUES ($1, $2, 'APPLICANT', 'INFO_PROVIDED', $3, true)`, [id, userId, o.note]);
      }
      await setActor(tx, { id: userId, role: "APPLICANT", note: o.infoProvided ? "Applicant provided the requested information." : o.note, visible: true });
      await tx.query(`UPDATE assistance_applications SET status = $2, closure_reason = $3 WHERE id = $1`, [id, o.to, o.closure ?? null]);
      await writeAudit(tx, { actorUserId: userId, action: `APPLICATION_${o.to}`, subjectType: "assistance_application", subjectId: id });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

// ---------------------------------------------------------------------------
// Staff: queue, detail, transitions, notes
// ---------------------------------------------------------------------------
type StaffCapacity = { kind: "admin"; role: "COUNTY_ADMIN" | "EXECUTIVE"; access: Access } | { kind: "provider"; orgId: string };

async function staffCapacityFor(tx: Tx, userId: string, a: { county_id: string; referred_org_id: string | null; status: AppStatus; consent: boolean }): Promise<StaffCapacity | null> {
  const access = await loadAccess(tx, userId);
  if (access.executive) return { kind: "admin", role: "EXECUTIVE", access };
  if (access.countyIds.includes(a.county_id)) return { kind: "admin", role: "COUNTY_ADMIN", access };
  if (a.consent && a.referred_org_id && access.orgIds.includes(a.referred_org_id) && ["REFERRED", "IN_PROGRESS", "COMPLETED"].includes(a.status)) {
    return { kind: "provider", orgId: a.referred_org_id };
  }
  return null;
}

export const queueFilterSchema = z.object({
  status: z.enum(STATUSES).optional().or(z.literal("").transform(() => undefined)),
  countyId: uuid.optional().or(z.literal("").transform(() => undefined)),
  categoryCode: z.string().regex(/^[A-Z_]{2,40}$/).optional().or(z.literal("").transform(() => undefined)),
  zip: z.string().regex(/^[0-9]{5}$/).optional().or(z.literal("").transform(() => undefined)),
  page: z.coerce.number().int().min(1).max(500).default(1),
});
export const QUEUE_PAGE_SIZE = 25;

/**
 * Staff queue. Row-level security does the scoping (county administrators see their counties, provider
 * staff see applications referred to their organization); the explicit access check adds the MFA rule.
 */
export async function listApplicationsForStaff(driver: Driver, userId: string, raw: unknown = {}): Promise<{ rows: ApplicationSummary[]; page: number; hasMore: boolean }> {
  const f = parseOrThrow(queueFilterSchema, raw);
  await runIn(driver, { kind: "system" }, async (tx) => {
    const a = await loadAccess(tx, userId);
    if (!a.executive && a.countyIds.length === 0 && a.orgIds.length === 0) throw new AppError("FORBIDDEN", "You do not have access to applications.");
    await assertPiiMfa(tx, userId);
  });
  const rows = await runIn(driver, { kind: "viewer", userId }, (tx) =>
    tx.query<Record<string, unknown>>(
      `SELECT ${SUMMARY_SELECT} FROM ${SUMMARY_FROM}
        WHERE a.applicant_user_id <> ics.viewer_id()
          AND ($1::text IS NULL OR a.status = $1) AND ($2::uuid IS NULL OR a.county_id = $2)
          AND ($3::text IS NULL OR a.category_code = $3) AND ($4::text IS NULL OR a.zip = $4)
        ORDER BY (a.status IN ('SUBMITTED','UNDER_REVIEW','INFO_REQUIRED')) DESC, a.status_changed_at DESC, a.id
        LIMIT $5 OFFSET $6`,
      [f.status ?? null, f.countyId ?? null, f.categoryCode ?? null, f.zip ?? null, QUEUE_PAGE_SIZE + 1, (f.page - 1) * QUEUE_PAGE_SIZE],
    ),
  );
  return { rows: rows.slice(0, QUEUE_PAGE_SIZE).map(toSummary), page: f.page, hasMore: rows.length > QUEUE_PAGE_SIZE };
}

/** Full detail for staff. Every read is recorded in the audit log (who looked at whose application). */
export async function getApplicationForStaff(driver: Driver, userId: string, id: string): Promise<ApplicationDetail & { allowedNext: AppStatus[]; capacity: "admin" | "provider" }> {
  if (!uuid.safeParse(id).success) throw new AppError("NOT_FOUND", "Application not found.");
  const base = await runIn(driver, { kind: "system" }, async (tx) => {
    const a = await tx.query<{ county_id: string; referred_org_id: string | null; status: AppStatus; consent: boolean; applicant: string }>(
      `SELECT county_id, referred_org_id, status, consent_share_providers AS consent, applicant_user_id AS applicant FROM assistance_applications WHERE id = $1`, [id]);
    if (!a.length) throw new AppError("NOT_FOUND", "Application not found.");
    const cap = await staffCapacityFor(tx, userId, a[0]);
    if (!cap) throw new AppError("NOT_FOUND", "Application not found."); // do not reveal that it exists
    await assertPiiMfa(tx, userId);
    await writeAudit(tx, { actorUserId: userId, action: "APPLICATION_VIEWED", subjectType: "assistance_application", subjectId: id, details: { as: cap.kind } });
    const contact = await tx.query<{ display_name: string; email: string }>(`SELECT display_name, email FROM users WHERE id = $1`, [a[0].applicant]);
    return { cap, status: a[0].status, contact: contact[0] };
  });
  const d = await runIn(driver, { kind: "viewer", userId }, (tx) => loadDetail(tx, id, "staff"));
  if (!d) throw new AppError("NOT_FOUND", "Application not found.");
  const allowedNext = STATUSES.filter((s) => transitionAllowedFor(base.cap, base.status, s));
  const detail = { ...d, applicantName: base.contact?.display_name ?? "", applicantEmail: base.contact?.email ?? "" };
  // Providers see only what they need to deliver help: no internal routing notes.
  if (base.cap.kind === "provider") detail.events = detail.events.filter((e) => e.type !== "ROUTED");
  return { ...detail, allowedNext, capacity: base.cap.kind };
}

const PROVIDER_MOVES: [AppStatus, AppStatus][] = [["REFERRED", "IN_PROGRESS"], ["IN_PROGRESS", "COMPLETED"], ["REFERRED", "APPROVED"], ["IN_PROGRESS", "APPROVED"]];
const ALL_MOVES: [AppStatus, AppStatus][] = [
  ["SUBMITTED", "UNDER_REVIEW"], ["SUBMITTED", "CLOSED"], ["UNDER_REVIEW", "INFO_REQUIRED"], ["UNDER_REVIEW", "APPROVED"], ["UNDER_REVIEW", "CLOSED"],
  ["INFO_REQUIRED", "UNDER_REVIEW"], ["INFO_REQUIRED", "CLOSED"], ["APPROVED", "REFERRED"], ["APPROVED", "IN_PROGRESS"], ["APPROVED", "CLOSED"],
  ["REFERRED", "IN_PROGRESS"], ["REFERRED", "APPROVED"], ["REFERRED", "CLOSED"], ["IN_PROGRESS", "COMPLETED"], ["IN_PROGRESS", "APPROVED"], ["IN_PROGRESS", "CLOSED"],
];

function transitionAllowedFor(cap: StaffCapacity, from: AppStatus, to: AppStatus): boolean {
  const list = cap.kind === "admin" ? ALL_MOVES : PROVIDER_MOVES;
  return list.some(([f, t]) => f === from && t === to);
}

export const transitionSchema = z.object({
  applicationId: uuid,
  to: z.enum(STATUSES),
  note: z.string().trim().max(2000).optional().transform((v) => (v ? v : null)),
  closureReason: z.enum(CLOSURE_REASONS).optional().or(z.literal("").transform(() => undefined)),
  referOrgId: uuid.optional().or(z.literal("").transform(() => undefined)),
  visibleToApplicant: checkbox,
});

/** Moves an application along the pipeline. The database trigger re-validates the move and records the event. */
export async function transitionApplication(driver: Driver, userId: string, raw: unknown): Promise<void> {
  const input = parseOrThrow(transitionSchema, raw);
  if (input.to === "CLOSED" && !input.closureReason) throw new AppError("VALIDATION", "Choose why this application is being closed.", { closureReason: ["Required"] });
  if ((input.to === "CLOSED" && input.closureReason === "DENIED") || input.to === "INFO_REQUIRED") {
    if (!input.note || input.note.length < 5) throw new AppError("VALIDATION", "Explain this decision to the applicant.", { note: ["Required"] });
  }
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const a = await tx.query<{ county_id: string; referred_org_id: string | null; suggested_org_id: string | null; status: AppStatus; consent: boolean; applicant: string }>(
        `SELECT county_id, referred_org_id, suggested_org_id, status, consent_share_providers AS consent, applicant_user_id AS applicant
           FROM assistance_applications WHERE id = $1 FOR UPDATE`, [input.applicationId]);
      if (!a.length) throw new AppError("NOT_FOUND", "Application not found.");
      const cap = await staffCapacityFor(tx, userId, a[0]);
      if (!cap) throw new AppError("NOT_FOUND", "Application not found.");
      await assertPiiMfa(tx, userId);
      if (!transitionAllowedFor(cap, a[0].status, input.to)) throw new AppError("CONFLICT", "That status change is not allowed from the current state.");

      let referOrg: string | null = null;
      if (input.to === "REFERRED") {
        referOrg = input.referOrgId ?? a[0].suggested_org_id;
        if (!referOrg) throw new AppError("VALIDATION", "Choose the provider organization to refer this application to.", { referOrgId: ["Required"] });
        if (!a[0].consent) throw new AppError("CONFLICT", "The applicant did not consent to sharing with providers, so this cannot be referred.");
        const ok = await tx.query(`SELECT 1 FROM organizations WHERE id = $1 AND status = 'APPROVED' AND NOT publication_suspended`, [referOrg]);
        if (!ok.length) throw new AppError("VALIDATION", "That organization is not an approved provider.", { referOrgId: ["Not available"] });
      }
      const role = cap.kind === "provider" ? "PROVIDER" : cap.role;
      const visible = input.visibleToApplicant || input.to === "INFO_REQUIRED" || (input.to === "CLOSED" && input.closureReason === "DENIED");
      await setActor(tx, { id: userId, role, orgId: cap.kind === "provider" ? cap.orgId : null, note: input.note, visible });
      await tx.query(
        `UPDATE assistance_applications SET status = $2, closure_reason = $3, referred_org_id = coalesce($4::uuid, referred_org_id) WHERE id = $1`,
        [input.applicationId, input.to, input.to === "CLOSED" ? input.closureReason : null, referOrg],
      );
      await writeAudit(tx, { actorUserId: userId, action: `APPLICATION_${input.to}`, subjectType: "assistance_application", subjectId: input.applicationId,
        details: { from: a[0].status, as: role } });
      await notifyApplicant(
        tx, input.applicationId, a[0].applicant,
        input.to === "REFERRED"
          ? "Your application was approved and shared with a resource provider who can help."
          : `The status of your assistance application is now: ${STATUS_LABELS[input.to]}.`,
      );
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

/** A note on the timeline. Hidden from the applicant unless explicitly marked visible. */
export async function addApplicationNote(driver: Driver, userId: string, applicationId: unknown, note: unknown, applicantVisible: boolean): Promise<void> {
  const id = parseOrThrow(uuid, applicationId);
  const text = parseOrThrow(noteSchema, note);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const a = await tx.query<{ county_id: string; referred_org_id: string | null; status: AppStatus; consent: boolean; applicant: string }>(
        `SELECT county_id, referred_org_id, status, consent_share_providers AS consent, applicant_user_id AS applicant FROM assistance_applications WHERE id = $1`, [id]);
      if (!a.length) throw new AppError("NOT_FOUND", "Application not found.");
      const cap = await staffCapacityFor(tx, userId, a[0]);
      if (!cap) throw new AppError("NOT_FOUND", "Application not found.");
      await assertPiiMfa(tx, userId);
      await tx.query(
        `INSERT INTO assistance_application_events (application_id, actor_user_id, actor_role, actor_org_id, event_type, note, applicant_visible)
         VALUES ($1, $2, $3, $4, 'NOTE', $5, $6)`,
        [id, userId, cap.kind === "provider" ? "PROVIDER" : cap.role, cap.kind === "provider" ? cap.orgId : null, text, applicantVisible],
      );
      await writeAudit(tx, { actorUserId: userId, action: "APPLICATION_NOTE_ADDED", subjectType: "assistance_application", subjectId: id });
      if (applicantVisible) await notifyApplicant(tx, id, a[0].applicant, "There is a new message about your assistance application.");
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
export async function uploadApplicationDocument(
  driver: Driver, store: ObjectStore, scanner: Scanner, userId: string, applicationId: string,
  file: { bytes: Buffer; name: string },
): Promise<string> {
  assertAssistanceEnabled();
  if (!uuid.safeParse(applicationId).success) throw new AppError("NOT_FOUND", "Application not found.");
  // Authorize and check limits before doing any expensive work.
  await runIn(driver, { kind: "system" }, async (tx) => {
    const a = await tx.query<{ status: AppStatus }>(`SELECT status FROM assistance_applications WHERE id = $1 AND applicant_user_id = $2`, [applicationId, userId]);
    if (!a.length) throw new AppError("NOT_FOUND", "Application not found.");
    if (["COMPLETED", "CLOSED"].includes(a[0].status)) throw new AppError("CONFLICT", "This application is closed.");
    const n = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM assistance_documents WHERE application_id = $1 AND removed_at IS NULL`, [applicationId]);
    if (n[0].n >= MAX_DOCUMENTS_PER_APPLICATION) throw new AppError("CONFLICT", `You can attach up to ${MAX_DOCUMENTS_PER_APPLICATION} files.`);
  });
  const doc = await prepareDocument(file.bytes, file.name);
  const scan = await scanDocument(scanner, doc.bytes);
  if (scan.status === "INFECTED") {
    await runIn(driver, { kind: "system" }, (tx) =>
      writeAudit(tx, { actorUserId: userId, action: "DOCUMENT_REJECTED_INFECTED", subjectType: "assistance_application", subjectId: applicationId, details: { sha256: doc.sha256 } }));
    throw new AppError("VALIDATION", "That file was blocked by our security scan and was not saved.", { document: ["Blocked"] });
  }
  if (scan.status === "FAILED") throw new AppError("VALIDATION", "We could not safely check that file right now. Please try again later.", { document: ["Could not be scanned"] });

  const key = `documents/${randomUUID()}.${doc.ext}`;
  await store.put(key, doc.bytes, doc.contentType);
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO assistance_documents (application_id, uploaded_by, storage_key, content_type, byte_size, sha256, display_name, scan_status, scan_detail, scanned_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $8 = 'CLEAN' THEN now() END) RETURNING id`,
        [applicationId, userId, key, doc.contentType, doc.bytes.length, doc.sha256, doc.displayName, scan.status, scan.detail ?? null],
      );
      await tx.query(
        `INSERT INTO assistance_application_events (application_id, actor_user_id, actor_role, event_type, note, applicant_visible)
         VALUES ($1, $2, 'APPLICANT', 'DOCUMENT_ADDED', $3, true)`, [applicationId, userId, doc.displayName]);
      await writeAudit(tx, { actorUserId: userId, action: "DOCUMENT_ADDED", subjectType: "assistance_application", subjectId: applicationId, details: { documentId: rows[0].id, bytes: doc.bytes.length } });
      return rows[0].id;
    });
  } catch (err) {
    await store.delete(key).catch(() => undefined); // never leave orphaned bytes
    throw fromDbError(err);
  }
}

export async function removeApplicationDocument(driver: Driver, userId: string, documentId: string): Promise<void> {
  if (!uuid.safeParse(documentId).success) throw new AppError("NOT_FOUND", "Document not found.");
  await runIn(driver, { kind: "system" }, async (tx) => {
    const r = await tx.query<{ application_id: string }>(
      `UPDATE assistance_documents d SET removed_at = now() FROM assistance_applications a
        WHERE d.id = $1 AND d.removed_at IS NULL AND a.id = d.application_id AND a.applicant_user_id = $2 RETURNING d.application_id`,
      [documentId, userId]);
    if (!r.length) throw new AppError("NOT_FOUND", "Document not found.");
    await tx.query(
      `INSERT INTO assistance_application_events (application_id, actor_user_id, actor_role, event_type, applicant_visible) VALUES ($1, $2, 'APPLICANT', 'DOCUMENT_REMOVED', true)`,
      [r[0].application_id, userId]);
    await writeAudit(tx, { actorUserId: userId, action: "DOCUMENT_REMOVED", subjectType: "assistance_application", subjectId: r[0].application_id, details: { documentId } });
  });
}

/**
 * Releases a document's bytes to someone entitled to see it (the applicant, the application's county
 * administrators, or the provider it was referred to). Visibility comes from row-level security; on top of
 * that only scan-CLEAN files are released (development also allows NOT_SCANNED). Every release is audited.
 */
export async function readApplicationDocument(driver: Driver, store: ObjectStore, userId: string, documentId: string): Promise<{ bytes: Buffer; contentType: string; displayName: string }> {
  if (!uuid.safeParse(documentId).success) throw new AppError("NOT_FOUND", "Document not found.");
  const prod = process.env.NODE_ENV === "production";
  const doc = await runIn(driver, { kind: "viewer", userId }, async (tx) => {
    const r = await tx.query<{ storage_key: string; content_type: string; display_name: string; scan_status: string; application_id: string; mine: boolean }>(
      `SELECT d.storage_key, d.content_type, d.display_name, d.scan_status, d.application_id,
              a.applicant_user_id = ics.viewer_id() AS mine
         FROM assistance_documents d JOIN assistance_applications a ON a.id = d.application_id WHERE d.id = $1`, [documentId]);
    return r[0];
  });
  if (!doc) throw new AppError("NOT_FOUND", "Document not found.");
  if (!doc.mine) {
    await runIn(driver, { kind: "system" }, (tx) => assertPiiMfa(tx, userId));
  }
  const releasable = doc.scan_status === "CLEAN" || (!prod && doc.scan_status === "NOT_SCANNED");
  if (!releasable) throw new AppError("FORBIDDEN", "This file is still being checked or was blocked.");
  const bytes = await store.get(doc.storage_key);
  if (!bytes) throw new AppError("NOT_FOUND", "Document not found.");
  await runIn(driver, { kind: "system" }, (tx) =>
    writeAudit(tx, { actorUserId: userId, action: "DOCUMENT_VIEWED", subjectType: "assistance_application", subjectId: doc.application_id, details: { documentId, own: doc.mine } }));
  return { bytes, contentType: doc.content_type, displayName: doc.display_name };
}

// ---------------------------------------------------------------------------
// Routing rules (county administrators for their counties; executives for all)
// ---------------------------------------------------------------------------
export type RoutingRule = { id: string; countyId: string; countyName: string; zip: string | null; categoryCode: string | null; categoryLabel: string | null; handlerOrgId: string; handlerOrgName: string; priority: number; note: string | null; active: boolean };

export async function listRoutingRules(driver: Driver, userId: string): Promise<RoutingRule[]> {
  const rows = await runIn(driver, { kind: "viewer", userId }, (tx) =>
    tx.query<Record<string, unknown>>(
      `SELECT r.id, r.county_id, k.name AS county_name, r.zip, r.category_code, c.label AS category_label, r.handler_org_id,
              o.display_name AS org_name, r.priority, r.note, r.active
         FROM application_routing_rules r JOIN counties k ON k.id = r.county_id JOIN organizations o ON o.id = r.handler_org_id
         LEFT JOIN assistance_categories c ON c.code = r.category_code ORDER BY k.name, r.priority, r.created_at`),
  );
  return rows.map((r) => ({ id: r.id as string, countyId: r.county_id as string, countyName: r.county_name as string, zip: r.zip as string | null,
    categoryCode: r.category_code as string | null, categoryLabel: r.category_label as string | null, handlerOrgId: r.handler_org_id as string,
    handlerOrgName: r.org_name as string, priority: r.priority as number, note: r.note as string | null, active: r.active as boolean }));
}

export const routingRuleSchema = z.object({
  countyId: uuid,
  zip: z.string().trim().regex(/^[0-9]{5}$/, "Use a 5-digit ZIP code").optional().or(z.literal("").transform(() => undefined)),
  categoryCode: z.string().regex(/^[A-Z_]{2,40}$/).optional().or(z.literal("").transform(() => undefined)),
  handlerOrgId: uuid,
  priority: z.coerce.number().int().min(1).max(1000).default(100),
  note: z.string().trim().max(500).optional().transform((v) => (v ? v : null)),
});

export async function createRoutingRule(driver: Driver, userId: string, raw: unknown): Promise<string> {
  const input = parseOrThrow(routingRuleSchema, raw);
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      const access = await loadAccess(tx, userId);
      if (!access.executive && !access.countyIds.includes(input.countyId)) throw new AppError("FORBIDDEN", "You do not administer this county.");
      const org = await tx.query(`SELECT 1 FROM organizations WHERE id = $1 AND status = 'APPROVED' AND NOT publication_suspended`, [input.handlerOrgId]);
      if (!org.length) throw new AppError("VALIDATION", "Choose an approved organization.", { handlerOrgId: ["Not available"] });
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO application_routing_rules (county_id, zip, category_code, handler_org_id, priority, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [input.countyId, input.zip ?? null, input.categoryCode ?? null, input.handlerOrgId, input.priority, input.note, userId]);
      await writeAudit(tx, { actorUserId: userId, action: "ROUTING_RULE_CREATED", subjectType: "routing_rule", subjectId: rows[0].id, details: { countyId: input.countyId } });
      return rows[0].id;
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export async function setRoutingRuleActive(driver: Driver, userId: string, ruleId: unknown, active: boolean): Promise<void> {
  const id = parseOrThrow(uuid, ruleId);
  await runIn(driver, { kind: "system" }, async (tx) => {
    const access = await loadAccess(tx, userId);
    const r = await tx.query<{ county_id: string }>(`SELECT county_id FROM application_routing_rules WHERE id = $1`, [id]);
    if (!r.length) throw new AppError("NOT_FOUND", "Rule not found.");
    if (!access.executive && !access.countyIds.includes(r[0].county_id)) throw new AppError("FORBIDDEN", "You do not administer this county.");
    await tx.query(`UPDATE application_routing_rules SET active = $2 WHERE id = $1`, [id, active]);
    await writeAudit(tx, { actorUserId: userId, action: active ? "ROUTING_RULE_ENABLED" : "ROUTING_RULE_DISABLED", subjectType: "routing_rule", subjectId: id });
  });
}
