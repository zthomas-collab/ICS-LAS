/**
 * Centralized brand + theme configuration (Crisis Compass).
 *
 * Everything that varies with branding lives here and is overridable with environment variables, so
 * official names, colors and logos can be dropped in without touching components:
 *
 *   BRAND_NAME, BRAND_TAGLINE, BRAND_OPERATOR, BRAND_LOGO_PATH (a file under /public, e.g. /brand/logo.svg)
 *   BRAND_COLOR_PRIMARY, BRAND_COLOR_INTERACTIVE, BRAND_COLOR_LINK, BRAND_COLOR_SOFT,
 *   BRAND_COLOR_ACCENT, BRAND_COLOR_BACKGROUND, BRAND_COLOR_TEXT   (each `#rrggbb`)
 *
 * Defaults are the Crisis Compass Carolinas identity. The hex values are provisional digital tokens drawn from
 * the official logo files (not verified official specifications). Overrides are
 * validated (strict hex only, so nothing can be injected into the generated CSS) and checked for
 * WCAG AA contrast; a failing or malformed override falls back to the default for that token.
 */

export type BrandColors = {
  /** Header/nav background and primary buttons. White text sits on it (>= 4.5:1 required). */
  primary: string;
  /** Map graphics, focus rings (>= 3:1 on white). */
  interactive: string;
  /** Text links on the page background (>= 4.5:1 required). */
  link: string;
  /** Soft supportive backgrounds and highlights. */
  soft: string;
  /** Attention buttons/badges. Dark text sits on it (>= 4.5:1 required). */
  accent: string;
  /** Page background. */
  background: string;
  /** Body text on the page background (>= 4.5:1 required). */
  text: string;
};

export type BrandConfig = {
  name: string;
  tagline: string;
  operator: string;
  /** Path under /public (served same-origin, so it satisfies the CSP), or null to use the built-in mark. */
  logoPath: string | null;
  /** Intrinsic size of the logo file, to reserve layout space. Only known for the built-in official logo. */
  logoSize: { width: number; height: number } | null;
  colors: BrandColors;
  /** Human-readable notes about overrides that were rejected. */
  warnings: string[];
};

export const DEFAULT_COLORS: BrandColors = {
  primary: "#41491d", // Deep Heritage Olive
  interactive: "#6b7352", // Muted Sage, deepened to keep >= 3:1 on white for focus rings and map graphics
  link: "#41491d", // Deep Heritage Olive (text links)
  soft: "#e7ddbd", // Soft Champagne
  accent: "#b5a04d", // Refined Antique Gold (restrained accent; charcoal text on it)
  background: "#f8f5ee", // Warm Ivory
  text: "#20231c", // Executive Charcoal
};

/** The official logo (margin-trimmed copy of the uploaded file; originals are in /public/brand/originals). */
export const DEFAULT_LOGO = { path: "/brand/logo-horizontal.png", width: 1541, height: 437 } as const;

const HEX = /^#[0-9a-fA-F]{6}$/;
const LOGO_PATH = /^\/[A-Za-z0-9_\-./]{1,120}\.(svg|png|webp|jpg|jpeg)$/;
const TEXT = /^[^\u0000-\u001f<>]{1,120}$/;

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colors. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** [token, other color the token is read against, minimum ratio, description] */
const CONTRAST_RULES: { token: keyof BrandColors; against: (c: BrandColors) => string; min: number; label: string }[] = [
  { token: "primary", against: () => "#ffffff", min: 4.5, label: "primary against white text" },
  { token: "interactive", against: () => "#ffffff", min: 3, label: "interactive against white" },
  { token: "link", against: (c) => c.background, min: 4.5, label: "link against the background" },
  { token: "accent", against: (c) => c.text, min: 4.5, label: "accent against body text" },
  { token: "text", against: (c) => c.background, min: 4.5, label: "text against the background" },
];

export function loadBrand(env: Record<string, string | undefined> = process.env): BrandConfig {
  const warnings: string[] = [];
  const colors: BrandColors = { ...DEFAULT_COLORS };
  const envKeys: Record<keyof BrandColors, string> = {
    primary: "BRAND_COLOR_PRIMARY",
    interactive: "BRAND_COLOR_INTERACTIVE",
    link: "BRAND_COLOR_LINK",
    soft: "BRAND_COLOR_SOFT",
    accent: "BRAND_COLOR_ACCENT",
    background: "BRAND_COLOR_BACKGROUND",
    text: "BRAND_COLOR_TEXT",
  };
  for (const token of Object.keys(envKeys) as (keyof BrandColors)[]) {
    const raw = env[envKeys[token]]?.trim();
    if (!raw) continue;
    if (!HEX.test(raw)) {
      warnings.push(`${envKeys[token]} ignored: use #rrggbb.`);
      continue;
    }
    colors[token] = raw.toLowerCase();
  }
  // Contrast guard: fall back per token, never ship an unreadable theme.
  for (const rule of CONTRAST_RULES) {
    if (contrastRatio(colors[rule.token], rule.against(colors)) < rule.min) {
      warnings.push(`${envKeys[rule.token]} ignored: ${rule.label} must be at least ${rule.min}:1.`);
      colors[rule.token] = DEFAULT_COLORS[rule.token];
    }
  }

  const text = (key: string, fallback: string): string => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    if (!TEXT.test(raw)) {
      warnings.push(`${key} ignored: plain text up to 120 characters only.`);
      return fallback;
    }
    return raw;
  };

  let logoPath: string | null = DEFAULT_LOGO.path;
  let logoSize: BrandConfig["logoSize"] = { width: DEFAULT_LOGO.width, height: DEFAULT_LOGO.height };
  const rawLogo = env.BRAND_LOGO_PATH?.trim();
  if (rawLogo) {
    if (LOGO_PATH.test(rawLogo) && !rawLogo.includes("..") && !rawLogo.startsWith("//")) {
      logoPath = rawLogo;
      logoSize = rawLogo === DEFAULT_LOGO.path ? logoSize : null;
    } else warnings.push("BRAND_LOGO_PATH ignored: use a same-origin path such as /brand/logo.svg.");
  }

  return {
    name: text("BRAND_NAME", "Crisis Compass Carolinas"),
    tagline: text("BRAND_TAGLINE", "Direction When It Matters Most"),
    operator: text("BRAND_OPERATOR", "Hiraeth Ventures"),
    logoPath,
    logoSize,
    colors,
    warnings,
  };
}

/** CSS custom properties for :root. Only validated values reach this string. */
export function brandCss(brand: BrandConfig): string {
  const c = brand.colors;
  return (
    `:root{--cc-primary:${c.primary};--cc-interactive:${c.interactive};--cc-link:${c.link};` +
    `--cc-soft:${c.soft};--cc-accent:${c.accent};--cc-background:${c.background};--cc-text:${c.text};}`
  );
}

let cached: BrandConfig | undefined;
/** Resolved once per server process. */
export function getBrand(): BrandConfig {
  if (!cached) {
    cached = loadBrand();
    for (const w of cached.warnings) console.warn(JSON.stringify({ level: "warn", scope: "brand", message: w }));
  }
  return cached;
}
