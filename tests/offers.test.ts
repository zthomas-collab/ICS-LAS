import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "@/server/db";
import { runIn } from "@/server/db/context";
import { assignCountyAdmin, createCounty } from "@/server/modules/counties";
import {
  addOfferNote, assignOfferCounty, getOffer, getNotificationEmailForAdmin, listOffers, setNotificationEmail, submitOffer, transitionOffer,
} from "@/server/modules/offers";
import { freshDb } from "./helpers/db";
import { grantRole, makeUser } from "./helpers/fixtures";

let db: Driver;
let exec: string, adminA: string, adminB: string, stranger: string;
let countyA: string, countyB: string;
const sys = <T>(fn: (tx: import("@/server/db").Tx) => Promise<T>) => runIn(db, { kind: "system" }, fn);
const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
let seq = 0;
const offer = (over: Record<string, unknown> = {}) => ({
  contributorName: "Pat Giver", email: `giver-${seq++}@example.test`, phone: "(828) 555-0188", zip: "28801", contributionType: "DRINKING_WATER",
  quantity: "200", unit: "cases", description: "Palletized bottled water ready for pickup.", consentContact: "on", ...over,
});

beforeAll(async () => {
  db = await freshDb();
  [exec, adminA, adminB, stranger] = await Promise.all(["exec", "admin-a", "admin-b", "stranger"].map((n) => makeUser(db, `${n}@example.test`)));
  await grantRole(db, exec, "PLATFORM_ADMIN");
  countyA = await createCounty(db, exec, { name: "Buncombe", state: "NC" });
  countyB = await createCounty(db, exec, { name: "Aiken", state: "SC" });
  await assignCountyAdmin(db, exec, { email: "admin-a@example.test", countyId: countyA, reason: "County A coordinator" });
  await assignCountyAdmin(db, exec, { email: "admin-b@example.test", countyId: countyB, reason: "County B coordinator" });
  await sys((tx) => tx.query(`UPDATE platform_settings SET value = to_jsonb('stale'::text) WHERE key = 'zip_county_sha256'`));
  const { syncZipCounty } = await import("@/server/modules/zipcounty");
  await syncZipCounty(db); // back-fills FIPS on the two counties above
});
afterAll(async () => db?.close());

describe("intake", () => {
  it("saves the offer with a unique reference and an audit trail, and derives the county from a one-county ZIP", async () => {
    const a = await submitOffer(db, offer());
    const b = await submitOffer(db, offer());
    expect(a.reference).toMatch(/^OFR-\d{4}-\d{6}$/);
    expect(a.reference).not.toBe(b.reference);
    const row = await sys((tx) => tx.query<{ county_id: string; status: string }>(`SELECT county_id, status FROM contribution_offers WHERE id = $1`, [a.id]));
    expect(row[0]).toMatchObject({ county_id: countyA, status: "SUBMITTED" });
    const audit = await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'OFFER_SUBMITTED' AND subject_id = $1`, [a.id]));
    expect(audit[0].n).toBe(1);
  });

  it("keeps the offer even when no email destination is configured, and queues emails (never sends inline) when it is", async () => {
    const before = await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification_jobs WHERE kind = 'OFFER_NEW'`));
    const first = await submitOffer(db, offer());
    expect(first.id).toBeTruthy();
    const afterNone = await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification_jobs WHERE kind = 'OFFER_NEW'`));
    expect(afterNone[0].n).toBe(before[0].n); // saved, nobody to notify yet

    await setNotificationEmail(db, exec, { email: "Intake@Crisis.Example" });
    const o = await submitOffer(db, offer({ contributorName: "SECRET-NAME-MARKER" }));
    const jobs = await sys((tx) => tx.query<{ recipient_email: string; body_text: string; status: string }>(
      `SELECT recipient_email, body_text, status FROM notification_jobs WHERE body_text LIKE $1 AND kind = 'OFFER_NEW'`, [`%${o.reference}%`]));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].recipient_email).toBe("intake@crisis.example");
    expect(jobs[0].status).toBe("PENDING"); // delivery and retry belong to the notification worker
    expect(jobs[0].body_text).not.toContain("SECRET-NAME-MARKER"); // staff email carries no contributor details
    const receipt = await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM notification_jobs WHERE kind = 'OFFER_RECEIPT' AND body_text LIKE $1`, [`%${o.reference}%`]));
    expect(receipt[0].n).toBe(1);
  });

  it("validates input: consent is required, ZIP must fit the chosen county, quantity and dates must be sane", async () => {
    expect(await code(submitOffer(db, offer({ consentContact: "" })))).toBe("VALIDATION");
    expect(await code(submitOffer(db, offer({ contributionType: "GOLD" })))).toBe("VALIDATION");
    expect(await code(submitOffer(db, offer({ quantity: "-4" })))).toBe("VALIDATION");
    expect(await code(submitOffer(db, offer({ zip: "2880" })))).toBe("VALIDATION");
    expect(await code(submitOffer(db, offer({ availableFrom: "2026-12-10", availableUntil: "2026-12-01" })))).toBe("VALIDATION");
    expect(await code(submitOffer(db, offer({ countyId: countyB })))).toBe("VALIDATION"); // 28801 is not in Aiken
    expect(await code(submitOffer(db, offer({ countyId: countyA })))).toBe("OK");
  });

  it("limits repeat submissions from one email address", async () => {
    const email = "repeat@example.test";
    for (let i = 0; i < 3; i++) await submitOffer(db, offer({ email }));
    expect(await code(submitOffer(db, offer({ email })))).toBe("RATE_LIMITED");
  });

  it("an offer with a ZIP that spans several counties starts unassigned and only an executive can assign it, once", async () => {
    const multi = (await sys((tx) => tx.query<{ zip: string; fips: string }>(
      `SELECT zip, (array_agg(county_fips ORDER BY land_share DESC))[1] AS fips FROM zip_county GROUP BY zip HAVING count(*) > 1 ORDER BY zip LIMIT 1`)))[0];
    const county = await createCounty(db, exec, { name: "Spanning", state: "NC" });
    await sys((tx) => tx.query(`UPDATE counties SET fips = $2 WHERE id = $1`, [county, multi.fips]));
    const o = await submitOffer(db, offer({ zip: multi.zip }));
    expect((await sys((tx) => tx.query<{ county_id: string | null }>(`SELECT county_id FROM contribution_offers WHERE id = $1`, [o.id])))[0].county_id).toBeNull();
    expect(await code(assignOfferCounty(db, adminA, o.id, county))).toBe("FORBIDDEN");
    await assignOfferCounty(db, exec, o.id, county);
    expect(await code(assignOfferCounty(db, exec, o.id, county))).toBe("CONFLICT");
  });
});

