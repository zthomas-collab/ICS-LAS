-- 0002_road_and_directory.sql
-- Tables for Module D (road conditions) and Module E (Black Book).
-- APIs for these modules ship in Phases 4–5. Until then RLS is enabled with NO
-- policies and NO grants to request roles: deny-by-default.

CREATE TYPE road_observation_type AS ENUM ('FALLEN_TREE','FLOODING','DEBRIS','BRIDGE_DAMAGE','WASHED_OUT_ROAD',
  'LANDSLIDE','IMPASSABLE_ROAD','RESTRICTED_ACCESS','OTHER');
CREATE TYPE road_report_status AS ENUM ('SUBMITTED','UNDER_REVIEW','ORGANIZATION_CONFIRMED','RESOLVED','ARCHIVED');
-- Official status is tracked separately and only set from an authoritative source.
CREATE TYPE road_official_status AS ENUM ('NONE','OFFICIALLY_CLOSED','OFFICIALLY_RESTRICTED','OFFICIALLY_REOPENED');

CREATE TABLE road_incidents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporting_org_id       uuid NOT NULL REFERENCES organizations(id),
  reported_by            uuid NOT NULL REFERENCES users(id),
  location               geography(Point, 4326),
  road_geometry          geography(LineString, 4326),
  road_name              text CHECK (length(road_name) <= 200),
  observation_type       road_observation_type NOT NULL,
  description            text CHECK (length(description) <= 2000),
  observed_at            timestamptz NOT NULL,
  reported_severity      text NOT NULL CHECK (reported_severity IN ('LOW','MODERATE','HIGH','IMPASSABLE')),
  status                 road_report_status NOT NULL DEFAULT 'SUBMITTED',
  visibility             visibility_level NOT NULL DEFAULT 'ORGANIZATION_NETWORK',
  official_status        road_official_status NOT NULL DEFAULT 'NONE',
  official_source_ref    text,
  official_verified_by   uuid REFERENCES users(id),
  official_verified_at   timestamptz,
  duplicate_of           uuid REFERENCES road_incidents(id),
  superseded_by          uuid REFERENCES road_incidents(id),
  last_confirmed_at      timestamptz,
  is_synthetic           boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (location IS NOT NULL OR road_geometry IS NOT NULL),
  -- An official status other than NONE requires a source reference and a verifier.
  CHECK (official_status = 'NONE' OR (official_source_ref IS NOT NULL AND official_verified_by IS NOT NULL AND official_verified_at IS NOT NULL)),
  CHECK (duplicate_of IS NULL OR duplicate_of <> id)
);
CREATE INDEX road_incidents_location_gix ON road_incidents USING gist (location);
CREATE INDEX road_incidents_geometry_gix ON road_incidents USING gist (road_geometry);
CREATE INDEX road_incidents_status_idx ON road_incidents (status, visibility);
CREATE TRIGGER road_incidents_touch BEFORE UPDATE ON road_incidents FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

CREATE TABLE road_incident_evidence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id     uuid NOT NULL REFERENCES road_incidents(id) ON DELETE CASCADE,
  storage_key     text NOT NULL,                -- private object storage key; access only via signed URL
  content_type    text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  byte_size       int NOT NULL CHECK (byte_size > 0 AND byte_size <= 15728640),
  sha256          text NOT NULL,
  scan_status     text NOT NULL DEFAULT 'PENDING' CHECK (scan_status IN ('PENDING','CLEAN','INFECTED','FAILED')),
  metadata_stripped boolean NOT NULL DEFAULT false,
  visibility      visibility_level NOT NULL DEFAULT 'PRIVATE_ORGANIZATION',
  uploaded_by     uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX road_evidence_incident_idx ON road_incident_evidence (incident_id);

CREATE TABLE road_incident_verifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  uuid NOT NULL REFERENCES road_incidents(id) ON DELETE CASCADE,
  verifier_id  uuid NOT NULL REFERENCES users(id),
  verifier_org_id uuid REFERENCES organizations(id),
  kind         text NOT NULL CHECK (kind IN ('ORGANIZATION_CONFIRMATION','OFFICIAL_SOURCE','STILL_PRESENT','CLEARED','DUPLICATE')),
  source_ref   text,
  note         text CHECK (length(note) <= 1000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'OFFICIAL_SOURCE' OR source_ref IS NOT NULL)
);
CREATE INDEX road_verifications_incident_idx ON road_incident_verifications (incident_id, created_at DESC);
CREATE TRIGGER road_verifications_append_only BEFORE UPDATE OR DELETE ON road_incident_verifications
  FOR EACH ROW EXECUTE FUNCTION ics.reject_mutation();

CREATE TABLE road_incident_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id   uuid NOT NULL REFERENCES road_incidents(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  event_type    text NOT NULL,
  from_status   road_report_status,
  to_status     road_report_status,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX road_events_incident_idx ON road_incident_events (incident_id, created_at DESC);
CREATE TRIGGER road_events_append_only BEFORE UPDATE OR DELETE ON road_incident_events
  FOR EACH ROW EXECUTE FUNCTION ics.reject_mutation();

-- Black Book -----------------------------------------------------------------
CREATE TABLE directory_entries (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_org_id           uuid REFERENCES organizations(id),
  name                   text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  organization_name      text,
  categories             text[] NOT NULL DEFAULT '{}',
  specialties            text[] NOT NULL DEFAULT '{}',
  website                text CHECK (website IS NULL OR website ~ '^https?://'),
  service_area_text      text,
  service_area           geography(MultiPolygon, 4326),
  availability_text      text,
  credential_status      text NOT NULL DEFAULT 'UNVERIFIED' CHECK (credential_status IN ('UNVERIFIED','VERIFIED','EXPIRED','REVOKED')),
  last_verified_at       timestamptz,
  consent_recorded_at    timestamptz,
  consent_scope          text CHECK (consent_scope IN ('PUBLIC','AUTHORIZED_ONLY','NONE')),
  status                 record_status NOT NULL DEFAULT 'ACTIVE',
  is_synthetic           boolean NOT NULL DEFAULT false,
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX directory_entries_area_gix ON directory_entries USING gist (service_area);
CREATE INDEX directory_entries_categories_idx ON directory_entries USING gin (categories);
CREATE TRIGGER directory_entries_touch BEFORE UPDATE ON directory_entries FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

CREATE TABLE directory_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES directory_entries(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('PHONE','EMAIL','SMS','OTHER')),
  value       text NOT NULL,
  label       text,
  visibility  visibility_level NOT NULL DEFAULT 'PRIVATE_ORGANIZATION',
  notes       text,                -- restricted; never in public read models
  last_verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX directory_contacts_entry_idx ON directory_contacts (entry_id);

CREATE TABLE directory_visibility_policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id       uuid NOT NULL REFERENCES directory_entries(id) ON DELETE CASCADE,
  allowed_org_id uuid REFERENCES organizations(id),
  allowed_role   platform_role,
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (allowed_org_id IS NOT NULL OR allowed_role IS NOT NULL)
);

CREATE TABLE directory_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id      uuid NOT NULL REFERENCES directory_entries(id) ON DELETE CASCADE,
  credential    text NOT NULL,          -- e.g. contractor license type
  issuer        text,
  identifier    text,                   -- restricted
  valid_until   date,
  verified_by   uuid REFERENCES users(id),
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE road_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE road_incident_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE road_incident_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE road_incident_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_visibility_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_credentials ENABLE ROW LEVEL SECURITY;
