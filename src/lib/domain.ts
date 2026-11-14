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

/**
 * Semantic resource status kinds. Colors for these are reserved for status only and are never
 * reused for organization/service types. Every rendering pairs color with text and an icon.
 */
export type StatusKind = "available" | "limited" | "depleted" | "closed" | "unknown" | "unconfirmed";

export const STATUS_KEY: { kind: StatusKind; label: string; letter: string; meaning: string }[] = [
  { kind: "available", label: "Available", letter: "A", meaning: "Confirmed available" },
  { kind: "limited", label: "Limited", letter: "L", meaning: "Confirmed, running low" },
  { kind: "depleted", label: "Depleted", letter: "D", meaning: "Confirmed out right now" },
  { kind: "closed", label: "Temporarily closed", letter: "C", meaning: "Closed for now" },
  { kind: "unknown", label: "Unknown", letter: "?", meaning: "Organization doesn't know" },
  { kind: "unconfirmed", label: "Unconfirmed", letter: "?", meaning: "Not re-checked recently — call ahead" },
];

export type DisplayAvailability = {
  /** What to show as the headline status. Never "Available" when the confirmation has expired. */
  label: string;
  kind: StatusKind;
  /** @deprecated use kind; kept for older call sites */
  tone: "ok" | "warn" | "bad" | "muted";
  /** True only when the status is both positive and within its confirmation interval. */
  confirmedAvailable: boolean;
  /** Secondary text, e.g. "Last reported: Available". */
  note?: string;
};

const KIND_TONE: Record<StatusKind, DisplayAvailability["tone"]> = {
  available: "ok", limited: "warn", depleted: "bad", closed: "muted", unknown: "muted", unconfirmed: "muted",
};

export function displayAvailability(status: AvailabilityStatus, freshness: Freshness): DisplayAvailability {
  const stale = freshness === "EXPIRED" || freshness === "NEVER_CONFIRMED";
  if (stale) {
    return {
      label: "Unconfirmed",
      kind: "unconfirmed",
      tone: "muted",
      confirmedAvailable: false,
      note: freshness === "NEVER_CONFIRMED" ? "Never confirmed" : `Last reported: ${AVAILABILITY_LABELS[status]}`,
    };
  }
  const kind: StatusKind =
    status === "AVAILABLE" ? "available"
    : status === "LIMITED" ? "limited"
    : status === "DEPLETED" ? "depleted"
    : status === "TEMPORARILY_CLOSED" ? "closed"
    : "unknown";
  return {
    label: AVAILABILITY_LABELS[status],
    kind,
    tone: KIND_TONE[kind],
    confirmedAvailable: kind === "available" || kind === "limited",
    note: freshness === "DUE_SOON" ? "Reconfirmation due soon" : undefined,
  };
}

/** The single status a map marker shows: the most useful confirmed status among its resources. */
export function bestSiteStatus(resources: { reportedStatus: string; freshness: string }[]): StatusKind {
  const order: StatusKind[] = ["available", "limited", "depleted", "closed", "unknown", "unconfirmed"];
  const kinds = resources.map((r) => displayAvailability(r.reportedStatus as AvailabilityStatus, r.freshness as Freshness).kind);
  for (const k of order) if (kinds.includes(k)) return k;
  return "unconfirmed";
}

/** Directions are only offered for publicly disclosed locations. */
export function directionsUrl(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/directions?to=${lat.toFixed(6)}%2C${lng.toFixed(6)}`;
}

export type MapApp = "google" | "apple" | "waze" | "osm" | "device";

export const MAP_APP_LABELS: Record<MapApp, string> = {
  google: "Google Maps",
  apple: "Apple Maps",
  waze: "Waze",
  osm: "OpenStreetMap",
  device: "Maps on this phone",
};

/** Turn-by-turn links for each navigation app. All are https universal links except `device` (geo:, Android). */
export function directionsLinks(lat: number, lng: number): Record<MapApp, string> {
  const a = lat.toFixed(6);
  const b = lng.toFixed(6);
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${a}%2C${b}&travelmode=driving`,
    apple: `https://maps.apple.com/?daddr=${a},${b}&dirflg=d`,
    waze: `https://waze.com/ul?ll=${a}%2C${b}&navigate=yes`,
    osm: directionsUrl(lat, lng),
    device: `geo:${a},${b}?q=${a},${b}`,
  };
}

/** The app to lead with for this device. Unknown devices get Google Maps (opens its app when installed). */
export function preferredMapApp(userAgent: string): MapApp {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "apple";
  if (/Android/i.test(userAgent)) return "device";
  if (/Macintosh/i.test(userAgent)) return "apple";
  return "google";
}

export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^0-9+]/g, "")}`;
}
