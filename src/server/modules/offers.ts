import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { loadAccess } from "./access";
import { checkbox, parseOrThrow } from "./identity";
import { assertPlatformAdmin, privilegedMfaRequired } from "./organizations";
import { appBaseUrl, brandName, enqueueEmail, writeAudit } from "./shared";
import { countiesForZip, zipMatchesCounty } from "./zipcounty";

/**
 * Volunteer and donation offers. Public intake (no account), reviewed by executives and county administrators.
 * The database row is the record of an offer; email is a notification only and goes through the retrying
 * notification queue. Contributor contact details are never put in email to staff, only in the dashboard.
 */

export const OFFER_TYPES = [
  "VOLUNTEER_LABOR", "PROFESSIONAL_SKILLS", "EQUIPMENT", "TRANSPORTATION", "DRINKING_WATER", "FOOD",
  "BUILDING_SUPPLIES", "CLEANING_SUPPLIES", "STORAGE_SPACE", "OTHER",
] as const;
export type OfferType = (typeof OFFER_TYPES)[number];
export const OFFER_TYPE_LABELS: Record<OfferType, string> = {
  VOLUNTEER_LABOR: "Volunteer labor",
  PROFESSIONAL_SKILLS: "Professional skills",
  EQUIPMENT: "Equipment",
  TRANSPORTATION: "Transportation",
  DRINKING_WATER: "Drinking water",
  FOOD: "Food",
  BUILDING_SUPPLIES: "Building supplies",
  CLEANING_SUPPLIES: "Cleaning supplies",
  STORAGE_SPACE: "Storage or staging space",
  OTHER: "Something else",
};

export const OFFER_STATUSES = ["SUBMITTED", "REVIEWED", "MATCHED", "ACCEPTED", "SCHEDULED", "COMPLETED", "DECLINED", "CANCELED", "EXPIRED"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  SUBMITTED: "Submitted",
  REVIEWED: "Reviewed",
  MATCHED: "Matched",
  ACCEPTED: "Accepted",
  SCHEDULED: "Scheduled",
  COMPLETED: "Delivered / completed",
  DECLINED: "Declined",
  CANCELED: "Canceled",
  EXPIRED: "Expired",
};
const OFFER_MOVES: [OfferStatus, OfferStatus][] = [
  ["SUBMITTED", "REVIEWED"], ["SUBMITTED", "DECLINED"], ["SUBMITTED", "CANCELED"], ["SUBMITTED", "EXPIRED"],
  ["REVIEWED", "MATCHED"], ["REVIEWED", "DECLINED"], ["REVIEWED", "CANCELED"], ["REVIEWED", "EXPIRED"],
  ["MATCHED", "ACCEPTED"], ["MATCHED", "REVIEWED"], ["MATCHED", "DECLINED"], ["MATCHED", "CANCELED"], ["MATCHED", "EXPIRED"],
  ["ACCEPTED", "SCHEDULED"], ["ACCEPTED", "CANCELED"], ["ACCEPTED", "EXPIRED"],
  ["SCHEDULED", "COMPLETED"], ["SCHEDULED", "CANCELED"],
];
export const nextOfferStatuses = (from: OfferStatus): OfferStatus[] => OFFER_MOVES.filter(([f]) => f === from).map(([, t]) => t);

const EMAIL_SETTING = "offers_notification_email";
const PER_EMAIL_DAILY_LIMIT = 3;
const uuid = z.string().uuid();
const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((v) => (v ? v : null));
const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), "Use a valid date");

export const offerSchema = z.object({
  contributorName: z.string().trim().min(2, "Enter a name").max(120),
  organizationName: optionalText(160),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  phone: optionalText(40).refine((v) => v === null || /^[0-9+()\-. xX]{7,40}$/.test(v), "Enter a valid phone number"),
  zip: z.string().trim().regex(/^[0-9]{5}$/, "Use a 5-digit ZIP code"),
  countyId: uuid.optional().or(z.literal("").transform(() => undefined)),
  contributionType: z.enum(OFFER_TYPES, { message: "Choose what you can offer" }),
  quantity: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? Number(v) : null))
    .refine((v) => v === null || (Number.isFinite(v) && v > 0 && v < 1e9), "Enter a number above zero"),
  unit: optionalText(40),
  description: z.string().trim().min(5, "Describe what you can offer").max(2000),
  availableFrom: optionalDate,
  availableUntil: optionalDate,
  deliveryNotes: optionalText(1000),
  preferredProject: optionalText(140),
  consentContact: checkbox.refine((v) => v === true, "We need your permission to contact you about this offer"),
  consentShare: checkbox,
});

