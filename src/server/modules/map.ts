import { z } from "zod";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";
import { AppError } from "../errors";
import { parseOrThrow } from "./identity";
import type { Visibility } from "@/lib/domain";

/** Module A: viewport queries. Anonymous callers only ever touch public_* read models. */

export const MAX_SPAN_DEG = 12;
export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;

export const mapQuerySchema = z
  .object({
    w: z.coerce.number().min(-180).max(180),
    s: z.coerce.number().min(-90).max(90),
    e: z.coerce.number().min(-180).max(180),
    n: z.coerce.number().min(-90).max(90),
    categories: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(",").filter((c) => /^[A-Z_]{2,40}$/.test(c)).slice(0, 20) : [])),
    services: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(",").filter((c) => /^[A-Z_]{2,40}$/.test(c)).slice(0, 20) : [])),
    confirmedOnly: z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((v) => v === "true" || v === "1"),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .refine((q) => q.w < q.e && q.s < q.n, { message: "Invalid bounding box" })
  .refine((q) => q.e - q.w <= MAX_SPAN_DEG && q.n - q.s <= MAX_SPAN_DEG, { message: "Zoom in to load resources" });

export type MapQuery = z.infer<typeof mapQuerySchema>;

export type MapResource = {
  id: string; categoryCode: string; categoryLabel: string; name: string; reportedStatus: string; freshness: string;
  reportedQuantity: string | null; quantityUnit: string | null; quantityBasis: string | null;
  lastConfirmedAt: string | null; reviewDueAt: string | null; visibility: Visibility;
};

export type MapSite = {
  id: string; orgId: string; orgName: string; name: string; description: string | null; lat: number; lng: number;
  visibility: Visibility; addressLine: string | null; city: string | null; county: string | null; state: string | null;
  postalCode: string | null; hoursText: string | null; publicPhone: string | null; lastConfirmedAt: string | null;
  updatedAt: string; isSynthetic: boolean; resources: MapResource[];
  serviceType: string | null; serviceLabel: string | null; serviceShort: string | null; serviceColor: string | null;
  imageId: string | null; imageAlt: string | null;
};

export type MapResult = { asOf: string; truncated: boolean; scope: "public" | "authenticated"; sites: MapSite[] };

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d == null ? null : String(d));

const POSITIVE = ["AVAILABLE", "LIMITED"];
const CONFIRMED = ["FRESH", "DUE_SOON"];

function resourceMatches(r: MapResource, q: MapQuery): boolean {
  if (q.categories.length && !q.categories.includes(r.categoryCode)) return false;
  if (q.confirmedOnly && !(POSITIVE.includes(r.reportedStatus) && CONFIRMED.includes(r.freshness))) return false;
  return true;
}

function toResource(r: Record<string, unknown>): MapResource {
  return {
    id: r.id as string, categoryCode: r.category_code as string, categoryLabel: r.category_label as string,
    name: r.name as string, reportedStatus: r.reported_status as string, freshness: r.freshness as string,
    reportedQuantity: (r.reported_quantity as string | null) ?? null, quantityUnit: (r.quantity_unit as string | null) ?? null,
    quantityBasis: (r.quantity_basis as string | null) ?? null, lastConfirmedAt: iso(r.last_confirmed_at),
    reviewDueAt: iso(r.review_due_at), visibility: (r.visibility as Visibility) ?? "PUBLIC",
  };
}

function toSite(r: Record<string, unknown>, resources: MapResource[]): MapSite {
  return {
    id: r.id as string, orgId: r.org_id as string, orgName: r.org_name as string, name: r.name as string,
    description: (r.description as string | null) ?? null, lat: Number(r.lat), lng: Number(r.lng),
    visibility: (r.visibility as Visibility) ?? "PUBLIC", addressLine: r.address_line as string | null,
    city: r.city as string | null, county: r.county as string | null, state: r.state as string | null,
    postalCode: r.postal_code as string | null, hoursText: r.hours_text as string | null,
    publicPhone: r.public_phone as string | null, lastConfirmedAt: iso(r.last_confirmed_at),
    updatedAt: iso(r.updated_at) ?? "", isSynthetic: Boolean(r.is_synthetic), resources,
    serviceType: (r.service_type as string | null) ?? null, serviceLabel: (r.service_label as string | null) ?? null,
    serviceShort: (r.service_short as string | null) ?? null, serviceColor: (r.service_color as string | null) ?? null,
    imageId: (r.image_id as string | null) ?? null, imageAlt: (r.image_alt as string | null) ?? null,
  };
}

