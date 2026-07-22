-- Migration 175: pending PO review notes
-- A free-text note per queued Gmail PO import so the reviewer can jot why
-- it hasn't been imported yet (waiting on a revised PDF, pricing question,
-- duplicate, etc.). Shown on the "Pending POs — Review Required" list.

ALTER TABLE gmail_po_imports
  ADD COLUMN IF NOT EXISTS review_note TEXT;
