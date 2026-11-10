"use server";

import { redirect } from "next/navigation";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  assertDevAuthAllowed,
  confirmEmail,
  consumeSignIn,
  registerOrganization,
  requestSignIn,
  revokeSession,
} from "@/server/modules/identity";
import { rateLimit } from "@/server/rate-limit";
import { clearSessionCookie, clientKey, getSessionToken, setSessionCookie } from "@/server/session";

export type FormState = { error?: string; fieldErrors?: Record<string, string[]>; ok?: boolean; message?: string };

function toState(err: unknown): FormState {
  if (err instanceof AppError) return { error: err.message, fieldErrors: err.fieldErrors };
  console.error(JSON.stringify({ level: "error", action: "auth", message: (err as Error).message }));
  return { error: "Something went wrong. Please try again." };
}

async function limited(bucket: string, limit: number): Promise<FormState | null> {
  const rl = rateLimit(`${bucket}:${await clientKey()}`, limit, 15 * 60_000);
  return rl.ok ? null : { error: "Too many attempts. Please wait and try again." };
}

export async function registerAction(_prev: FormState, form: FormData): Promise<FormState> {
  assertDevAuthAllowed();
  const blocked = await limited("register", 5);
  if (blocked) return blocked;
  try {
    await registerOrganization(await getDriver(), Object.fromEntries(form.entries()));
    return { ok: true, message: "Check your email for a confirmation link. Your organization will then be reviewed." };
  } catch (err) {
    return toState(err);
  }
}

export async function confirmEmailAction(_prev: FormState, form: FormData): Promise<FormState> {
  assertDevAuthAllowed();
  try {
    const { sessionToken } = await confirmEmail(await getDriver(), String(form.get("token") ?? ""));
    await setSessionCookie(sessionToken);
  } catch (err) {
    return toState(err);
  }
  redirect("/dashboard");
}

export async function requestSignInAction(_prev: FormState, form: FormData): Promise<FormState> {
  assertDevAuthAllowed();
  const blocked = await limited("signin", 10);
  if (blocked) return blocked;
  try {
    await requestSignIn(await getDriver(), form.get("email"));
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "VALIDATION") return toState(err);
    return { error: "Enter a valid email address.", fieldErrors: { email: ["Enter a valid email address"] } };
  }
  return { ok: true, message: "If that email belongs to a confirmed organization account, a sign-in link is on its way." };
}

export async function consumeSignInAction(_prev: FormState, form: FormData): Promise<FormState> {
  assertDevAuthAllowed();
  try {
    const { sessionToken } = await consumeSignIn(await getDriver(), String(form.get("token") ?? ""));
    await setSessionCookie(sessionToken);
  } catch (err) {
    return toState(err);
  }
  redirect("/dashboard");
}

export async function signOutAction(): Promise<void> {
  const token = await getSessionToken();
  if (token) await revokeSession(await getDriver(), token);
  await clearSessionCookie();
  redirect("/");
}
