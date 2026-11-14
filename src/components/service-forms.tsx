"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { FormState } from "@/app/auth/actions";
import type { ServiceType } from "@/server/modules/directory";
import { ORG_TYPES, ORG_TYPE_LABELS } from "@/lib/domain";
import { SOCIAL_KINDS, SOCIAL_LABELS, type SocialKind } from "@/lib/links";
import type { County } from "@/server/modules/counties";
import { Field, FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export function ServiceSwatch({ type, size = "md" }: { type: Pick<ServiceType, "shortLabel" | "color" | "label">; size?: "sm" | "md" }) {
  const dim = size === "sm" ? "h-6 min-w-6 text-[10px]" : "h-8 min-w-8 text-xs";
  return (
    <span aria-hidden className={`inline-flex ${dim} items-center justify-center rounded-full px-1 font-bold text-white ring-2 ring-white`} style={{ background: type.color }}>
      {type.shortLabel}
    </span>
  );
}

export function ServiceBadge({ type }: { type: Pick<ServiceType, "shortLabel" | "color" | "label"> }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-0.5 pl-0.5 pr-2.5 text-xs font-semibold">
      <ServiceSwatch type={type} size="sm" />
      {type.label}
    </span>
  );
}

/** Primary type (single) + other services offered (multi). */
export function ServiceTypeFields({
  serviceTypes,
  state,
  primaryName = "primaryServiceType",
  primaryLabel = "Main service type (shown on the map legend)",
  defaultPrimary,
  defaultAdditional = [],
  showPrimary = true,
}: {
  serviceTypes: ServiceType[];
  state: FormState;
  primaryName?: string;
  primaryLabel?: string;
  defaultPrimary?: string | null;
  defaultAdditional?: string[];
  showPrimary?: boolean;
}) {
  const [primary, setPrimary] = useState(defaultPrimary ?? "");
  return (
    <div className="grid gap-3">
      {showPrimary && (
        <label className="field">
          <span>{primaryLabel}</span>
          <select name={primaryName} className="input" required value={primary} onChange={(e) => setPrimary(e.target.value)}>
            <option value="" disabled>Choose one…</option>
            {serviceTypes.map((t) => (
              <option key={t.code} value={t.code}>{t.label}</option>
            ))}
          </select>
          <FieldError state={state} name={primaryName} />
        </label>
      )}
      <fieldset className="rounded-lg border border-line p-3">
        <legend className="px-1 text-sm font-semibold">Other services you offer (optional)</legend>
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          {serviceTypes
            .filter((t) => t.code !== primary)
            .map((t) => (
              <label key={t.code} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="additionalServiceTypes" value={t.code} defaultChecked={defaultAdditional.includes(t.code)} />
                <ServiceSwatch type={t} size="sm" />
                {t.label}
              </label>
            ))}
        </div>
      </fieldset>
    </div>
  );
}

export function ConsentField({ defaultChecked }: { defaultChecked?: boolean }) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-line p-3 text-sm">
      <input type="checkbox" name="directoryConsent" className="mt-1" defaultChecked={defaultChecked} />
      <span>
        <strong>List us in public Contacts.</strong> Anyone, without signing in, can see our organization name,
        service types, description, logo, public phone, public email, website, social links, counties served and office ZIP code. A platform administrator approves the profile before it appears. You can withdraw this at any time from your
        organization profile. Your sign-in email is never published.
      </span>
    </label>
  );
}

