"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import type { ServiceType } from "@/server/modules/directory";
import { FieldError, FormMessage } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

const LABELS: Record<string, string> = {
  APPROVED: "Approve",
  REJECTED: "Reject",
  SUSPENDED: "Suspend publication (SOP-012)",
  REINSTATED: "Reinstate",
};

export function DecisionForm({
  action,
  orgId,
  decisions,
  compact,
  serviceTypes,
  defaultServiceType,
}: {
  action: Action;
  orgId: string;
  decisions: string[];
  compact?: boolean;
  serviceTypes?: ServiceType[];
  defaultServiceType?: string | null;
}) {
  const [state, formAction] = useActionState(action, {});
  if (state.ok) return <FormMessage state={state} />;
  return (
    <form action={formAction} className="grid gap-2">
      <FormMessage state={state} />
      <input type="hidden" name="orgId" value={orgId} />
      {serviceTypes && decisions.includes("APPROVED") && (
        <label className="field">
          <span>Confirmed service type (required to approve — sets the map legend color)</span>
          <select name="primaryServiceType" className="input" defaultValue={defaultServiceType ?? ""}>
            <option value="">Choose…</option>
            {serviceTypes.map((t) => (
              <option key={t.code} value={t.code}>{t.label}</option>
            ))}
          </select>
          <FieldError state={state} name="primaryServiceType" />
        </label>
      )}
      <label className="field">
        <span>{compact ? "Reason" : "Evidence summary (what you verified)"}</span>
        <textarea name="evidenceSummary" className="input" rows={compact ? 1 : 3} required minLength={5} maxLength={4000} />
        <FieldError state={state} name="evidenceSummary" />
      </label>
      <div className="flex flex-wrap gap-2">
        {decisions.map((d) => (
          <button key={d} name="decision" value={d} type="submit"
            className={`btn ${d === "APPROVED" || d === "REINSTATED" ? "btn-primary" : "btn-danger"}`}>
            {LABELS[d]}
          </button>
        ))}
      </div>
    </form>
  );
}
