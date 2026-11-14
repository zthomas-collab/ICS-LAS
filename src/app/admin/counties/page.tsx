import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { listCountyAdmins, listManageableCounties } from "@/server/modules/counties";
import { requireUser } from "@/server/session";
import { Timestamp } from "@/components/status";
import { AssignCountyAdminForm, CreateCountyForm, RevokeButton } from "@/components/county-forms";
import { assignCountyAdminAction, createCountyAction, revokeCountyAdminAction } from "@/app/dashboard/actions";

export const metadata: Metadata = { title: "Counties and administrators", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function AdminCountiesPage() {
  const user = await requireUser();
  const db = await getDriver();
  const executive = user.platformRoles.includes("PLATFORM_ADMIN");
  let admins, counties;
  try {
    [admins, counties] = await Promise.all([listCountyAdmins(db, user.id), listManageableCounties(db, user.id)]);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") notFound();
    throw err;
  }
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <Link href="/admin" className="text-sm text-brand underline">← Administration</Link>
      <h1 className="mt-2 text-2xl font-bold">Counties and administrators</h1>
      <p className="text-sm text-muted">
        County administrators can act only inside the counties assigned to them. Every grant and revocation is audited.
      </p>

      <section className="mt-6" aria-labelledby="counties-h">
        <h2 id="counties-h" className="text-lg font-semibold">Counties{executive ? "" : " you administer"}</h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {counties.map((c) => <li key={c.id} className="badge tone-brand">{c.name}, {c.state}</li>)}
          {counties.length === 0 && <li className="text-sm text-muted">No counties yet.</li>}
        </ul>
        {executive && (
          <div className="card mt-3 p-4">
            <h3 className="mb-2 font-semibold">Add a county</h3>
            <CreateCountyForm action={createCountyAction} />
          </div>
        )}
      </section>

      <section className="mt-8" aria-labelledby="admins-h">
        <h2 id="admins-h" className="text-lg font-semibold">County administrators</h2>
        <ul className="mt-2 divide-y divide-line">
          {admins.map((a) => (
            <li key={a.assignmentId} className="grid gap-1 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <div>
                <p className="font-medium">{a.email} <span className="text-muted">— {a.countyName}, {a.state}</span></p>
                <p className="text-xs text-muted">
                  {a.reason} · <Timestamp value={a.grantedAt} prefix="Granted" />
                  {a.expiresAt && <> · <Timestamp value={a.expiresAt} prefix="Expires" /></>}
                </p>
              </div>
              {executive && <RevokeButton action={revokeCountyAdminAction.bind(null, a.assignmentId)} label={`Revoke ${a.email} for ${a.countyName}`} />}
            </li>
          ))}
          {admins.length === 0 && <li className="py-3 text-sm text-muted">No county administrators assigned.</li>}
        </ul>
        {executive && (
          <div className="card mt-3 p-4">
            <h3 className="mb-2 font-semibold">Assign a county administrator</h3>
            <AssignCountyAdminForm action={assignCountyAdminAction} counties={counties} />
          </div>
        )}
      </section>
    </div>
  );
}
