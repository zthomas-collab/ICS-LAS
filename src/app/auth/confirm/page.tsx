import type { Metadata } from "next";
import { TokenForm } from "@/components/forms";
import { confirmEmailAction } from "../actions";

export const metadata: Metadata = { title: "Confirm email", robots: { index: false } };

export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  return (
    <div className="mx-auto w-full max-w-md px-4 py-6">
      <h1 className="text-2xl font-bold">Confirm your email</h1>
      <p className="mt-2 text-muted">Confirming submits your organization for verification and signs you in.</p>
      <div className="card mt-5 p-4">
        <TokenForm action={confirmEmailAction} token={token} label="Confirm email" />
      </div>
    </div>
  );
}
