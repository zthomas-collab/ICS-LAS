-- 0005_contacts_zip_search.sql
-- Public "Contacts" (formerly Black Book) search by ZIP code + radius.
--  * zip_codes: ZIP centroids (load the public-domain U.S. Census ZCTA gazetteer with
--    `npm run zips:import -- <file>`). When a ZIP is missing, search falls back to the
--    centroid of public sites that list that ZIP.
--  * organizations.public_postal_code: optional public office ZIP for organizations
--    without a public location on the map.

CREATE TABLE zip_codes (
  zip       text PRIMARY KEY CHECK (zip ~ '^[0-9]{5}$'),
  location  geography(Point, 4326) NOT NULL,
  source    text NOT NULL DEFAULT 'census_zcta',
  loaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zip_codes_location_gix ON zip_codes USING gist (location);
GRANT SELECT ON zip_codes TO ics_anon, ics_app;

ALTER TABLE organizations
  ADD COLUMN public_postal_code text CHECK (public_postal_code IS NULL OR public_postal_code ~ '^[0-9]{5}$');
GRANT SELECT (public_postal_code) ON organizations TO ics_app;

-- Resolve a ZIP to a point: official centroid first, else the centroid of public sites with that ZIP.
CREATE FUNCTION ics.zip_point(p_zip text) RETURNS geography
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, ics AS $$
  SELECT coalesce(
    (SELECT location FROM zip_codes WHERE zip = p_zip),
    (SELECT ST_Centroid(ST_Collect(location::geometry))::geography FROM public_sites WHERE postal_code = p_zip)
  ) $$;
GRANT EXECUTE ON FUNCTION ics.zip_point(text) TO ics_anon, ics_app;

DROP VIEW public_black_book;
CREATE VIEW public_contacts AS
SELECT o.id, o.display_name, o.org_type, o.description, o.website, o.public_phone, o.public_email,
       o.public_postal_code,
       o.primary_service_type AS service_type, st.label AS service_label, st.short_label AS service_short,
       st.color AS service_color,
       coalesce((SELECT array_agg(ost.service_type ORDER BY t.sort_order)
                   FROM organization_service_types ost JOIN service_types t ON t.code = ost.service_type
                  WHERE ost.org_id = o.id AND ost.service_type <> o.primary_service_type), '{}') AS additional_service_types,
       -- Every service label the org offers, for text search ("healthcare", "case management", ...).
       coalesce((SELECT string_agg(t.label, ' ') FROM organization_service_types ost JOIN service_types t ON t.code = ost.service_type
                  WHERE ost.org_id = o.id), '') || ' ' || st.label AS service_text,
       (SELECT count(*)::int FROM public_sites ps WHERE ps.org_id = o.id) AS public_site_count,
       o.approved_at, o.updated_at, o.directory_consent_at, o.is_synthetic
  FROM organizations o JOIN service_types st ON st.code = o.primary_service_type
 WHERE o.status = 'APPROVED' AND NOT o.publication_suspended AND o.directory_consent_at IS NOT NULL;

GRANT SELECT ON public_contacts TO ics_anon, ics_app;
