import type { Metadata } from "next";
import { getDriver } from "@/server/db";
import { listBlackBook, listServiceTypes } from "@/server/modules/directory";
import { telHref } from "@/lib/domain";
import { ServiceBadge, ServiceSwatch } from "@/components/service-forms";
import { SyntheticBadge, Timestamp } from "@/components/status";

export const metadata: Metadata = {
  title: "Black Book — organization contacts",
  description: "Verified disaster-recovery organizations and how to reach them.",
};
export const dynamic = "force-dynamic";

export default async function BlackBookPage({ searchParams }: { searchParams: Promise<{ q?: string; service?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 80);
  const service = /^[A-Z_]{2,40}$/.test(sp.service ?? "") ? sp.service : "";
  const db = await getDriver();
  const [entries, serviceTypes] = await Promise.all([listBlackBook(db, { q, service }), listServiceTypes(db)]);
  const typeOf = (code: string) => serviceTypes.find((t) => t.code === code);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-2xl font-bold">Black Book</h1>
      <p className="mt-1 text-muted">
        Contact details for organizations verified by platform administrators. No sign-in needed. Organizations choose
        whether to be listed and which contact details are public.
      </p>

      <form method="get" role="search" className="card mt-4 grid gap-3 p-3 sm:grid-cols-[1fr_16rem_auto] sm:items-end">
        <label className="field">
          <span>Search by name or description</span>
          <input name="q" defaultValue={q} className="input" maxLength={80} placeholder="e.g. pantry, clinic" />
        </label>
        <label className="field">
          <span>Service type</span>
          <select name="service" defaultValue={service} className="input">
            <option value="">All services</option>
            {serviceTypes.map((t) => (
              <option key={t.code} value={t.code}>{t.label}</option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary" type="submit">Search</button>
      </form>

      <p className="mt-4 text-sm text-muted" aria-live="polite">
        {entries.length} organization{entries.length === 1 ? "" : "s"}
        {q || service ? " match your search" : ""}
      </p>

      <ul className="mt-2 grid gap-3">
        {entries.map((e) => {
          const primary = { label: e.serviceLabel, shortLabel: e.serviceShort, color: e.serviceColor };
          return (
            <li key={e.id} className="card p-4">
              <div className="flex flex-wrap items-start gap-3">
                <ServiceSwatch type={primary} />
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold">{e.displayName}</h2>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <span className="badge tone-ok">Verified organization</span>
                    <SyntheticBadge show={e.isSynthetic} />
                  </div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <ServiceBadge type={primary} />
                {e.additionalServiceTypes.map((c) => typeOf(c) && <ServiceBadge key={c} type={typeOf(c)!} />)}
              </div>
              {e.description && <p className="mt-2 text-sm">{e.description}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {e.publicPhone && <a className="btn btn-primary" href={telHref(e.publicPhone)}>Call {e.publicPhone}</a>}
                {e.publicEmail && <a className="btn btn-secondary" href={`mailto:${e.publicEmail}`}>Email</a>}
                {e.website && (
                  <a className="btn btn-secondary" href={e.website} target="_blank" rel="noopener noreferrer nofollow">Website</a>
                )}
                {!e.publicPhone && !e.publicEmail && !e.website && <span className="text-sm text-muted">No public contact details provided.</span>}
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted">
                <span>{e.publicSiteCount} public location{e.publicSiteCount === 1 ? "" : "s"} on the map</span>
                <Timestamp value={e.approvedAt} prefix="Verified" />
                <Timestamp value={e.updatedAt} prefix="Profile updated" />
              </div>
            </li>
          );
        })}
        {entries.length === 0 && (
          <li className="text-sm text-muted">No organizations found. Try another service type or a shorter search.</li>
        )}
      </ul>
      <p className="mt-6 text-xs text-muted">
        Listings are provided by the organizations. Hiraeth Ventures verifies that each organization exists but does not
        guarantee services. In an emergency, call 911.
      </p>
    </div>
  );
}
