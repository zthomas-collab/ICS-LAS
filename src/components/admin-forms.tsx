"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import { FieldError, FormMessage } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

const LABELS: Record<string, string> = {
  APPROVED: "Approve",
  REJECTED: "Reject",
  SUSPENDED: "Suspend publication (SOP-012)",
  REINSTATED: "Reinstate",
};

export function DecisionForm({ action, orgId, decisions, compact }: { action: Action; orgId: string; decisions: string[]; compact?: boolean }) {
  const [state, formAction] = useActionState(action, {});
  if (state.ok) return <FormMessage state={state} />;
  return (
    <form action={formAction} className="grid gap-2">
      <FormMessage state={state} />
      <input type="hidden" name="orgId" value={orgId} />
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
