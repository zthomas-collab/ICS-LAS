import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/forms";
import { RegisterForm } from "@/components/service-forms";
import { getDriver } from "@/server/db";
import { listServiceTypes } from "@/server/modules/directory";
import { getCurrentUser } from "@/server/session";
import { registerAction, requestSignInAction } from "../auth/actions";

export const metadata: Metadata = { title: "For organizations — sign in or register" };
export const dynamic = "force-dynamic";

/** One page for organization staff: sign in (existing accounts) or register a new organization. */
export default async function OrganizationAccessPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const active = tab === "register" ? "register" : "signin";
  // Signed-in staff skip the sign-in tab but may still register another organization.
  if (active === "signin" && (await getCurrentUser())) redirect("/dashboard");
  const serviceTypes = active === "register" ? await listServiceTypes(await getDriver()) : [];
  const tabClass = (on: boolean) =>
    `flex-1 rounded-t-lg border border-b-0 px-4 py-3 text-center font-semibold ${on ? "border-line bg-surface text-ink" : "border-transparent text-muted underline"}`;

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6">
      <h1 className="text-2xl font-bold">For organizations</h1>
      <p className="mt-2 text-muted">
        For nonprofits, response organizations and service providers who stage resources.{" "}
        <strong>People looking for help do not need an account</strong> —{" "}
        <Link className="underline" href="/">use the map</Link> or <Link className="underline" href="/contacts">Contacts</Link>.
      </p>

      <nav aria-label="Sign in or register" className="mt-5 flex gap-1 border-b border-line">
        <Link href="/signin" className={tabClass(active === "signin")} aria-current={active === "signin" ? "page" : undefined}>
          Sign in
        </Link>
        <Link href="/signin?tab=register" className={tabClass(active === "register")} aria-current={active === "register" ? "page" : undefined}>
          Register a new organization
        </Link>
      </nav>

      <div className="card rounded-t-none border-t-0 p-4">
        {active === "signin" ? (
          <>
            <p className="mb-3 text-sm text-muted">
              Already registered? Enter your work email and we&apos;ll send a one-time sign-in link.{" "}
              <strong>Never got (or lost) your confirmation email?</strong> Enter the same email — we&apos;ll send a new confirmation link.
            </p>
            <SignInForm action={requestSignInAction} />
            <p className="mt-4 text-sm">
              New here? <Link className="font-semibold text-brand underline" href="/signin?tab=register">Register your organization</Link> — it takes about 3 minutes.
            </p>
          </>
        ) : (
          <>
            <ol className="mb-4 grid gap-2 text-sm sm:grid-cols-3" aria-label="How approval works">
              <li className="rounded-lg bg-neutral-bg p-2"><strong>1. Register</strong><br />and confirm your email</li>
              <li className="rounded-lg bg-neutral-bg p-2"><strong>2. We verify</strong><br />and confirm your service type (target 48 h)</li>
              <li className="rounded-lg bg-neutral-bg p-2"><strong>3. Publish</strong><br />your locations immediately</li>
            </ol>
            <RegisterForm action={registerAction} serviceTypes={serviceTypes} />
            <p className="mt-4 text-sm">
              Already registered? <Link className="font-semibold text-brand underline" href="/signin">Sign in</Link>
            </p>
          </>
        )}
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
