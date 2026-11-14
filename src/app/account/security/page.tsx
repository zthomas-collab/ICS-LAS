import type { Metadata } from "next";
import { getDriver } from "@/server/db";
import { getMfaStatus } from "@/server/modules/mfa";
import { privilegedMfaRequired } from "@/server/modules/organizations";
import { isPrivileged, requireUser } from "@/server/session";
import { MfaSetup } from "@/components/mfa-forms";
import { beginMfaEnrollmentAction, confirmMfaEnrollmentAction } from "../../auth/mfa-actions";

export const metadata: Metadata = { title: "Account security", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ required?: string }> }) {
  const { required } = await searchParams;
  const user = await requireUser();
  const status = await getMfaStatus(await getDriver(), user.id);
  const mustEnroll = isPrivileged(user) && privilegedMfaRequired();
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-6">
      <h1 className="text-2xl font-bold">Account security</h1>
      {(required || (mustEnroll && !status.enrolled)) && !status.enrolled && (
        <p role="alert" className="mt-3 rounded-md bg-warn-bg p-3 text-sm text-warn">
          Your role requires multi-factor authentication. Administrator tools stay locked until you finish this setup.
        </p>
      )}
      <div className="card mt-4 grid gap-3 p-4">
        <h2 className="text-lg font-semibold">Authenticator app</h2>
        {status.enrolled ? (
          <>
            <p className="text-sm"><span className="badge tone-ok">On</span> You will be asked for a code each time you sign in.</p>
            <p className="text-sm text-muted">{status.recoveryCodesRemaining} recovery code{status.recoveryCodesRemaining === 1 ? "" : "s"} left.
              If you lose your phone and your codes, an executive administrator must reset your account after verifying your identity.</p>
          </>
        ) : (
          <MfaSetup begin={beginMfaEnrollmentAction} confirm={confirmMfaEnrollmentAction} />
        )}
      </div>
    </div>
  );
}
