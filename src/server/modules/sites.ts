import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { AVAILABILITY_STATUSES, VISIBILITY_LEVELS, isResourceVisibilityAllowed, type Visibility } from "@/lib/domain";
import { parseOrThrow } from "./identity";
import { writeAudit } from "./shared";

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

export const siteSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: optText(2000),
  visibility: z.enum(VISIBILITY_LEVELS),
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  addressLine: optText(200),
  city: optText(100),
  county: optText(100),
  state: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z]{2})?$/, "Use a 2-letter state code")
    .optional()
    .transform((v) => (v ? v : null)),
  postalCode: z
    .string()
    .trim()
    .regex(/^([0-9]{5}(-[0-9]{4})?)?$/, "Use a 5-digit ZIP code")
    .optional()
    .transform((v) => (v ? v : null)),
  hoursText: optText(300),
  publicPhone: optText(40),
});
export type SiteInput = z.infer<typeof siteSchema>;

export const resourceSchema = z.object({
  categoryCode: z.string().regex(/^[A-Z_]+$/),
  name: z.string().trim().min(2).max(160),
  description: optText(2000),
  visibility: z.enum(VISIBILITY_LEVELS),
  availabilityStatus: z.enum(AVAILABILITY_STATUSES),
  reportedQuantity: z
    .union([z.literal(""), z.coerce.number().min(0).max(1e9)])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  quantityUnit: optText(40),
  quantityBasis: z.enum(["REPORTED", "VERIFIED_COUNT"]).default("REPORTED"),
});

export const availabilitySchema = z.object({
  availabilityStatus: z.enum(AVAILABILITY_STATUSES),
  reportedQuantity: z
    .union([z.literal(""), z.coerce.number().min(0).max(1e9)])
    .optional()
    .transform((v) => (v === "" || v === undefined ? null : v)),
  quantityUnit: optText(40),
  quantityBasis: z.enum(["REPORTED", "VERIFIED_COUNT"]).default("REPORTED"),
  note: optText(1000),
  isCorrection: z.coerce.boolean().default(false),
});

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw fromDbError(err);
  }
}

type SiteRow = {
  id: string; org_id: string; name: string; description: string | null; visibility: Visibility;
  lat: number; lng: number; address_line: string | null; city: string | null; county: string | null;
  state: string | null; postal_code: string | null; hours_text: string | null; public_phone: string | null;
  status: string; last_confirmed_at: Date | null; updated_at: Date; is_synthetic: boolean;
};

const SITE_COLUMNS = `s.id, s.org_id, s.name, s.description, s.visibility::text AS visibility,
  ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng, s.address_line, s.city, s.county,
  s.state, s.postal_code, s.hours_text, s.public_phone, s.status::text AS status, s.last_confirmed_at,
  s.updated_at, s.is_synthetic`;

function siteSnapshot(r: SiteRow) {
  return {
    name: r.name, visibility: r.visibility, lat: r.lat, lng: r.lng, addressLine: r.address_line, city: r.city,
    county: r.county, state: r.state, postalCode: r.postal_code, hoursText: r.hours_text,
    publicPhone: r.public_phone, status: r.status, description: r.description,
  };
}

async function loadSite(tx: Tx, siteId: string): Promise<SiteRow> {
  if (!z.string().uuid().safeParse(siteId).success) throw new AppError("NOT_FOUND", "Site not found.");
  const rows = await tx.query<SiteRow>(`SELECT ${SITE_COLUMNS} FROM staging_sites s WHERE s.id = $1`, [siteId]);
  if (!rows.length) throw new AppError("NOT_FOUND", "Site not found.");
  return rows[0];
}

async function assertCanEdit(tx: Tx, orgId: string): Promise<void> {
  const r = await tx.query<{ ok: boolean }>(`SELECT ics.can_edit_org($1) AS ok`, [orgId]);
  if (!r[0]?.ok) throw new AppError("FORBIDDEN", "Your organization role does not allow editing this site.");
}

async function recordEvent(
  tx: Tx,
  e: {
    siteId: string; orgId: string; actor: string; type: string; resourceId?: string | null;
    before?: unknown; after?: unknown; basis?: string | null; note?: string | null;
  },
) {
  await tx.query(
    `INSERT INTO resource_update_events (resource_id, site_id, org_id, actor_user_id, event_type, quantity_basis,
                                         before_state, after_state, note)
     VALUES ($1, $2, $3, $4, $5, $6::quantity_basis, $7::jsonb, $8::jsonb, $9)`,
    [
      e.resourceId ?? null, e.siteId, e.orgId, e.actor, e.type, e.basis ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.note ?? null,
    ],
  );
}

