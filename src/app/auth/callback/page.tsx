import type { Metadata } from "next";
import { TokenForm } from "@/components/forms";
import { consumeSignInAction } from "../actions";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function CallbackPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  return (
    <div className="mx-auto w-full max-w-md px-4 py-6">
      <h1 className="text-2xl font-bold">Finish signing in</h1>
      <div className="card mt-5 p-4">
        <TokenForm action={consumeSignInAction} token={token} label="Sign in" />
      </div>
    </div>
  );
}
