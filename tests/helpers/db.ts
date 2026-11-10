import { createDriver, type Driver } from "@/server/db";
import { migrate } from "@/server/db/migrate";

/** Fresh in-memory PostgreSQL + PostGIS (PGlite) with all migrations applied. */
export async function freshDb(): Promise<Driver> {
  const driver = await createDriver({ pgliteDir: "memory://" });
  await migrate(driver);
  return driver;
}
