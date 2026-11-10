import { NextResponse, type NextRequest } from "next/server";
import { getDriver } from "@/server/db";
import { AppError, httpStatus } from "@/server/errors";
import { queryMap } from "@/server/modules/map";
import { rateLimit } from "@/server/rate-limit";
import { clientKey, getCurrentUser } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/map/resources?w=&s=&e=&n=&categories=FOOD,WATER&confirmedOnly=true
 * Anonymous: public read model only (cacheable briefly). Authenticated: RLS-filtered, never cached.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  const rl = rateLimit(`map:${user?.id ?? (await clientKey())}`, user ? 240 : 90, 60_000);
  if (!rl.ok) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }
  try {
    const params = Object.fromEntries(req.nextUrl.searchParams.entries());
    const result = await queryMap(await getDriver(), user?.id ?? null, params);
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": user ? "private, no-store" : "public, max-age=10, s-maxage=10, stale-while-revalidate=20",
        Vary: "Cookie",
      },
    });
  } catch (err) {
    if (err instanceof AppError) return NextResponse.json({ error: err.message }, { status: httpStatus(err) });
    console.error(JSON.stringify({ level: "error", route: "map.resources", message: (err as Error).message }));
    return NextResponse.json({ error: "Unable to load resources" }, { status: 500 });
  }
}
