-- Migration 477: FleetSuite's own books, part 45 — the NetSuite feed.
--
-- The NetSuite Exit Checklist's "NetSuite feed" (thread "Replacing NetSuite
-- with FleetSuite"; docs/books.md "NetSuite feed"): from January 2027 the
-- team works only in FleetSuite, and FleetSuite sends what they do on to
-- NetSuite, screen by screen, the moment someone saves. Nothing kept a
-- record of those sends: a refused one was only on the screen of whoever
-- pressed, and one NetSuite never answered left no trace at all.
--
-- netsuite_sends keeps every request FleetSuite makes that writes to
-- NetSuite (src/lib/netsuite-sends.ts): a row when it starts, then what
-- NetSuite answered. It took it, refused it, or left FleetSuite unsure (no
-- answer, a timeout, a server error), in which case NetSuite may have made
-- the document anyway. A row still without an answer five minutes on is a
-- send that never heard back. Never the request's body: only the record
-- type, the record addressed or made, and a document number or external ID
-- to find it by. Books → NetSuite feed lists them; a send FleetSuite can't be
-- sure about stays on its list until a super admin has looked for it in
-- NetSuite, and the daily check tells the super admins about it once.
--
-- Reader and writer: the service role only, as the books are.

CREATE TABLE IF NOT EXISTS netsuite_sends (
  -- Made by FleetSuite before the send, so the row it starts with is the one it finishes.
  id UUID PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  method TEXT NOT NULL CHECK (method IN ('POST', 'PATCH', 'PUT', 'DELETE')),
  -- A new record, a change to one, one deleted, one made from another (an invoice from a sales order), or
  -- something the item script was asked to do.
  action TEXT NOT NULL CHECK (action IN ('create', 'change', 'delete', 'transform', 'script')),
  -- NetSuite's name for the record ('invoice', 'salesOrder'), 'item' or 'script' for the item script.
  record_type TEXT NOT NULL CHECK (length(record_type) BETWEEN 1 AND 60),
  -- The record changed, deleted or made from.
  record_id TEXT CHECK (length(record_id) <= 60),
  -- What it made, and the record NetSuite says it made.
  made_type TEXT CHECK (length(made_type) <= 60),
  made_id TEXT CHECK (made_id ~ '^[0-9]+$'),
  -- A document number, external ID or name sent or answered, to find it by in NetSuite.
  doc_ref TEXT CHECK (length(doc_ref) <= 120),
  outcome TEXT CHECK (outcome IN ('took', 'refused', 'unsure')),
  http_status INT CHECK (http_status BETWEEN 100 AND 599),
  -- NetSuite's reason, or why FleetSuite can't tell, with any long run of digits hidden.
  error TEXT CHECK (length(error) <= 600),
  -- Who was signed in, when a person sent it; none for a scheduled job.
  user_id UUID,
  -- A super admin looked for a send FleetSuite can't be sure about in NetSuite, and what they found.
  looked_at TIMESTAMPTZ,
  looked_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  looked_note TEXT CHECK (length(looked_note) <= 300),
  -- When the daily check told the super admins about it.
  told_at TIMESTAMPTZ,
  CHECK ((outcome IS NULL) = (finished_at IS NULL)),
  CHECK (looked_at IS NOT NULL OR looked_by IS NULL)
);
CREATE INDEX IF NOT EXISTS netsuite_sends_started_idx ON netsuite_sends (started_at DESC, id DESC);
-- The ones to look at: unsure, or never answered, and not looked at yet.
CREATE INDEX IF NOT EXISTS netsuite_sends_to_look_idx ON netsuite_sends (started_at DESC, id DESC)
  WHERE (outcome = 'unsure' OR outcome IS NULL) AND looked_at IS NULL;

DO $$
DECLARE
  r TEXT;
BEGIN
  ALTER TABLE public.netsuite_sends ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.netsuite_sends FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE netsuite_sends IS 'Migration 477: one row per request FleetSuite makes that writes to NetSuite (src/lib/netsuite-sends.ts, Books → NetSuite feed): the record type, the record addressed or made, a document number to find it by, and whether NetSuite took it, refused it, or left FleetSuite unsure. Never the request''s body. Service-role write and read.';
