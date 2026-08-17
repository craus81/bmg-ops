-- Vendor product-page URL for a part. FleetSuite-owned (like image_path and
-- marketing_description — the NetSuite sync never touches it). Populated by
-- the vendor-asset importer (which has the page URL in hand when it saves the
-- photo) or by hand on the Parts page. Shown to customers on the enhanced
-- estimate ("View product") where present.
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS product_url TEXT;

COMMENT ON COLUMN netsuite_parts.product_url IS
  'Vendor product-page URL (FleetSuite-owned; never overwritten by the NetSuite sync). Linked from the customer-facing estimate.';
