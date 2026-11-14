import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ApplicationForm } from "@/components/assistance-forms";
import { NotReady } from "@/components/assistance-ui";
import { getDriver } from "@/server/db";
import { assistanceReadiness, listAssistanceCategories } from "@/server/modules/assistance";
import { listCounties } from "@/server/modules/counties";
import { getCurrentUser } from "@/server/session";
import { submitApplicationAction } from "../actions";

export const metadata: Metadata = { title: "Request assistance", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function NewApplicationPage() {
  if (!assistanceReadiness().ready) return <NotReady />;
  const user = await getCurrentUser();
  if (!user) redirect("/signup");
  const db = await getDriver();
  const [counties, categories] = await Promise.all([listCounties(db), listAssistanceCategories(db)]);
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6">
      <h1 className="text-3xl">Request assistance</h1>
      <p className="mt-2 text-muted">Tell us what you need. County staff review your request and update you by email and on this site.</p>
      <div className="card mt-5 p-4">
        <ApplicationForm action={submitApplicationAction} counties={counties} categories={categories} />
      </div>
    </div>
  );
}
