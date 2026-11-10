import type { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";

/** Minimal query surface shared by the PGlite (dev/test) and node-postgres (production) drivers. */
export interface Tx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Driver {
  readonly kind: "pglite" | "postgres";
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function pgliteDriver(pg: PGlite): Driver {
  return {
    kind: "pglite",
    async exec(sql) {
      await pg.exec(sql);
    },
    async transaction(fn) {
      return pg.transaction(async (t) =>
        fn({
          async query<T>(sql: string, params: unknown[] = []) {
            const r = await t.query<T>(sql, params);
            return r.rows;
          },
        }),
      );
    },
    async close() {
      await pg.close();
    },
  };
}

export function postgresDriver(pool: Pool): Driver {
  return {
    kind: "postgres",
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          async query<T>(sql: string, params: unknown[] = []) {
            const r = await client.query(sql, params);
            return r.rows as T[];
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
