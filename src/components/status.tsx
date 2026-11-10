import { displayAvailability, VISIBILITY_LABELS, type AvailabilityStatus, type Freshness, type Visibility } from "@/lib/domain";
import { StatusPill } from "./status-icons";

/** Resource availability: semantic color + icon + text (never color alone). */
export function AvailabilityBadge({ status, freshness }: { status: string; freshness: string }) {
  const d = displayAvailability(status as AvailabilityStatus, freshness as Freshness);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusPill kind={d.kind} label={d.label} />
      {d.note && <span className="text-xs text-muted">{d.note}</span>}
    </span>
  );
}

const VIS: Record<Visibility, { short: string; icon: React.ReactNode }> = {
  PUBLIC: { short: "Public", icon: <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13" /> },
  ORGANIZATION_NETWORK: { short: "Org network", icon: <path d="M5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm6 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM1.5 13c0-2 1.6-3.5 3.5-3.5S8.5 11 8.5 13m-1 0c0-2 1.6-3.5 3.5-3.5s3.5 1.5 3.5 3.5" /> },
  AUTHORIZED_RESPONDERS: { short: "Responders", icon: <path d="M8 1.5l5.5 2v4c0 3.3-2.3 5.9-5.5 7-3.2-1.1-5.5-3.7-5.5-7v-4z" /> },
  PRIVATE_ORGANIZATION: { short: "Private", icon: <path d="M4 7.5h8v6.5H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5" /> },
};

/** Who can see a record. Brand-neutral colors so it is never confused with resource status. */
export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  const v = VIS[visibility];
  return (
    <span className={`badge ${visibility === "PUBLIC" ? "tone-brand" : "border border-line bg-surface text-ink"}`} title={VISIBILITY_LABELS[visibility]}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>{v.icon}</svg>
      {v.short}
    </span>
  );
}

export function SyntheticBadge({ show }: { show: boolean }) {
  return show ? <span className="badge border border-dashed border-line bg-surface text-ink" title="Synthetic demo data — not a real resource">SYNTHETIC DEMO</span> : null;
}

export function Timestamp({ value, prefix }: { value: Date | string | null; prefix: string }) {
  if (!value) return <span className="text-xs text-muted">{prefix}: never</span>;
  const d = typeof value === "string" ? new Date(value) : value;
  return (
    <time dateTime={d.toISOString()} className="text-xs text-muted">
      {prefix}: {d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
    </time>
  );
}
