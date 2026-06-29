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
The full onboarding → vendor-provisioning design is §2.4.

### 2.4 Onboarding & NetSuite vendor provisioning (deep dive)

The endgame: **FleetSuite collects the full installer/vendor packet — identity,
W-9/tax, insurance, and banking — and on approval *mints the NetSuite vendor
itself*, writing the Internal ID back automatically.** This replaces the manual
"create the vendor in NetSuite by hand, copy the numeric Internal ID, paste it
into FleetSuite" hop that `docs/cni-vendor-bills.md` warns about (and that was
the entire first-rollout failure).

**Current reality (starting point):**
- W-9 / insurance: the invite email *promises* upload
  (`src/app/api/cni/invite/route.ts:60`) but **no upload UI exists**; the admin
  page only displays `✓/✕` from `w9_file_path` / `insurance_cert_path`
  (`src/app/(main)/admin/cni/installers/[id]/page.tsx:602–626`), columns nothing
  ever writes.
- Bank data: not modeled anywhere.
- Vendor creation: no `createVendor` in `src/lib/netsuite.ts` — only
  `createCustomerOrLead`, `createItem`, `createSalesOrder`, `createDirectInvoice`,
  `createVendorBill`. Vendor IDs are hand-entered.
- Plumbing we already have: file uploads → Cloudflare R2 presign
  (`src/lib/r2.ts`); NetSuite record create pattern proven by
  `createCustomerOrLead` (`POST /services/rest/record/v1/customer`, read the new
  Internal ID off the response `location` header) and RESTlet calls via
  `callRestlet`.

**Decisions locked (2026-06-29):**
1. **Payment rail = NetSuite Electronic Bank Payments (EBP / SuitePayments).**
   Bank/ACH details land in NetSuite, on its EBP **Entity Bank Details** record
   (a managed custom record), not on the base vendor record.
2. **Bank + Tax ID are forward-only — FleetSuite does NOT retain them.** Collect
   in a secure form, push to NetSuite, then keep only **last-4 + a
   `bank_synced_at` flag**. FleetSuite never becomes a store of full account /
   routing / SSN-EIN numbers. (W-9 and insurance *documents* are retained in R2
   with restricted access — those are files, not raw numbers.)
3. **Vendor level follows `cni_jobs.payout_mode`:**
   - `company` mode → one **company vendor**; bank/W-9 captured at the company
     level; Internal ID → `companies.netsuite_vendor_id`.
   - `individual` mode → one **person vendor** per installer; bank/W-9 at the
     person level; Internal ID → `cni_profiles.netsuite_vendor_id`.

**Target onboarding flow (staged):**

