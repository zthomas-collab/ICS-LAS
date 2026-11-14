import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MfaChallengeForm } from "@/components/mfa-forms";
import { getSessionUserAnyState, postSignInPath } from "@/server/session";
import { verifyMfaAction } from "../mfa-actions";

export const metadata: Metadata = { title: "Verify it's you", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function MfaChallengePage() {
  const user = await getSessionUserAnyState();
  if (!user) redirect("/signin");
  if (!user.mfaPending) redirect(postSignInPath(user));
  return (
    <div className="mx-auto w-full max-w-md px-4 py-8">
      <h1 className="text-2xl font-bold">Verify it&apos;s you</h1>
      <p className="mt-2 text-sm text-muted">Signed in as {user.email}. Enter the code from your authenticator app to finish signing in.</p>
      <div className="card mt-4 p-4"><MfaChallengeForm action={verifyMfaAction} /></div>
      <p className="mt-3 text-sm text-muted">Lost your phone? Enter one of your recovery codes instead.</p>
    </div>
  );
}
