import { NextResponse, type NextRequest } from "next/server";
import { getDriver } from "@/server/db";
import { AppError, httpStatus } from "@/server/errors";
import { searchPlaces } from "@/server/modules/map";
import { rateLimit } from "@/server/rate-limit";
import { clientKey, getCurrentUser } from "@/server/session";

export const dynamic = "force-dynamic";

/** GET /api/map/search?q=28801 — matches city, county, ZIP, address or site name among sites the caller may see. */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const rl = rateLimit(`search:${user?.id ?? (await clientKey())}`, user ? 120 : 30, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  try {
    const hits = await searchPlaces(await getDriver(), user?.id ?? null, req.nextUrl.searchParams.get("q") ?? "");
    return NextResponse.json({ hits }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (err instanceof AppError) return NextResponse.json({ error: err.message }, { status: httpStatus(err) });
    console.error(JSON.stringify({ level: "error", route: "map.search", message: (err as Error).message }));
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
