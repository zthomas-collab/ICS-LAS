import type { Tx } from "../db";
import { AppError } from "../errors";
import { assertPlatformAdmin, privilegedMfaRequired } from "./organizations";

/**
 * Role and scope resolution for trusted (system-context) code paths. Authorization is always
 * re-derived from the database inside the transaction — never from the session cache or the client.
 *
 * Role model (see docs/09-crisis-compass-upgrade-plan.md):
 *   Executive Administrator = platform role PLATFORM_ADMIN (all counties, all settings)
 *   County Administrator    = active county_admin_assignments rows (only their counties)
 *   Nonprofit account       = ACTIVE membership in an APPROVED organization
 *   Volunteer / Public      = a signed-in user with no elevated role (volunteer profile arrives in Phase 3)
 * A user may hold several of these at once.
 */
export type Access = {
  userId: string;
  executive: boolean;
  /** Counties this user administers through assignments (executives administer all, see `canManageCounty`). */
  countyIds: string[];
  orgIds: string[];
};

export async function loadAccess(tx: Tx, userId: string): Promise<Access> {
  const rows = await tx.query<{ executive: boolean; counties: string[]; orgs: string[]; mfa: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM role_assignments ra JOIN users u ON u.id = ra.user_id
                     WHERE ra.user_id = $1 AND ra.role = 'PLATFORM_ADMIN' AND u.status = 'ACTIVE'
                       AND ra.revoked_at IS NULL AND (ra.expires_at IS NULL OR ra.expires_at > now())) AS executive,
            coalesce((SELECT array_agg(a.county_id) FROM county_admin_assignments a JOIN users u ON u.id = a.user_id
                       WHERE a.user_id = $1 AND u.status = 'ACTIVE' AND a.revoked_at IS NULL
                         AND (a.expires_at IS NULL OR a.expires_at > now())), '{}') AS counties,
            coalesce((SELECT array_agg(m.org_id) FROM organization_memberships m
                        JOIN organizations o ON o.id = m.org_id JOIN users u ON u.id = m.user_id
                       WHERE m.user_id = $1 AND m.status = 'ACTIVE' AND u.status = 'ACTIVE' AND o.status = 'APPROVED'
                         AND NOT o.publication_suspended), '{}') AS orgs,
            EXISTS (SELECT 1 FROM users WHERE id = $1 AND mfa_enrolled_at IS NOT NULL) AS mfa`,
    [userId],
  );
  const r = rows[0];
  // Elevated roles need MFA where enforced (always in production); without it they act as ordinary users.
  const elevatedAllowed = !privilegedMfaRequired() || r.mfa;
  return {
    userId,
    executive: r.executive && elevatedAllowed,
    countyIds: elevatedAllowed ? r.counties : [],
    orgIds: r.orgs,
  };
}

export function canManageCounty(access: Access, countyId: string): boolean {
  return access.executive || access.countyIds.includes(countyId);
}

export function assertCountyAccess(access: Access, countyId: string): void {
  if (!canManageCounty(access, countyId)) throw new AppError("FORBIDDEN", "You do not administer this county.");
}

export function isAnyAdmin(access: Access): boolean {
  return access.executive || access.countyIds.length > 0;
}

/** Executive-only gate, including MFA enforcement (delegates to the existing platform-admin check). */
export async function assertExecutive(tx: Tx, userId: string): Promise<void> {
  await assertPlatformAdmin(tx, userId);
}
