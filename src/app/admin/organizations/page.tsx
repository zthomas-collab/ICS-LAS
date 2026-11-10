import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { listOrganizationsForReview, privilegedMfaRequired } from "@/server/modules/organizations";
import { requireUser } from "@/server/session";
import { ORG_TYPE_LABELS, type OrgType } from "@/lib/domain";
import { Timestamp } from "@/components/status";
import { DecisionForm } from "@/components/admin-forms";
import { decideOrganizationAction, setServiceTypeAction } from "@/app/dashboard/actions";
import { listServiceTypes } from "@/server/modules/directory";
import { ServiceBadge, ServiceTypeChangeForm } from "@/components/service-forms";

export const metadata: Metadata = { title: "Organizations awaiting approval", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function AdminOrganizationsPage() {
  const user = await requireUser();
  let orgs;
  const db = await getDriver();
  const serviceTypes = await listServiceTypes(db);
  const typeOf = (code: string | null) => serviceTypes.find((t) => t.code === code);
  try {
    orgs = await listOrganizationsForReview(db, user.id);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") notFound();
    throw err;
  }
  const pending = orgs.filter((o) => o.status === "PENDING_VERIFICATION");
  const others = orgs.filter((o) => o.status !== "PENDING_VERIFICATION");
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <h1 className="text-2xl font-bold">Organizations awaiting approval</h1>
      <p className="text-sm text-muted">SOP-001 Organization Verification. Every decision requires an evidence summary and is audited.</p>
      {!privilegedMfaRequired() && (
        <p className="mt-3 rounded-md bg-warn-bg p-3 text-sm text-warn">
          MFA enforcement for privileged roles is OFF (development). It is mandatory in production.
        </p>
      )}
      <ul className="mt-5 grid gap-4">
        {pending.map((o) => (
          <li key={o.id} className="card p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{o.displayName}</h2>
              <span className="badge tone-muted">{ORG_TYPE_LABELS[o.orgType as OrgType] ?? o.orgType}</span>
              {o.sopDueAt && o.sopDueAt < new Date() && <span className="badge tone-bad">Overdue</span>}
            </div>
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-muted">Legal name</dt><dd>{o.legalName}</dd>
              <dt className="text-muted">Contact email</dt><dd>{o.contactEmail}</dd>
              <dt className="text-muted">Website</dt><dd>{o.website ?? "—"}</dd>
              <dt className="text-muted">Public phone</dt><dd>{o.publicPhone ?? "—"}</dd>
              <dt className="text-muted">Requested type</dt>
              <dd>{typeOf(o.requestedServiceType) ? <ServiceBadge type={typeOf(o.requestedServiceType)!} /> : "—"}</dd>
              <dt className="text-muted">Also offers</dt>
              <dd className="flex flex-wrap gap-1">
                {o.offeredServiceTypes.filter((c) => c !== o.requestedServiceType).map((c) => typeOf(c) && <ServiceBadge key={c} type={typeOf(c)!} />)}
                {o.offeredServiceTypes.length <= 1 && "—"}
              </dd>
              <dt className="text-muted">Verification notes</dt><dd className="whitespace-pre-wrap">{o.registrationNotes}</dd>
              <dt className="text-muted">Registered</dt><dd><Timestamp value={o.createdAt} prefix="On" /></dd>
              <dt className="text-muted">SOP due</dt><dd><Timestamp value={o.sopDueAt} prefix="By" /></dd>
            </dl>
            <div className="mt-3">
              <DecisionForm action={decideOrganizationAction} orgId={o.id} decisions={["APPROVED", "REJECTED"]}
                serviceTypes={serviceTypes} defaultServiceType={o.requestedServiceType} />
            </div>
          </li>
        ))}
        {pending.length === 0 && <li className="text-muted">No organizations are waiting for verification.</li>}
      </ul>
      <h2 className="mt-8 text-xl font-semibold">Approved and suspended</h2>
      <ul className="mt-3 divide-y divide-line">
        {others.map((o) => (
          <li key={o.id} className="grid gap-2 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{o.displayName}</span>
              <span className={`badge ${o.status === "APPROVED" ? "tone-ok" : "tone-bad"}`}>{o.status}</span>
              {typeOf(o.primaryServiceType) && <ServiceBadge type={typeOf(o.primaryServiceType)!} />}
            </div>
            <ServiceTypeChangeForm action={setServiceTypeAction} orgId={o.id} serviceTypes={serviceTypes} current={o.primaryServiceType} />
            <DecisionForm action={decideOrganizationAction} orgId={o.id} decisions={o.status === "APPROVED" ? ["SUSPENDED"] : ["REINSTATED"]} compact />
          </li>
        ))}
      </ul>
    </div>
  );
}
