-- Migration 414: delivery method on estimates, upfit projects and graphics jobs.
--
-- Valarie's ask (2026-10-20, via Craig): every Graphics Production job says
-- how the graphics reach the customer, with the details that go with it:
--   direct_ship      — UPS speed + ship-to address (+ optional contact)
--   onsite_install   — install address, installation contact, install notes,
--                      who installs (BMG crew or a CNI installer)
--   customer_pickup  — who to contact, special instructions
--   bmg_shop         — the vehicle comes to our shop for its graphics
-- Craig chose to enter it on the estimate and carry it to the upfit project
-- and the project's graphics jobs, all kept in step (src/lib/delivery.ts,
-- POST /api/delivery). Required on new Production jobs only; older jobs get
-- a method derived from their shipping speed below.
--
-- graphics_jobs keeps its existing ship_speed (speed) and ship_to (address)
-- columns for those two values so the packing list, tracking and shipping
-- flows keep reading them; estimates and upfit projects get their own.

ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS delivery_method TEXT,
  ADD COLUMN IF NOT EXISTS delivery_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS delivery_contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS delivery_notes TEXT,
  ADD COLUMN IF NOT EXISTS delivery_installer TEXT;

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS delivery_method TEXT,
  ADD COLUMN IF NOT EXISTS delivery_ship_speed TEXT,
  ADD COLUMN IF NOT EXISTS delivery_address TEXT,
  ADD COLUMN IF NOT EXISTS delivery_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS delivery_contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS delivery_notes TEXT,
  ADD COLUMN IF NOT EXISTS delivery_installer TEXT;

ALTER TABLE upfit_projects
  ADD COLUMN IF NOT EXISTS delivery_method TEXT,
  ADD COLUMN IF NOT EXISTS delivery_ship_speed TEXT,
  ADD COLUMN IF NOT EXISTS delivery_address TEXT,
  ADD COLUMN IF NOT EXISTS delivery_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS delivery_contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS delivery_notes TEXT,
  ADD COLUMN IF NOT EXISTS delivery_installer TEXT;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['graphics_jobs', 'estimates', 'upfit_projects'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_delivery_method_check') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (delivery_method IS NULL OR delivery_method IN (''direct_ship'', ''onsite_install'', ''customer_pickup'', ''bmg_shop''))',
        t, t || '_delivery_method_check');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_delivery_installer_check') THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (delivery_installer IS NULL OR delivery_installer IN (''bmg_crew'', ''cni''))',
        t, t || '_delivery_installer_check');
    END IF;
  END LOOP;
END $$;

-- Older jobs: derive the method from today's shipping speed. The pickup and
-- "Delivered by BMG / installed here" speeds stay on the row as history but
-- new jobs only pick UPS speeds.
UPDATE graphics_jobs
SET delivery_method = 'direct_ship'
WHERE delivery_method IS NULL
  AND ship_speed IN ('ups_ground', 'ups_3_day_select', 'ups_2nd_day_air', 'ups_next_day_air');

UPDATE graphics_jobs
SET delivery_method = 'customer_pickup'
WHERE delivery_method IS NULL
  AND ship_speed = 'customer_pickup';

UPDATE graphics_jobs
SET delivery_method = 'onsite_install',
    delivery_installer = CASE WHEN install_location = 'CNI Installer' THEN 'cni' ELSE 'bmg_crew' END
WHERE delivery_method IS NULL
  AND ship_speed = 'bmg_delivered'
  AND install_location IN ('Customer Site', 'CNI Installer');

UPDATE graphics_jobs
SET delivery_method = 'bmg_shop'
WHERE delivery_method IS NULL
  AND ship_speed = 'bmg_delivered';
