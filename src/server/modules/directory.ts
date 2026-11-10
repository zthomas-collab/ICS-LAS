import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { checkbox, parseOrThrow, serviceTypeList } from "./identity";
import { assertPlatformAdmin } from "./organizations";
import { writeAudit } from "./shared";

/**
 * Service types (map legend) and the public Black Book of approved organizations.
 * The public Black Book only lists organizations that consented to publication, and only
 * their public channels. Restricted contacts are never part of these read models.
 */

export type ServiceType = { code: string; label: string; shortLabel: string; color: string; description: string | null };

export async function listServiceTypes(driver: Driver): Promise<ServiceType[]> {
  const rows = await runIn(driver, { kind: "anon" }, (tx) =>
    tx.query<{ code: string; label: string; short_label: string; color: string; description: string | null }>(
      `SELECT code, label, short_label, color, description FROM service_types WHERE active ORDER BY sort_order`,
    ),
  );
  return rows.map((r) => ({ code: r.code, label: r.label, shortLabel: r.short_label, color: r.color, description: r.description }));
}

export type ContactEntry = {
  id: string;
  displayName: string;
  description: string | null;
  website: string | null;
  publicPhone: string | null;
  publicEmail: string | null;
  publicPostalCode: string | null;
  serviceType: string;
  serviceLabel: string;
  serviceShort: string;
  serviceColor: string;
  additionalServiceTypes: string[];
  publicSiteCount: number;
  /** Distance in miles from the searched ZIP to the nearest public location or office ZIP. */
  distanceMiles: number | null;
  approvedAt: Date | null;
  updatedAt: Date;
  isSynthetic: boolean;
};

export const RADIUS_OPTIONS_MILES = [5, 10, 25, 50, 100] as const;
export const DEFAULT_RADIUS_MILES = 25;
const METERS_PER_MILE = 1609.344;

export const contactsQuerySchema = z.object({
  q: z.string().trim().max(80).optional().default(""),
  service: z
    .string()
    .regex(/^[A-Z_]{2,40}$/)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  zip: z
    .string()
    .trim()
    .regex(/^[0-9]{5}$/, "Enter a 5-digit ZIP code")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  radius: z.coerce
    .number()
    .refine((v) => (RADIUS_OPTIONS_MILES as readonly number[]).includes(v), "Choose a listed radius")
    .optional()
    .default(DEFAULT_RADIUS_MILES),
});

export type ContactsSearch = {
  entries: ContactEntry[];
  zip: string | null;
  radiusMiles: number;
  /** "zip_table" = official ZIP centroid; "site_centroid" = estimated from listed sites; "unknown" = exact-ZIP matching only. */
  zipResolution: "zip_table" | "site_centroid" | "unknown" | null;
};

function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Public Contacts search (no sign-in). Runs as ics_anon against public read models only.
 * Text terms match name, description and service types; ZIP + radius matches organizations
 * with a public location (or public office ZIP) within the radius, nearest first.
 */
