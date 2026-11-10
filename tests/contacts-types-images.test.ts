import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "@/server/db";
import { runIn } from "@/server/db/context";
import { getOrganizationProfile, searchContacts, setPrimaryServiceType, updateOrganizationProfile } from "@/server/modules/directory";
import { findSiteImage, processImage, removeSiteImage, sniffImageType, uploadSiteImage } from "@/server/modules/images";
import { queryMap, searchPlaces } from "@/server/modules/map";
import { createSite } from "@/server/modules/sites";
import { LocalObjectStore } from "@/server/storage";
import { freshDb } from "./helpers/db";
import { ASHEVILLE_BBOX, grantRole, makeOrg, makeUser, site } from "./helpers/fixtures";

let db: Driver;
let store: LocalObjectStore;
let adminA: string, editorA: string, editorB: string, admin: string, outsider: string;
let orgA: string, orgB: string, quietOrg: string, pendingOrg: string;

const jpeg = (w = 64, h = 48) =>
  sharp({ create: { width: w, height: h, channels: 3, background: "#3366aa" } }).jpeg().toBuffer();

beforeAll(async () => {
  db = await freshDb();
  store = new LocalObjectStore(mkdtempSync(path.join(tmpdir(), "ics-img-")));
  [adminA, editorA, editorB, admin, outsider] = await Promise.all(
    ["a-admin", "a-editor", "b-editor", "platform", "outsider"].map((n) => makeUser(db, `${n}@example.test`)),
  );
  orgA = await makeOrg(db, { name: "Water Org", serviceType: "WATER", consent: true, members: [{ userId: adminA, role: "ORG_ADMIN" }, { userId: editorA, role: "EDITOR" }] });
  orgB = await makeOrg(db, { name: "Clinic Org", serviceType: "HEALTHCARE", consent: true, members: [{ userId: editorB, role: "EDITOR" }] });
  quietOrg = await makeOrg(db, { name: "No Consent Org", serviceType: "FOOD", consent: false });
  pendingOrg = await makeOrg(db, { name: "Pending Org", status: "PENDING_VERIFICATION", consent: true });
  await grantRole(db, admin, "PLATFORM_ADMIN");
});
afterAll(async () => db?.close());

