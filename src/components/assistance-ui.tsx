import Link from "next/link";
import { STATUS_LABELS, CLOSURE_LABELS, type AppStatus, type ApplicationDetail, type ApplicationSummary, type ClosureReason } from "@/server/modules/assistance";

const TONE: Record<AppStatus, string> = {
  SUBMITTED: "tone-muted",
  UNDER_REVIEW: "tone-brand",
  INFO_REQUIRED: "tone-warn",
  APPROVED: "tone-ok",
  REFERRED: "tone-ok",
  IN_PROGRESS: "tone-brand",
  COMPLETED: "tone-ok",
  CLOSED: "tone-muted",
};

export function ApplicationStatusBadge({ status, closureReason }: { status: AppStatus; closureReason: ClosureReason | null }) {
  const label = status === "CLOSED" && closureReason ? CLOSURE_LABELS[closureReason] : STATUS_LABELS[status];
  return <span className={`badge ${TONE[status]}`}>{label}</span>;
}

const fmt = (d: Date) => d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

export function ApplicationRows({ rows, basePath }: { rows: ApplicationSummary[]; basePath: string }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((a) => (
        <li key={a.id} className="py-3">
          <Link className="font-semibold text-brand underline" href={`${basePath}/${a.id}`}>{a.summary}</Link>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <ApplicationStatusBadge status={a.status} closureReason={a.closureReason} />
            <span>{a.categoryLabel}</span>
            <span className="text-muted">{a.countyName} County · {a.zip}</span>
            <time className="text-xs text-muted" dateTime={a.statusChangedAt.toISOString()}>Updated {fmt(a.statusChangedAt)}</time>
          </div>
        </li>
      ))}
    </ul>
  );
}

const EVENT_LABELS: Record<string, string> = {
  SUBMITTED: "Submitted",
  STATUS_CHANGED: "Status changed",
  NOTE: "Message",
  INFO_PROVIDED: "Applicant replied",
  ROUTED: "Routing",
};

export function Timeline({ events }: { events: ApplicationDetail["events"] }) {
  return (
    <ol className="grid gap-3" aria-label="Application history">
      {events.map((e) => (
        <li key={e.id} className="border-l-4 border-gold pl-3">
          <div className="flex flex-wrap items-baseline gap-2 text-sm">
            <strong>{e.toStatus ? STATUS_LABELS[e.toStatus as AppStatus] ?? e.toStatus : EVENT_LABELS[e.type] ?? e.type}</strong>
            <span className="text-xs text-muted">{e.actorRole.toLowerCase().replace(/_/g, " ")}</span>
            <time className="text-xs text-muted" dateTime={e.at.toISOString()}>{fmt(e.at)}</time>
          </div>
          {e.note && <p className="mt-1 whitespace-pre-wrap text-sm">{e.note}</p>}
        </li>
      ))}
    </ol>
  );
}

export function NotReady() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <h1 className="text-2xl">Assistance requests are not open yet</h1>
      <p className="mt-3 text-muted">
        This feature is being prepared and cannot accept requests yet. In the meantime you can find help on the{" "}
        <Link className="underline" href="/">resource map</Link> or in <Link className="underline" href="/contacts">Contacts</Link>.
      </p>
      <p className="mt-3 rounded-md bg-bad-bg p-3 text-sm text-bad">
        <strong>Life-threatening emergency? Call 911.</strong> This site does not dispatch help.
      </p>
    </div>
  );
}
