-- R5-17 part 2: ready-for-pickup nudge state. Auto-archive only covers
-- SHIPPED vehicles — a completed vehicle whose customer never comes sat in
-- the lot with no aging view and no follow-up. The nudge cron stamps its
-- sends here so reminders repeat weekly (not daily) and the sales-rep
-- escalation fires exactly once per ready period.

ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS pickup_nudge_sent_at TIMESTAMPTZ;
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS pickup_nudge_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS pickup_escalated_at TIMESTAMPTZ;

COMMENT ON COLUMN fleet_checkins.pickup_nudge_sent_at IS
  'Last automated pickup reminder to the customer (R5-17 nudge cron) — weekly repeats key off this.';
