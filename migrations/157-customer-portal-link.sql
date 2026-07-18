-- Customer portal rebuild: link customer logins to their NetSuite customer
-- so the portal scopes automatically. Replaces the manual
-- customer_job_assignments wiring (admin hand-assigned every vehicle to
-- every contact) — one link per login covers everything, forever.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS customer_netsuite_id TEXT;

CREATE INDEX IF NOT EXISTS idx_profiles_customer_netsuite
  ON profiles(customer_netsuite_id)
  WHERE customer_netsuite_id IS NOT NULL;

COMMENT ON COLUMN profiles.customer_netsuite_id IS 'For customer-role logins: the NetSuite customer this account belongs to. Set from User Management; drives automatic portal scoping.';
