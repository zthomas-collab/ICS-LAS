import { createHash } from "node:crypto";
import { AppError } from "./errors";
import { processImage, sniffImageType } from "./modules/images";
import type { ScanResult, Scanner } from "./scanner";

/**
 * Supporting-document intake for assistance applications (may contain sensitive personal records).
 *
 *  - Accepts PDF, JPEG, PNG or WebP only, identified from the file's bytes (never its name or declared type).
 *  - Images are decoded and re-encoded to WebP: metadata (EXIF/GPS) is dropped and hidden payloads neutralized.
 *  - PDFs are refused when they declare active content (JavaScript, launch actions, embedded files, forms
 *    that submit data). This is a heuristic on top of, not instead of, the malware scan.
 *  - Nothing is released to staff until the scan returns CLEAN. Without an effective scanner, production
 *    refuses uploads (fail closed); development stores files as NOT_SCANNED.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS_PER_APPLICATION = 8;
const DOC_IMAGE_EDGE = 2400;

export type PreparedDocument = {
  bytes: Buffer;
  contentType: "application/pdf" | "image/webp";
  ext: "pdf" | "webp";
  sha256: string;
  displayName: string;
};

const ACTIVE_PDF = /\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction|RichMedia|XFA|SubmitForm|ImportData)\b/;

/** A file name that is safe to show and to put in a Content-Disposition header. */
export function safeDisplayName(raw: string, ext: string): string {
  const base = (raw.split(/[\\/]/).pop() ?? "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 _.-]+/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^[\s._-]+/, "")
    .trim()
    .slice(0, 80);
  return `${base || "document"}.${ext}`;
}

export async function prepareDocument(input: Buffer, originalName: string): Promise<PreparedDocument> {
  if (input.length === 0) throw new AppError("VALIDATION", "Choose a file to upload.", { document: ["Required"] });
  if (input.length > MAX_DOCUMENT_BYTES) throw new AppError("VALIDATION", "Files must be 10 MB or smaller.", { document: ["Too large"] });

  if (input.subarray(0, 5).toString("latin1") === "%PDF-") {
    if (ACTIVE_PDF.test(input.toString("latin1"))) {
      throw new AppError("VALIDATION", "That PDF contains interactive content and cannot be accepted. Save or print it to a new PDF and try again.", { document: ["Unsafe PDF"] });
    }
    return {
      bytes: input,
      contentType: "application/pdf",
      ext: "pdf",
      sha256: createHash("sha256").update(input).digest("hex"),
      displayName: safeDisplayName(originalName, "pdf"),
    };
  }
  if (sniffImageType(input)) {
    const img = await processImage(input, DOC_IMAGE_EDGE);
    return { bytes: img.bytes, contentType: "image/webp", ext: "webp", sha256: img.sha256, displayName: safeDisplayName(originalName, "webp") };
  }
  throw new AppError("VALIDATION", "Only PDF, JPEG, PNG or WebP files are accepted.", { document: ["Unsupported file type"] });
}

export type ScanOutcome = { status: "CLEAN" | "INFECTED" | "FAILED" | "NOT_SCANNED"; detail?: string };

/**
 * Applies the scanning policy. Throws when uploads must be refused (production without a working scanner);
 * returns the status to record otherwise.
 */
export async function scanDocument(scanner: Scanner, bytes: Buffer, env: { NODE_ENV?: string } = process.env): Promise<ScanOutcome> {
  if (!scanner.effective) {
    if (env.NODE_ENV === "production") {
      throw new AppError("VALIDATION", "Document uploads are temporarily unavailable. You can submit your application without documents and add them later.");
    }
    return { status: "NOT_SCANNED", detail: "development: no scanner configured" };
  }
  const r: ScanResult = await scanner.scan(bytes);
  return r;
}
