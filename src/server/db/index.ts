import path from "node:path";
import { mkdirSync } from "node:fs";
import { type Driver, pgliteDriver, postgresDriver } from "./driver";
import { migrate } from "./migrate";

export type { Driver, Tx } from "./driver";

/**
 * Creates the configured driver.
 *  - DATABASE_URL set  -> PostgreSQL/PostGIS via node-postgres (production, staging, CI with PostGIS).
 *  - otherwise         -> PGlite (PostgreSQL 18 + PostGIS in WASM), persisted to PGLITE_DATA_DIR
 *                         (default ./.data/pglite). Use "memory://" for an ephemeral database.
 * PGlite is single-process: stop the dev server before running CLI scripts against the same directory.
 */
export async function createDriver(opts: { databaseUrl?: string; pgliteDir?: string } = {}): Promise<Driver> {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import("pg");
    return postgresDriver(new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) }));
  }
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PGLITE_IN_PRODUCTION !== "true") {
    throw new Error("DATABASE_URL is required in production (PGlite is for development and tests only).");
  }
  const dir = opts.pgliteDir ?? process.env.PGLITE_DATA_DIR ?? path.join(/* turbopackIgnore: true */ process.cwd(), ".data", "pglite");
  const { PGlite } = await import("@electric-sql/pglite");
  const { postgis } = await import("@electric-sql/pglite-postgis");
  if (!dir.startsWith("memory://")) mkdirSync(dir, { recursive: true });
  const pg = new PGlite({ dataDir: dir, extensions: { postgis } });
  await pg.waitReady;
  return pgliteDriver(pg);
}

const globalForDb = globalThis as unknown as { __icsDb?: Promise<Driver> };

/** Process-wide driver (survives Next.js dev hot reloads). Applies pending migrations on first use. */
export function getDriver(): Promise<Driver> {
  if (!globalForDb.__icsDb) {
    globalForDb.__icsDb = (async () => {
      const driver = await createDriver();
      if (driver.kind === "pglite" || process.env.MIGRATE_ON_START === "true") await migrate(driver);
      return driver;
    })().catch((err) => {
      globalForDb.__icsDb = undefined;
      throw err;
    });
  }
  return globalForDb.__icsDb;
}
