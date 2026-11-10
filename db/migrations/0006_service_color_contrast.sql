-- 0006_service_color_contrast.sql
-- Accessibility audit (P5): white marker/badge text needs >= 4.5:1 contrast.
--   FOOD      #d84315 (4.44:1) -> #bf360c (5.60:1)
--   VOLUNTEER #558b2f (4.10:1) -> #33691e (6.56:1)
UPDATE service_types SET color = '#bf360c' WHERE code = 'FOOD' AND color = '#d84315';
UPDATE service_types SET color = '#33691e' WHERE code = 'VOLUNTEER' AND color = '#558b2f';
-- Guard against future regressions: every active color must be dark enough for white text.
CREATE FUNCTION ics.white_text_contrast(hex text) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  WITH c AS (
    SELECT (('x' || substr(hex, 2, 2))::bit(8)::int / 255.0) AS r,
           (('x' || substr(hex, 4, 2))::bit(8)::int / 255.0) AS g,
           (('x' || substr(hex, 6, 2))::bit(8)::int / 255.0) AS b
  ), lin AS (
    SELECT CASE WHEN r <= 0.03928 THEN r / 12.92 ELSE power((r + 0.055) / 1.055, 2.4) END AS r,
           CASE WHEN g <= 0.03928 THEN g / 12.92 ELSE power((g + 0.055) / 1.055, 2.4) END AS g,
           CASE WHEN b <= 0.03928 THEN b / 12.92 ELSE power((b + 0.055) / 1.055, 2.4) END AS b FROM c
  )
  SELECT round((1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05))::numeric, 2) FROM lin $$;
ALTER TABLE service_types ADD CONSTRAINT service_types_color_contrast CHECK (ics.white_text_contrast(color) >= 4.5);