/** SOP-002. Approved org editors publish immediately; RLS enforces org ownership and approval. */
export async function createSite(driver: Driver, userId: string, orgId: string, raw: unknown): Promise<string> {
  const input = parseOrThrow(siteSchema, raw);
  if (!z.string().uuid().safeParse(orgId).success) throw new AppError("NOT_FOUND", "Organization not found.");
  return guarded(() =>
    runIn(driver, { kind: "viewer", userId }, async (tx) => {
      await assertCanEdit(tx, orgId);
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO staging_sites (org_id, name, description, visibility, location, address_line, city, county, state,
                                    postal_code, hours_text, public_phone, last_confirmed_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4::visibility_level, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7, $8, $9, $10,
                 $11, $12, $13, now(), ics.viewer_id(), ics.viewer_id())
         RETURNING id`,
        [
          orgId, input.name, input.description, input.visibility, input.lng, input.lat, input.addressLine,
          input.city, input.county, input.state, input.postalCode, input.hoursText, input.publicPhone,
        ],
      );
      const id = rows[0].id;
      await recordEvent(tx, { siteId: id, orgId, actor: userId, type: "SITE_CREATED", after: input });
      await writeAudit(tx, { actorUserId: userId, actorOrgId: orgId, action: "SITE_CREATED", subjectType: "staging_site", subjectId: id, details: { visibility: input.visibility } });
      return id;
    }),
  );
}

export async function updateSite(driver: Driver, userId: string, siteId: string, raw: unknown): Promise<void> {
  const input = parseOrThrow(siteSchema, raw);
  await guarded(() =>
    runIn(driver, { kind: "viewer", userId }, async (tx) => {
      const before = await loadSite(tx, siteId);
      await assertCanEdit(tx, before.org_id);
      if (before.status !== "ACTIVE") throw new AppError("CONFLICT", "Archived sites cannot be edited.");
      const rows = await tx.query<{ id: string }>(
        `UPDATE staging_sites SET name = $2, description = $3, visibility = $4::visibility_level,
                location = ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, address_line = $7, city = $8,
                county = $9, state = $10, postal_code = $11, hours_text = $12, public_phone = $13,
                last_confirmed_at = now(), updated_by = ics.viewer_id()
          WHERE id = $1 RETURNING id`,
        [
          siteId, input.name, input.description, input.visibility, input.lng, input.lat, input.addressLine,
          input.city, input.county, input.state, input.postalCode, input.hoursText, input.publicPhone,
        ],
      );
      if (!rows.length) throw new AppError("FORBIDDEN", "You cannot edit this site.");
      await recordEvent(tx, { siteId, orgId: before.org_id, actor: userId, type: "SITE_EDITED", before: siteSnapshot(before), after: input });
      await writeAudit(tx, { actorUserId: userId, actorOrgId: before.org_id, action: "SITE_EDITED", subjectType: "staging_site", subjectId: siteId,
        details: before.visibility !== input.visibility ? { visibilityFrom: before.visibility, visibilityTo: input.visibility } : {} });
    }),
  );
}

export async function archiveSite(driver: Driver, userId: string, siteId: string, note?: string): Promise<void> {
  await guarded(() =>
    runIn(driver, { kind: "viewer", userId }, async (tx) => {
      const before = await loadSite(tx, siteId);
      await assertCanEdit(tx, before.org_id);
      const rows = await tx.query<{ id: string }>(
        `UPDATE staging_sites SET status = 'ARCHIVED', archived_at = now(), updated_by = ics.viewer_id()
          WHERE id = $1 AND status = 'ACTIVE' RETURNING id`,
        [siteId],
      );
      if (!rows.length) throw new AppError("CONFLICT", "Site is already archived.");
      await recordEvent(tx, { siteId, orgId: before.org_id, actor: userId, type: "SITE_ARCHIVED", before: siteSnapshot(before), note: note ?? null });
      await writeAudit(tx, { actorUserId: userId, actorOrgId: before.org_id, action: "SITE_ARCHIVED", subjectType: "staging_site", subjectId: siteId });
    }),
  );
}

export async function confirmSite(driver: Driver, userId: string, siteId: string): Promise<void> {
  await guarded(() =>
    runIn(driver, { kind: "viewer", userId }, async (tx) => {
      const s = await loadSite(tx, siteId);
      await assertCanEdit(tx, s.org_id);
      await tx.query(`UPDATE staging_sites SET last_confirmed_at = now(), updated_by = ics.viewer_id() WHERE id = $1`, [siteId]);
      await recordEvent(tx, { siteId, orgId: s.org_id, actor: userId, type: "SITE_CONFIRMED" });
    }),
  );
}

export type SiteSummary = {
  id: string; name: string; visibility: Visibility; status: string; city: string | null; state: string | null;
  lastConfirmedAt: Date | null; updatedAt: Date; resourceCount: number; isSynthetic: boolean;
};

export async function listOrgSites(driver: Driver, userId: string, orgId: string): Promise<SiteSummary[]> {
  if (!z.string().uuid().safeParse(orgId).success) return [];
  return runIn(driver, { kind: "viewer", userId }, async (tx) => {
    const rows = await tx.query<SiteRow & { resource_count: number }>(
      `SELECT ${SITE_COLUMNS},
              (SELECT count(*)::int FROM resources r WHERE r.site_id = s.id AND r.status = 'ACTIVE') AS resource_count
         FROM staging_sites s
        WHERE s.org_id = $1 AND ics.is_member($1)
        ORDER BY s.status, s.updated_at DESC`,
      [orgId],
    );
    return rows.map((r) => ({
      id: r.id, name: r.name, visibility: r.visibility, status: r.status, city: r.city, state: r.state,
      lastConfirmedAt: r.last_confirmed_at, updatedAt: r.updated_at, resourceCount: r.resource_count, isSynthetic: r.is_synthetic,
    }));
  });
}

export type ResourceDetail = {
  id: string; categoryCode: string; categoryLabel: string; name: string; description: string | null;
  visibility: Visibility; status: string; availabilityStatus: string; reportedQuantity: string | null;
  quantityUnit: string | null; quantityBasis: string; lastConfirmedAt: Date | null; freshness: string;
  reviewDueAt: Date | null;
};

export type SiteEvent = { id: string; eventType: string; createdAt: Date; actorName: string | null; note: string | null; resourceName: string | null };

export type SiteDetail = SiteSummary & {
  orgId: string; description: string | null; lat: number; lng: number; addressLine: string | null;
  county: string | null; postalCode: string | null; hoursText: string | null; publicPhone: string | null;
  canEdit: boolean; resources: ResourceDetail[]; events: SiteEvent[];
  imageId: string | null; imageAlt: string | null;
};

export async function getSiteDetail(driver: Driver, userId: string, siteId: string): Promise<SiteDetail> {
  return guarded(() =>
    runIn(driver, { kind: "viewer", userId }, async (tx) => {
      const s = await loadSite(tx, siteId);
      const member = await tx.query<{ ok: boolean; edit: boolean }>(`SELECT ics.is_member($1) AS ok, ics.can_edit_org($1) AS edit`, [s.org_id]);
      if (!member[0].ok) throw new AppError("NOT_FOUND", "Site not found.");
      const resources = await tx.query<Record<string, unknown>>(
        `SELECT r.id, r.category_code, c.label, r.name, r.description, r.visibility::text AS visibility, r.status::text AS status,
                coalesce(a.availability_status::text, 'UNKNOWN') AS availability_status, a.reported_quantity::text AS reported_quantity,
                a.quantity_unit, coalesce(a.quantity_basis::text, 'REPORTED') AS quantity_basis, a.last_confirmed_at,
                ics.freshness_state('RESOURCE', r.category_code, a.last_confirmed_at) AS freshness,
                a.last_confirmed_at + ics.freshness_interval('RESOURCE', r.category_code) AS review_due_at
           FROM resources r JOIN resource_categories c ON c.code = r.category_code
           LEFT JOIN resource_availability a ON a.resource_id = r.id
          WHERE r.site_id = $1 ORDER BY r.status, c.sort_order, r.name`,
        [siteId],
      );
      const image = await tx.query<{ id: string; alt_text: string }>(
        `SELECT id, alt_text FROM site_images WHERE site_id = $1 AND status = 'ACTIVE'`,
        [siteId],
      );
      const events = await tx.query<Record<string, unknown>>(
        `SELECT e.id, e.event_type, e.created_at, e.note, r.name AS resource_name
           FROM resource_update_events e LEFT JOIN resources r ON r.id = e.resource_id
          WHERE e.site_id = $1 ORDER BY e.created_at DESC LIMIT 25`,
        [siteId],
      );
      return {
        id: s.id, orgId: s.org_id, name: s.name, visibility: s.visibility, status: s.status, city: s.city, state: s.state,
        lastConfirmedAt: s.last_confirmed_at, updatedAt: s.updated_at, isSynthetic: s.is_synthetic,
        resourceCount: resources.filter((r) => r.status === "ACTIVE").length,
        description: s.description, lat: s.lat, lng: s.lng, addressLine: s.address_line, county: s.county,
        postalCode: s.postal_code, hoursText: s.hours_text, publicPhone: s.public_phone, canEdit: member[0].edit,
        imageId: image[0]?.id ?? null, imageAlt: image[0]?.alt_text ?? null,
        resources: resources.map((r) => ({
          id: r.id as string, categoryCode: r.category_code as string, categoryLabel: r.label as string, name: r.name as string,
          description: r.description as string | null, visibility: r.visibility as Visibility, status: r.status as string,
          availabilityStatus: r.availability_status as string, reportedQuantity: r.reported_quantity as string | null,
          quantityUnit: r.quantity_unit as string | null, quantityBasis: r.quantity_basis as string,
          lastConfirmedAt: r.last_confirmed_at as Date | null, freshness: r.freshness as string, reviewDueAt: r.review_due_at as Date | null,
        })),
        events: events.map((e) => ({
          id: e.id as string, eventType: e.event_type as string, createdAt: e.created_at as Date,
          actorName: null, note: e.note as string | null, resourceName: e.resource_name as string | null,
        })),
      };
    }),
  );
}

export async function createResource(driver: Driver, userId: string, siteId: string, raw: unknown): Promise<string> {
  const input = parseOrThrow(resourceSchema, raw);
  if (input.reportedQuantity !== null && !input.quantityUnit) {
    throw new AppError("VALIDATION", "Enter a unit for the quantity.", { quantityUnit: ["Required when a quantity is entered"] });
  }
  return guarded(() =>
    runIn(driver, { kind: "viewer", userId }, async (tx) => {
      const s = await loadSite(tx, siteId);
      await assertCanEdit(tx, s.org_id);
      if (!isResourceVisibilityAllowed(s.visibility, input.visibility)) {
        throw new AppError("VALIDATION", "A resource cannot be more visible than its site.", { visibility: ["Choose the site's visibility or stricter"] });
      }
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO resources (site_id, org_id, category_code, name, description, visibility, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::visibility_level, ics.viewer_id()) RETURNING id`,
        [siteId, s.org_id, input.categoryCode, input.name, input.description, input.visibility],
      );
      const id = rows[0].id;
      await tx.query(
        `INSERT INTO resource_availability (resource_id, availability_status, reported_quantity, quantity_unit, quantity_basis,
                                            last_confirmed_at, last_confirmed_by)
         VALUES ($1, $2::availability_status, $3, $4, $5::quantity_basis, now(), ics.viewer_id())`,
        [id, input.availabilityStatus, input.reportedQuantity, input.quantityUnit, input.quantityBasis],
      );
      await recordEvent(tx, { siteId, orgId: s.org_id, actor: userId, type: "RESOURCE_CREATED", resourceId: id, after: input, basis: input.quantityBasis });
      await writeAudit(tx, { actorUserId: userId, actorOrgId: s.org_id, action: "RESOURCE_CREATED", subjectType: "resource", subjectId: id });
      return id;
    }),
  );
}

