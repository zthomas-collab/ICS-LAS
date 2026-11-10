import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers/db";
import { migrate } from "@/server/db/migrate";

describe("migrations", () => {
  it("apply cleanly and are idempotent", async () => {
    const db = await freshDb();
    expect(await migrate(db)).toEqual([]);
    const rows = await db.transaction((tx) =>
      tx.query<{ n: number }>("SELECT count(*)::int AS n FROM operational_sop_definitions"),
    );
    expect(rows[0].n).toBe(14);
    await db.close();
  });
});