describe("authorization and isolation", () => {
  it("county administrators see only their county's offers; unassigned offers are executive-only; strangers and the public see nothing", async () => {
    const a = await submitOffer(db, offer()); // county A (Buncombe)
    const unassigned = await submitOffer(db, offer({ zip: "99999" }));
    const asA = await listOffers(db, adminA);
    expect(asA.rows.some((r) => r.id === a.id)).toBe(true);
    expect(asA.rows.some((r) => r.id === unassigned.id)).toBe(false);
    const asB = await listOffers(db, adminB);
    expect(asB.rows.some((r) => r.id === a.id)).toBe(false);
    const asExec = await listOffers(db, exec);
    expect(asExec.rows.some((r) => r.id === a.id) && asExec.rows.some((r) => r.id === unassigned.id)).toBe(true);
    expect(await code(listOffers(db, stranger))).toBe("FORBIDDEN");
    expect(await code(getOffer(db, adminB, a.id))).toBe("NOT_FOUND");
    expect(await code(getOffer(db, adminA, unassigned.id))).toBe("NOT_FOUND");
    expect((await getOffer(db, adminA, a.id)).email).toContain("@example.test");
    // Anonymous role cannot read the table at all.
    await expect(runIn(db, { kind: "anon" }, (tx) => tx.query(`SELECT * FROM contribution_offers`))).rejects.toThrow();
  });

  it("the notification address is executive-only and validated", async () => {
    expect(await code(setNotificationEmail(db, adminA, { email: "a@b.example" }))).toBe("FORBIDDEN");
    expect(await code(setNotificationEmail(db, exec, { email: "not-an-email" }))).toBe("VALIDATION");
    await setNotificationEmail(db, exec, { email: "" });
    expect(await getNotificationEmailForAdmin(db, exec)).toBeNull();
    await setNotificationEmail(db, exec, { email: "ops@crisis.example" });
    expect(await getNotificationEmailForAdmin(db, exec)).toBe("ops@crisis.example");
    expect(await code(getNotificationEmailForAdmin(db, adminA))).toBe("FORBIDDEN");
  });
});

describe("workflow", () => {
  it("follows Submitted -> Reviewed -> Matched -> Accepted -> Scheduled -> Completed with an append-only history, and refuses shortcuts", async () => {
    const o = await submitOffer(db, offer());
    expect(await code(transitionOffer(db, adminA, { offerId: o.id, to: "ACCEPTED" }))).toBe("CONFLICT");
    for (const to of ["REVIEWED", "MATCHED", "ACCEPTED", "SCHEDULED", "COMPLETED"]) await transitionOffer(db, adminA, { offerId: o.id, to });
    const d = await getOffer(db, adminA, o.id);
    expect(d.status).toBe("COMPLETED");
    expect(d.events.filter((e) => e.type === "STATUS_CHANGED").map((e) => e.toStatus)).toEqual(["REVIEWED", "MATCHED", "ACCEPTED", "SCHEDULED", "COMPLETED"]);
    expect(d.allowedNext).toEqual([]);
    await expect(sys((tx) => tx.query(`UPDATE contribution_offer_events SET note = 'x' WHERE offer_id = $1`, [o.id]))).rejects.toThrow();
    await expect(sys((tx) => tx.query(`UPDATE contribution_offers SET status = 'SUBMITTED' WHERE id = $1`, [o.id]))).rejects.toThrow(); // database refuses too
  });

  it("declining needs a reason, another county's administrator cannot act, and notes are recorded", async () => {
    const o = await submitOffer(db, offer());
    expect(await code(transitionOffer(db, adminA, { offerId: o.id, to: "DECLINED" }))).toBe("VALIDATION");
    expect(await code(transitionOffer(db, adminB, { offerId: o.id, to: "REVIEWED" }))).toBe("NOT_FOUND");
    await addOfferNote(db, adminA, o.id, "Called the donor; pickup works on Tuesday.");
    await transitionOffer(db, adminA, { offerId: o.id, to: "DECLINED", note: "Outside current needs." });
    const d = await getOffer(db, exec, o.id);
    expect(d.status).toBe("DECLINED");
    expect(d.events.map((e) => e.type)).toEqual(["SUBMITTED", "NOTE", "STATUS_CHANGED"]);
    const viewed = await sys((tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'OFFER_VIEWED' AND subject_id = $1`, [o.id]));
    expect(viewed[0].n).toBe(1);
  });
});
