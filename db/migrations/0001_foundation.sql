-- 0001_foundation.sql
-- Foundational schema: identity, organizations, authorization, staging sites,
-- resources, availability, freshness, audit, notifications, SOP engine.
-- Target: PostgreSQL 16+ with PostGIS 3.4+ (also runs on PGlite 0.5 / PG 18 + PostGIS 3.6 for dev/test).

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS ics;

-- ---------------------------------------------------------------------------
-- Database roles. Tables are owned by the migration role (owner bypasses RLS; RLS is
-- deliberately NOT forced so owner-rights public views work). The application never queries as the owner for
-- request-scoped work:
--   ics_anon : anonymous visitors. SELECT on public_* read-model views only.
--   ics_app  : authenticated users. Base tables, filtered by row-level security.
-- Trusted server code (auth, registration, jobs, audit) uses the connection role.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ics_anon') THEN CREATE ROLE ics_anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ics_app')  THEN CREATE ROLE ics_app  NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public, ics TO ics_anon, ics_app;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
CREATE TYPE org_status AS ENUM ('PENDING_EMAIL','PENDING_VERIFICATION','APPROVED','REJECTED','SUSPENDED');
CREATE TYPE org_type AS ENUM ('NONPROFIT','RESPONSE_ORGANIZATION','GOVERNMENT_AGENCY','SERVICE_PROVIDER','CONTRACTOR','COMMUNITY_ORGANIZATION');
CREATE TYPE visibility_level AS ENUM ('PUBLIC','ORGANIZATION_NETWORK','AUTHORIZED_RESPONDERS','PRIVATE_ORGANIZATION');
CREATE TYPE availability_status AS ENUM ('AVAILABLE','LIMITED','DEPLETED','TEMPORARILY_CLOSED','UNKNOWN');
CREATE TYPE record_status AS ENUM ('ACTIVE','ARCHIVED');
CREATE TYPE membership_role AS ENUM ('ORG_ADMIN','EDITOR','VIEWER');
CREATE TYPE membership_status AS ENUM ('INVITED','ACTIVE','REVOKED');
CREATE TYPE platform_role AS ENUM ('PLATFORM_ADMIN','SECURITY_ADMIN','AUTHORIZED_RESPONDER','ROAD_VERIFIER');
CREATE TYPE quantity_basis AS ENUM ('REPORTED','VERIFIED_COUNT');

-- Visibility ordering: a resource may never be more visible than its site.
CREATE FUNCTION ics.visibility_rank(v visibility_level) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE v WHEN 'PUBLIC' THEN 0 WHEN 'ORGANIZATION_NETWORK' THEN 1
                WHEN 'AUTHORIZED_RESPONDERS' THEN 2 ELSE 3 END $$;

CREATE FUNCTION ics.touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE FUNCTION ics.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501'; END $$;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL CHECK (email = lower(email) AND position('@' in email) > 1),
  display_name      text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  email_verified_at timestamptz,
  mfa_enrolled_at   timestamptz,
  is_synthetic      boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (email);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

-- Single-use, hashed, expiring tokens (email confirmation, sign-in links, invitations).
CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id      uuid,
  purpose     text NOT NULL CHECK (purpose IN ('EMAIL_CONFIRM','SIGN_IN','INVITE')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_idx ON auth_tokens (user_id, purpose);

-- Server-side sessions so access can be revoked immediately (SOP-013).
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------------
CREATE TABLE organizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name            text NOT NULL CHECK (length(legal_name) BETWEEN 2 AND 200),
  display_name          text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 120),
  org_type              org_type NOT NULL,
  status                org_status NOT NULL DEFAULT 'PENDING_EMAIL',
  description           text CHECK (length(description) <= 2000),
  website               text CHECK (website IS NULL OR website ~ '^https?://'),
  public_phone          text CHECK (length(public_phone) <= 40),
  public_email          text CHECK (public_email IS NULL OR position('@' in public_email) > 1),
  -- Private: platform communication only. Not granted to ics_app (column privileges).
  contact_email         text NOT NULL,
  registration_notes    text CHECK (length(registration_notes) <= 2000),
  publication_suspended boolean NOT NULL DEFAULT false,
  is_synthetic          boolean NOT NULL DEFAULT false,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  approved_at           timestamptz,
  suspended_at          timestamptz
);
CREATE INDEX organizations_status_idx ON organizations (status);
CREATE TRIGGER organizations_touch BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

