# Per-Vehicle Pay Splits — Design

**Status:** Draft for review — no code written yet.
**Scope:** Crew tagging, per-vehicle pay credits, uneven splits, individual
payouts, and admin corrections — for both CNI installer jobs and BMG field
installs (e.g., the U-Haul job billed to Designs That Stick).

## Problem

Multiple employees of the same company work the same install job. Pay needs to
split per completed vehicle by however many people worked that shift (2-way,
4-way, etc.), with:

- Installers able to see how many vehicles they completed and their cut per
  vehicle given that shift's crew size.
- Whoever scans tagging which employees are present that shift.
- Admin able to edit crews/credits after the fact.
- Even splits by default, uneven splits when needed.
- The option to pay employees individually (NetSuite bill per employee) instead
  of one company lump sum.
- The same mechanics on the BMG field side, where workers are payroll employees
  and the output is a per-pay-period earnings report instead of bills.

## What exists today

- CNI jobs have one `assigned_installer_id` and one lump-sum `budget`. Payment
  is: installer uploads invoice → admin approves → admin manually creates one
  NetSuite vendor bill and records `netsuite_bill_id`.
- `cni_job_vins` records `completed_at` but not who completed it.
- Both completion paths converge on `logScan()` (`src/lib/scan-log.ts`), which
  writes `scan_logs` — except CNI jobs *without* a part number, which complete
  VINs without a scan_log row.
- The field `/scan` page already has a "shift" concept (part + location locked
  until "End Shift") but no crew or money attached.
- Multiple `cni_profiles` can share a `company_name`; there is no crew/team
  table. Field installers are internal users in `profiles`.

## Core concepts

### 1. Shifts and crew tagging

A **shift** is a work session on a job/part with a tagged crew. Whoever is
scanning starts the shift and checks off who's present.

```sql
work_shifts (
  id UUID PK,
  context TEXT CHECK (context IN ('cni','field')),
  cni_job_id UUID NULL REFERENCES cni_jobs,     -- CNI shifts
  part_number TEXT NULL,                        -- field shifts (incl. custom job names)
  location_id UUID NULL, location_name TEXT NULL,
  started_by UUID REFERENCES profiles,
  started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ
)

work_shift_members (
  id UUID PK,
  shift_id UUID REFERENCES work_shifts ON DELETE CASCADE,
  profile_id UUID REFERENCES profiles,
  share_weight NUMERIC NOT NULL DEFAULT 1,      -- uneven splits (see below)
  added_by UUID, added_at TIMESTAMPTZ, removed_at TIMESTAMPTZ NULL
)
```

- Crew membership can change mid-shift (someone arrives late / leaves early).
  Changes only affect vehicles completed *after* the change, because each
  completion snapshots the roster (see Credits).
- A solo worker is just a crew of one — full rate, no behavior change. The
  field side can therefore roll out without affecting solo installers (an
  implicit one-person shift is created if they skip crew tagging).

**Uneven splits:** each member has a `share_weight` (default 1 = even split).
A lead on double share is weight 2 vs 1/1. Per-vehicle amount =
`rate × member_weight / Σ weights`. Weights are set at shift start by the
scanner (or by admin), and admin can override per vehicle after the fact.
Weights were chosen over percentages because they stay valid when crew size
changes mid-shift.

### 2. Credits — the per-vehicle pay ledger

Every completed vehicle generates one **credit row per crew member present**,
snapshotting the rate, weights, and dollar amount at completion time. The
snapshot is the source of truth — later rate changes or roster edits never
silently rewrite history (recomputes are explicit admin actions, see Admin
corrections).

