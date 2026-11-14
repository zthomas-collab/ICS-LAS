import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ApplicationRows, NotReady } from "@/components/assistance-ui";
import { getDriver } from "@/server/db";
import { assistanceReadiness, listMyApplications } from "@/server/modules/assistance";
import { getCurrentUser } from "@/server/session";

export const metadata: Metadata = { title: "My assistance requests", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function AssistanceHome() {
  if (!assistanceReadiness().ready) return <NotReady />;
  const user = await getCurrentUser();
  if (!user) redirect("/signup");
  const rows = await listMyApplications(await getDriver(), user.id);
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="text-3xl">My assistance requests</h1>
      <p className="mt-2 text-muted">Signed in as {user.email}. Submitting a request does not guarantee help; county staff review every request.</p>
      <p className="mt-4"><Link className="btn btn-primary" href="/assistance/new">Request assistance</Link></p>
      <section className="card mt-5 p-4" aria-labelledby="mine">
        <h2 id="mine" className="text-xl">Your requests</h2>
        {rows.length === 0 ? <p className="mt-2 text-sm text-muted">You have not submitted a request yet.</p> : <ApplicationRows rows={rows} basePath="/assistance" />}
      </section>
      <p className="mt-4 rounded-md bg-bad-bg p-3 text-sm text-bad"><strong>Life-threatening emergency? Call 911.</strong> This site does not dispatch help.</p>
    </div>
  );
}
