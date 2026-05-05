-- Migration 089: Persisted PDF/file attachments for purchase orders
--
-- Source PDFs from PO PDF uploads and Gmail email imports were discarded
-- after parsing. This table keeps the original file alongside the PO so
-- it stays linked to the record and can be surfaced on graphics jobs that
-- reference the PO.

CREATE TABLE IF NOT EXISTS po_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT,
  file_size INTEGER,
  storage_path TEXT NOT NULL,
  source TEXT CHECK (source IN ('pdf_upload', 'email_import')),
  uploaded_by UUID REFERENCES profiles(id),
  uploaded_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_files_po ON po_files(po_id);

ALTER TABLE po_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal staff can manage po files"
  ON po_files FOR ALL
  TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());
