"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  addApplicationNote,
  provideRequestedInfo,
  removeApplicationDocument,
  submitApplication,
  transitionApplication,
  uploadApplicationDocument,
  withdrawApplication,
} from "@/server/modules/assistance";
import { assertDevAuthAllowed, registerPublicAccount } from "@/server/modules/identity";
import { rateLimit } from "@/server/rate-limit";
import { clientKey, requireUser } from "@/server/session";
import { getObjectStore } from "@/server/storage";
import { getScanner } from "@/server/scanner";
import type { FormState } from "../auth/actions";

function toState(err: unknown): FormState {
  if (err instanceof AppError) return { error: err.message, fieldErrors: err.fieldErrors };
  console.error(JSON.stringify({ level: "error", action: "assistance", message: (err as Error).message }));
  return { error: "Something went wrong. Please try again." };
}

async function limited(bucket: string, limit: number, userId?: string): Promise<FormState | null> {
  const rl = rateLimit(`${bucket}:${userId ?? (await clientKey())}`, limit, 15 * 60_000);
  return rl.ok ? null : { error: "Too many attempts. Please wait and try again." };
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "");

/** Resident sign-up. Always answers the same way, so it cannot reveal which emails have accounts. */
export async function signUpAction(_prev: FormState, form: FormData): Promise<FormState> {
  assertDevAuthAllowed();
  const blocked = await limited("signup", 5);
  if (blocked) return blocked;
  try {
    await registerPublicAccount(await getDriver(), Object.fromEntries(form.entries()));
    return { ok: true, message: "Check your email. If this address can create or sign in to an account, a link is on its way." };
  } catch (err) {
    return toState(err);
  }
}

export async function submitApplicationAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const blocked = await limited("apply", 10, user.id);
  if (blocked) return blocked;
  let id: string;
  try {
    id = await submitApplication(await getDriver(), user.id, Object.fromEntries(form.entries()));
  } catch (err) {
    return toState(err);
  }
  redirect(`/assistance/${id}`);
}

export async function withdrawAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await withdrawApplication(await getDriver(), user.id, text(form, "applicationId"), text(form, "note") || undefined);
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/assistance/${text(form, "applicationId")}`);
  return { ok: true, message: "Your application was withdrawn." };
}

export async function provideInfoAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await provideRequestedInfo(await getDriver(), user.id, text(form, "applicationId"), text(form, "message"));
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/assistance/${text(form, "applicationId")}`);
  return { ok: true, message: "Thank you. Your reply was sent for review." };
}

export async function uploadDocumentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const blocked = await limited("upload", 20, user.id);
  if (blocked) return blocked;
  const file = form.get("document");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a file to upload.", fieldErrors: { document: ["Required"] } };
  try {
    await uploadApplicationDocument(await getDriver(), getObjectStore(), getScanner(), user.id, text(form, "applicationId"), {
      bytes: Buffer.from(await file.arrayBuffer()),
      name: file.name,
    });
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/assistance/${text(form, "applicationId")}`);
  return { ok: true, message: "File added." };
}

export async function removeDocumentAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await removeApplicationDocument(await getDriver(), user.id, text(form, "documentId"));
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/assistance/${text(form, "applicationId")}`);
  return { ok: true, message: "File removed." };
}

// ----------------------------- staff -----------------------------
export async function transitionAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await transitionApplication(await getDriver(), user.id, Object.fromEntries(form.entries()));
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/admin/applications/${text(form, "applicationId")}`);
  return { ok: true, message: "Status updated. The applicant was notified." };
}

export async function noteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await addApplicationNote(await getDriver(), user.id, text(form, "applicationId"), text(form, "note"), form.get("visible") === "on");
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/admin/applications/${text(form, "applicationId")}`);
  return { ok: true, message: "Note added." };
}
