import { notFound } from "next/navigation";
import { getDriver } from "@/server/db";
import { runIn } from "@/server/db/context";

export const dynamic = "force-dynamic";

/** Development-only view of queued transactional emails. 404 in production. */
export default async function OutboxPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const jobs = await runIn(await getDriver(), { kind: "system" }, (tx) =>
    tx.query<{ id: string; recipient_email: string; subject: string; body_text: string; status: string; created_at: Date }>(
      `SELECT id, recipient_email, subject, body_text, status, created_at FROM notification_jobs ORDER BY created_at DESC LIMIT 30`,
    ),
  );
  const linkify = (t: string) =>
    t.split(/(https?:\/\/\S+)/).map((p, i) =>
      /^https?:\/\//.test(p) ? (
        <a key={i} className="break-all text-brand underline" href={p.replace(/^https?:\/\/[^/]+/, "")}>
          {p}
        </a>
      ) : (
        p
      ),
    );
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-bold">Dev outbox</h1>
      <p className="mt-1 text-sm text-muted">
        Queued notification jobs. No email provider is configured, so nothing leaves this machine and jobs stay PENDING.
      </p>
      <ul className="mt-4 grid gap-3">
        {jobs.map((j) => (
          <li key={j.id} className="card p-3">
            <div className="text-sm text-muted">
              {j.created_at.toLocaleString()} · to {j.recipient_email} · {j.status}
            </div>
            <div className="font-semibold">{j.subject}</div>
            <pre className="mt-1 whitespace-pre-wrap font-sans text-sm">{linkify(j.body_text)}</pre>
          </li>
        ))}
        {jobs.length === 0 && <li className="text-muted">No messages yet.</li>}
      </ul>
    </div>
  );
}
