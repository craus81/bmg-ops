# CNI Workflow Redesign — Target Architecture

**Status:** Proposal / planning. Nothing here is built yet. This is the shape
we agreed to review before writing code. Audit findings that motivate it are at
the bottom (§7) with file/line evidence.

**Goal in one sentence:** make a CNI job a first-class billing object — so the
VINs completed on it flow cleanly into the Scan Log and onto a customer invoice
off a PO — while collapsing the installer / company / vendor model down to one
coherent identity and removing the duplicate pages and tables that make the
section feel disjointed.

---

## 0. The core problem, stated plainly

CNI today serves **two independent money flows** that happen to share one table
(`scan_logs`):

| Flow | Who pays whom | Engine today | Health |
|---|---|---|---|
| **A — Pay the installer** | BMG → installer | `cni_job_vins` → `install_credits` → `payouts` → NetSuite **vendor bill** | Mature, mostly coherent (the pay-splits work). Keep it. |
| **B — Bill the customer** | customer → BMG | `scan_logs` → PO auto-match → `invoice-vehicles` → NetSuite **invoice** | Bolted on. Reachable from CNI only by accident. This is the gap. |

Flow A got three design phases (`docs/pay-splits-design.md`). Flow B was never
given first-class concepts on the CNI side: a CNI job has **no customer-PO
link**, its VINs only reach `scan_logs` **if the job happens to carry a part
number**, and even then nothing tells you "these are the VINs from job
CNI-…-001, here's the invoice." The redesign's center of gravity is giving Flow
B the same first-class treatment Flow A already has.

A secondary problem is **identity sprawl**: an installer is modeled three times
(`profiles`, `cni_profiles`, `companies`) and the pages disagree about which is
authoritative, producing duplicate editors, a misleading "change company" field
that changes nothing, and three navigation entries that open the same page.

---

## 1. Target data model

### 1.1 Identity: one model, `companies` is the spine

**Decision: `companies` + `profiles.company_id` is the single source of truth
for "who the installer works for." `cni_profiles` is per-person data only.**

```
companies ───────────────┐  (the org / the vendor)
  id                      │
  name                    │  authoritative org name
  phone, email, address   │
  netsuite_vendor_id      │  ← THE vendor id (company payout mode)
  w9/insurance (company)  │
  primary_contact_profile_id
        ▲
        │ profiles.company_id   (the ONLY membership link)
        │
profiles ──────────────── one row per login
  id, full_name, email, role(s)
  company_id ─────────────┘
  is_field_installer
        ▲
        │ cni_profiles.user_id (1:1)
        │
cni_profiles ──────────── per-PERSON installer data only
  capabilities, availability, compliance (per person),
  performance/risk, netsuite_vendor_id (individual payout mode)
  ✗ company_name      ← REMOVE (demote to companies.name)
  ✗ primary_contact_name ← REMOVE (dead)
```

Changes from today:

- **Delete `cni_profiles.company_name`.** It's a denormalized free-text copy of
  `companies.name` that drifts. Everywhere it's read, read `companies.name` via
  `profiles.company_id` instead. (Migration: backfill any company that exists
  only as a `company_name` string into a real `companies` row + set
  `company_id`, then drop the column.)
- **Delete the dead fields:** `cni_profiles.primary_contact_name`,
  `skill_level`, `referred_by` (none are read by any workflow). Keep the
  company-level compliance slots only if we add upload UI (§2.3); otherwise
  drop them too.
- **Two vendor-id columns stay, but with one rule:** `companies.netsuite_vendor_id`
  is used in `company` payout mode; `cni_profiles.netsuite_vendor_id` in
  `individual` mode. The UI must show only the one relevant to the job's payout
  mode (today both are editable everywhere — see §2.1).

### 1.2 Make a CNI job billing-aware (the key new structure)

A CNI job already knows its customer informally (`customer_name`) and inherits a
`billable_customer` from the part. It has **no PO and no NetSuite customer id**.
Add them so the job carries an invoice target from creation:

```sql
ALTER TABLE cni_jobs
  ADD COLUMN netsuite_customer_id TEXT,   -- resolved NetSuite customer (not free text)
  ADD COLUMN po_id   UUID REFERENCES purchase_orders(id),
  ADD COLUMN po_number TEXT;              -- denormalized for display
```

