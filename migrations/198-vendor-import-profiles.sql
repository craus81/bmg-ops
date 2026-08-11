-- Migration 198: saved vendor-import profiles
--
-- Craig 2026-08-11: "we should save imports so we can re run them easily."
-- Each vendor import is a recipe — site, teach-mode category URLs, vendor
-- tag, vendor filter — plus a discovery result that takes minutes to
-- rebuild (Ranger's catalog is a 470-page walk). Persist the whole thing
-- so a re-run is: load profile -> Import. The discovered URL list is
-- cached with a timestamp; "Find product pages" refreshes it in place.
--
-- Admin-only feature accessed through service-role API routes
-- (/api/parts/import-profiles, requireAdmin) — RLS is enabled with no
-- policies, so clients can't touch the table directly.

CREATE TABLE IF NOT EXISTS vendor_import_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  -- Teach-mode seeds (category/listing pages, one per array entry).
  listing_urls TEXT[] NOT NULL DEFAULT '{}',
  -- "Match only parts whose vendor contains…" filter (optional).
  vendor_scope TEXT,
  -- NetSuite vendor name stamped onto matched parts (optional).
  set_vendor TEXT,
  -- Cached discovery result: product page URLs + when they were found.
  discovered_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  discovered_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  -- { matched, imagesSaved, descriptionsSaved, vendorsSet, pages }
  last_run_stats JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE vendor_import_profiles IS
  'Saved vendor-asset import recipes (site, teach URLs, vendor tag) with cached discovery results — service-role access only.';

ALTER TABLE vendor_import_profiles ENABLE ROW LEVEL SECURITY;
