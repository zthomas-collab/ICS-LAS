import type { Driver } from "../db";
import { runIn } from "../db/context";
import type { EmailTransport } from "../email";

/**
 * Notification worker: drains `notification_jobs` through an EmailTransport.
 *  - Safe to run from several processes at once (rows are claimed with FOR UPDATE SKIP LOCKED).
 *  - A claimed job that never finishes (crash) becomes claimable again after CLAIM_MINUTES.
 *  - Failures back off exponentially and end as DEAD after MAX_ATTEMPTS.
 *  - Sign-in and confirmation emails carry single-use tokens: once sent, the stored body is redacted so a
 *    database reader cannot replay them.
 */
export const MAX_ATTEMPTS = 5;
const CLAIM_MINUTES = 10;
/** Kinds whose body contains a credential-like link. */
const SECRET_KINDS = ["SIGN_IN", "EMAIL_CONFIRM", "INVITE"];

export type DrainResult = { claimed: number; sent: number; failed: number; dead: number };

type Job = { id: string; kind: string; recipient_email: string; subject: string; body_text: string; attempts: number };

export async function processNotificationJobs(driver: Driver, transport: EmailTransport, opts: { batch?: number } = {}): Promise<DrainResult> {
  const result: DrainResult = { claimed: 0, sent: 0, failed: 0, dead: 0 };
  // A transport that does not deliver (development) leaves the queue untouched.
  if (!transport.delivers) return result;

  const jobs = await runIn(driver, { kind: "system" }, (tx) =>
    tx.query<Job>(
      `UPDATE notification_jobs SET status = 'SENDING', attempts = attempts + 1, run_after = now() + make_interval(mins => $2)
        WHERE id IN (SELECT id FROM notification_jobs
                      WHERE status IN ('PENDING','FAILED','SENDING') AND run_after <= now() AND attempts < $3
                      ORDER BY run_after LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, kind, recipient_email, subject, body_text, attempts`,
      [opts.batch ?? 25, CLAIM_MINUTES, MAX_ATTEMPTS],
    ),
  );
  result.claimed = jobs.length;

  for (const job of jobs) {
    try {
      await transport.send({ to: job.recipient_email, subject: job.subject, text: job.body_text });
      await runIn(driver, { kind: "system" }, (tx) =>
        tx.query(
          `UPDATE notification_jobs SET status = 'SENT', sent_at = now(), last_error = NULL,
                  body_text = CASE WHEN kind = ANY($2::text[]) THEN '[redacted after sending]' ELSE body_text END
            WHERE id = $1`,
          [job.id, SECRET_KINDS],
        ),
      );
      result.sent++;
    } catch (err) {
      const dead = job.attempts >= MAX_ATTEMPTS;
      // Never store provider responses verbatim: they can echo addresses or credentials.
      const safe = (err as Error).message.replace(/[\r\n]+/g, " ").replace(/\/\/[^@\s]*@/g, "//***@").slice(0, 200);
      await runIn(driver, { kind: "system" }, (tx) =>
        tx.query(
          `UPDATE notification_jobs SET status = $2, last_error = $3,
                  run_after = now() + make_interval(mins => $4)
            WHERE id = $1`,
          [job.id, dead ? "DEAD" : "FAILED", safe, 2 ** job.attempts],
        ),
      );
      if (dead) result.dead++;
      else result.failed++;
    }
  }
  return result;
}

export type QueueStats = { pending: number; failed: number; dead: number; oldestPendingMinutes: number | null };

export async function queueStats(driver: Driver): Promise<QueueStats> {
  const r = await runIn(driver, { kind: "system" }, (tx) =>
    tx.query<{ pending: number; failed: number; dead: number; oldest: number | null }>(
      `SELECT count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
              count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
              count(*) FILTER (WHERE status = 'DEAD')::int AS dead,
              (extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'PENDING')) / 60)::float8 AS oldest
         FROM notification_jobs`,
    ),
  );
  return { pending: r[0].pending, failed: r[0].failed, dead: r[0].dead, oldestPendingMinutes: r[0].oldest };
}
