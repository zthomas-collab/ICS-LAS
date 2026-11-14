-- 0010_assistance.sql
-- Crisis Compass Phase 2: public assistance applications. Additive.
--
-- This is the first table set in the system that holds personal information about residents.
-- Controls enforced in the database (in addition to checks in code):
--   * NO public view and NO grant to ics_anon. ics_app gets SELECT only; every write goes through
--     trusted server code (system context) after an explicit authorization check.
--   * Row-level security: an applicant sees only their own rows; a county administrator (or executive)
--     sees rows of counties they manage; a provider organization sees an application only after it has
--     been referred to it AND the applicant consented to sharing with providers.
--   * Status changes follow a fixed state machine enforced by a trigger, and the trigger itself writes the
--     audit event, so a status cannot change without an append-only history row.
--   * Events are append-only. Documents are quarantined until scanned CLEAN (enforced in code, recorded here).

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------
CREATE TABLE assistance_categories (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z_]{2,40}$'),
  label       text NOT NULL,
  description text,
  sort_order  int NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true
);
INSERT INTO assistance_categories (code, label, description, sort_order) VALUES
  ('HOUSING','Housing and shelter','Temporary shelter, repairs that make a home livable, rent or relocation help',10),
  ('FOOD_WATER','Food and water','Groceries, meals, drinking water',20),
  ('UTILITIES','Utilities','Power, water, gas, internet or sewer restoration or bills',30),
  ('CLEANUP_REPAIR','Cleanup and repair','Debris removal, mucking out, tarps, minor repairs',40),
  ('MEDICAL','Medical and health','Medications, equipment, health supplies',50),
  ('FINANCIAL','Financial assistance','Emergency funds, document replacement fees',60),
  ('TRANSPORTATION','Transportation','Rides, vehicle repair',70),
  ('OTHER','Something else','Anything not listed',900);
GRANT SELECT ON assistance_categories TO ics_anon, ics_app;

