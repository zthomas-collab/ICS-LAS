import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "@/server/db";
import { runIn } from "@/server/db/context";
import { createCounty } from "@/server/modules/counties";
import { submitApplication } from "@/server/modules/assistance";
import { countiesForZip, parseZipCountyCsv, syncZipCounty, zipMatchesCounty } from "@/server/modules/zipcounty";
import { freshDb } from "./helpers/db";
import { grantRole, makeUser } from "./helpers/fixtures";

let db: Driver;
let exec: string;
const sys = <T>(fn: (tx: import("@/server/db").Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);

beforeAll(async () => {
  db = await freshDb(); // migrate() loads the shipped static crosswalk
  exec = await makeUser(db, "exec@example.test");
  await grantRole(db, exec, "PLATFORM_ADMIN");
});
afterAll(async () => db?.close());

describe("static ZIP-county crosswalk", () => {
  it("is loaded by migrate for North and South Carolina", async () => {
    const r = await sys((tx) => tx.query<{ n: number; states: string }>(`SELECT count(*)::int AS n, string_agg(DISTINCT state, ',' ORDER BY state) AS states FROM zip_county`));
    expect(r[0].n).toBeGreaterThan(1500);
    expect(r[0].states).toBe("NC,SC");
  });

  it("maps a single-county ZIP and reports every county for a ZIP that spans several", async () => {
    const asheville = await sys((tx) => countiesForZip(tx, "28801"));
    expect(asheville).toHaveLength(1);
    expect(asheville[0]).toMatchObject({ countyName: "Buncombe", state: "NC" });
    const multi = await sys((tx) => tx.query<{ zip: string }>(`SELECT zip FROM zip_county GROUP BY zip HAVING count(*) > 1 ORDER BY zip LIMIT 1`));
    const counties = await sys((tx) => countiesForZip(tx, multi[0].zip));
    expect(counties.length).toBeGreaterThan(1);
    expect(counties[0].landShare).toBeGreaterThanOrEqual(counties[1].landShare);
    expect(await sys((tx) => countiesForZip(tx, "abcde"))).toEqual([]);
  });

  it("is idempotent and only reloads when the shipped file changes", async () => {
    expect((await syncZipCounty(db)).changed).toBe(false);
    const dir = mkdtempSync(path.join(tmpdir(), "zc-"));
    const f = path.join(dir, "zc.csv");
    writeFileSync(f, `zip,county_fips,state,county_name,land_share\n28801,37021,NC,"Buncombe",1.0000\n`);
    expect((await syncZipCounty(db, f)).changed).toBe(true);
    expect((await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM zip_county`)))[0].n).toBe(1);
    expect((await syncZipCounty(db)).changed).toBe(true); // restored to the shipped data
    expect((await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM zip_county`)))[0].n).toBeGreaterThan(1500);
  });

  it("rejects malformed files", () => {
    expect(() => parseZipCountyCsv("a,b\n")).toThrow();
    expect(() => parseZipCountyCsv(`zip,county_fips,state,county_name,land_share\n1234,37021,NC,"X",1\n`)).toThrow(/Bad ZIP-county row/);
  });

  it("back-fills the FIPS code on counties by name and state", async () => {
    const id = await createCounty(db, exec, { name: "Buncombe", state: "NC" });
    await syncZipCounty(db, path.join(process.cwd(), "db", "data", "zip_county_nc_sc.csv")); // unchanged: no-op
    await sys((tx) => tx.query(`UPDATE platform_settings SET value = to_jsonb('stale'::text) WHERE key = 'zip_county_sha256'`));
    await syncZipCounty(db);
    const r = await sys((tx) => tx.query<{ fips: string }>(`SELECT fips FROM counties WHERE id = $1`, [id]));
    expect(r[0].fips).toBe("37021");
  });

  it("zipMatchesCounty rejects a ZIP outside the county, and does not reject what the data does not cover", async () => {
    const buncombe = (await sys((tx) => tx.query<{ id: string }>(`SELECT id FROM counties WHERE name = 'Buncombe'`)))[0].id;
    const aiken = await createCounty(db, exec, { name: "Aiken", state: "SC" });
    await syncZipCounty(db, path.join(process.cwd(), "db", "data", "zip_county_nc_sc.csv"));
    await sys((tx) => tx.query(`UPDATE platform_settings SET value = to_jsonb('stale'::text) WHERE key = 'zip_county_sha256'`));
    await syncZipCounty(db);
    expect(await sys((tx) => zipMatchesCounty(tx, "28801", buncombe))).toBe(true);
    expect(await sys((tx) => zipMatchesCounty(tx, "28801", aiken))).toBe(false);
    expect(await sys((tx) => zipMatchesCounty(tx, "99999", aiken))).toBe(true); // unknown ZIP: not provably wrong
    const noFips = await createCounty(db, exec, { name: "Zeta", state: "NC" });
    expect(await sys((tx) => zipMatchesCounty(tx, "28801", noFips))).toBe(true); // county without FIPS: not provably wrong
  });

  it("an assistance application whose ZIP is provably in another county is refused", async () => {
    process.env.ASSISTANCE_ENABLED = "true";
    try {
      const buncombe = (await sys((tx) => tx.query<{ id: string }>(`SELECT id FROM counties WHERE name = 'Buncombe'`)))[0].id;
      const aiken = (await sys((tx) => tx.query<{ id: string }>(`SELECT id FROM counties WHERE name = 'Aiken'`)))[0].id;
      const resident = await makeUser(db, "resident@example.test");
      const form = (countyId: string) => ({
        countyId, zip: "28801", categoryCode: "HOUSING", summary: "Roof damage", situation: "Roof collapsed.", householdSize: "2",
        contactPhone: "", preferredContact: "EMAIL", consentShareProviders: "on",
      });
      await expect(submitApplication(db, resident, form(aiken))).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(submitApplication(db, resident, form(buncombe))).resolves.toMatch(/[0-9a-f-]{36}/);
    } finally {
      delete process.env.ASSISTANCE_ENABLED;
    }
  });
});
