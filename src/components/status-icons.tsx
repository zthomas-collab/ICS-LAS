import type { StatusKind } from "@/lib/domain";

/** Icons that accompany every resource status (color is never the only cue). Decorative: text carries meaning. */
export function StatusIcon({ kind, size = 14 }: { kind: StatusKind; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": true as const, focusable: false as const };
  switch (kind) {
    case "available": // check in circle
      return (
        <svg {...common}><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="M4.5 8.2l2.2 2.2 4.8-4.8" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      );
    case "limited": // warning triangle
      return (
        <svg {...common}><path d="M8 1.5l7 12.5H1z" fill="currentColor" /><path d="M8 6v3.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /><circle cx="8" cy="11.8" r="1" fill="#fff" /></svg>
      );
    case "depleted": // x in circle
      return (
        <svg {...common}><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /></svg>
      );
    case "closed": // pause / closed sign
      return (
        <svg {...common}><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="currentColor" /><path d="M6.2 5v6M9.8 5v6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /></svg>
      );
    case "unknown":
    case "unconfirmed": // question mark in dashed circle
      return (
        <svg {...common}><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 1.6" /><path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.6c-.6.3-.8.6-.8 1.2v.4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /><circle cx="8" cy="11.6" r=".9" fill="currentColor" /></svg>
      );
  }
}

export function StatusPill({ kind, label }: { kind: StatusKind; label: string }) {
  return (
    <span className={`status status-${kind}`}>
      <StatusIcon kind={kind} />
      {label}
    </span>
  );
}