function finish(rows: Record<string, unknown>[], resRows: Record<string, unknown>[], q: MapQuery, limit: number, scope: MapResult["scope"]): MapResult {
  const bySite = new Map<string, MapResource[]>();
  for (const rr of resRows) {
    const res = toResource(rr);
    if (!resourceMatches(res, q)) continue;
    const list = bySite.get(rr.site_id as string) ?? [];
    list.push(res);
    bySite.set(rr.site_id as string, list);
  }
  const filtering = q.categories.length > 0 || q.confirmedOnly;
  const sites = rows
    .map((r) => toSite(r, bySite.get(r.id as string) ?? []))
    .filter((s) => !filtering || s.resources.length > 0);
  return { asOf: new Date().toISOString(), truncated: rows.length >= limit, scope, sites };
}

async function publicQuery(tx: Tx, q: MapQuery): Promise<MapResult> {
  const rows = await tx.query<Record<string, unknown>>(
    `SELECT id, org_id, org_name, name, description, lat, lng, address_line, city, county, state, postal_code,
            hours_text, public_phone, last_confirmed_at, updated_at, is_synthetic,
            service_type, service_label, service_short, service_color, image_id, image_alt
       FROM public_sites
      WHERE location::geometry && ST_MakeEnvelope($1, $2, $3, $4, 4326)
        AND (cardinality($6::text[]) = 0 OR service_type = ANY($6::text[]))
      ORDER BY updated_at DESC LIMIT $5`,
    [q.w, q.s, q.e, q.n, q.limit, q.services],
  );
  if (!rows.length) return finish([], [], q, q.limit, "public");
  const res = await tx.query<Record<string, unknown>>(
    `SELECT id, site_id, category_code, category_label, name, reported_status::text AS reported_status, freshness,
            reported_quantity::text AS reported_quantity, quantity_unit, quantity_basis::text AS quantity_basis,
            last_confirmed_at, review_due_at
       FROM public_resources WHERE site_id = ANY($1::uuid[])`,
    [rows.map((r) => r.id)],
  );
  return finish(rows, res, q, q.limit, "public");
}

async function viewerQuery(tx: Tx, q: MapQuery): Promise<MapResult> {
  const ids = (
    await tx.query<{ id: string }>(`SELECT ics.visible_site_ids_in_bbox($1, $2, $3, $4, $5) AS id`, [q.w, q.s, q.e, q.n, q.limit])
  ).map((r) => r.id);
  if (!ids.length) return finish([], [], q, q.limit, "authenticated");
  // Re-read under RLS: authorization is enforced again by the base-table policies.
  const rows = await tx.query<Record<string, unknown>>(
    `SELECT s.id, s.org_id, o.display_name AS org_name, s.name, s.description, s.visibility::text AS visibility,
            ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng, s.address_line, s.city, s.county,
            s.state, s.postal_code, s.hours_text, s.public_phone, s.last_confirmed_at, s.updated_at,
            (s.is_synthetic OR o.is_synthetic) AS is_synthetic,
            o.primary_service_type AS service_type, st.label AS service_label, st.short_label AS service_short,
            st.color AS service_color, img.id AS image_id, img.alt_text AS image_alt
       FROM staging_sites s
       JOIN organizations o ON o.id = s.org_id
       LEFT JOIN service_types st ON st.code = o.primary_service_type
       LEFT JOIN site_images img ON img.site_id = s.id AND img.status = 'ACTIVE' AND img.scan_status IN ('NOT_SCANNED','CLEAN')
      WHERE s.id = ANY($1::uuid[]) AND s.status = 'ACTIVE'
        AND (cardinality($2::text[]) = 0 OR o.primary_service_type = ANY($2::text[]))
      ORDER BY s.updated_at DESC`,
    [ids, q.services],
  );
  const res = await tx.query<Record<string, unknown>>(
    `SELECT r.id, r.site_id, r.category_code, c.label AS category_label, r.name, r.visibility::text AS visibility,
            coalesce(a.availability_status::text, 'UNKNOWN') AS reported_status,
            ics.freshness_state('RESOURCE', r.category_code, a.last_confirmed_at) AS freshness,
            a.reported_quantity::text AS reported_quantity, a.quantity_unit, a.quantity_basis::text AS quantity_basis,
            a.last_confirmed_at, a.last_confirmed_at + ics.freshness_interval('RESOURCE', r.category_code) AS review_due_at
       FROM resources r JOIN resource_categories c ON c.code = r.category_code
       LEFT JOIN resource_availability a ON a.resource_id = r.id
      WHERE r.site_id = ANY($1::uuid[]) AND r.status = 'ACTIVE'`,
    [ids],
  );
  return finish(rows, res, q, q.limit, "authenticated");
}

