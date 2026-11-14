import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { brandCss, getBrand } from "@/config/brand";
import { getCurrentUser } from "@/server/session";
import { signOutAction } from "./auth/actions";
import { BrandMark } from "@/components/brand";

const brand = getBrand();

export const metadata: Metadata = {
  title: { default: `${brand.name} — ${brand.tagline}`, template: `%s · ${brand.name}` },
  description: `${brand.name} shows where disaster-recovery help is available near you, who provides it, and when it was last confirmed.`,
  manifest: "/manifest.webmanifest",
  applicationName: brand.name,
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: brand.colors.primary };

const navLink = "rounded-md px-2 py-2 text-sm font-semibold text-white hover:bg-white/10";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const isAdmin = user?.platformRoles.includes("PLATFORM_ADMIN") || user?.countyAdmin;
  return (
    <html lang="en">
      <head>
        {/* Theme variables come from validated config only (see src/config/brand.ts). */}
        <style id="brand-theme" dangerouslySetInnerHTML={{ __html: brandCss(brand) }} />
      </head>
      <body className="flex min-h-full flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-surface focus:p-2">
          Skip to content
        </a>
        <aside aria-label="Emergency information" className="bg-bad-bg px-4 py-1.5 text-center text-sm text-bad">
          <strong>Life-threatening emergency? Call 911.</strong> {brand.name} coordinates resources; it does not dispatch help.
        </aside>
        <header className="bg-brand text-white">
          <nav aria-label="Main" className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-1 gap-y-1 px-4 py-2">
            <div className="mr-auto flex flex-wrap items-baseline gap-x-3 gap-y-0 py-1">
              <Link href="/" className="flex items-center gap-2 self-center text-xl font-extrabold tracking-tight text-white" aria-label={`${brand.name} home`}>
                <BrandMark logoPath={brand.logoPath} />
                <span>{brand.name}</span>
              </Link>
              <span className="text-xs font-semibold text-mint sm:text-sm">{brand.tagline}</span>
            </div>
            <Link href="/" className={navLink}>Map</Link>
            <Link href="/contacts" className={navLink}>Contacts</Link>
            <Link href="/safety" className={navLink}>Safety</Link>
            {user ? (
              <>
                <Link href="/dashboard" className={navLink}>Dashboard</Link>
                {isAdmin && <Link href="/admin" className={navLink}>Admin</Link>}
                <form action={signOutAction}>
                  <button className={`${navLink} underline`}>Sign out</button>
                </form>
              </>
            ) : (
              <>
                <Link href="/signin" className={navLink}>Sign in</Link>
                <Link href="/signin?tab=register" className="btn btn-attention ml-1 min-h-10 px-3 py-1.5 text-sm">
                  Register Your Organization
                </Link>
              </>
            )}
          </nav>
        </header>
        <main id="main" className="flex flex-1 flex-col">{children}</main>
        <footer className="border-t border-line bg-surface px-4 py-3 text-center text-xs text-muted">
          <strong className="text-ink">{brand.name}</strong> is operated by {brand.operator}. Information is provided by
          participating organizations — always check timestamps. Road and resource reports are not official government
          notices. <Link className="text-brand underline" href="/safety">Safety &amp; corrections</Link>
        </footer>
      </body>
    </html>
  );
}
