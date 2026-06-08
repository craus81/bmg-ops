-- Migration 098: store the NetSuite invoice PDF on graphics jobs
-- Pulled from the NetSuite PDF RESTlet and stored in R2; this column
-- holds the public URL of the stored copy so the UI can link to it
-- instead of deep-linking into NetSuite.

ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS invoice_pdf_url text;
