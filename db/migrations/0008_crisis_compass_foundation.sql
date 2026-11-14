-- 0008_crisis_compass_foundation.sql
-- Crisis Compass upgrade, Phase 1 (foundation). Additive only: no existing column, table, row or
-- policy is dropped or rewritten except the public_contacts read model, which is recreated with
-- extra columns (same name, same existing columns, same grants).
--
--  * counties + county_admin_assignments: the unit of scope for County Administrators.
--    "Executive Administrator" is the existing PLATFORM_ADMIN role (see docs/09 for the mapping), so
--    no enum change and no data migration is needed.
--  * organization_counties: counties an organization serves.
--  * Organization profile: logo, social links, and an administrator-controlled profile_status.
--    Existing approved + consented organizations are backfilled to APPROVED so nothing disappears
--    from public Contacts on deploy.

-- ---------------------------------------------------------------------------
-- Counties
-- ---------------------------------------------------------------------------
CREATE TABLE counties (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  state      text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  fips       text CHECK (fips IS NULL OR fips ~ '^[0-9]{5}$'),
  active     boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (state, name)
);
CREATE TRIGGER counties_touch BEFORE UPDATE ON counties FOR EACH ROW EXECUTE FUNCTION ics.touch_updated_at();

-- Seed from counties that already appear on staging sites (non-destructive; admins can add more).
INSERT INTO counties (name, state)
SELECT DISTINCT trim(county), state FROM staging_sites
 WHERE county IS NOT NULL AND length(trim(county)) BETWEEN 2 AND 80 AND state IS NOT NULL AND state ~ '^[A-Z]{2}$'
ON CONFLICT (state, name) DO NOTHING;

GRANT SELECT ON counties TO ics_anon, ics_app;

CREATE TABLE county_admin_assignments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  county_id  uuid NOT NULL REFERENCES counties(id),
  reason     text NOT NULL CHECK (length(reason) BETWEEN 5 AND 2000),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX county_admin_active_uq ON county_admin_assignments (user_id, county_id) WHERE revoked_at IS NULL;
CREATE INDEX county_admin_county_idx ON county_admin_assignments (county_id) WHERE revoked_at IS NULL;

CREATE TABLE organization_counties (
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  county_id  uuid NOT NULL REFERENCES counties(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, county_id)
);
CREATE INDEX organization_counties_county_idx ON organization_counties (county_id);

-- ---------------------------------------------------------------------------
-- Authorization helpers (same pattern as 0001: SECURITY DEFINER, viewer from transaction setting)
-- ---------------------------------------------------------------------------
CREATE FUNCTION ics.viewer_county_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT coalesce(array_agg(a.county_id), '{}') FROM county_admin_assignments a JOIN users u ON u.id = a.user_id
   WHERE a.user_id = ics.viewer_id() AND u.status = 'ACTIVE' AND a.revoked_at IS NULL
     AND (a.expires_at IS NULL OR a.expires_at > now()) $$;

-- Executive (platform admin) manages every county; a county admin only their assigned counties.
CREATE FUNCTION ics.can_manage_county(p_county uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT ics.is_platform_admin() OR p_county = ANY (ics.viewer_county_ids()) $$;

ALTER TABLE county_admin_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY county_admin_select ON county_admin_assignments FOR SELECT TO ics_app
  USING (user_id = ics.viewer_id() OR ics.is_platform_admin());
GRANT SELECT ON county_admin_assignments TO ics_app;

ALTER TABLE organization_counties ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_counties_select ON organization_counties FOR SELECT TO ics_app
  USING (ics.is_member(org_id) OR ics.is_platform_admin() OR ics.can_manage_county(county_id));
GRANT SELECT ON organization_counties TO ics_app;

-- ---------------------------------------------------------------------------
-- Organization profile: logo, social links, administrator-approved visibility
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN logo_storage_key  text CHECK (logo_storage_key IS NULL OR logo_storage_key ~ '^org-logos/[0-9a-f-]{36}\.webp$'),
  ADD COLUMN logo_alt          text CHECK (logo_alt IS NULL OR length(logo_alt) BETWEEN 3 AND 300),
  ADD COLUMN logo_updated_at   timestamptz,
  ADD COLUMN social_links      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(social_links) = 'object'),
  ADD COLUMN profile_status    text NOT NULL DEFAULT 'PENDING' CHECK (profile_status IN ('PENDING','APPROVED','HIDDEN')),
  ADD COLUMN profile_reviewed_by uuid REFERENCES users(id),
  ADD COLUMN profile_reviewed_at timestamptz;

-- A public profile is: approved org + consent (the existing "public-facing" opt-in) + admin-approved profile.
-- Backfill so listings that were public before this migration stay public.
UPDATE organizations SET profile_status = 'APPROVED', profile_reviewed_at = now()
 WHERE status IN ('APPROVED','SUSPENDED') AND directory_consent_at IS NOT NULL;

GRANT SELECT (logo_alt, logo_updated_at, social_links, profile_status) ON organizations TO ics_app;

-- ---------------------------------------------------------------------------
-- Public read model, rebuilt with profile columns. Whitelisted columns only; the private
-- sign-in contact_email, registration notes and storage details beyond the logo key are never exposed.
-- ---------------------------------------------------------------------------
DROP VIEW public_contacts;
CREATE VIEW public_contacts AS
SELECT o.id, o.display_name, o.org_type, o.description, o.website, o.public_phone, o.public_email,
       o.public_postal_code,
       o.primary_service_type AS service_type, st.label AS service_label, st.short_label AS service_short,
       st.color AS service_color,
       coalesce((SELECT array_agg(ost.service_type ORDER BY t.sort_order)
                   FROM organization_service_types ost JOIN service_types t ON t.code = ost.service_type
                  WHERE ost.org_id = o.id AND ost.service_type <> o.primary_service_type), '{}') AS additional_service_types,
       coalesce((SELECT string_agg(t.label, ' ') FROM organization_service_types ost JOIN service_types t ON t.code = ost.service_type
                  WHERE ost.org_id = o.id), '') || ' ' || st.label AS service_text,
       (SELECT count(*)::int FROM public_sites ps WHERE ps.org_id = o.id) AS public_site_count,
       o.approved_at, o.updated_at, o.directory_consent_at, o.is_synthetic,
       o.social_links,
       o.logo_storage_key, o.logo_alt,
       coalesce((SELECT array_agg(c.name || ', ' || c.state ORDER BY c.state, c.name)
                   FROM organization_counties oc JOIN counties c ON c.id = oc.county_id
                  WHERE oc.org_id = o.id), '{}') AS counties_served
  FROM organizations o JOIN service_types st ON st.code = o.primary_service_type
 WHERE o.status = 'APPROVED' AND NOT o.publication_suspended AND o.directory_consent_at IS NOT NULL
   AND o.profile_status = 'APPROVED';

GRANT SELECT ON public_contacts TO ics_anon, ics_app;
