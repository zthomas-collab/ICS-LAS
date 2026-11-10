import type { Metadata } from "next";
import { SignInForm } from "@/components/forms";
import { requestSignInAction } from "../auth/actions";

export const metadata: Metadata = { title: "Organization sign-in" };

export default function SignInPage() {
  return (
    <div className="mx-auto w-full max-w-md px-4 py-6">
      <h1 className="text-2xl font-bold">Organization sign-in</h1>
      <p className="mt-2 text-muted">For staff of registered organizations. The public map needs no account.</p>
      <div className="card mt-5 p-4">
        <SignInForm action={requestSignInAction} />
      </div>
      {process.env.NODE_ENV !== "production" && (
        <p className="mt-4 rounded-md bg-warn-bg p-3 text-sm text-warn">
          Development authentication: emails are not sent. Open{" "}
          <a className="underline" href="/dev/outbox">/dev/outbox</a> to follow links. A managed auth provider with MFA
          must replace this before production.
        </p>
      )}
    </div>
  );
}
