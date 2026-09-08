-- R5-13: CNI pay-period batch payouts (installer payout autopilot, part b).
-- Individual-mode CNI work generates one vendor bill per job — four small
-- jobs means four bills, four approvals, four payment runs. A pay-period
-- payout gathers one installer's unlinked CNI credits across ALL jobs in a
-- date range into ONE payout → ONE NetSuite vendor bill.
--
-- kind='payroll_period' is TAKEN by the biweekly FIELD payroll flow
-- (admin/payroll — its amounts are hidden from workers on /earnings), so
-- CNI batches get their own kind and nothing downstream misreads them.
ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_kind_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_kind_check
  CHECK (kind IN ('cni_job', 'payroll_period', 'cni_period'));

COMMENT ON COLUMN payouts.kind IS
  'cni_job = one CNI job''s individual-mode payout; payroll_period = biweekly field payroll (amounts hidden from workers); cni_period = CNI pay-period batch across jobs (R5-13).';
