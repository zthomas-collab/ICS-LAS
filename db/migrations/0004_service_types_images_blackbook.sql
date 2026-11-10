-- 0004_service_types_images_blackbook.sql
-- * Organization service types (admin-confirmed primary type drives the map legend)
-- * Directory publication consent for the public Black Book
-- * One image per staging site (privacy-filtered like the site itself)

CREATE TABLE service_types (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z_]+$'),
  label       text NOT NULL,
  short_label text NOT NULL CHECK (length(short_label) BETWEEN 1 AND 3),
  color       text NOT NULL CHECK (color ~ '^#[0-9a-f]{6}$'),
  description text,
  sort_order  int NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true
);
-- Colors are dark enough for white marker text (WCAG AA on 12px bold is not guaranteed;
-- the short label is the primary cue, color is secondary).
INSERT INTO service_types (code, label, short_label, color, sort_order, description) VALUES
  ('SUPPLIES','Supplies & distribution','SUP','#6a1b9a',10,'General relief supplies, hygiene kits, clothing'),
  ('WATER','Water','H2O','#1565c0',20,'Drinking water, refill stations, water purification'),
  ('FOOD','Food','FD','#d84315',30,'Meals, groceries, food banks and pantries'),
  ('SHELTER','Shelter','SH','#2e7d32',40,'Emergency and temporary shelter'),
  ('DISASTER_CASE_MANAGEMENT','Disaster case management (FEMA & state programs)','CM','#ad1457',50,'Help navigating FEMA, state and insurance recovery programs. Not affiliated with FEMA unless stated.'),
  ('HEALTHCARE','Healthcare','MED','#c62828',60,'Clinics, mobile medical, pharmacy and mental health support'),
  ('DEBRIS_CLEANUP','Debris removal & cleanup','DEB','#6d4c41',70,'Tree removal, muck-outs, debris hauling'),
  ('HOUSING','Housing assistance','HSG','#00838f',80,'Rental help, repairs, rebuilding'),
  ('TRANSPORTATION','Transportation','TRN','#37474f',90,'Rides, evacuation transport, delivery'),
  ('FINANCIAL_ASSISTANCE','Financial assistance','$','#8d6e00',100,'Grants, emergency cash assistance, benefits help'),
  ('LEGAL_TITLE','Legal, title & real estate help','LGL','#283593',110,'Title, deeds, heirs property, legal aid'),
  ('CONTRACTORS_EQUIPMENT','Contractors & equipment','EQP','#827717',120,'Licensed contractors, heavy equipment, generators'),
  ('UTILITIES','Utilities support','UTL','#4527a0',130,'Power, gas, telecom restoration support'),
  ('VOLUNTEER','Volunteer coordination','VOL','#558b2f',140,'Volunteer reception and coordination'),
  ('OTHER','Other recovery services','OTH','#616161',900,'Other disaster recovery services');

ALTER TABLE organizations
  ADD COLUMN requested_service_type text REFERENCES service_types(code),
  ADD COLUMN primary_service_type   text REFERENCES service_types(code),
  ADD COLUMN directory_consent_at   timestamptz,
  ADD COLUMN directory_consent_by   uuid REFERENCES users(id);

-- Existing approved rows (development data only at the time of writing) get a type so the
-- invariant below can be enforced.
UPDATE organizations SET primary_service_type = coalesce(requested_service_type, 'OTHER')
 WHERE status IN ('APPROVED','SUSPENDED') AND primary_service_type IS NULL;

-- Every approved (or suspended-after-approval) account has an admin-confirmed service type.
ALTER TABLE organizations ADD CONSTRAINT organizations_approved_has_type
  CHECK (status NOT IN ('APPROVED','SUSPENDED') OR primary_service_type IS NOT NULL);
CREATE INDEX organizations_primary_type_idx ON organizations (primary_service_type);

CREATE TABLE organization_service_types (
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  service_type text NOT NULL REFERENCES service_types(code),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, service_type)
);

