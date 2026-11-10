-- 0007_hopegrid_type_palette.sql
-- HopeGrid brand: resource STATUS colors (green / amber / red / gray) are reserved for status.
-- Organization service-type colors are moved off those hues so the two never read alike.
-- All values keep >= 4.5:1 contrast with white marker text (enforced by service_types_color_contrast).
UPDATE service_types SET color = v.color FROM (VALUES
  ('SUPPLIES',                 '#6a1b9a'),  -- purple
  ('WATER',                    '#1565c0'),  -- blue
  ('FOOD',                     '#ad1457'),  -- raspberry   (was orange-red, too close to Depleted)
  ('SHELTER',                  '#00695c'),  -- teal        (was green, too close to Available)
  ('DISASTER_CASE_MANAGEMENT', '#4527a0'),  -- deep violet
  ('HEALTHCARE',               '#00838f'),  -- cyan        (was red, too close to Depleted)
  ('DEBRIS_CLEANUP',           '#6d4c41'),  -- brown
  ('HOUSING',                  '#283593'),  -- indigo
  ('TRANSPORTATION',           '#37474f'),  -- slate
  ('FINANCIAL_ASSISTANCE',     '#880e4f'),  -- wine        (was dark gold, too close to Limited)
  ('LEGAL_TITLE',              '#1a237e'),  -- midnight
  ('CONTRACTORS_EQUIPMENT',    '#004d40'),  -- dark teal   (was olive, too close to Limited)
  ('UTILITIES',                '#311b92'),  -- ink violet
  ('VOLUNTEER',                '#8e24aa'),  -- orchid      (was green, too close to Available)
  ('OTHER',                    '#263238')   -- charcoal    (was mid gray, too close to Closed/Unknown)
) AS v(code, color) WHERE service_types.code = v.code;

-- Reserved status colors may never be used as a type color.
ALTER TABLE service_types ADD CONSTRAINT service_types_not_status_color
  CHECK (lower(color) NOT IN ('#2e7d32', '#1b5e20', '#f0b84b', '#c62828', '#a61b1b', '#b0bec5', '#eceff1', '#616161'));
