import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Driver } from "@/server/db";
import { runIn } from "@/server/db/context";
import { createTransport, sanitizeEmail, type EmailTransport, type OutgoingEmail } from "@/server/email";
import { MAX_ATTEMPTS, processNotificationJobs, queueStats } from "@/server/modules/notifications";
import { enqueueEmail } from "@/server/modules/shared";
import { freshDb } from "./helpers/db";

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  readonly delivers: boolean;
  sent: OutgoingEmail[] = [];
  failFor = new Set<string>();
  constructor(delivers = true) {
    this.delivers = delivers;
  }
  async send(msg: OutgoingEmail) {
    if (this.failFor.has(msg.to)) throw new Error("550 mailbox unavailable for smtp://user:secret@host");
    this.sent.push(msg);
  }
}

let db: Driver;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => db?.close());

const enqueue = (to: string, kind = "TEST", body = "hello") =>
  runIn(db, { kind: "system" }, (tx) => enqueueEmail(tx, { kind, to, subject: `Subject for ${to}`, body }));
const job = async (to: string) =>
  (await runIn(db, { kind: "system" }, (tx) =>
    tx.query<{ status: string; attempts: number; body_text: string; last_error: string | null; sent_at: Date | null }>(
      `SELECT status, attempts, body_text, last_error, sent_at FROM notification_jobs WHERE recipient_email = $1`, [to]),
  ))[0];

describe("email transport configuration", () => {
  it("defaults to the non-delivering dev transport outside production", () => {
    expect(createTransport({}).delivers).toBe(false);
  });
  it("refuses to run production without a real transport", () => {
    expect(() => createTransport({ NODE_ENV: "production" })).toThrow(/smtp is required/);
    expect(() => createTransport({ EMAIL_TRANSPORT: "smtp" })).toThrow(/SMTP_URL/);
    expect(() => createTransport({ EMAIL_TRANSPORT: "smtp", SMTP_URL: "smtps://u:p@h:465", EMAIL_FROM: "bad\r\nBcc: x@y.z" })).toThrow(/EMAIL_FROM/);
    expect(() => createTransport({ EMAIL_TRANSPORT: "carrier-pigeon" })).toThrow(/Unknown/);
    expect(createTransport({ EMAIL_TRANSPORT: "smtp", SMTP_URL: "smtps://u:p@h:465", EMAIL_FROM: "Crisis Compass <no-reply@example.org>" }).delivers).toBe(true);
  });
  it("blocks header injection and malformed recipients before they reach a provider", () => {
    expect(sanitizeEmail({ to: "a@example.org", subject: "Hi\r\nBcc: evil@example.org", text: "x" }).subject).toBe("Hi Bcc: evil@example.org");
    for (const to of ["a@example.org, b@example.org", "a@example.org\r\nBcc: x@y.z", "Name <a@example.org>", "nodomain", ""]) {
      expect(() => sanitizeEmail({ to, subject: "s", text: "t" }), to).toThrow();
    }
  });
});

describe("notification worker", () => {
  it("leaves the queue untouched when the transport does not deliver", async () => {
    await enqueue("dev@example.org");
    const r = await processNotificationJobs(db, new FakeTransport(false));
    expect(r.claimed).toBe(0);
    expect((await job("dev@example.org")).status).toBe("PENDING");
  });

  it("delivers queued mail once and marks it sent", async () => {
    await enqueue("ok@example.org");
    const t = new FakeTransport();
    const r = await processNotificationJobs(db, t);
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(t.sent.filter((m) => m.to === "ok@example.org")).toHaveLength(1);
    const j = await job("ok@example.org");
    expect(j).toMatchObject({ status: "SENT", attempts: 1 });
    expect(j.sent_at).not.toBeNull();
    await processNotificationJobs(db, t);
    expect(t.sent.filter((m) => m.to === "ok@example.org")).toHaveLength(1); // not re-sent
  });

  it("redacts single-use links after sending, but keeps ordinary message bodies", async () => {
    await enqueue("link@example.org", "SIGN_IN", "Sign in: https://app.example/auth/callback?token=SECRET");
    await enqueue("note@example.org", "ORG_APPROVED", "Your organization was approved.");
    await processNotificationJobs(db, new FakeTransport());
    expect((await job("link@example.org")).body_text).toBe("[redacted after sending]");
    expect((await job("note@example.org")).body_text).toBe("Your organization was approved.");
  });

  it("backs off after a failure, hides credentials in the stored error, and ends as DEAD", async () => {
    await enqueue("bad@example.org");
    const t = new FakeTransport();
    t.failFor.add("bad@example.org");
    await processNotificationJobs(db, t);
    let j = await job("bad@example.org");
    expect(j.status).toBe("FAILED");
    expect(j.last_error).not.toContain("secret");
    expect(j.last_error).toContain("//***@");
    // Not due yet: another pass must not retry it.
    await processNotificationJobs(db, t);
    expect((await job("bad@example.org")).attempts).toBe(1);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await runIn(db, { kind: "system" }, (tx) => tx.query(`UPDATE notification_jobs SET run_after = now() - interval '1 second' WHERE recipient_email = 'bad@example.org'`));
      await processNotificationJobs(db, t);
    }
    j = await job("bad@example.org");
    expect(j).toMatchObject({ status: "DEAD", attempts: MAX_ATTEMPTS });
    expect((await queueStats(db)).dead).toBe(1);
  });

  it("a crashed worker's claimed job is picked up again after the claim expires", async () => {
    await enqueue("crash@example.org");
    await runIn(db, { kind: "system" }, (tx) =>
      tx.query(`UPDATE notification_jobs SET status = 'SENDING', attempts = 1, run_after = now() + interval '5 minutes' WHERE recipient_email = 'crash@example.org'`));
    const t = new FakeTransport();
    await processNotificationJobs(db, t);
    expect(t.sent.some((m) => m.to === "crash@example.org")).toBe(false); // still claimed by the other worker
    await runIn(db, { kind: "system" }, (tx) => tx.query(`UPDATE notification_jobs SET run_after = now() - interval '1 second' WHERE recipient_email = 'crash@example.org'`));
    await processNotificationJobs(db, t);
    expect(t.sent.some((m) => m.to === "crash@example.org")).toBe(true);
  });
});