-- ---------------------------------------------------------------------------
-- Site images. Bytes live in object storage; this row is the metadata + policy.
-- ---------------------------------------------------------------------------
CREATE TABLE site_images (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id           uuid NOT NULL REFERENCES staging_sites(id),
  org_id            uuid NOT NULL REFERENCES organizations(id),
  storage_key       text NOT NULL UNIQUE CHECK (storage_key ~ '^site-images/[0-9a-f-]{36}\.webp$'),
  content_type      text NOT NULL CHECK (content_type = 'image/webp'),
  byte_size         int  NOT NULL CHECK (byte_size > 0 AND byte_size <= 3145728),
  width             int  NOT NULL CHECK (width > 0 AND width <= 4096),
  height            int  NOT NULL CHECK (height > 0 AND height <= 4096),
  sha256            text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  alt_text          text NOT NULL CHECK (length(alt_text) BETWEEN 3 AND 300),
  metadata_stripped boolean NOT NULL,
  scan_status       text NOT NULL DEFAULT 'NOT_SCANNED' CHECK (scan_status IN ('NOT_SCANNED','PENDING','CLEAN','INFECTED','FAILED')),
  status            record_status NOT NULL DEFAULT 'ACTIVE',
  is_synthetic      boolean NOT NULL DEFAULT false,
  uploaded_by       uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  CHECK (metadata_stripped),
  CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
);
CREATE UNIQUE INDEX site_images_one_active ON site_images (site_id) WHERE status = 'ACTIVE';

CREATE FUNCTION ics.site_images_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, ics AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM staging_sites WHERE id = NEW.site_id AND org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'image org must match site org' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER site_images_guard_trg BEFORE INSERT OR UPDATE ON site_images FOR EACH ROW EXECUTE FUNCTION ics.site_images_guard();

ALTER TABLE site_images ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_images_select ON site_images FOR SELECT TO ics_app USING (ics.can_view_site(site_id));
CREATE POLICY site_images_insert ON site_images FOR INSERT TO ics_app
  WITH CHECK (ics.can_edit_org(org_id) AND uploaded_by = ics.viewer_id());
CREATE POLICY site_images_update ON site_images FOR UPDATE TO ics_app
  USING (ics.can_edit_org(org_id) OR ics.is_platform_admin())
  WITH CHECK (ics.can_edit_org(org_id) OR ics.is_platform_admin());
GRANT SELECT, INSERT, UPDATE ON site_images TO ics_app;

ALTER TABLE organization_service_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_services_select ON organization_service_types FOR SELECT TO ics_app USING (true);
GRANT SELECT ON organization_service_types TO ics_app;
GRANT SELECT ON service_types TO ics_anon, ics_app;
GRANT SELECT (primary_service_type, directory_consent_at) ON organizations TO ics_app;

-- ---------------------------------------------------------------------------
-- Rebuild public read models with service type and image columns.
-- ---------------------------------------------------------------------------
DROP VIEW public_resources;
DROP VIEW public_sites;

CREATE VIEW public_sites AS
SELECT s.id, s.org_id, o.display_name AS org_name, o.org_type,
       s.name, s.description,
       ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
       s.address_line, s.city, s.county, s.state, s.postal_code, s.hours_text, s.public_phone,
       s.last_confirmed_at, s.updated_at, (s.is_synthetic OR o.is_synthetic) AS is_synthetic,
       s.location,
       o.primary_service_type AS service_type, st.label AS service_label,
       st.short_label AS service_short, st.color AS service_color,
       img.id AS image_id, img.alt_text AS image_alt
  FROM staging_sites s
  JOIN organizations o ON o.id = s.org_id
  JOIN service_types st ON st.code = o.primary_service_type
  LEFT JOIN site_images img ON img.site_id = s.id AND img.status = 'ACTIVE' AND img.scan_status IN ('NOT_SCANNED','CLEAN')
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

-- Image bytes for anonymous requests are located through this view only.
CREATE VIEW public_site_images AS
SELECT img.id, img.site_id, img.storage_key, img.content_type, img.alt_text, img.created_at
  FROM site_images img JOIN public_sites ps ON ps.id = img.site_id AND ps.image_id = img.id;

-- Public Black Book: approved, non-suspended organizations that CONSENTED to publication.
-- Only public contact channels. Private contact_email / registration notes never appear.
CREATE VIEW public_black_book AS
SELECT o.id, o.display_name, o.org_type, o.description, o.website, o.public_phone, o.public_email,
       o.primary_service_type AS service_type, st.label AS service_label, st.short_label AS service_short,
       st.color AS service_color,
       coalesce((SELECT array_agg(ost.service_type ORDER BY t.sort_order)
                   FROM organization_service_types ost JOIN service_types t ON t.code = ost.service_type
                  WHERE ost.org_id = o.id AND ost.service_type <> o.primary_service_type), '{}') AS additional_service_types,
       (SELECT count(*)::int FROM public_sites ps WHERE ps.org_id = o.id) AS public_site_count,
       o.approved_at, o.updated_at, o.directory_consent_at, o.is_synthetic
  FROM organizations o JOIN service_types st ON st.code = o.primary_service_type
 WHERE o.status = 'APPROVED' AND NOT o.publication_suspended AND o.directory_consent_at IS NOT NULL;

GRANT SELECT ON public_sites, public_resources, public_site_images, public_black_book TO ics_anon, ics_app;
