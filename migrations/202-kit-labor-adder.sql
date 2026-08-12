-- Migration 202: package-level labor adder (Craig's answer to N4-B1 Q3)
--
-- Member lines carry their own labor hours; this is the EXTRA assembly
-- overhead for installing the bundle as a whole ("the package takes 2h
-- beyond the parts' own labor"). On explode it lands as its own visible
-- zero-price line, so reps can see and edit it like any other line.

ALTER TABLE part_kits ADD COLUMN IF NOT EXISTS labor_adder_hours NUMERIC NOT NULL DEFAULT 0;
