import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SignUpForm } from "@/components/assistance-forms";
import { SignInForm } from "@/components/forms";
import { assistanceReadiness } from "@/server/modules/assistance";
import { getCurrentUser } from "@/server/session";
import { requestSignInAction } from "../auth/actions";
import { signUpAction } from "../assistance/actions";
import { NotReady } from "@/components/assistance-ui";

export const metadata: Metadata = { title: "Create an account or sign in", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  if (await getCurrentUser()) redirect("/assistance");
  if (!assistanceReadiness().ready) return <NotReady />;
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6">
      <h1 className="text-3xl">Request assistance</h1>
      <p className="mt-2 text-muted">
        Create a free account to send a request for help and follow its progress. We email you a link, so there is no password to
        remember. You do not need an account to use the <Link className="underline" href="/">resource map</Link>.
      </p>
      <section className="card mt-5 p-4" aria-labelledby="new-account">
        <h2 id="new-account" className="text-xl">New here? Create an account</h2>
        <div className="mt-3"><SignUpForm action={signUpAction} /></div>
      </section>
      <section className="card mt-5 p-4" aria-labelledby="have-account">
        <h2 id="have-account" className="text-xl">Already have an account? Sign in</h2>
        <div className="mt-3"><SignInForm action={requestSignInAction} /></div>
      </section>
      <p className="mt-4 text-sm">Organizations that stage resources register <Link className="underline" href="/signin?tab=register">here</Link>.</p>
    </div>
  );
}