CREATE TABLE organization_memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        membership_role NOT NULL,
  status      membership_status NOT NULL DEFAULT 'ACTIVE',
  invited_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  UNIQUE (org_id, user_id)
);
CREATE INDEX memberships_user_idx ON organization_memberships (user_id) WHERE status = 'ACTIVE';
CREATE TRIGGER memberships_touch BEFORE UPDATE ON organization_memberships FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

-- Platform-level and operational roles. Operational authority (AUTHORIZED_RESPONDER)
-- is separate from organization verification and is geographically scoped.
CREATE TABLE role_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        platform_role NOT NULL,
  org_id      uuid REFERENCES organizations(id),          -- optional organizational scope
  scope_area  geography(MultiPolygon, 4326),             -- required for AUTHORIZED_RESPONDER
  reason      text NOT NULL,
  granted_by  uuid REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  revoked_by  uuid REFERENCES users(id),
  CHECK (role <> 'AUTHORIZED_RESPONDER' OR scope_area IS NOT NULL)
);
CREATE INDEX role_assignments_user_idx ON role_assignments (user_id, role) WHERE revoked_at IS NULL;
CREATE INDEX role_assignments_scope_gix ON role_assignments USING gist (scope_area);

CREATE TABLE organization_verifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  decision         text NOT NULL CHECK (decision IN ('APPROVED','REJECTED','SUSPENDED','REINSTATED','NOTE')),
  reviewer_id      uuid NOT NULL REFERENCES users(id),
  evidence_summary text NOT NULL CHECK (length(evidence_summary) BETWEEN 5 AND 4000),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX org_verifications_org_idx ON organization_verifications (org_id, created_at DESC);
CREATE TRIGGER org_verifications_append_only BEFORE UPDATE OR DELETE ON organization_verifications
  FOR EACH ROW EXECUTE FUNCTION ics.reject_mutation();

CREATE TABLE organization_service_areas (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  county     text,
  state      text CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  area       geography(MultiPolygon, 4326),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_areas_org_idx ON organization_service_areas (org_id);
CREATE INDEX service_areas_gix ON organization_service_areas USING gist (area);

-- ---------------------------------------------------------------------------
-- Platform settings (e.g. active operations mode that tightens freshness)
-- ---------------------------------------------------------------------------
CREATE TABLE platform_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (key, value) VALUES ('active_operations', 'false'::jsonb);

-- ---------------------------------------------------------------------------
-- Categories and freshness
-- ---------------------------------------------------------------------------
CREATE TABLE resource_categories (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z_]+$'),
  label       text NOT NULL,
  description text,
  sort_order  int NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true
);
INSERT INTO resource_categories (code, label, sort_order) VALUES
  ('FOOD','Food',10),('WATER','Water',20),('SHELTER','Shelter',30),
  ('MEDICAL_SUPPORT','Medical support listings',40),('TRANSPORTATION','Transportation',50),
  ('EQUIPMENT','Equipment',60),('FUEL','Fuel',70),('DEBRIS_REMOVAL','Debris removal',80),
  ('BUILDING_MATERIALS','Building materials',90),('VOLUNTEER_SUPPORT','Volunteer and nonprofit support',100),
  ('FINANCIAL_ASSISTANCE','Financial assistance',110),('HOUSING_ASSISTANCE','Housing assistance',120),
  ('REAL_ESTATE_TITLE_INFO','Real estate and title information',130),
  ('DISASTER_RECOVERY_SERVICES','Disaster recovery services',140);

