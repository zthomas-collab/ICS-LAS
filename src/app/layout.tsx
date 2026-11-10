import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { getCurrentUser } from "@/server/session";
import { signOutAction } from "./auth/actions";

export const metadata: Metadata = {
  title: { default: "ICS-LAS · Resource Map", template: "%s · ICS-LAS" },
  description: "Find disaster recovery resources, who runs them, and when they were last confirmed.",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f4c5c" };

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
          <strong>Life-threatening emergency? Call 911.</strong> This site lists resources; it does not dispatch help.
        </aside>
        <header className="border-b border-line bg-surface">
          <nav aria-label="Main" className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
            <Link href="/" className="mr-auto text-lg font-bold text-brand">
              ICS-LAS <span className="hidden text-sm font-normal text-muted sm:inline">Resource Map</span>
            </Link>
            <Link href="/" className="py-2 text-sm font-medium">Map</Link>
            <Link href="/contacts" className="py-2 text-sm font-medium">Contacts</Link>
            <Link href="/safety" className="py-2 text-sm font-medium">Safety</Link>
            {user ? (
              <>
                <Link href="/dashboard" className="py-2 text-sm font-medium">Dashboard</Link>
                {isAdmin && <Link href="/admin/organizations" className="py-2 text-sm font-medium">Admin</Link>}
                <form action={signOutAction}>
                  <button className="py-2 text-sm font-medium text-muted underline">Sign out</button>
                </form>
              </>
            ) : (
              <>
                <Link href="/signin" className="py-2 text-sm font-medium">For organizations: sign in / register</Link>
              </>
            )}
          </nav>
        </header>
        <main id="main" className="flex flex-1 flex-col">{children}</main>
        <footer className="border-t border-line bg-surface px-4 py-3 text-center text-xs text-muted">
          Information is provided by participating organizations. Always check timestamps. Road and resource
          reports are not official government notices. <Link className="underline" href="/safety">Safety &amp; corrections</Link>
        </footer>
      </body>
    </html>
  );
}