```sql
install_credits (
  id UUID PK,
  shift_id UUID REFERENCES work_shifts,
  profile_id UUID REFERENCES profiles,          -- who earns it
  -- what was completed (at least one set):
  scan_log_id UUID NULL REFERENCES scan_logs,
  cni_job_vin_id UUID NULL REFERENCES cni_job_vins,
  vin TEXT,                                     -- denormalized for reporting
  -- snapshot:
  rate_per_vehicle NUMERIC,                     -- NULL = needs pricing (field, no rate configured)
  share_weight NUMERIC, crew_size INT, total_weight NUMERIC,
  amount NUMERIC,                               -- the dollars credited (NULL until priced)
  source TEXT CHECK (source IN ('cni','field')),
  -- payout linkage + audit:
  payout_id UUID NULL REFERENCES payouts,       -- locked once set
  voided_at TIMESTAMPTZ NULL, voided_by UUID NULL,
  created_at TIMESTAMPTZ,
  edited_by UUID NULL, edited_at TIMESTAMPTZ NULL,
  CHECK (scan_log_id IS NOT NULL OR cni_job_vin_id IS NOT NULL)
)
```

Credits are created server-side at the moment of completion:

- **CNI:** `/api/cni/complete-vin` looks up the job's active shift and writes
  credits alongside the existing scan_log + cni_job_vins updates. Also adds
  `completed_by` and `shift_id` to `cni_job_vins` for audit.
- **Field:** `logScan()` accepts a `shift_id`; the `/scan` page passes the
  active shift. Offline scans queue the shift_id and credits are created at
  sync. Duplicate-scan rejections (409) create no credits.

### 3. Rates

- **CNI jobs:** new `cni_jobs.pay_per_vehicle NUMERIC`, set by admin at job
  creation, defaulting to `budget / vin_count`. Sum of all credits on a job
  reconciles to `pay_per_vehicle × completed VINs`.
- **Field:** admin-managed rate table keyed by the same string that lands in
  `scan_logs.part_number` (real part numbers *and* custom job names like
  "Uhaul Regular"):

```sql
install_pay_rates (
  id UUID PK,
  part_number TEXT UNIQUE,            -- matches scan_logs.part_number / custom job name
  rate_per_vehicle NUMERIC,
  active BOOLEAN DEFAULT true,
  created_by UUID, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
)
```

If a field scan has no configured rate, credits are still created with
`rate_per_vehicle = NULL` and surface in admin as "needs pricing"; setting the
rate fills in the unpriced credits. Crew tracking never blocks on pricing.

### 4. CNI crew roster

```sql
cni_job_crew (
  id UUID PK,
  job_id UUID REFERENCES cni_jobs ON DELETE CASCADE,
  profile_id UUID REFERENCES profiles,          -- must have a cni_profile
  added_by UUID, added_at TIMESTAMPTZ
)
```

- The assigned installer stays the **lead** (scheduling, invoice, messages).
- Admin adds crew members; the lead can also add coworkers whose `cni_profiles`
  share their `company_name` (soft rule, admin can override).
- Crew members get read access to the job and appear in the shift-start
  checklist. **Each employee needs their own login** to see their earnings —
  that's the tradeoff for the installer-facing visibility requirement.
- RLS: crew members read the job + their own credits; only admins read/write
  credits broadly.

### 5. Payouts

```sql
payouts (
  id UUID PK,
  profile_id UUID REFERENCES profiles,
  kind TEXT CHECK (kind IN ('cni_job','payroll_period')),
  cni_job_id UUID NULL,                          -- cni_job payouts
  period_start DATE NULL, period_end DATE NULL,  -- payroll payouts
  total_amount NUMERIC,
  status TEXT CHECK (status IN ('draft','approved','billed','paid')),
  netsuite_bill_id TEXT NULL,
  approved_by UUID NULL, approved_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ
)
```

Credits link to their payout via `install_credits.payout_id`; once linked to a
non-draft payout they are **locked** against recompute (void + reissue is the
only correction path, keeping the audit trail).

**CNI — per-job payout mode.** New `cni_jobs.payout_mode`
(`'company'` default | `'individual'`):

