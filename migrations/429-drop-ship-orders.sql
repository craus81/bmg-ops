-- Migration 429: drop ship POs made from an estimate's sales order.
--
-- Craig (2026-10-23, thread "Drop-ship orders for in-stock parts"): a part
-- we have on the shelf sometimes has to be bought again and shipped by the
-- vendor straight to the customer. "Drop ship from vendor" on the estimate
-- marks the sales order lines Drop Ship in NetSuite, which makes a linked
-- purchase order shipping to the customer. Our stock never moves.

CREATE TABLE IF NOT EXISTS public.drop_ship_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id UUID REFERENCES public.estimates(id) ON DELETE SET NULL,
  sales_order_id TEXT NOT NULL,
  sales_order_number TEXT,
  purchase_order_id TEXT,
  purchase_order_number TEXT,
  vendor_netsuite_id TEXT,
  vendor_name TEXT,
  -- { name, attention, address, address2, city, state, zip, phone }
  ship_to JSONB,
  -- [{ soLine, itemId, itemNumber, description, quantity, rate }]
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  memo TEXT,
  emailed_at TIMESTAMPTZ,
  emailed_to TEXT[],
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drop_ship_orders_estimate_idx ON public.drop_ship_orders (estimate_id);
CREATE INDEX IF NOT EXISTS drop_ship_orders_so_idx ON public.drop_ship_orders (sales_order_id);

-- Written and read only by the service-role routes under
-- /api/estimates/[id]/drop-ship (admin gate), so no policies.
ALTER TABLE public.drop_ship_orders ENABLE ROW LEVEL SECURITY;

-- A drop ship PO never comes into O'Fallon: the parts readiness checks, the
-- purchase-request auto-match and Receiving leave these POs out. The vendor
-- PO sync never writes this column, so the flag survives every sync.
ALTER TABLE public.netsuite_vendor_pos ADD COLUMN IF NOT EXISTS drop_ship BOOLEAN NOT NULL DEFAULT false;

COMMENT ON TABLE public.drop_ship_orders IS 'Drop ship POs made from an estimate''s sales order (vendor ships to the customer). Migration 429.';
COMMENT ON COLUMN public.netsuite_vendor_pos.drop_ship IS 'Vendor ships straight to the customer: not stock coming into a BMG location.';
