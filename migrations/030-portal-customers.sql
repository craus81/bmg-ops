-- Migration 030: Customer-Facing Graphics Ordering Portal
-- Creates portal customers, proof parts/pricing, order tables, and portal user linkage

-- ─── portal_customers ────────────────────────────────────────────────────────
-- Represents an external company (e.g. Verizon, AT&T) that orders graphics
CREATE TABLE IF NOT EXISTS portal_customers (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,          -- URL-safe identifier: /portal/[slug]
  logo_url     TEXT,                          -- Public URL (R2) for customer logo
  primary_color TEXT,                         -- Hex color for portal branding, e.g. '#E31837'
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_portal_customers_slug ON portal_customers(slug);

-- ─── proof_parts ─────────────────────────────────────────────────────────────
-- Orderable line items attached to a specific graphics proof
CREATE TABLE IF NOT EXISTS proof_parts (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  proof_id    UUID NOT NULL REFERENCES graphics_proofs(id) ON DELETE CASCADE,
  part_name   TEXT NOT NULL,
  part_number TEXT,
  description TEXT,
  unit_price  NUMERIC(10,2) NOT NULL DEFAULT 0,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_proof_parts_proof ON proof_parts(proof_id);

-- ─── customer_proof_assignments ──────────────────────────────────────────────
-- Controls which proofs a portal customer can see and order from
CREATE TABLE IF NOT EXISTS customer_proof_assignments (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  portal_customer_id UUID NOT NULL REFERENCES portal_customers(id) ON DELETE CASCADE,
  proof_id           UUID NOT NULL REFERENCES graphics_proofs(id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(portal_customer_id, proof_id)
);

CREATE INDEX idx_cpa_customer ON customer_proof_assignments(portal_customer_id);
CREATE INDEX idx_cpa_proof    ON customer_proof_assignments(proof_id);

-- ─── portal_customer_users ───────────────────────────────────────────────────
-- Links Supabase auth users (role='customer') to a portal customer
CREATE TABLE IF NOT EXISTS portal_customer_users (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  portal_customer_id UUID NOT NULL REFERENCES portal_customers(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role               TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(portal_customer_id, user_id)
);

CREATE INDEX idx_pcu_customer ON portal_customer_users(portal_customer_id);
CREATE INDEX idx_pcu_user     ON portal_customer_users(user_id);

-- ─── portal_orders ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portal_orders (
  id                 UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  portal_customer_id UUID NOT NULL REFERENCES portal_customers(id),
  po_number          TEXT,
  ship_to_address    JSONB,                   -- { street, city, state, zip }
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','confirmed','in_production','shipped','completed')),
  notes              TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_portal_orders_customer ON portal_orders(portal_customer_id);
CREATE INDEX idx_portal_orders_status   ON portal_orders(status);

-- ─── portal_order_lines ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portal_order_lines (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  portal_order_id UUID NOT NULL REFERENCES portal_orders(id) ON DELETE CASCADE,
  proof_part_id   UUID NOT NULL REFERENCES proof_parts(id),
  quantity        INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price      NUMERIC(10,2) NOT NULL,     -- price snapshot at order time
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pol_order ON portal_order_lines(portal_order_id);

-- ─── updated_at triggers ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_portal_customers_updated_at ON portal_customers;
CREATE TRIGGER trg_portal_customers_updated_at
  BEFORE UPDATE ON portal_customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_portal_orders_updated_at ON portal_orders;
CREATE TRIGGER trg_portal_orders_updated_at
  BEFORE UPDATE ON portal_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE portal_customers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE proof_parts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_proof_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_customer_users     ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_order_lines        ENABLE ROW LEVEL SECURITY;

-- Admins and sales: full access to all portal management tables
CREATE POLICY "admins_portal_customers" ON portal_customers
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND (role = 'admin' OR roles && ARRAY['admin','sales']::text[])
        AND (deactivated IS NULL OR deactivated = false)
    )
  );

CREATE POLICY "admins_proof_parts" ON proof_parts
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND (role = 'admin' OR roles && ARRAY['admin','sales']::text[])
        AND (deactivated IS NULL OR deactivated = false)
    )
  );

CREATE POLICY "admins_cpa" ON customer_proof_assignments
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND (role = 'admin' OR roles && ARRAY['admin','sales']::text[])
        AND (deactivated IS NULL OR deactivated = false)
    )
  );

CREATE POLICY "admins_pcu" ON portal_customer_users
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND (role = 'admin' OR roles && ARRAY['admin','sales']::text[])
        AND (deactivated IS NULL OR deactivated = false)
    )
  );

-- Portal customers: can read their own customer record (for branding)
CREATE POLICY "customers_read_own_portal_customer" ON portal_customers
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM portal_customer_users
      WHERE portal_customer_id = portal_customers.id
        AND user_id = auth.uid()
    )
  );

-- Portal customers: can read proof parts for their assigned proofs
CREATE POLICY "customers_read_proof_parts" ON proof_parts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM customer_proof_assignments cpa
      JOIN portal_customer_users pcu ON pcu.portal_customer_id = cpa.portal_customer_id
      WHERE cpa.proof_id = proof_parts.proof_id
        AND pcu.user_id = auth.uid()
    )
  );

-- Portal customers: can read their own assignments
CREATE POLICY "customers_read_own_cpa" ON customer_proof_assignments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM portal_customer_users
      WHERE portal_customer_id = customer_proof_assignments.portal_customer_id
        AND user_id = auth.uid()
    )
  );

-- Portal customers: can read their own pcu row
CREATE POLICY "customers_read_own_pcu" ON portal_customer_users
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Portal orders: admins/sales full access; customers see/create own
CREATE POLICY "admins_portal_orders" ON portal_orders
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND (role = 'admin' OR roles && ARRAY['admin','sales']::text[])
        AND (deactivated IS NULL OR deactivated = false)
    )
  );

CREATE POLICY "customers_own_orders" ON portal_orders
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM portal_customer_users
      WHERE portal_customer_id = portal_orders.portal_customer_id
        AND user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM portal_customer_users
      WHERE portal_customer_id = portal_orders.portal_customer_id
        AND user_id = auth.uid()
    )
  );

CREATE POLICY "admins_portal_order_lines" ON portal_order_lines
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
        AND (role = 'admin' OR roles && ARRAY['admin','sales']::text[])
        AND (deactivated IS NULL OR deactivated = false)
    )
  );

CREATE POLICY "customers_own_order_lines" ON portal_order_lines
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM portal_orders po
      JOIN portal_customer_users pcu ON pcu.portal_customer_id = po.portal_customer_id
      WHERE po.id = portal_order_lines.portal_order_id
        AND pcu.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM portal_orders po
      JOIN portal_customer_users pcu ON pcu.portal_customer_id = po.portal_customer_id
      WHERE po.id = portal_order_lines.portal_order_id
        AND pcu.user_id = auth.uid()
    )
  );

-- Allow unauthenticated reads on portal_customers by slug (for login page branding)
-- We expose only safe fields via a public function instead, so no anon policy here.
-- The /api/portal/[slug] route uses service role to fetch branding.
