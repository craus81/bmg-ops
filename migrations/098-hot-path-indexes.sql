-- Migration 091: Indexes for hot read paths
--
-- Adds indexes for queries that show up on the dashboard, header, and
-- admin lists and were running unindexed. Each statement is
-- IF NOT EXISTS so re-running is safe; intentionally avoids
-- CONCURRENTLY since Supabase wraps migrations in a transaction and
-- CONCURRENTLY can't run inside one. Tables are small enough today that
-- a brief lock during CREATE INDEX is acceptable.

-- notifications: Header.tsx polls unread count and lists recent items on
-- every page load. user_id+read_at narrows to one user's unreads;
-- user_id+created_at DESC supports the dropdown listing.
CREATE INDEX IF NOT EXISTS idx_notifications_user_read
  ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);

-- purchase_orders: admin/scans page filters by status and orders by
-- created_at; no index existed.
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status_created
  ON purchase_orders(status, created_at DESC);

-- graphics_jobs: assignment lookups (upfit/page.tsx) filter by
-- assigned_to; no index existed.
CREATE INDEX IF NOT EXISTS idx_graphics_jobs_assigned_to
  ON graphics_jobs(assigned_to);

-- quotes: list views filter by status and order by created_at.
CREATE INDEX IF NOT EXISTS idx_quotes_status_created
  ON quotes(status, created_at DESC);

-- profiles: notify-admins paths filter by role+status; status filter is
-- the more selective of the two.
CREATE INDEX IF NOT EXISTS idx_profiles_status
  ON profiles(status);
