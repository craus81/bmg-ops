-- Migration 335: purchase requests raised from an estimate.
--
-- A request could only point at an upfit project (source_project_id), and an
-- estimate has no project until it is converted to a sales order — so the
-- estimate's "4 parts not in stock and not on order" banner had nowhere to
-- send its parts. source_estimate_id records the estimate a request was
-- raised from. When the estimate later converts, ensureUpfitProjectForSo
-- stamps the new project onto these rows too, so the upfit card's
-- "Requested" count picks them up instead of asking for the parts again.
ALTER TABLE purchase_requests
  ADD COLUMN IF NOT EXISTS source_estimate_id UUID REFERENCES estimates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_requests_estimate
  ON purchase_requests(source_estimate_id) WHERE source_estimate_id IS NOT NULL;
