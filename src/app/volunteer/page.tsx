import type { Metadata } from "next";
import { OfferForm } from "@/components/offer-forms";
import { getDriver } from "@/server/db";
import { listCounties } from "@/server/modules/counties";
import { OFFER_TYPES, OFFER_TYPE_LABELS } from "@/server/modules/offers";
import { submitOfferAction } from "./actions";

export const metadata: Metadata = { title: "Volunteer & donate" };
export const dynamic = "force-dynamic";

export default async function VolunteerPage() {
  const counties = await listCounties(await getDriver());
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <h1 className="text-3xl">Volunteer &amp; donate</h1>
      <p className="mt-2 text-muted">
        Offer your time, skills, supplies, equipment, transportation or space. Coordinators review each offer and match it to a real
        need. You do not need an account, and sending an offer does not commit anyone to accept it.
      </p>
      <div className="card mt-5 p-4">
        <OfferForm action={submitOfferAction} counties={counties} types={OFFER_TYPES.map((t) => ({ code: t, label: OFFER_TYPE_LABELS[t] }))} />
      </div>
    </div>
  );
}
