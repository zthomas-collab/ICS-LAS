import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { getCurrentUser } from "@/server/session";
import { signOutAction } from "./auth/actions";
import { HopeGridMark } from "@/components/brand";

export const metadata: Metadata = {
  title: { default: "HopeGrid — Help Is Closer Than You Think", template: "%s · HopeGrid" },
  description:
    "HopeGrid shows where disaster-recovery help is available near you, who provides it, and when it was last confirmed.",
  manifest: "/manifest.webmanifest",
  applicationName: "HopeGrid",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#205C4B" };

const navLink = "rounded-md px-2 py-2 text-sm font-semibold text-white hover:bg-white/10";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  const isAdmin = user?.platformRoles.includes("PLATFORM_ADMIN");
  return (
    <html lang="en">
      <body className="flex min-h-full flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-surface focus:p-2">
          Skip to content
        </a>
        <aside aria-label="Emergency information" className="bg-bad-bg px-4 py-1.5 text-center text-sm text-bad">
          <strong>Life-threatening emergency? Call 911.</strong> HopeGrid lists resources; it does not dispatch help.
        </aside>
        <header className="bg-brand text-white">
          <nav aria-label="Main" className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-1 gap-y-1 px-4 py-2">
            <Link href="/" className="mr-auto flex items-center gap-2 py-1 text-xl font-extrabold tracking-tight text-white" aria-label="HopeGrid home">
              <HopeGridMark />
              <span>Hope<span className="text-mint">Grid</span></span>
            </Link>
            <Link href="/" className={navLink}>Map</Link>
            <Link href="/contacts" className={navLink}>Contacts</Link>
            <Link href="/safety" className={navLink}>Safety</Link>
            {user ? (
              <>
                <Link href="/dashboard" className={navLink}>Dashboard</Link>
                {isAdmin && <Link href="/admin/organizations" className={navLink}>Admin</Link>}
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
          <strong className="text-ink">HopeGrid</strong> is operated by Hiraeth Ventures. Information is provided by
          participating organizations — always check timestamps. Road and resource reports are not official government
          notices. <Link className="text-brand underline" href="/safety">Safety &amp; corrections</Link>
        </footer>
      </body>
    </html>
  );
}
