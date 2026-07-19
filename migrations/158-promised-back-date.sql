-- In-Shop upgrade: when does the customer need the vehicle back?
-- The date every "is it done yet?" call is really asking about — captured
-- at check-in (or set from the In-Shop card), it drives the board's
-- due-risk chips and overdue metrics, exactly like due dates on the
-- graphics board.

ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS promised_back_date DATE;

CREATE INDEX IF NOT EXISTS idx_fleet_checkins_promised_back
  ON fleet_checkins(promised_back_date)
  WHERE promised_back_date IS NOT NULL;
