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
import { uploadSiteImage } from "../src/server/modules/images";
import { getObjectStore } from "../src/server/storage";
import sharp from "sharp";

/** Placeholder photo, visibly labelled synthetic — never a real location photo. */
function syntheticPhoto(title: string, color: string): Promise<Buffer> {
  const esc = (t: string) => t.replace(/[<>&"]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">
    <rect width="800" height="500" fill="${color}"/>
    <rect x="40" y="40" width="720" height="420" fill="none" stroke="#ffffff" stroke-width="6" stroke-dasharray="18 12"/>
    <text x="400" y="210" font-family="Arial, sans-serif" font-size="44" font-weight="bold" fill="#ffffff" text-anchor="middle">SYNTHETIC DEMO PHOTO</text>
    <text x="400" y="280" font-family="Arial, sans-serif" font-size="30" fill="#ffffff" text-anchor="middle">${esc(title)}</text>
    <text x="400" y="340" font-family="Arial, sans-serif" font-size="22" fill="#ffffff" text-anchor="middle">Not a real location</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

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
    const org = async (name: string, type: string, phone: string, service: string, also: string[] = []) => {
      const id = (await tx.query<{ id: string }>(
        `INSERT INTO organizations (legal_name, display_name, org_type, status, contact_email, public_phone, public_email, website,
                                    description, is_synthetic, approved_at, requested_service_type, primary_service_type, directory_consent_at)
         VALUES ($1, $1, $2::org_type, 'APPROVED', 'synthetic@example.invalid', $3, $4, 'https://example.org',
                 'Synthetic demo organization. Not a real entity.', true, now(), $5, $5, now())
         RETURNING id`,
        [name, type, phone, `contact+${service.toLowerCase()}@example.invalid`, service],
      ))[0].id;
      await tx.query(`INSERT INTO organization_service_types (org_id, service_type) SELECT $1, unnest($2::text[])`, [id, [service, ...also]]);
      return id;
    };
    const member = (o: string, u: string, role: string) =>
      tx.query(`INSERT INTO organization_memberships (org_id, user_id, role) VALUES ($1, $2, $3::membership_role)`, [o, u, role]);

    const pantryEditor = await user("pantry.editor@example.invalid", "[SYNTHETIC] Pantry Editor");
    const reliefEditor = await user("relief.editor@example.invalid", "[SYNTHETIC] Relief Editor");
    const responder = await user("responder@example.invalid", "[SYNTHETIC] County Responder");
    const pantry = await org("[SYNTHETIC] Blue Ridge Community Pantry", "NONPROFIT", "(828) 555-0101", "FOOD", ["WATER", "SUPPLIES"]);
    const relief = await org("[SYNTHETIC] Mountain Response Network", "RESPONSE_ORGANIZATION", "(828) 555-0102", "SHELTER", ["SUPPLIES", "TRANSPORTATION"]);
    const clinic = await org("[SYNTHETIC] Valley Mobile Health Clinic", "NONPROFIT", "(828) 555-0103", "HEALTHCARE");
    const casemgmt = await org("[SYNTHETIC] Recovery Case Management Partners", "NONPROFIT", "(828) 555-0104", "DISASTER_CASE_MANAGEMENT", ["FINANCIAL_ASSISTANCE", "HOUSING"]);
    const trees = await org("[SYNTHETIC] Clear Roads Tree Crew", "CONTRACTOR", "(828) 555-0105", "DEBRIS_CLEANUP", ["CONTRACTORS_EQUIPMENT"]);
    const water = await org("[SYNTHETIC] French Broad Water Relief", "NONPROFIT", "(828) 555-0106", "WATER");
    await member(pantry, pantryEditor, "ORG_ADMIN");
    await member(relief, reliefEditor, "EDITOR");
    for (const o of [clinic, casemgmt, trees, water]) await member(o, reliefEditor, "ORG_ADMIN");
    await tx.query(
      `INSERT INTO role_assignments (user_id, role, scope_area, reason)
       VALUES ($1, 'AUTHORIZED_RESPONDER', ST_GeogFromText('MULTIPOLYGON(((-83.2 35.2,-82.0 35.2,-82.0 36.0,-83.2 36.0,-83.2 35.2)))'),
               'Synthetic responder scoped to demo area')`,
      [responder],
    );
    return { pantryEditor, reliefEditor, pantry, relief, clinic, casemgmt, trees, water };
  });

  const sites: [string, string, string, Record<string, unknown>][] = [
    [ids.pantryEditor, ids.pantry, "Downtown Food Distribution", { visibility: "PUBLIC", lat: 35.5951, lng: -82.5515, addressLine: "100 Example St", city: "Asheville", county: "Buncombe", state: "NC", postalCode: "28801", hoursText: "Daily 9am–5pm", publicPhone: "(828) 555-0111" }],
    [ids.reliefEditor, ids.clinic, "Mobile Clinic at Community Center", { visibility: "PUBLIC", lat: 35.6085, lng: -82.5600, city: "Asheville", county: "Buncombe", state: "NC", postalCode: "28804", hoursText: "Mon–Sat 9am–4pm", publicPhone: "(828) 555-0133" }],
    [ids.reliefEditor, ids.casemgmt, "Recovery Assistance Desk", { visibility: "PUBLIC", lat: 35.5880, lng: -82.5300, city: "Asheville", county: "Buncombe", state: "NC", postalCode: "28801", hoursText: "Weekdays 10am–6pm", publicPhone: "(828) 555-0144" }],
    [ids.reliefEditor, ids.trees, "Tree Crew Dispatch Point", { visibility: "PUBLIC", lat: 35.6300, lng: -82.4500, city: "Weaverville", county: "Buncombe", state: "NC", postalCode: "28787", hoursText: "Daily 7am–7pm" }],
    [ids.reliefEditor, ids.water, "Riverside Water Distribution", { visibility: "PUBLIC", lat: 35.5650, lng: -82.5750, city: "Asheville", county: "Buncombe", state: "NC", postalCode: "28806", hoursText: "Daily 8am–6pm" }],
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
  await res(ids.reliefEditor, "Mobile Clinic at Community Center", { categoryCode: "MEDICAL_SUPPORT", name: "Walk-in first aid & prescriptions help", visibility: "PUBLIC", availabilityStatus: "AVAILABLE" });
  await res(ids.reliefEditor, "Recovery Assistance Desk", { categoryCode: "DISASTER_RECOVERY_SERVICES", name: "FEMA application help (walk-in)", visibility: "PUBLIC", availabilityStatus: "AVAILABLE" });
  await res(ids.reliefEditor, "Recovery Assistance Desk", { categoryCode: "FINANCIAL_ASSISTANCE", name: "Emergency grant referrals", visibility: "PUBLIC", availabilityStatus: "LIMITED" });
  await res(ids.reliefEditor, "Tree Crew Dispatch Point", { categoryCode: "DEBRIS_REMOVAL", name: "Free tree removal for homeowners", visibility: "PUBLIC", availabilityStatus: "LIMITED" });
  await res(ids.reliefEditor, "Riverside Water Distribution", { categoryCode: "WATER", name: "Bottled water pickup", visibility: "PUBLIC", availabilityStatus: "AVAILABLE", reportedQuantity: "800", quantityUnit: "cases" });

  // Synthetic placeholder photos (clearly labelled) so the image feature can be exercised.
  const store = getObjectStore();
  const photo = async (user: string, site: string, color: string) =>
    uploadSiteImage(db, store, user, created[site], { bytes: await syntheticPhoto(site, color), altText: `Synthetic placeholder image for ${site}`, isSynthetic: true });
  await photo(ids.pantryEditor, "Downtown Food Distribution", "#d84315");
  await photo(ids.reliefEditor, "Swannanoa Shelter", "#2e7d32");
  await photo(ids.reliefEditor, "Mobile Clinic at Community Center", "#c62828");
  await photo(ids.reliefEditor, "Recovery Assistance Desk", "#ad1457");
  await photo(ids.reliefEditor, "Equipment Staging Yard (responders only)", "#2e7d32");

  // Demonstrate freshness expiry: back-date one confirmation beyond the water interval.
  await runIn(db, { kind: "system" }, (tx) =>
    tx.query(`UPDATE resource_availability SET last_confirmed_at = now() - interval '20 hours' WHERE resource_id = $1`, [stale]),
  );
  console.log(`Seeded synthetic data: ${sites.length} sites. Synthetic sign-in emails use the example.invalid domain.`);
  await db.close();
}

/**
 * Loads ZIP centroids from the U.S. Census Bureau ZCTA Gazetteer file (public domain), e.g.
 * 2024_Gaz_zcta_national.txt — tab-separated with columns GEOID ... INTPTLAT INTPTLONG.
 * Download and unzip it from census.gov yourself, then: npm run zips:import -- <path-to-txt>
 */
async function importZips(file: string | undefined) {
  if (!file) throw new Error("Usage: npm run zips:import -- <path to Census ZCTA gazetteer .txt>");
  const { readFileSync } = await import("node:fs");
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split("\t").map((h) => h.trim().toUpperCase());
  const iZip = header.indexOf("GEOID");
  const iLat = header.indexOf("INTPTLAT");
  const iLng = header.indexOf("INTPTLONG");
  if (iZip < 0 || iLat < 0 || iLng < 0) throw new Error("Unrecognized file: expected GEOID, INTPTLAT and INTPTLONG columns");
  const zips: string[] = [];
  const lats: number[] = [];
  const lngs: number[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const c = line.split("\t").map((v) => v.trim());
    const zip = c[iZip];
    const lat = Number(c[iLat]);
    const lng = Number(c[iLng]);
    if (!/^[0-9]{5}$/.test(zip) || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      skipped++;
      continue;
    }
    zips.push(zip);
    lats.push(lat);
    lngs.push(lng);
  }
  const db = await createDriver();
  await migrate(db);
  const BATCH = 2000;
  for (let i = 0; i < zips.length; i += BATCH) {
    await runIn(db, { kind: "system" }, (tx) =>
      tx.query(
        `INSERT INTO zip_codes (zip, location, source)
         SELECT z, ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography, 'census_zcta'
           FROM unnest($1::text[], $2::float8[], $3::float8[]) AS t(z, lat, lng)
         ON CONFLICT (zip) DO UPDATE SET location = EXCLUDED.location, source = EXCLUDED.source, loaded_at = now()`,
        [zips.slice(i, i + BATCH), lats.slice(i, i + BATCH), lngs.slice(i, i + BATCH)],
      ),
    );
  }
  console.log(`Loaded ${zips.length} ZIP centroids (${skipped} rows skipped).`);
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
  } else if (cmd === "zips") {
    await importZips(args[0]);
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
