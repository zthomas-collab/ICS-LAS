import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import {
  addApplicationNote,
  assistanceReadiness,
  createRoutingRule,
  documentsAvailable,
  findRoute,
  getApplicationForStaff,
  getMyApplication,
  listApplicationsForStaff,
  listMyApplications,
  provideRequestedInfo,
  readApplicationDocument,
  removeApplicationDocument,
  setRoutingRuleActive,
  submitApplication,
  transitionApplication,
  uploadApplicationDocument,
  withdrawApplication,
} from "@/server/modules/assistance";
import { confirmEmail, registerPublicAccount, requestSignIn } from "@/server/modules/identity";
import type { Scanner } from "@/server/scanner";
import { LocalObjectStore } from "@/server/storage";
import { freshDb } from "./helpers/db";
import { grantRole, makeOrg, makeUser } from "./helpers/fixtures";

let db: Driver;
let store: LocalObjectStore;
let exec: string, applicantA: string, applicantB: string, adminA: string, adminB: string, provider: string, outsiderMember: string, stranger: string;
let countyA: string, countyB: string, orgP: string, orgQ: string;

const MARKER = "ZEBRA-PRIVATE-SITUATION-TEXT";
const cleanScanner: Scanner = { name: "fake", effective: true, scan: async (b) => (b.includes(Buffer.from("EICAR")) ? { status: "INFECTED", detail: "Eicar-Test" } : { status: "CLEAN" }) };
const brokenScanner: Scanner = { name: "broken", effective: true, scan: async () => ({ status: "FAILED", detail: "down" }) };

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
const form = (over: Record<string, unknown> = {}) => ({
  countyId: countyA, zip: "28801", categoryCode: "HOUSING", summary: "Roof damage after the storm",
  situation: `${MARKER} The roof collapsed and we are staying with relatives.`, householdSize: "4",
  contactPhone: "(828) 555-0199", preferredContact: "EMAIL", consentShareProviders: "on", ...over,
});
const png = () => sharp({ create: { width: 300, height: 200, channels: 3, background: "#336699" } }).png().toBuffer();
let applicantSeq = 0;
const newApplicant = () => makeUser(db, `resident-${applicantSeq++}@example.test`);
const sys = <T>(fn: (tx: import("@/server/db").Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);

beforeAll(async () => {
  db = await freshDb();
  store = new LocalObjectStore(mkdtempSync(path.join(tmpdir(), "ics-docs-")));
  [exec, applicantA, applicantB, adminA, adminB, provider, outsiderMember, stranger] = await Promise.all(
    ["exec", "app-a", "app-b", "admin-a", "admin-b", "provider", "outsider", "stranger"].map((n) => makeUser(db, `${n}@example.test`)),
  );
  await grantRole(db, exec, "PLATFORM_ADMIN");
  countyA = await createCounty(db, exec, { name: "Alpha", state: "NC" });
  countyB = await createCounty(db, exec, { name: "Bravo", state: "NC" });
  await assignCountyAdmin(db, exec, { email: "admin-a@example.test", countyId: countyA, reason: "County A coordinator" });
  await assignCountyAdmin(db, exec, { email: "admin-b@example.test", countyId: countyB, reason: "County B coordinator" });
  orgP = await makeOrg(db, { name: "Provider P", members: [{ userId: provider, role: "EDITOR" }] });
  orgQ = await makeOrg(db, { name: "Outsider Q", members: [{ userId: outsiderMember, role: "EDITOR" }] });
  await createRoutingRule(db, adminA, { countyId: countyA, categoryCode: "HOUSING", handlerOrgId: orgP });
});
afterAll(async () => db?.close());
afterEach(() => {
  delete process.env.REQUIRE_MFA_FOR_PRIVILEGED;
  delete process.env.ASSISTANCE_ENABLED;
});

/** Takes an application through submit -> approved (and optionally referred), as county A's administrator. */
async function approved(owner?: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = await submitApplication(db, owner ?? (await newApplicant()), form(over));
  await transitionApplication(db, adminA, { applicationId: id, to: "UNDER_REVIEW" });
  await transitionApplication(db, adminA, { applicationId: id, to: "APPROVED" });
  return id;
}

describe("public account sign-up", () => {
  const latest = async (email: string) =>
    (await sys((tx) => tx.query<{ subject: string; body_text: string }>(`SELECT subject, body_text FROM notification_jobs WHERE recipient_email = $1 ORDER BY created_at DESC LIMIT 1`, [email])))[0];

  it("requires accepting the privacy notice", async () => {
    expect(await code(registerPublicAccount(db, { displayName: "Pat Resident", email: "pat@example.test" }))).toBe("VALIDATION");
  });

  it("a new address gets a confirmation link that confirms the email and signs in; a known address gets a sign-in link, indistinguishably", async () => {
    await registerPublicAccount(db, { displayName: "Pat Resident", email: "pat@example.test", acceptTerms: "on" });
    const mail = await latest("pat@example.test");
    expect(mail.body_text).toContain("/auth/confirm?token=");
    const token = mail.body_text.match(/token=([A-Za-z0-9_-]+)/)![1];
    const { sessionToken, userId } = await confirmEmail(db, token);
    expect(sessionToken.length).toBeGreaterThan(20);
    const verified = await sys((tx) => tx.query(`SELECT 1 FROM users WHERE id = $1 AND email_verified_at IS NOT NULL`, [userId]));
    expect(verified).toHaveLength(1);
    // Registering again with a confirmed address sends a sign-in link and gives the caller the same (silent) result.
    await expect(registerPublicAccount(db, { displayName: "Someone Else", email: "pat@example.test", acceptTerms: "on" })).resolves.toBeUndefined();
    expect((await latest("pat@example.test")).body_text).toContain("/auth/callback?token=");
    await requestSignIn(db, "pat@example.test");
  });
});

describe("submission and routing", () => {
  it("an unconfirmed email cannot apply", async () => {
    const id = await sys(async (tx) => (await tx.query<{ id: string }>(`INSERT INTO users (email, display_name) VALUES ('unverified@example.test', 'Un Verified') RETURNING id`))[0].id);
    expect(await code(submitApplication(db, id, form()))).toBe("UNAUTHENTICATED");
  });

  it("validates input", async () => {
    expect(await code(submitApplication(db, applicantA, form({ zip: "1234" })))).toBe("VALIDATION");
    expect(await code(submitApplication(db, applicantA, form({ situation: "short" })))).toBe("VALIDATION");
    expect(await code(submitApplication(db, applicantA, form({ categoryCode: "NOPE" })))).toBe("VALIDATION");
    expect(await code(submitApplication(db, applicantA, form({ countyId: "00000000-0000-4000-8000-000000000000" })))).toBe("VALIDATION");
    expect(await code(submitApplication(db, applicantA, form({ preferredContact: "PHONE", contactPhone: "" })))).toBe("VALIDATION");
  });

  it("routes by county, ZIP and category: most specific rule wins; inactive rules and suspended orgs are ignored", async () => {
    const orgZip = await makeOrg(db, { name: "ZIP specialist" });
    const orgAny = await makeOrg(db, { name: "County generalist" });
    const orgDead = await makeOrg(db, { name: "Suspended later" });
    const r = (o: Record<string, unknown>) => createRoutingRule(db, exec, { countyId: countyB, ...o });
    await r({ handlerOrgId: orgAny });
    const zipRule = await r({ zip: "28805", handlerOrgId: orgZip });
    await r({ categoryCode: "FOOD_WATER", handlerOrgId: orgP });
    await r({ handlerOrgId: orgDead, zip: "28810", priority: 1 });
    await sys((tx) => tx.query(`UPDATE organizations SET status = 'SUSPENDED' WHERE id = $1`, [orgDead]));
    const route = (zip: string, cat: string) => sys((tx) => findRoute(tx, { countyId: countyB, zip, categoryCode: cat }));
    expect((await route("28805", "FOOD_WATER")).orgId).toBe(orgZip); // ZIP outranks category
    expect((await route("28899", "FOOD_WATER")).orgId).toBe(orgP); // category outranks county-wide
    expect((await route("28899", "UTILITIES")).orgId).toBe(orgAny); // county-wide fallback
    expect((await route("28810", "UTILITIES")).orgId).toBe(orgAny); // suspended org never suggested
    await setRoutingRuleActive(db, exec, zipRule, false);
    expect((await route("28805", "UTILITIES")).orgId).toBe(orgAny);
    expect((await sys((tx) => findRoute(tx, { countyId: countyA, zip: "28801", categoryCode: "UTILITIES" }))).orgId).toBeNull(); // no rule: manual
  });

  it("falls back to the platform default processing organization, then to manual routing", async () => {
    const countyC = await createCounty(db, exec, { name: "Charlie", state: "NC" });
    const fallback = await makeOrg(db, { name: "Default processor" });
    expect((await sys((tx) => findRoute(tx, { countyId: countyC, zip: "28001", categoryCode: "OTHER" }))).orgId).toBeNull();
    await sys((tx) => tx.query(`INSERT INTO platform_settings (key, value) VALUES ('assistance.default_processing_org_id', to_jsonb($1::text))`, [fallback]));
    expect((await sys((tx) => findRoute(tx, { countyId: countyC, zip: "28001", categoryCode: "OTHER" }))).orgId).toBe(fallback);
    await sys((tx) => tx.query(`DELETE FROM platform_settings WHERE key = 'assistance.default_processing_org_id'`)); // keep other tests independent
  });

  it("only administrators of a county (or executives) can manage its routing rules", async () => {
    expect(await code(createRoutingRule(db, adminB, { countyId: countyA, handlerOrgId: orgP }))).toBe("FORBIDDEN");
    expect(await code(createRoutingRule(db, stranger, { countyId: countyA, handlerOrgId: orgP }))).toBe("FORBIDDEN");
    expect(await code(createRoutingRule(db, adminA, { countyId: countyA, handlerOrgId: orgP, zip: "bad" }))).toBe("VALIDATION");
  });

  it("limits open applications per person and can be switched off", async () => {
    const heavy = await makeUser(db, "heavy@example.test");
    for (let i = 0; i < 5; i++) await submitApplication(db, heavy, form({ summary: `Application number ${i}` }));
    expect(await code(submitApplication(db, heavy, form()))).toBe("RATE_LIMITED");
    process.env.ASSISTANCE_ENABLED = "false";
    expect(await code(submitApplication(db, applicantB, form()))).toBe("FORBIDDEN");
  });

  it("emails never contain the applicant's story or name; county administrators are told there is work waiting", async () => {
    const id = await submitApplication(db, applicantB, form({ summary: "Needs water", situation: `${MARKER} Water is out.` }));
    const mails = await sys((tx) => tx.query<{ recipient_email: string; subject: string; body_text: string }>(`SELECT recipient_email, subject, body_text FROM notification_jobs`));
    for (const m of mails) {
      expect(m.subject + m.body_text).not.toContain(MARKER);
      expect(m.subject + m.body_text).not.toContain("Needs water");
    }
    const toAdmin = mails.filter((m) => m.recipient_email === "admin-a@example.test" && m.body_text.includes(id));
    expect(toAdmin).toHaveLength(1);
    expect(toAdmin[0].body_text).toContain(`/admin/applications/${id}`);
    expect(mails.some((m) => m.recipient_email === "admin-b@example.test" && m.body_text.includes(id))).toBe(false);
  });
});

describe("who can see an application", () => {
  let id: string;
  beforeAll(async () => {
    id = await submitApplication(db, applicantA, form({ summary: "Visible only to the right people" }));
  });

  it("the applicant sees their own; other residents never do", async () => {
    expect((await getMyApplication(db, applicantA, id)).summary).toBe("Visible only to the right people");
    expect(await code(getMyApplication(db, applicantB, id))).toBe("NOT_FOUND");
    expect((await listMyApplications(db, applicantB)).map((a) => a.id)).not.toContain(id);
    expect((await listMyApplications(db, applicantA)).map((a) => a.id)).toContain(id);
  });

  it("only the county's administrators and executives see it; other counties' administrators and strangers do not", async () => {
    expect((await getApplicationForStaff(db, adminA, id)).situation).toContain(MARKER);
    expect((await getApplicationForStaff(db, exec, id)).applicantEmail).toBe("app-a@example.test");
    expect(await code(getApplicationForStaff(db, adminB, id))).toBe("NOT_FOUND");
    expect(await code(getApplicationForStaff(db, stranger, id))).toBe("NOT_FOUND");
    expect((await listApplicationsForStaff(db, adminB)).rows.map((r) => r.id)).not.toContain(id);
    expect((await listApplicationsForStaff(db, adminA)).rows.map((r) => r.id)).toContain(id);
    expect(await code(listApplicationsForStaff(db, stranger))).toBe("FORBIDDEN");
  });

  it("a provider organization sees nothing before a referral, and an unrelated organization never does", async () => {
    expect(await code(getApplicationForStaff(db, provider, id))).toBe("NOT_FOUND");
    expect(await code(getApplicationForStaff(db, outsiderMember, id))).toBe("NOT_FOUND");
    expect((await listApplicationsForStaff(db, provider)).rows).toHaveLength(0);
  });

  it("the database itself enforces this: request roles cannot read or write around the application layer", async () => {
    const asStranger = await runIn(db, { kind: "viewer", userId: stranger }, (tx) => tx.query(`SELECT 1 FROM assistance_applications`));
    expect(asStranger).toHaveLength(0);
    const asOther = await runIn(db, { kind: "viewer", userId: applicantB }, (tx) =>
      tx.query(`SELECT 1 FROM assistance_application_events e JOIN assistance_applications a ON a.id = e.application_id WHERE a.id = $1`, [id]));
    expect(asOther).toHaveLength(0);
    expect(await code(runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT 1 FROM assistance_applications`)))).toBe("42501");
    expect(await code(runIn(db, { kind: "viewer", userId: applicantA }, (tx) => tx.query(`UPDATE assistance_applications SET status = 'COMPLETED' WHERE id = $1`, [id])))).toBe("42501");
    expect(await code(runIn(db, { kind: "viewer", userId: applicantA }, (tx) =>
      tx.query(`INSERT INTO assistance_applications (applicant_user_id, county_id, zip, category_code, summary, situation) VALUES ($1,$2,'28801','OTHER','hello world','a long enough story')`, [applicantA, countyA])))).toBe("42501");
    expect(await code(runIn(db, { kind: "viewer", userId: applicantA }, (tx) => tx.query(`SELECT 1 FROM users`)))).toBe("42501");
  });

  it("staff reads are audited, and the audit log never contains the applicant's words", async () => {
    await getApplicationForStaff(db, adminA, id);
    const views = await sys((tx) => tx.query<{ actor_user_id: string }>(`SELECT actor_user_id FROM audit_logs WHERE action = 'APPLICATION_VIEWED' AND subject_id = $1`, [id]));
    expect(views.map((v) => v.actor_user_id)).toContain(adminA);
    const leaked = await sys((tx) => tx.query(`SELECT 1 FROM audit_logs WHERE details::text ILIKE '%' || $1 || '%'`, [MARKER]));
    expect(leaked).toHaveLength(0);
  });
});

describe("pipeline and state machine", () => {
  it("runs the full journey with the right people at each step, and keeps a complete trail", async () => {
    const id = await submitApplication(db, applicantA, form({ summary: "Full journey" }));
    await transitionApplication(db, adminA, { applicationId: id, to: "UNDER_REVIEW" });
    // Asking for information requires a message, which the applicant can see.
    expect(await code(transitionApplication(db, adminA, { applicationId: id, to: "INFO_REQUIRED" }))).toBe("VALIDATION");
    await transitionApplication(db, adminA, { applicationId: id, to: "INFO_REQUIRED", note: "Please add a photo of the damage." });
    expect((await getMyApplication(db, applicantA, id)).status).toBe("INFO_REQUIRED");
    await provideRequestedInfo(db, applicantA, id, "Photo attached to the application.");
    expect((await getMyApplication(db, applicantA, id)).status).toBe("UNDER_REVIEW");
    await transitionApplication(db, adminA, { applicationId: id, to: "APPROVED", note: "Eligible", visibleToApplicant: "on" });
    await transitionApplication(db, adminA, { applicationId: id, to: "REFERRED" }); // suggested provider from the routing rule
    const forProvider = await getApplicationForStaff(db, provider, id);
    expect(forProvider.capacity).toBe("provider");
    expect(forProvider.referredOrgName).toBe("[TEST] Provider P");
    expect(forProvider.events.some((e) => e.type === "ROUTED")).toBe(false);
    await addApplicationNote(db, provider, id, "Contacted the household; crew scheduled.", false);
    await transitionApplication(db, provider, { applicationId: id, to: "IN_PROGRESS", note: "Work started", visibleToApplicant: "on" });
    await transitionApplication(db, provider, { applicationId: id, to: "COMPLETED", note: "Roof tarped", visibleToApplicant: "on" });

    const mine = await getMyApplication(db, applicantA, id);
    expect(mine.status).toBe("COMPLETED");
    // The applicant's timeline holds their own steps and visible updates, but not internal notes or routing.
    const notes = mine.events.map((e) => e.note ?? "");
    expect(notes.join(" ")).not.toContain("Contacted the household");
    expect(mine.events.some((e) => e.type === "ROUTED")).toBe(false);
    expect(mine.events.filter((e) => e.type === "STATUS_CHANGED").map((e) => e.toStatus)).toEqual(
      expect.arrayContaining(["INFO_REQUIRED", "UNDER_REVIEW", "APPROVED", "IN_PROGRESS", "COMPLETED"]));

    const staff = await getApplicationForStaff(db, adminA, id);
    const trail = staff.events.filter((e) => e.type === "STATUS_CHANGED").map((e) => `${e.fromStatus}>${e.toStatus}`);
    expect(trail).toEqual(["SUBMITTED>UNDER_REVIEW", "UNDER_REVIEW>INFO_REQUIRED", "INFO_REQUIRED>UNDER_REVIEW", "UNDER_REVIEW>APPROVED", "APPROVED>REFERRED", "REFERRED>IN_PROGRESS", "IN_PROGRESS>COMPLETED"]);
    expect(staff.events.some((e) => e.type === "NOTE" && e.note?.includes("crew scheduled"))).toBe(true);
    expect(staff.allowedNext).toEqual([]); // completed is final
  });

  it("rejects illegal moves in code and in the database", async () => {
    const id = await submitApplication(db, applicantA, form({ summary: "Illegal moves" }));
    expect(await code(transitionApplication(db, adminA, { applicationId: id, to: "COMPLETED" }))).toBe("CONFLICT");
    expect(await code(transitionApplication(db, adminA, { applicationId: id, to: "REFERRED" }))).toBe("CONFLICT");
    // Straight to the database, bypassing the application code:
    expect(await code(sys((tx) => tx.query(`UPDATE assistance_applications SET status = 'COMPLETED' WHERE id = $1`, [id])))).toBe("23514");
    // A real move without naming who did it is refused, so the trail cannot be skipped.
    expect(await code(sys((tx) => tx.query(`UPDATE assistance_applications SET status = 'UNDER_REVIEW' WHERE id = $1`, [id])))).toBe("42501");
    expect((await getApplicationForStaff(db, adminA, id)).status).toBe("SUBMITTED");
  });

  it("history cannot be edited or deleted", async () => {
    const id = await submitApplication(db, applicantA, form({ summary: "Append only" }));
    expect(await code(sys((tx) => tx.query(`UPDATE assistance_application_events SET note = 'edited' WHERE application_id = $1`, [id])))).toBe("42501");
    expect(await code(sys((tx) => tx.query(`DELETE FROM assistance_application_events WHERE application_id = $1`, [id])))).toBe("42501");
  });

  it("a provider may only do provider things, and only for what was referred to it", async () => {
    const id = await approved();
    expect(await code(transitionApplication(db, provider, { applicationId: id, to: "IN_PROGRESS" }))).toBe("NOT_FOUND"); // not referred yet
    await transitionApplication(db, adminA, { applicationId: id, to: "REFERRED" });
    expect(await code(transitionApplication(db, provider, { applicationId: id, to: "CLOSED", closureReason: "DENIED", note: "no thanks" }))).toBe("CONFLICT");
    expect(await code(transitionApplication(db, provider, { applicationId: id, to: "UNDER_REVIEW" }))).toBe("CONFLICT");
    expect(await code(transitionApplication(db, outsiderMember, { applicationId: id, to: "IN_PROGRESS" }))).toBe("NOT_FOUND");
    await transitionApplication(db, provider, { applicationId: id, to: "APPROVED", note: "We cannot take this one" }); // hand back
    expect(await code(getApplicationForStaff(db, provider, id))).toBe("NOT_FOUND"); // no longer theirs
  });

  it("an application without the applicant's consent is never shared with a provider", async () => {
    const id = await approved(undefined, { consentShareProviders: "" });
    expect(await code(transitionApplication(db, adminA, { applicationId: id, to: "REFERRED" }))).toBe("CONFLICT");
    expect(await code(sys((tx) => tx.query(
      `UPDATE assistance_applications SET status = 'REFERRED', referred_org_id = $2 WHERE id = $1`, [id, orgP])))).toBe("23514"); // the database trigger refuses even trusted code
    expect(await code(getApplicationForStaff(db, provider, id))).toBe("NOT_FOUND");
    await transitionApplication(db, adminA, { applicationId: id, to: "IN_PROGRESS" }); // the county can still handle it itself
  });

  it("referral needs an approved organization and a target", async () => {
    const id = await approved(undefined, { categoryCode: "UTILITIES" }); // no routing rule for this category in county A
    expect(await code(transitionApplication(db, adminA, { applicationId: id, to: "REFERRED" }))).toBe("VALIDATION");
    const pending = await makeOrg(db, { name: "Not approved", status: "PENDING_VERIFICATION" });
    expect(await code(transitionApplication(db, adminA, { applicationId: id, to: "REFERRED", referOrgId: pending }))).toBe("VALIDATION");
    await transitionApplication(db, adminA, { applicationId: id, to: "REFERRED", referOrgId: orgP });
    expect((await getApplicationForStaff(db, provider, id)).status).toBe("REFERRED");
  });

  it("denying or closing needs a reason, shows the applicant why, and is final", async () => {
    const owner = await newApplicant();
    const id = await submitApplication(db, owner, form({ summary: "To be denied" }));
    expect(await code(transitionApplication(db, adminA, { applicationId: id, to: "CLOSED" }))).toBe("VALIDATION");
    expect(await code(transitionApplication(db, adminA, { applicationId: id, to: "CLOSED", closureReason: "DENIED" }))).toBe("VALIDATION");
    await transitionApplication(db, adminA, { applicationId: id, to: "CLOSED", closureReason: "DENIED", note: "Outside the disaster declaration area." });
    const mine = await getMyApplication(db, owner, id);
    expect(mine).toMatchObject({ status: "CLOSED", closureReason: "DENIED" });
    expect(mine.events.at(-1)?.note).toContain("Outside the disaster declaration area");
    expect(await code(transitionApplication(db, adminA, { applicationId: id, to: "UNDER_REVIEW" }))).toBe("CONFLICT");
  });

  it("applicants can withdraw until work is with a provider, and cannot touch others' applications", async () => {
    const owner = await newApplicant();
    const id = await submitApplication(db, owner, form({ summary: "Will withdraw" }));
    expect(await code(withdrawApplication(db, applicantB, id))).toBe("NOT_FOUND");
    await withdrawApplication(db, owner, id, "Found help elsewhere.");
    expect(await getMyApplication(db, owner, id)).toMatchObject({ status: "CLOSED", closureReason: "WITHDRAWN" });
    const owner2 = await newApplicant();
    const referred = await approved(owner2);
    await transitionApplication(db, adminA, { applicationId: referred, to: "REFERRED" });
    expect(await code(withdrawApplication(db, owner2, referred))).toBe("CONFLICT");
    expect(await code(provideRequestedInfo(db, owner2, referred, "no info was requested"))).toBe("CONFLICT");
  });

  it("staff queues are filtered and paged, and the queue never includes the viewer's own application", async () => {
    const q = await listApplicationsForStaff(db, adminA, { status: "APPROVED" });
    expect(q.rows.every((r) => r.status === "APPROVED")).toBe(true);
    expect(await code(listApplicationsForStaff(db, adminA, { status: "NOT_A_STATUS" }))).toBe("VALIDATION");
    expect((await listApplicationsForStaff(db, adminA, { countyId: countyB })).rows).toHaveLength(0);
    const own = await submitApplication(db, adminA, form({ summary: "Staff member's own request" }));
    expect((await listApplicationsForStaff(db, adminA)).rows.map((r) => r.id)).not.toContain(own);
    expect((await getMyApplication(db, adminA, own)).id).toBe(own);
  });
});

describe("staff handling personal data needs MFA where enforced", () => {
  it("county administrators and provider staff without MFA are locked out of applications", async () => {
    const owner = await newApplicant();
    const id = await approved(owner);
    await transitionApplication(db, adminA, { applicationId: id, to: "REFERRED" });
    process.env.REQUIRE_MFA_FOR_PRIVILEGED = "true";
    expect(await code(listApplicationsForStaff(db, adminA))).toBe("FORBIDDEN");
    expect(await code(getApplicationForStaff(db, adminA, id))).toMatch(/FORBIDDEN|NOT_FOUND/);
    expect(await code(getApplicationForStaff(db, provider, id))).toBe("FORBIDDEN");
    expect(await code(listApplicationsForStaff(db, provider))).toBe("FORBIDDEN");
    // Applicants themselves are never asked for MFA to see their own application.
    expect((await getMyApplication(db, owner, id)).id).toBe(id);
  });
});

describe("documents", () => {
  let id: string;
  let applicantDoc: string;
  beforeAll(async () => {
    applicantDoc = await newApplicant();
    id = await approved(applicantDoc, { summary: "Has documents" });
  });

  it("uploads are re-encoded, scanned and stored privately; the applicant can open their own", async () => {
    const docId = await uploadApplicationDocument(db, store, cleanScanner, applicantDoc, id, { bytes: await png(), name: "../Damage Photo.PNG" });
    const mine = await getMyApplication(db, applicantDoc, id);
    expect(mine.documents).toEqual([expect.objectContaining({ id: docId, displayName: "Damage Photo.webp", contentType: "image/webp", scanStatus: "CLEAN" })]);
    const out = await readApplicationDocument(db, store, applicantDoc, docId);
    expect((await sharp(out.bytes).metadata()).format).toBe("webp");
  });

  it("other people cannot even learn that a document exists", async () => {
    const docId = (await getMyApplication(db, applicantDoc, id)).documents[0].id;
    expect(await code(readApplicationDocument(db, store, applicantB, docId))).toBe("NOT_FOUND");
    expect(await code(readApplicationDocument(db, store, adminB, docId))).toBe("NOT_FOUND");
    expect(await code(readApplicationDocument(db, store, provider, docId))).toBe("NOT_FOUND"); // not referred yet
    expect(await code(uploadApplicationDocument(db, store, cleanScanner, applicantB, id, { bytes: await png(), name: "x.png" }))).toBe("NOT_FOUND");
    expect(await code(removeApplicationDocument(db, applicantB, docId))).toBe("NOT_FOUND");
  });

  it("the county's administrators and, after referral with consent, the provider can open it; each release is audited", async () => {
    const docId = (await getMyApplication(db, applicantDoc, id)).documents[0].id;
    await readApplicationDocument(db, store, adminA, docId);
    await transitionApplication(db, adminA, { applicationId: id, to: "REFERRED" });
    await readApplicationDocument(db, store, provider, docId);
    const views = await sys((tx) => tx.query<{ actor_user_id: string }>(`SELECT actor_user_id FROM audit_logs WHERE action = 'DOCUMENT_VIEWED' AND subject_id = $1`, [id]));
    expect(views.map((v) => v.actor_user_id)).toEqual(expect.arrayContaining([adminA, provider]));
    expect(await code(readApplicationDocument(db, store, outsiderMember, docId))).toBe("NOT_FOUND");
  });

  it("infected, unscannable and disguised files are refused and leave nothing behind", async () => {
    const fresh = await submitApplication(db, applicantB, form({ summary: "Bad uploads" }));
    expect(await code(uploadApplicationDocument(db, store, cleanScanner, applicantB, fresh, { bytes: Buffer.concat([Buffer.from("%PDF-1.4 EICAR"), Buffer.alloc(10)]), name: "a.pdf" }))).toBe("VALIDATION");
    expect(await code(uploadApplicationDocument(db, store, brokenScanner, applicantB, fresh, { bytes: await png(), name: "b.png" }))).toBe("VALIDATION");
    expect(await code(uploadApplicationDocument(db, store, cleanScanner, applicantB, fresh, { bytes: Buffer.from("MZ not a document"), name: "c.pdf" }))).toBe("VALIDATION");
    expect((await getMyApplication(db, applicantB, fresh)).documents).toHaveLength(0);
    const audit = await sys((tx) => tx.query(`SELECT 1 FROM audit_logs WHERE action = 'DOCUMENT_REJECTED_INFECTED' AND subject_id = $1`, [fresh]));
    expect(audit).toHaveLength(1);
  });

  it("a file that is not CLEAN is never released, even to the applicant or an administrator", async () => {
    const docId = (await getMyApplication(db, applicantDoc, id)).documents[0].id;
    await sys((tx) => tx.query(`UPDATE assistance_documents SET scan_status = 'INFECTED' WHERE id = $1`, [docId]));
    expect(await code(readApplicationDocument(db, store, applicantDoc, docId))).toBe("FORBIDDEN");
    expect(await code(readApplicationDocument(db, store, adminA, docId))).toBe("FORBIDDEN");
    await sys((tx) => tx.query(`UPDATE assistance_documents SET scan_status = 'CLEAN' WHERE id = $1`, [docId]));
  });

  it("enforces the per-application file limit, blocks uploads to closed applications, and removal hides the file", async () => {
    const heavy = await submitApplication(db, applicantB, form({ summary: "Many files" }));
    for (let i = 0; i < 8; i++) await uploadApplicationDocument(db, store, cleanScanner, applicantB, heavy, { bytes: await sharp({ create: { width: 10 + i, height: 10, channels: 3, background: "#000" } }).png().toBuffer(), name: `f${i}.png` });
    expect(await code(uploadApplicationDocument(db, store, cleanScanner, applicantB, heavy, { bytes: await png(), name: "ninth.png" }))).toBe("CONFLICT");
    const first = (await getMyApplication(db, applicantB, heavy)).documents[0].id;
    await removeApplicationDocument(db, applicantB, first);
    expect((await getMyApplication(db, applicantB, heavy)).documents).toHaveLength(7);
    expect(await code(readApplicationDocument(db, store, applicantB, first))).toBe("NOT_FOUND");
    await withdrawApplication(db, applicantB, heavy);
    expect(await code(uploadApplicationDocument(db, store, cleanScanner, applicantB, heavy, { bytes: await png(), name: "late.png" }))).toBe("CONFLICT");
  });
});

describe("production readiness gate", () => {
  const full = {
    NODE_ENV: "production", ASSISTANCE_ENABLED: "true", EMAIL_TRANSPORT: "smtp", SMTP_URL: "smtps://u:p@smtp.example.org:465",
    EMAIL_FROM: "Crisis Compass <no-reply@example.org>", AUTH_PROVIDER: "magic-link-mfa", MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    S3_BUCKET: "private", SCANNER: "clamd", CLAMD_HOST: "clam",
  };

  it("is ready in development by default and can be switched off", () => {
    expect(assistanceReadiness({}).ready).toBe(true);
    expect(assistanceReadiness({ ASSISTANCE_ENABLED: "false" }).ready).toBe(false);
  });

  it("production stays closed until every protection is configured", () => {
    expect(assistanceReadiness({ NODE_ENV: "production" }).ready).toBe(false);
    expect(assistanceReadiness(full).ready).toBe(true);
    for (const missing of ["ASSISTANCE_ENABLED", "EMAIL_TRANSPORT", "AUTH_PROVIDER", "MFA_ENCRYPTION_KEY"] as const) {
      const env: Record<string, string | undefined> = { ...full, [missing]: undefined };
      expect(assistanceReadiness(env).ready, missing).toBe(false);
    }
  });

  it("without storage or a scanner, applications still work but document uploads stay off", () => {
    expect(documentsAvailable(full)).toBe(true);
    const noScanner = { ...full, SCANNER: undefined };
    expect(assistanceReadiness(noScanner).ready).toBe(true);
    expect(documentsAvailable(noScanner)).toBe(false);
    expect(documentsAvailable({ ...full, S3_BUCKET: undefined })).toBe(false);
  });
});