describe("public Contacts", () => {
  it("anyone can read it without signing in; only consenting, approved organizations appear", async () => {
    const names = (await searchContacts(db)).entries.map((e) => e.displayName);
    expect(names).toEqual(["[TEST] Clinic Org", "[TEST] Water Org"]);
    expect(names).not.toContain("[TEST] No Consent Org");
    expect(names).not.toContain("[TEST] Pending Org");
    void quietOrg;
    void pendingOrg;
  });

  it("exposes only public channels — never the private contact email", async () => {
    const json = JSON.stringify((await searchContacts(db)).entries);
    expect(json).toContain("public@example.test");
    expect(json).toContain("(555) 010-0000");
    expect(json).not.toContain("private-contact@example.test");
    expect(json).not.toMatch(/registration/i);
  });

  it("filters by service type (primary or additional) and text", async () => {
    expect((await searchContacts(db, { service: "HEALTHCARE" })).entries.map((e) => e.displayName)).toEqual(["[TEST] Clinic Org"]);
    expect((await searchContacts(db, { q: "water" })).entries.map((e) => e.displayName)).toEqual(["[TEST] Water Org"]);
    expect((await searchContacts(db, { q: "%" })).entries).toEqual([]); // LIKE wildcards are escaped
  });

  it("org admins control consent; withdrawing removes the listing immediately", async () => {
    await updateOrganizationProfile(db, adminA, orgA, { publicPhone: "(555) 010-0111", publicEmail: "water@example.test", additionalServiceTypes: ["SUPPLIES"], directoryConsent: "" });
    expect((await searchContacts(db)).entries.map((e) => e.displayName)).toEqual(["[TEST] Clinic Org"]);
    await updateOrganizationProfile(db, adminA, orgA, { publicPhone: "(555) 010-0111", publicEmail: "water@example.test", additionalServiceTypes: ["SUPPLIES"], directoryConsent: "on" });
    const entry = (await searchContacts(db, { service: "SUPPLIES" })).entries[0];
    expect(entry).toMatchObject({ displayName: "[TEST] Water Org", publicEmail: "water@example.test", serviceType: "WATER", additionalServiceTypes: ["SUPPLIES"] });
    const audit = await runIn(db, { kind: "system" }, (tx) =>
      tx.query<{ action: string }>(`SELECT action FROM audit_logs WHERE subject_id = $1 ORDER BY occurred_at`, [orgA]),
    );
    expect(audit.map((a) => a.action)).toEqual(["DIRECTORY_CONSENT_WITHDRAWN", "DIRECTORY_CONSENT_GRANTED"]);
  });

  it("only ORG_ADMIN members can edit the profile; the primary type is not editable by the org", async () => {
    await expect(updateOrganizationProfile(db, editorA, orgA, { directoryConsent: "on" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateOrganizationProfile(db, outsider, orgA, { directoryConsent: "on" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await updateOrganizationProfile(db, adminA, orgA, { directoryConsent: "on", additionalServiceTypes: [], primaryServiceType: "SHELTER" });
    expect((await getOrganizationProfile(db, adminA, orgA)).primaryServiceType).toBe("WATER");
    await expect(updateOrganizationProfile(db, adminA, orgA, { directoryConsent: "on", additionalServiceTypes: ["NOT_A_TYPE"] })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("service types", () => {
  it("the database refuses an approved account without a service type", async () => {
    await expect(
      runIn(db, { kind: "system" }, (tx) => tx.query(`UPDATE organizations SET primary_service_type = NULL WHERE id = $1`, [orgA])),
    ).rejects.toThrow(/organizations_approved_has_type/);
  });

  it("map pins carry the account's service type and color for the legend, and can be filtered by it", async () => {
    await createSite(db, editorA, orgA, site({ name: "Water point" }));
    await createSite(db, editorB, orgB, site({ name: "Clinic", lat: 35.6, lng: -82.56 }));
    const all = await queryMap(db, null, ASHEVILLE_BBOX);
    expect(all.sites.map((s) => [s.name, s.serviceType, s.serviceShort, s.serviceColor]).sort()).toEqual([
      ["Clinic", "HEALTHCARE", "MED", "#c62828"],
      ["Water point", "WATER", "H2O", "#1565c0"],
    ]);
    expect((await queryMap(db, null, { ...ASHEVILLE_BBOX, services: "HEALTHCARE" })).sites.map((s) => s.name)).toEqual(["Clinic"]);
    expect((await queryMap(db, editorA, { ...ASHEVILLE_BBOX, services: "WATER" })).sites.map((s) => s.name)).toEqual(["Water point"]);
  });

  it("only platform admins can change an account's confirmed type, and it is audited", async () => {
    await expect(setPrimaryServiceType(db, adminA, { orgId: orgA, primaryServiceType: "SHELTER", evidenceSummary: "self change" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await setPrimaryServiceType(db, admin, { orgId: orgB, primaryServiceType: "DISASTER_CASE_MANAGEMENT", evidenceSummary: "Org now provides case management." });
    const clinic = (await queryMap(db, null, ASHEVILLE_BBOX)).sites.find((s) => s.name === "Clinic")!;
    expect(clinic.serviceType).toBe("DISASTER_CASE_MANAGEMENT");
    await expect(setPrimaryServiceType(db, admin, { orgId: orgB, primaryServiceType: "NOPE", evidenceSummary: "bad code" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("site images", () => {
  it("accepts only real JPEG/PNG/WebP bytes", async () => {
    expect(sniffImageType(await jpeg())).toBe("jpeg");
    await expect(processImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(processImage(Buffer.from("GIF89a....."))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(processImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("not really a jpeg")]))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(processImage(Buffer.alloc(6 * 1024 * 1024, 1))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("strips EXIF/GPS metadata, applies orientation and re-encodes to WebP", async () => {
    const withGps = await sharp({ create: { width: 80, height: 40, channels: 3, background: "#aa3300" } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExifMerge({ IFD0: { Make: "TestCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 35/1 0/1" } })
      .toBuffer();
    const inMeta = await sharp(withGps).metadata();
    expect(inMeta.exif).toBeDefined();
    expect(inMeta.orientation).toBe(6);
    const out = await processImage(withGps);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect([out.width, out.height]).toEqual([40, 80]); // rotated per Orientation=6
  });

  it("public site photos are visible to anyone; restricted site photos only to authorized viewers", async () => {
    const pub = await createSite(db, editorA, orgA, site({ name: "Public w/ photo" }));
    const priv = await createSite(db, editorA, orgA, site({ name: "Private w/ photo", visibility: "PRIVATE_ORGANIZATION" }));
    await expect(uploadSiteImage(db, store, editorA, pub, { bytes: await jpeg(), altText: "" })).rejects.toMatchObject({ code: "VALIDATION" });
    const pubImg = await uploadSiteImage(db, store, editorA, pub, { bytes: await jpeg(), altText: "Front of the water point" });
    await uploadSiteImage(db, store, editorA, priv, { bytes: await jpeg(), altText: "Loading dock" });

    expect((await findSiteImage(db, null, pub))?.id).toBe(pubImg);
    expect(await findSiteImage(db, null, priv)).toBeNull();
    expect(await findSiteImage(db, editorB, priv)).toBeNull();
    expect(await findSiteImage(db, outsider, priv)).toBeNull();
    expect(await findSiteImage(db, editorA, priv)).not.toBeNull();
    expect(await findSiteImage(db, admin, priv)).not.toBeNull();

    const found = await findSiteImage(db, null, pub);
    expect((await store.get(found!.storageKey))?.subarray(8, 12).toString("ascii")).toBe("WEBP");

    const mapSite = (await queryMap(db, null, ASHEVILLE_BBOX)).sites.find((s) => s.name === "Public w/ photo")!;
    expect(mapSite).toMatchObject({ imageId: pubImg, imageAlt: "Front of the water point" });
    expect(JSON.stringify(await queryMap(db, null, ASHEVILLE_BBOX))).not.toContain("site-images/"); // storage keys never leave the server
  });

  it("other organizations cannot upload or remove photos; replacing keeps one active photo", async () => {
    const id = await createSite(db, editorA, orgA, site({ name: "Replace test" }));
    await expect(uploadSiteImage(db, store, editorB, id, { bytes: await jpeg(), altText: "Hijack photo" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const first = await uploadSiteImage(db, store, editorA, id, { bytes: await jpeg(), altText: "First photo" });
    const second = await uploadSiteImage(db, store, editorA, id, { bytes: await jpeg(32, 32), altText: "Second photo" });
    expect(second).not.toBe(first);
    expect((await findSiteImage(db, null, id))?.id).toBe(second);
    await expect(removeSiteImage(db, editorB, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await removeSiteImage(db, editorA, id);
    expect(await findSiteImage(db, null, id)).toBeNull();
    const rows = await runIn(db, { kind: "system" }, (tx) =>
      tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM site_images WHERE site_id = $1`, [id]),
    );
    expect(rows[0].n).toBe(2); // history kept, nothing hard-deleted
  });

  it("suspending an organization hides its photos from the public too", async () => {
    await runIn(db, { kind: "system" }, (tx) => tx.query(`UPDATE organizations SET publication_suspended = true WHERE id = $1`, [orgA]));
    const pub = (await runIn(db, { kind: "system" }, (tx) =>
      tx.query<{ id: string }>(`SELECT id FROM staging_sites WHERE name = 'Public w/ photo'`),
    ))[0].id;
    expect(await findSiteImage(db, null, pub)).toBeNull();
    await runIn(db, { kind: "system" }, (tx) => tx.query(`UPDATE organizations SET publication_suspended = false WHERE id = $1`, [orgA]));
  });
});

describe("Contacts search by text, type, ZIP and radius", () => {
  beforeAll(async () => {
    // Fixture ZIP centroids (approximate, test-only).
    await runIn(db, { kind: "system" }, (tx) =>
      tx.query(`INSERT INTO zip_codes (zip, location, source) VALUES
        ('28801', ST_SetSRID(ST_MakePoint(-82.5515, 35.5951), 4326)::geography, 'test'),
        ('28739', ST_SetSRID(ST_MakePoint(-82.4600, 35.3200), 4326)::geography, 'test')`),
    );
    // Organization with no public site, only a public office ZIP (~19.6 miles from 28801).
    const officeOnly = await makeOrg(db, { name: "Office Only Org", serviceType: "LEGAL_TITLE", consent: true });
    await runIn(db, { kind: "system" }, (tx) => tx.query(`UPDATE organizations SET public_postal_code = '28739' WHERE id = $1`, [officeOnly]));
  });

  const names = (r: { entries: { displayName: string }[] }) => r.entries.map((e) => e.displayName);

  it("text search matches name, description and service type labels; multiple words must all match", async () => {
    expect(names(await searchContacts(db, { q: "office only" }))).toEqual(["[TEST] Office Only Org"]);
    expect(names(await searchContacts(db, { q: "case management" }))).toEqual(["[TEST] Clinic Org"]); // service label
    expect(names(await searchContacts(db, { q: "title" }))).toEqual(["[TEST] Office Only Org"]);
    expect(names(await searchContacts(db, { q: "clinic water" }))).toEqual([]);
  });

  it("ZIP + radius returns organizations within the distance, nearest first, with distances", async () => {
    const near = await searchContacts(db, { zip: "28801", radius: "5" });
    expect(near.zipResolution).toBe("zip_table");
    expect(names(near)).toEqual(["[TEST] Water Org", "[TEST] Clinic Org"]);
    expect(near.entries[0].distanceMiles).toBe(0);
    expect(near.entries[1].distanceMiles).toBeGreaterThan(0);
    expect(near.entries[1].distanceMiles).toBeLessThan(5);
  });

  it("the radius filter widens and narrows results (office-ZIP-only orgs included)", async () => {
    expect(names(await searchContacts(db, { zip: "28801", radius: "10" }))).not.toContain("[TEST] Office Only Org");
    const wide = await searchContacts(db, { zip: "28801", radius: "25" });
    expect(names(wide)).toContain("[TEST] Office Only Org");
    const d = wide.entries.find((e) => e.displayName === "[TEST] Office Only Org")!.distanceMiles!;
    expect(d).toBeGreaterThan(18);
    expect(d).toBeLessThan(21);
    expect(names(wide).at(-1)).toBe("[TEST] Office Only Org"); // farthest last
  });

  it("combines ZIP with type and text filters", async () => {
    expect(names(await searchContacts(db, { zip: "28801", radius: "25", service: "LEGAL_TITLE" }))).toEqual(["[TEST] Office Only Org"]);
    expect(names(await searchContacts(db, { zip: "28801", radius: "25", q: "water" }))).toEqual(["[TEST] Water Org"]);
  });

  it("falls back to listed-site centroids for ZIPs missing from reference data, then to exact ZIP matching", async () => {
    await createSite(db, editorB, orgB, site({ name: "Swannanoa clinic", lat: 35.5979, lng: -82.3996, postalCode: "28778" }));
    const est = await searchContacts(db, { zip: "28778", radius: "5" });
    expect(est.zipResolution).toBe("site_centroid");
    expect(names(est)).toEqual(["[TEST] Clinic Org"]);
    const unknown = await searchContacts(db, { zip: "99999", radius: "100" });
    expect(unknown.zipResolution).toBe("unknown");
    expect(unknown.entries).toEqual([]);
  });

  it("rejects malformed ZIP codes and radii outside the listed options", async () => {
    await expect(searchContacts(db, { zip: "abcde" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(searchContacts(db, { zip: "28801", radius: "7" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("never matches restricted locations: a private site does not place an organization near a ZIP", async () => {
    const hidden = await makeOrg(db, { name: "Hidden Site Org", serviceType: "SUPPLIES", consent: true, members: [{ userId: outsider, role: "EDITOR" }] });
    await createSite(db, outsider, hidden, site({ name: "Secret depot", visibility: "PRIVATE_ORGANIZATION" }));
    const r = await searchContacts(db, { zip: "28801", radius: "100" });
    expect(names(r)).not.toContain("[TEST] Hidden Site Org");
    expect(names(await searchContacts(db, { q: "hidden" }))).toEqual(["[TEST] Hidden Site Org"]); // still listed, just not by location
  });

  it("map search treats a ZIP code as a place without revealing private locations", async () => {
    const official = await searchPlaces(db, null, "28801");
    expect(official[0]).toMatchObject({ kind: "zip", name: "ZIP 28801", approximate: false });
    expect(official[0].lat).toBeCloseTo(35.5951, 3);
    const estimated = await searchPlaces(db, null, "28778");
    expect(estimated[0]).toMatchObject({ kind: "zip", approximate: true });
    expect((await searchPlaces(db, null, "99999")).filter((h) => h.kind === "zip")).toEqual([]);
    // A ZIP used only by a private site must not resolve (that would reveal where the site is).
    const hidden = await makeOrg(db, { name: "Private Zip Org", serviceType: "SUPPLIES", members: [{ userId: outsider, role: "EDITOR" }] });
    await createSite(db, outsider, hidden, site({ name: "Private depot", visibility: "PRIVATE_ORGANIZATION", postalCode: "28555", lat: 34.9, lng: -77.2 }));
    expect(await searchPlaces(db, null, "28555")).toEqual([]);
  });
});
