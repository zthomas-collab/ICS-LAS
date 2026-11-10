// Copies MapLibre's standalone web worker into public/ so the browser can load it from
// our own origin (CSP worker-src 'self'). Runs before dev and build.
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "node_modules", "maplibre-gl", "dist", "maplibre-gl-worker.mjs");
const destDir = path.join(root, "public", "vendor", "maplibre");
mkdirSync(destDir, { recursive: true });
copyFileSync(src, path.join(destDir, "maplibre-gl-worker.mjs"));
console.log("Copied maplibre-gl-worker.mjs to public/vendor/maplibre/");
