/* eslint-disable @next/next/no-img-element -- same-origin brand logo from /public; no optimizer needed */

/**
 * Brand mark. Renders the configured logo (BRAND_LOGO_PATH, a same-origin file under /public) or,
 * when none is configured, a neutral placeholder compass drawn with the theme variables.
 * Decorative: the wordmark next to it carries the name.
 */
export function BrandMark({ size = 28, logoPath }: { size?: number; logoPath?: string | null }) {
  if (logoPath) {
    return <img src={logoPath} alt="" width={size} height={size} className="object-contain" style={{ width: size, height: size }} />;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--cc-soft)" />
      <circle cx="16" cy="16" r="10" fill="none" stroke="var(--cc-primary)" strokeWidth="2" />
      <path d="M16 7l3.2 9L16 25l-3.2-9z" fill="var(--cc-primary)" />
      <path d="M16 7l3.2 9h-6.4z" fill="var(--cc-accent)" />
      <circle cx="16" cy="16" r="1.4" fill="var(--cc-background)" />
    </svg>
  );
}