export function ProfileForm({
  action,
  serviceTypes,
  counties,
  initial,
}: {
  action: Action;
  serviceTypes: ServiceType[];
  counties: Pick<County, "id" | "name" | "state">[];
  initial: { description: string | null; website: string | null; publicPhone: string | null; publicEmail: string | null; publicPostalCode: string | null; additional: string[]; consent: boolean; primary: string | null; social: Partial<Record<SocialKind, string>>; countyIds: string[] };
}) {
  const [state, formAction] = useActionState(action, {});
  const primaryType = serviceTypes.find((t) => t.code === initial.primary);
  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      <div className="text-sm">
        <span className="font-semibold">Main service type: </span>
        {primaryType ? <ServiceBadge type={primaryType} /> : <span className="text-muted">Set by a platform administrator at approval</span>}
        <p className="mt-1 text-muted">Only platform administrators can change the main type, because it controls how your locations appear on the public map.</p>
      </div>
      <label className="field">
        <span>Public description</span>
        <textarea name="description" className="input" rows={3} maxLength={2000} defaultValue={initial.description ?? ""} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="field">
          <span>Public phone</span>
          <input name="publicPhone" type="tel" className="input" maxLength={40} defaultValue={initial.publicPhone ?? ""} />
          <FieldError state={state} name="publicPhone" />
        </label>
        <label className="field">
          <span>Public email</span>
          <input name="publicEmail" type="email" className="input" maxLength={254} defaultValue={initial.publicEmail ?? ""} />
          <FieldError state={state} name="publicEmail" />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <label className="field">
          <span>Website</span>
          <input name="website" type="url" className="input" placeholder="https://" maxLength={300} defaultValue={initial.website ?? ""} />
          <FieldError state={state} name="website" />
        </label>
        <label className="field">
          <span>Office ZIP code</span>
          <input name="publicPostalCode" className="input" inputMode="numeric" pattern="[0-9]{5}" maxLength={5} defaultValue={initial.publicPostalCode ?? ""} />
          <FieldError state={state} name="publicPostalCode" />
        </label>
      </div>
      <p className="-mt-2 text-xs text-muted">The office ZIP lets people find you in Contacts by distance even if you have no public location on the map.</p>
      <fieldset className="rounded-lg border border-line p-3">
        <legend className="px-1 text-sm font-semibold">Social media and other links (optional)</legend>
        <div className="mt-1 grid gap-3 sm:grid-cols-2">
          {SOCIAL_KINDS.map((k) => (
            <label key={k} className="field">
              <span>{SOCIAL_LABELS[k]}</span>
              <input name={`social_${k}`} type="url" className="input" placeholder="https://" maxLength={300} defaultValue={initial.social[k] ?? ""} />
            </label>
          ))}
        </div>
        <FieldError state={state} name="socialLinks" />
      </fieldset>
      {counties.length > 0 && (
        <fieldset className="rounded-lg border border-line p-3">
          <legend className="px-1 text-sm font-semibold">Counties you serve</legend>
          <div className="mt-1 grid max-h-56 gap-1 overflow-auto sm:grid-cols-2">
            {counties.map((c) => (
              <label key={c.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" name="countyIds" value={c.id} defaultChecked={initial.countyIds.includes(c.id)} />
                {c.name}, {c.state}
              </label>
            ))}
          </div>
          <FieldError state={state} name="countyIds" />
        </fieldset>
      )}
      <ServiceTypeFields serviceTypes={serviceTypes} state={state} showPrimary={false} defaultPrimary={initial.primary} defaultAdditional={initial.additional} />
      <ConsentField defaultChecked={initial.consent} />
      <SubmitButton>Save profile</SubmitButton>
    </form>
  );
}

export function PhotoForm({ uploadAction, removeAction, hasPhoto }: { uploadAction: Action; removeAction: Action; hasPhoto: boolean }) {
  const [state, formAction] = useActionState(uploadAction, {});
  const [removeState, removeFormAction] = useActionState(removeAction, {});
  const formRef = useRef<HTMLFormElement>(null);
  // The preview belongs to the form state it was chosen in; a new (successful) state hides it.
  const [picked, setPicked] = useState<{ url: string; forState: FormState } | null>(null);
  const preview = picked && picked.forState === state ? picked.url : null;
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);
  useEffect(() => () => { if (picked) URL.revokeObjectURL(picked.url); }, [picked]);
  return (
    <div className="grid gap-3">
      <form ref={formRef} action={formAction} className="grid gap-3">
        <FormMessage state={state} />
        <label className="field">
          <span>{hasPhoto ? "Replace photo" : "Add a photo of this location"}</span>
          <small className="text-muted">JPEG, PNG or WebP, up to 5 MB. Location (GPS) data in the file is removed. Don&apos;t include faces, license plates or people needing help.</small>
          <input
            name="image"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className="input"
            required
            onChange={(e) => {
              const f = e.target.files?.[0];
              setPicked(f ? { url: URL.createObjectURL(f), forState: state } : null);
            }}
          />
          <FieldError state={state} name="image" />
        </label>
        {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
        {preview && <img src={preview} alt="Selected photo preview" className="max-h-48 w-auto rounded-lg object-cover" />}
        <label className="field">
          <span>Describe the photo</span>
          <input name="altText" className="input" required minLength={3} maxLength={300} placeholder="Front entrance with blue tent" />
          <FieldError state={state} name="altText" />
        </label>
        <SubmitButton>{hasPhoto ? "Replace photo" : "Upload photo"}</SubmitButton>
      </form>
      {hasPhoto && (
        <form
          action={removeFormAction}
          onSubmit={(e) => {
            if (!window.confirm("Remove this photo from the site? It will disappear from the map.")) e.preventDefault();
          }}
          className="grid gap-2"
        >
          <FormMessage state={removeState} />
          <SubmitButton className="btn btn-danger justify-self-start">Remove photo</SubmitButton>
        </form>
      )}
    </div>
  );
}

