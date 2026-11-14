// Lossless margin trim of the official logo files: removes only the empty canvas around the artwork
// (no scaling, recoloring or redrawing). The untouched originals stay in public/brand/originals/.
import sharp from "sharp";

const jobs = [
  ["ccc-logo-white.png", "logo-horizontal.png"],
  ["ccc-logo-ivory.png", "logo-horizontal-ivory.png"],
  ["ccc-logo-mono.png", "logo-horizontal-mono.png"],
];
for (const [src, out] of jobs) {
  const info = await sharp(`public/brand/originals/${src}`).flatten({ background: "#ffffff" }).trim({ threshold: 18 }).png().toFile(`public/brand/${out}`);
  console.log(out, info.width, info.height);
}
