"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { FormState } from "@/app/auth/actions";
import {
  AVAILABILITY_LABELS,
  AVAILABILITY_STATUSES,
  VISIBILITY_LABELS,
  VISIBILITY_LEVELS,
  VISIBILITY_RANK,
  type Visibility,
} from "@/lib/domain";
import { FieldError, FormMessage, SubmitButton } from "./forms";

type Action = (prev: FormState, form: FormData) => Promise<FormState>;

export type SiteFormValues = {
  name?: string; description?: string | null; visibility?: Visibility; lat?: number; lng?: number;
  addressLine?: string | null; city?: string | null; county?: string | null; state?: string | null;
  postalCode?: string | null; hoursText?: string | null; publicPhone?: string | null;
};

function Text({ label, name, state, value, ...rest }: { label: string; name: string; state: FormState; value?: string | number | null } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value">) {
  return (
    <label className="field">
      <span>{label}</span>
      <input className="input" name={name} defaultValue={value ?? ""} aria-invalid={Boolean(state.fieldErrors?.[name])} {...rest} />
      <FieldError state={state} name={name} />
    </label>
  );
}

export function SiteForm({ action, initial = {}, submitLabel }: { action: Action; initial?: SiteFormValues; submitLabel: string }) {
  const [state, formAction] = useActionState(action, {});
  const [lat, setLat] = useState(initial.lat?.toString() ?? "");
  const [lng, setLng] = useState(initial.lng?.toString() ?? "");
  const [locMsg, setLocMsg] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>(initial.visibility ?? "PRIVATE_ORGANIZATION");

  function useMyLocation() {
    if (!navigator.geolocation) return setLocMsg("Location is not available on this device.");
    setLocMsg("Locating…");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLat(p.coords.latitude.toFixed(6));
        setLng(p.coords.longitude.toFixed(6));
        setLocMsg(`Location set (±${Math.round(p.coords.accuracy)} m). Check it before saving.`);
      },
      () => setLocMsg("Could not get your location. Enter coordinates manually."),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  return (
    <form action={formAction} className="grid gap-4">
      <FormMessage state={state} />
      <Text label="Site name" name="name" state={state} value={initial.name} required maxLength={160} />
      <label className="field">
        <span>Who can see this site?</span>
        <select name="visibility" className="input" value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
          {VISIBILITY_LEVELS.map((v) => (
            <option key={v} value={v}>{VISIBILITY_LABELS[v]}</option>
          ))}
        </select>
        {visibility === "PUBLIC" ? (
          <small className="text-warn">Public: the exact location, address and phone will be shown to anyone without sign-in.</small>
        ) : (
          <small className="text-muted">Not shown on the public map or in public search.</small>
        )}
      </label>
      <fieldset className="grid gap-3 rounded-lg border border-line p-3">
        <legend className="px-1 text-sm font-semibold">Location</legend>
        <div className="grid grid-cols-2 gap-3">
          <label className="field">
            <span>Latitude</span>
            <input className="input" name="lat" inputMode="decimal" required value={lat} onChange={(e) => setLat(e.target.value)} />
            <FieldError state={state} name="lat" />
          </label>
          <label className="field">
            <span>Longitude</span>
            <input className="input" name="lng" inputMode="decimal" required value={lng} onChange={(e) => setLng(e.target.value)} />
            <FieldError state={state} name="lng" />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-secondary" onClick={useMyLocation}>Use my current location</button>
          {locMsg && <span role="status" className="text-sm text-muted">{locMsg}</span>}
        </div>
        <Text label="Street address (optional)" name="addressLine" state={state} value={initial.addressLine} maxLength={200} autoComplete="street-address" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Text label="City" name="city" state={state} value={initial.city} maxLength={100} />
          <Text label="County" name="county" state={state} value={initial.county} maxLength={100} />
          <Text label="State" name="state" state={state} value={initial.state} maxLength={2} placeholder="NC" />
          <Text label="ZIP" name="postalCode" state={state} value={initial.postalCode} maxLength={10} inputMode="numeric" />
        </div>
      </fieldset>
      <Text label="Hours (optional)" name="hoursText" state={state} value={initial.hoursText} maxLength={300} placeholder="Daily 8am–6pm" />
      <Text label="Public phone (optional)" name="publicPhone" state={state} value={initial.publicPhone} type="tel" maxLength={40} />
      <label className="field">
        <span>Description (optional)</span>
        <textarea className="input" name="description" rows={3} maxLength={2000} defaultValue={initial.description ?? ""} />
      </label>
      <SubmitButton>{submitLabel}</SubmitButton>
    </form>
  );
}