export async function queryMap(driver: Driver, viewerId: string | null, raw: unknown): Promise<MapResult> {
  const r = mapQuerySchema.safeParse(raw);
  if (!r.success) throw new AppError("VALIDATION", r.error.issues[0]?.message ?? "Invalid query");
  return viewerId
    ? runIn(driver, { kind: "viewer", userId: viewerId }, (tx) => viewerQuery(tx, r.data))
    : runIn(driver, { kind: "anon" }, (tx) => publicQuery(tx, r.data));
}

export type PlaceHit = {
  id: string; name: string; label: string; lat: number; lng: number;
  /** "zip" = the area of a ZIP code (center point); "site" = a listed location. */
  kind: "zip" | "site";
  approximate?: boolean;
};

const searchSchema = z.string().trim().min(2).max(80);

function likePattern(q: string) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Map search. A 5-digit ZIP resolves to the ZIP's center (Census reference data, or estimated
 * from listed public sites) so the map can move there even if no site lists that exact ZIP.
 * Other text matches stored site address fields (no external geocoder configured — missing input M3).
 */
export async function searchPlaces(driver: Driver, viewerId: string | null, raw: unknown): Promise<PlaceHit[]> {
  const q = parseOrThrow(searchSchema, raw);
  const zipHit: PlaceHit[] = [];
  if (/^[0-9]{5}$/.test(q)) {
    const z = await runIn(driver, { kind: "anon" }, (tx) =>
      tx.query<{ lat: number | null; lng: number | null; official: boolean }>(
        `SELECT ST_Y(p::geometry) AS lat, ST_X(p::geometry) AS lng,
                EXISTS (SELECT 1 FROM zip_codes WHERE zip = $1) AS official
           FROM (SELECT ics.zip_point($1) AS p) x`,
        [q],
      ),
    );
    if (z[0]?.lat != null && z[0]?.lng != null) {
      zipHit.push({
        id: `zip:${q}`, kind: "zip", name: `ZIP ${q}`, label: z[0].official ? "ZIP code area" : "ZIP code area (approximate)",
        lat: Number(z[0].lat), lng: Number(z[0].lng), approximate: !z[0].official,
      });
    }
  }
  const pattern = likePattern(q);
  const sql = (from: string, extra: string) => `
    SELECT id, name, concat_ws(', ', nullif(city, ''), nullif(county, ''), nullif(state, ''), nullif(postal_code, '')) AS label,
           ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
      FROM ${from}
     WHERE (city ILIKE $1 OR county ILIKE $1 OR postal_code ILIKE $1 OR address_line ILIKE $1 OR name ILIKE $1) ${extra}
     ORDER BY updated_at DESC LIMIT 20`;
  const map = (rows: Record<string, unknown>[]) =>
    rows.map((r): PlaceHit => ({ id: r.id as string, kind: "site", name: r.name as string, label: r.label as string, lat: Number(r.lat), lng: Number(r.lng) }));
  const sites = viewerId
    ? await runIn(driver, { kind: "viewer", userId: viewerId }, async (tx) =>
        map(await tx.query(sql("staging_sites", "AND status = 'ACTIVE'"), [pattern])),
      )
    : await runIn(driver, { kind: "anon" }, async (tx) => map(await tx.query(sql("public_sites", ""), [pattern])));
  return [...zipHit, ...sites];
}
