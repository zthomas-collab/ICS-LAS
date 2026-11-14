import type { MetadataRoute } from "next";
import { getBrand } from "@/config/brand";

export default function manifest(): MetadataRoute.Manifest {
  const brand = getBrand();
  return {
    name: brand.name,
    short_name: brand.name.length > 12 ? brand.name.split(" ").map((w) => w[0]).join("") : brand.name,
    description: `${brand.tagline} Find disaster-recovery resources near you.`,
    start_url: "/",
    display: "standalone",
    background_color: brand.colors.background,
    theme_color: brand.colors.primary,
    icons: [
      { src: "/brand/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/brand/icon-256.png", sizes: "256x256", type: "image/png", purpose: "any" },
    ],
  };
}
