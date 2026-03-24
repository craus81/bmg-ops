-- Migration 021: Estimates Builder
-- Create estimates that can be pushed to NetSuite as Estimate records

CREATE TABLE IF NOT EXISTS estimates (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  estimate_number text NOT NULL UNIQUE,

  -- Customer (references local customers table synced from NetSuite)
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name text,
  customer_netsuite_id text, -- for pushing to NS

  -- Estimate details
  title text,
  notes text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'rejected', 'pushed')),

  -- Tax
  tax_rate numeric(6,4) DEFAULT 0.0795, -- 7.95% default
  tax_exempt boolean DEFAULT false,

  -- Labor
  labor_rate numeric(10,2) DEFAULT 85.00, -- hourly rate
  labor_hours numeric(8,2) DEFAULT 0, -- total labor hours (auto-summed + manual adds)
  labor_hours_override numeric(8,2), -- if manually overridden, stores the override value

  -- Totals (computed on save)
  subtotal numeric(12,2) DEFAULT 0,
  labor_total numeric(12,2) DEFAULT 0,
  tax_amount numeric(12,2) DEFAULT 0,
  grand_total numeric(12,2) DEFAULT 0,

  -- NetSuite push tracking
  netsuite_estimate_id text, -- NS internal ID after push
  netsuite_estimate_number text, -- NS estimate/quote number
  pushed_at timestamptz,
  pushed_by uuid REFERENCES profiles(id),

  -- Metadata
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS estimate_line_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  estimate_id uuid NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  sort_order integer DEFAULT 0,

  -- Part reference (nullable for custom lines)
  part_id uuid REFERENCES netsuite_parts(id) ON DELETE SET NULL,
  netsuite_item_id text, -- NS item internal ID for push

  -- Line details
  item_number text,
  description text,
  quantity numeric(10,2) DEFAULT 1,
  unit_price numeric(12,2) DEFAULT 0,
  line_total numeric(12,2) DEFAULT 0,

  -- Labor hours from this part (auto-populated from netsuite_parts.labor_hours)
  labor_hours numeric(8,2) DEFAULT 0,

  -- Custom line flag
  is_custom boolean DEFAULT false,

  created_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_estimates_status ON estimates(status);
CREATE INDEX IF NOT EXISTS idx_estimates_customer ON estimates(customer_id);
CREATE INDEX IF NOT EXISTS idx_estimates_created_by ON estimates(created_by);
CREATE INDEX IF NOT EXISTS idx_estimate_lines_estimate ON estimate_line_items(estimate_id);

-- RLS
ALTER TABLE estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimate_line_items ENABLE ROW LEVEL SECURITY;

-- Admin and sales can do everything with estimates
DROP POLICY IF EXISTS "admin_sales_estimates_all" ON estimates;
CREATE POLICY "admin_sales_estimates_all" ON estimates
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'sales')
    )
  );

DROP POLICY IF EXISTS "admin_sales_estimate_lines_all" ON estimate_line_items;
CREATE POLICY "admin_sales_estimate_lines_all" ON estimate_line_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'sales')
    )
  );
