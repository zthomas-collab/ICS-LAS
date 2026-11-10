import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { getOrganizationProfile, listServiceTypes } from "@/server/modules/directory";
import { requireUser } from "@/server/session";
import { ProfileForm } from "@/components/service-forms";
import { Timestamp } from "@/components/status";
import { updateProfileAction } from "@/app/dashboard/actions";

export const metadata: Metadata = { title: "Organization profile", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function OrgProfilePage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const user = await requireUser();
  const db = await getDriver();
  let profile;
  try {
    profile = await getOrganizationProfile(db, user.id, orgId);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const serviceTypes = await listServiceTypes(db);
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <Link href="/dashboard" className="text-sm text-brand underline">← Dashboard</Link>
      <h1 className="mt-2 text-2xl font-bold">{profile.displayName}</h1>
      <p className="text-sm text-muted">
        Public profile and Contacts listing.{" "}
        {profile.directoryConsentAt ? (
          <>Listed publicly since <Timestamp value={profile.directoryConsentAt} prefix="consent" />.</>
        ) : (
          "Not listed in public Contacts."
        )}
      </p>
      <div className="card mt-4 p-4">
        {profile.canEdit ? (
          <ProfileForm
            action={updateProfileAction.bind(null, profile.id)}
            serviceTypes={serviceTypes}
            initial={{
              description: profile.description,
              website: profile.website,
              publicPhone: profile.publicPhone,
              publicEmail: profile.publicEmail,
              publicPostalCode: profile.publicPostalCode,
              additional: profile.offeredServiceTypes,
              consent: Boolean(profile.directoryConsentAt),
              primary: profile.primaryServiceType ?? profile.requestedServiceType,
            }}
          />
        ) : (
          <p className="text-muted">Only organization administrators can edit this profile.</p>
        )}
      </div>
    </div>
  );
}
