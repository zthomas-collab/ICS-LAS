import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "@/server/db";
import { runIn } from "@/server/db/context";
import { queryMap, searchPlaces } from "@/server/modules/map";
import {
  archiveSite,
  createResource,
  createSite,
  getSiteDetail,
  updateAvailability,
  updateSite,
} from "@/server/modules/sites";
import { AppError } from "@/server/errors";
import { freshDb } from "./helpers/db";
import { ASHEVILLE_BBOX, grantRole, makeOrg, makeUser, site, squareAround } from "./helpers/fixtures";

/**
 * Authorization boundary tests (acceptance criteria 2, 3, 4).
 * Every visibility level is checked against every viewer class, through the
 * same service functions the HTTP layer uses, against a real PostGIS database.
 */
let db: Driver;
let editorA: string, viewerA: string, editorB: string, outsider: string, responder: string, responderFar: string, admin: string, pendingUser: string;
let orgA: string, orgB: string, pendingOrg: string;
const siteIds: Record<string, string> = {};

const names = (r: { sites: { name: string }[] }) => r.sites.map((s) => s.name).sort();

beforeAll(async () => {
  db = await freshDb();
  [editorA, viewerA, editorB, outsider, responder, responderFar, admin, pendingUser] = await Promise.all(
    ["a-editor", "a-viewer", "b-editor", "outsider", "responder", "responder-far", "admin", "pending"].map((n) =>
      makeUser(db, `${n}@example.test`),
    ),
  );
  orgA = await makeOrg(db, { name: "Org A", members: [{ userId: editorA, role: "EDITOR" }, { userId: viewerA, role: "VIEWER" }] });
  orgB = await makeOrg(db, { name: "Org B", members: [{ userId: editorB, role: "ORG_ADMIN" }] });
  pendingOrg = await makeOrg(db, { name: "Pending Org", status: "PENDING_VERIFICATION", members: [{ userId: pendingUser, role: "ORG_ADMIN" }] });
  await grantRole(db, responder, "AUTHORIZED_RESPONDER", squareAround(-82.55, 35.6));
  await grantRole(db, responderFar, "AUTHORIZED_RESPONDER", squareAround(-90, 30)); // scope elsewhere
  await grantRole(db, admin, "PLATFORM_ADMIN");

  for (const v of ["PUBLIC", "ORGANIZATION_NETWORK", "AUTHORIZED_RESPONDERS", "PRIVATE_ORGANIZATION"]) {
    siteIds[v] = await createSite(db, editorA, orgA, site({ name: `A-${v}`, visibility: v }));
  }
});

afterAll(async () => db?.close());

