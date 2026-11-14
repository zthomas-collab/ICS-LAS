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
import {
  removeOrganizationLogo,
  reviewOrganizationProfile,
  setPrimaryServiceType,
  updateOrganizationProfile,
  uploadOrganizationLogo,
} from "@/server/modules/directory";
import { assignCountyAdmin, createCounty, revokeCountyAdmin } from "@/server/modules/counties";
import { SOCIAL_KINDS } from "@/lib/links";
import { MAX_UPLOAD_BYTES, removeSiteImage, uploadSiteImage } from "@/server/modules/images";
import { getObjectStore } from "@/server/storage";
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

export async function setServiceTypeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await setPrimaryServiceType(await getDriver(), user.id, fields(form));
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/admin/organizations");
  return { ok: true, message: "Service type updated." };
}

export async function updateProfileAction(orgId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await updateOrganizationProfile(await getDriver(), user.id, orgId, {
      ...fields(form),
      additionalServiceTypes: form.getAll("additionalServiceTypes"),
      countyIds: form.getAll("countyIds"),
      socialLinks: Object.fromEntries(SOCIAL_KINDS.map((k) => [k, String(form.get(`social_${k}`) ?? "")])),
    });
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/dashboard/orgs/${orgId}/profile`);
  revalidatePath("/contacts");
  revalidatePath(`/orgs/${orgId}`);
  return { ok: true, message: "Profile saved." };
}

export async function uploadSiteImageAction(siteId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const file = form.get("image");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a photo to upload.", fieldErrors: { image: ["Required"] } };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "Images must be 5 MB or smaller.", fieldErrors: { image: ["Too large"] } };
  try {
    await uploadSiteImage(await getDriver(), getObjectStore(), user.id, siteId, {
      bytes: Buffer.from(await file.arrayBuffer()),
      altText: form.get("altText"),
    });
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/dashboard/sites/${siteId}`);
  return { ok: true, message: "Photo saved. Location metadata was removed." };
}

export async function removeSiteImageAction(siteId: string): Promise<FormState> {
  const user = await requireUser();
  try {
    await removeSiteImage(await getDriver(), user.id, siteId);
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/dashboard/sites/${siteId}`);
  return { ok: true, message: "Photo removed." };
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

export async function uploadLogoAction(orgId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  const file = form.get("logo");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a logo to upload.", fieldErrors: { logo: ["Required"] } };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "Images must be 5 MB or smaller.", fieldErrors: { logo: ["Too large"] } };
  try {
    await uploadOrganizationLogo(await getDriver(), getObjectStore(), user.id, orgId, {
      bytes: Buffer.from(await file.arrayBuffer()),
      altText: form.get("altText"),
    });
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/dashboard/orgs/${orgId}/profile`);
  revalidatePath(`/orgs/${orgId}`);
  return { ok: true, message: "Logo saved." };
}

export async function removeLogoAction(orgId: string): Promise<FormState> {
  const user = await requireUser();
  try {
    await removeOrganizationLogo(await getDriver(), getObjectStore(), user.id, orgId);
  } catch (err) {
    return toState(err);
  }
  revalidatePath(`/dashboard/orgs/${orgId}/profile`);
  revalidatePath(`/orgs/${orgId}`);
  return { ok: true, message: "Logo removed." };
}

export async function reviewProfileAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await reviewOrganizationProfile(await getDriver(), user.id, fields(form));
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/admin/profiles");
  revalidatePath("/contacts");
  return { ok: true, message: "Profile decision recorded." };
}

export async function createCountyAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await createCounty(await getDriver(), user.id, fields(form));
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/admin/counties");
  return { ok: true, message: "County added." };
}

export async function assignCountyAdminAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await assignCountyAdmin(await getDriver(), user.id, fields(form));
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/admin/counties");
  return { ok: true, message: "County administrator assigned. They can sign in with an emailed link." };
}

export async function revokeCountyAdminAction(assignmentId: string): Promise<FormState> {
  const user = await requireUser();
  try {
    await revokeCountyAdmin(await getDriver(), user.id, assignmentId);
  } catch (err) {
    return toState(err);
  }
  revalidatePath("/admin/counties");
  return { ok: true, message: "Access revoked and sessions ended." };
}
