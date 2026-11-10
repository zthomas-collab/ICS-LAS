"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDriver } from "@/server/db";
import { AppError } from "@/server/errors";
import {
  archiveResource,
  archiveSite,
  confirmResource,
  confirmSite,
  createResource,
  createSite,
  updateAvailability,
  updateSite,
} from "@/server/modules/sites";
import { decideOrganization } from "@/server/modules/organizations";
import { requireUser } from "@/server/session";
import type { FormState } from "../auth/actions";

function toState(err: unknown): FormState {
  if (err instanceof AppError) return { error: err.message, fieldErrors: err.fieldErrors };
  console.error(JSON.stringify({ level: "error", action: "dashboard", message: (err as Error).message }));
  return { error: "Something went wrong. Please try again." };
}

const fields = (form: FormData) => Object.fromEntries(form.entries());

export async function createSiteAction(orgId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  let id: string;
  try {
    id = await createSite(await getDriver(), user.id, orgId, fields(form));
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/dashboard");
  redirect(`/dashboard/sites/${id}?created=1`);
}

export async function updateSiteAction(siteId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await updateSite(await getDriver(), user.id, siteId, fields(form));
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/dashboard/sites/${siteId}`);
  return { ok: true, message: "Site saved and confirmed." };
}

export async function siteCommandAction(siteId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const cmd = form.get("cmd");
  try {
    if (cmd === "confirm") await confirmSite(await getDriver(), user.id, siteId);
    else if (cmd === "archive") await archiveSite(await getDriver(), user.id, siteId, String(form.get("note") ?? "") || undefined);
    else return { error: "Unknown command." };
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/dashboard/sites/${siteId}`);
  return { ok: true, message: cmd === "confirm" ? "Site confirmed as accurate." : "Site archived and unpublished." };
}

export async function createResourceAction(siteId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await createResource(await getDriver(), user.id, siteId, fields(form));
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/dashboard/sites/${siteId}`);
  return { ok: true, message: "Resource added." };
}

export async function resourceCommandAction(siteId: string, resourceId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const cmd = form.get("cmd");
  const db = await getDriver();
  try {
    if (cmd === "confirm") await confirmResource(db, user.id, resourceId);
    else if (cmd === "archive") await archiveResource(db, user.id, resourceId);
    else if (cmd === "status") await updateAvailability(db, user.id, resourceId, fields(form));
    else return { error: "Unknown command." };
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/dashboard/sites/${siteId}`);
  return { ok: true, message: cmd === "confirm" ? "Confirmed." : cmd === "archive" ? "Archived." : "Updated." };
}

export async function decideOrganizationAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await decideOrganization(await getDriver(), user.id, fields(form));
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/admin/organizations");
  return { ok: true, message: `Decision recorded: ${String(form.get("decision")).toLowerCase()}.` };
}
