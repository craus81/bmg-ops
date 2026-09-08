-- R6-5: ZIP centroids for invite matching. Deliberately EMPTY on arrival.
--
-- The audit called for a bundled centroid file so ranking needs no external
-- geocoder, and that is right — but the coordinates have to be real. Made-up
-- centroids would produce confidently wrong mileage ("42 mi, in radius" for a
-- company three states away), which is worse for a coordinator than no
-- mileage at all. So the table ships empty and is loaded once from any public
-- ZIP centroid dataset through /api/admin/zip-centroids.
--
-- Until it is loaded, invite ranking still works on what the app already
-- knows — explicit ZIP-list and state service areas, ZIP-prefix proximity,
-- service type, equipment, availability and the R5-12 scorecard — and every
-- chip says which of those it used rather than implying a distance.

CREATE TABLE IF NOT EXISTS zip_centroids (
  zip TEXT PRIMARY KEY,
  latitude NUMERIC(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude NUMERIC(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  city TEXT,
  state TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE zip_centroids ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff read zip centroids" ON zip_centroids;
CREATE POLICY "Staff read zip centroids" ON zip_centroids
  FOR SELECT TO authenticated USING (public.is_internal_staff());
-- Loaded through the admin import (service role) only.

COMMENT ON TABLE zip_centroids IS
  'R6-5: ZIP -> lat/lon for CNI invite distance ranking. Empty until an admin imports a real dataset; ranking degrades to exact ZIP/state/prefix matching rather than guessing miles.';