export async function getNotificationEmail(tx: Tx): Promise<string | null> {
  const r = await tx.query<{ v: string | null }>(`SELECT value #>> '{}' AS v FROM platform_settings WHERE key = $1`, [EMAIL_SETTING]);
  return r[0]?.v && r[0].v !== "null" ? r[0].v : null;
}

/** Records the offer, then queues (never sends inline) a notification to the configured address and a receipt to the contributor. */
export async function submitOffer(driver: Driver, raw: unknown): Promise<{ reference: string; id: string }> {
  const input = parseOrThrow(offerSchema, raw);
  if (input.availableFrom && input.availableUntil && input.availableUntil < input.availableFrom) {
    throw new AppError("VALIDATION", "The end date is before the start date.", { availableUntil: ["Must be on or after the start date"] });
  }
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      const recent = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM contribution_offers WHERE lower(email) = $1 AND created_at > now() - interval '24 hours'`, [input.email]);
      if (recent[0].n >= PER_EMAIL_DAILY_LIMIT) {
        throw new AppError("RATE_LIMITED", "You have already sent several offers today. Thank you; we will be in touch about those.");
      }
      let countyId: string | null = null;
      if (input.countyId) {
        const c = await tx.query<{ id: string }>(`SELECT id FROM counties WHERE id = $1 AND active`, [input.countyId]);
        if (!c.length) throw new AppError("VALIDATION", "Choose your county.", { countyId: ["Unknown county"] });
        if (!(await zipMatchesCounty(tx, input.zip, input.countyId))) {
          throw new AppError("VALIDATION", "That ZIP code is not in the county you chose.", { zip: ["Not in this county"] });
        }
        countyId = c[0].id;
      } else {
        // Only fill the county in when the ZIP belongs to exactly one known county; otherwise staff triage it.
        const zc = await countiesForZip(tx, input.zip);
        if (zc.length === 1) {
          const c = await tx.query<{ id: string }>(`SELECT id FROM counties WHERE fips = $1 AND active`, [zc[0].countyFips]);
          countyId = c[0]?.id ?? null;
        }
      }
      const rows = await tx.query<{ id: string; reference: string }>(
        `INSERT INTO contribution_offers (contributor_name, organization_name, email, phone, county_id, zip, contribution_type, quantity, unit,
                                          description, available_from, available_until, delivery_notes, preferred_project, consent_contact, consent_share)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, reference`,
        [input.contributorName, input.organizationName, input.email, input.phone, countyId, input.zip, input.contributionType, input.quantity,
         input.unit, input.description, input.availableFrom, input.availableUntil, input.deliveryNotes, input.preferredProject, true, input.consentShare],
      );
      const { id, reference } = rows[0];
      await tx.query(
        `INSERT INTO contribution_offer_events (offer_id, actor_role, event_type, to_status, note) VALUES ($1, 'CONTRIBUTOR', 'SUBMITTED', 'SUBMITTED', 'Offer submitted.')`, [id]);
      await writeAudit(tx, { actorUserId: null, action: "OFFER_SUBMITTED", subjectType: "contribution_offer", subjectId: id, details: { type: input.contributionType, hasCounty: Boolean(countyId) } });

      const destination = await getNotificationEmail(tx);
      if (destination) {
        await enqueueEmail(tx, {
          kind: "OFFER_NEW",
          to: destination,
          subject: `${brandName()}: new ${OFFER_TYPE_LABELS[input.contributionType].toLowerCase()} offer ${reference}`,
          body: `A new offer was received (${reference}).\nType: ${OFFER_TYPE_LABELS[input.contributionType]}\nZIP: ${input.zip}\n\nReview it (sign-in and MFA required): ${appBaseUrl()}/admin/offers/${id}`,
        });
      }
      await enqueueEmail(tx, {
        kind: "OFFER_RECEIPT",
        to: input.email,
        subject: `${brandName()}: we received your offer ${reference}`,
        body: `Thank you. We received your offer.\nReference number: ${reference}\n\nA coordinator will review it and may contact you. Receiving an offer does not commit anyone to accept it. If you did not send this, ignore this message.`,
      });
      return { reference, id };
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

// --------------------------- staff access ---------------------------
async function assertStaff(tx: Tx, userId: string): Promise<{ executive: boolean; countyIds: string[] }> {
  const a = await loadAccess(tx, userId);
  if (!a.executive && a.countyIds.length === 0) throw new AppError("FORBIDDEN", "You do not have access to offers.");
  if (privilegedMfaRequired()) {
    const r = await tx.query<{ mfa: boolean }>(`SELECT mfa_enrolled_at IS NOT NULL AS mfa FROM users WHERE id = $1 AND status = 'ACTIVE'`, [userId]);
    if (!r[0]?.mfa) throw new AppError("FORBIDDEN", "Multi-factor authentication is required to view offers.");
  }
  return { executive: a.executive, countyIds: a.countyIds };
}

export type OfferSummary = {
  id: string; reference: string; contributorName: string; organizationName: string | null; contributionType: OfferType;
  quantity: number | null; unit: string | null; zip: string; countyName: string | null; status: OfferStatus; createdAt: Date; statusChangedAt: Date;
};
export type OfferEvent = { id: string; type: string; fromStatus: string | null; toStatus: string | null; note: string | null; actorRole: string; at: Date };
export type OfferDetail = OfferSummary & {
  email: string; phone: string | null; description: string; availableFrom: string | null; availableUntil: string | null;
  deliveryNotes: string | null; preferredProject: string | null; consentShare: boolean; countyId: string | null; events: OfferEvent[];
  allowedNext: OfferStatus[]; canAssignCounty: boolean;
};

const SELECT = `o.id, o.reference, o.contributor_name, o.organization_name, o.contribution_type, o.quantity, o.unit, o.zip, o.status,
                o.created_at, o.status_changed_at, c.name AS county_name`;
const FROM = `contribution_offers o LEFT JOIN counties c ON c.id = o.county_id`;
const toSummary = (r: Record<string, unknown>): OfferSummary => ({
  id: r.id as string, reference: r.reference as string, contributorName: r.contributor_name as string,
  organizationName: (r.organization_name as string | null) ?? null, contributionType: r.contribution_type as OfferType,
  quantity: r.quantity === null || r.quantity === undefined ? null : Number(r.quantity), unit: (r.unit as string | null) ?? null,
  zip: r.zip as string, countyName: (r.county_name as string | null) ?? null, status: r.status as OfferStatus,
  createdAt: r.created_at as Date, statusChangedAt: r.status_changed_at as Date,
});

export const offerFilterSchema = z.object({
  status: z.enum(OFFER_STATUSES).optional().or(z.literal("").transform(() => undefined)),
  type: z.enum(OFFER_TYPES).optional().or(z.literal("").transform(() => undefined)),
  countyId: uuid.optional().or(z.literal("").transform(() => undefined)),
  page: z.coerce.number().int().min(1).max(500).default(1),
});
export const OFFER_PAGE_SIZE = 25;

export async function listOffers(driver: Driver, userId: string, raw: unknown = {}): Promise<{ rows: OfferSummary[]; page: number; hasMore: boolean; counts: Record<string, number>; unassigned: number }> {
  const f = parseOrThrow(offerFilterSchema, raw);
  await runIn(driver, { kind: "system" }, (tx) => assertStaff(tx, userId));
  return runIn(driver, { kind: "viewer", userId }, async (tx) => {
    const rows = await tx.query<Record<string, unknown>>(
      `SELECT ${SELECT} FROM ${FROM}
        WHERE ($1::text IS NULL OR o.status = $1) AND ($2::text IS NULL OR o.contribution_type = $2) AND ($3::uuid IS NULL OR o.county_id = $3)
        ORDER BY (o.status IN ('SUBMITTED','REVIEWED')) DESC, o.created_at DESC, o.id LIMIT $4 OFFSET $5`,
      [f.status ?? null, f.type ?? null, f.countyId ?? null, OFFER_PAGE_SIZE + 1, (f.page - 1) * OFFER_PAGE_SIZE],
    );
    const c = await tx.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM contribution_offers GROUP BY status`);
    const u = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM contribution_offers WHERE county_id IS NULL AND status = 'SUBMITTED'`);
    return {
      rows: rows.slice(0, OFFER_PAGE_SIZE).map(toSummary), page: f.page, hasMore: rows.length > OFFER_PAGE_SIZE,
      counts: Object.fromEntries(c.map((x) => [x.status, x.n])), unassigned: u[0].n,
    };
  });
}

/** Full detail. Opening an offer (which shows contact details) is recorded in the audit log. */
export async function getOffer(driver: Driver, userId: string, id: string): Promise<OfferDetail> {
  if (!uuid.safeParse(id).success) throw new AppError("NOT_FOUND", "Offer not found.");
  const staff = await runIn(driver, { kind: "system" }, (tx) => assertStaff(tx, userId));
  const d = await runIn(driver, { kind: "viewer", userId }, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(
      `SELECT ${SELECT}, o.email, o.phone, o.description, o.available_from::text AS available_from, o.available_until::text AS available_until,
              o.delivery_notes, o.preferred_project, o.consent_share, o.county_id FROM ${FROM} WHERE o.id = $1`, [id]);
    if (!r.length) return null;
    const ev = await tx.query<Record<string, unknown>>(
      `SELECT id, event_type, from_status, to_status, note, actor_role, created_at FROM contribution_offer_events WHERE offer_id = $1 ORDER BY created_at, id`, [id]);
    return { r: r[0], ev };
  });
  if (!d) throw new AppError("NOT_FOUND", "Offer not found.");
  await runIn(driver, { kind: "system" }, (tx) => writeAudit(tx, { actorUserId: userId, action: "OFFER_VIEWED", subjectType: "contribution_offer", subjectId: id }));
  const s = toSummary(d.r);
  return {
    ...s, email: d.r.email as string, phone: (d.r.phone as string | null) ?? null, description: d.r.description as string,
    availableFrom: (d.r.available_from as string | null) ?? null, availableUntil: (d.r.available_until as string | null) ?? null,
    deliveryNotes: (d.r.delivery_notes as string | null) ?? null, preferredProject: (d.r.preferred_project as string | null) ?? null,
    consentShare: d.r.consent_share as boolean, countyId: (d.r.county_id as string | null) ?? null,
    events: d.ev.map((e) => ({ id: e.id as string, type: e.event_type as string, fromStatus: e.from_status as string | null,
      toStatus: e.to_status as string | null, note: e.note as string | null, actorRole: e.actor_role as string, at: e.created_at as Date })),
    allowedNext: nextOfferStatuses(s.status),
    canAssignCounty: staff.executive && d.r.county_id === null,
  };
}

export const offerTransitionSchema = z.object({
  offerId: uuid,
  to: z.enum(OFFER_STATUSES),
  note: z.string().trim().max(2000).optional().transform((v) => (v ? v : null)),
});

async function actorFor(tx: Tx, userId: string, countyId: string | null): Promise<"EXECUTIVE" | "COUNTY_ADMIN"> {
  const a = await loadAccess(tx, userId);
  if (a.executive) return "EXECUTIVE";
  if (countyId && a.countyIds.includes(countyId)) return "COUNTY_ADMIN";
  throw new AppError("NOT_FOUND", "Offer not found."); // do not reveal that it exists
}

async function setActor(tx: Tx, id: string, role: string, note: string | null): Promise<void> {
  await tx.query(`SELECT set_config('ics.actor_id', $1, true), set_config('ics.actor_role', $2, true), set_config('ics.event_note', $3, true)`, [id, role, note ?? ""]);
}

export async function transitionOffer(driver: Driver, userId: string, raw: unknown): Promise<void> {
  const input = parseOrThrow(offerTransitionSchema, raw);
  if (["DECLINED", "CANCELED"].includes(input.to) && !input.note) {
    throw new AppError("VALIDATION", "Add a short reason.", { note: ["Required"] });
  }
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await assertStaff(tx, userId);
      const o = await tx.query<{ status: OfferStatus; county_id: string | null }>(`SELECT status, county_id FROM contribution_offers WHERE id = $1 FOR UPDATE`, [input.offerId]);
      if (!o.length) throw new AppError("NOT_FOUND", "Offer not found.");
      const role = await actorFor(tx, userId, o[0].county_id);
      if (!OFFER_MOVES.some(([f, t]) => f === o[0].status && t === input.to)) throw new AppError("CONFLICT", "That status change is not allowed from the current state.");
      await setActor(tx, userId, role, input.note);
      await tx.query(`UPDATE contribution_offers SET status = $2, assigned_admin_id = coalesce(assigned_admin_id, $3) WHERE id = $1`, [input.offerId, input.to, userId]);
      await writeAudit(tx, { actorUserId: userId, action: `OFFER_${input.to}`, subjectType: "contribution_offer", subjectId: input.offerId, details: { from: o[0].status } });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

/** Executive triage: an offer whose county could not be derived from its ZIP gets a county. Allowed once. */
export async function assignOfferCounty(driver: Driver, userId: string, offerId: unknown, countyId: unknown): Promise<void> {
  const oid = parseOrThrow(uuid, offerId);
  const cid = parseOrThrow(uuid, countyId);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await assertPlatformAdmin(tx, userId);
      const c = await tx.query<{ id: string }>(`SELECT id FROM counties WHERE id = $1 AND active`, [cid]);
      if (!c.length) throw new AppError("VALIDATION", "Choose a county.", { countyId: ["Unknown county"] });
      const o = await tx.query<{ county_id: string | null; zip: string }>(`SELECT county_id, zip FROM contribution_offers WHERE id = $1 FOR UPDATE`, [oid]);
      if (!o.length) throw new AppError("NOT_FOUND", "Offer not found.");
      if (o[0].county_id) throw new AppError("CONFLICT", "This offer already has a county.");
      if (!(await zipMatchesCounty(tx, o[0].zip, cid))) throw new AppError("VALIDATION", "That ZIP code is not in the county you chose.", { countyId: ["Not in this county"] });
      await tx.query(`UPDATE contribution_offers SET county_id = $2 WHERE id = $1`, [oid, cid]);
      await tx.query(`INSERT INTO contribution_offer_events (offer_id, actor_user_id, actor_role, event_type, note) VALUES ($1, $2, 'EXECUTIVE', 'COUNTY_ASSIGNED', 'County assigned.')`, [oid, userId]);
      await writeAudit(tx, { actorUserId: userId, action: "OFFER_COUNTY_ASSIGNED", subjectType: "contribution_offer", subjectId: oid });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export async function addOfferNote(driver: Driver, userId: string, offerId: unknown, note: unknown): Promise<void> {
  const oid = parseOrThrow(uuid, offerId);
  const text = parseOrThrow(z.string().trim().min(2, "Write a short note").max(2000), note);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await assertStaff(tx, userId);
      const o = await tx.query<{ county_id: string | null }>(`SELECT county_id FROM contribution_offers WHERE id = $1`, [oid]);
      if (!o.length) throw new AppError("NOT_FOUND", "Offer not found.");
      const role = await actorFor(tx, userId, o[0].county_id);
      await tx.query(`INSERT INTO contribution_offer_events (offer_id, actor_user_id, actor_role, event_type, note) VALUES ($1, $2, $3, 'NOTE', $4)`, [oid, userId, role, text]);
      await writeAudit(tx, { actorUserId: userId, action: "OFFER_NOTE_ADDED", subjectType: "contribution_offer", subjectId: oid });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

// --------------------------- settings ---------------------------
export const notificationEmailSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).refine((v) => v === "" || z.string().email().safeParse(v).success, "Enter a valid email address or leave blank to turn notifications off"),
});

/** Executive-only. A blank value turns the staff notification off; offers are still saved and shown in the dashboard. */
export async function setNotificationEmail(driver: Driver, userId: string, raw: unknown): Promise<string | null> {
  const input = parseOrThrow(notificationEmailSchema, raw);
  const value = input.email === "" ? null : input.email;
  return runIn(driver, { kind: "system" }, async (tx) => {
    await assertPlatformAdmin(tx, userId);
    await tx.query(
      `INSERT INTO platform_settings (key, value, updated_by) VALUES ($1, CASE WHEN $2::text IS NULL THEN 'null'::jsonb ELSE to_jsonb($2::text) END, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [EMAIL_SETTING, value, userId],
    );
    await writeAudit(tx, { actorUserId: userId, action: "SETTING_CHANGED", subjectType: "platform_setting", details: { key: EMAIL_SETTING, enabled: value !== null } });
    return value;
  });
}

export async function getNotificationEmailForAdmin(driver: Driver, userId: string): Promise<string | null> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    await assertPlatformAdmin(tx, userId);
    return getNotificationEmail(tx);
  });
}
