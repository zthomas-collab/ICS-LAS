import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { listProfilesForReview } from "@/server/modules/directory";
import { SOCIAL_KINDS, SOCIAL_LABELS } from "@/lib/links";
import { requireUser } from "@/server/session";
import { ProfileReviewForm } from "@/components/service-forms";
import { reviewProfileAction } from "@/app/dashboard/actions";

export const metadata: Metadata = { title: "Organization profiles", robots: { index: false } };
export const dynamic = "force-dynamic";

const TONE: Record<string, string> = { APPROVED: "tone-ok", PENDING: "tone-warn", HIDDEN: "tone-bad" };

export default async function AdminProfilesPage() {
  const user = await requireUser();
  let rows;
  try {
    rows = await listProfilesForReview(await getDriver(), user.id);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") notFound();
    throw err;
  }
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <Link href="/admin" className="text-sm text-brand underline">← Administration</Link>
      <h1 className="mt-2 text-2xl font-bold">Organization profiles</h1>
      <p className="text-sm text-muted">
        A profile is public only when the organization is approved, has opted in, and its profile is approved here.
        County administrators see organizations that serve their counties.
      </p>
      <ul className="mt-5 grid gap-4">
        {rows.map((o) => (
          <li key={o.id} className="card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{o.displayName}</h2>
              <span className={`badge ${TONE[o.profileStatus] ?? "tone-muted"}`}>{o.profileStatus}</span>
              {!o.consented && <span className="badge tone-muted">Private (no public opt-in)</span>}
              {o.status !== "APPROVED" && <span className="badge tone-bad">{o.status}</span>}
            </div>
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted">Website</dt><dd className="break-all">{o.website ?? "—"}</dd>
              <dt className="text-muted">Links</dt>
              <dd className="break-all">
                {SOCIAL_KINDS.filter((k) => o.socialLinks[k]).map((k) => `${SOCIAL_LABELS[k]}: ${o.socialLinks[k]}`).join(" · ") || "—"}
              </dd>
              <dt className="text-muted">Logo</dt><dd>{o.hasLogo ? "Uploaded" : "—"}</dd>
              <dt className="text-muted">Counties served</dt><dd>{o.countiesServed.join("; ") || "—"}</dd>
            </dl>
            <div className="mt-3"><ProfileReviewForm action={reviewProfileAction} orgId={o.id} current={o.profileStatus} /></div>
          </li>
        ))}
        {rows.length === 0 && <li className="text-sm text-muted">No profiles to review.</li>}
      </ul>
    </div>
  );
}