CREATE TABLE freshness_policies (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type         text NOT NULL CHECK (subject_type IN ('RESOURCE','ROAD_INCIDENT','ORG_PROGRAM','DIRECTORY_CONTACT')),
  category_code        text REFERENCES resource_categories(code),
  interval_normal      interval NOT NULL CHECK (interval_normal > interval '0'),
  interval_active_ops  interval NOT NULL CHECK (interval_active_ops > interval '0'),
  due_soon_fraction    numeric NOT NULL DEFAULT 0.75 CHECK (due_soon_fraction > 0 AND due_soon_fraction < 1),
  updated_by           uuid REFERENCES users(id),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX freshness_policies_uq ON freshness_policies (subject_type, coalesce(category_code, '*'));
-- Proposed starting intervals (configurable; not universal limits).
INSERT INTO freshness_policies (subject_type, category_code, interval_normal, interval_active_ops) VALUES
  ('RESOURCE','SHELTER','12 hours','2 hours'),
  ('RESOURCE','FOOD','12 hours','4 hours'),
  ('RESOURCE','WATER','12 hours','4 hours'),
  ('RESOURCE','EQUIPMENT','24 hours','8 hours'),
  ('RESOURCE','FUEL','12 hours','4 hours'),
  ('RESOURCE','MEDICAL_SUPPORT','24 hours','8 hours'),
  ('RESOURCE','TRANSPORTATION','24 hours','8 hours'),
  ('RESOURCE',NULL,'7 days','7 days'),          -- default for non-time-sensitive categories
  ('ROAD_INCIDENT',NULL,'12 hours','2 hours'),
  ('ORG_PROGRAM',NULL,'7 days','7 days'),
  ('DIRECTORY_CONTACT',NULL,'90 days','90 days');

CREATE FUNCTION ics.freshness_interval(p_subject text, p_category text) RETURNS interval
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT CASE WHEN coalesce((SELECT value::text = 'true' FROM platform_settings WHERE key = 'active_operations'), false)
              THEN fp.interval_active_ops ELSE fp.interval_normal END
  FROM freshness_policies fp
  WHERE fp.subject_type = p_subject AND (fp.category_code = p_category OR fp.category_code IS NULL)
  ORDER BY fp.category_code NULLS LAST LIMIT 1 $$;

-- FRESH | DUE_SOON | EXPIRED | NEVER_CONFIRMED
CREATE FUNCTION ics.freshness_state(p_subject text, p_category text, p_last_confirmed timestamptz) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT CASE
    WHEN p_last_confirmed IS NULL THEN 'NEVER_CONFIRMED'
    WHEN now() > p_last_confirmed + ics.freshness_interval(p_subject, p_category) THEN 'EXPIRED'
    WHEN now() > p_last_confirmed + ics.freshness_interval(p_subject, p_category)
                 * (SELECT due_soon_fraction FROM freshness_policies
                     WHERE subject_type = p_subject AND (category_code = p_category OR category_code IS NULL)
                     ORDER BY category_code NULLS LAST LIMIT 1)::float8 THEN 'DUE_SOON'
    ELSE 'FRESH' END $$;

-- ---------------------------------------------------------------------------
-- Staging sites and resources
-- ---------------------------------------------------------------------------
CREATE TABLE staging_sites (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  name              text NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
  description       text CHECK (length(description) <= 2000),
  visibility        visibility_level NOT NULL DEFAULT 'PRIVATE_ORGANIZATION',
  location          geography(Point, 4326) NOT NULL,
  address_line      text CHECK (length(address_line) <= 200),
  city              text CHECK (length(city) <= 100),
  county            text CHECK (length(county) <= 100),
  state             text CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  postal_code       text CHECK (postal_code IS NULL OR postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  hours_text        text CHECK (length(hours_text) <= 300),
  public_phone      text CHECK (length(public_phone) <= 40),
  status            record_status NOT NULL DEFAULT 'ACTIVE',
  last_confirmed_at timestamptz,
  is_synthetic      boolean NOT NULL DEFAULT false,
  created_by        uuid NOT NULL REFERENCES users(id),
  updated_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE INDEX staging_sites_location_gix ON staging_sites USING gist (location);
-- Viewport (lat/lng rectangle) queries use planar bbox semantics; geography && is geodesic and over-inclusive.
CREATE INDEX staging_sites_location_geom_gix ON staging_sites USING gist ((location::geometry));
CREATE INDEX staging_sites_org_idx ON staging_sites (org_id);
CREATE INDEX staging_sites_public_idx ON staging_sites (visibility, status);
CREATE INDEX staging_sites_search_idx ON staging_sites (lower(city), lower(county), postal_code);
CREATE TRIGGER staging_sites_touch BEFORE UPDATE ON staging_sites FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

-- Optional allow-list narrowing ORGANIZATION_NETWORK visibility to named orgs.
CREATE TABLE site_access_policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        uuid NOT NULL REFERENCES staging_sites(id) ON DELETE CASCADE,
  allowed_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, allowed_org_id)
);

CREATE TABLE resources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES staging_sites(id),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  category_code text NOT NULL REFERENCES resource_categories(code),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
  description   text CHECK (length(description) <= 2000),
  visibility    visibility_level NOT NULL DEFAULT 'PRIVATE_ORGANIZATION',
  status        record_status NOT NULL DEFAULT 'ACTIVE',
  is_synthetic  boolean NOT NULL DEFAULT false,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);
