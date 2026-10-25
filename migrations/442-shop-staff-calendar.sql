-- Staff calendar (owner decision 2026-10-25): capacity comes from who is
-- working, by department. Admins keep a roster of the people who do the
-- work — name, department, normal hours per day and work days — and mark
-- the days someone will be out. Everyone on the roster is assumed to be
-- working their normal hours unless a time-off row says otherwise.
--
-- Departments: 'upfit' (the upfit shop; every estimate's labor hours count
-- here) and 'graphics_install' (graphics install labor, tracked
-- separately). Roster rows are not app accounts: some of the crew never
-- sign in, so profile_id is an optional link only.
--
-- Shop Week reads this for the upfit shop's daily capacity once at least
-- one active upfit person is on the roster; until then it keeps using
-- crew size × shift hours (migration 279). Per-day overrides
-- (shop_capacity_overrides) still win over both.

CREATE TABLE IF NOT EXISTS shop_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  department TEXT NOT NULL CHECK (department IN ('upfit', 'graphics_install')),
  hours_per_day NUMERIC(4,1) NOT NULL DEFAULT 8 CHECK (hours_per_day >= 0 AND hours_per_day <= 24),
  -- ISO weekdays, 1 = Monday … 7 = Sunday.
  work_days SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_time_off (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL REFERENCES shop_staff(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  -- Hours missed that day; NULL = the whole day.
  hours NUMERIC(4,1) CHECK (hours IS NULL OR (hours > 0 AND hours <= 24)),
  note TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (staff_id, day)
);

CREATE INDEX IF NOT EXISTS idx_staff_time_off_day ON staff_time_off(day);

ALTER TABLE shop_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_time_off ENABLE ROW LEVEL SECURITY;
-- Reads and writes go through the admin API (service role) only.
