-- Migration 123: optional target vehicle count on CNI jobs
--
-- Phase 2 of the CNI redesign (docs/cni-redesign.md §2.5). Completion is not a
-- gate (billing/pay flow from scans regardless), but it's useful for the CNI to
-- see what's left. The admin can set an expected vehicle count at creation /
-- assignment; it counts down as vehicles are scanned. NULL = open-ended.
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS target_quantity INT;