CREATE INDEX resources_site_idx ON resources (site_id);
CREATE INDEX resources_category_idx ON resources (category_code);
CREATE TRIGGER resources_touch BEFORE UPDATE ON resources FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

-- Resource org must equal site org; resource can never be more visible than its site.
CREATE FUNCTION ics.resources_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, ics AS $$
DECLARE s staging_sites%ROWTYPE;
BEGIN
  SELECT * INTO s FROM staging_sites WHERE id = NEW.site_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'site not found'; END IF;
  IF s.org_id <> NEW.org_id THEN RAISE EXCEPTION 'resource org must match site org' USING ERRCODE = '42501'; END IF;
  IF ics.visibility_rank(NEW.visibility) < ics.visibility_rank(s.visibility) THEN
    RAISE EXCEPTION 'resource cannot be more visible than its site' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resources_guard_trg BEFORE INSERT OR UPDATE ON resources FOR EACH ROW EXECUTE FUNCTION ics.resources_guard();

-- Tightening a site's visibility tightens its resources (never loosens them).
CREATE FUNCTION ics.site_visibility_cascade() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, ics AS $$
BEGIN
  IF ics.visibility_rank(NEW.visibility) > ics.visibility_rank(OLD.visibility) THEN
    UPDATE resources SET visibility = NEW.visibility
     WHERE site_id = NEW.id AND ics.visibility_rank(visibility) < ics.visibility_rank(NEW.visibility);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER staging_sites_visibility_cascade AFTER UPDATE OF visibility ON staging_sites
  FOR EACH ROW EXECUTE FUNCTION ics.site_visibility_cascade();

-- Current availability (one row per resource). History lives in resource_update_events.
CREATE TABLE resource_availability (
  resource_id         uuid PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  availability_status availability_status NOT NULL DEFAULT 'UNKNOWN',
  reported_quantity   numeric CHECK (reported_quantity IS NULL OR reported_quantity >= 0),
  quantity_unit       text CHECK (length(quantity_unit) <= 40),
  quantity_basis      quantity_basis NOT NULL DEFAULT 'REPORTED',
  expected_until      timestamptz,
  last_confirmed_at   timestamptz,
  last_confirmed_by   uuid REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (reported_quantity IS NULL OR quantity_unit IS NOT NULL)
);
CREATE TRIGGER resource_availability_touch BEFORE UPDATE ON resource_availability FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

-- Append-only provenance of every material change.
CREATE TABLE resource_update_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id    uuid REFERENCES resources(id),
  site_id        uuid NOT NULL REFERENCES staging_sites(id),
  org_id         uuid NOT NULL REFERENCES organizations(id),
  actor_user_id  uuid NOT NULL REFERENCES users(id),
  event_type     text NOT NULL CHECK (event_type IN ('SITE_CREATED','SITE_EDITED','SITE_ARCHIVED','SITE_CONFIRMED',
                   'RESOURCE_CREATED','RESOURCE_EDITED','RESOURCE_ARCHIVED','AVAILABILITY_UPDATED','AVAILABILITY_CONFIRMED','CORRECTION')),
  quantity_basis quantity_basis,
  before_state   jsonb,
  after_state    jsonb,
  note           text CHECK (length(note) <= 1000),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resource_events_site_idx ON resource_update_events (site_id, created_at DESC);