-- ---------------------------------------------------------------------------
-- Applicant profile (optional contact details reused across applications)
-- ---------------------------------------------------------------------------
CREATE TABLE user_profiles (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone      text CHECK (phone IS NULL OR length(phone) BETWEEN 7 AND 40),
  county_id  uuid REFERENCES counties(id),
  zip        text CHECK (zip IS NULL OR zip ~ '^[0-9]{5}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_profiles_touch BEFORE UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_profiles_select ON user_profiles FOR SELECT TO ics_app USING (user_id = ics.viewer_id());
GRANT SELECT ON user_profiles TO ics_app;

-- ---------------------------------------------------------------------------
-- Routing rules: who handles which county / ZIP / category. Most specific match wins.
-- ---------------------------------------------------------------------------
CREATE TABLE application_routing_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  county_id      uuid NOT NULL REFERENCES counties(id),
  zip            text CHECK (zip IS NULL OR zip ~ '^[0-9]{5}$'),
  category_code  text REFERENCES assistance_categories(code),
  handler_org_id uuid NOT NULL REFERENCES organizations(id),
  priority       int NOT NULL DEFAULT 100,
  note           text CHECK (note IS NULL OR length(note) <= 500),
  active         boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX routing_rules_lookup_idx ON application_routing_rules (county_id, active);
CREATE TRIGGER routing_rules_touch BEFORE UPDATE ON application_routing_rules FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();
ALTER TABLE application_routing_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY routing_rules_select ON application_routing_rules FOR SELECT TO ics_app USING (ics.can_manage_county(county_id));
GRANT SELECT ON application_routing_rules TO ics_app;

-- ---------------------------------------------------------------------------
-- Applications
-- ---------------------------------------------------------------------------
CREATE TABLE assistance_applications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  applicant_user_id    uuid NOT NULL REFERENCES users(id),
  county_id            uuid NOT NULL REFERENCES counties(id),
  zip                  text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  category_code        text NOT NULL REFERENCES assistance_categories(code),
  summary              text NOT NULL CHECK (length(summary) BETWEEN 5 AND 140),
  situation            text NOT NULL CHECK (length(situation) BETWEEN 10 AND 4000),
  household_size       int CHECK (household_size IS NULL OR household_size BETWEEN 1 AND 50),
  contact_phone        text CHECK (contact_phone IS NULL OR length(contact_phone) BETWEEN 7 AND 40),
  preferred_contact    text NOT NULL DEFAULT 'EMAIL' CHECK (preferred_contact IN ('EMAIL','PHONE')),
  -- Sharing the application with a provider organization requires the applicant's explicit consent.
  consent_share_providers boolean NOT NULL DEFAULT false,
  consent_recorded_at  timestamptz NOT NULL DEFAULT now(),
  status               text NOT NULL DEFAULT 'SUBMITTED'
                       CHECK (status IN ('SUBMITTED','UNDER_REVIEW','INFO_REQUIRED','APPROVED','REFERRED','IN_PROGRESS','COMPLETED','CLOSED')),
  closure_reason       text CHECK (closure_reason IS NULL OR closure_reason IN ('DENIED','CLOSED','WITHDRAWN','DUPLICATE')),
  referred_org_id      uuid REFERENCES organizations(id),
  suggested_org_id     uuid REFERENCES organizations(id),
  routing_rule_id      uuid REFERENCES application_routing_rules(id),
  is_synthetic         boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  status_changed_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'CLOSED') = (closure_reason IS NOT NULL)),
  CHECK (status NOT IN ('REFERRED') OR referred_org_id IS NOT NULL)
);
CREATE INDEX applications_applicant_idx ON assistance_applications (applicant_user_id, created_at DESC);
CREATE INDEX applications_county_status_idx ON assistance_applications (county_id, status, created_at DESC);
CREATE INDEX applications_org_idx ON assistance_applications (referred_org_id) WHERE referred_org_id IS NOT NULL;
CREATE TRIGGER applications_touch BEFORE UPDATE ON assistance_applications FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Events: the append-only audit trail and the applicant-visible timeline
-- ---------------------------------------------------------------------------
CREATE TABLE assistance_application_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id     uuid NOT NULL REFERENCES assistance_applications(id),
  actor_user_id      uuid REFERENCES users(id),
  actor_role         text NOT NULL CHECK (actor_role IN ('APPLICANT','COUNTY_ADMIN','EXECUTIVE','PROVIDER','SYSTEM')),
  actor_org_id       uuid REFERENCES organizations(id),
  event_type         text NOT NULL CHECK (event_type IN ('SUBMITTED','STATUS_CHANGED','NOTE','INFO_REQUESTED','INFO_PROVIDED','DOCUMENT_ADDED','DOCUMENT_REMOVED','ROUTED')),
  from_status        text,
  to_status          text,
  note               text CHECK (note IS NULL OR length(note) <= 2000),
  applicant_visible  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX application_events_app_idx ON assistance_application_events (application_id, created_at);
CREATE TRIGGER application_events_append_only BEFORE UPDATE OR DELETE ON assistance_application_events
  FOR EACH ROW EXECUTE FUNCTION ics.reject_mutation();

