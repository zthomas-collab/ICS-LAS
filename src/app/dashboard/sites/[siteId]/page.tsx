import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { getSiteDetail, listCategories } from "@/server/modules/sites";
import { requireUser } from "@/server/session";
import { AvailabilityBadge, SyntheticBadge, Timestamp, VisibilityBadge } from "@/components/status";
import { CommandButton, NewResourceForm, ResourceQuickActions, SiteForm } from "@/components/site-forms";
import { createResourceAction, removeSiteImageAction, resourceCommandAction, siteCommandAction, updateSiteAction, uploadSiteImageAction } from "@/app/dashboard/actions";
import { PhotoForm } from "@/components/service-forms";

export const metadata: Metadata = { title: "Staging site", robots: { index: false } };
export const dynamic = "force-dynamic";

const EVENT_LABELS: Record<string, string> = {
  SITE_CREATED: "Site created", SITE_EDITED: "Site edited", SITE_ARCHIVED: "Site archived", SITE_CONFIRMED: "Site confirmed",
  RESOURCE_CREATED: "Resource added", RESOURCE_EDITED: "Resource edited", RESOURCE_ARCHIVED: "Resource archived",
  AVAILABILITY_UPDATED: "Availability updated", AVAILABILITY_CONFIRMED: "Availability confirmed", CORRECTION: "Correction",
};

export default async function SitePage({ params, searchParams }: { params: Promise<{ siteId: string }>; searchParams: Promise<{ created?: string }> }) {
  const { siteId } = await params;
  const { created } = await searchParams;
  const user = await requireUser();
  const db = await getDriver();
  let site;
  try {
    site = await getSiteDetail(db, user.id, siteId);
  } catch (err) {
    if (err instanceof AppError && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) notFound();
    throw err;
  }
  const categories = await listCategories(db);
  const editable = site.canEdit && site.status === "ACTIVE";
  const active = site.resources.filter((r) => r.status === "ACTIVE");

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <Link href="/dashboard" className="text-sm text-brand underline">← Dashboard</Link>
      {created && <p role="status" className="mt-3 rounded-md bg-ok-bg p-3 text-sm text-ok">Site created{site.visibility === "PUBLIC" ? " and published to the public map" : ""}.</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold">{site.name}</h1>
        <VisibilityBadge visibility={site.visibility} />
        {site.status === "ARCHIVED" && <span className="badge tone-muted">Archived</span>}
        <SyntheticBadge show={site.isSynthetic} />
      </div>
      <div className="mt-1 flex flex-wrap gap-3">
        <Timestamp value={site.lastConfirmedAt} prefix="Site last confirmed" />
        <Timestamp value={site.updatedAt} prefix="Updated" />
      </div>
      {!site.canEdit && <p className="mt-3 rounded-md bg-warn-bg p-3 text-sm text-warn">Read-only: your role does not allow editing.</p>}

      <section className="mt-6" aria-labelledby="photo-h">
        <h2 id="photo-h" className="text-xl font-semibold">Location photo</h2>
        <p className="text-sm text-muted">Shown on the map with this site, to the same people who can see the site.</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {site.imageId ? (
            // eslint-disable-next-line @next/next/no-img-element -- authorized image route, not a static asset
            <img src={`/api/sites/${site.id}/image?v=${site.imageId}`} alt={site.imageAlt ?? ""} className="w-full rounded-lg border border-line object-cover" />
          ) : (
            <div className="flex min-h-32 items-center justify-center rounded-lg border border-dashed border-line text-sm text-muted">No photo yet</div>
          )}
          {editable && (
            <div className="card p-4">
              <PhotoForm uploadAction={uploadSiteImageAction.bind(null, site.id)} removeAction={removeSiteImageAction.bind(null, site.id)} hasPhoto={Boolean(site.imageId)} />
            </div>
          )}
        </div>
      </section>

      <section className="mt-6" aria-labelledby="resources-h">
        <h2 id="resources-h" className="text-xl font-semibold">Resources ({active.length})</h2>
        <ul className="mt-3 grid gap-3">
          {active.map((r) => (
            <li key={r.id} className="card p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{r.name}</span>
                <span className="badge tone-muted">{r.categoryLabel}</span>
                <VisibilityBadge visibility={r.visibility} />
                <AvailabilityBadge status={r.availabilityStatus} freshness={r.freshness} />
              </div>
              <div className="mt-1 flex flex-wrap gap-3 text-sm text-muted">
                {r.reportedQuantity !== null && (
                  <span>{r.reportedQuantity} {r.quantityUnit} ({r.quantityBasis === "VERIFIED_COUNT" ? "verified count" : "reported"})</span>
                )}
                <Timestamp value={r.lastConfirmedAt} prefix="Confirmed" />
                <Timestamp value={r.reviewDueAt} prefix="Review due" />
              </div>
              {editable && (
                <div className="mt-3 grid gap-2">
                  <ResourceQuickActions action={resourceCommandAction.bind(null, site.id, r.id)} current={r.availabilityStatus} />
                  <CommandButton action={resourceCommandAction.bind(null, site.id, r.id)} cmd="archive" label="Archive resource"
                    className="btn btn-danger justify-self-start" confirmText="Archive this resource? It will be unpublished; history is kept." />
                </div>
              )}
            </li>
          ))}
          {active.length === 0 && <li className="text-sm text-muted">No active resources.</li>}
        </ul>
        {editable && (
          <div className="card mt-4 p-4">
            <h3 className="mb-3 font-semibold">Add a resource</h3>
            <NewResourceForm action={createResourceAction.bind(null, site.id)} categories={categories} siteVisibility={site.visibility} />
          </div>
        )}
      </section>

      {editable && (
        <section className="mt-8" aria-labelledby="edit-h">
          <h2 id="edit-h" className="text-xl font-semibold">Site details</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <CommandButton action={siteCommandAction.bind(null, site.id)} cmd="confirm" label="Confirm site details are accurate" />
          </div>
          <div className="card mt-3 p-4">
            <SiteForm action={updateSiteAction.bind(null, site.id)} submitLabel="Save site" initial={{
              name: site.name, description: site.description, visibility: site.visibility, lat: site.lat, lng: site.lng,
              addressLine: site.addressLine, city: site.city, county: site.county, state: site.state,
              postalCode: site.postalCode, hoursText: site.hoursText, publicPhone: site.publicPhone,
            }} />
          </div>
          <div className="mt-4">
            <CommandButton action={siteCommandAction.bind(null, site.id)} cmd="archive" label="Archive site" className="btn btn-danger"
              confirmText="Archive this site? It will be removed from every map immediately. History is preserved." />
          </div>
        </section>
      )}

      <section className="mt-8" aria-labelledby="history-h">
        <h2 id="history-h" className="text-xl font-semibold">Recent changes</h2>
        <p className="text-sm text-muted">Append-only history for this site (latest 25).</p>
        <ol className="mt-2 divide-y divide-line">
          {site.events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-2 py-2 text-sm">
              <span className="font-medium">{EVENT_LABELS[e.eventType] ?? e.eventType}</span>
              {e.resourceName && <span className="text-muted">· {e.resourceName}</span>}
              {e.note && <span className="text-muted">· “{e.note}”</span>}
              <span className="ml-auto"><Timestamp value={e.createdAt} prefix="At" /></span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
