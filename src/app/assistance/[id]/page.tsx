import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ProvideInfoForm, RemoveDocumentForm, UploadForm, WithdrawForm } from "@/components/assistance-forms";
import { ApplicationStatusBadge, NotReady, Timeline } from "@/components/assistance-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { MAX_DOCUMENTS_PER_APPLICATION } from "@/server/documents";
import { assistanceReadiness, documentsAvailable, getMyApplication } from "@/server/modules/assistance";
import { getCurrentUser } from "@/server/session";
import { provideInfoAction, removeDocumentAction, uploadDocumentAction, withdrawAction } from "../actions";

export const metadata: Metadata = { title: "Assistance request", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  if (!assistanceReadiness().ready) return <NotReady />;
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/signup");
  let a;
  try {
    a = await getMyApplication(await getDriver(), user.id, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const open = a.status !== "COMPLETED" && a.status !== "CLOSED";
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/assistance">← My requests</Link></p>
      <h1 className="mt-2 text-3xl">{a.summary}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <ApplicationStatusBadge status={a.status} closureReason={a.closureReason} />
        <span>{a.categoryLabel}</span>
        <span className="text-muted">{a.countyName} County · {a.zip}</span>
      </div>
      {a.referredOrgName && <p className="mt-3 text-sm">Referred to <strong>{a.referredOrgName}</strong>.</p>}

      {a.status === "INFO_REQUIRED" && (
        <section className="card mt-5 border-2 border-gold p-4" aria-labelledby="reply">
          <h2 id="reply" className="text-xl">We need more information</h2>
          <p className="mt-1 text-sm text-muted">Read the latest message below, then reply here.</p>
          <div className="mt-3"><ProvideInfoForm action={provideInfoAction} applicationId={a.id} /></div>
        </section>
      )}

      <section className="card mt-5 p-4" aria-labelledby="history">
        <h2 id="history" className="text-xl">Progress</h2>
        <div className="mt-3"><Timeline events={a.events} /></div>
      </section>

      <section className="card mt-5 p-4" aria-labelledby="details">
        <h2 id="details" className="text-xl">What you told us</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm">{a.situation}</p>
        <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
          {a.householdSize && <div><dt className="inline font-semibold">Household: </dt><dd className="inline">{a.householdSize}</dd></div>}
          {a.contactPhone && <div><dt className="inline font-semibold">Phone: </dt><dd className="inline">{a.contactPhone}</dd></div>}
          <div><dt className="inline font-semibold">Preferred contact: </dt><dd className="inline">{a.preferredContact === "PHONE" ? "Phone" : "Email"}</dd></div>
          <div><dt className="inline font-semibold">Share with a provider: </dt><dd className="inline">{a.consentShareProviders ? "Yes, if approved" : "No"}</dd></div>
        </dl>
      </section>

      <section className="card mt-5 p-4" aria-labelledby="docs">
        <h2 id="docs" className="text-xl">Documents</h2>
        {a.documents.length === 0 ? <p className="mt-2 text-sm text-muted">No files added.</p> : (
          <ul className="mt-2 divide-y divide-line">
            {a.documents.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <a className="underline" href={`/api/assistance/documents/${d.id}`}>{d.displayName}</a>{" "}
                  <span className="text-xs text-muted">{d.scanStatus === "CLEAN" ? "checked" : d.scanStatus === "NOT_SCANNED" ? "not scanned (test mode)" : d.scanStatus.toLowerCase()}</span>
                </span>
                {open && <RemoveDocumentForm action={removeDocumentAction} applicationId={a.id} documentId={d.id} />}
              </li>
            ))}
          </ul>
        )}
        {open && (documentsAvailable() ? (
          a.documents.length < MAX_DOCUMENTS_PER_APPLICATION ? <div className="mt-4"><UploadForm action={uploadDocumentAction} applicationId={a.id} /></div>
            : <p className="mt-3 text-sm text-muted">You have reached the file limit.</p>
        ) : (
          <p className="mt-3 rounded-md bg-neutral-bg p-3 text-sm">File uploads are temporarily unavailable. You can continue without them and add files later.</p>
        ))}
      </section>

      {open && (
        <section className="card mt-5 p-4" aria-labelledby="withdraw">
          <h2 id="withdraw" className="text-xl">Withdraw this request</h2>
          <p className="mt-1 text-sm text-muted">Withdrawing closes your request. You can submit a new one later.</p>
          <div className="mt-3"><WithdrawForm action={withdrawAction} applicationId={a.id} /></div>
        </section>
      )}
    </div>
  );
}
