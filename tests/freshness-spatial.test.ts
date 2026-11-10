import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "@/server/db";
import { runIn } from "@/server/db/context";
import { queryMap, MAX_SPAN_DEG } from "@/server/modules/map";
import { confirmResource, createResource, createSite } from "@/server/modules/sites";
import { freshDb } from "./helpers/db";
import { makeOrg, makeUser, site } from "./helpers/fixtures";

let db: Driver;
let editor: string;
let org: string;

beforeAll(async () => {
  db = await freshDb();
  editor = await makeUser(db, "editor@example.test");
  org = await makeOrg(db, { name: "Fresh Org", members: [{ userId: editor, role: "EDITOR" }] });
});
afterAll(async () => db?.close());

const backdate = (resourceId: string, interval: string) =>
  runIn(db, { kind: "system" }, (tx) =>
    tx.query(`UPDATE resource_availability SET last_confirmed_at = now() - $2::interval WHERE resource_id = $1`, [resourceId, interval]),
  );

describe("freshness (criterion 5)", () => {
  let shelterId: string;
  let waterId: string;
  const bbox = { w: -83, s: 35, e: -82, n: 36 };

  beforeAll(async () => {
    const s = await createSite(db, editor, org, site({ name: "Shelter site" }));
    shelterId = await createResource(db, editor, s, { categoryCode: "SHELTER", name: "Cots", visibility: "PUBLIC", availabilityStatus: "AVAILABLE", reportedQuantity: "40", quantityUnit: "beds" });
    waterId = await createResource(db, editor, s, { categoryCode: "WATER", name: "Water", visibility: "PUBLIC", availabilityStatus: "AVAILABLE" });
  });

  const resources = async (confirmedOnly = false) =>
    (await queryMap(db, null, { ...bbox, confirmedOnly: String(confirmedOnly) })).sites.flatMap((s) => s.resources);

  it("new records are FRESH", async () => {
    expect((await resources()).map((r) => r.freshness)).toEqual(["FRESH", "FRESH"]);
  });

  it("records past their category interval become EXPIRED and drop out of confirmed-only filters", async () => {
    await backdate(shelterId, "13 hours"); // shelter normal interval: 12h
    const all = await resources();
    expect(all.find((r) => r.name === "Cots")).toMatchObject({ freshness: "EXPIRED", reportedStatus: "AVAILABLE" });
    expect(all.find((r) => r.name === "Water")?.freshness).toBe("FRESH");
    expect((await resources(true)).map((r) => r.name)).toEqual(["Water"]);
  });

  it("active-operations mode tightens intervals without a code change", async () => {
    await backdate(waterId, "5 hours"); // water: 12h normal, 4h active ops
    expect((await resources()).find((r) => r.name === "Water")?.freshness).toBe("FRESH");
    await runIn(db, { kind: "system" }, (tx) => tx.query(`UPDATE platform_settings SET value = 'true' WHERE key = 'active_operations'`));
    expect((await resources()).find((r) => r.name === "Water")?.freshness).toBe("EXPIRED");
    await runIn(db, { kind: "system" }, (tx) => tx.query(`UPDATE platform_settings SET value = 'false' WHERE key = 'active_operations'`));
  });

  it("DUE_SOON appears after 75% of the interval", async () => {
    await backdate(waterId, "10 hours");
    expect((await resources()).find((r) => r.name === "Water")?.freshness).toBe("DUE_SOON");
  });

  it("one-tap reconfirmation restores FRESH and preserves history", async () => {
    await confirmResource(db, editor, shelterId);
    expect((await resources()).find((r) => r.name === "Cots")?.freshness).toBe("FRESH");
    const ev = await runIn(db, { kind: "system" }, (tx) =>
      tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM resource_update_events WHERE resource_id = $1`, [shelterId]),
    );
    expect(ev[0].n).toBe(2);
  });
});

describe("spatial query correctness", () => {
  beforeAll(async () => {
    // Points straddling a bbox edge, plus far-away points.
    const pts: [string, number, number][] = [
      ["inside-center", 40.0, -100.0],
      ["inside-near-west-edge", 40.0, -100.999],
      ["outside-just-west", 40.0, -101.001],
      ["inside-near-north-edge", 40.999, -100.0],
      ["outside-just-north", 41.001, -100.0],
      ["far-away", 10.0, 10.0],
    ];
    for (const [name, lat, lng] of pts) await createSite(db, editor, org, site({ name, lat, lng }));
  });

  it("returns exactly the sites inside the bounding box", async () => {
    const r = await queryMap(db, null, { w: -101, s: 39, e: -99, n: 41 });
    expect(r.sites.map((s) => s.name).sort()).toEqual(["inside-center", "inside-near-north-edge", "inside-near-west-edge"]);
    const a = await queryMap(db, editor, { w: -101, s: 39, e: -99, n: 41 });
    expect(a.sites.map((s) => s.name).sort()).toEqual(["inside-center", "inside-near-north-edge", "inside-near-west-edge"]);
  });

  it("round-trips coordinates with full precision", async () => {
    const r = await queryMap(db, null, { w: -101, s: 39, e: -99, n: 41 });
    const p = r.sites.find((s) => s.name === "inside-near-west-edge")!;
    expect(p.lat).toBeCloseTo(40.0, 6);
    expect(p.lng).toBeCloseTo(-100.999, 6);
  });

  it("rejects inverted, out-of-range and oversized boxes", async () => {
    await expect(queryMap(db, null, { w: -99, s: 39, e: -101, n: 41 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(queryMap(db, null, { w: -200, s: 39, e: -99, n: 41 })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(queryMap(db, null, { w: -110, s: 30, e: -110 + MAX_SPAN_DEG + 1, n: 41 })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("caps results and reports truncation", async () => {
    const r = await queryMap(db, null, { w: -101, s: 39, e: -99, n: 41, limit: 2 });
    expect(r.sites).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it("uses the GiST index for viewport queries", async () => {
    const plan = await runIn(db, { kind: "system" }, async (tx) => {
      await tx.query("SET LOCAL enable_seqscan = off");
      return tx.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT id FROM public_sites WHERE location::geometry && ST_MakeEnvelope(-101, 39, -99, 41, 4326)`,
      );
    });
    expect(plan.map((p) => p["QUERY PLAN"]).join("\n")).toMatch(/staging_sites_location_geom_gix/);
  });
});
