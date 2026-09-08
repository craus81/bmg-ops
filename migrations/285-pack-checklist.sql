-- R6-4: the digital pack & ship checklist. Packing has been a printed
-- sheet somebody ticked with a pen and taped to the box — no record of who
-- packed what, no second pair of eyes, and no evidence of what actually
-- went in the carton when a customer says a piece is missing.
--
-- One row per line on the sheet. Per-line stamps, not one job-level stamp,
-- because the useful question is "who packed THIS piece and who verified
-- it" — and because a photo per line is the evidence the owner asked for.

CREATE TABLE IF NOT EXISTS graphics_pack_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  graphics_job_id UUID NOT NULL REFERENCES graphics_jobs(id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL,
  part_number TEXT,
  description TEXT,
  quantity_expected NUMERIC(10,2),
  quantity_packed NUMERIC(10,2),
  packed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  packed_at TIMESTAMPTZ,
  checked_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  checked_at TIMESTAMPTZ,
  -- Per-step photo evidence: the storage key in the `photos` bucket.
  photo_path TEXT,
  photo_uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  photo_uploaded_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (graphics_job_id, line_index),
  -- The whole point of a second pair of eyes: the person who verifies a
  -- line cannot be the person who packed it. Enforced in the database so
  -- no future call site can quietly skip it.
  CONSTRAINT pack_check_is_second_person CHECK (checked_by IS NULL OR checked_by <> packed_by),
  -- A line cannot be verified before it is packed.
  CONSTRAINT pack_check_after_pack CHECK (checked_at IS NULL OR packed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_graphics_pack_items_job ON graphics_pack_items(graphics_job_id, line_index);

ALTER TABLE graphics_pack_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff manage pack items" ON graphics_pack_items;
CREATE POLICY "Staff manage pack items" ON graphics_pack_items
  FOR ALL TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());

COMMENT ON CONSTRAINT pack_check_is_second_person ON graphics_pack_items IS
  'R6-4: a packer cannot verify their own line — the second signature is the control.';