describe("site visibility matrix", () => {
  it("anonymous visitors see only PUBLIC sites (criterion 4)", async () => {
    const r = await queryMap(db, null, ASHEVILLE_BBOX);
    expect(r.scope).toBe("public");
    expect(names(r)).toEqual(["A-PUBLIC"]);
  });

  it("anonymous payloads never carry visibility or restricted columns", async () => {
    const r = await queryMap(db, null, ASHEVILLE_BBOX);
    const json = JSON.stringify(r);
    expect(json).not.toContain("private-contact@example.test");
    expect(json).not.toContain("ORGANIZATION_NETWORK");
    expect(json).not.toContain("PRIVATE_ORGANIZATION");
  });

  it("the anonymous DB role cannot read base tables at all", async () => {
    await expect(runIn(db, { kind: "anon" }, (tx) => tx.query("SELECT * FROM staging_sites"))).rejects.toThrow(/permission denied/);
    await expect(runIn(db, { kind: "anon" }, (tx) => tx.query("SELECT * FROM organizations"))).rejects.toThrow(/permission denied/);
    await expect(runIn(db, { kind: "anon" }, (tx) => tx.query("SELECT * FROM users"))).rejects.toThrow(/permission denied/);
  });

  it("members of another approved org see PUBLIC + ORGANIZATION_NETWORK", async () => {
    expect(names(await queryMap(db, editorB, ASHEVILLE_BBOX))).toEqual(["A-ORGANIZATION_NETWORK", "A-PUBLIC"]);
  });

  it("a user with no approved organization sees only PUBLIC", async () => {
    expect(names(await queryMap(db, outsider, ASHEVILLE_BBOX))).toEqual(["A-PUBLIC"]);
    expect(names(await queryMap(db, pendingUser, ASHEVILLE_BBOX))).toEqual(["A-PUBLIC"]);
  });

  it("authorized responders see AUTHORIZED_RESPONDERS sites only inside their geographic scope", async () => {
    expect(names(await queryMap(db, responder, ASHEVILLE_BBOX))).toEqual(["A-AUTHORIZED_RESPONDERS", "A-PUBLIC"]);
    expect(names(await queryMap(db, responderFar, ASHEVILLE_BBOX))).toEqual(["A-PUBLIC"]);
  });

  it("the owning org (any role) and platform admins see everything", async () => {
    const all = ["A-AUTHORIZED_RESPONDERS", "A-ORGANIZATION_NETWORK", "A-PRIVATE_ORGANIZATION", "A-PUBLIC"];
    expect(names(await queryMap(db, viewerA, ASHEVILLE_BBOX))).toEqual(all);
    expect(names(await queryMap(db, admin, ASHEVILLE_BBOX))).toEqual(all);
  });

  it("raw SQL under the authenticated role is filtered by RLS (defense in depth)", async () => {
    const rows = await runIn(db, { kind: "viewer", userId: outsider }, (tx) => tx.query<{ name: string }>("SELECT name FROM staging_sites"));
    expect(rows.map((r) => r.name)).toEqual(["A-PUBLIC"]);
  });

  it("revoked responder access takes effect immediately", async () => {
    await runIn(db, { kind: "system" }, (tx) => tx.query("UPDATE role_assignments SET revoked_at = now() WHERE user_id = $1", [responder]));
    expect(names(await queryMap(db, responder, ASHEVILLE_BBOX))).toEqual(["A-PUBLIC"]);
    await runIn(db, { kind: "system" }, (tx) => tx.query("UPDATE role_assignments SET revoked_at = NULL WHERE user_id = $1", [responder]));
  });

  it("search suggestions respect visibility", async () => {
    const anon = await searchPlaces(db, null, "Asheville");
    expect(anon.map((h) => h.name)).toEqual(["A-PUBLIC"]);
  });
});

