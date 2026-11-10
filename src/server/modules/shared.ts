import { createHash, randomBytes } from "node:crypto";
import type { Tx } from "../db";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function writeAudit(
  tx: Tx,
  entry: {
    actorUserId: string | null;
    actorOrgId?: string | null;
    action: string;
    subjectType: string;
    subjectId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs (actor_user_id, actor_org_id, action, subject_type, subject_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      entry.actorUserId,
      entry.actorOrgId ?? null,
      entry.action,
      entry.subjectType,
      entry.subjectId ?? null,
      JSON.stringify(entry.details ?? {}),
    ],
  );
}

/** Queues a transactional email. Delivery is performed by the notification worker (not yet configured). */
export async function enqueueEmail(
  tx: Tx,
  msg: { kind: string; to: string; subject: string; body: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO notification_jobs (kind, recipient_email, subject, body_text) VALUES ($1, $2, $3, $4)`,
    [msg.kind, msg.to, msg.subject, msg.body],
  );
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}
