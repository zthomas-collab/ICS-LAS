import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDriver } from "./db";
import { resolveSession, SESSION_TTL_HOURS, type SessionUser } from "./modules/identity";
import { privilegedMfaRequired } from "./modules/organizations";

export const SESSION_COOKIE = process.env.NODE_ENV === "production" ? "__Host-ics_session" : "ics_session";

export async function getSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** The session's user even when the second factor is still pending. Only the MFA pages should use this. */
export async function getSessionUserAnyState(): Promise<SessionUser | null> {
  const token = await getSessionToken();
  if (!token) return null;
  return resolveSession(await getDriver(), token);
}

/** The signed-in user. A session that still owes its second factor counts as signed out. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const user = await getSessionUserAnyState();
  return user && !user.mfaPending ? user : null;
}

/** True for roles that must use MFA wherever enforcement is on (always in production). */
export function isPrivileged(user: SessionUser): boolean {
  return user.platformRoles.some((r) => r === "PLATFORM_ADMIN" || r === "SECURITY_ADMIN") || user.countyAdmin;
}

/** Where to send a user straight after sign-in. */
export function postSignInPath(user: SessionUser): string {
  if (user.mfaPending) return "/auth/mfa";
  if (!user.mfaEnrolled && isPrivileged(user) && privilegedMfaRequired()) return "/account/security?required=1";
  return "/dashboard";
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  return user;
}

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_HOURS * 3600,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Client IP for rate limiting only (never logged raw). Trusts the first X-Forwarded-For hop set by our proxy. */
export async function clientKey(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "local").trim();
}
