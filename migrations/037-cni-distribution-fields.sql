-- Migration 037: Add distribution fields to cni_jobs
-- Supports Phase 2: job publishing, invite-only, and bid tracking

-- Distribution type: how the job is made available to installers
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS distribution_type TEXT DEFAULT 'direct';
-- direct = coordinator picks installer manually (Phase 1 behavior)
-- invite = coordinator sends to specific installers, they respond
-- published = visible on open job board to all qualified installers

-- When was the job published to the open board
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- How many bids/responses received
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS bid_count INT DEFAULT 0;

-- Allow the status to include 'bidding_open' between awaiting_assignment and assigned
-- Drop and recreate the CHECK constraint on status
ALTER TABLE cni_jobs DROP CONSTRAINT IF EXISTS cni_jobs_status_check;
ALTER TABLE cni_jobs ADD CONSTRAINT cni_jobs_status_check CHECK (
  status IN (
    'awaiting_assignment',
    'bidding_open',
    'assigned_awaiting_scheduling',
    'scheduling_proposed',
    'scheduled_pending_confirmation',
    'scheduled_confirmed',
    'in_progress',
    'completed_pending_review',
    'approved_closed'
  )
);