describe("ownership and write authorization (criteria 2, 3)", () => {
  it("a verified org editor publishes and updates immediately", async () => {
    const id = await createSite(db, editorA, orgA, site({ name: "A-Immediate" }));
    expect(names(await queryMap(db, null, ASHEVILLE_BBOX))).toContain("A-Immediate");
    await updateSite(db, editorA, id, site({ name: "A-Immediate-Renamed" }));
    expect(names(await queryMap(db, null, ASHEVILLE_BBOX))).toContain("A-Immediate-Renamed");
    await archiveSite(db, editorA, id);
    expect(names(await queryMap(db, null, ASHEVILLE_BBOX))).not.toContain("A-Immediate-Renamed");
  });

  it("another org cannot edit, archive or add resources to Org A's site", async () => {
    const id = siteIds.PUBLIC;
    await expect(updateSite(db, editorB, id, site({ name: "hijacked" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(archiveSite(db, editorB, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      createResource(db, editorB, id, { categoryCode: "WATER", name: "Hijack water", visibility: "PUBLIC", availabilityStatus: "AVAILABLE" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("another org cannot create sites for Org A", async () => {
    await expect(createSite(db, editorB, orgA, site())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("raw UPDATE by another org's user affects zero rows under RLS", async () => {
    const rows = await runIn(db, { kind: "viewer", userId: editorB }, (tx) =>
      tx.query("UPDATE staging_sites SET name = 'hijacked', updated_by = ics.viewer_id() WHERE id = $1 RETURNING id", [siteIds.PUBLIC]),
    );
    expect(rows).toHaveLength(0);
  });

  it("a user cannot move a site to another organization", async () => {
    await expect(
      runIn(db, { kind: "viewer", userId: editorA }, (tx) =>
        tx.query("UPDATE staging_sites SET org_id = $2, updated_by = ics.viewer_id() WHERE id = $1", [siteIds.PUBLIC, orgB]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("VIEWER role members can read but not edit their own org's sites", async () => {
    await expect(getSiteDetail(db, viewerA, siteIds.PRIVATE_ORGANIZATION)).resolves.toMatchObject({ canEdit: false });
    await expect(updateSite(db, viewerA, siteIds.PUBLIC, site())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("pending (unverified) organizations cannot publish", async () => {
    await expect(createSite(db, pendingUser, pendingOrg, site())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("suspending publication removes an org's sites from the public map immediately (SOP-012)", async () => {
    await runIn(db, { kind: "system" }, (tx) => tx.query("UPDATE organizations SET publication_suspended = true WHERE id = $1", [orgA]));
    expect(names(await queryMap(db, null, ASHEVILLE_BBOX))).toEqual([]);
    await expect(createSite(db, editorA, orgA, site())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await runIn(db, { kind: "system" }, (tx) => tx.query("UPDATE organizations SET publication_suspended = false WHERE id = $1", [orgA]));
  });

  it("revoked membership loses edit access immediately (SOP-013)", async () => {
    await runIn(db, { kind: "system" }, (tx) =>
      tx.query("UPDATE organization_memberships SET status = 'REVOKED' WHERE user_id = $1", [editorA]),
    );
    await expect(updateSite(db, editorA, siteIds.PUBLIC, site({ name: "A-PUBLIC" }))).rejects.toBeInstanceOf(AppError);
    expect(names(await queryMap(db, editorA, ASHEVILLE_BBOX))).toEqual(["A-PUBLIC"]);
    await runIn(db, { kind: "system" }, (tx) =>
      tx.query("UPDATE organization_memberships SET status = 'ACTIVE' WHERE user_id = $1", [editorA]),
    );
  });
});

describe("resource visibility", () => {
  it("restricted resources at a public site are not exposed to anonymous visitors", async () => {
    await createResource(db, editorA, siteIds.PUBLIC, { categoryCode: "WATER", name: "Public water", visibility: "PUBLIC", availabilityStatus: "AVAILABLE", reportedQuantity: "200", quantityUnit: "cases" });
    await createResource(db, editorA, siteIds.PUBLIC, { categoryCode: "EQUIPMENT", name: "Restricted generator cache", visibility: "AUTHORIZED_RESPONDERS", availabilityStatus: "AVAILABLE" });
    const anon = await queryMap(db, null, ASHEVILLE_BBOX);
    const pub = anon.sites.find((s) => s.name === "A-PUBLIC")!;
    expect(pub.resources.map((r) => r.name)).toEqual(["Public water"]);
    expect(JSON.stringify(anon)).not.toContain("generator");

    const resp = await queryMap(db, responder, ASHEVILLE_BBOX);
    expect(resp.sites.find((s) => s.name === "A-PUBLIC")!.resources.map((r) => r.name).sort()).toEqual(["Public water", "Restricted generator cache"]);
    const other = await queryMap(db, editorB, ASHEVILLE_BBOX);
    expect(other.sites.find((s) => s.name === "A-PUBLIC")!.resources.map((r) => r.name)).toEqual(["Public water"]);
  });

  it("a resource cannot be more visible than its site (app + database)", async () => {
    await expect(
      createResource(db, editorA, siteIds.PRIVATE_ORGANIZATION, { categoryCode: "FOOD", name: "Leak", visibility: "PUBLIC", availabilityStatus: "AVAILABLE" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      runIn(db, { kind: "viewer", userId: editorA }, (tx) =>
        tx.query(`INSERT INTO resources (site_id, org_id, category_code, name, visibility, created_by)
                  VALUES ($1, $2, 'FOOD', 'Leak', 'PUBLIC', ics.viewer_id())`, [siteIds.PRIVATE_ORGANIZATION, orgA]),
      ),
    ).rejects.toThrow(/more visible/);
  });

  it("tightening a site's visibility tightens its resources", async () => {
    const id = await createSite(db, editorA, orgA, site({ name: "A-Tighten" }));
    await createResource(db, editorA, id, { categoryCode: "FOOD", name: "Hot meals", visibility: "PUBLIC", availabilityStatus: "AVAILABLE" });
    await updateSite(db, editorA, id, site({ name: "A-Tighten", visibility: "PRIVATE_ORGANIZATION" }));
    const d = await getSiteDetail(db, editorA, id);
    expect(d.resources[0].visibility).toBe("PRIVATE_ORGANIZATION");
    expect(names(await queryMap(db, null, ASHEVILLE_BBOX))).not.toContain("A-Tighten");
  });

  it("status-only (one-tap) updates preserve the reported quantity", async () => {
    const id = await createSite(db, editorA, orgA, site({ name: "A-Quantity" }));
    const rid = await createResource(db, editorA, id, { categoryCode: "FOOD", name: "Boxes", visibility: "PUBLIC", availabilityStatus: "AVAILABLE", reportedQuantity: "120", quantityUnit: "boxes", quantityBasis: "VERIFIED_COUNT" });
    await updateAvailability(db, editorA, rid, { availabilityStatus: "LIMITED" });
    const r = (await getSiteDetail(db, editorA, id)).resources[0];
    expect(r).toMatchObject({ availabilityStatus: "LIMITED", reportedQuantity: "120", quantityUnit: "boxes", quantityBasis: "VERIFIED_COUNT" });
    await updateAvailability(db, editorA, rid, { availabilityStatus: "DEPLETED", reportedQuantity: "", quantityUnit: "" });
    expect((await getSiteDetail(db, editorA, id)).resources[0].reportedQuantity).toBeNull();
  });

  it("availability updates are append-only events with before/after provenance (criterion 9)", async () => {
    const id = await createSite(db, editorA, orgA, site({ name: "A-Events" }));
    const rid = await createResource(db, editorA, id, { categoryCode: "WATER", name: "Water", visibility: "PUBLIC", availabilityStatus: "AVAILABLE", reportedQuantity: "50", quantityUnit: "cases" });
    await updateAvailability(db, editorA, rid, { availabilityStatus: "LIMITED", reportedQuantity: "5", quantityUnit: "cases" });
    await expect(updateAvailability(db, editorA, rid, { availabilityStatus: "DEPLETED", isCorrection: "true" })).rejects.toMatchObject({ code: "VALIDATION" });
    await updateAvailability(db, editorA, rid, { availabilityStatus: "DEPLETED", isCorrection: "true", note: "Miscounted pallets", quantityBasis: "VERIFIED_COUNT", reportedQuantity: "0", quantityUnit: "cases" });
    const d = await getSiteDetail(db, editorA, id);
    expect(d.events.map((e) => e.eventType)).toEqual(["CORRECTION", "AVAILABILITY_UPDATED", "RESOURCE_CREATED", "SITE_CREATED"]);
    await expect(
      runIn(db, { kind: "system" }, (tx) => tx.query("DELETE FROM resource_update_events WHERE site_id = $1", [id])),
    ).rejects.toThrow(/append-only/);
    const audit = await runIn(db, { kind: "system" }, (tx) =>
      tx.query<{ action: string }>("SELECT action FROM audit_logs WHERE subject_id = $1", [id]),
    );
    expect(audit.map((a) => a.action)).toContain("SITE_CREATED");
  });
});