- `customer_name` stays as the human label; `netsuite_customer_id` is what
  `invoice-vehicles` actually needs (today it re-resolves `billable_customer` by
  exact-string match, which is the #1 silent invoice failure — §7 Flow B).
- `po_id` lets a job be tied to the customer PO it bills against **up front**, so
  every VIN completed on the job already has its invoice target. The PO can also
  be left null and matched later (back-compat), but the happy path sets it at
  creation.
- `billable_customer` on the job becomes derived/optional rather than the load-
  bearing key.

### 1.3 Decouple the three meanings of `part_number`

Today `cni_jobs.part_number` is simultaneously (a) the pay-rate key, (b) the
gate that decides whether a completed VIN is logged to `scan_logs` at all, and
(c) the invoice line item. That triple duty is why "job has no part → nothing is
billable AND nothing is paid."

Target:

- **Always log completed VINs to `scan_logs`**, even when the job has no part
  number. A scan with a null part is fine for tracking; it simply lands in a
  "needs part/pricing" state in the Scan Log instead of vanishing. (Removes the
  `if (job.part_number)` gate in `complete-vin` / `scan-vehicle` /
  `add-completed-vin`.)
- Pay credits already tolerate a null rate ("needs pricing"); mirror that on the
  billing side so a missing part blocks *invoicing* visibly rather than dropping
  the VIN silently.

### 1.4 Retire the legacy `scanned_vehicles` table

Migration 068 declared `scan_logs` the single source of truth, but
`scanned_vehicles` is still read in ~29 files (incl. live photo-review counts).
Plan: migrate the remaining readers (photo review, etc.) to `scan_logs` /
`cni_job_*`, verify nothing writes to `scanned_vehicles`, then drop it. Tracked
as its own phase (§3, Phase 0) because it's cross-cutting cleanup, not CNI-only.

---

## 2. Target pages & navigation

### 2.1 Collapse the entity pages

Today: `installers`, `companies`, `vendor-ids` — three pages with overlapping,
sometimes contradictory editors. Target: **the company is the hub.**

- **`/admin/cni/companies`** (list) and **`/admin/cni/companies/[id]`** (detail)
  become the single home for org + roster + vendor id + compliance.
  - Member roster with each member linking to their installer detail.
  - **One** vendor-id editor, shown contextually (company vs per-person by the
    company's default payout mode).
- **`/admin/cni/installers/[id]`** stays as the *person* detail (capabilities,
  availability, compliance-per-person, performance, job history) — but:
  - **Remove the "Company Name" text field** (the trap: it edits a dead string,
    not membership). Replace with a **read-only company link + a "Change
    company" action that actually sets `profiles.company_id`.**
- **Delete `/admin/cni/vendor-ids`** as a separate page; fold its bulk-edit
  convenience into the companies list (a "vendor IDs" view/filter there). One
  place to edit, period.

### 2.2 One navigation entry

Replace the **three** `More` menu entries that all open `/admin/cni`
("Certified Network Installs" / `all_jobs`, "Vendor Payments" /
`vendor_payments`, "CNI Management" / `cni_management`) with **one** entry and
one feature flag. Sub-sections (Jobs, Companies, Installers, Pay) live as tabs
on the CNI dashboard, not as separate top-level menu items.

### 2.3 One onboarding/creation flow

Today "invite installer" never creates a company and never sets `company_id`;
"create company" never invites anyone. Target: the invite flow picks **or
creates** a company at invite time, so a new installer is never left unassigned.
Company-level compliance upload UI added here (or the company compliance columns
dropped if we decide docs live per-person only).

---

## 3. The invoicing bridge (Flow B made real)

This is the user's stated #1 pain. Target experience:

### 3.1 On the CNI job detail page

A **"Billing" panel** showing:
- the job's customer + PO (from §1.2), editable;
- the list of completed VINs with their `scan_log_id` status:
  - ✅ in Scan Log, matched to PO, **ready to invoice**
  - ⚠️ in Scan Log, **waiting for PO** (with a "attach PO" action right here)
  - ⛔ completed but **not yet in Scan Log** (missing part — fix inline)
- a **"Invoice this job"** action that selects this job's ready VINs and calls
  the existing `invoice-vehicles` endpoint — the same engine the Scan Log uses,
  just scoped to one job.

This is the "pull VINs from CNI jobs into scans to invoice off a PO" capability,
made explicit and one-click. The data link (`cni_job_vins.scan_log_id`) already
exists; we're surfacing it as an action instead of leaving it implicit.

### 3.2 In the Scan Log (`/admin/scans`)

- Add a **source column + filter** ("CNI job CNI-…-001" vs field scan). Today
  CNI scans are indistinguishable from field scans, so you can't find "the VINs
  from that job."
- Allow **creating/attaching a PO from the Scan Log** for stuck "Waiting for PO"
  scans (today the only fix is editing the DB by hand).

### 3.3 Fix the silent failure modes

- Resolve and store `netsuite_customer_id` on the job at creation (§1.2) so
  invoicing doesn't depend on an exact `billable_customer` string match.
- Surface invoice-precondition failures (part not in `netsuite_parts`, customer
  unresolved, no open PO) as **visible states on the job's Billing panel**,
  not as a generic NetSuite 500 at invoice time.

---

## 4. What stays unchanged

- The whole **pay-splits / credits / payouts** apparatus (Flow A) —
  `work_shifts`, `install_credits`, `payouts`, payout modes, vendor bills. It
  works; the redesign only changes how it's *navigated to*, not how it computes.
- The **NetSuite vendor-bill specifics** in `docs/cni-vendor-bills.md` (vendor
  Internal ID gotcha, subsidiary 2 / account 223, header-only location). Still
  authoritative.
- `scan_logs` as the unified hub. We're widening what reaches it and what reads
  from it, not replacing it.

---

## 5. Phased build plan

Each phase is independently shippable as its own PR(s).

- **Phase 0 — Legacy cleanup.** Migrate remaining `scanned_vehicles` readers to
  `scan_logs`; drop the table. (Unblocks reasoning about "duplicate tables.")
- **Phase 1 — Identity consolidation.** Backfill `company_name` → real
  `companies` rows; drop `cni_profiles.company_name` + dead fields; one vendor-id
  editor; fix the installer-page company trap; collapse the 3 nav entries to 1.
  *No new billing yet — pure de-duplication.*
- **Phase 2 — Billing-aware jobs.** Add `netsuite_customer_id` / `po_id` /
  `po_number` to `cni_jobs`; wire job creation to resolve a NetSuite customer and
  (optionally) attach a PO. Remove the `part_number` logging gate so every
  completed VIN reaches `scan_logs`.
- **Phase 3 — The invoicing bridge.** Job Billing panel + "Invoice this job";
  Scan Log source filter + attach-PO-from-scan; visible precondition states.
- **Phase 4 — Onboarding unification.** One invite-or-create-company flow;
  compliance upload UI (or drop unused company compliance columns).

Recommended order if we want the user's pain addressed soonest: **Phase 2 → 3**
first (the invoicing they asked for), then **0 → 1 → 4** as cleanup — at the cost
of building Phase 2/3 on top of the still-messy identity model. Cleaner-but-
slower order is the numeric one. To be decided.

---

## 6. Open questions

1. **PO timing.** Should a CNI job *require* a PO at creation (clean billing,
   but blocks job creation when the PO isn't issued yet), or allow null + attach
   later (flexible, but reintroduces "waiting for PO")? Leaning: allow null,
   strongly surface the missing-PO state.
2. **Customer resolution.** Resolve `netsuite_customer_id` via a customer picker
   at job creation (like the part picker), or keep free-text + resolve at
   invoice time with fuzzy matching? Leaning: picker at creation.
3. **Phase order** (§5) — pain-first vs cleanup-first.
4. **Company compliance docs** — keep per-company W9/insurance (needs upload UI)
   or per-person only (drop the company columns)?

---

## 7. Audit evidence (current state)

### Identity sprawl
- Three models for one installer: `migrations/032-cni-profiles.sql`,
  `migrations/110-companies-and-pay-splits.sql` (companies reuse + comment lines
  55–61), `profiles.company_id`.
- "Change company" trap: `src/app/(main)/admin/cni/installers/[id]/page.tsx`
  edits `cni_profiles.company_name` only — never `profiles.company_id`.
- Two vendor-id editors for the same field: `src/app/(main)/admin/cni/vendor-ids/page.tsx`
  and `src/app/(main)/admin/cni/companies/[id]/page.tsx` (the latter even notes
  "use the Vendor IDs page").
- Three nav entries → one page: `src/app/(main)/more/page.tsx:105,108,142`
  (flags `all_jobs`, `vendor_payments`, `cni_management`, all → `/admin/cni`).
- Dead fields: `cni_profiles.primary_contact_name`, `skill_level`, `referred_by`.

### The `part_number` gate (VINs vanish from billing)
- `src/app/api/cni/complete-vin/route.ts` — `if (job.part_number && !vin.scan_log_id)`
  guards the `logScan()` call; no part ⇒ no `scan_logs` row.
- Same gate in `src/app/api/cni/scan-vehicle/route.ts` and
  `src/app/api/cni/add-completed-vin/route.ts`.
- `docs/pay-splits-design.md` lines 47–48 already flag this: "except CNI jobs
  *without* a part number, which complete VINs without a scan_log row."

### No customer/PO link on a job
- `migrations/033-cni-jobs.sql` — `cni_jobs` has `customer_name` / unused
  `customer_id`, **no `po_id`**.
- `src/app/(main)/admin/cni/jobs/new/page.tsx:91–94` — sets `customer_name`
  (free text) + `billable_customer` (from the part); never a NetSuite customer
  id or PO.

### Billing depends on exact string + an open PO
- `src/app/api/netsuite/invoice-vehicles/route.ts` — groups by
  `billable_customer`, resolves the customer by exact name; fails as a NetSuite
  error when it doesn't match.
- `src/lib/scan-match.ts` — auto-match only touches `po_id IS NULL AND
  exported_at IS NULL AND archived_at IS NULL`; no open PO ⇒ scan stuck in
  "Waiting for PO" with no in-UI way to create one.
- Direction mismatch: `src/app/api/cni/import-scans/route.ts` pulls field scans
  *into* a CNI job — the opposite of "push this job's VINs to the Scan Log."

### Duplicate scan tables
- Legacy `scanned_vehicles` still referenced in ~29 files despite migration
  `068-migrate-scanned-vehicles-to-scan-logs.sql`; e.g. live photo-review count
  in `src/app/(main)/more/page.tsx:41`.