export async function searchContacts(driver: Driver, raw: unknown = {}): Promise<ContactsSearch> {
  const parsed = contactsQuerySchema.safeParse(raw);
  if (!parsed.success) throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid search");
  const q = parsed.data;
  const terms = q.q.split(/\s+/).filter(Boolean).slice(0, 6).map(likePattern);
  const zip = q.zip ?? null;
  return runIn(driver, { kind: "anon" }, async (tx) => {
    let zipResolution: ContactsSearch["zipResolution"] = null;
    if (zip) {
      const r = await tx.query<{ official: boolean; any: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM zip_codes WHERE zip = $1) AS official, ics.zip_point($1) IS NOT NULL AS any`,
        [zip],
      );
      zipResolution = r[0].official ? "zip_table" : r[0].any ? "site_centroid" : "unknown";
    }
    const rows = await tx.query<Record<string, unknown>>(
      `WITH origin AS (SELECT CASE WHEN $3::text IS NULL THEN NULL ELSE ics.zip_point($3) END AS pt)
       SELECT c.id, c.display_name, c.description, c.website, c.public_phone, c.public_email, c.public_postal_code,
              c.service_type, c.service_label, c.service_short, c.service_color, c.additional_service_types,
              c.public_site_count, c.approved_at, c.updated_at, c.is_synthetic, d.dist_m
         FROM public_contacts c
        CROSS JOIN origin
         LEFT JOIN LATERAL (
              SELECT min(ST_Distance(x.loc, origin.pt)) AS dist_m
                FROM (SELECT ps.location AS loc FROM public_sites ps WHERE ps.org_id = c.id
                      UNION ALL
                      SELECT ics.zip_point(c.public_postal_code) WHERE c.public_postal_code IS NOT NULL) x
               WHERE origin.pt IS NOT NULL AND x.loc IS NOT NULL
         ) d ON true
        WHERE NOT EXISTS (SELECT 1 FROM unnest($1::text[]) t
                           WHERE NOT (c.display_name ILIKE t OR coalesce(c.description, '') ILIKE t OR coalesce(c.service_text, '') ILIKE t))
          AND ($2::text IS NULL OR c.service_type = $2 OR $2 = ANY (c.additional_service_types))
          AND ($3::text IS NULL
               OR (origin.pt IS NOT NULL AND d.dist_m <= $4)
               OR (origin.pt IS NULL AND (c.public_postal_code = $3
                   OR EXISTS (SELECT 1 FROM public_sites ps WHERE ps.org_id = c.id AND ps.postal_code = $3))))
        ORDER BY d.dist_m NULLS LAST, c.display_name
        LIMIT 200`,
      [terms, q.service ?? null, zip, q.radius * METERS_PER_MILE],
    );
    return {
      zip,
      radiusMiles: q.radius,
      zipResolution,
      entries: rows.map((r) => ({
        id: r.id as string, displayName: r.display_name as string, description: r.description as string | null,
        website: r.website as string | null, publicPhone: r.public_phone as string | null,
        publicEmail: r.public_email as string | null, publicPostalCode: r.public_postal_code as string | null,
        serviceType: r.service_type as string, serviceLabel: r.service_label as string, serviceShort: r.service_short as string,
        serviceColor: r.service_color as string, additionalServiceTypes: (r.additional_service_types as string[]) ?? [],
        publicSiteCount: r.public_site_count as number,
        distanceMiles: r.dist_m == null ? null : Math.round((Number(r.dist_m) / METERS_PER_MILE) * 10) / 10,
        approvedAt: r.approved_at as Date | null, updatedAt: r.updated_at as Date, isSynthetic: r.is_synthetic as boolean,
      })),
    };
  });
}

export const serviceTypeChangeSchema = z.object({
  orgId: z.string().uuid(),
  primaryServiceType: z.string().regex(/^[A-Z_]{2,40}$/, "Choose a service type"),
  evidenceSummary: z.string().trim().min(5, "Give a reason for the change").max(4000),
});

/** Platform admin changes an approved account's confirmed service type (drives the map legend). */
export async function setPrimaryServiceType(driver: Driver, adminUserId: string, raw: unknown): Promise<void> {
  const input = parseOrThrow(serviceTypeChangeSchema, raw);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await assertPlatformAdmin(tx, adminUserId);
      const before = await tx.query<{ primary_service_type: string | null }>(
        `SELECT primary_service_type FROM organizations WHERE id = $1 AND status IN ('APPROVED','SUSPENDED')`,
        [input.orgId],
      );
      if (!before.length) throw new AppError("NOT_FOUND", "Approved organization not found.");
      await tx.query(`UPDATE organizations SET primary_service_type = $2 WHERE id = $1`, [input.orgId, input.primaryServiceType]);
      await tx.query(`INSERT INTO organization_service_types (org_id, service_type) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        input.orgId,
        input.primaryServiceType,
      ]);
      await tx.query(
        `INSERT INTO organization_verifications (org_id, decision, reviewer_id, evidence_summary) VALUES ($1, 'NOTE', $2, $3)`,
        [input.orgId, adminUserId, `Service type ${before[0].primary_service_type} -> ${input.primaryServiceType}: ${input.evidenceSummary}`],
      );
      await writeAudit(tx, {
        actorUserId: adminUserId,
        actorOrgId: input.orgId,
        action: "ORG_SERVICE_TYPE_CHANGED",
        subjectType: "organization",
        subjectId: input.orgId,
        details: { from: before[0].primary_service_type, to: input.primaryServiceType },
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export type OrganizationProfile = {
  id: string; displayName: string; status: string; description: string | null; website: string | null;
  publicPhone: string | null; publicEmail: string | null; publicPostalCode: string | null; primaryServiceType: string | null;
  requestedServiceType: string | null; offeredServiceTypes: string[]; directoryConsentAt: Date | null; canEdit: boolean;
};

async function membershipRole(tx: Tx, orgId: string, userId: string): Promise<string | null> {
  const r = await tx.query<{ role: string }>(
    `SELECT m.role::text AS role FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = $1 AND m.user_id = $2 AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'`,
    [orgId, userId],
  );
  return r[0]?.role ?? null;
}

const EDITABLE_STATES = ["PENDING_VERIFICATION", "APPROVED"];

export async function getOrganizationProfile(driver: Driver, userId: string, orgId: string): Promise<OrganizationProfile> {
  if (!z.string().uuid().safeParse(orgId).success) throw new AppError("NOT_FOUND", "Organization not found.");
  return runIn(driver, { kind: "system" }, async (tx) => {
    const role = await membershipRole(tx, orgId, userId);
    if (!role) throw new AppError("NOT_FOUND", "Organization not found.");
    const r = (
      await tx.query<Record<string, unknown>>(
        `SELECT o.id, o.display_name, o.status::text AS status, o.description, o.website, o.public_phone, o.public_email, o.public_postal_code,
                o.primary_service_type, o.requested_service_type, o.directory_consent_at,
                coalesce((SELECT array_agg(service_type) FROM organization_service_types WHERE org_id = o.id), '{}') AS offered
           FROM organizations o WHERE o.id = $1`,
        [orgId],
      )
    )[0];
    return {
      id: r.id as string, displayName: r.display_name as string, status: r.status as string,
      description: r.description as string | null, website: r.website as string | null,
      publicPhone: r.public_phone as string | null, publicEmail: r.public_email as string | null,
      publicPostalCode: r.public_postal_code as string | null,
      primaryServiceType: r.primary_service_type as string | null, requestedServiceType: r.requested_service_type as string | null,
      offeredServiceTypes: r.offered as string[], directoryConsentAt: r.directory_consent_at as Date | null,
      canEdit: role === "ORG_ADMIN" && EDITABLE_STATES.includes(r.status as string),
    };
  });
}

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

export const profileSchema = z.object({
  description: optional(2000),
  website: optional(300).refine((v) => v === null || /^https?:\/\//.test(v), "Must start with http:// or https://"),
  publicPhone: optional(40),
  publicEmail: optional(254)
    .transform((v) => (v ? v.toLowerCase() : null))
    .refine((v) => v === null || z.string().email().safeParse(v).success, "Enter a valid email"),
  publicPostalCode: optional(5).refine((v) => v === null || /^[0-9]{5}$/.test(v), "Use a 5-digit ZIP code"),
  additionalServiceTypes: serviceTypeList,
  directoryConsent: checkbox,
});

/** Org admins maintain their public profile and Black Book consent. The primary type stays admin-confirmed. */
export async function updateOrganizationProfile(driver: Driver, userId: string, orgId: string, raw: unknown): Promise<void> {
  const input = parseOrThrow(profileSchema, raw);
  if (!z.string().uuid().safeParse(orgId).success) throw new AppError("NOT_FOUND", "Organization not found.");
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      const role = await membershipRole(tx, orgId, userId);
      if (role !== "ORG_ADMIN") throw new AppError("FORBIDDEN", "Only organization administrators can edit the profile.");
      const before = (
        await tx.query<{ status: string; consent: Date | null; primary_type: string | null; requested: string | null }>(
          `SELECT status::text AS status, directory_consent_at AS consent, primary_service_type AS primary_type,
                  requested_service_type AS requested FROM organizations WHERE id = $1`,
          [orgId],
        )
      )[0];
      if (!EDITABLE_STATES.includes(before.status)) {
        throw new AppError("FORBIDDEN", "This organization's profile cannot be edited in its current state.");
      }
      await tx.query(
        `UPDATE organizations SET description = $2, website = $3, public_phone = $4, public_email = $5, public_postal_code = $8,
                directory_consent_at = CASE WHEN $6 THEN coalesce(directory_consent_at, now()) ELSE NULL END,
                directory_consent_by = CASE WHEN $6 THEN coalesce(directory_consent_by, $7::uuid) ELSE NULL END
          WHERE id = $1`,
        [orgId, input.description, input.website, input.publicPhone, input.publicEmail, input.directoryConsent, userId, input.publicPostalCode],
      );
      const keep = [before.primary_type ?? before.requested].filter((v): v is string => Boolean(v));
      const offered = Array.from(new Set([...keep, ...input.additionalServiceTypes]));
      await tx.query(`DELETE FROM organization_service_types WHERE org_id = $1 AND NOT (service_type = ANY($2::text[]))`, [orgId, offered]);
      await tx.query(
        `INSERT INTO organization_service_types (org_id, service_type) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [orgId, offered],
      );
      const consentChanged = Boolean(before.consent) !== input.directoryConsent;
      await writeAudit(tx, {
        actorUserId: userId,
        actorOrgId: orgId,
        subjectType: "organization",
        subjectId: orgId,
        action: consentChanged ? (input.directoryConsent ? "DIRECTORY_CONSENT_GRANTED" : "DIRECTORY_CONSENT_WITHDRAWN") : "ORG_PROFILE_UPDATED",
        details: { services: offered },
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}
