-- R5-17: customer-booked pickup & drop-off appointments. Both ends of a
-- shop visit are phone tag today — the completion email says "contact us
-- to arrange pickup" and nothing captures when approved work arrives. One
-- row per active booking; the customer's tokenized page books, reschedules
-- or cancels it, and the slot grid's concurrency guard is the partial
-- unique index (two customers can never take one slot).

CREATE TABLE IF NOT EXISTS shop_appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK (kind IN ('pickup', 'dropoff')),
  -- pickup → the vehicle being collected; dropoff → the approved estimate
  -- whose vans are arriving (project linkage resolved at write time).
  fleet_checkin_id UUID REFERENCES fleet_checkins(id) ON DELETE CASCADE,
  estimate_id UUID REFERENCES estimates(id) ON DELETE CASCADE,
  upfit_project_id UUID REFERENCES upfit_projects(id) ON DELETE SET NULL,
  slot_date DATE NOT NULL,
  slot_time TIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled', 'completed')),
  customer_name TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  notes TEXT,
  booked_via TEXT NOT NULL DEFAULT 'customer' CHECK (booked_via IN ('customer', 'staff')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  CHECK (fleet_checkin_id IS NOT NULL OR estimate_id IS NOT NULL)
);

-- The concurrency guard: one active booking per time slot, transactional —
-- a losing racer gets a 23505 and the API tells them the slot just went.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_appt_slot_unique
  ON shop_appointments(slot_date, slot_time) WHERE status = 'booked';
-- One active booking per vehicle / per estimate — "the same link
-- reschedules" means updating the row, never stacking a second one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_appt_active_checkin
  ON shop_appointments(kind, fleet_checkin_id) WHERE status = 'booked' AND fleet_checkin_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_appt_active_estimate
  ON shop_appointments(kind, estimate_id) WHERE status = 'booked' AND estimate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shop_appt_date ON shop_appointments(slot_date, status);

ALTER TABLE shop_appointments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff manage shop appointments" ON shop_appointments;
CREATE POLICY "Staff manage shop appointments" ON shop_appointments
  FOR ALL TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());
-- Customer writes go through the tokenized /api/book route (service role).

-- The booked pickup lands on the check-in so boards can read it without a
-- join (written by the booking API, service role only).
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS pickup_scheduled_date DATE;
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS pickup_scheduled_time TIME;
COMMENT ON COLUMN fleet_checkins.pickup_scheduled_date IS
  'Customer-booked pickup day (R5-17 shop_appointments mirror) — set/cleared by the booking API.';
