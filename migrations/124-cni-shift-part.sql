-- Migration 124: the chosen part lives on the work shift (CNI field-shift model)
--
-- Phase 2b-2 of the CNI redesign (docs/cni-redesign.md §1.2 / §1.3). A CNI
-- installer picks a part when they start scanning — just like a field shift —
-- held on the open work_shift until they switch it, rather than the part being
-- pinned to the job at creation. Each completed vehicle bills under the shift's
-- part. work_shifts.part_number already exists (used by field shifts); add the
-- description + billable customer so the shift snapshots the full chosen part
-- and the completion endpoints don't have to re-resolve it from netsuite_parts.
ALTER TABLE work_shifts ADD COLUMN IF NOT EXISTS part_description TEXT;
ALTER TABLE work_shifts ADD COLUMN IF NOT EXISTS billable_customer TEXT;
