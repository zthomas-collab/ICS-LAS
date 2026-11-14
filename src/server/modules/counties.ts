import { z } from "zod";
import type { Driver } from "../db";
import { runIn } from "../db/context";
import { AppError, fromDbError } from "../errors";
import { assertExecutive, loadAccess } from "./access";
import { parseOrThrow } from "./identity";
import { writeAudit } from "./shared";

export type County = { id: string; name: string; state: string; active: boolean };

export async function listCounties(driver: Driver): Promise<County[]> {
  return runIn(driver, { kind: "anon" }, (tx) =>
    tx.query<County>(`SELECT id, name, state, active FROM counties WHERE active ORDER BY state, name`),
  );
}

export const countySchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[\p{L}0-9 .'-]+$/u, "Letters, numbers, spaces and . ' - only"),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "Use a 2-letter state code"),
  fips: z
    .string()
    .trim()
    .regex(/^[0-9]{5}$/, "Use the 5-digit county FIPS code")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

/** Executive: add a county to the platform. */
export async function createCounty(driver: Driver, actorId: string, raw: unknown): Promise<string> {
  const input = parseOrThrow(countySchema, raw);
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      await assertExecutive(tx, actorId);
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO counties (name, state, fips, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.name, input.state, input.fips ?? null, actorId],
      );
      await writeAudit(tx, {
        actorUserId: actorId,
        action: "COUNTY_CREATED",
        subjectType: "county",
        subjectId: rows[0].id,
        details: { name: input.name, state: input.state },
      });
      return rows[0].id;
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export const assignCountyAdminSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  countyId: z.string().uuid(),
  reason: z.string().trim().min(5, "Record why this access is granted").max(2000),
  expiresAt: z
    .string()
    .trim()
    .optional()
    .or(z.literal("").transform(() => undefined))
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), "Use a valid date"),
});

/**
 * Executive: make a person administrator of one county. The account is created if it does not exist;
 * the person still proves control of the address by signing in with an emailed single-use link.
 */
export async function assignCountyAdmin(driver: Driver, actorId: string, raw: unknown): Promise<string> {
  const input = parseOrThrow(assignCountyAdminSchema, raw);
  try {
    return await runIn(driver, { kind: "system" }, async (tx) => {
      await assertExecutive(tx, actorId);
      const county = await tx.query<{ id: string }>(`SELECT id FROM counties WHERE id = $1 AND active`, [input.countyId]);
      if (!county.length) throw new AppError("NOT_FOUND", "County not found.");
      const user = await tx.query<{ id: string }>(
        `INSERT INTO users (email, display_name, email_verified_at) VALUES ($1, $2, now())
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
        [input.email, input.email.split("@")[0]],
      );
      const existing = await tx.query(
        `SELECT 1 FROM county_admin_assignments WHERE user_id = $1 AND county_id = $2 AND revoked_at IS NULL`,
        [user[0].id, input.countyId],
      );
      if (existing.length) throw new AppError("CONFLICT", "That person already administers this county.");
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO county_admin_assignments (user_id, county_id, reason, granted_by, expires_at)
         VALUES ($1, $2, $3, $4, $5::timestamptz) RETURNING id`,
        [user[0].id, input.countyId, input.reason, actorId, input.expiresAt ?? null],
      );
      await writeAudit(tx, {
        actorUserId: actorId,
        action: "COUNTY_ADMIN_GRANTED",
        subjectType: "user",
        subjectId: user[0].id,
        details: { countyId: input.countyId, assignmentId: rows[0].id },
      });
      return rows[0].id;
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export async function revokeCountyAdmin(driver: Driver, actorId: string, assignmentId: unknown): Promise<void> {
  const id = parseOrThrow(z.string().uuid(), assignmentId);
  try {
    await runIn(driver, { kind: "system" }, async (tx) => {
      await assertExecutive(tx, actorId);
      const rows = await tx.query<{ user_id: string; county_id: string }>(
        `UPDATE county_admin_assignments SET revoked_at = now(), revoked_by = $2
          WHERE id = $1 AND revoked_at IS NULL RETURNING user_id, county_id`,
        [id, actorId],
      );
      if (!rows.length) throw new AppError("NOT_FOUND", "Assignment not found or already revoked.");
      await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [rows[0].user_id]);
      await writeAudit(tx, {
        actorUserId: actorId,
        action: "COUNTY_ADMIN_REVOKED",
        subjectType: "user",
        subjectId: rows[0].user_id,
        details: { countyId: rows[0].county_id, assignmentId: id },
      });
    });
  } catch (err) {
    throw fromDbError(err);
  }
}

export type CountyAdminRow = {
  assignmentId: string;
  countyId: string;
  countyName: string;
  state: string;
  email: string;
  displayName: string;
  reason: string;
  grantedAt: Date;
  expiresAt: Date | null;
};

/** Executives see every assignment; a county administrator sees only assignments in their own counties. */
export async function listCountyAdmins(driver: Driver, actorId: string): Promise<CountyAdminRow[]> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    const access = await loadAccess(tx, actorId);
    if (!access.executive && access.countyIds.length === 0) throw new AppError("FORBIDDEN", "Administrator role required.");
    const rows = await tx.query<Record<string, unknown>>(
      `SELECT a.id, a.county_id, c.name, c.state, u.email, u.display_name, a.reason, a.granted_at, a.expires_at
         FROM county_admin_assignments a JOIN counties c ON c.id = a.county_id JOIN users u ON u.id = a.user_id
        WHERE a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > now())
          AND ($1::boolean OR a.county_id = ANY($2::uuid[]))
        ORDER BY c.state, c.name, u.email`,
      [access.executive, access.countyIds],
    );
    return rows.map((r) => ({
      assignmentId: r.id as string,
      countyId: r.county_id as string,
      countyName: r.name as string,
      state: r.state as string,
      email: r.email as string,
      displayName: r.display_name as string,
      reason: r.reason as string,
      grantedAt: r.granted_at as Date,
      expiresAt: r.expires_at as Date | null,
    }));
  });
}

/** Counties the user may manage: all for executives, otherwise their assignments. */
export async function listManageableCounties(driver: Driver, userId: string): Promise<County[]> {
  return runIn(driver, { kind: "system" }, async (tx) => {
    const access = await loadAccess(tx, userId);
    return tx.query<County>(
      `SELECT id, name, state, active FROM counties WHERE active AND ($1::boolean OR id = ANY($2::uuid[])) ORDER BY state, name`,
      [access.executive, access.countyIds],
    );
  });
}