1. **Admin invite** (as today) → installer gets a login.
2. **Installer self-onboarding** — steps:
   - *Identity & capabilities* (today's fields).
   - *Tax / W-9* — upload the W-9 PDF **and** capture legal name + Tax ID
     (EIN/SSN) + 1099-eligibility (NetSuite needs these structured, not just the
     file). The Tax ID is forward-only (decision 2).
   - *Insurance* — upload certificate + expiry (reuse `insurance_expiry`; add a
     renewal reminder).
   - *Banking* — routing + account number + account type, ACH. Forward-only.
3. **Admin review & approve** — admin sees the complete packet, verifies, clicks
   **"Create NetSuite Vendor."**
4. **FleetSuite provisions the vendor** (new `createVendor()`):
   - `POST /services/rest/record/v1/vendor` — `isPerson` true (person) or false
     (company), name, `subsidiary {id: 2}` (BMG Fleet Installations),
     `taxIdNum`, `is1099Eligible`, email/phone, `addressBook`.
   - Read the new Internal ID off the `location` header → store on
     `companies.netsuite_vendor_id` or `cni_profiles.netsuite_vendor_id` per
     payout level. **This is what eliminates the manual-paste gotcha** — and the
     `create_bill` flow then works because the ID is already correct/numeric.
   - **Bank details** push to the EBP **Entity Bank Details** record. This very
     likely needs a small **SuiteScript RESTlet** on the NetSuite side (the EBP
     bank-details custom record isn't in the standard REST record catalog), so
     bank-data sync is a distinct sub-task gated on that script + permissions.
   - Optionally copy the W-9 / insurance PDFs into the NetSuite **File Cabinet**
     and attach to the vendor.
   - On success: store `last4` + `bank_synced_at`; never persist the rest.

**NetSuite-side prerequisites (must confirm with the NetSuite admin):**
- Integration role gains **Lists → Vendors (Create)** (today it only has
  Transactions → Bills, per `docs/cni-vendor-bills.md`).
- For bank sync: the **EBP SuiteApp** installed, plus a RESTlet (or permissions)
  exposing the Entity Bank Details record, and role access to it.
- For doc attach: **File Cabinet** permission.

**Schema deltas (sketch):**
```sql
-- forward-only banking state (NO full numbers stored)
ALTER TABLE companies     ADD COLUMN bank_last4 TEXT, ADD COLUMN bank_synced_at TIMESTAMPTZ;
ALTER TABLE cni_profiles  ADD COLUMN bank_last4 TEXT, ADD COLUMN bank_synced_at TIMESTAMPTZ;
-- structured tax (forward-only value; retain only eligibility + a synced flag)
ALTER TABLE companies     ADD COLUMN is_1099 BOOLEAN, ADD COLUMN tax_synced_at TIMESTAMPTZ;
ALTER TABLE cni_profiles  ADD COLUMN is_1099 BOOLEAN, ADD COLUMN tax_synced_at TIMESTAMPTZ;
-- vendor provisioning audit
ALTER TABLE companies     ADD COLUMN vendor_provisioned_at TIMESTAMPTZ;
ALTER TABLE cni_profiles  ADD COLUMN vendor_provisioned_at TIMESTAMPTZ;
-- (netsuite_vendor_id already exists on both; now auto-populated, not hand-typed)
```

**Security posture:** the banking/Tax-ID step is the only place full sensitive
numbers exist in FleetSuite, and only in-flight. The submit handler pushes to
NetSuite server-side and discards the raw values; they are never written to a
table, never logged, never emailed. Retained docs (W-9/insurance PDFs) sit in R2
behind presigned, access-controlled URLs. This keeps FleetSuite out of scope as
a "system of record" for bank/SSN data.

---

## 3. The invoicing bridge (Flow B made real) — deep dive

This is the user's stated #1 pain: "no way to invoice based on CNI jobs / pull
VINs from CNI jobs into scans to invoice off a PO." The good news from the audit
is that **the engine already exists and is reusable** — the work is mostly about
stamping the right data at completion and surfacing it, not building a new
invoice path.

### 3.0 The key realization: the bridge is a *stamp*, not a new pipeline

`POST /api/netsuite/invoice-vehicles` already does exactly what we want. Reading
it (`src/app/api/netsuite/invoice-vehicles/route.ts`):

- Input is just `{ scanIds: string[] }`.
- It groups scans by **`billable_customer` + `po_number`**, one invoice per group.
- It resolves the customer with `findCustomer(billable_customer)` (by **name**),
  prices each part from `netsuite_parts.sales_price`, resolves the NetSuite
  location from the **PO's `ship_to`** (+ overrides), and sets the invoice's
  reference number (`otherrefnum`) to the **`po_number`**.
- **It does *not* read `po_line_items` at all** — it does not validate the part
  against the PO, does not check remaining quantity, does not touch `installed`.
  The PO is used only for *location* and the *reference number*.

So whether a CNI job's VINs are invoiceable comes down to **two string fields on
their `scan_logs` rows**: `billable_customer` (must resolve to a NetSuite
customer) and `po_number` (drives location + reference). Today CNI completion
stamps `billable_customer` from the *part* (usually null) and never stamps a PO —
which is precisely why nothing is invoiceable. Fix the stamp and the existing
engine just works.

### 3.1 What gets stamped, and from where

When a CNI VIN is completed (`complete-vin` / `scan-vehicle` /
`add-completed-vin`), the `logScan()` call should stamp:

| scan_logs field | today | target source |
|---|---|---|
| `billable_customer` | job's *part* `billable_customer` (often null) | **the job's customer** (§1.2 `customer_name` / resolved customer) |
| `po_id` / `po_number` | never set | **the job's PO** (§1.2 `cni_jobs.po_id` → `po_number`) |
| `part_number` | job part (gated) | job part — **and log even when null** (§1.3) so the VIN still appears, flagged "needs part" |

Net effect: a VIN completed on a CNI job that has a customer + PO lands in the
Scan Log already **ready to invoice**, attributed to the right customer and PO.

**One engine change for robustness:** `invoice-vehicles` resolves the customer by
name string, which is the #1 silent failure ("Customer not found"). Add an
optional `customerId` path: when a CNI job has a resolved `netsuite_customer_id`
(§1.2, set via a customer picker at job creation), stamp it onto the scan (new
nullable `scan_logs.netsuite_customer_id`) and let the engine prefer it over the
name lookup. Falls back to the existing name match for field scans.

### 3.2 The two roles of a PO (don't conflate them)

The audit shows a PO does two *separate* jobs; the design must treat them
separately:

1. **Scan→PO match** (`src/lib/scan-match.ts`) — auto-attaches a `po_number` to a
   scan *only* if an **open** PO has a line with the matching part and
   `installed < quantity`, and **increments `installed`**. This is the
   fulfillment/tracking ledger. It's also what gates the Scan Log's "Ready" vs
   "Waiting for PO" tabs.
2. **Invoice** (`invoice-vehicles`) — needs only the `po_number` string.

Because a CNI job *knows* its PO up front (§1.2), we don't have to rely on the
fuzzy auto-match to attach it. Target behavior at completion:

- **Always stamp the job's `po_id`/`po_number` directly** onto the scan (the job
  is the source of truth for which PO this work bills against). This means CNI
  scans are **never stuck in "Waiting for PO"** when the job has a PO.
- **Best-effort line bind for tracking:** if the job's part matches an open PO
  line with remaining qty, also set `po_line_item_id` and increment `installed`
  (reuse `scan-match` logic). If it doesn't match a line, still keep the PO
  header stamp and surface a soft **"part not on PO"** warning — invoicing isn't
  blocked (the engine doesn't check), but tracking is incomplete and the admin
  should know.

### 3.3 The CNI job "Billing" panel (new section on the job page)

The job detail page (`src/app/(main)/admin/cni/jobs/[id]/page.tsx`, ~1900 lines)
today has *only* Flow-A money UI (installer payouts, uploaded invoice file). Add a
**Billing panel** (Flow B), placed after the VINs section:

- **Header:** the job's customer + PO, **editable inline** (pick/Change PO,
  pick/Change customer). Shows the resolved NetSuite customer + PO ship-to →
  location preview so the admin sees where it'll bill *before* sending.
- **Per-VIN billing status** (joins `cni_job_vins.scan_log_id` → `scan_logs`):
  - ✅ in Scan Log, has customer + PO → **ready to invoice**
  - 🧾 already invoiced (`invoice_number` set) → shows the NS invoice #
  - ⚠️ in Scan Log but missing customer/PO → **fix inline** (attach PO / set
    customer right here)
  - ⛔ completed but **not in Scan Log** (job had no part) → **"log to Scan Log"**
    action that backfills the row
- **"Invoice this job"** button: collects the ready VINs' `scan_log_id`s →
  `POST /api/netsuite/invoice-vehicles` → on success runs the **same
  post-invoice bookkeeping the Scan Log page does** (`bulk-update` to set
  `invoice_number`, `date_invoiced`, `archived_at`). ⚠️ Note: the engine itself
  only sets `exported_at`; the invoice-number/archive stamping lives in the
  page handler (`src/app/(main)/admin/scans/page.tsx` `createInvoice`). To avoid
  duplicating that, **move the post-invoice bookkeeping into the
  `invoice-vehicles` endpoint** so both the Scan Log and the job page get it for
  free (small refactor, removes a latent drift bug).

This is the literal "pull VINs from CNI jobs into scans to invoice off a PO,"
one click, scoped to a job — built on the link (`cni_job_vins.scan_log_id`) that
already exists but was never surfaced.

### 3.4 Scan Log changes (`/admin/scans`)

- **Source column + filter.** CNI scans are today indistinguishable from field
  scans. Add a "source" derived from `cni_job_vins.scan_log_id` (and/or a job
  ref on the scan) so you can filter to "CNI job CNI-…-001" and batch-invoice a
  job's VINs from the Scan Log too.
- **Attach-PO from a stuck scan.** For "Waiting for PO" rows, allow attaching an
  existing PO inline (today the only fix is editing the DB). Reuses the §3.2
  direct-stamp + best-effort-line-bind.

### 3.5 The PO supply gap (call it out now)

POs are **import-only** today — Gmail auto-import + AI extraction, or admin PDF
upload (`src/app/api/gmail/import-po`). **There is no manual "create PO" UI.** So
"invoice a CNI job off a PO" presumes that customer's PO has been imported. Two
options, to decide (see §6 Q5):

- **(a)** Rely on import — the CNI customer's PO must be imported before the job
  can be invoiced (fine when CNI customers email POs like the upfit side does).
- **(b)** Add a lightweight **manual "create PO"** path (number, customer,
  ship-to, line items) for CNI customers who don't send importable POs. Smaller
  than it sounds: it's one insert into `purchase_orders` + `po_line_items`.

### 3.6 Failure modes, made visible (not 500s)

Every precondition that silently fails today becomes a **state on the Billing
panel**, checked before the invoice call:

| precondition | today | target |
|---|---|---|
| job has no part | VIN never reaches Scan Log | ⛔ "not in Scan Log — log it" action |
| `billable_customer` doesn't match NetSuite | NS "Customer not found" at invoice | resolved customer shown up front (§3.1 `customerId`) |
| part not in `netsuite_parts` | "No parts matched in NetSuite" | flagged on the VIN row before sending |
| no PO / wrong PO | stuck in "Waiting for PO" | PO shown + editable on the panel; never silently stuck |
| location unresolved | "Could not resolve a NetSuite location" | location preview from PO ship-to shown before sending |

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
- **Phase 3 — The invoicing bridge (§3).** Stamp `billable_customer` (job
  customer) + `po_id`/`po_number` (job PO) onto `scan_logs` at completion;
  optional `customerId` path on `invoice-vehicles` + move post-invoice
  bookkeeping into the endpoint; CNI Job **Billing panel** with per-VIN states +
  "Invoice this job"; Scan Log source filter + attach-PO-from-scan; visible
  precondition states instead of NetSuite 500s. Optional sub-PR: manual
  "create PO" path (§3.5, pending §6 Q5).
- **Phase 4 — Onboarding & vendor provisioning (§2.4).** One invite-or-create-
  company flow; staged onboarding with W-9/insurance upload (R2) + structured
  tax; secure forward-only banking step; `createVendor()` that mints the NetSuite
  vendor and auto-stores the Internal ID; EBP bank-details RESTlet for ACH sync.
  *Gated on NetSuite-side prerequisites (role perms, EBP, File Cabinet).* Split
  into sub-PRs: (4a) docs upload + status, (4b) `createVendor` + auto-ID,
  (4c) EBP bank sync.

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
   or per-person only (drop the company columns)? *Leaning: both, per §2.4
   decision 3 (company-level when payout_mode = company; per-person otherwise).*
5. **PO supply for CNI billing (§3.5)** — rely on PO import only, or add a
   lightweight manual "create PO" path for CNI customers who don't email
   importable POs? *Leaning: add manual create — it's a small insert and removes
   a hard dependency on the import pipeline for the CNI side.*
6. **Customer at job creation** — resolve `netsuite_customer_id` via a customer
   picker at job-creation time (robust invoicing, §3.1), or keep free-text +
   resolve by name at invoice time? *Leaning: picker at creation.*

### Resolved (2026-06-29) — onboarding & vendor provisioning (§2.4)
- **Payment rail:** NetSuite Electronic Bank Payments (ACH) — bank details go to
  NetSuite's EBP Entity Bank Details record.
- **Sensitive-data posture:** forward-only — FleetSuite collects bank/Tax ID,
  pushes to NetSuite, retains only last-4 + a synced flag.
- **Vendor level:** both, driven by `cni_jobs.payout_mode` (company vendor for
  company mode, person vendor for individual mode).
- **Still to confirm with NetSuite admin:** Vendors-Create role permission, EBP
  SuiteApp + a bank-details RESTlet, File Cabinet access.

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
