-- Migration 200: proof-sweep queue (meeting plan K12)
--
-- "Search email for proofs and part numbers and attempt to attach found
-- proofs to part-number records." The bulk sweep auto-attaches only
-- HIGH-confidence hits (part number in the attachment filename, or in the
-- subject of a single-attachment message); everything else lands here as
-- a pending row for the admin's approve/reject list. Wrong proof on a
-- part record is worse than none — installers see these in the scanner.
--
-- Attached/dismissed rows stay as the sweep's memory: re-runs skip
-- anything already resolved, so the sweep is idempotent per
-- (part, message, filename). Gmail attachment ids are NOT stable across
-- message fetches, so the filename is the durable key and the attachment
-- id is re-resolved at attach time.
--
-- Admin-only feature accessed through service-role API routes
-- (/api/parts/proof-sweep, requireAdmin) — RLS enabled with no policies.

CREATE TABLE IF NOT EXISTS proof_sweep_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id UUID NOT NULL REFERENCES netsuite_parts(id) ON DELETE CASCADE,
  part_number TEXT NOT NULL,
  message_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  subject TEXT,
  from_addr TEXT,
  email_date TEXT,
  -- 'high' rows were auto-attached by the sweep; 'review' rows wait for a
  -- human verdict.
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'review')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached', 'dismissed', 'failed')),
  status_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES profiles(id),
  UNIQUE (part_id, message_id, filename)
);

CREATE INDEX IF NOT EXISTS idx_proof_sweep_queue_status ON proof_sweep_queue(status, created_at DESC);

COMMENT ON TABLE proof_sweep_queue IS
  'K12 proof sweep: auto-attach log + review queue for Gmail proof attachments matched to parts — service-role access only.';

ALTER TABLE proof_sweep_queue ENABLE ROW LEVEL SECURITY;
