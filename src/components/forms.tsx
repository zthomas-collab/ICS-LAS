"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "@/app/auth/actions";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export function FieldError({ state, name }: { state: FormState; name: string }) {
  const errs = state.fieldErrors?.[name];
  if (!errs?.length) return null;
  return (
    <span id={`${name}-error`} className="text-sm text-bad">
      {errs.join(", ")}
    </span>
  );
}

export function FormMessage({ state }: { state: FormState }) {
  if (state.error) return <p role="alert" className="rounded-md bg-bad-bg p-3 text-sm text-bad">{state.error}</p>;
  if (state.message) return <p role="status" className="rounded-md bg-ok-bg p-3 text-sm text-ok">{state.message}</p>;
  return null;
}

export function SubmitButton({ children, className = "btn btn-primary" }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending ? "Working…" : children}
    </button>
  );
}

export function Field(props: { label: string; name: string; state: FormState; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const { label, name, state, hint, ...rest } = props;
  const invalid = Boolean(state.fieldErrors?.[name]?.length);
  return (
    <label className="field">
      <span>{label}</span>
      {hint && <small className="text-muted">{hint}</small>}
      <input className="input" name={name} aria-invalid={invalid} aria-describedby={invalid ? `${name}-error` : undefined} {...rest} />
      <FieldError state={state} name={name} />
    </label>
  );
}

export function SignInForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      <Field label="Work email" name="email" type="email" state={state} required autoComplete="email" />
      <SubmitButton>Email me a sign-in link</SubmitButton>
    </form>
  );
}

/** Tokens are consumed by POST (button press), never by GET, so link scanners cannot burn them. */
export function TokenForm({ action, token, label }: { action: Action; token: string; label: string }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token} />
      <SubmitButton>{label}</SubmitButton>
    </form>
  );
}
