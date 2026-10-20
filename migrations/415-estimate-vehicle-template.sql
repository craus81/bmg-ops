-- Estimates pick their vehicle from the same Art Station template library
-- as the Graphics Builder (Craig 2026-10-19: "the vehicle make and model
-- selector on the estimates should mirror the graphics builder
-- selections"; he chose "Same picker + sync").
--
-- vehicle_template_id is the template the estimate's picker chose (or the
-- linked worksheet's, which every builder save writes back). make / model
-- keep the picker's choice when no template fits — a vehicle the library
-- has a make and model for but not the exact body. vehicle_platform_id
-- stays the parts catalog's fitment key and is worked out from these
-- (src/lib/vehicle-templates.ts platformFromVehicle).
--
-- Idempotent.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS vehicle_template_id UUID REFERENCES vehicle_templates(id) ON DELETE SET NULL;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS vehicle_make TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS vehicle_model TEXT;
CREATE INDEX IF NOT EXISTS estimates_vehicle_template_idx ON estimates (vehicle_template_id) WHERE vehicle_template_id IS NOT NULL;
