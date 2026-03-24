-- Migration 018: Parts Catalog — synced from NetSuite
-- Two catalogs: upfit_parts (fleet/install) and graphic_parts (decals/graphics)

CREATE TABLE IF NOT EXISTS netsuite_parts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  netsuite_id text NOT NULL UNIQUE,
  item_number text NOT NULL,
  display_name text,
  description text,
  item_type text, -- 'InventoryItem', 'NonInventoryItem', 'ServiceItem', etc.
  catalog text NOT NULL DEFAULT 'upfit' CHECK (catalog IN ('upfit', 'graphics')),

  -- Pricing
  sales_price numeric(12,2) DEFAULT 0,
  purchase_price numeric(12,2) DEFAULT 0,

  -- Inventory
  quantity_on_hand numeric(12,2) DEFAULT 0,
  quantity_available numeric(12,2) DEFAULT 0,

  -- Labor
  labor_hours numeric(8,2) DEFAULT 0,

  -- Classification from NetSuite
  ns_class text,
  ns_category text,
  ns_department text,

  -- Status
  is_active boolean DEFAULT true,

  -- Sync metadata
  last_synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_netsuite_parts_catalog ON netsuite_parts(catalog);
CREATE INDEX IF NOT EXISTS idx_netsuite_parts_item_number ON netsuite_parts(item_number);
CREATE INDEX IF NOT EXISTS idx_netsuite_parts_netsuite_id ON netsuite_parts(netsuite_id);
CREATE INDEX IF NOT EXISTS idx_netsuite_parts_active ON netsuite_parts(is_active);

-- Sync log to track when syncs happen
CREATE TABLE IF NOT EXISTS parts_sync_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  status text DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  parts_synced integer DEFAULT 0,
  parts_added integer DEFAULT 0,
  parts_updated integer DEFAULT 0,
  error text,
  triggered_by uuid REFERENCES profiles(id)
);

-- RLS
ALTER TABLE netsuite_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE parts_sync_log ENABLE ROW LEVEL SECURITY;

-- Admin and sales can read parts
CREATE POLICY "Admin and sales can read parts"
  ON netsuite_parts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'sales')
    )
  );

-- Only admin can modify parts (sync process uses service role)
CREATE POLICY "Admin can manage parts"
  ON netsuite_parts FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- Admin and sales can read sync log
CREATE POLICY "Admin and sales can read sync log"
  ON parts_sync_log FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'sales')
    )
  );
