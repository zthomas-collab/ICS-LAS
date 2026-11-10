import { displayAvailability, VISIBILITY_LABELS, type AvailabilityStatus, type Freshness, type Visibility } from "@/lib/domain";

export function AvailabilityBadge({ status, freshness }: { status: string; freshness: string }) {
  const d = displayAvailability(status as AvailabilityStatus, freshness as Freshness);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={`badge tone-${d.tone}`}>{d.label}</span>
      {d.note && <span className="text-xs text-muted">{d.note}</span>}
    </span>
  );
}

export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  const tone = visibility === "PUBLIC" ? "ok" : visibility === "PRIVATE_ORGANIZATION" ? "bad" : "warn";
  return (
    <span className={`badge tone-${tone}`} title={VISIBILITY_LABELS[visibility]}>
      {visibility === "PUBLIC" ? "Public" : visibility === "ORGANIZATION_NETWORK" ? "Org network" : visibility === "AUTHORIZED_RESPONDERS" ? "Responders" : "Private"}
    </span>
  );
}

export function SyntheticBadge({ show }: { show: boolean }) {
  return show ? <span className="badge tone-warn" title="Synthetic demo data — not a real resource">SYNTHETIC DEMO</span> : null;
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