export function NewResourceForm({ action, categories, siteVisibility }: { action: Action; categories: { code: string; label: string }[]; siteVisibility: Visibility }) {
  const [state, formAction] = useActionState(action, {});
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);
  const allowed = VISIBILITY_LEVELS.filter((v) => VISIBILITY_RANK[v] >= VISIBILITY_RANK[siteVisibility]);
  return (
    <form ref={formRef} action={formAction} className="grid gap-3">
      <FormMessage state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="field">
          <span>Category</span>
          <select name="categoryCode" className="input" required>
            {categories.map((c) => (
              <option key={c.code} value={c.code}>{c.label}</option>
            ))}
          </select>
        </label>
        <Text label="Resource name" name="name" state={state} required maxLength={160} placeholder="Bottled water" />
        <label className="field">
          <span>Status</span>
          <select name="availabilityStatus" className="input" defaultValue="AVAILABLE">
            {AVAILABILITY_STATUSES.map((s) => (
              <option key={s} value={s}>{AVAILABILITY_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Visibility</span>
          <select name="visibility" className="input" defaultValue={siteVisibility}>
            {allowed.map((v) => (
              <option key={v} value={v}>{VISIBILITY_LABELS[v]}</option>
            ))}
          </select>
          <FieldError state={state} name="visibility" />
        </label>
        <Text label="Quantity (optional)" name="reportedQuantity" state={state} inputMode="decimal" />
        <Text label="Unit" name="quantityUnit" state={state} maxLength={40} placeholder="cases, beds, meals" />
        <label className="field">
          <span>Quantity basis</span>
          <select name="quantityBasis" className="input" defaultValue="REPORTED">
            <option value="REPORTED">Reported estimate</option>
            <option value="VERIFIED_COUNT">Verified physical count</option>
          </select>
        </label>
      </div>
      <SubmitButton>Add resource</SubmitButton>
    </form>
  );
}

/** Mobile one-tap status controls for a resource. */
export function ResourceQuickActions({ action, current }: { action: Action; current: string }) {
  const [state, formAction] = useActionState(action, {});
  const [showCorrection, setShowCorrection] = useState(false);
  return (
    <div className="grid gap-2">
      <FormMessage state={state} />
      <form action={formAction} className="flex flex-wrap gap-2">
        <input type="hidden" name="cmd" value="confirm" />
        <SubmitButton className="btn btn-primary">Still accurate</SubmitButton>
      </form>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Set status">
        {AVAILABILITY_STATUSES.filter((s) => s !== current).map((s) => (
          <form key={s} action={formAction}>
            <input type="hidden" name="cmd" value="status" />
            <input type="hidden" name="availabilityStatus" value={s} />
            <SubmitButton className="btn btn-secondary">{AVAILABILITY_LABELS[s]}</SubmitButton>
          </form>
        ))}
      </div>
      <button type="button" className="justify-self-start text-sm text-brand underline" onClick={() => setShowCorrection((v) => !v)}>
        {showCorrection ? "Hide" : "Update quantity / record correction"}
      </button>
      {showCorrection && (
        <form action={formAction} className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-2">
          <input type="hidden" name="cmd" value="status" />
          <label className="field">
            <span>Status</span>
            <select name="availabilityStatus" className="input" defaultValue={current}>
              {AVAILABILITY_STATUSES.map((s) => (
                <option key={s} value={s}>{AVAILABILITY_LABELS[s]}</option>
              ))}
            </select>
          </label>
          <Text label="Quantity" name="reportedQuantity" state={state} inputMode="decimal" />
          <Text label="Unit" name="quantityUnit" state={state} maxLength={40} />
          <label className="field">
            <span>Basis</span>
            <select name="quantityBasis" className="input">
              <option value="REPORTED">Reported estimate</option>
              <option value="VERIFIED_COUNT">Verified physical count</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="isCorrection" value="true" /> This corrects a previous wrong value (SOP-004)
          </label>
          <label className="field sm:col-span-2">
            <span>Note</span>
            <input className="input" name="note" maxLength={1000} />
            <FieldError state={state} name="note" />
          </label>
          <SubmitButton>Save update</SubmitButton>
        </form>
      )}
    </div>
  );
}

export function CommandButton({ action, cmd, label, confirmText, className }: { action: Action; cmd: string; label: string; confirmText?: string; className?: string }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirmText && !window.confirm(confirmText)) e.preventDefault();
      }}
      className="grid gap-2"
    >
      <input type="hidden" name="cmd" value={cmd} />
      <SubmitButton className={className ?? "btn btn-secondary"}>{label}</SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}
