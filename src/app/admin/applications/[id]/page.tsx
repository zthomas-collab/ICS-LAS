import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoteForm, TransitionForm } from "@/components/assistance-forms";
import { ApplicationStatusBadge, Timeline } from "@/components/assistance-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { STATUS_LABELS, getApplicationForStaff } from "@/server/modules/assistance";
import { requireUser } from "@/server/session";
import { noteAction, transitionAction } from "../../../assistance/actions";

export const metadata: Metadata = { title: "Assistance request (staff)", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function StaffApplication({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let a;
  try {
    a = await getApplicationForStaff(await getDriver(), user.id, id);
  } catch (err) {
    // Not found, not authorized and MFA-not-enrolled all look the same from outside, except MFA which tells staff what to do.
    if (err instanceof AppError && err.code === "FORBIDDEN" && /Multi-factor/.test(err.message)) {
      return (
        <div className="mx-auto max-w-2xl px-4 py-8">
          <h1 className="text-2xl">Set up multi-factor authentication first</h1>
          <p className="mt-2">{err.message} <Link className="underline" href="/account/security?required=1">Set it up now</Link>.</p>
        </div>
      );
    }
    if (err instanceof AppError && (err.code === "NOT_FOUND" || err.code === "FORBIDDEN")) notFound();
    throw err;
  }
  const isAdmin = a.capacity === "admin";
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/admin/applications">← All requests</Link></p>
      <h1 className="mt-2 text-3xl">{a.summary}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <ApplicationStatusBadge status={a.status} closureReason={a.closureReason} />
        <span>{a.categoryLabel}</span>
        <span className="text-muted">{a.countyName} County · {a.zip}</span>
        {a.referredOrgName && <span>Referred to <strong>{a.referredOrgName}</strong></span>}
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-5">
          <section className="card p-4" aria-labelledby="applicant">
            <h2 id="applicant" className="text-xl">Applicant</h2>
            <dl className="mt-2 grid gap-1 text-sm">
              <div><dt className="inline font-semibold">Name: </dt><dd className="inline">{a.applicantName}</dd></div>
              <div><dt className="inline font-semibold">Email: </dt><dd className="inline">{a.applicantEmail}</dd></div>
              {a.contactPhone && <div><dt className="inline font-semibold">Phone: </dt><dd className="inline">{a.contactPhone}</dd></div>}
              <div><dt className="inline font-semibold">Prefers: </dt><dd className="inline">{a.preferredContact === "PHONE" ? "Phone" : "Email"}</dd></div>
              {a.householdSize && <div><dt className="inline font-semibold">Household: </dt><dd className="inline">{a.householdSize}</dd></div>}
              <div><dt className="inline font-semibold">May share with providers: </dt><dd className="inline">{a.consentShareProviders ? "Yes" : "No"}</dd></div>
            </dl>
            <h3 className="mt-4 text-base font-semibold">Situation</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm">{a.situation}</p>
          </section>
          <section className="card p-4" aria-labelledby="files">
            <h2 id="files" className="text-xl">Documents</h2>
            {a.documents.length === 0 ? <p className="mt-2 text-sm text-muted">None.</p> : (
              <ul className="mt-2 list-disc pl-5 text-sm">
                {a.documents.map((d) => (
                  <li key={d.id}><a className="underline" href={`/api/assistance/documents/${d.id}`}>{d.displayName}</a> <span className="text-xs text-muted">{d.scanStatus.toLowerCase()}</span></li>
                ))}
              </ul>
            )}
          </section>
          <section className="card p-4" aria-labelledby="history">
            <h2 id="history" className="text-xl">History</h2>
            <div className="mt-3"><Timeline events={a.events} /></div>
          </section>
        </div>
        <aside className="grid content-start gap-5">
          <section className="card p-4" aria-labelledby="move">
            <h2 id="move" className="text-xl">Update status</h2>
            <div className="mt-3">
              <TransitionForm action={transitionAction} applicationId={a.id} options={a.allowedNext}
                suggestedOrgId={isAdmin ? a.suggestedOrgId : null} labels={STATUS_LABELS} />
            </div>
          </section>
          <section className="card p-4" aria-labelledby="note">
            <h2 id="note" className="text-xl">Add a note</h2>
            <div className="mt-3"><NoteForm action={noteAction} applicationId={a.id} /></div>
          </section>
        </aside>
      </div>
    </div>
  );
}
