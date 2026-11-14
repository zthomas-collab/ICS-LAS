import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApplicationRows } from "@/components/assistance-ui";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { STATUSES, STATUS_LABELS, listApplicationsForStaff, listAssistanceCategories } from "@/server/modules/assistance";
import { listManageableCounties } from "@/server/modules/counties";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Assistance requests (staff)", robots: { index: false } };
export const dynamic = "force-dynamic";

type Search = { status?: string; countyId?: string; categoryCode?: string; zip?: string; page?: string };

export default async function StaffQueue({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const db = await getDriver();
  let result;
  try {
    result = await listApplicationsForStaff(db, user.id, sp);
  } catch (err) {
    if (err instanceof AppError && (err.code === "FORBIDDEN" || err.code === "VALIDATION")) {
      if (err.code === "FORBIDDEN") notFound();
      return <p className="mx-auto max-w-3xl px-4 py-6">Check the filters and try again.</p>;
    }
    throw err;
  }
  const [counties, categories] = await Promise.all([listManageableCounties(db, user.id), listAssistanceCategories(db)]);
  const q = (over: Record<string, string>) => new URLSearchParams(Object.entries({ ...sp, ...over }).filter(([, v]) => v) as [string, string][]).toString();
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="text-3xl">Assistance requests</h1>
      <p className="mt-1 text-sm text-muted">Only requests you are authorized to see are listed. Opening one is recorded in the audit log.</p>
      <form className="card mt-4 grid gap-3 p-4 sm:grid-cols-5" method="get">
        <label className="field"><span>Status</span>
          <select className="input" name="status" defaultValue={sp.status ?? ""}>
            <option value="">Any</option>{STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select></label>
        <label className="field"><span>County</span>
          <select className="input" name="countyId" defaultValue={sp.countyId ?? ""}>
            <option value="">Any</option>{counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}
          </select></label>
        <label className="field"><span>Type</span>
          <select className="input" name="categoryCode" defaultValue={sp.categoryCode ?? ""}>
            <option value="">Any</option>{categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
          </select></label>
        <label className="field"><span>ZIP</span><input className="input" name="zip" defaultValue={sp.zip ?? ""} inputMode="numeric" maxLength={5} /></label>
        <div className="flex items-end"><button className="btn btn-primary w-full" type="submit">Filter</button></div>
      </form>
      <section className="card mt-4 p-4" aria-label="Results">
        {result.rows.length === 0 ? <p className="text-sm text-muted">No requests match.</p> : <ApplicationRows rows={result.rows} basePath="/admin/applications" />}
        <nav className="mt-3 flex justify-between text-sm" aria-label="Pages">
          {result.page > 1 ? <Link className="underline" href={`?${q({ page: String(result.page - 1) })}`}>← Newer</Link> : <span />}
          {result.hasMore && <Link className="underline" href={`?${q({ page: String(result.page + 1) })}`}>Older →</Link>}
        </nav>
      </section>
    </div>
  );
}
