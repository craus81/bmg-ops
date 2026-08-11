-- Migration 198: lock down schema_migrations (rls_disabled_in_public)
--
-- The migration runner (scripts/migrate.mjs) creates its schema_migrations
-- tracking table at connect time — outside any migration file, and long
-- after the RLS sweeps (027/044) ran against the hand-applied database. That
-- made it the one public table with RLS disabled, which Supabase's security
-- advisor flagged (09 Aug 2026). It's worse than a read leak: Supabase's
-- default grants give anon/authenticated full CRUD on public tables via
-- PostgREST, so anyone with the project URL could delete rows and cause
-- already-applied migrations to re-run on the next production build.
--
-- Fix: enable RLS with no policies (default-deny for the API roles) and
-- revoke the API grants outright, which also drops the table from the
-- PostgREST schema surface. The runner is unaffected — it connects as the
-- table's owner, whom RLS doesn't constrain without FORCE. migrate.mjs now
-- applies this same hardening right after CREATE TABLE, so a fresh database
-- never re-opens the hole; this migration exists to fix databases (like
-- production) where the table already predates that change.

ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON schema_migrations FROM anon, authenticated;
