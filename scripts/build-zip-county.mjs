// Builds db/data/zip_county_nc_sc.csv from the U.S. Census Bureau 2020 ZCTA-to-county relationship file
// (public domain): https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt
//
//   node scripts/build-zip-county.mjs <path-to-tab20_zcta520_county20_natl.txt>
//
// The result is committed to the repository and loaded by the platform at migrate time, so the data only
// changes when someone re-runs this script and ships the code. ZIPs are ZCTA approximations of USPS ZIPs;
// a ZIP that overlaps several counties yields several rows (land_share is the fraction of the ZIP's land
// area inside each county) and the app asks the person which county they live in.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("Usage: node scripts/build-zip-county.mjs <relationship file>");
const lines = readFileSync(file, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
const head = lines[0].split("|");
const col = (n) => {
  const i = head.indexOf(n);
  if (i < 0) throw new Error(`missing column ${n}`);
  return i;
};
const [iZip, iFips, iName, iPart] = ["GEOID_ZCTA5_20", "GEOID_COUNTY_20", "NAMELSAD_COUNTY_20", "AREALAND_PART"].map(col);

const STATES = { "37": "NC", "45": "SC" };
const byZip = new Map();
for (const line of lines.slice(1)) {
  const c = line.split("|");
  const zip = c[iZip];
  if (!/^\d{5}$/.test(zip)) continue; // counties with no ZCTA
  const land = Number(c[iPart]) || 0;
  const row = { fips: c[iFips], name: c[iName].replace(/ (County|Parish|Borough|Census Area|city)$/i, (m) => (m.trim() === "city" ? " city" : "")), land };
  if (!byZip.has(zip)) byZip.set(zip, []);
  byZip.get(zip).push(row);
}

const out = ["zip,county_fips,state,county_name,land_share"];
let zips = 0;
let multi = 0;
for (const [zip, rows] of [...byZip].sort((a, b) => a[0].localeCompare(b[0]))) {
  const total = rows.reduce((s, r) => s + r.land, 0) || 1;
  let keep = rows.filter((r) => STATES[r.fips.slice(0, 2)]).map((r) => ({ ...r, share: r.land / total }));
  if (keep.length === 0) continue;
  const sig = keep.filter((r) => r.share >= 0.001);
  keep = sig.length ? sig : [keep.sort((a, b) => b.share - a.share)[0]];
  zips++;
  if (keep.length > 1) multi++;
  for (const r of keep.sort((a, b) => b.share - a.share)) {
    out.push([zip, r.fips, STATES[r.fips.slice(0, 2)], `"${r.name}"`, r.share.toFixed(4)].join(","));
  }
}
mkdirSync("db/data", { recursive: true });
writeFileSync("db/data/zip_county_nc_sc.csv", out.join("\n") + "\n");
console.log(`ZIPs: ${zips}, multi-county ZIPs: ${multi}, rows: ${out.length - 1}`);