export function ServiceTypeChangeForm({ action, orgId, serviceTypes, current }: { action: Action; orgId: string; serviceTypes: ServiceType[]; current: string | null }) {
  const [state, formAction] = useActionState(action, {});
  if (state.ok) return <FormMessage state={state} />;
  return (
    <form action={formAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <input type="hidden" name="orgId" value={orgId} />
      <label className="field">
        <span>Service type</span>
        <select name="primaryServiceType" className="input" defaultValue={current ?? ""} required>
          {serviceTypes.map((t) => (
            <option key={t.code} value={t.code}>{t.label}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Reason for change</span>
        <input name="evidenceSummary" className="input" required minLength={5} maxLength={4000} />
      </label>
      <SubmitButton className="btn btn-secondary">Change type</SubmitButton>
      <div className="sm:col-span-3"><FormMessage state={state} /></div>
    </form>
  );
}

export function RegisterForm({ action, serviceTypes }: { action: Action; serviceTypes: ServiceType[] }) {
  const [state, formAction] = useActionState(action, {});
  if (state.ok) return <FormMessage state={state} />;
  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      <Field label="Organization display name" name="displayName" state={state} required maxLength={120} />
      <Field label="Legal name" name="legalName" state={state} required maxLength={200} />
      <label className="field">
        <span>Organization type</span>
        <select name="orgType" className="input" required defaultValue="NONPROFIT">
          {ORG_TYPES.map((t) => (
            <option key={t} value={t}>{ORG_TYPE_LABELS[t]}</option>
          ))}
        </select>
      </label>
      <Field label="Your name" name="contactName" state={state} required maxLength={120} autoComplete="name" />
      <Field label="Your work email" name="email" type="email" state={state} required autoComplete="email"
        hint="Used for sign-in and platform communication. Not published." />
      <Field label="Public website (optional)" name="website" type="url" state={state} placeholder="https://" />
      <ServiceTypeFields serviceTypes={serviceTypes} state={state} />
      <Field label="Public phone (optional)" name="publicPhone" type="tel" state={state} maxLength={40} />
      <Field label="Public email (optional)" name="publicEmail" type="email" state={state} maxLength={254}
        hint="Shown in Contacts if you opt in below. Can differ from your sign-in email." />
      <Field label="Office ZIP code (optional)" name="publicPostalCode" state={state} inputMode="numeric" maxLength={5}
        hint="Lets people find you in Contacts by distance." />
      <label className="field">
        <span>Public description (optional)</span>
        <textarea name="description" className="input" rows={3} maxLength={2000} />
      </label>
      <label className="field">
        <span>How can we verify your organization?</span>
        <small className="text-muted">EIN / 501(c)(3) letter, state registration number, agency contact, or references.</small>
        <textarea name="registrationNotes" className="input" rows={4} required minLength={10} maxLength={2000}
          aria-invalid={Boolean(state.fieldErrors?.registrationNotes)} />
        <FieldError state={state} name="registrationNotes" />
      </label>
      <ConsentField />
      <SubmitButton>Register organization</SubmitButton>
    </form>
  );
}


export function LogoForm({ uploadAction, removeAction, hasLogo, logoSrc }: { uploadAction: Action; removeAction: Action; hasLogo: boolean; logoSrc: string | null }) {
  const [state, formAction] = useActionState(uploadAction, {});
  const [removeState, removeFormAction] = useActionState(removeAction, {});
  return (
    <div className="grid gap-3">
      <h2 className="text-lg font-semibold">Logo</h2>
      {hasLogo && logoSrc && (
        // eslint-disable-next-line @next/next/no-img-element -- same-origin logo route
        <img src={logoSrc} alt="Current logo" width={72} height={72} className="h-[72px] w-[72px] rounded-lg border border-line bg-white object-contain" />
      )}
      <form action={formAction} className="grid gap-3">
        <FormMessage state={state} />
        <label className="field">
          <span>{hasLogo ? "Replace logo" : "Upload a logo"}</span>
          <small className="text-muted">JPEG, PNG or WebP, up to 5 MB. Shown at up to 512 px. Metadata is removed. The logo appears once your profile is approved and public.</small>
          <input name="logo" type="file" accept="image/jpeg,image/png,image/webp" className="input" required />
          <FieldError state={state} name="logo" />
        </label>
        <label className="field">
          <span>Describe the logo</span>
          <input name="altText" className="input" required minLength={3} maxLength={300} placeholder="Green compass with the organization name" />
          <FieldError state={state} name="altText" />
        </label>
        <SubmitButton>{hasLogo ? "Replace logo" : "Upload logo"}</SubmitButton>
      </form>
      {hasLogo && (
        <form action={removeFormAction} className="grid gap-2">
          <FormMessage state={removeState} />
          <SubmitButton className="btn btn-danger justify-self-start">Remove logo</SubmitButton>
        </form>
      )}
    </div>
  );
}

export function ProfileReviewForm({ action, orgId, current }: { action: Action; orgId: string; current: string }) {
  const [state, formAction] = useActionState(action, {});
  if (state.ok) return <FormMessage state={state} />;
  const options = ["APPROVED", "HIDDEN", "PENDING"].filter((d) => d !== current);
  return (
    <form action={formAction} className="grid gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
      <input type="hidden" name="orgId" value={orgId} />
      <label className="field">
        <span>Profile decision</span>
        <select name="decision" className="input" defaultValue={options[0]}>
          {options.map((d) => (
            <option key={d} value={d}>{d === "APPROVED" ? "Approve" : d === "HIDDEN" ? "Hide from public" : "Return to review"}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Reason</span>
        <input name="note" className="input" required minLength={5} maxLength={2000} />
      </label>
      <SubmitButton className="btn btn-secondary">Record decision</SubmitButton>
      <div className="sm:col-span-3"><FormMessage state={state} /></div>
    </form>
  );
}
