"use client";

import { useActionState, useState, useTransition } from "react";
import type { FormState } from "@/app/auth/actions";
import type { MfaSetupState } from "@/app/auth/mfa-actions";
import { Field, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export function MfaChallengeForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      <Field label="Authenticator code or recovery code" name="code" state={state} required autoComplete="one-time-code"
        inputMode="text" maxLength={20} hint="Open your authenticator app and enter the 6-digit code." />
      <SubmitButton>Verify</SubmitButton>
    </form>
  );
}

export function MfaSetup({
  begin,
  confirm,
}: {
  begin: () => Promise<MfaSetupState>;
  confirm: (prev: MfaSetupState, form: FormData) => Promise<MfaSetupState>;
}) {
  const [setup, setSetup] = useState<MfaSetupState>({});
  const [pending, start] = useTransition();
  const [state, formAction] = useActionState(confirm, {} as MfaSetupState);

  if (state.recoveryCodes) {
    return (
      <div className="grid gap-3">
        <FormMessage state={state} />
        <h2 className="text-lg font-semibold">Save your recovery codes</h2>
        <p className="text-sm">
          Each code works once if you lose your phone. They are shown <strong>only now</strong>. Store them somewhere safe (a password manager, not email).
        </p>
        <ul className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface p-3 font-mono text-sm">
          {state.recoveryCodes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <a className="btn btn-primary justify-self-start" href="/dashboard">I saved them — continue</a>
      </div>
    );
  }

  if (!setup.secret) {
    return (
      <div className="grid gap-3">
        <FormMessage state={setup} />
        <button type="button" className="btn btn-primary justify-self-start" disabled={pending} onClick={() => start(async () => setSetup(await begin()))}>
          {pending ? "Working…" : "Set up an authenticator app"}
        </button>
      </div>
    );
  }

  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      <ol className="grid gap-1 text-sm">
        <li>1. Install an authenticator app (any TOTP app works).</li>
        <li>2. Scan this code, or type the key by hand.</li>
        <li>3. Enter the 6-digit code it shows.</li>
      </ol>
      {setup.qrSvg && (
        <div role="img" aria-label="QR code for your authenticator app" className="w-48 rounded-lg border border-line bg-white p-1"
          dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
      )}
      <p className="text-sm">Key: <code className="select-all break-all font-mono">{setup.secret}</code></p>
      <Field label="6-digit code" name="code" state={state} required autoComplete="one-time-code" inputMode="numeric" maxLength={6} pattern="[0-9]{6}" />
      <SubmitButton>Turn on multi-factor authentication</SubmitButton>
    </form>
  );
}