CREATE INDEX resource_events_org_idx ON resource_update_events (org_id, created_at DESC);
CREATE TRIGGER resource_events_append_only BEFORE UPDATE OR DELETE ON resource_update_events
  FOR EACH ROW EXECUTE FUNCTION ics.reject_mutation();

-- ---------------------------------------------------------------------------
-- Notifications, audit, SOP engine
-- ---------------------------------------------------------------------------
CREATE TABLE notification_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,
  recipient_email text NOT NULL,
  subject         text NOT NULL,
  body_text       text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','SENT','FAILED','DEAD')),
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  run_after       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX notification_jobs_pending_idx ON notification_jobs (status, run_after);

CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid REFERENCES users(id),
  actor_org_id  uuid REFERENCES organizations(id),
  action        text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    uuid,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_logs_subject_idx ON audit_logs (subject_type, subject_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, occurred_at DESC);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION ics.reject_mutation();

CREATE TABLE operational_sop_definitions (
  code       text PRIMARY KEY CHECK (code ~ '^SOP-[0-9]{3}$'),
  title      text NOT NULL,
  version    int NOT NULL DEFAULT 1,
  definition jsonb NOT NULL,     -- trigger, initiating_role, required_fields, responsible, action, deadline, exception, escalation, evidence, completion
  active     boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sop_executions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sop_code     text NOT NULL REFERENCES operational_sop_definitions(code),
  subject_type text NOT NULL,
  subject_id   uuid NOT NULL,
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETED','EXPIRED','ESCALATED','CANCELLED')),
  initiated_by uuid REFERENCES users(id),
  completed_by uuid REFERENCES users(id),
  due_at       timestamptz,
  completed_at timestamptz,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sop_executions_open_idx ON sop_executions (sop_code, status, due_at);
CREATE INDEX sop_executions_subject_idx ON sop_executions (subject_type, subject_id);
CREATE TRIGGER sop_executions_touch BEFORE UPDATE ON sop_executions FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Authorization functions (SECURITY DEFINER: read membership/role tables
-- regardless of the caller's RLS). The viewer id comes from a transaction-local
-- setting written by trusted server code after session validation.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ics.viewer_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('ics.viewer_id', true), '')::uuid $$;

CREATE FUNCTION ics.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT EXISTS (SELECT 1 FROM role_assignments ra JOIN users u ON u.id = ra.user_id
                  WHERE ra.user_id = ics.viewer_id() AND ra.role = 'PLATFORM_ADMIN' AND u.status = 'ACTIVE'
                    AND ra.revoked_at IS NULL AND (ra.expires_at IS NULL OR ra.expires_at > now())) $$;

CREATE FUNCTION ics.is_member(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT EXISTS (SELECT 1 FROM organization_memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.org_id = p_org AND m.user_id = ics.viewer_id() AND m.status = 'ACTIVE' AND u.status = 'ACTIVE') $$;

-- Editors of an APPROVED, non-suspended org may write that org's data immediately.
CREATE FUNCTION ics.can_edit_org(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT EXISTS (SELECT 1 FROM organization_memberships m
                   JOIN organizations o ON o.id = m.org_id
                   JOIN users u ON u.id = m.user_id
                  WHERE m.org_id = p_org AND m.user_id = ics.viewer_id() AND m.status = 'ACTIVE'
                    AND m.role IN ('ORG_ADMIN','EDITOR') AND u.status = 'ACTIVE'
                    AND o.status = 'APPROVED' AND NOT o.publication_suspended) $$;

CREATE FUNCTION ics.viewer_approved_org_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT coalesce(array_agg(m.org_id), '{}') FROM organization_memberships m
    JOIN organizations o ON o.id = m.org_id JOIN users u ON u.id = m.user_id
   WHERE m.user_id = ics.viewer_id() AND m.status = 'ACTIVE' AND u.status = 'ACTIVE'
     AND o.status = 'APPROVED' AND NOT o.publication_suspended $$;

-- Row-based checks: policies pass the row's own columns, so INSERT ... RETURNING
-- (which evaluates SELECT policies on a row not yet visible to STABLE lookups) works.
CREATE FUNCTION ics.responder_covers(p_org uuid, p_loc geography) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT EXISTS (SELECT 1 FROM role_assignments ra JOIN users u ON u.id = ra.user_id
                  WHERE ra.user_id = ics.viewer_id() AND ra.role = 'AUTHORIZED_RESPONDER' AND u.status = 'ACTIVE'
                    AND ra.revoked_at IS NULL AND (ra.expires_at IS NULL OR ra.expires_at > now())
                    AND (ra.org_id IS NULL OR ra.org_id = p_org)
                    AND ST_Covers(ra.scope_area, p_loc)) $$;

CREATE FUNCTION ics.can_view_site_row(p_id uuid, p_org uuid, p_vis visibility_level, p_status record_status, p_loc geography)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
DECLARE o organizations%ROWTYPE; viewer_orgs uuid[];
BEGIN
  IF ics.viewer_id() IS NULL THEN RETURN false; END IF;
  IF ics.is_platform_admin() OR ics.is_member(p_org) THEN RETURN true; END IF;
  SELECT * INTO o FROM organizations WHERE id = p_org;
  IF p_status <> 'ACTIVE' OR o.status <> 'APPROVED' OR o.publication_suspended THEN RETURN false; END IF;
  IF p_vis = 'PUBLIC' THEN RETURN true; END IF;
  IF p_vis = 'ORGANIZATION_NETWORK' THEN
    viewer_orgs := ics.viewer_approved_org_ids();
    IF cardinality(viewer_orgs) = 0 THEN RETURN false; END IF;
    IF NOT EXISTS (SELECT 1 FROM site_access_policies WHERE site_id = p_id) THEN RETURN true; END IF;
    RETURN EXISTS (SELECT 1 FROM site_access_policies WHERE site_id = p_id AND allowed_org_id = ANY (viewer_orgs));
  END IF;
  IF p_vis = 'AUTHORIZED_RESPONDERS' THEN RETURN ics.responder_covers(p_org, p_loc); END IF;
  RETURN false; -- PRIVATE_ORGANIZATION: members/admins handled above
END $$;

CREATE FUNCTION ics.can_view_site(p_site uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT coalesce((SELECT ics.can_view_site_row(s.id, s.org_id, s.visibility, s.status, s.location)
                     FROM staging_sites s WHERE s.id = p_site), false) $$;

-- A resource is visible only if its site is visible AND the resource's own level admits the viewer.
CREATE FUNCTION ics.can_view_resource_row(p_site uuid, p_org uuid, p_vis visibility_level, p_status record_status)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
DECLARE s staging_sites%ROWTYPE;
BEGIN
  IF NOT ics.can_view_site(p_site) THEN RETURN false; END IF;
  IF ics.is_platform_admin() OR ics.is_member(p_org) THEN RETURN true; END IF;
  IF p_status <> 'ACTIVE' THEN RETURN false; END IF;
  SELECT * INTO s FROM staging_sites WHERE id = p_site;
  IF p_vis = 'PUBLIC' THEN RETURN true; END IF;
  IF p_vis = 'ORGANIZATION_NETWORK' THEN
    RETURN cardinality(ics.viewer_approved_org_ids()) > 0
       AND (NOT EXISTS (SELECT 1 FROM site_access_policies WHERE site_id = p_site)
            OR EXISTS (SELECT 1 FROM site_access_policies WHERE site_id = p_site AND allowed_org_id = ANY (ics.viewer_approved_org_ids())));
  END IF;
  IF p_vis = 'AUTHORIZED_RESPONDERS' THEN RETURN ics.responder_covers(p_org, s.location); END IF;
  RETURN false;
END $$;

CREATE FUNCTION ics.can_view_resource(p_resource uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT coalesce((SELECT ics.can_view_resource_row(r.site_id, r.org_id, r.visibility, r.status)
                     FROM resources r WHERE r.id = p_resource), false) $$;

-- ---------------------------------------------------------------------------
-- Row-level security for authenticated (ics_app) access
-- ---------------------------------------------------------------------------
ALTER TABLE staging_sites ENABLE ROW LEVEL SECURITY;
CREATE POLICY sites_select ON staging_sites FOR SELECT TO ics_app USING (ics.can_view_site_row(id, org_id, visibility, status, location));
CREATE POLICY sites_insert ON staging_sites FOR INSERT TO ics_app
  WITH CHECK (ics.can_edit_org(org_id) AND created_by = ics.viewer_id() AND updated_by = ics.viewer_id());
CREATE POLICY sites_update ON staging_sites FOR UPDATE TO ics_app
  USING (ics.can_edit_org(org_id) OR ics.is_platform_admin())
  WITH CHECK ((ics.can_edit_org(org_id) OR ics.is_platform_admin()) AND updated_by = ics.viewer_id());

ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
CREATE POLICY resources_select ON resources FOR SELECT TO ics_app USING (ics.can_view_resource_row(site_id, org_id, visibility, status));
CREATE POLICY resources_insert ON resources FOR INSERT TO ics_app
  WITH CHECK (ics.can_edit_org(org_id) AND created_by = ics.viewer_id());
CREATE POLICY resources_update ON resources FOR UPDATE TO ics_app
  USING (ics.can_edit_org(org_id) OR ics.is_platform_admin())
  WITH CHECK (ics.can_edit_org(org_id) OR ics.is_platform_admin());

ALTER TABLE resource_availability ENABLE ROW LEVEL SECURITY;
CREATE POLICY availability_select ON resource_availability FOR SELECT TO ics_app USING (ics.can_view_resource(resource_id));
CREATE POLICY availability_insert ON resource_availability FOR INSERT TO ics_app
  WITH CHECK (EXISTS (SELECT 1 FROM resources r WHERE r.id = resource_id AND ics.can_edit_org(r.org_id)));
CREATE POLICY availability_update ON resource_availability FOR UPDATE TO ics_app
  USING (EXISTS (SELECT 1 FROM resources r WHERE r.id = resource_id AND ics.can_edit_org(r.org_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM resources r WHERE r.id = resource_id AND ics.can_edit_org(r.org_id)));

ALTER TABLE resource_update_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_select ON resource_update_events FOR SELECT TO ics_app
  USING (ics.is_member(org_id) OR ics.is_platform_admin());
CREATE POLICY events_insert ON resource_update_events FOR INSERT TO ics_app
  WITH CHECK ((ics.can_edit_org(org_id) OR ics.is_platform_admin()) AND actor_user_id = ics.viewer_id());

ALTER TABLE site_access_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_access_select ON site_access_policies FOR SELECT TO ics_app
  USING (EXISTS (SELECT 1 FROM staging_sites s WHERE s.id = site_id AND (ics.is_member(s.org_id) OR ics.is_platform_admin())));
CREATE POLICY site_access_write ON site_access_policies FOR ALL TO ics_app
  USING (EXISTS (SELECT 1 FROM staging_sites s WHERE s.id = site_id AND ics.can_edit_org(s.org_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM staging_sites s WHERE s.id = site_id AND ics.can_edit_org(s.org_id)));

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY orgs_select ON organizations FOR SELECT TO ics_app
  USING (status = 'APPROVED' OR ics.is_member(id) OR ics.is_platform_admin());

ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_select ON organization_memberships FOR SELECT TO ics_app
  USING (user_id = ics.viewer_id() OR ics.is_member(org_id) OR ics.is_platform_admin());

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_insert ON audit_logs FOR INSERT TO ics_app WITH CHECK (actor_user_id = ics.viewer_id());
CREATE POLICY audit_select ON audit_logs FOR SELECT TO ics_app USING (ics.is_platform_admin());

-- Grants (least privilege; no DELETE anywhere for request roles).
GRANT SELECT, INSERT, UPDATE ON staging_sites, resources, resource_availability TO ics_app;
GRANT SELECT, INSERT ON resource_update_events, audit_logs TO ics_app;
GRANT SELECT, INSERT, DELETE ON site_access_policies TO ics_app;
GRANT SELECT ON resource_categories, freshness_policies, organization_memberships TO ics_app;
GRANT SELECT (id, legal_name, display_name, org_type, status, description, website, public_phone, public_email,
              publication_suspended, is_synthetic, created_at, updated_at, approved_at) ON organizations TO ics_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ics TO ics_app;

-- ---------------------------------------------------------------------------
-- Public read model (anonymous). Whitelisted columns only; owner-rights views
-- with explicit publication filters. ics_anon has no access to base tables.
-- ---------------------------------------------------------------------------
CREATE VIEW public_sites AS
SELECT s.id, s.org_id, o.display_name AS org_name, o.org_type,
       s.name, s.description,
       ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
       s.address_line, s.city, s.county, s.state, s.postal_code, s.hours_text, s.public_phone,
       s.last_confirmed_at, s.updated_at, (s.is_synthetic OR o.is_synthetic) AS is_synthetic,
       s.location
  FROM staging_sites s JOIN organizations o ON o.id = s.org_id
 WHERE s.visibility = 'PUBLIC' AND s.status = 'ACTIVE'
   AND o.status = 'APPROVED' AND NOT o.publication_suspended;

CREATE VIEW public_resources AS
SELECT r.id, r.site_id, r.category_code, c.label AS category_label, r.name, r.description,
       coalesce(a.availability_status, 'UNKNOWN') AS reported_status,
       ics.freshness_state('RESOURCE', r.category_code, a.last_confirmed_at) AS freshness,
       a.reported_quantity, a.quantity_unit, a.quantity_basis, a.expected_until, a.last_confirmed_at,
       a.last_confirmed_at + ics.freshness_interval('RESOURCE', r.category_code) AS review_due_at,
       r.is_synthetic
  FROM resources r
  JOIN public_sites ps ON ps.id = r.site_id
  JOIN resource_categories c ON c.code = r.category_code
  LEFT JOIN resource_availability a ON a.resource_id = r.id
 WHERE r.visibility = 'PUBLIC' AND r.status = 'ACTIVE';

CREATE VIEW public_organizations AS
SELECT o.id, o.display_name, o.org_type, o.description, o.website, o.public_phone, o.public_email,
       o.approved_at, o.is_synthetic
  FROM organizations o WHERE o.status = 'APPROVED' AND NOT o.publication_suspended;

GRANT SELECT ON public_sites, public_resources, public_organizations, resource_categories TO ics_anon, ics_app;
GRANT EXECUTE ON FUNCTION ics.freshness_state(text, text, timestamptz), ics.freshness_interval(text, text) TO ics_anon;

-- The public views are intentionally NOT security_barrier so that bounding-box
-- predicates reach the GiST index. That is safe only because request roles can
-- never create functions (no leaky-function attacks):
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA ics FROM PUBLIC;
GRANT USAGE ON SCHEMA ics TO ics_anon, ics_app;

-- Authenticated viewport query. RLS quals are evaluated before non-leakproof user
-- quals, which would defeat the spatial index; this function prefilters by the
-- index and then applies the single source of authorization truth (can_view_site).
-- Callers re-read rows by id under RLS, so authorization is checked twice.
CREATE FUNCTION ics.visible_site_ids_in_bbox(w float8, s float8, e float8, n float8, lim int)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  WITH candidates AS MATERIALIZED (
    SELECT id, updated_at FROM staging_sites
     WHERE location::geometry && ST_MakeEnvelope(w, s, e, n, 4326)
  )
  SELECT id FROM candidates WHERE ics.can_view_site(id) ORDER BY updated_at DESC LIMIT lim $$;
REVOKE ALL ON FUNCTION ics.visible_site_ids_in_bbox(float8, float8, float8, float8, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ics.visible_site_ids_in_bbox(float8, float8, float8, float8, int) TO ics_app;
