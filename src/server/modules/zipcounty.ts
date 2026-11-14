import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Driver, Tx } from "../db";
import { runIn } from "../db/context";

/** Static, versioned crosswalk shipped with the code. Replace by re-running scripts/build-zip-county.mjs. */
export const ZIP_COUNTY_CSV = path.join(/* turbopackIgnore: true */ process.cwd(), "db", "data", "zip_county_nc_sc.csv");
const SETTING_KEY = "zip_county_sha256";

export type ZipCountyRow = { zip: string; countyFips: string; state: string; countyName: string; landShare: number };

/** Parses the committed CSV (header: zip,county_fips,state,county_name,land_share). Rejects malformed rows. */
export function parseZipCountyCsv(text: string): ZipCountyRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.shift()?.trim() !== "zip,county_fips,state,county_name,land_share") throw new Error("Unrecognized ZIP-county file header");
  return lines.map((line, i) => {
    const m = /^(\d{5}),(\d{5}),([A-Z]{2}),"([^"]{1,80})",([01](?:\.\d+)?)$/.exec(line);
    if (!m) throw new Error(`Bad ZIP-county row ${i + 2}`);
    return { zip: m[1], countyFips: m[2], state: m[3], countyName: m[4], landShare: Number(m[5]) };
  });
}

/**
 * Loads the static crosswalk when it is new or changed (compared by SHA-256, kept in platform_settings), then
 * back-fills `counties.fips` for counties whose state and name match. Idempotent; a no-op when unchanged.
 */
export async function syncZipCounty(driver: Driver, csvPath = ZIP_COUNTY_CSV): Promise<{ changed: boolean; rows: number }> {
  const text = readFileSync(/* turbopackIgnore: true */ csvPath, "utf8");
  const sha = createHash("sha256").update(text).digest("hex");
  const rows = parseZipCountyCsv(text);
  return runIn(driver, { kind: "system" }, async (tx) => {
    const cur = await tx.query<{ v: string }>(`SELECT value #>> '{}' AS v FROM platform_settings WHERE key = $1`, [SETTING_KEY]);
    if (cur[0]?.v === sha) return { changed: false, rows: rows.length };
    await tx.query(`DELETE FROM zip_county`);
    const BATCH = 1000;
    for (let i = 0; i < rows.length; i += BATCH) {
      const b = rows.slice(i, i + BATCH);
      await tx.query(
        `INSERT INTO zip_county (zip, county_fips, state, county_name, land_share)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[])`,
        [b.map((r) => r.zip), b.map((r) => r.countyFips), b.map((r) => r.state), b.map((r) => r.countyName), b.map((r) => r.landShare)],
      );
    }
    await tx.query(
      `UPDATE counties c SET fips = z.county_fips
         FROM (SELECT DISTINCT county_fips, state, county_name FROM zip_county) z
        WHERE c.fips IS NULL AND c.state = z.state AND lower(regexp_replace(c.name, ' County$', '', 'i')) = lower(z.county_name)`,
    );
    await tx.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, to_jsonb($2::text))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [SETTING_KEY, sha],
    );
    return { changed: true, rows: rows.length };
  });
}

export type ZipCounty = { countyFips: string; state: string; countyName: string; landShare: number };

/**
 * Counties a ZIP overlaps, largest share first. More than one entry means the person must choose; an empty list
 * means the ZIP is outside the loaded data (not an error by itself: other states are simply not covered).
 */
export async function countiesForZip(tx: Tx, zip: string): Promise<ZipCounty[]> {
  if (!/^\d{5}$/.test(zip)) return [];
  const r = await tx.query<{ county_fips: string; state: string; county_name: string; land_share: string }>(
    `SELECT county_fips, state, county_name, land_share FROM zip_county WHERE zip = $1 ORDER BY land_share DESC, county_fips`,
    [zip],
  );
  return r.map((x) => ({ countyFips: x.county_fips, state: x.state, countyName: x.county_name, landShare: Number(x.land_share) }));
}

/**
 * True unless the data proves the ZIP is outside the county. ZIPs with no crosswalk row, and counties with no
 * FIPS code yet, are not rejected (the data does not cover them).
 */
export async function zipMatchesCounty(tx: Tx, zip: string, countyId: string): Promise<boolean> {
  const r = await tx.query<{ known: boolean; match: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM zip_county WHERE zip = $1) AS known,
            EXISTS (SELECT 1 FROM zip_county z JOIN counties c ON c.fips = z.county_fips WHERE z.zip = $1 AND c.id = $2) AS match,
            (SELECT fips IS NOT NULL FROM counties WHERE id = $2) AS has_fips`,
    [zip, countyId],
  );
  const row = r[0] as { known: boolean; match: boolean; has_fips?: boolean };
  if (!row.known || row.has_fips === false) return true;
  return row.match;
}
