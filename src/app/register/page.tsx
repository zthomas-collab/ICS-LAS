import type { Metadata } from "next";
import Link from "next/link";
import { RegisterForm } from "@/components/service-forms";
import { getDriver } from "@/server/db";
import { listServiceTypes } from "@/server/modules/directory";
import { registerAction } from "../auth/actions";

export const metadata: Metadata = { title: "Register your organization" };

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const serviceTypes = await listServiceTypes(await getDriver());
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6">
      <h1 className="text-2xl font-bold">Register your organization</h1>
      <p className="mt-2 text-muted">
        For nonprofits, response organizations and service providers who stage resources.{" "}
        <strong>People looking for help do not need an account</strong> —{" "}
        <Link className="underline" href="/">use the map</Link>.
      </p>
      <ol className="mt-3 list-decimal pl-5 text-sm text-muted">
        <li>Register and confirm your email.</li>
        <li>A platform administrator verifies your organization and confirms its service type (target: within 48 hours).</li>
        <li>Once approved, your team publishes and updates staging sites immediately.</li>
      </ol>
      <div className="card mt-5 p-4">
        <RegisterForm action={registerAction} serviceTypes={serviceTypes} />
      </div>
    </div>
  );
}
