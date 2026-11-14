"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import type { County } from "@/server/modules/counties";
import { Field, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export function CreateCountyForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-[1fr_6rem_9rem_auto] sm:items-end">
      <div className="sm:col-span-4"><FormMessage state={state} /></div>
      <Field label="County name" name="name" state={state} required maxLength={80} placeholder="Buncombe" />
      <Field label="State" name="state" state={state} required maxLength={2} placeholder="NC" />
      <Field label="FIPS (optional)" name="fips" state={state} inputMode="numeric" maxLength={5} placeholder="37021" />
      <SubmitButton>Add county</SubmitButton>
    </form>
  );
}

export function AssignCountyAdminForm({ action, counties }: { action: Action; counties: Pick<County, "id" | "name" | "state">[] }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2"><FormMessage state={state} /></div>
      <Field label="Administrator email" name="email" type="email" state={state} required autoComplete="off"
        hint="They sign in with an emailed single-use link." />
      <label className="field">
        <span>County</span>
        <select name="countyId" className="input" required defaultValue="">
          <option value="" disabled>Choose a county…</option>
          {counties.map((c) => (
            <option key={c.id} value={c.id}>{c.name}, {c.state}</option>
          ))}
        </select>
      </label>
      <Field label="Reason for access" name="reason" state={state} required minLength={5} maxLength={2000} />
      <Field label="Expires (optional)" name="expiresAt" type="date" state={state} />
      <div className="sm:col-span-2"><SubmitButton>Assign county administrator</SubmitButton></div>
    </form>
  );
}

export function RevokeButton({ action, label }: { action: Action; label: string }) {
  const [state, formAction] = useActionState(action, {});
  if (state.ok) return <FormMessage state={state} />;
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm(`${label}? Their sessions will end immediately.`)) e.preventDefault();
      }}
      className="grid gap-1"
    >
      <FormMessage state={state} />
      <SubmitButton className="btn btn-danger">Revoke</SubmitButton>
    </form>
  );
}
