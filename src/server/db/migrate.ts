import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Driver } from "./driver";

export const MIGRATIONS_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), "db", "migrations");

/** Applies pending SQL migrations in filename order, each in its own transaction. */
export async function migrate(driver: Driver, dir = MIGRATIONS_DIR): Promise<string[]> {
  await driver.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set(
    (await driver.transaction((tx) => tx.query<{ name: string }>("SELECT name FROM schema_migrations"))).map(
      (r) => r.name,
    ),
  );
  const files = readdirSync(/* turbopackIgnore: true */ dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(/* turbopackIgnore: true */ path.join(dir, file), "utf8");
    // Multi-statement SQL runs via exec; wrap in explicit transaction for atomicity.
    try {
      await driver.exec(
        `BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${file.replace(/'/g, "''")}');\nCOMMIT;`,
      );
    } catch (err) {
      await driver.exec("ROLLBACK").catch(() => undefined);
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
    ran.push(file);
  }
  return ran;
}
