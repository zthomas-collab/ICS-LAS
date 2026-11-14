"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/auth/actions";
import { Field, FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;
type County = { id: string; name: string; state: string };

export function OfferForm({ action, counties, types }: { action: Action; counties: County[]; types: { code: string; label: string }[] }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      {/* Trap field for bots: hidden from people and assistive technology. */}
      <div aria-hidden className="absolute -left-[9999px]">
        <label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label>
      </div>
      <label className="field">
        <span>What can you offer?</span>
        <select className="input" name="contributionType" required defaultValue="">
          <option value="" disabled>Choose one</option>
          {types.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
        </select>
        <FieldError state={state} name="contributionType" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Quantity or capacity (optional)" name="quantity" state={state} type="number" min="0" step="any" hint="For example 200, or 6 volunteers." />
        <Field label="Unit (optional)" name="unit" state={state} maxLength={40} hint="cases, pallets, hours, people…" />
      </div>
      <label className="field">
        <span>Describe your offer</span>
        <textarea className="input min-h-28" name="description" required minLength={5} maxLength={2000} />
        <FieldError state={state} name="description" />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Available from (optional)" name="availableFrom" state={state} type="date" />
        <Field label="Available until (optional)" name="availableUntil" state={state} type="date" />
      </div>
      <label className="field">
        <span>Pickup or delivery limits (optional)</span>
        <textarea className="input min-h-20" name="deliveryNotes" maxLength={1000} />
        <FieldError state={state} name="deliveryNotes" />
      </label>
      <fieldset className="grid gap-4 rounded-lg border border-line p-3">
        <legend className="px-1 text-sm font-semibold">Where are you?</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="ZIP code" name="zip" state={state} required inputMode="numeric" pattern="[0-9]{5}" maxLength={5} autoComplete="postal-code" />
          <label className="field">
            <span>County (optional)</span>
            <select className="input" name="countyId" defaultValue="">
              <option value="">Not sure</option>
              {counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}
            </select>
            <FieldError state={state} name="countyId" />
          </label>
        </div>
      </fieldset>
      <fieldset className="grid gap-4 rounded-lg border border-line p-3">
        <legend className="px-1 text-sm font-semibold">About you</legend>
        <Field label="Your name" name="contributorName" state={state} required autoComplete="name" />
        <Field label="Organization (optional)" name="organizationName" state={state} autoComplete="organization" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" name="email" type="email" state={state} required autoComplete="email" />
          <Field label="Phone (optional)" name="phone" type="tel" state={state} autoComplete="tel" />
        </div>
        <Field label="Project you would like to support (optional)" name="preferredProject" state={state} maxLength={140} />
      </fieldset>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="consentContact" className="mt-1 h-5 w-5" required />
        <span>You may contact me about this offer.</span>
      </label>
      <FieldError state={state} name="consentContact" />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="consentShare" className="mt-1 h-5 w-5" />
        <span>You may share my contact details with an approved organization that can use this offer (optional).</span>
      </label>
      <p className="rounded-md bg-neutral-bg p-3 text-sm">Sending an offer does not commit anyone to accept it, and we cannot guarantee it will be used.</p>
      <SubmitButton>Send my offer</SubmitButton>
    </form>
  );
}

function Mini({ action, submit, tone = "btn-secondary", children }: { action: Action; submit: string; tone?: string; children: React.ReactNode }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="grid gap-3">
      <FormMessage state={state} />
      {children}
      <div><SubmitButton className={`btn ${tone}`}>{submit}</SubmitButton></div>
    </form>
  );
}

export function OfferTransitionForm({ action, offerId, options, labels }: { action: Action; offerId: string; options: string[]; labels: Record<string, string> }) {
  if (options.length === 0) return <p className="text-sm text-muted">This offer is finished; no further changes are possible.</p>;
  return (
    <Mini action={action} submit="Update status" tone="btn-primary">
      <input type="hidden" name="offerId" value={offerId} />
      <label className="field"><span>Move to</span>
        <select className="input" name="to" required defaultValue="">
          <option value="" disabled>Choose a status</option>
          {options.map((o) => <option key={o} value={o}>{labels[o] ?? o}</option>)}
        </select></label>
      <label className="field"><span>Note (required to decline or cancel)</span><textarea className="input min-h-20" name="note" maxLength={2000} /></label>
    </Mini>
  );
}

export function OfferNoteForm({ action, offerId }: { action: Action; offerId: string }) {
  return (
    <Mini action={action} submit="Add note">
      <input type="hidden" name="offerId" value={offerId} />
      <label className="field"><span>Internal note</span><textarea className="input min-h-20" name="note" required minLength={2} maxLength={2000} /></label>
    </Mini>
  );
}

export function AssignCountyForm({ action, offerId, counties }: { action: Action; offerId: string; counties: County[] }) {
  return (
    <Mini action={action} submit="Assign county">
      <input type="hidden" name="offerId" value={offerId} />
      <label className="field"><span>County</span>
        <select className="input" name="countyId" required defaultValue="">
          <option value="" disabled>Choose a county</option>
          {counties.map((c) => <option key={c.id} value={c.id}>{c.name}, {c.state}</option>)}
        </select></label>
    </Mini>
  );
}

export function SettingsForm({ action, email }: { action: Action; email: string | null }) {
  return (
    <Mini action={action} submit="Save" tone="btn-primary">
      <label className="field">
        <span>Email address that receives new volunteer and donation offers</span>
        <small className="text-muted">Leave blank to turn notifications off. Offers are always saved and shown in the offers dashboard.</small>
        <input className="input" type="email" name="email" defaultValue={email ?? ""} autoComplete="off" maxLength={254} />
      </label>
    </Mini>
  );
}
