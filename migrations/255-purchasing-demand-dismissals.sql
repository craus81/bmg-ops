-- Dismiss a part on the Purchasing → Open-job demand list.
--
-- The demand list rolls every open job up by part number and had no way
-- to say "we know, not buying this one" — a part covered from stock, a
-- line NetSuite will never bill, a customer-supplied item — so the same
-- rows sat at the top of the list forever. A dismissal hides the part
-- while the demand behind it is unchanged; if the needed quantity GROWS
-- past what it was when dismissed (a new job landed), the row comes back
-- on its own so new demand is never hidden by an old decision.
--
-- Keyed by the normalized item number (the demand row's own identity —
-- see src/lib/parts-demand.ts), not by SO line: a dismissal is a buying
-- decision about the part, and re-syncs replace SO lines wholesale.

CREATE TABLE IF NOT EXISTS purchasing_demand_dismissals (
  item_number TEXT PRIMARY KEY,
  -- The row's needed quantity at the moment it was dismissed. The
  -- dismissal applies only while needed <= this.
  needed_at_dismiss NUMERIC(12,2) NOT NULL DEFAULT 0,
  reason TEXT,
  dismissed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE purchasing_demand_dismissals IS
  'Purchasing demand rows staff dismissed (by normalized item number). Applies while the part''s needed quantity is <= needed_at_dismiss; new demand un-hides it.';

ALTER TABLE purchasing_demand_dismissals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Internal staff manage demand dismissals" ON purchasing_demand_dismissals;
CREATE POLICY "Internal staff manage demand dismissals"
  ON purchasing_demand_dismissals FOR ALL
  TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());
