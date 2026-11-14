import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AssignCountyForm, OfferNoteForm, OfferTransitionForm } from "@/components/offer-forms";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { listCounties } from "@/server/modules/counties";
import { OFFER_STATUS_LABELS, OFFER_TYPE_LABELS, getOffer } from "@/server/modules/offers";
import { requireUser } from "@/server/session";
import { assignCountyAction, offerNoteAction, offerTransitionAction } from "../../../volunteer/actions";

export const metadata: Metadata = { title: "Offer", robots: { index: false } };
export const dynamic = "force-dynamic";
const fmt = (d: Date) => d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

export default async function OfferPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const db = await getDriver();
  let o;
  try {
    o = await getOffer(db, user.id, id);
  } catch (err) {
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
  const counties = o.canAssignCounty ? await listCounties(db) : [];
  const labels = Object.fromEntries(Object.entries(OFFER_STATUS_LABELS));
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <p className="text-sm"><Link className="underline" href="/admin/offers">← All offers</Link></p>
      <h1 className="mt-2 text-3xl"><span className="font-mono">{o.reference}</span></h1>
      <p className="mt-1"><span className="badge tone-brand">{OFFER_STATUS_LABELS[o.status]}</span> {OFFER_TYPE_LABELS[o.contributionType]}</p>
      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-5">
          <section className="card p-4" aria-labelledby="offer">
            <h2 id="offer" className="text-xl">Offer</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm">{o.description}</p>
            <dl className="mt-3 grid gap-1 text-sm">
              {o.quantity !== null && <div><dt className="inline font-semibold">Quantity: </dt><dd className="inline">{o.quantity}{o.unit ? ` ${o.unit}` : ""}</dd></div>}
              <div><dt className="inline font-semibold">Location: </dt><dd className="inline">{o.countyName ? `${o.countyName} County` : "county not set"}, {o.zip}</dd></div>
              {(o.availableFrom || o.availableUntil) && <div><dt className="inline font-semibold">Available: </dt><dd className="inline">{o.availableFrom ?? "now"} to {o.availableUntil ?? "open-ended"}</dd></div>}
              {o.deliveryNotes && <div><dt className="inline font-semibold">Pickup/delivery: </dt><dd className="inline">{o.deliveryNotes}</dd></div>}
              {o.preferredProject && <div><dt className="inline font-semibold">Preferred project: </dt><dd className="inline">{o.preferredProject}</dd></div>}
            </dl>
          </section>
          <section className="card p-4" aria-labelledby="who">
            <h2 id="who" className="text-xl">Contributor</h2>
            <dl className="mt-2 grid gap-1 text-sm">
              <div><dt className="inline font-semibold">Name: </dt><dd className="inline">{o.contributorName}</dd></div>
              {o.organizationName && <div><dt className="inline font-semibold">Organization: </dt><dd className="inline">{o.organizationName}</dd></div>}
              <div><dt className="inline font-semibold">Email: </dt><dd className="inline">{o.email}</dd></div>
              {o.phone && <div><dt className="inline font-semibold">Phone: </dt><dd className="inline">{o.phone}</dd></div>}
              <div><dt className="inline font-semibold">May share details with organizations: </dt><dd className="inline">{o.consentShare ? "Yes" : "No"}</dd></div>
            </dl>
          </section>
          <section className="card p-4" aria-labelledby="hist">
            <h2 id="hist" className="text-xl">History</h2>
            <ol className="mt-3 grid gap-3">
              {o.events.map((e) => (
                <li key={e.id} className="border-l-4 border-gold pl-3 text-sm">
                  <strong>{e.toStatus ? OFFER_STATUS_LABELS[e.toStatus as keyof typeof OFFER_STATUS_LABELS] ?? e.toStatus : e.type === "NOTE" ? "Note" : e.type === "COUNTY_ASSIGNED" ? "County assigned" : e.type}</strong>{" "}
                  <span className="text-xs text-muted">{e.actorRole.toLowerCase().replace(/_/g, " ")} · {fmt(e.at)}</span>
                  {e.note && <p className="mt-1 whitespace-pre-wrap">{e.note}</p>}
                </li>
              ))}
            </ol>
          </section>
        </div>
        <aside className="grid content-start gap-5">
          {o.canAssignCounty && (
            <section className="card border-2 border-gold p-4" aria-labelledby="assign">
              <h2 id="assign" className="text-xl">Assign a county</h2>
              <p className="mt-1 text-sm text-muted">This ZIP code could not be matched to one county. Only you can see this offer until it has a county.</p>
              <div className="mt-3"><AssignCountyForm action={assignCountyAction} offerId={o.id} counties={counties} /></div>
            </section>
          )}
          <section className="card p-4" aria-labelledby="move">
            <h2 id="move" className="text-xl">Update status</h2>
            <div className="mt-3"><OfferTransitionForm action={offerTransitionAction} offerId={o.id} options={o.allowedNext} labels={labels} /></div>
          </section>
          <section className="card p-4" aria-labelledby="note">
            <h2 id="note" className="text-xl">Add a note</h2>
            <div className="mt-3"><OfferNoteForm action={offerNoteAction} offerId={o.id} /></div>
          </section>
        </aside>
      </div>
    </div>
  );
}
