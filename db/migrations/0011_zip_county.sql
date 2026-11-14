-- 0011: static ZIP -> county crosswalk (North and South Carolina).
--
-- Data comes from db/data/zip_county_nc_sc.csv (U.S. Census Bureau 2020 ZCTA-to-county relationship file,
-- public domain) and is loaded by src/server/modules/zipcounty.ts when migrations run. The table only changes
-- when that CSV changes in a code release (no runtime calls to any maps service).
--
-- A ZIP can overlap several counties; each overlap is one row and land_share is the fraction of the ZIP's land
-- area inside that county. Applications and projects must ask the person to choose when a ZIP has several rows.
-- Additive and reversible: DROP TABLE zip_county.

CREATE TABLE zip_county (
  zip         text NOT NULL CHECK (zip ~ '^[0-9]{5}$'),
  county_fips text NOT NULL CHECK (county_fips ~ '^[0-9]{5}$'),
  state       text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  county_name text NOT NULL,
  land_share  numeric(5,4) NOT NULL CHECK (land_share >= 0 AND land_share <= 1),
  PRIMARY KEY (zip, county_fips)
);
CREATE INDEX zip_county_fips_idx ON zip_county (county_fips);

-- Reference data, not personal data: readable by everyone, writable only by the connection (system) role.
GRANT SELECT ON zip_county TO ics_anon, ics_app;
