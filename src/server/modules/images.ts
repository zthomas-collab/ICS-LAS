import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { Driver } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import type { ObjectStore } from "../storage";
import { writeAudit } from "./shared";

/**
 * Site images. Every upload is decoded and RE-ENCODED to WebP:
 *  - only JPEG / PNG / WebP inputs are accepted (sniffed from bytes, never from the filename or client MIME type)
 *  - EXIF (including GPS), XMP, IPTC and ICC metadata are dropped by re-encoding
 *  - orientation is applied first so phone photos display upright
 *  - output is bounded to 1600 px on the long edge
 * Re-encoding also neutralizes polyglot payloads hidden in the original container.
 * Malware scanning is NOT configured (missing input M5): rows are recorded as NOT_SCANNED.
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_EDGE = 1600;

export function sniffImageType(bytes: Buffer): "jpeg" | "png" | "webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

export type ProcessedImage = { bytes: Buffer; width: number; height: number; sha256: string };

export async function processImage(input: Buffer, maxEdge: number = MAX_EDGE): Promise<ProcessedImage> {
  if (input.length === 0) throw new AppError("VALIDATION", "Choose an image to upload.", { image: ["Required"] });
  if (input.length > MAX_UPLOAD_BYTES) throw new AppError("VALIDATION", "Images must be 5 MB or smaller.", { image: ["Too large"] });
  const kind = sniffImageType(input);
  if (!kind) throw new AppError("VALIDATION", "Only JPEG, PNG or WebP photos are accepted.", { image: ["Unsupported file type"] });
  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false })
      .rotate() // apply EXIF orientation, then metadata is discarded on output
      .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    return { bytes: data, width: info.width, height: info.height, sha256: createHash("sha256").update(data).digest("hex") };
  } catch {
    throw new AppError("VALIDATION", "That image could not be read. Try a different photo.", { image: ["Unreadable image"] });
  }
}

const altSchema = z.string().trim().min(3, "Describe the photo for people using screen readers").max(300);

/** Uploads (or replaces) the single image for a site. Authorization: org editor via RLS + service check. */
export async function uploadSiteImage(
  driver: Driver,
  store: ObjectStore,
  userId: string,
  siteId: string,
  file: { bytes: Buffer; altText: unknown; isSynthetic?: boolean },
): Promise<string> {
  const alt = altSchema.safeParse(file.altText);
  if (!alt.success) throw new AppError("VALIDATION", "Add a short description of the photo.", { altText: [alt.error.issues[0].message] });
  if (!z.string().uuid().safeParse(siteId).success) throw new AppError("NOT_FOUND", "Site not found.");

  // Authorize before doing expensive work or touching storage.
  const site = await runIn(driver, { kind: "viewer", userId }, async (tx) => {
    const rows = await tx.query<{ org_id: string; can_edit: boolean; status: string }>(
      `SELECT org_id, ics.can_edit_org(org_id) AS can_edit, status::text AS status FROM staging_sites WHERE id = $1`,
      [siteId],
    );
    return rows[0];
  });
  if (!site) throw new AppError("NOT_FOUND", "Site not found.");
  if (!site.can_edit) throw new AppError("FORBIDDEN", "Your organization role does not allow editing this site.");
  if (site.status !== "ACTIVE") throw new AppError("CONFLICT", "Archived sites cannot be edited.");

  const img = await processImage(file.bytes);
  const key = `site-images/${randomUUID()}.webp`;
  await store.put(key, img.bytes, "image/webp");
  try {
    const { id, replacedKey } = await runIn(driver, { kind: "viewer", userId }, async (tx) => {
      const old = await tx.query<{ id: string; storage_key: string }>(
        `UPDATE site_images SET status = 'ARCHIVED', archived_at = now()
          WHERE site_id = $1 AND status = 'ACTIVE' RETURNING id, storage_key`,
        [siteId],
      );
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO site_images (site_id, org_id, storage_key, content_type, byte_size, width, height, sha256, alt_text,
                                  metadata_stripped, is_synthetic, uploaded_by)
         VALUES ($1, $2, $3, 'image/webp', $4, $5, $6, $7, $8, true, $9, ics.viewer_id()) RETURNING id`,
        [siteId, site.org_id, key, img.bytes.length, img.width, img.height, img.sha256, alt.data, file.isSynthetic ?? false],
      );
      await tx.query(
        `INSERT INTO resource_update_events (site_id, org_id, actor_user_id, event_type, after_state, note)
         VALUES ($1, $2, ics.viewer_id(), 'SITE_EDITED', $3::jsonb, $4)`,
        [siteId, site.org_id, JSON.stringify({ imageId: rows[0].id }), old.length ? "Photo replaced" : "Photo added"],
      );
      await writeAudit(tx, {
        actorUserId: userId, actorOrgId: site.org_id, action: old.length ? "SITE_IMAGE_REPLACED" : "SITE_IMAGE_ADDED",
        subjectType: "staging_site", subjectId: siteId, details: { imageId: rows[0].id, bytes: img.bytes.length },
      });
      return { id: rows[0].id, replacedKey: old[0]?.storage_key ?? null };
    });
    // Archived image rows are kept for history; their bytes are retained (no hard delete) until a retention job runs.
    void replacedKey;
    return id;
  } catch (err) {
    await store.delete(key).catch(() => undefined); // do not leave orphaned bytes
    throw fromDbError(err);
  }
}

export async function removeSiteImage(driver: Driver, userId: string, siteId: string): Promise<void> {
  try {
    await runIn(driver, { kind: "viewer", userId }, async (tx) => {
      const site = await tx.query<{ org_id: string; can_edit: boolean }>(
        `SELECT org_id, ics.can_edit_org(org_id) AS can_edit FROM staging_sites WHERE id = $1`,
        [siteId],
      );
      if (!site.length) throw new AppError("NOT_FOUND", "Site not found.");
      if (!site[0].can_edit) throw new AppError("FORBIDDEN", "Your organization role does not allow editing this site.");
      const rows = await tx.query<{ id: string }>(
        `UPDATE site_images SET status = 'ARCHIVED', archived_at = now() WHERE site_id = $1 AND status = 'ACTIVE' RETURNING id`,
        [siteId],
      );
      if (!rows.length) throw new AppError("CONFLICT", "This site has no photo.");
      await writeAudit(tx, { actorUserId: userId, actorOrgId: site[0].org_id, action: "SITE_IMAGE_REMOVED", subjectType: "staging_site", subjectId: siteId });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export type ImageLookup = { id: string; storageKey: string; contentType: string; isPublic: boolean };

/**
 * Locates the current image for a site that the caller may see. Anonymous callers go through
 * public_site_images (ics_anon); signed-in callers go through site_images under RLS.
 */
export async function findSiteImage(driver: Driver, viewerId: string | null, siteId: string): Promise<ImageLookup | null> {
  if (!z.string().uuid().safeParse(siteId).success) return null;
  const pub = await runIn(driver, { kind: "anon" }, (tx) =>
    tx.query<{ id: string; storage_key: string; content_type: string }>(
      `SELECT id, storage_key, content_type FROM public_site_images WHERE site_id = $1`,
      [siteId],
    ),
  );
  if (pub.length) return { id: pub[0].id, storageKey: pub[0].storage_key, contentType: pub[0].content_type, isPublic: true };
  if (!viewerId) return null;
  const rows = await runIn(driver, { kind: "viewer", userId: viewerId }, (tx) =>
    tx.query<{ id: string; storage_key: string; content_type: string }>(
      `SELECT id, storage_key, content_type FROM site_images
        WHERE site_id = $1 AND status = 'ACTIVE' AND scan_status IN ('NOT_SCANNED','CLEAN')`,
      [siteId],
    ),
  );
  return rows.length ? { id: rows[0].id, storageKey: rows[0].storage_key, contentType: rows[0].content_type, isPublic: false } : null;
}
