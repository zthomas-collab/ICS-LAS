import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { listManageableCounties } from "@/server/modules/counties";
import { OFFER_STATUSES, OFFER_STATUS_LABELS, OFFER_TYPES, OFFER_TYPE_LABELS, listOffers } from "@/server/modules/offers";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Volunteer & donation offers", robots: { index: false } };
export const dynamic = "force-dynamic";

type Search = { status?: string; type?: string; countyId?: string; page?: string };
const fmt = (d: Date) => d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

export default async function OffersQueue({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const db = await getDriver();
  let r;
  try {
    r = await listOffers(db, user.id, sp);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") notFound();
    if (err instanceof AppError && err.code === "VALIDATION") return <p className="mx-auto max-w-3xl px-4 py-6">Check the filters and try again.</p>;
    throw err;
  }
  const counties = await listManageableCounties(db, user.id);
  const q = (over: Record<string, string>) => new URLSearchParams(Object.entries({ ...sp, ...over }).filter(([, v]) => v) as [string, string][]).toString();
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-3xl">Volunteer &amp; donation offers</h1>
      <ul className="mt-3 flex flex-wrap gap-2 text-sm" aria-label="Counts by status">
        {OFFER_STATUSES.map((s) => <li key={s} className="badge tone-muted">{OFFER_STATUS_LABELS[s]}: {r.counts[s] ?? 0}</li>)}
        {r.unassigned > 0 && <li className="badge tone-warn">Needs a county: {r.unassigned}</li>}
      </ul>
      <form method="get" className="card mt-4 grid gap-3 p-4 sm:grid-cols-4">
        <label className="field"><span>Status</span>
          <select className="input" name="status" defaultValue={sp.status ?? ""}><option value="">Any</option>
            {OFFER_STATUSES.map((s) => <option key={s} value={s}>{OFFER_STATUS_LABELS[s]}</option>)}</select></label>
        <label className="field"><span>Type</span>
          <select className="input" name="type" defaultValue={sp.type ?? ""}><option value="">Any</option>
            {OFFER_TYPES.map((t) => <option key={t} value={t}>{OFFER_TYPE_LABELS[t]}</option>)}</select></label>
        <label className="field"><span>County</span>
          <select className="input" name="countyId" defaultValue={sp.countyId ?? ""}><option value="">Any</option>
            {counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}</select></label>
        <div className="flex items-end"><button className="btn btn-primary w-full" type="submit">Filter</button></div>
      </form>
      <section className="card mt-4 p-4" aria-label="Offers">
        {r.rows.length === 0 ? <p className="text-sm text-muted">No offers match.</p> : (
          <ul className="divide-y divide-line">
            {r.rows.map((o) => (
              <li key={o.id} className="py-3">
                <Link className="font-semibold text-brand underline" href={`/admin/offers/${o.id}`}>{o.reference}</Link>{" "}
                <span className="badge tone-brand">{OFFER_STATUS_LABELS[o.status]}</span>
                <div className="mt-1 text-sm">
                  {OFFER_TYPE_LABELS[o.contributionType]}{o.quantity !== null ? ` · ${o.quantity}${o.unit ? ` ${o.unit}` : ""}` : ""} ·{" "}
                  {o.countyName ? `${o.countyName} County` : "county not set"} · {o.zip}
                </div>
                <time className="text-xs text-muted" dateTime={o.createdAt.toISOString()}>Received {fmt(o.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
        <nav className="mt-3 flex justify-between text-sm" aria-label="Pages">
          {r.page > 1 ? <Link className="underline" href={`?${q({ page: String(r.page - 1) })}`}>← Newer</Link> : <span />}
          {r.hasMore && <Link className="underline" href={`?${q({ page: String(r.page + 1) })}`}>Older →</Link>}
        </nav>
      </section>
    </div>
  );
}