async function loadResource(tx: Tx, resourceId: string) {
  if (!z.string().uuid().safeParse(resourceId).success) throw new AppError("NOT_FOUND", "Resource not found.");
  const rows = await tx.query<{
    id: string; site_id: string; org_id: string; status: string; availability_status: string | null;
    reported_quantity: string | null; quantity_unit: string | null; quantity_basis: string | null;
  }>(
    `SELECT r.id, r.site_id, r.org_id, r.status::text AS status, a.availability_status::text AS availability_status,
            a.reported_quantity::text AS reported_quantity, a.quantity_unit, a.quantity_basis::text AS quantity_basis
       FROM resources r LEFT JOIN resource_availability a ON a.resource_id = r.id WHERE r.id = $1`,
    [resourceId],
  );
  if (!rows.length) throw new AppError("NOT_FOUND", "Resource not found.");
  return rows[0];
}

/** SOP-003 / SOP-004. Each update is an append-only event; corrections are labelled as such. */
export async function updateAvailability(driver: Driver, userId: string, resourceId: string, raw: unknown): Promise<void> {
  const input = parseOrThrow(availabilitySchema, raw);
  if (input.reportedQuantity !== null && !input.quantityUnit) {
    throw new AppError("VALIDATION", "Enter a unit for the quantity.", { quantityUnit: ["Required when a quantity is entered"] });
  }
  if (input.isCorrection && !input.note) {
    throw new AppError("VALIDATION", "Corrections need a note explaining what was wrong.", { note: ["Required for corrections"] });
  }
  await guarded(() =>
    runIn(driver, { kind: "viewer", userId }, async (tx) => {
      const r = await loadResource(tx, resourceId);
      await assertCanEdit(tx, r.org_id);
      if (r.status !== "ACTIVE") throw new AppError("CONFLICT", "Archived resources cannot be updated.");
      // A status-only update (one-tap buttons) must not erase the existing quantity.
      const statusOnly = typeof raw === "object" && raw !== null && !("reportedQuantity" in raw);
      if (statusOnly) {
        input.reportedQuantity = r.reported_quantity === null ? null : Number(r.reported_quantity);
        input.quantityUnit = r.quantity_unit;
        input.quantityBasis = (r.quantity_basis as "REPORTED" | "VERIFIED_COUNT" | null) ?? "REPORTED";
      }
      await tx.query(
        `INSERT INTO resource_availability (resource_id, availability_status, reported_quantity, quantity_unit, quantity_basis,
                                            last_confirmed_at, last_confirmed_by)
         VALUES ($1, $2::availability_status, $3, $4, $5::quantity_basis, now(), ics.viewer_id())
         ON CONFLICT (resource_id) DO UPDATE SET availability_status = EXCLUDED.availability_status,
           reported_quantity = EXCLUDED.reported_quantity, quantity_unit = EXCLUDED.quantity_unit,
           quantity_basis = EXCLUDED.quantity_basis, last_confirmed_at = now(), last_confirmed_by = ics.viewer_id()`,
        [resourceId, input.availabilityStatus, input.reportedQuantity, input.quantityUnit, input.quantityBasis],
      );
      await recordEvent(tx, {
        siteId: r.site_id, orgId: r.org_id, actor: userId, resourceId,
        type: input.isCorrection ? "CORRECTION" : "AVAILABILITY_UPDATED",
        before: { availabilityStatus: r.availability_status, reportedQuantity: r.reported_quantity, quantityUnit: r.quantity_unit, quantityBasis: r.quantity_basis },
        after: { availabilityStatus: input.availabilityStatus, reportedQuantity: input.reportedQuantity, quantityUnit: input.quantityUnit, quantityBasis: input.quantityBasis },
        basis: input.quantityBasis, note: input.note,
      });
    }),
  );
}

