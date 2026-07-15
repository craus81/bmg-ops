-- The PDF backfill (/api/pos/backfill-pdfs) inserts po_files rows with
-- source='email_backfill', but migration 097's CHECK constraint only allows
-- ('pdf_upload', 'email_import') — so every backfill insert was rejected.
-- The route didn't check the insert result, counted the PO as attached
-- anyway, and the batch loop re-processed the same PDF-less POs round after
-- round (the "Attached PDFs to 2812 POs" report on a ~109-PO book, with no
-- files actually stored). Allow the backfill's source value.
ALTER TABLE po_files DROP CONSTRAINT IF EXISTS po_files_source_check;
ALTER TABLE po_files ADD CONSTRAINT po_files_source_check
  CHECK (source IN ('pdf_upload', 'email_import', 'email_backfill'));
