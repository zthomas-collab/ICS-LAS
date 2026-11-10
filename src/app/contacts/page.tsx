import type { Metadata } from "next";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  DEFAULT_RADIUS_MILES,
  RADIUS_OPTIONS_MILES,
  listServiceTypes,
  searchContacts,
  type ContactsSearch,
} from "@/server/modules/directory";
import { telHref } from "@/lib/domain";
import { ServiceBadge, ServiceSwatch } from "@/components/service-forms";
import { SyntheticBadge, Timestamp } from "@/components/status";

export const metadata: Metadata = {
  title: "Contacts",
  description: "Verified disaster-recovery organizations near you and how to reach them.",
};
export const dynamic = "force-dynamic";

type SP = { q?: string; service?: string; zip?: string; radius?: string };

export default async function ContactsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const form = {
    q: (sp.q ?? "").slice(0, 80),
    service: sp.service ?? "",
    zip: (sp.zip ?? "").trim().slice(0, 5),
    radius: sp.radius ?? String(DEFAULT_RADIUS_MILES),
  };
  const db = await getDriver();
  const serviceTypes = await listServiceTypes(db);
  let result: ContactsSearch | null = null;
  let error: string | null = null;
  try {
    result = await searchContacts(db, form);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    error = err.message;
  }
  const typeOf = (code: string) => serviceTypes.find((t) => t.code === code);
  const entries = result?.entries ?? [];
  const filtering = Boolean(form.q || form.service || form.zip);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-2xl font-bold">Contacts</h1>
      <p className="mt-1 text-muted">
        Organizations verified by platform administrators, and how to reach them. No sign-in needed. Each organization
        chooses whether to be listed and which contact details are public.
      </p>

      <form method="get" role="search" className="card mt-4 grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_0.6fr_0.7fr_auto] lg:items-end">
        <label className="field">
          <span>Name, description or service</span>
          <input name="q" defaultValue={form.q} className="input" maxLength={80} placeholder="e.g. clinic, case management" />
        </label>
        <label className="field">
          <span>Type</span>
          <select name="service" defaultValue={form.service} className="input">
            <option value="">All types</option>
            {serviceTypes.map((t) => (
              <option key={t.code} value={t.code}>{t.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>ZIP code</span>
          <input name="zip" defaultValue={form.zip} className="input" inputMode="numeric" pattern="[0-9]{5}" maxLength={5} placeholder="28801" autoComplete="postal-code" />
        </label>
        <label className="field">
          <span>Within</span>
          <select name="radius" defaultValue={form.radius} className="input" aria-describedby="radius-hint">
            {RADIUS_OPTIONS_MILES.map((r) => (
              <option key={r} value={r}>{r} miles</option>
            ))}
          </select>
        </label>
        <div className="flex gap-2 sm:col-span-2 lg:col-span-1">
          <button className="btn btn-primary flex-1" type="submit">Search</button>
          {filtering && <a className="btn btn-secondary" href="/contacts">Clear</a>}
        </div>
        <small id="radius-hint" className="text-muted sm:col-span-2 lg:col-span-5">
          The distance applies when you enter a ZIP code. It is measured to the organization&apos;s nearest public location or office ZIP.
        </small>
      </form>

      {error && <p role="alert" className="mt-4 rounded-md bg-bad-bg p-3 text-sm text-bad">{error}</p>}
      {result?.zipResolution === "site_centroid" && (
        <p className="mt-4 rounded-md bg-warn-bg p-3 text-sm text-warn">
          ZIP {result.zip} isn&apos;t in our ZIP reference data yet, so its center is estimated from listed locations. Distances are approximate.
        </p>
      )}
      {result?.zipResolution === "unknown" && (
        <p className="mt-4 rounded-md bg-warn-bg p-3 text-sm text-warn">
          We couldn&apos;t locate ZIP {result.zip}, so the radius can&apos;t be applied. Showing organizations listed in exactly that ZIP.
        </p>
      )}

      <p className="mt-4 text-sm text-muted" aria-live="polite">
        {entries.length} organization{entries.length === 1 ? "" : "s"}
        {result?.zip && result.zipResolution !== "unknown" ? ` within ${result.radiusMiles} miles of ${result.zip}` : ""}
        {result?.zip && result.zipResolution === "unknown" ? ` in ${result.zip}` : ""}
        {form.q ? ` matching “${form.q}”` : ""}
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
                {e.distanceMiles !== null && (
                  <span className="badge tone-muted text-sm">{e.distanceMiles < 0.1 ? "< 0.1" : e.distanceMiles} mi</span>
                )}
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
                {e.publicPostalCode && <span>Office ZIP {e.publicPostalCode}</span>}
                <Timestamp value={e.approvedAt} prefix="Verified" />
                <Timestamp value={e.updatedAt} prefix="Profile updated" />
              </div>
            </li>
          );
        })}
        {!error && entries.length === 0 && (
          <li className="text-sm text-muted">
            No organizations found.{form.zip ? " Try a larger radius or another ZIP code." : " Try another type or a shorter search."}
          </li>
        )}
      </ul>
      <p className="mt-6 text-xs text-muted">
        Listings are provided by the organizations. Hiraeth Ventures verifies that each organization exists but does not
        guarantee services. In an emergency, call 911.
      </p>
    </div>
  );
}
