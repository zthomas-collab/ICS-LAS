// Shared domain vocabulary (safe for client and server bundles; no secrets).

export const VISIBILITY_LEVELS = [
  "PUBLIC",
  "ORGANIZATION_NETWORK",
  "AUTHORIZED_RESPONDERS",
  "PRIVATE_ORGANIZATION",
] as const;
export type Visibility = (typeof VISIBILITY_LEVELS)[number];

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  PUBLIC: "Public — anyone, no sign-in",
  ORGANIZATION_NETWORK: "Organization network — approved organizations",
  AUTHORIZED_RESPONDERS: "Authorized responders — scoped operational users",
  PRIVATE_ORGANIZATION: "Private — my organization only",
};

export const AVAILABILITY_STATUSES = ["AVAILABLE", "LIMITED", "DEPLETED", "TEMPORARILY_CLOSED", "UNKNOWN"] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export const AVAILABILITY_LABELS: Record<AvailabilityStatus, string> = {
  AVAILABLE: "Available",
  LIMITED: "Limited",
  DEPLETED: "Depleted",
  TEMPORARILY_CLOSED: "Temporarily closed",
  UNKNOWN: "Unknown",
};

export type Freshness = "FRESH" | "DUE_SOON" | "EXPIRED" | "NEVER_CONFIRMED";

export const ORG_TYPES = [
  "NONPROFIT",
  "RESPONSE_ORGANIZATION",
  "GOVERNMENT_AGENCY",
  "SERVICE_PROVIDER",
  "CONTRACTOR",
  "COMMUNITY_ORGANIZATION",
] as const;
export type OrgType = (typeof ORG_TYPES)[number];
export const ORG_TYPE_LABELS: Record<OrgType, string> = {
  NONPROFIT: "Nonprofit",
  RESPONSE_ORGANIZATION: "Response organization",
  GOVERNMENT_AGENCY: "Government agency",
  SERVICE_PROVIDER: "Service provider",
  CONTRACTOR: "Contractor",
  COMMUNITY_ORGANIZATION: "Community organization",
};

export const VISIBILITY_RANK: Record<Visibility, number> = {
  PUBLIC: 0,
  ORGANIZATION_NETWORK: 1,
  AUTHORIZED_RESPONDERS: 2,
  PRIVATE_ORGANIZATION: 3,
};

/** A resource can never be more visible than the site that holds it. */
export function isResourceVisibilityAllowed(site: Visibility, resource: Visibility): boolean {
  return VISIBILITY_RANK[resource] >= VISIBILITY_RANK[site];
}

export type DisplayAvailability = {
  /** What to show as the headline status. Never "Available" when the confirmation has expired. */
  label: string;
  tone: "ok" | "warn" | "bad" | "muted";
  /** True only when the status is both positive and within its confirmation interval. */
  confirmedAvailable: boolean;
  /** Secondary text, e.g. "Last reported: Available". */
  note?: string;
};

export function displayAvailability(status: AvailabilityStatus, freshness: Freshness): DisplayAvailability {
  const stale = freshness === "EXPIRED" || freshness === "NEVER_CONFIRMED";
  if (stale) {
    return {
      label: "Unconfirmed",
      tone: "muted",
      confirmedAvailable: false,
      note: freshness === "NEVER_CONFIRMED" ? "Never confirmed" : `Last reported: ${AVAILABILITY_LABELS[status]}`,
    };
  }
  const tone = status === "AVAILABLE" ? "ok" : status === "LIMITED" ? "warn" : status === "UNKNOWN" ? "muted" : "bad";
  return {
    label: AVAILABILITY_LABELS[status],
    tone,
    confirmedAvailable: status === "AVAILABLE" || status === "LIMITED",
    note: freshness === "DUE_SOON" ? "Reconfirmation due soon" : undefined,
  };
}

/** Directions are only offered for publicly disclosed locations. */
export function directionsUrl(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/directions?to=${lat.toFixed(6)}%2C${lng.toFixed(6)}`;
}

export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^0-9+]/g, "")}`;
}