/** One-tap "still accurate": resets freshness without changing values. */
export async function confirmResource(driver: Driver, userId: string, resourceId: string): Promise<void> {
  await guarded(() =>
    runIn(driver, { kind: "viewer", userId }, async (tx) => {
      const r = await loadResource(tx, resourceId);
      await assertCanEdit(tx, r.org_id);
      const rows = await tx.query<{ resource_id: string }>(
        `UPDATE resource_availability SET last_confirmed_at = now(), last_confirmed_by = ics.viewer_id()
          WHERE resource_id = $1 RETURNING resource_id`,
        [resourceId],
      );
      if (!rows.length) throw new AppError("CONFLICT", "Set an availability status first.");
      await recordEvent(tx, { siteId: r.site_id, orgId: r.org_id, actor: userId, resourceId, type: "AVAILABILITY_CONFIRMED" });
    }),
  );
}

export async function archiveResource(driver: Driver, userId: string, resourceId: string): Promise<void> {
  await guarded(() =>
    runIn(driver, { kind: "viewer", userId }, async (tx) => {
      const r = await loadResource(tx, resourceId);
      await assertCanEdit(tx, r.org_id);
      const rows = await tx.query<{ id: string }>(
        `UPDATE resources SET status = 'ARCHIVED', archived_at = now() WHERE id = $1 AND status = 'ACTIVE' RETURNING id`,
        [resourceId],
      );
      if (!rows.length) throw new AppError("CONFLICT", "Resource is already archived.");
      await recordEvent(tx, { siteId: r.site_id, orgId: r.org_id, actor: userId, resourceId, type: "RESOURCE_ARCHIVED" });
      await writeAudit(tx, { actorUserId: userId, actorOrgId: r.org_id, action: "RESOURCE_ARCHIVED", subjectType: "resource", subjectId: resourceId });
    }),
  );
}

export async function listCategories(driver: Driver): Promise<{ code: string; label: string }[]> {
  return runIn(driver, { kind: "anon" }, (tx) =>
    tx.query<{ code: string; label: string }>(`SELECT code, label FROM resource_categories WHERE active ORDER BY sort_order`),
  );
}
