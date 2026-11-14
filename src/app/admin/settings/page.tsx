import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SettingsForm } from "@/components/offer-forms";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { getNotificationEmailForAdmin } from "@/server/modules/offers";
import { queueStats } from "@/server/modules/notifications";
import { requireUser } from "@/server/session";
import { saveSettingsAction } from "../../volunteer/actions";

export const metadata: Metadata = { title: "Settings", robots: { index: false } };
export const dynamic = "force-dynamic";

/** Executive-only platform settings. */
export default async function SettingsPage() {
  const user = await requireUser();
  const db = await getDriver();
  let email: string | null;
  try {
    email = await getNotificationEmailForAdmin(db, user.id);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") notFound();
    throw err;
  }
  const q = await queueStats(db);
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/admin">← Administration</Link></p>
      <h1 className="mt-2 text-3xl">Settings</h1>
      <section className="card mt-5 p-4" aria-labelledby="offers-email">
        <h2 id="offers-email" className="text-xl">Volunteer &amp; donation notifications</h2>
        <div className="mt-3"><SettingsForm action={saveSettingsAction} email={email} /></div>
        {!email && <p className="mt-3 rounded-md bg-warn-bg p-3 text-sm text-warn">No address is set, so nobody is emailed about new offers. They still appear in <Link className="underline" href="/admin/offers">the offers dashboard</Link>.</p>}
      </section>
      <section className="card mt-5 p-4" aria-labelledby="queue">
        <h2 id="queue" className="text-xl">Email delivery queue</h2>
        <p className="mt-2 text-sm">Waiting: {q.pending} · Failed, will retry: {q.failed} · Gave up: {q.dead}{q.oldestPendingMinutes !== null ? ` · Oldest waiting: ${q.oldestPendingMinutes} min` : ""}</p>
        <p className="mt-1 text-xs text-muted">If email is not configured in this environment, messages wait here; offers are never lost.</p>
      </section>
    </div>
  );
}
