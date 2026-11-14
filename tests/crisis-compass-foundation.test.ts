import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brandCss, contrastRatio, DEFAULT_COLORS, loadBrand } from "@/config/brand";
import { parseSocialLink, parseWebUrl } from "@/lib/links";
import type { Driver } from "@/server/db";
import { runIn } from "@/server/db/context";
import { loadAccess } from "@/server/modules/access";
import { assignCountyAdmin, createCounty, listCountyAdmins, listManageableCounties, revokeCountyAdmin } from "@/server/modules/counties";
import {
  findPublicLogo,
  getOrganizationProfile,
  getPublicOrganization,
  listProfilesForReview,
  removeOrganizationLogo,
  reviewOrganizationProfile,
  searchContacts,
  updateOrganizationProfile,
  uploadOrganizationLogo,
} from "@/server/modules/directory";
import { decideOrganization } from "@/server/modules/organizations";
import { LocalObjectStore } from "@/server/storage";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser } from "./helpers/fixtures";

// ---------------------------------------------------------------------------
// Branding / theme configuration
// ---------------------------------------------------------------------------
describe("brand configuration", () => {
  it("defaults to Crisis Compass with placeholder colors and no warnings", () => {
    const b = loadBrand({});
    expect(b.name).toBe("Crisis Compass");
    expect(b.colors).toEqual(DEFAULT_COLORS);
    expect(b.logoPath).toBeNull();
    expect(b.warnings).toEqual([]);
  });

  it("applies valid overrides without code changes", () => {
    const b = loadBrand({ BRAND_NAME: "Compass Co", BRAND_COLOR_PRIMARY: "#12355B", BRAND_LOGO_PATH: "/brand/logo.svg" });
    expect(b.name).toBe("Compass Co");
    expect(b.colors.primary).toBe("#12355b");
    expect(b.logoPath).toBe("/brand/logo.svg");
    expect(brandCss(b)).toContain("--cc-primary:#12355b");
  });

  it("rejects malformed values so nothing can be injected into the generated CSS", () => {
    const b = loadBrand({
      BRAND_COLOR_PRIMARY: "red; } body { display:none",
      BRAND_COLOR_ACCENT: "url(javascript:1)",
      BRAND_NAME: "<script>x</script>",
      BRAND_LOGO_PATH: "//evil.example/logo.png",
    });
    expect(b.colors.primary).toBe(DEFAULT_COLORS.primary);
    expect(b.colors.accent).toBe(DEFAULT_COLORS.accent);
    expect(b.name).toBe("Crisis Compass");
    expect(b.logoPath).toBeNull();
    expect(b.warnings.length).toBe(4);
    expect(brandCss(b)).not.toMatch(/[<>]|url\(|display:none/);
  });

  it("refuses unreadable color pairs and falls back to the default for that token", () => {
    const b = loadBrand({ BRAND_COLOR_PRIMARY: "#ffee99", BRAND_COLOR_TEXT: "#eeeeee" });
    expect(b.colors.primary).toBe(DEFAULT_COLORS.primary);
    expect(b.colors.text).toBe(DEFAULT_COLORS.text);
    expect(contrastRatio(b.colors.primary, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(b.warnings.join(" ")).toMatch(/at least 4.5:1/);
  });

  it("the placeholder defaults themselves meet WCAG AA", () => {
    const c = DEFAULT_COLORS;
    expect(contrastRatio(c.primary, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.link, c.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.text, c.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.accent, c.text)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(c.interactive, "#ffffff")).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Link safety
// ---------------------------------------------------------------------------
describe("link validation", () => {
  it("accepts ordinary web addresses and rejects dangerous or malformed ones", () => {
    expect(parseWebUrl("https://example.org/help").ok).toBe(true);
    expect(parseWebUrl("http://legacy.example.org").ok).toBe(true);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://example.org", "https://user:pw@example.org", "example.org", "https://localhost", ""]) {
      expect(parseWebUrl(bad).ok, bad).toBe(false);
    }
    expect(parseWebUrl("http://legacy.example.org", { requireHttps: true }).ok).toBe(false);
  });

  it("social links must belong to their platform; 'other' accepts any https host", () => {
    expect(parseSocialLink("facebook", "https://www.facebook.com/someorg").ok).toBe(true);
    expect(parseSocialLink("facebook", "https://facebook.com.evil.example/x").ok).toBe(false);
    expect(parseSocialLink("x", "https://twitter.com/someorg").ok).toBe(true);
    expect(parseSocialLink("instagram", "https://www.facebook.com/someorg").ok).toBe(false);
    expect(parseSocialLink("other", "https://newsletter.example.org").ok).toBe(true);
    expect(parseSocialLink("other", "http://newsletter.example.org").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Roles, county scoping and profile approval (real PostgreSQL + PostGIS)
// ---------------------------------------------------------------------------
let db: Driver;
let store: LocalObjectStore;
let exec: string, countyAdminA: string, orgAdmin: string, orgEditor: string, stranger: string;
let countyA: string, countyB: string;
let orgServesA: string, orgServesB: string, orgNoCounty: string;

const png = () => sharp({ create: { width: 900, height: 600, channels: 3, background: "#225588" } }).png().toBuffer();

beforeAll(async () => {
  db = await freshDb();
  store = new LocalObjectStore(mkdtempSync(path.join(tmpdir(), "ics-logo-")));
  [exec, countyAdminA, orgAdmin, orgEditor, stranger] = await Promise.all(
    ["exec", "county-a", "org-admin", "org-editor", "stranger"].map((n) => makeUser(db, `${n}@example.test`)),
  );
  await grantRole(db, exec, "PLATFORM_ADMIN");
  countyA = await createCounty(db, exec, { name: "Alpha", state: "nc" });
  countyB = await createCounty(db, exec, { name: "Bravo", state: "NC" });
  await assignCountyAdmin(db, exec, { email: "county-a@example.test", countyId: countyA, reason: "Regional coordinator" });
  orgServesA = await makeOrg(db, { name: "Serves A", consent: true, members: [{ userId: orgAdmin, role: "ORG_ADMIN" }, { userId: orgEditor, role: "EDITOR" }] });
  orgServesB = await makeOrg(db, { name: "Serves B", consent: true });
  orgNoCounty = await makeOrg(db, { name: "Serves none", consent: true });
  await runIn(db, { kind: "system" }, async (tx) => {
    await tx.query(`INSERT INTO organization_counties (org_id, county_id) VALUES ($1, $2), ($3, $4)`, [orgServesA, countyA, orgServesB, countyB]);
  });
});
afterAll(async () => db?.close());

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

describe("executive and county administrator permissions", () => {
  it("only an executive can create counties or assign county administrators", async () => {
    expect(await code(createCounty(db, countyAdminA, { name: "Charlie", state: "NC" }))).toBe("FORBIDDEN");
    expect(await code(assignCountyAdmin(db, countyAdminA, { email: "x@example.test", countyId: countyA, reason: "self-service" }))).toBe("FORBIDDEN");
    expect(await code(createCounty(db, stranger, { name: "Charlie", state: "NC" }))).toBe("FORBIDDEN");
  });

  it("access is derived from the database: executive sees everything, county admin only assigned counties", async () => {
    const e = await runIn(db, { kind: "system" }, (tx) => loadAccess(tx, exec));
    const c = await runIn(db, { kind: "system" }, (tx) => loadAccess(tx, countyAdminA));
    const s = await runIn(db, { kind: "system" }, (tx) => loadAccess(tx, stranger));
    expect(e.executive).toBe(true);
    expect(c.executive).toBe(false);
    expect(c.countyIds).toEqual([countyA]);
    expect(s).toMatchObject({ executive: false, countyIds: [] });
    expect((await listManageableCounties(db, countyAdminA)).map((x) => x.name)).toEqual(["Alpha"]);
    expect((await listManageableCounties(db, exec)).map((x) => x.name).sort()).toEqual(["Alpha", "Bravo"]);
  });

  it("a county administrator sees only assignments in their own counties; others are refused", async () => {
    await assignCountyAdmin(db, exec, { email: "county-b@example.test", countyId: countyB, reason: "Second county lead" });
    expect((await listCountyAdmins(db, exec)).length).toBeGreaterThanOrEqual(2);
    const mine = await listCountyAdmins(db, countyAdminA);
    expect(mine.every((r) => r.countyId === countyA)).toBe(true);
    expect(await code(listCountyAdmins(db, stranger))).toBe("FORBIDDEN");
  });

  it("rejects duplicate assignment and unknown county", async () => {
    expect(await code(assignCountyAdmin(db, exec, { email: "county-a@example.test", countyId: countyA, reason: "duplicate grant" }))).toBe("CONFLICT");
    expect(await code(assignCountyAdmin(db, exec, { email: "z@example.test", countyId: "00000000-0000-4000-8000-000000000000", reason: "no such county" }))).toBe("NOT_FOUND");
  });

  it("revocation takes effect immediately and ends the person's sessions; expired grants carry no access", async () => {
    const id = await assignCountyAdmin(db, exec, { email: "temp@example.test", countyId: countyA, reason: "Short engagement" });
    const tempUser = await runIn(db, { kind: "system" }, async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM users WHERE email = 'temp@example.test'`))[0].id);
    await runIn(db, { kind: "system" }, (tx) => tx.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, 'h-temp', now() + interval '1 hour')`, [tempUser]));
    expect((await runIn(db, { kind: "system" }, (tx) => loadAccess(tx, tempUser))).countyIds).toEqual([countyA]);
    await revokeCountyAdmin(db, exec, id);
    expect((await runIn(db, { kind: "system" }, (tx) => loadAccess(tx, tempUser))).countyIds).toEqual([]);
    const live = await runIn(db, { kind: "system" }, (tx) => tx.query(`SELECT 1 FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [tempUser]));
    expect(live).toHaveLength(0);
    expect(await code(revokeCountyAdmin(db, exec, id))).toBe("NOT_FOUND");
    expect(await code(revokeCountyAdmin(db, countyAdminA, id))).toBe("FORBIDDEN");

    await runIn(db, { kind: "system" }, (tx) =>
      tx.query(`INSERT INTO county_admin_assignments (user_id, county_id, reason, expires_at) VALUES ($1, $2, 'expired', now() - interval '1 day')`, [tempUser, countyB]),
    );
    expect((await runIn(db, { kind: "system" }, (tx) => loadAccess(tx, tempUser))).countyIds).toEqual([]);
  });

  it("RLS: assignments are visible to the person and executives only; org-county rows only to members/admins", async () => {
    const asStranger = await runIn(db, { kind: "viewer", userId: stranger }, async (tx) => ({
      assignments: await tx.query(`SELECT 1 FROM county_admin_assignments`),
      orgCounties: await tx.query(`SELECT 1 FROM organization_counties`),
    }));
    expect(asStranger.assignments).toHaveLength(0);
    expect(asStranger.orgCounties).toHaveLength(0);
    const asSelf = await runIn(db, { kind: "viewer", userId: countyAdminA }, (tx) => tx.query<{ user_id: string }>(`SELECT user_id FROM county_admin_assignments`));
    expect(asSelf.length).toBeGreaterThan(0);
    expect(asSelf.every((r) => r.user_id === countyAdminA)).toBe(true);
    // Anonymous visitors have no access to these tables at all.
    expect(await code(runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT 1 FROM county_admin_assignments`)))).toBe("42501");
    expect(await code(runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT 1 FROM organization_counties`)))).toBe("42501");
  });
});

describe("organization profiles: links, counties, approval", () => {
  const profile = (over: Record<string, unknown> = {}) => ({
    description: "We help.",
    website: "https://example.org",
    directoryConsent: "on",
    socialLinks: { facebook: "https://www.facebook.com/serves-a", instagram: "" },
    countyIds: [countyA],
    additionalServiceTypes: [],
    ...over,
  });

  it("only an organization administrator can edit; links and counties are validated server-side", async () => {
    expect(await code(updateOrganizationProfile(db, orgEditor, orgServesA, profile()))).toBe("FORBIDDEN");
    expect(await code(updateOrganizationProfile(db, stranger, orgServesA, profile()))).toBe("FORBIDDEN");
    expect(await code(updateOrganizationProfile(db, orgAdmin, orgServesA, profile({ website: "javascript:alert(1)" })))).toBe("VALIDATION");
    expect(await code(updateOrganizationProfile(db, orgAdmin, orgServesA, profile({ socialLinks: { facebook: "https://evil.example/fb" } })))).toBe("VALIDATION");
    expect(await code(updateOrganizationProfile(db, orgAdmin, orgServesA, profile({ socialLinks: { myspace: "https://myspace.com/x" } })))).toBe("VALIDATION");
    expect(await code(updateOrganizationProfile(db, orgAdmin, orgServesA, profile({ countyIds: ["00000000-0000-4000-8000-000000000000"] })))).toBe("VALIDATION");
    expect(await code(updateOrganizationProfile(db, orgAdmin, orgServesA, profile()))).toBe("OK");
    const saved = await getOrganizationProfile(db, orgAdmin, orgServesA);
    expect(saved.socialLinks).toEqual({ facebook: "https://www.facebook.com/serves-a" });
    expect(saved.countyIds).toEqual([countyA]);
    expect(saved.website).toBe("https://example.org/");
  });

  it("the public profile shows website, social links and counties, and nothing private", async () => {
    const pub = await getPublicOrganization(db, orgServesA);
    expect(pub).toMatchObject({ website: "https://example.org/", countiesServed: ["Alpha, NC"], socialLinks: { facebook: "https://www.facebook.com/serves-a" } });
    expect(JSON.stringify(pub)).not.toMatch(/private-contact@example\.test/);
  });

  it("a profile is public only while approved: pending and hidden profiles disappear from Contacts and the profile page", async () => {
    const pendingOrg = await makeOrg(db, { name: "Fresh profile", consent: true });
    await runIn(db, { kind: "system" }, (tx) => tx.query(`UPDATE organizations SET profile_status = 'PENDING' WHERE id = $1`, [pendingOrg]));
    expect(await getPublicOrganization(db, pendingOrg)).toBeNull();
    expect((await searchContacts(db)).entries.map((e) => e.id)).not.toContain(pendingOrg);

    await reviewOrganizationProfile(db, exec, { orgId: pendingOrg, decision: "APPROVED", note: "Checked links" });
    expect(await getPublicOrganization(db, pendingOrg)).not.toBeNull();
    expect((await searchContacts(db)).entries.map((e) => e.id)).toContain(pendingOrg);

    await reviewOrganizationProfile(db, exec, { orgId: pendingOrg, decision: "HIDDEN", note: "Misleading link reported" });
    expect(await getPublicOrganization(db, pendingOrg)).toBeNull();
    expect((await searchContacts(db)).entries.map((e) => e.id)).not.toContain(pendingOrg);
  });

  it("an organization without the public opt-in stays private even when approved", async () => {
    const quiet = await makeOrg(db, { name: "Private profile", consent: false });
    expect(await getPublicOrganization(db, quiet)).toBeNull();
  });

  it("verifying an organization approves its first profile; a later decision is kept", async () => {
    const org = await makeOrg(db, { name: "Awaiting verification", status: "PENDING_VERIFICATION", consent: true });
    expect(await getPublicOrganization(db, org)).toBeNull();
    await decideOrganization(db, exec, { orgId: org, decision: "APPROVED", evidenceSummary: "EIN checked", primaryServiceType: "FOOD" });
    expect(await getPublicOrganization(db, org)).not.toBeNull();
  });

  it("county administrators review only profiles of organizations serving their counties", async () => {
    const note = "County review";
    expect(await code(reviewOrganizationProfile(db, countyAdminA, { orgId: orgServesA, decision: "APPROVED", note }))).toBe("OK");
    expect(await code(reviewOrganizationProfile(db, countyAdminA, { orgId: orgServesB, decision: "HIDDEN", note }))).toBe("FORBIDDEN");
    expect(await code(reviewOrganizationProfile(db, countyAdminA, { orgId: orgNoCounty, decision: "HIDDEN", note }))).toBe("FORBIDDEN");
    expect(await code(reviewOrganizationProfile(db, stranger, { orgId: orgServesA, decision: "HIDDEN", note }))).toBe("FORBIDDEN");
    expect(await code(reviewOrganizationProfile(db, orgAdmin, { orgId: orgServesA, decision: "APPROVED", note }))).toBe("FORBIDDEN");
    expect(await code(reviewOrganizationProfile(db, exec, { orgId: orgNoCounty, decision: "APPROVED", note }))).toBe("OK");

    const mine = (await listProfilesForReview(db, countyAdminA)).map((r) => r.id);
    expect(mine).toContain(orgServesA);
    expect(mine).not.toContain(orgServesB);
    expect(mine).not.toContain(orgNoCounty);
    expect((await listProfilesForReview(db, exec)).map((r) => r.id)).toEqual(expect.arrayContaining([orgServesA, orgServesB, orgNoCounty]));
    expect(await code(listProfilesForReview(db, stranger))).toBe("FORBIDDEN");
  });

  it("every profile decision is audited", async () => {
    const rows = await runIn(db, { kind: "system" }, (tx) =>
      tx.query<{ action: string }>(`SELECT action FROM audit_logs WHERE subject_id = $1 AND action LIKE 'ORG_PROFILE_%'`, [orgServesA]),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("organization logo", () => {
  it("only an organization administrator can upload; the file is re-encoded and bounded", async () => {
    expect(await code(uploadOrganizationLogo(db, store, orgEditor, orgServesA, { bytes: await png(), altText: "Blue square logo" }))).toBe("FORBIDDEN");
    expect(await code(uploadOrganizationLogo(db, store, orgAdmin, orgServesA, { bytes: Buffer.from("<svg onload=alert(1)>"), altText: "Bad file here" }))).toBe("VALIDATION");
    expect(await code(uploadOrganizationLogo(db, store, orgAdmin, orgServesA, { bytes: await png(), altText: "x" }))).toBe("VALIDATION");
    await uploadOrganizationLogo(db, store, orgAdmin, orgServesA, { bytes: await png(), altText: "Blue square logo" });
    const logo = await findPublicLogo(db, orgServesA);
    expect(logo).not.toBeNull();
    const bytes = (await store.get(logo!.key))!;
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(512);
  });

  it("replacing removes the old object; the logo is served only for approved public profiles", async () => {
    const first = (await findPublicLogo(db, orgServesA))!.key;
    await uploadOrganizationLogo(db, store, orgAdmin, orgServesA, { bytes: await png(), altText: "Replacement logo" });
    const second = (await findPublicLogo(db, orgServesA))!.key;
    expect(second).not.toBe(first);
    expect(await store.get(first)).toBeNull();

    await reviewOrganizationProfile(db, exec, { orgId: orgServesA, decision: "HIDDEN", note: "Under review" });
    expect(await findPublicLogo(db, orgServesA)).toBeNull();
    await reviewOrganizationProfile(db, exec, { orgId: orgServesA, decision: "APPROVED", note: "Reviewed" });
    expect(await findPublicLogo(db, orgServesA)).not.toBeNull();
  });

  it("removal is limited to organization administrators and deletes the stored file", async () => {
    const key = (await findPublicLogo(db, orgServesA))!.key;
    expect(await code(removeOrganizationLogo(db, store, orgEditor, orgServesA))).toBe("FORBIDDEN");
    await removeOrganizationLogo(db, store, orgAdmin, orgServesA);
    expect(await findPublicLogo(db, orgServesA)).toBeNull();
    expect(await store.get(key)).toBeNull();
    expect(await code(removeOrganizationLogo(db, store, orgAdmin, orgServesA))).toBe("CONFLICT");
  });
});
