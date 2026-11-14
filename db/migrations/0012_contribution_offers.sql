-- 0012: volunteer and donation offers (public intake, executive/county review).
--
-- Additive and reversible (DROP the two tables, the sequence and the three functions).
--  * Every submission is a database row first. Email is only a notification (queued, retried by the
--    existing notification worker); it is never the only record.
--  * Each row gets a unique reference number (OFR-YYYY-NNNNNN).
--  * Offers are never visible to anonymous users. Executives see all; a county administrator sees offers
--    in their counties; offers whose county is not yet known are executive-only.
--  * Status changes are validated by a trigger and recorded in an append-only event table.
-- The notification destination lives in platform_settings ('offers_notification_email'), set by an
-- executive in administration, never in source code.

CREATE SEQUENCE offer_reference_seq;

CREATE TABLE contribution_offers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference         text NOT NULL UNIQUE
                    DEFAULT ('OFR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('offer_reference_seq')::text, 6, '0')),
  contributor_name  text NOT NULL CHECK (length(contributor_name) BETWEEN 2 AND 120),
  organization_name text CHECK (organization_name IS NULL OR length(organization_name) <= 160),
  email             text NOT NULL CHECK (length(email) BETWEEN 5 AND 254),
  phone             text CHECK (phone IS NULL OR length(phone) BETWEEN 7 AND 40),
  county_id         uuid REFERENCES counties(id),
  zip               text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  contribution_type text NOT NULL CHECK (contribution_type IN
                    ('VOLUNTEER_LABOR','PROFESSIONAL_SKILLS','EQUIPMENT','TRANSPORTATION','DRINKING_WATER','FOOD',
                     'BUILDING_SUPPLIES','CLEANING_SUPPLIES','STORAGE_SPACE','OTHER')),
  quantity          numeric(12,2) CHECK (quantity IS NULL OR quantity > 0),
  unit              text CHECK (unit IS NULL OR length(unit) <= 40),
  description       text NOT NULL CHECK (length(description) BETWEEN 5 AND 2000),
  available_from    date,
  available_until   date,
  delivery_notes    text CHECK (delivery_notes IS NULL OR length(delivery_notes) <= 1000),
  preferred_project text CHECK (preferred_project IS NULL OR length(preferred_project) <= 140),
  consent_contact   boolean NOT NULL CHECK (consent_contact),
  consent_share     boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'SUBMITTED'
                    CHECK (status IN ('SUBMITTED','REVIEWED','MATCHED','ACCEPTED','SCHEDULED','COMPLETED','DECLINED','CANCELED','EXPIRED')),
  assigned_admin_id uuid REFERENCES users(id),
  is_synthetic      boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (available_until IS NULL OR available_from IS NULL OR available_until >= available_from)
);
CREATE INDEX offers_county_status_idx ON contribution_offers (county_id, status, created_at DESC);
CREATE INDEX offers_email_recent_idx ON contribution_offers (lower(email), created_at DESC);
CREATE TRIGGER offers_touch BEFORE UPDATE ON contribution_offers FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

CREATE TABLE contribution_offer_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id      uuid NOT NULL REFERENCES contribution_offers(id),
  actor_user_id uuid REFERENCES users(id),
  actor_role    text NOT NULL CHECK (actor_role IN ('CONTRIBUTOR','COUNTY_ADMIN','EXECUTIVE','SYSTEM')),
  event_type    text NOT NULL CHECK (event_type IN ('SUBMITTED','STATUS_CHANGED','NOTE','COUNTY_ASSIGNED')),
  from_status   text,
  to_status     text,
  note          text CHECK (note IS NULL OR length(note) <= 2000),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offer_events_offer_idx ON contribution_offer_events (offer_id, created_at);
CREATE TRIGGER offer_events_append_only BEFORE UPDATE OR DELETE ON contribution_offer_events
  FOR EACH ROW EXECUTE FUNCTION ics.reject_mutation();

CREATE FUNCTION ics.offer_transition_ok(f text, t text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (f, t) IN (
    ('SUBMITTED','REVIEWED'), ('SUBMITTED','DECLINED'), ('SUBMITTED','CANCELED'), ('SUBMITTED','EXPIRED'),
    ('REVIEWED','MATCHED'), ('REVIEWED','DECLINED'), ('REVIEWED','CANCELED'), ('REVIEWED','EXPIRED'),
    ('MATCHED','ACCEPTED'), ('MATCHED','REVIEWED'), ('MATCHED','DECLINED'), ('MATCHED','CANCELED'), ('MATCHED','EXPIRED'),
    ('ACCEPTED','SCHEDULED'), ('ACCEPTED','CANCELED'), ('ACCEPTED','EXPIRED'),
    ('SCHEDULED','COMPLETED'), ('SCHEDULED','CANCELED')
  ) $$;

CREATE FUNCTION ics.offers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := nullif(current_setting('ics.actor_id', true), '')::uuid;
  actor_role text := nullif(current_setting('ics.actor_role', true), '');
  note text := nullif(current_setting('ics.event_note', true), '');
BEGIN
  IF NEW.email <> OLD.email OR NEW.zip <> OLD.zip OR NEW.contribution_type <> OLD.contribution_type
     OR NEW.created_at <> OLD.created_at OR NEW.reference <> OLD.reference THEN
    RAISE EXCEPTION 'submitted details cannot be changed' USING ERRCODE = '42501';
  END IF;
  -- A county can be filled in once (executive triage); it is never silently re-pointed.
  IF OLD.county_id IS NOT NULL AND NEW.county_id IS DISTINCT FROM OLD.county_id THEN
    RAISE EXCEPTION 'county cannot be changed once assigned' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT ics.offer_transition_ok(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF actor_role IS NULL OR (actor IS NULL AND actor_role <> 'SYSTEM') THEN
    RAISE EXCEPTION 'status changes must identify the actor' USING ERRCODE = '42501';
  END IF;
  NEW.status_changed_at := now();
  INSERT INTO contribution_offer_events (offer_id, actor_user_id, actor_role, event_type, from_status, to_status, note)
  VALUES (NEW.id, actor, actor_role, 'STATUS_CHANGED', OLD.status, NEW.status, note);
  RETURN NEW;
END $$;
CREATE TRIGGER offers_guard_trg BEFORE UPDATE ON contribution_offers FOR EACH ROW EXECUTE FUNCTION ics.offers_guard();

-- Visibility: executives see everything; county administrators see their counties; an offer with no county yet is executive-only.
CREATE FUNCTION ics.can_view_offer(p_county uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT ics.is_platform_admin() OR (p_county IS NOT NULL AND p_county = ANY (ics.viewer_county_ids())) $$;

ALTER TABLE contribution_offers ENABLE ROW LEVEL SECURITY;
CREATE POLICY offers_select ON contribution_offers FOR SELECT TO ics_app USING (ics.can_view_offer(county_id));

ALTER TABLE contribution_offer_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY offer_events_select ON contribution_offer_events FOR SELECT TO ics_app USING (
  EXISTS (SELECT 1 FROM contribution_offers o WHERE o.id = offer_id AND ics.can_view_offer(o.county_id)));

GRANT SELECT ON contribution_offers, contribution_offer_events TO ics_app;
-- ics_anon gets nothing: offers are never readable without signing in as authorized staff.

INSERT INTO platform_settings (key, value) VALUES ('offers_notification_email', 'null'::jsonb) ON CONFLICT (key) DO NOTHING;
