"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import { addOfferNote, assignOfferCounty, setNotificationEmail, submitOffer, transitionOffer } from "@/server/modules/offers";
import { rateLimit } from "@/server/rate-limit";
import { clientKey, requireUser } from "@/server/session";
import type { FormState } from "../auth/actions";

function toState(err: unknown): FormState {
  if (err instanceof AppError) return { error: err.message, fieldErrors: err.fieldErrors };
  console.error(JSON.stringify({ level: "error", action: "offers", message: (err as Error).message }));
  return { error: "Something went wrong. Please try again." };
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

/** Public offer form. No account needed, so it is guarded by a per-address rate limit and a hidden trap field. */
export async function submitOfferAction(_prev: FormState, form: FormData): Promise<FormState> {
  const rl = rateLimit(`offer:${await clientKey()}`, 6, 15 * 60_000);
  if (!rl.ok) return { error: "Too many attempts. Please wait a few minutes and try again." };
  // Bots fill every field. A person never sees this one; pretend success and store nothing.
  if (text(form, "website")) redirect("/volunteer/thanks");
  let reference: string;
  try {
    ({ reference } = await submitOffer(await getDriver(), Object.fromEntries(form.entries())));
  } catch (err) {
    return toState(err);
  }
  redirect(`/volunteer/thanks?ref=${encodeURIComponent(reference)}`);
}

export async function offerTransitionAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await transitionOffer(await getDriver(), user.id, Object.fromEntries(form.entries()));
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/admin/offers/${text(form, "offerId")}`);
  return { ok: true, message: "Status updated." };
}

export async function offerNoteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await addOfferNote(await getDriver(), user.id, text(form, "offerId"), text(form, "note"));
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/admin/offers/${text(form, "offerId")}`);
  return { ok: true, message: "Note added." };
}

export async function assignCountyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await assignOfferCounty(await getDriver(), user.id, text(form, "offerId"), text(form, "countyId"));
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/admin/offers/${text(form, "offerId")}`);
  return { ok: true, message: "County assigned." };
}

export async function saveSettingsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    const v = await setNotificationEmail(await getDriver(), user.id, { email: text(form, "email") });
    revalidatePath("/admin/settings");
    return { ok: true, message: v ? `New offers will be announced to ${v}.` : "Offer notification emails are turned off. Offers are still saved and shown in the dashboard." };
  } catch (err) {
    return toState(err);
  }
}
