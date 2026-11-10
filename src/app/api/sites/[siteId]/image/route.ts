import { NextResponse, type NextRequest } from "next/server";
import { getDriver } from "@/server/db";
import { findSiteImage } from "@/server/modules/images";
import { rateLimit } from "@/server/rate-limit";
import { clientKey, getCurrentUser } from "@/server/session";
import { getObjectStore } from "@/server/storage";

export const dynamic = "force-dynamic";

/**
 * GET /api/sites/:siteId/image — streams the site's current photo if, and only if, the caller
 * may see the site. Restricted-site photos are never cacheable by shared caches.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await ctx.params;
  const user = await getCurrentUser();
  const rl = rateLimit(`img:${user?.id ?? (await clientKey())}`, user ? 600 : 240, 60_000);
  if (!rl.ok) return new NextResponse(null, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  const img = await findSiteImage(await getDriver(), user?.id ?? null, siteId);
  if (!img) return new NextResponse(null, { status: 404 });
  const bytes = await getObjectStore().get(img.storageKey);
  if (!bytes) return new NextResponse(null, { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": img.contentType,
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
      "Cache-Control": img.isPublic ? "public, max-age=300" : "private, no-store",
      Vary: "Cookie",
      ETag: `"${img.id}"`,
    },
  });
}
