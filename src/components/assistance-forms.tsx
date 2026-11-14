"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import { Field, FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export function SignUpForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      <Field label="Your name" name="displayName" state={state} required autoComplete="name" />
      <Field label="Email address" name="email" type="email" state={state} required autoComplete="email" />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="acceptTerms" className="mt-1 h-5 w-5" required />
        <span>
          I have read the <a className="underline" href="/safety">privacy and safety notice</a> and agree that my information is used to
          review my request and contact me about it.
        </span>
      </label>
      <FieldError state={state} name="acceptTerms" />
      <SubmitButton>Email me a confirmation link</SubmitButton>
    </form>
  );
}

type County = { id: string; name: string; state: string };
type Category = { code: string; label: string; description: string };

export function ApplicationForm({ action, counties, categories }: { action: Action; counties: County[]; categories: Category[] }) {
  const [state, formAction] = useActionState(action, {});
  const sel = "input";
  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      <label className="field">
        <span>What kind of help do you need?</span>
        <select className={sel} name="categoryCode" required defaultValue="">
          <option value="" disabled>Choose one</option>
          {categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
        </select>
        <FieldError state={state} name="categoryCode" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="field">
          <span>County</span>
          <select className={sel} name="countyId" required defaultValue="">
            <option value="" disabled>Choose your county</option>
            {counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}
          </select>
          <FieldError state={state} name="countyId" />
        </label>
        <Field label="ZIP code" name="zip" state={state} required inputMode="numeric" pattern="[0-9]{5}" maxLength={5} autoComplete="postal-code"
          hint="If your ZIP code touches more than one county, choose the county where you live." />
      </div>
      <Field label="Short title" name="summary" state={state} required maxLength={140} hint="For example: Roof damage, no drinking water." />
      <label className="field">
        <span>Tell us what happened and what you need</span>
        <textarea className="input min-h-32" name="situation" required minLength={10} maxLength={4000} />
        <FieldError state={state} name="situation" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="People in your household (optional)" name="householdSize" state={state} type="number" min={1} max={50} />
        <Field label="Phone (optional)" name="contactPhone" state={state} type="tel" autoComplete="tel" />
      </div>
      <label className="field">
        <span>Best way to reach you</span>
        <select className={sel} name="preferredContact" defaultValue="EMAIL">
          <option value="EMAIL">Email</option>
          <option value="PHONE">Phone</option>
        </select>
        <FieldError state={state} name="preferredContact" />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="consentShareProviders" className="mt-1 h-5 w-5" />
        <span>
          If my application is approved, you may share it with an approved organization that can provide this help. Without this, only
          county staff can see it and nobody can refer it to a provider.
        </span>
      </label>
      <p className="rounded-md bg-neutral-bg p-3 text-sm">
        Do not put Social Security numbers, bank details or passwords in this form. Submitting does not guarantee assistance.
      </p>
      <SubmitButton>Submit request</SubmitButton>
    </form>
  );
}

function MiniForm({ action, children, submit, tone = "btn-secondary" }: { action: Action; children?: React.ReactNode; submit: string; tone?: string }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <FormMessage state={state} />
      {children}
      <div><SubmitButton className={`btn ${tone}`}>{submit}</SubmitButton></div>
    </form>
  );
}

export function WithdrawForm({ action, applicationId }: { action: Action; applicationId: string }) {
  return (
    <MiniForm action={action} submit="Withdraw my application" tone="btn-danger">
      <input type="hidden" name="applicationId" value={applicationId} />
    </MiniForm>
  );
}

export function ProvideInfoForm({ action, applicationId }: { action: Action; applicationId: string }) {
  return (
    <MiniForm action={action} submit="Send reply" tone="btn-primary">
      <input type="hidden" name="applicationId" value={applicationId} />
      <label className="field"><span>Your reply</span><textarea className="input min-h-24" name="message" required minLength={2} maxLength={2000} /></label>
    </MiniForm>
  );
}

export function UploadForm({ action, applicationId }: { action: Action; applicationId: string }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <FormMessage state={state} />
      <input type="hidden" name="applicationId" value={applicationId} />
      <label className="field">
        <span>Add a document or photo</span>
        <small className="text-muted">PDF, JPEG, PNG or WebP, up to 10 MB. Files are scanned before staff can open them.</small>
        <input className="input" type="file" name="document" accept="application/pdf,image/jpeg,image/png,image/webp" required />
        <FieldError state={state} name="document" />
      </label>
      <div><SubmitButton className="btn btn-secondary">Upload</SubmitButton></div>
    </form>
  );
}

export function RemoveDocumentForm({ action, applicationId, documentId }: { action: Action; applicationId: string; documentId: string }) {
  return (
    <MiniForm action={action} submit="Remove" tone="btn-danger">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="documentId" value={documentId} />
    </MiniForm>
  );
}

export function TransitionForm({
  action, applicationId, options, suggestedOrgId, labels,
}: { action: Action; applicationId: string; options: string[]; suggestedOrgId: string | null; labels: Record<string, string> }) {
  const [state, formAction] = useActionState(action, {});
  if (options.length === 0) return <p className="text-sm text-muted">No status changes are available from here.</p>;
  return (
    <form action={formAction} className="grid gap-3">
      <FormMessage state={state} />
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="referOrgId" value={suggestedOrgId ?? ""} />
      <label className="field">
        <span>Move to</span>
        <select className="input" name="to" required defaultValue="">
          <option value="" disabled>Choose a status</option>
          {options.map((o) => <option key={o} value={o}>{labels[o] ?? o}</option>)}
        </select>
        <FieldError state={state} name="to" />
      </label>
      <label className="field">
        <span>If closing, the reason</span>
        <select className="input" name="closureReason" defaultValue="">
          <option value="">Not closing</option>
          <option value="DENIED">Denied</option>
          <option value="CLOSED">Closed</option>
          <option value="DUPLICATE">Duplicate</option>
        </select>
        <FieldError state={state} name="closureReason" />
      </label>
      <label className="field">
        <span>Message to record (required to deny or to ask for information)</span>
        <textarea className="input min-h-20" name="note" maxLength={2000} />
        <FieldError state={state} name="note" />
      </label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="visibleToApplicant" className="h-5 w-5" /> Show this message to the applicant</label>
      <div><SubmitButton className="btn btn-primary">Update status</SubmitButton></div>
    </form>
  );
}

export function NoteForm({ action, applicationId }: { action: Action; applicationId: string }) {
  return (
    <MiniForm action={action} submit="Add note">
      <input type="hidden" name="applicationId" value={applicationId} />
      <label className="field"><span>Note</span><textarea className="input min-h-20" name="note" required minLength={2} maxLength={2000} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="visible" className="h-5 w-5" /> Show to the applicant</label>
    </MiniForm>
  );
}
