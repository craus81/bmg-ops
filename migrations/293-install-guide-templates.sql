-- R6-10: install guides as reusable model templates.
--
-- A guide's real work is the CALIBRATION — px_per_in per page, the
-- standard dimension set, the sections that always say the same thing.
-- All of it is redone by hand for every new job, even when the vehicle is
-- the same Transit 148" high-roof somebody already dimensioned last month.
--
-- A template is just a guide flagged as one, keyed to a year/make/model
-- so 'New from template' can offer the ones that fit the job's vehicle.
-- Same table on purpose: a template IS a guide, and forking the schema
-- would double every future change to pages/sections.

ALTER TABLE install_guides
  ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS template_name TEXT,
  -- Vehicle keying, stored apart from the free-text vehicle_desc so the
  -- match is on fields rather than string-guessing at display text.
  ADD COLUMN IF NOT EXISTS template_year TEXT,
  ADD COLUMN IF NOT EXISTS template_make TEXT,
  ADD COLUMN IF NOT EXISTS template_model TEXT,
  -- Provenance. ON DELETE SET NULL: deleting a template must never take
  -- the guides made from it with it.
  ADD COLUMN IF NOT EXISTS created_from_template_id UUID
    REFERENCES install_guides(id) ON DELETE SET NULL;

COMMENT ON COLUMN install_guides.is_template IS
  'A reusable model template rather than a job guide (R6-10). Templates carry no customer and no job links.';

CREATE INDEX IF NOT EXISTS idx_install_guides_templates
  ON install_guides(is_template, template_make, template_model)
  WHERE is_template = true;
CREATE INDEX IF NOT EXISTS idx_install_guides_from_template
  ON install_guides(created_from_template_id)
  WHERE created_from_template_id IS NOT NULL;

-- A template belongs to no customer and no job. Saving one strips those
-- in the route; this is the backstop, because a template that quietly
-- carried a customer would print somebody else's name on every guide
-- made from it, and one carrying graphics_job_id would attach new guides
-- to the ORIGINAL job.
ALTER TABLE install_guides
  DROP CONSTRAINT IF EXISTS install_guide_template_is_unowned;
ALTER TABLE install_guides
  ADD CONSTRAINT install_guide_template_is_unowned CHECK (
    is_template = false OR (
      customer_name IS NULL
      AND graphics_job_id IS NULL
      AND cni_job_id IS NULL
      AND fleet_checkin_id IS NULL
    )
  );
