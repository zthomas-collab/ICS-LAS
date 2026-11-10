/**
 * Viewport query micro-benchmark (service layer, no HTTP).
 *   npm run bench:viewport            # PGlite in-memory (dev indication only)
 *   DATABASE_URL=... npm run bench:viewport   # real PostGIS — use a disposable database!
 * Generates N synthetic sites (default 10,000) + 1–3 resources each in a 3°×3° area,
 * then runs random city-scale (0.25°) and region-scale (1.5°) viewport queries.
 */
import { createDriver } from "../src/server/db";
import { migrate } from "../src/server/db/migrate";
import { runIn } from "../src/server/db/context";
import { queryMap } from "../src/server/modules/map";

const N = Number(process.env.BENCH_SITES ?? 10_000);
const RUNS = Number(process.env.BENCH_RUNS ?? 200);

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function main() {
  const db = await createDriver({ pgliteDir: process.env.DATABASE_URL ? undefined : "memory://" });
  await migrate(db);
  const { userId } = await runIn(db, { kind: "system" }, async (tx) => {
    const u = (await tx.query<{ id: string }>(`INSERT INTO users (email, display_name, email_verified_at, is_synthetic) VALUES ('bench@example.invalid', '[SYNTHETIC] bench', now(), true) RETURNING id`))[0].id;
    const orgs: string[] = [];
    for (let i = 0; i < 20; i++) {
      orgs.push((await tx.query<{ id: string }>(
        `INSERT INTO organizations (legal_name, display_name, org_type, status, contact_email, is_synthetic, approved_at)
         VALUES ($1, $1, 'NONPROFIT', 'APPROVED', 'bench@example.invalid', true, now()) RETURNING id`, [`[SYNTHETIC] Bench Org ${i}`])
      )[0].id);
    }
    await tx.query(`INSERT INTO organization_memberships (org_id, user_id, role) VALUES ($1, $2, 'EDITOR')`, [orgs[0], u]);
    await tx.query(
      `INSERT INTO staging_sites (org_id, name, visibility, location, city, state, last_confirmed_at, is_synthetic, created_by, updated_by)
       SELECT ($1::uuid[])[1 + (g % 20)], '[SYNTHETIC] Bench site ' || g,
              (ARRAY['PUBLIC','PUBLIC','PUBLIC','ORGANIZATION_NETWORK','AUTHORIZED_RESPONDERS','PRIVATE_ORGANIZATION'])[1 + (g % 6)]::visibility_level,
              ST_SetSRID(ST_MakePoint(-84 + random() * 3, 34.5 + random() * 3), 4326)::geography,
              'Benchville', 'NC', now() - (random() * interval '30 hours'), true, $2, $2
         FROM generate_series(1, $3) g`,
      [orgs, u, N],
    );
    await tx.query(
      `INSERT INTO resources (site_id, org_id, category_code, name, visibility, created_by, is_synthetic)
       SELECT s.id, s.org_id, (ARRAY['FOOD','WATER','SHELTER','EQUIPMENT'])[1 + (k % 4)], 'Bench resource ' || k, s.visibility, $1, true
         FROM staging_sites s CROSS JOIN generate_series(1, 1 + (abs(hashtext(s.id::text)) % 3)) k`,
      [u],
    );
    await tx.query(
      `INSERT INTO resource_availability (resource_id, availability_status, last_confirmed_at)
       SELECT id, (ARRAY['AVAILABLE','LIMITED','DEPLETED','UNKNOWN'])[1 + (abs(hashtext(id::text)) % 4)]::availability_status,
              now() - (random() * interval '30 hours') FROM resources`,
    );
    await tx.query(`ANALYZE`);
    return { userId: u };
  });

  const counts = await runIn(db, { kind: "system" }, (tx) =>
    tx.query<{ sites: number; resources: number }>(`SELECT (SELECT count(*)::int FROM staging_sites) AS sites, (SELECT count(*)::int FROM resources) AS resources`),
  );
  console.log(`Dataset: ${counts[0].sites} sites, ${counts[0].resources} resources (driver: ${db.kind})`);

  for (const [label, span] of [["city-scale 0.25°", 0.25], ["region-scale 1.5°", 1.5]] as const) {
    for (const viewer of [null, userId]) {
      const times: number[] = [];
      let returned = 0;
      for (let i = 0; i < RUNS; i++) {
        const w = -84 + Math.random() * (3 - span);
        const s = 34.5 + Math.random() * (3 - span);
        const t0 = performance.now();
        const r = await queryMap(db, viewer, { w, s, e: w + span, n: s + span });
        times.push(performance.now() - t0);
        returned += r.sites.length;
      }
      console.log(
        `${label.padEnd(18)} ${viewer ? "authenticated" : "anonymous    "} runs=${RUNS} avgSites=${(returned / RUNS).toFixed(0).padStart(4)} ` +
          `p50=${pct(times, 50).toFixed(1)}ms p95=${pct(times, 95).toFixed(1)}ms max=${Math.max(...times).toFixed(1)}ms`,
      );
    }
  }
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
