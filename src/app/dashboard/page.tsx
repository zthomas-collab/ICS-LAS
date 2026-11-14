import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDriver } from "@/server/db";
import { listMyOrganizations } from "@/server/modules/organizations";
import { listOrgSites } from "@/server/modules/sites";
import { requireUser } from "@/server/session";
import { ORG_TYPE_LABELS, type OrgType } from "@/lib/domain";
import { SyntheticBadge, Timestamp, VisibilityBadge } from "@/components/status";
import { ServiceBadge } from "@/components/service-forms";
import { listServiceTypes } from "@/server/modules/directory";

export const metadata: Metadata = { title: "Organization dashboard", robots: { index: false } };
export const dynamic = "force-dynamic";

const STATUS_TEXT: Record<string, string> = {
  PENDING_EMAIL: "Waiting for email confirmation.",
  PENDING_VERIFICATION: "Submitted for verification. A platform administrator will review your organization (target 48 hours).",
  APPROVED: "Verified. Editors can publish and update sites immediately.",
  REJECTED: "Verification was not approved. Contact the platform team if you believe this is an error.",
  SUSPENDED: "Suspended. Listings are unpublished and editing is disabled.",
};

export default async function DashboardPage() {
  const user = await requireUser();
  const db = await getDriver();
  const [orgs, serviceTypes] = await Promise.all([listMyOrganizations(db, user.id), listServiceTypes(db)]);
  if (orgs.length === 0 && !user.countyAdmin && user.platformRoles.length === 0) redirect("/assistance");
  const sitesByOrg = await Promise.all(orgs.map((o) => (o.status === "APPROVED" ? listOrgSites(db, user.id, o.id) : Promise.resolve([]))));

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <p className="text-sm text-muted">Signed in as {user.displayName} ({user.email})</p>
      {user.platformRoles.length > 0 && (
        <p className="mt-1 text-sm">Platform roles: {user.platformRoles.join(", ")}</p>
      )}
      {orgs.length === 0 && (
        <div className="card mt-5 p-4">
          <p>You are not a member of any organization.</p>
          <Link className="btn btn-primary mt-3" href="/signin?tab=register">Register an organization</Link>
        </div>
      )}
      {orgs.map((o, i) => {
        const canEdit = o.status === "APPROVED" && !o.publicationSuspended && (o.role === "ORG_ADMIN" || o.role === "EDITOR");
        const sites = sitesByOrg[i];
        return (
          <section key={o.id} className="card mt-5 p-4" aria-labelledby={`org-${o.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={`org-${o.id}`} className="text-xl font-semibold">{o.displayName}</h2>
              <span className="badge tone-muted">{ORG_TYPE_LABELS[o.orgType as OrgType] ?? o.orgType}</span>
              <span className={`badge ${o.status === "APPROVED" ? "tone-ok" : o.status === "PENDING_VERIFICATION" ? "tone-warn" : "tone-bad"}`}>{o.status.replace("_", " ")}</span>
              <span className="badge tone-muted">Your role: {o.role.replace("_", " ")}</span>
              <SyntheticBadge show={o.isSynthetic} />
              {serviceTypes.find((t) => t.code === o.primaryServiceType) && (
                <ServiceBadge type={serviceTypes.find((t) => t.code === o.primaryServiceType)!} />
              )}
              {o.role === "ORG_ADMIN" && o.membershipStatus === "ACTIVE" && (
                <Link className="ml-auto text-sm text-brand underline" href={`/dashboard/orgs/${o.id}/profile`}>Organization profile &amp; public contact listing</Link>
              )}
            </div>
            <p className="mt-2 text-sm text-muted">{STATUS_TEXT[o.status]}</p>
            {o.status === "APPROVED" && (
              <>
                <div className="mt-4 flex items-center justify-between gap-2">
                  <h3 className="font-semibold">Staging sites ({sites.length})</h3>
                  {canEdit && <Link className="btn btn-primary" href={`/dashboard/orgs/${o.id}/sites/new`}>New site</Link>}
                </div>
                <ul className="mt-2 divide-y divide-line">
                  {sites.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-2 py-3">
                      <Link href={`/dashboard/sites/${s.id}`} className="font-medium text-brand underline">{s.name}</Link>
                      <VisibilityBadge visibility={s.visibility} />
                      {s.status === "ARCHIVED" && <span className="badge tone-muted">Archived</span>}
                      <SyntheticBadge show={s.isSynthetic} />
                      <span className="text-sm text-muted">{[s.city, s.state].filter(Boolean).join(", ")} · {s.resourceCount} resources</span>
                      <span className="ml-auto"><Timestamp value={s.lastConfirmedAt} prefix="Confirmed" /></span>
                    </li>
                  ))}
                  {sites.length === 0 && <li className="py-3 text-sm text-muted">No sites yet.</li>}
                </ul>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
