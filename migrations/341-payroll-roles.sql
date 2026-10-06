-- Migration 341: payroll roles per Paychex employee (owner ask 2026-10-06).
--
-- Each Paychex employee gets one BMG role, set on Reports → Paychex Payroll →
-- People (prefilled from their FleetSuite login role). Roles roll up to a
-- division so payroll splits into Upfit vs Graphics, with Sales and
-- Office/Admin as Shared (src/lib/paychex-payroll.ts PAYROLL_ROLES):
--
--   shop_tech, upfit_management                                 → upfit
--   graphics_production, graphics_installer, graphics_management → graphics
--   sales, office_admin                                         → shared
--
-- Keyed by Paychex employee ID, not profile, because owners and others who
-- never log in to FleetSuite still need a role. The role also picks the
-- shop labor pools: upfit timers are costed at the Shop Tech pool, graphics
-- timers at the Graphics Production + Installer pool.
-- No RLS policies: service role only, behind requireFinancials.

CREATE TABLE IF NOT EXISTS payroll_employee_roles (
  paychex_employee_id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN (
    'shop_tech', 'upfit_management',
    'graphics_production', 'graphics_installer', 'graphics_management',
    'sales', 'office_admin'
  )),
  set_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payroll_employee_roles ENABLE ROW LEVEL SECURITY;
