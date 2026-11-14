import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Thank you", robots: { index: false } };

export default async function Thanks({ searchParams }: { searchParams: Promise<{ ref?: string }> }) {
  const { ref } = await searchParams;
  const reference = ref && /^OFR-\d{4}-\d{6}$/.test(ref) ? ref : null;
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8">
      <h1 className="text-3xl">Thank you</h1>
      <p className="mt-3">We received your offer. A coordinator will review it and may contact you.</p>
      {reference && (
        <p className="card mt-4 p-4">Your reference number: <strong className="font-mono">{reference}</strong><br />
          <span className="text-sm text-muted">Keep this number if you contact us about your offer. We also emailed it to you.</span></p>
      )}
      <p className="mt-4"><Link className="underline" href="/">Back to the resource map</Link></p>
    </div>
  );
}
