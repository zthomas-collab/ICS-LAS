import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Administration", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * Admin landing. The links shown are a convenience only: each destination re-checks authorization
 * on the server and returns 404 to anyone who is not entitled to it.
 */
export default async function AdminHome() {
  const user = await requireUser();
  const executive = user.platformRoles.includes("PLATFORM_ADMIN");
  if (!executive && !user.countyAdmin) notFound();
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-bold">Administration</h1>
      <p className="text-sm text-muted">{executive ? "Executive administrator: all counties." : "County administrator: your assigned counties only."}</p>
      <ul className="mt-5 grid gap-3 sm:grid-cols-2">
        {executive && (
          <li className="card p-4">
            <Link className="text-lg font-semibold text-brand underline" href="/admin/organizations">Organization approvals</Link>
            <p className="mt-1 text-sm text-muted">Verify, suspend and reinstate organizations (SOP-001, SOP-012).</p>
          </li>
        )}
        <li className="card p-4">
          <Link className="text-lg font-semibold text-brand underline" href="/admin/applications">Assistance requests</Link>
          <p className="mt-1 text-sm text-muted">Review, route and update requests for your counties.</p>
        </li>
        <li className="card p-4">
          <Link className="text-lg font-semibold text-brand underline" href="/admin/offers">Volunteer &amp; donation offers</Link>
          <p className="mt-1 text-sm text-muted">Review, match and track offers of help for your counties.</p>
        </li>
        {executive && (
          <li className="card p-4">
            <Link className="text-lg font-semibold text-brand underline" href="/admin/settings">Settings</Link>
            <p className="mt-1 text-sm text-muted">Notification email for new offers and the email delivery queue.</p>
          </li>
        )}
        <li className="card p-4">
          <Link className="text-lg font-semibold text-brand underline" href="/admin/profiles">Organization profiles</Link>
          <p className="mt-1 text-sm text-muted">Approve or hide public profiles, logos and links.</p>
        </li>
        <li className="card p-4">
          <Link className="text-lg font-semibold text-brand underline" href="/admin/counties">Counties and administrators</Link>
          <p className="mt-1 text-sm text-muted">{executive ? "Add counties and assign county administrators." : "See who administers your counties."}</p>
        </li>
      </ul>
    </div>
  );
}
