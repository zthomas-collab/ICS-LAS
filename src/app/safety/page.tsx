import type { Metadata } from "next";

export const metadata: Metadata = { title: "Safety & corrections" };

export default function SafetyPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 leading-relaxed">
      <h1 className="text-2xl font-bold">Safety, limits &amp; corrections</h1>
      <section className="card mt-4 p-4">
        <h2 className="text-lg font-semibold text-bad">In an emergency, call 911</h2>
        <p className="mt-1">
          This platform does not dispatch emergency services and is not monitored around the clock. For a
          life-threatening emergency, call 911. For non-emergency disaster information, dial 211 where available.
        </p>
      </section>
      <section className="mt-5">
        <h2 className="text-lg font-semibold">How to read listings</h2>
        <ul className="mt-2 list-disc pl-5">
          <li>Listings are published by organizations that platform administrators have verified.</li>
          <li>
            Every listing shows when it was <strong>last confirmed</strong>. When a listing passes its review interval it
            is shown as <strong>Unconfirmed</strong> — call ahead before traveling.
          </li>
          <li>Quantities are reported by the organization unless marked as a verified count.</li>
          <li>
            Road condition reports from organizations are <strong>not official closures</strong>. Follow instructions
            from local authorities and your state transportation agency. Do not drive through flood water.
          </li>
          <li>Some staging sites are intentionally not shown publicly for safety and operational reasons.</li>
        </ul>
      </section>
      <section className="mt-5">
        <h2 className="text-lg font-semibold">Report incorrect information</h2>
        <p className="mt-1">
          The in-app correction form ships in a later phase (SOP-011). Until then, contact the listed organization
          directly using the phone number on its listing.
        </p>
      </section>
    </div>
  );
}
