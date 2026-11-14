import { NextResponse, type NextRequest } from "next/server";
import { getDriver } from "@/server/db";
import { findPublicLogo } from "@/server/modules/directory";
import { rateLimit } from "@/server/rate-limit";
import { clientKey } from "@/server/session";
import { getObjectStore } from "@/server/storage";

export const dynamic = "force-dynamic";

/** GET /api/orgs/:orgId/logo — streams the logo only for organizations with an approved public profile. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  const rl = rateLimit(`logo:${await clientKey()}`, 240, 60_000);
  if (!rl.ok) return new NextResponse(null, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  const logo = await findPublicLogo(await getDriver(), orgId);
  if (!logo) return new NextResponse(null, { status: 404 });
  const bytes = await getObjectStore().get(logo.key);
  if (!bytes) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
      "Cache-Control": "public, max-age=300",
      ETag: `"${logo.version}"`,
    },
  });
}