-- ---------------------------------------------------------------------------
-- Documents (bytes live in private object storage; only metadata is here)
-- ---------------------------------------------------------------------------
CREATE TABLE assistance_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES assistance_applications(id),
  uploaded_by    uuid NOT NULL REFERENCES users(id),
  storage_key    text NOT NULL UNIQUE CHECK (storage_key ~ '^documents/[0-9a-f-]{36}\.(webp|pdf)$'),
  content_type   text NOT NULL CHECK (content_type IN ('application/pdf','image/webp')),
  byte_size      int NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  sha256         text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  display_name   text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  scan_status    text NOT NULL DEFAULT 'NOT_SCANNED' CHECK (scan_status IN ('NOT_SCANNED','CLEAN','INFECTED','FAILED')),
  scan_detail    text CHECK (scan_detail IS NULL OR length(scan_detail) <= 200),
  scanned_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz
);
CREATE INDEX assistance_documents_app_idx ON assistance_documents (application_id) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------
-- State machine, enforced here as well as in code
-- ---------------------------------------------------------------------------
CREATE FUNCTION ics.application_transition_ok(f text, t text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (f, t) IN (
    ('SUBMITTED','UNDER_REVIEW'), ('SUBMITTED','CLOSED'),
    ('UNDER_REVIEW','INFO_REQUIRED'), ('UNDER_REVIEW','APPROVED'), ('UNDER_REVIEW','CLOSED'),
    ('INFO_REQUIRED','UNDER_REVIEW'), ('INFO_REQUIRED','CLOSED'),
    ('APPROVED','REFERRED'), ('APPROVED','IN_PROGRESS'), ('APPROVED','CLOSED'),
    ('REFERRED','IN_PROGRESS'), ('REFERRED','APPROVED'), ('REFERRED','CLOSED'),
    ('IN_PROGRESS','COMPLETED'), ('IN_PROGRESS','APPROVED'), ('IN_PROGRESS','CLOSED')
  ) $$;

-- Fields that must never change after submission.
CREATE FUNCTION ics.applications_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor uuid := nullif(current_setting('ics.actor_id', true), '')::uuid;
  actor_role text := nullif(current_setting('ics.actor_role', true), '');
  actor_org uuid := nullif(current_setting('ics.actor_org', true), '')::uuid;
  note text := nullif(current_setting('ics.event_note', true), '');
  visible boolean := coalesce(nullif(current_setting('ics.event_visible', true), '')::boolean, false);
BEGIN
  IF NEW.applicant_user_id <> OLD.applicant_user_id OR NEW.county_id <> OLD.county_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'applicant and county cannot be changed' USING ERRCODE = '42501';
  END IF;
  IF NEW.status = OLD.status THEN
    -- A referral target may be (re)assigned only through a status change.
    IF NEW.referred_org_id IS DISTINCT FROM OLD.referred_org_id THEN
      RAISE EXCEPTION 'referral changes require a status change' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ics.application_transition_ok(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'illegal status change % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'REFERRED' AND NOT NEW.consent_share_providers THEN
    RAISE EXCEPTION 'applicant has not consented to sharing with providers' USING ERRCODE = '23514';
  END IF;
  IF actor_role IS NULL OR (actor IS NULL AND actor_role <> 'SYSTEM') THEN
    RAISE EXCEPTION 'status changes must identify the actor' USING ERRCODE = '42501';
  END IF;
  NEW.status_changed_at := now();
  INSERT INTO assistance_application_events (application_id, actor_user_id, actor_role, actor_org_id, event_type, from_status, to_status, note, applicant_visible)
  VALUES (NEW.id, actor, actor_role, actor_org, 'STATUS_CHANGED', OLD.status, NEW.status, note, visible);
  RETURN NEW;
END $$;
CREATE TRIGGER applications_guard_trg BEFORE UPDATE ON assistance_applications FOR EACH ROW EXECUTE FUNCTION ics.applications_guard();

-- ---------------------------------------------------------------------------
-- Row-level security (request roles read only; all writes are trusted server code)
-- ---------------------------------------------------------------------------
-- Referral visibility: only to approved, active members of the organization it was referred to,
-- only with consent, and only while the work is with a provider.
CREATE FUNCTION ics.can_view_application_row(p_applicant uuid, p_county uuid, p_org uuid, p_status text, p_consent boolean)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT p_applicant = ics.viewer_id()
      OR ics.can_manage_county(p_county)
      OR (p_consent AND p_org IS NOT NULL AND p_status IN ('REFERRED','IN_PROGRESS','COMPLETED')
          AND p_org = ANY (ics.viewer_approved_org_ids())) $$;

ALTER TABLE assistance_applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY applications_select ON assistance_applications FOR SELECT TO ics_app
  USING (ics.can_view_application_row(applicant_user_id, county_id, referred_org_id, status, consent_share_providers));

ALTER TABLE assistance_application_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY application_events_select ON assistance_application_events FOR SELECT TO ics_app USING (
  EXISTS (SELECT 1 FROM assistance_applications a WHERE a.id = application_id AND (
        (a.applicant_user_id = ics.viewer_id() AND applicant_visible)
     OR ics.can_manage_county(a.county_id)
     OR (actor_org_id IS NOT NULL AND actor_org_id = ANY (ics.viewer_approved_org_ids()))
     OR (applicant_visible AND ics.can_view_application_row(a.applicant_user_id, a.county_id, a.referred_org_id, a.status, a.consent_share_providers)
         AND a.applicant_user_id <> ics.viewer_id()))));

ALTER TABLE assistance_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY assistance_documents_select ON assistance_documents FOR SELECT TO ics_app USING (
  removed_at IS NULL AND EXISTS (SELECT 1 FROM assistance_applications a WHERE a.id = application_id));

GRANT SELECT ON assistance_applications, assistance_application_events, assistance_documents TO ics_app;
