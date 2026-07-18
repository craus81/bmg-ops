-- Finance/AP role + the vendor-invoice payment workflow.
--
-- The finance role gives the AP person (bill approval, NetSuite vendor
-- bills, mark-paid) exactly the payment powers they need without full
-- admin. vendor_invoices grows a submit -> approve -> bill -> paid
-- lifecycle with actor/timestamp stamps at every step.

-- Role constraint: recreate with 'finance' added (same pattern as 145).
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'admin', 'installer', 'field_tech', 'shop_tech',
    'sales', 'graphics_production', 'customer', 'production', 'finance'
  ));

-- Payment lifecycle. 'recorded' rows are pre-workflow (or not yet
-- submitted); 'rejected' goes back to the submitter with a reason and can
-- be resubmitted.
ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'recorded';
ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS netsuite_bill_id TEXT;
ALTER TABLE vendor_invoices DROP CONSTRAINT IF EXISTS vendor_invoices_status_check;
ALTER TABLE vendor_invoices ADD CONSTRAINT vendor_invoices_status_check
  CHECK (status IN ('recorded', 'submitted', 'approved', 'rejected', 'billed', 'paid'));

ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES profiles(id);
ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES profiles(id);
ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES profiles(id);
ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS billed_by UUID REFERENCES profiles(id);
ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS billed_at TIMESTAMPTZ;
ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS paid_by UUID REFERENCES profiles(id);
ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_vendor_invoices_status ON vendor_invoices(status);
