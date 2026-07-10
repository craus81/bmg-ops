-- Quote lifecycle + email extras for the wrap estimator:
--
-- archived_at: soft-archive for the History tab (hidden by default,
-- restorable). Hard delete remains available in the UI for quotes that
-- should really go away.
--
-- attachments: files the sender attaches to the emailed quote (proof
-- PDFs, vinyl spec sheets, etc.), uploaded to the vehicle-templates
-- bucket under quote-attachments/. Array of {name, path, size, type};
-- the send route downloads each path and attaches it to the email.
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
