/**
 * Operator CLI. Uses the same driver selection as the app (DATABASE_URL or PGlite dir).
 * PGlite is single-process: STOP the dev server before running these against .data/pglite.
 *
 *   npm run db:migrate
 *   npm run db:seed                       # synthetic demo data (labelled [SYNTHETIC])
 *   npm run admin:grant -- <email> [PLATFORM_ADMIN|SECURITY_ADMIN|ROAD_VERIFIER] "<reason>"
 */
import { createDriver } from "../src/server/db";
import { migrate } from "../src/server/db/migrate";
import { runIn } from "../src/server/db/context";
import { grantPlatformRole } from "../src/server/modules/organizations";
import { createResource, createSite } from "../src/server/modules/sites";

async function seed() {
  const db = await createDriver();
  await migrate(db);
  const existing = await runIn(db, { kind: "system" }, (tx) =>
    tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM organizations WHERE is_synthetic`),
  );
  if (existing[0].n > 0) {
    console.log("Synthetic data already present; skipping.");
    return db.close();
  }

  const ids = await runIn(db, { kind: "system" }, async (tx) => {
    const user = async (email: string, name: string) =>
      (await tx.query<{ id: string }>(
        `INSERT INTO users (email, display_name, email_verified_at, is_synthetic) VALUES ($1, $2, now(), true) RETURNING id`,
        [email, name],
      ))[0].id;
    const org = async (name: string, type: string, phone: string) =>
      (await tx.query<{ id: string }>(
        `INSERT INTO organizations (legal_name, display_name, org_type, status, contact_email, public_phone, description, is_synthetic, approved_at)
         VALUES ($1, $1, $2::org_type, 'APPROVED', 'synthetic@example.invalid', $3, 'Synthetic demo organization. Not a real entity.', true, now())
         RETURNING id`,
        [name, type, phone],
      ))[0].id;
    const member = (o: string, u: string, role: string) =>
      tx.query(`INSERT INTO organization_memberships (org_id, user_id, role) VALUES ($1, $2, $3::membership_role)`, [o, u, role]);

    const pantryEditor = await user("pantry.editor@example.invalid", "[SYNTHETIC] Pantry Editor");
    const reliefEditor = await user("relief.editor@example.invalid", "[SYNTHETIC] Relief Editor");
    const responder = await user("responder@example.invalid", "[SYNTHETIC] County Responder");
    const pantry = await org("[SYNTHETIC] Blue Ridge Community Pantry", "NONPROFIT", "(828) 555-0101");
    const relief = await org("[SYNTHETIC] Mountain Response Network", "RESPONSE_ORGANIZATION", "(828) 555-0102");
    await member(pantry, pantryEditor, "ORG_ADMIN");
    await member(relief, reliefEditor, "EDITOR");
    await tx.query(
      `INSERT INTO role_assignments (user_id, role, scope_area, reason)
       VALUES ($1, 'AUTHORIZED_RESPONDER', ST_GeogFromText('MULTIPOLYGON(((-83.2 35.2,-82.0 35.2,-82.0 36.0,-83.2 36.0,-83.2 35.2)))'),
               'Synthetic responder scoped to demo area')`,
      [responder],
    );
    return { pantryEditor, reliefEditor, pantry, relief };
  });

  const sites: [string, string, string, Record<string, unknown>][] = [
    [ids.pantryEditor, ids.pantry, "Downtown Food Distribution", { visibility: "PUBLIC", lat: 35.5951, lng: -82.5515, addressLine: "100 Example St", city: "Asheville", county: "Buncombe", state: "NC", postalCode: "28801", hoursText: "Daily 9am–5pm", publicPhone: "(828) 555-0111" }],
    [ids.pantryEditor, ids.pantry, "West Side Water Point", { visibility: "PUBLIC", lat: 35.5785, lng: -82.6040, city: "Asheville", county: "Buncombe", state: "NC", postalCode: "28806", hoursText: "8am–8pm" }],
    [ids.reliefEditor, ids.relief, "Swannanoa Shelter", { visibility: "PUBLIC", lat: 35.5979, lng: -82.3996, city: "Swannanoa", county: "Buncombe", state: "NC", postalCode: "28778", hoursText: "24 hours", publicPhone: "(828) 555-0122" }],
    [ids.reliefEditor, ids.relief, "Equipment Staging Yard (responders only)", { visibility: "AUTHORIZED_RESPONDERS", lat: 35.6170, lng: -82.3200, city: "Black Mountain", county: "Buncombe", state: "NC" }],
    [ids.reliefEditor, ids.relief, "Partner Supply Cache (org network)", { visibility: "ORGANIZATION_NETWORK", lat: 35.4300, lng: -82.5000, city: "Fletcher", county: "Henderson", state: "NC" }],
    [ids.pantryEditor, ids.pantry, "Warehouse (private)", { visibility: "PRIVATE_ORGANIZATION", lat: 35.5200, lng: -82.5300, city: "Asheville", county: "Buncombe", state: "NC" }],
  ];
  const created: Record<string, string> = {};
  for (const [user, org, name, s] of sites) {
    created[name] = await createSite(db, user, org, { name: `[SYNTHETIC] ${name}`, ...s });
  }
  const res = (user: string, site: string, r: Record<string, unknown>) => createResource(db, user, created[site], r);
  await res(ids.pantryEditor, "Downtown Food Distribution", { categoryCode: "FOOD", name: "Hot meals", visibility: "PUBLIC", availabilityStatus: "AVAILABLE", reportedQuantity: "300", quantityUnit: "meals" });
  await res(ids.pantryEditor, "Downtown Food Distribution", { categoryCode: "WATER", name: "Bottled water", visibility: "PUBLIC", availabilityStatus: "LIMITED", reportedQuantity: "40", quantityUnit: "cases" });
  const stale = await res(ids.pantryEditor, "West Side Water Point", { categoryCode: "WATER", name: "Water refill station", visibility: "PUBLIC", availabilityStatus: "AVAILABLE" });
  await res(ids.reliefEditor, "Swannanoa Shelter", { categoryCode: "SHELTER", name: "Overnight cots", visibility: "PUBLIC", availabilityStatus: "AVAILABLE", reportedQuantity: "35", quantityUnit: "beds", quantityBasis: "VERIFIED_COUNT" });
  await res(ids.reliefEditor, "Swannanoa Shelter", { categoryCode: "MEDICAL_SUPPORT", name: "First-aid station listing", visibility: "PUBLIC", availabilityStatus: "TEMPORARILY_CLOSED" });
  await res(ids.reliefEditor, "Swannanoa Shelter", { categoryCode: "FUEL", name: "Generator fuel reserve", visibility: "AUTHORIZED_RESPONDERS", availabilityStatus: "AVAILABLE", reportedQuantity: "500", quantityUnit: "gallons" });
  await res(ids.reliefEditor, "Equipment Staging Yard (responders only)", { categoryCode: "EQUIPMENT", name: "Chainsaws and skid steer", visibility: "AUTHORIZED_RESPONDERS", availabilityStatus: "AVAILABLE" });
  await res(ids.reliefEditor, "Partner Supply Cache (org network)", { categoryCode: "BUILDING_MATERIALS", name: "Tarps and plywood", visibility: "ORGANIZATION_NETWORK", availabilityStatus: "LIMITED" });
  await res(ids.pantryEditor, "Warehouse (private)", { categoryCode: "FOOD", name: "Pallet inventory", visibility: "PRIVATE_ORGANIZATION", availabilityStatus: "AVAILABLE" });
  // Demonstrate freshness expiry: back-date one confirmation beyond the water interval.
  await runIn(db, { kind: "system" }, (tx) =>
    tx.query(`UPDATE resource_availability SET last_confirmed_at = now() - interval '20 hours' WHERE resource_id = $1`, [stale]),
  );
  console.log(`Seeded synthetic data: ${sites.length} sites. Synthetic sign-in emails use the example.invalid domain.`);
  await db.close();
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "migrate") {
    const db = await createDriver();
    const ran = await migrate(db);
    console.log(ran.length ? `Applied: ${ran.join(", ")}` : "No pending migrations.");
    await db.close();
  } else if (cmd === "seed") {
    await seed();
  } else if (cmd === "grant") {
    const [email, role = "PLATFORM_ADMIN", reason = "Bootstrap via CLI"] = args;
    if (!email) throw new Error("Usage: npm run admin:grant -- <email> [role] [reason]");
    const db = await createDriver();
    await migrate(db);
    const id = await grantPlatformRole(db, { email, role: role as "PLATFORM_ADMIN", reason });
    console.log(`Granted ${role} to ${email} (user ${id}). Sign in at /signin.`);
    await db.close();
  } else {
    console.log("Commands: migrate | seed | grant <email> [role] [reason]");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
