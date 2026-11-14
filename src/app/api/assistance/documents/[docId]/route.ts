import { NextResponse, type NextRequest } from "next/server";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { readApplicationDocument } from "@/server/modules/assistance";
import { rateLimit } from "@/server/rate-limit";
import { clientKey, getCurrentUser } from "@/server/session";
import { getObjectStore } from "@/server/storage";

export const dynamic = "force-dynamic";

/**
 * GET /api/assistance/documents/:docId. Streams a supporting document only to the applicant, the application's
 * county administrators or the provider it was referred to (row-level security + MFA rule inside the module).
 * Always downloaded (never rendered inline) and never cached.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ docId: string }> }) {
  const { docId } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401, headers: { "Cache-Control": "no-store" } });
  const rl = rateLimit(`adoc:${user.id}:${await clientKey()}`, 120, 60_000);
  if (!rl.ok) return new NextResponse(null, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  try {
    const f = await readApplicationDocument(await getDriver(), getObjectStore(), user.id, docId);
    const name = f.displayName.replace(/[^A-Za-z0-9._ -]/g, "_");
    return new NextResponse(new Uint8Array(f.bytes), {
      headers: {
        "Content-Type": f.contentType,
        "Content-Length": String(f.bytes.length),
        "Content-Disposition": `attachment; filename="${name}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError) {
      const status = err.code === "FORBIDDEN" ? 403 : 404;
      return new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });
    }
    throw err;
  }
}
