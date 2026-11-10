import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDriver } from "@/server/db";
import { listMyOrganizations } from "@/server/modules/organizations";
import { requireUser } from "@/server/session";
import { SiteForm } from "@/components/site-forms";
import { createSiteAction } from "@/app/dashboard/actions";

export const metadata: Metadata = { title: "New staging site", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function NewSitePage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const user = await requireUser();
  const org = (await listMyOrganizations(await getDriver(), user.id)).find((o) => o.id === orgId);
  if (!org) notFound();
  const canEdit = org.status === "APPROVED" && !org.publicationSuspended && (org.role === "ORG_ADMIN" || org.role === "EDITOR");
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <Link href="/dashboard" className="text-sm text-brand underline">← Dashboard</Link>
      <h1 className="mt-2 text-2xl font-bold">New staging site</h1>
      <p className="text-sm text-muted">{org.displayName} · SOP-002: choose the least visibility that serves the site&apos;s purpose.</p>
      <div className="card mt-4 p-4">
        {canEdit ? (
          <SiteForm action={createSiteAction.bind(null, orgId)} submitLabel="Create site" />
        ) : (
          <p className="text-bad">Your organization or role cannot publish sites right now.</p>
        )}
      </div>
    </div>
  );
}
