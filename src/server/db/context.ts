import type { Driver, Tx } from "./driver";

/**
 * Execution contexts. Every request-scoped query runs inside exactly one of these.
 *
 *  anon   -> SET LOCAL ROLE ics_anon. Can only read public_* read-model views.
 *  viewer -> SET LOCAL ROLE ics_app + transaction-local ics.viewer_id. Base tables, filtered by RLS.
 *  system -> connection role. ONLY for trusted server code paths that have performed their own
 *            authorization (authentication, registration, admin decisions after role check, jobs).
 */
export type DbContext = { kind: "anon" } | { kind: "viewer"; userId: string } | { kind: "system" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runIn<T>(driver: Driver, ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return driver.transaction(async (tx) => {
    if (ctx.kind === "anon") {
      await tx.query("SET LOCAL ROLE ics_anon");
    } else if (ctx.kind === "viewer") {
      if (!UUID_RE.test(ctx.userId)) throw new Error("invalid viewer id");
      await tx.query("SELECT set_config('ics.viewer_id', $1, true)", [ctx.userId]);
      await tx.query("SET LOCAL ROLE ics_app");
    }
    return fn(tx);
  });
}
