-- Graphics job material drop-downs that admins can add to (Craig
-- 2026-10-30, thread "Add free text for vinyl, laminate and premask").
--
-- Vinyl Type, Laminate and Premask on a graphics job were hard-coded
-- lists, and picking "Other" saved the word "Other". Each drop-down now has
-- "Other…" that opens a text box; an admin can tick "Add to the list" to
-- put what they typed on the drop-down for everyone, and remove items in
-- Settings → Graphics Job Material Lists. The job itself still stores plain
-- text in graphics_jobs.vinyl_type / laminate / premask, so removing an
-- item here never changes a job that already uses it.
CREATE TABLE IF NOT EXISTS graphics_material_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('vinyl', 'laminate', 'premask')),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  sort_order INT NOT NULL DEFAULT 0,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS graphics_material_options_kind_name
  ON graphics_material_options (kind, lower(btrim(name)));

-- Read and written only through /api/graphics/material-options.
ALTER TABLE graphics_material_options ENABLE ROW LEVEL SECURITY;

-- The lists the job screens had built in. "Other" isn't an item any more:
-- the drop-down's own "Other…" replaces it.
INSERT INTO graphics_material_options (kind, name, sort_order) VALUES
  ('vinyl', 'IJ280 CV4', 10),
  ('vinyl', 'IJ175 CV3', 20),
  ('vinyl', 'IJ40C', 30),
  ('vinyl', 'IJ780CR', 40),
  ('vinyl', 'IJ680CR', 50),
  ('vinyl', 'Banner', 60),
  ('laminate', 'N/A', 10),
  ('laminate', '8428G', 20),
  ('laminate', '8418', 30),
  ('laminate', '8508', 40),
  ('premask', 'N/A', 10),
  ('premask', 'R-Tape 4075', 20)
ON CONFLICT DO NOTHING;