- `company`: today's flow unchanged — one invoice, one NetSuite bill to the
  company. Credits are informational: the admin job page and the company lead
  get a per-employee breakdown to check the invoice against / divide pay with.
- `individual`: when the job is approved, the app generates one **draft payout
  per employee** from their credits (an itemized statement: VINs, dates, crew
  size, amounts). Admin approves each, creates the vendor bill in NetSuite
  manually (matching today's manual pattern), and records the bill ID per
  payout. Each employee needs a NetSuite vendor record — store
  `netsuite_vendor_id` on `cni_profiles`. The job-level invoice upload is
  skipped in this mode; the generated statements replace it.

**Field — payroll report.** Field workers are W-2 payroll employees, so field
credits are never NetSuite-billed. Admin gets a payroll report page: pick a
pay period → per-employee totals with per-vehicle drill-down → CSV export for
payroll → mark the period's credits as a `payroll_period` payout (`paid`) so
nothing double-counts.

### 6. Admin corrections

Two levels of edit, both audit-logged (`edited_by`/`edited_at`, plus void
trail), both restricted to unlocked (un-paid-out) credits:

1. **Shift edit** — "Joe wasn't there Tuesday": add/remove members or change
   weights on a shift → recompute all that shift's unlocked credits in one
   action, with a preview of the dollar deltas.
2. **Per-vehicle edit** — adjust one vehicle's credit list/weights/amounts
   directly for one-off corrections.

Reopening a completed VIN (or archiving/deleting a scan) voids its credits.

## Installer experience

- **CNI job page:** a shift bar — "On shift: you + Mike + Dana · $25.00/vehicle
  to you" — with start/end shift and the crew checklist. Completed VINs show
  the split ("÷3"). New **My Earnings** page: per job and running totals —
  vehicles credited, crew size each, their amount, payout status.
- **Field `/scan` page:** after part + location, an optional "Who's working
  with you?" step (skipping = solo). The locked banner adds crew + "your cut"
  when a rate exists. End Shift closes the work_shift.
- Employees see only their own numbers; the lead sees the whole crew's
  breakdown; rates invisible on field scans until priced.

## Admin screens

- **Pay rates** (`/admin/pay-rates`): CRUD for `install_pay_rates`, plus the
  "needs pricing" queue of unpriced credits.
- **CNI job page additions:** crew roster editor, `pay_per_vehicle` +
  `payout_mode` fields, shifts list with credit totals, shift/per-vehicle
  credit editors, per-employee payout statements (individual mode) with
  NetSuite bill ID entry.
- **Payroll report** (`/admin/payroll`): pay-period picker, per-employee
  totals + drill-down, CSV export, "mark period paid".

## Reconciliation invariants

- Per vehicle: `Σ credit amounts = rate_per_vehicle` (always, including uneven
  splits).
- Per CNI job: `Σ all credits = pay_per_vehicle × completed VINs` — shown
  against `budget` on the admin job page so over/under is visible before
  approving payouts or the company invoice.

## Build phases

1. **Tracking** — migrations; shift start/crew tagging on both sides; credit
   snapshots in `complete-vin` and `logScan()`; rate table + CNI
   `pay_per_vehicle`; admin shift/credit editing. Tracking starts immediately;
   money stays invisible to installers until rates are set.
2. **Visibility** — installer My Earnings + shift-bar UX; admin payroll report
   with CSV export.
3. **Payouts** — `payout_mode` on CNI jobs; generated per-employee statements;
   NetSuite vendor ID on profiles; bill-ID workflow; credit locking.

## Open questions

- Pay-period definition for the payroll report (weekly? biweekly? which day
  does it start?).
- Should the field crew picker list *all* internal profiles or a curated
  "field installer" subset?
- For `individual` CNI payouts: any employees without NetSuite vendor records
  yet, and who sets those up?
- Does the U-Haul rate vary by vehicle type (box truck vs van vs trailer)? If
  so the rate table needs a second dimension (rate per part + vehicle class).
