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

### 1.2 CNI scanning **is** field scanning (the governing principle)

**Decision (2026-06-29):** a CNI job does **not** pre-know POs, customers, or
VINs. Billing works exactly like a BMG field tech doing field work. The CNI
"job" stays as the coordination wrapper (assignment, bidding, scheduling,
photos, completion review, pay) — but the **scan→bill path is the one unified
field path**, not a CNI-specific mechanism.

Concretely, the installer's experience mirrors the field `/scan` page
(`src/app/(main)/scan/page.tsx`, the `part → location → scan` shift model):

- **Pick a part before scanning, held persistent until they switch it.** Same as
  the field shift: the part (and location) lock in at shift start, every scan in
  that session inherits them, and the part only changes on an explicit "Switch
  Part" / "End Shift". The part is chosen *by the installer at scan time*, **not**
  pre-loaded onto the job and **not** required at job creation. (Persisted like
  field's `scan_session` so it survives reloads within the shift.)
- **VINs are discovered by scanning**, not pre-loaded. Drop the assumption that a
  job carries a known VIN list / `vin_count` up front; the `cni_job_vins` rows
  are created as vehicles are scanned (an admin can still add a missed one after
  the fact, as today).
- **PO and customer are resolved downstream in the Scan Log**, identical to
  field. `billable_customer` comes from the chosen part (as field does today);
  the PO is attached by `matchScansToOpenPos`; admin finalizes/re-assigns in
  the Scan Log. **No `po_id` / `netsuite_customer_id` on `cni_jobs`** — that
  earlier idea is dropped in favor of the field flow.

What this deletes from the plan: the §1.2-old `cni_jobs.po_id` /
`netsuite_customer_id` columns, the "job carries an invoice target" stamping, and
any "preload the VIN list / PO" notion. CNI billing is no longer special.

### 1.3 `part_number` — picked at the shift, not owned by the job

Since the part is chosen at shift start (§1.2), `cni_jobs.part_number` stops
being a required, load-bearing creation field. It may still exist as an optional
**default** the installer's part picker pre-selects (convenience only), but:

- It is **not** the gate for logging. Every scan logs to `scan_logs` with the
  part the installer picked for that shift — exactly like field. (The current
  `if (job.part_number)` gate in `complete-vin` / `scan-vehicle` /
  `add-completed-vin` goes away; the part comes from the active shift instead.)
- Pay rate keys off the shift's part (`install_pay_rates`) / the job's
  `pay_per_vehicle`, mirroring field's "needs pricing" tolerance when no rate is
  set — billing/pricing surfaces the gap visibly rather than dropping the VIN.

### 1.4 Retire the legacy `scanned_vehicles` table

Migration 068 declared `scan_logs` the single source of truth, but
`scanned_vehicles` is still read in ~29 files (incl. live photo-review counts).
Plan: migrate the remaining readers (photo review, etc.) to `scan_logs` /
`cni_job_*`, verify nothing writes to `scanned_vehicles`, then drop it. Tracked
as its own phase (§3, Phase 0) because it's cross-cutting cleanup, not CNI-only.

### 1.5 Identity consolidation — migration & refactor (deep dive)

The "duplicate instances" feeling comes from one installer being modeled three
times (`profiles`, `cni_profiles`, `companies`) with the pages disagreeing on
which is authoritative. The fix is cheaper than it looks, because the spine
already exists.

**Finding that makes this cheap:** `profiles.company_id → companies` is *already*
the de-facto source of truth. Everything that matters keys off it —
- `/api/cni/installers` GET resolves the company name from `company_id`
  (`route.ts:73-74`), not from `cni_profiles.company_name`;
- RLS via `cni_user_company_id()` (migration 110);
- scan attribution `resolveScannerCompany` (`src/lib/scan-log.ts:52-68`);
- job assignment `cni_jobs.assigned_company_id`;
- the entire companies page (add/remove member = set `profiles.company_id`,
  `companies/[id]/page.tsx:221-233`).

Only **four surfaces** still read/write the denormalized
`cni_profiles.company_name`: the installers list, the installer detail edit form,
the invite stub (`/api/cni/invite`), and onboarding/installer-profile. So
consolidation is mostly **deleting a redundant copy**, not re-plumbing.

**The "change company" trap, exactly (confirmed):** `installers/[id]` *reads* the
real name from `companies` on load and even re-syncs it into `company_name`
(`page.tsx:101-111`) — but the edit form's "Company" field writes **only**
`cni_profiles.company_name` (`page.tsx:202-203`) and never touches
`profiles.company_id`. An admin "changing the company" changes a label, not
membership.

**Two editors for the same field (confirmed):** both `/admin/cni/vendor-ids` and
the companies-page member rows PATCH `/api/cni/installers`, which upserts
`cni_profiles.netsuite_vendor_id` (`route.ts:117-118`). Same field, two UIs, no
cross-awareness — plus the companies page carries a "use the Vendor IDs page"
apology note.

**Migration (one-time):**
1. For each distinct `cni_profiles.company_name` not already represented by the
   installer's `company_id`: **find-or-create** a `companies` row by exact name
   (values are clean — `docs/pay-splits-design.md:329-332`) and set
   `profiles.company_id`.
2. For any installer still without a `company_id` (no name either):
   **auto-create a one-person company** from their full name and link it — per
   the resolved policy that every installer belongs to a company (§6, resolved).
   After this, **no active installer is company-less**; report any exceptions.
3. Drop `cni_profiles.company_name` and the dead fields
   (`primary_contact_name`, `skill_level`, `referred_by`).

**Page / API refactors:**
- **installers/[id]:** replace the free-text "Company" field with a **company
  picker that sets `profiles.company_id`** (find-or-create inline), or a
  read-only company link + a "Change company" action. Remove the `company_name`
  write entirely — this kills the trap.
- **installers list:** read the company from `company_id → companies.name` (the
  API already returns exactly this).
- **One vendor-id editor:** keep the bulk `vendor-ids` page as the single editing
  surface and make the companies-page member rows **read-only with a link to
  it** — or extract one shared `<VendorIdEditor>` used in both (they already
  PATCH the same idempotent endpoint). Drop the apology note.
- **Show the right vendor id by payout mode:** the **company**
  `netsuite_vendor_id` when the company defaults to `company` payout, the
  **per-person** ones when `individual` — never both at once (ties to §2.4).
- **Nav:** collapse the three `/admin/cni` entries (`all_jobs`,
  `vendor_payments`, `cni_management`) to **one** "CNI" entry; Jobs / Companies /
  Installers / Pay become tabs (§2.2).

**Creation unification (with §2.3/§2.4):** the invite flow **picks or creates a
company** and sets `profiles.company_id` at invite time, so no installer is ever
left unassigned; the invite stub stops writing `company_name`.

**Solo installers (resolved 2026-06-29):** **every installer belongs to a
company.** A solo installer is a one-person company, auto-created at invite — so
assignment, bidding, and payout have no special "independent" path. The
"Independent" display (`installers/[id]/page.tsx:373`) goes away; the migration
auto-creates one-person companies for any company-less installer (step 2 above),
and invite always creates-or-links a company.

### 1.6 A third scan channel — admin enters VINs *for* an installer

Not every CNI installer will use the app. Some will email a spreadsheet, a list,
or **photos of the VINs** (or handwritten install worksheets). Those must still
flow into the **same `scan_logs` pipeline**, credited to the right company +
crew, billable *and* payable exactly like an in-app scan. This is the third way a
scan enters the system; all three converge on `logScan()` + pay credits:

1. Installer scans in-app (CNI = field, §1.2)
2. BMG field tech scans in-app
3. **Admin bulk-enters on behalf of an installer** (this section)

**What already exists (scattered — the work is unifying, not building):**
- `/admin/import-installs` (+ `/api/admin/import-installs`) — paste/spreadsheet of
  VINs → `logScan()` → `scan_logs`. ✅ billing rows, dedup, device IDs. ❌ but it
  credits a **free-text company string** (`scanned_by_company`), not a real
  `companies` row, and writes **no pay credits** (`install_credits`) — so imported
  work is billable but the installer isn't *paid* for it.
- `/api/scan-worksheet` — Claude already **reads photos/PDFs of install
  worksheets** and extracts VIN-last-8 + Unit# + part + PO + customer per page.
  ✅ the "pictures of VINs" path largely exists — but returns **VIN last-8** (see
  wrinkle) and isn't wired to `logScan` / credits.
- `add-completed-vin` — admin adds **one** completed VIN *with* crew + pay
  credits. ✅ the pay-credit pattern to reuse for the bulk path.
- `bulk-vin-upload-code.tsx` (repo root) — a ~59KB **dead/unwired** bulk-upload UI
  on the old `scanned_vehicles` model. Salvage ideas, then delete.

**Target — one "Scan for an installer" admin tool** that mirrors the field shift:
- Pick the **company** (real `companies` row, §1.5) + **crew** (pay splits) +
  **part** + **location** — the same inputs as starting a field/CNI shift, done by
  an admin on the installer's behalf.
- Feed VINs through any channel into one staging grid: typed/pasted list,
  spreadsheet upload (today's parser), or **photos/PDF** → `scan-worksheet` AI
  extraction (worksheets) + plain-photo VIN OCR (reuse `VinScanner`'s decode).
- Each row → `logScan()` (shared dedup / device IDs / PO match) **and** pay
  credits to the chosen crew at the part/job rate (reuse `add-completed-vin`).
- Identical downstream: dedup, PO decrement (§3.2), Scan Log, invoice.

**Fixes folded in:** import-installs credits a real `companies` row + writes pay
credits; the worksheet/photo path joins the same tool; the dead root file is
removed.

**Full VIN vs last-8 — doesn't matter for billing/pay (resolved 2026-06-29).**
Billing and pay never key off the VIN string: PO matching is by **part number**
(`scan-match`), the invoice sends vehicle **counts** (not VINs) to NetSuite
(`invoice-vehicles`), and pay is rate × vehicles. The VIN is just a
reference/dedup token, and `logScan` only requires ≥5 chars — so an 8-char VIN
flows through unchanged. **No reconciliation step; accept last-8 or full VIN as
entered.** Two honest, non-blocking caveats: (a) auto-decoding year/make/model
needs a full VIN — a last-8 row just won't auto-fill vehicle details (admin can
type them or leave blank); (b) ~~cross-format dedup~~ — **resolved**: dedup now
compares the VIN **last-8** (§3.2), so the same vehicle entered once full and once
as last-8 *is* caught (flagged, with admin override).

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

### 2.5 Job lifecycle — what stays, what changes (deep dive)

**Good news:** the lifecycle already supports most of the target model —
company-based assignment + RLS, **ad-hoc scan-during-work** (no pre-loaded VIN
list), crew shifts, and the audit trail. This is mostly *removing* a couple of
pre-loaded-list assumptions and *finishing* the company migration, not a rebuild.

**Target lifecycle (6 phases):**

| # | Phase | Status | Who drives it |
|---|---|---|---|
| 1 | **Create** | `awaiting_assignment` | Admin: title, customer, optional **default** part, payout mode, pay rate. **No VINs, no required part** (§1.3). |
| 2 | **Distribute & assign** | `bidding_open` → … | Admin: direct-assign a company, *or* invite companies, *or* publish to board → pick winner → `assigned_company_id`. Bidding is optional. |
| 3 | **Schedule** | `scheduling…` → `scheduled_confirmed` | Admin proposes a datetime (`scheduled_start_at`, migration 113); company confirms/declines; admin may confirm on their behalf. |
| 4 | **In progress** | `in_progress` | Admin "Start Work". Installer **starts a shift, picks the part** (defaults to the job's if set), held persistent; **scans VINs** (each → `scan_logs` + credits + `cni_job_vins`), like field. Crew tagged on the shift. |
| 5 | **Complete** | `completed_pending_review` | **Installer-driven** "End Shift / Mark Job Complete" — *not* auto-on-empty (see fix). Optional **target quantity** gives a countdown. |
| 6 | **Review & close** | `approved_closed` | Admin reviews per-VIN photos → approves → closes → unlocks payout. Billing (Scan Log → invoice) runs independently. |

**The one real bug to fix — premature auto-completion.** Today `complete-vin`
(`route.ts:151-157`) and `scan-vehicle` advance the job to
`completed_pending_review` the moment **no VIN is left in a non-completed
status**. That was right for a *pre-loaded list* (finish the list → done). In the
**discovered-VIN** model every scanned vehicle is immediately completed, so "zero
pending" is true after the **first** scan — the job would mark itself done after
one vehicle. Fix: **completion becomes an explicit installer action** ("End Shift
/ Mark Job Complete"), with an admin "mark complete" too. Remove the
auto-advance-on-empty.

**Other changes (mostly deletions / cleanup):**
- **Part at creation = optional default**, not required (`new/page.tsx:73` drops
  the hard check). The installer picks the part at shift start (§1.2),
  pre-filled from the job's default if present.
- **Optional target quantity instead of a pre-loaded VIN list (resolved
  2026-06-29).** Completion isn't important to BMG's internal system — billing
  and pay flow from scans regardless. But it's useful for the **CNI to see what's
  left**. So at assignment the admin can set an optional **`target_quantity`**
  (expected vehicles) — or leave it **null = open-ended**. As vehicles are
  scanned, the installer sees a countdown ("12 of 30 done · 18 left"); reaching
  the target may *prompt* "looks done?" but never force-completes. Open-ended jobs
  rely purely on the explicit "Mark Job Complete". Replaces `vin_count` /
  `is_multi_unit` as gates (those stay only as legacy/no-op). Not a completion
  gate — purely a progress indicator + optional admin visibility.
- **Finish the company migration on lifecycle stragglers:** the status-history
  trigger + RLS (migration 035) and various checks still key on
  `assigned_installer_id`; move them to `assigned_company_id` /
  `cni_user_company_id()`. The bids page drops its legacy `assignFromBid`
  (individual) path — company invites/bids (migration 111) fully supersede the
  per-installer ones (036). `assigned_installer_id` stays read-only for
  historical jobs.
- **Photo review stays**, but the **required photo set becomes configurable per
  job** — an RFID/device-capture job needs different evidence than a full wrap,
  and forcing 5 fixed angles on every job is friction. (Today's required types
  are hard-coded, migration 038.)
- **Naming cleanup:** `/installer/ready-for-install` is the **upfit
  `fleet_checkins` queue, not CNI** — rename/relocate so it isn't mistaken for a
  CNI "ready" state.

**What stays unchanged:** the distribution/bidding model, admin-proposes
scheduling (113), crew shifts + pay credits, the status-history audit, and the
installer bidding board (`/installer/available`).

**Open question (§6 Q10):** **reopen for stragglers.** A site visit can spill —
a few more vehicles show up after the installer marked the job complete. Allow an
admin (or the installer) to reopen `completed_pending_review → in_progress` to
add them before closing? Today reopening a completed VIN voids its credits;
job-level reopen needs to *not* disturb already-credited vehicles. *Leaning:
yes, allow reopen-before-close; closing (`approved_closed`) is the hard stop.*

### 2.6 Scheduling & calendar (foundation + the part to decide with Ashley)

Scheduling is **not greenfield** — the pieces exist and are partly wired:

- **CNI scheduling fields** already exist: admin proposes `scheduled_start_at` /
  `scheduled_end_at` (migration 113), installer confirms/declines (§2.5 phase 3).
- **A unified calendar view** already exists at `/admin/schedule` — a week/month
  grid that renders **CNI as a first-class event type** alongside graphics,
  upfit, reminders (`schedule/page.tsx` TYPE_COLORS/TYPE_LABELS include `cni`).
- **A proven Google Calendar sync pattern** exists: `/api/calendar/sync-upfit`
  pushes a job's scheduled date → a GCal event and stores `calendar_event_id`
  back on the row; `sync-graphics` does the same for graphics jobs. The
  Google_Calendar integration is connected.

**The clear, low-risk extension (recommended default):**
- Add **`/api/calendar/sync-cni`** mirroring `sync-upfit`: when a CNI job's
  schedule is confirmed, create/update a GCal event and store
  `cni_jobs.calendar_event_id`; clear it if unscheduled. (One new endpoint +
  one column, following an existing template.)
- Give the **installer/company an agenda view** of their upcoming confirmed jobs
  (date, address, target qty, part) — the schedule they actually work from.
- Keep `/admin/schedule` as the single cross-type calendar (CNI events already
  render there once they carry a confirmed datetime).

**The part to decide with Ashley (preferences, not architecture).** These are
workflow/policy choices the system should *support* but shouldn't hardcode
blindly — flagged for Ashley's experience (§6 Q11):
- **Whose calendar?** One shared BMG "CNI installs" Google Calendar, per-coordinator
  calendars, and/or do installers get calendar invites to their own email?
- **Multi-day / windows.** Many CNI visits span days or are a date *range*, not a
  single slot — does scheduling need start+end windows, all-day events, recurring?
- **Reminders & lead time.** Auto-reminder cadence (e.g. 48h/24h before) and to
  whom (installer, coordinator, site contact)?
- **Capacity / conflicts.** Should the calendar warn when a company is double-booked
  across jobs, or is that overkill?
- **Site contact coordination.** Does the site contact (the customer's location
  POC on the job) get an invite / confirmation email?
- **Holds vs confirmed.** Proposed-but-unconfirmed schedules shown as tentative
  holds on the calendar, or only confirmed ones?

Recommendation: build the §2.5 confirm/decline flow + `sync-cni` + installer
agenda as the **foundation now** (it's the obvious, reversible part), and lock
the preference list above with Ashley before adding reminders / multi-day /
capacity logic — so we don't bake in guesses about how the scheduling actually
runs day to day.

---

## 3. Billing: CNI rides the field path, and the PO is consumed at invoice

Governing principle (§1.2): **CNI billing is not special.** A CNI installer who
scans a vehicle produces the exact same `scan_logs` row a field tech produces;
from there, there is **one** billing path for everyone. So §3 is no longer a
"CNI bridge" — it's (a) making CNI scans flow down the field path cleanly, and
(b) fixing the field path's PO accounting, which today is broken for everyone.

### 3.1 How a CNI scan reaches billing (same as field)

The installer picks a part (persistent shift, §1.2) and scans VINs. Each scan
calls the shared `logScan()` → writes `scan_logs` with the shift's part +
location and the part's `billable_customer` → `matchScansToOpenPos()` attaches an
open PO with that part. Admin invoices from the Scan Log. **Identical to field.**

What changes vs. today is only what's needed to make CNI scans behave like field
scans:

- Completion logs to `scan_logs` using the **shift's** part (not a job-gated
  part), so the `if (job.part_number)` gate disappears (§1.3) and CNI scans stop
  vanishing.
- `cni_job_vins` rows are created from scanning (VINs discovered, §1.2), each
  linked to its `scan_log_id` (the link already exists).
- Everything else — customer, PO, location, pricing — is resolved in the Scan
  Log by the same machinery field already uses. No customer/PO on the job.

### 3.2 The PO is consumed at **scan** time — and that's correct

Resolved (2026-06-29): **a scanned ("completed") vehicle decrements the PO**, with
the understanding that those vehicles are invoiced later. So the current behavior
is the intended semantics, not a bug:

- `po_line_items.installed` is incremented at **match time**
  (`src/lib/scan-match.ts:104`) — i.e. when the vehicle is scanned and attaches
  to its open PO line. "Remaining" = not-yet-scanned/installed. ✓ keep.
- Invoicing happens later from the Scan Log; the invoice does **not** need to
  move the PO again.

**Why this doesn't double-bill:** the system blocks duplicate scans. `logScan`
rejects a second scan of the same **VIN + part_number** (and the same **IMEI**)
with a 409 (`src/lib/scan-log.ts:96-114`). One vehicle+part ⇒ one `scan_logs`
row ⇒ one decrement ⇒ one invoice line. The no-duplicate-scan rule is what makes
"no duplicate invoices" fall out for free — exactly as expected.

**Dedup on the last-8 of the VIN, as a soft flag with admin override
(resolved 2026-06-29).** Today's check is exact `vin + part_number`, so the same
vehicle entered once as a full 17-char VIN and once as the last-8 slips through
as two rows (the §1.6 caveat). Fix it by comparing the **last 8 characters**:

- Add a generated, indexed column:
  `vin_last8 TEXT GENERATED ALWAYS AS (upper(right(vin, 8))) STORED`, with
  `INDEX (vin_last8, part_number)`.
- `logScan` checks for an existing row with the same `vin_last8 + part_number`
  and returns a structured **`duplicate` outcome** (the matching scan's id, VIN,
  date) — catching full↔full, full↔last-8, and last-8↔last-8.
- **Soft, not hard.** Installer/field scan paths surface it as a blocking warning
  (don't silently create a dup). **Admin paths** (the §1.6 bulk tool,
  `add-completed-vin`, the admin scan view) get an **"override / log anyway"** —
  for the rare legitimate case (two real VINs sharing a last-8, or a deliberate
  re-log). Override is admin-gated and recorded (who/why).
- In the §1.6 staging grid, flagged rows show the dup + the existing match, with
  a per-row override checkbox so an admin clears them in bulk.

**Plus a hard guard for *exact* dups.** Keep a **DB unique index** on the exact
key — `CREATE UNIQUE INDEX ON scan_logs (vin, part_number) WHERE part_number IS
NOT NULL;` (and the existing IMEI uniqueness). Identical re-inserts are always
wrong, so that one is not overridable; it also closes the race window the
app-level check has. The last-8 check stays *soft/overridable* (it can't be a
unique constraint precisely because override must be possible). Net: exact dups
are impossible by construction; near-dups (mixed VIN format) are flagged and an
admin decides.

**Keep the reversal path.** If a scan is un-matched, archived, or deleted, the PO
must re-increment — the `increment/decrement_po_installed` RPCs (migration 004)
already do this and are used in `src/app/api/vehicles/update-match/route.ts`.
Reopening/voiding a completed CNI VIN should run the same reversal.

**The actual CNI defect** was never the decrement timing — it was that CNI scans
**never matched a PO at all** (no part on many jobs, separate flow), so the PO
never moved. That's fixed by §1.2/§1.3: CNI scans now run the field path and
match + decrement just like field scans. No PO-engine change needed.

**Auto-close (nice-to-have).** When every line on a PO reaches `installed =
quantity`, flip `purchase_orders.status` to `complete`/`closed` (today manual;
status defined in migration 071) so fully-installed POs drop out of the open set.

### 3.3 Consolidate the post-invoice bookkeeping into the endpoint

Today the invoice **number/date/archive** stamping lives in the Scan Log *page*
(`src/app/(main)/admin/scans/page.tsx` `createInvoice`), while the endpoint only
sets `exported_at`. Fold `invoice_number` / `date_invoiced` / `archived_at` **into
`invoice-vehicles`** so every caller gets identical accounting with no client-side
duplication. (PO consumption already happened at scan time per §3.2, so it's not
part of this — this is purely about not splitting the invoice-stamp logic between
the page and the endpoint.)

### 3.4 Scan Log: make CNI scans findable (small adds)

The Scan Log stays the one billing surface. Two conveniences so CNI work is easy
to find and finish there:

- **Source column + filter** — derive "CNI job CNI-…-001" vs "field" from
  `cni_job_vins.scan_log_id`, so you can filter to a job's VINs and bill them.
- **Attach-PO inline** for a "Waiting for PO" row (today only fixable via DB).
  Reuses `matchScansToOpenPos` against a chosen PO.

A per-job "Billing" mini-view on the CNI job page is **optional** — it's just a
pre-filtered Scan Log scoped to that job (handy for the coordinator), not a
separate invoice path. Build it only if the unified Scan Log filter isn't enough.

### 3.5 The PO supply gap (still applies)

POs are **import-only** today — Gmail auto-import + AI extraction, or admin PDF
upload (`src/app/api/gmail/import-po`); **no manual "create PO" UI.** So billing
any scan (CNI or field) off a PO presumes that PO was imported. Same options as
before (§6 Q5): rely on import, or add a lightweight manual create
(`purchase_orders` + `po_line_items` insert) for customers who don't email POs.

### 3.6 Failure modes, made visible (not 500s)

Each precondition that silently fails today becomes a visible Scan-Log state,
checked before the invoice call:

| precondition | today | target |
|---|---|---|
| part picked has no `netsuite_parts` price | bills at $0 silently | flagged "needs price" before sending |
| `billable_customer` unset / unmatched | NS "Customer not found" at invoice | shown unresolved in the Scan Log row, fix inline |
| part not in `netsuite_parts` | "No parts matched in NetSuite" | flagged before sending |
| no PO / wrong PO | stuck in "Waiting for PO" | PO editable inline; never silently stuck |
| duplicate vehicle | exact `vin+part` only (misses full-vs-last-8), race-prone | **last-8 soft flag + admin override**, plus a hard unique index on exact `(vin, part_number)` (§3.2) |
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
- **Phase 1 — Identity consolidation (§1.5).** Migration: find-or-create
  `companies` from `company_name` + set `company_id`; drop `company_name` + dead
  fields. Refactor: installer-page company **picker** (sets `company_id`, kills
  the trap); installers list reads `companies.name`; **one** vendor-id editor
  (companies rows read-only → link); vendor id shown by payout mode; collapse the
  3 nav entries to 1. Every installer ends up in a company (one-person companies
  auto-created). *No new billing — pure de-duplication.*
- **Phase 2 — CNI scans = field scans + lifecycle fix (§1.2/§1.3/§2.5).** Give
  CNI the field shift model: pick a part before scanning, held persistent until
  switched; log every scan via the shift's part (remove the `if (job.part_number)`
  gate); create `cni_job_vins` from scanning; no PO/customer/VIN on the job. **Fix
  premature auto-completion** — make completion an explicit installer "End Shift /
  Mark Job Complete" instead of auto-on-empty; part at creation becomes an
  optional default; drop `vin_count`/`is_multi_unit` as gates; per-job configurable
  photo set; finish moving status-history/RLS off `assigned_installer_id`.
- **Phase 3a — "Scan for an installer" tool (§1.6).** Unify import-installs +
  scan-worksheet + add-completed-vin into one admin bulk-entry tool: company +
  crew + part + location, then VINs via paste / spreadsheet / photo-PDF, each →
  `logScan()` + pay credits. Fix import-installs to credit a real company + write
  credits; delete the dead root `bulk-vin-upload-code.tsx`. Last-8 or full VIN
  both accepted as-is (no reconciliation).
- **Phase 3 — Unify billing + harden PO accounting (§3).** Keep the scan-time PO
  decrement (it's correct); **dedup**: `vin_last8` generated column + last-8 soft
  flag with admin override, plus a hard unique index on exact `(vin, part_number)`
  (§3.2); ensure reopen/void/archive reverses the decrement; fold invoice
  bookkeeping (`invoice_number`/`date_invoiced`/`archived_at`) into
  `invoice-vehicles`; Scan Log source filter + attach-PO-inline; visible
  precondition states; optional PO auto-close. Optional sub-PR: manual
  "create PO" path (§3.5, §6 Q5).
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
10. **Reopen for stragglers (§2.5)** — allow reopening a
    `completed_pending_review` job to `in_progress` to add late vehicles before
    closing (without disturbing already-credited VINs)? *Leaning: yes; closing is
    the hard stop.*
11. **Scheduling/calendar preferences (§2.6) — for Ashley.** Whose calendar
    (shared vs per-coordinator vs installer invites); multi-day/windows;
    reminder cadence + recipients; double-book warnings; site-contact invites;
    tentative holds vs confirmed-only. *Build the foundation (confirm/decline +
    `sync-cni` + installer agenda) now; lock these with Ashley before reminders /
    multi-day / capacity logic.*

### Resolved (2026-06-29) — job lifecycle completion (§2.5)
- **Completion is a CNI-facing progress nicety, not a system gate.** Billing/pay
  flow from scans regardless. Admin optionally sets a **`target_quantity`** at
  assignment (or leaves it open-ended) that counts down as vehicles are scanned;
  completion is the explicit installer "Mark Job Complete" (premature
  auto-completion removed). 

### Resolved (2026-06-29) — bulk ingestion (§1.6) + dedup (§3.2)
- **Last-8 or full VIN both work; no reconciliation.** Billing/pay key off
  part + PO + customer + vehicle count, not the VIN string, so an 8-char VIN
  flows through `logScan` unchanged. (Full VIN still needed to auto-decode
  year/make/model.)
- **Dedup compares the VIN last-8** as a **soft flag with admin override** —
  catches full-vs-last-8 of the same vehicle; admins can override the rare
  legitimate collision. A hard unique index on exact `(vin, part_number)` still
  blocks identical re-inserts race-free.

### Resolved (2026-06-29) — identity consolidation (§1.5)
- **Every installer belongs to a company.** Solo = a one-person company,
  auto-created at invite; no "Independent" path. Migration auto-creates one-person
  companies for company-less installers; `profiles.company_id → companies` is the
  single membership source of truth; `cni_profiles.company_name` + dead fields
  dropped; one vendor-id editor; installer-page company picker sets `company_id`.

### Resolved (2026-06-29) — CNI billing = field flow (§1.2, §3)
- **CNI scanning IS field scanning.** Installer picks a part before scanning,
  held persistent until they switch it (field shift model). No PO/customer/VIN
  pre-loaded on the job; VINs discovered by scanning; PO/customer resolved in the
  Scan Log like field. Dropped: `cni_jobs.po_id` / `netsuite_customer_id` and the
  customer-picker-at-creation idea (old Q6).
- **PO is consumed at scan time** (a scanned/"completed" vehicle decrements the
  PO; invoiced later). Kept as-is — *not* moved to invoice time. Duplicate scans
  are blocked (VIN+part / IMEI), so duplicate invoices can't arise; harden that
  with a DB unique index. The CNI gap was that CNI scans never matched a PO —
  fixed by routing CNI down the field path (resolves old Q7).

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
