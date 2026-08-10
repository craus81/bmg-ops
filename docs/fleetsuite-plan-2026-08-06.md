# FleetSuite plan — Aug 6, 2026 session (Craig + Ashley)

Built from the two meeting-notes emails for the Aug 6 "FleetSuite" call
(Gemini notes + the Read.ai report), traced against the codebase and
reconciled with the three plans already on file:

- `docs/fleetsuite-roadmap.md` — the 23-note punch list (Chris + Valarie),
  bugs B1–B15, items W/E/N/G/V/A/S/C.
- `docs/ceo-dashboard-plan.md` — Zach's metric list, RESTlet/P&L, Paychex,
  bank feed.
- `docs/cni-redesign.md` — the CNI/installer-portal target architecture.

This doc does **not** re-plan anything those cover. It records (1) what the
meeting *decided or answered* in the existing plans, (2) meeting asks that
**already exist in code** and need surfacing or verification, not building,
and (3) genuinely **new workstreams**, each traced to current code. Ops
tasks that involve no engineering are tracked in a short list at the bottom
so nothing from the notes is dropped.

Sizes: XS (<1h), S (half day), M (1–2 days), L (3–5 days), XL (>1 week).

---

## 1. What the meeting resolved in the existing plans

**Roadmap Q4 — SO gate: ANSWERED.** Both notes are explicit: block
sales-order conversion until explicit customer approval **and** add an
internal approval override for phone/PO approvals ("fix the sales-order
conversion workflow so conversion is only available after explicit customer
approval and add an internal approval override note"). That is roadmap
option (b). **N1 is unblocked** — build the `customer_approved` gate with
an admin override that records who overrode and why (a note/audit row, per
the "override note" wording). B4 still lands first.

**Roadmap Q6 / V1 — the VIN blocker: RESOLVED, differently than assumed.**
The roadmap treated "does sales fill the SO VIN field?" as the open
question. The meeting instead decided **VINs go on the estimate** ("Is
there a VIN number field on FleetSuite estimates so it appears on the
PDF?" / "standardizing job-naming conventions including VINs"). So: add a
VIN field to estimates (folds into E1's header-fields migration), print it
on the estimate document, pass it to `custbody_vin_number_` on push and on
convert-to-SO — and V1's "arriving" row gets its VIN from the estimate
chain instead of hoping NetSuite sales reps typed one. See item K5.

**Roadmap N4 — configurator: appetite confirmed, data plan named.** The
meeting described exactly the phase-A browser ("filter by category, vendor,
vehicle fit, and sort by price") and assigned the missing data: **Ashley
compiles the product-category list.** N4-A should build against that list;
see K11 for the catalog-side prerequisites (categories, prefixes, sync).

**Roadmap C1 — mentioned again, still unanswered.** "Combining estimates
with wrap quotes" came up in the account-model chapter with no (a)–(d)
choice. Strategy C (one customer document + one list) remains the default.
Question 1 of the roadmap stays open.

**Roadmap S1 — the classification data gets a source.** Ashley's product
categories + industry tags (K2) are the same data the upsell detector was
blocked on. Phase 0 (dumb weekly nudge) remains available any time.

**CEO dashboard — reviewed and well received.** Specific follow-ups:

- **Revenue per employee**: already Phase 2 item 8 / Phase 4 item 13. Note
  the *headcount* half is NOT blocked — the verified Paychex "Company and
  worker APIs" scope already returns workers; only Total Payroll / Labor %
  wait on the payroll-scope enablement. Rev-per-employee can ship now.
- **Primary contact field on customers** — see K2.
- **"Needs attention" assignment appears broken** — see K15 (investigate;
  the code shows no assignment concept on those queues at all).
- **Access tightening** ("a NetSuite report revealing bank-balance-like
  figures… access should be tightened") — see K6. This is real and should
  ship first.
- "Three data feeds had completed" = cash / A-R / A-P are live on the
  Financials tab, matching the plan's "where we stand."

**Installer portal — decision made: rebuild.** "Rebuild the
installer/installer-portal workflow from the ground up with a planned
design for job linking and bidding." That planned design **already exists
and matches the ask**: `docs/cni-redesign.md` (bidding/distribution §2.5,
job linking to billing §3, phased build §5, most open questions resolved
2026-06-29). The decision to make is **phase order** (§6 Q3): pain-first
(Phase 2 → 3, then 0 → 1 → 4) vs cleanup-first (numeric). Given the meeting
framed it as workflow pain, recommend **pain-first**. The remaining §6
scheduling questions (Q11) are explicitly flagged for Ashley — fold them
into the training-resource conversation she owns. No new plan needed here;
execute that doc.

---

## 2. Meeting asks that already exist — verify/surface, don't build

The session assumed several gaps that the code says are already closed.
Each needs a demo or a small surfacing change, not a project:

| Meeting ask | What actually exists | Remaining gap |
|---|---|---|
| "Enable the scanning system to allow installers to add multiple part numbers per scan" | Interactive scanner is already multi-select — `scan/page.tsx:58` holds `selectedParts[]`, `logVehicle()` loops one `scan_logs` row per part (`:539-555`). Bulk VIN paste crosses VINs × parts (`admin/scans/page.tsx:912-925`); worksheet OCR splits `06N5TR/06N179` into rows | Spreadsheet **import-installs** takes a single `partNumber` per run (`api/admin/import-installs/route.ts:33-38`) — extend to multi (S). Verizon RFID capture only engages with exactly one part selected (`scan/page.tsx:650-651`) — confirm that's intended |
| "Establish an internal process for scanning and invoicing vehicles without purchase orders" | The no-PO path exists end-to-end: `invoice-vehicles` groups PO-less scans under `NO_PO` and skips the over-bill gate (`route.ts:61-68,106`); Scan Log's Waiting-for-PO tab has a Create Invoice button ("no PO/SO needed", `admin/scans/page.tsx:650-678,1244-1252`) | This is a **process/training** item (who may use it, when), plus one UI seam: `/invoices` hides PO-less scans unless the part has `requires_po_match=false` (`invoices/page.tsx:326-331`) — decide whether that page should offer the same path (XS–S). Feeds Ashley's training resource |
| "The parts catalog should allow creating a new part that syncs to NetSuite" | Exists: `CreateNetsuiteItemModal` from the Parts page and inline from Scan Log bulk search; `api/netsuite/create-item` creates the NS item, pushes price, mirrors into `netsuite_parts` (`route.ts:94-241`) | Discoverability + the two specific parts the meeting wants created (internal repairs, install-GPS labor) are data entry, not code. Real gap: **no scheduled item sync** — see K11 |
| "Configure the AI tool to provide sum totals by customer and time frame plus CSV exports" | Both exist: the agent runs arbitrary SuiteQL/SQL with canned aggregate patterns (AR by customer, revenue by month — `ai-agent/chat/route.ts:448-452`), and every table renders with a Download CSV button (`AiChat.tsx:90-109`) | Verify against the exact questions asked in the meeting; tune `ai_instructions` if a pattern is missing (XS). **But see K6 first** — the same executor is the access leak |
| "Proofs… stored and searchable by part number" | `part_files` FKs files to `netsuite_parts` (migrations/057), three attach paths (manual, Gmail `attach-proof`, Dropbox), scanner shows the proof to installers (`scan/page.tsx:380-390,946-968`), and `/admin/proof-search` searches Dropbox+Gmail by customer/part | What's missing is **bulk/auto** attachment — Craig's email-search script. See K12 |
| "The tagging/role issue was fixed and should be verified" | Shipped as PRs #455/#461 | Verify by tagging once in prod; close |
| "Are we at risk of running out of data storage for proofs and photos?" | Storage is Cloudflare R2 (`src/lib/r2.ts`) — object storage, no practical ceiling; cost scales linearly and R2 has zero egress fees | No action. Answer: no |

**And one belief to correct before anyone "fixes" it:** the meeting
concluded the **"exported" invoice status "likely has no system meaning."
It has real meaning.** `scan_logs.exported_at` removes a scan from the
invoicing queue (`invoices/page.tsx:329-331`), removes it from the
Ready/Waiting ops counts (`OpsDashboard.tsx:249,354`), and de-prioritizes
it in PO auto-matching (`scan-match.ts:94-104`). It is set by CSV export
(`admin/scans/page.tsx:618-626`) and back-stamped by invoicing
(`invoice-vehicles/route.ts:284-289`). Clearing it casually would flood the
invoice queue with historical scans. The actual ask — "move exported items
back to a PO / invoice them" — already half-exists (the Exported tab has
its own Create Invoice button, `admin/scans/page.tsx:1254-1257`). See K9
for the small remaining piece.

---

## 3. New workstreams

### K6 — Close the financials bypass in the AI agent  **[do this first]**

> "a participant found a NetSuite report revealing bank-balance-like
> figures and raised concerns about access scope for admins… access should
> be tightened"

**Today.** The Financials tab itself is gated correctly — `requireFinancials`
(`src/lib/api-auth.ts:171-181`) admits only `super_admin`/`executive`, and
all five `/api/reports/financials*` routes enforce it. **The bypass is the
AI agent**: `api/ai-agent/chat/route.ts` is `requireAuth` only (`:1053`),
runs raw SuiteQL and (service-role) SQL for any approved user, and its own
system prompt documents `account.balance` (`:434-435`), GL detail
(`:413-414`), and canned AR/revenue rollups (`:448-452`) — with a Download
CSV button on every result. The only role check (installer NetSuite block,
`:1174-1179`) keys off a **client-supplied** `userRole` from the request
body. This is almost certainly the exact leak the meeting saw.

**Change.**
1. Resolve the role **server-side** from `profiles` (drop the body field).
2. Gate query classes by role: `netsuite`/`supabase` sources restricted to
   staff; GL-balance/accounting tables (`account`,
   `transactionaccountingline`, payment tables) restricted to
   financials-eligible roles — enforce with a table/keyword allowlist in
   the executor path, not prompt text, and strip the balance-query patterns
   from the prompt for non-financials roles.
3. While in there: decide whether the write **actions** (`create_estimate`,
   `send_message`, …) should really be reachable by every role `requireAuth`
   admits, and log agent queries (who/what/when) so the next audit is
   readable.

**Size.** S–M. Security fix — schedule ahead of everything else in this doc.

### K1 — Customer hierarchy: parent/child + leasing-company assignment

> "Link sub-customers to their parent enterprise accounts" · "records like
> Jerry Kelly show activity across related corporate accounts" (Glesby
> Marks, Holman) · "linking may require manual assignment… add an 'assign
> to leasing company' control"

**Today.** Nothing — no parent/leasing/hierarchy column exists on
`customers` or `prospects` anywhere in 182 migrations, and the NetSuite
customer sync never selects the customer `parent` field
(`cron/netsuite-sync/route.ts:58-70` pulls id/companyname/entityid/email/
phone/lastmodified only). `customers` has no CREATE TABLE migration; its
FleetSuite-owned columns follow the migration-080 pattern (kept out of the
sync's SET list).

**Change.**
1. **Migration 191**: `customers.netsuite_parent_id` (synced) +
   `customers.parent_customer_id` / `parent_source ('netsuite'|'manual')`
   (FleetSuite-owned, migration-080 pattern) — NetSuite's own hierarchy
   where it exists, manual assignment where it doesn't, and the manual link
   must survive resync.
2. Add `c.parent` to the sync SELECT + upsert.
3. **"Assign to leasing company" control** on the customer/prospect detail
   page — a parent picker writing the manual link. Mirror on `prospects`
   via the `netsuite_id` join (the customers↔prospects split is the known
   trap here — roadmap E5 hit the same one).
4. **Rollup views**: parent record shows children + consolidated activity/
   spend (children's `ytd_spend` etc. are already synced per-child; sum
   client-side or in the query — paginate per CLAUDE.md if unbounded).
   Contact-level visibility ("Jerry Kelly under all relevant parents") =
   listing child accounts' contacts on the parent page — read-only join,
   not a data-model change.
5. When an account is re-parented, write a note/activity row explaining the
   change (the meeting: "notes should be used to explain account status
   changes when customers move between parent and sub-accounts") — today
   customer notes are a single `internal_notes` TEXT column, so log to
   `prospect_activities` via the join, or simply require a note in the
   assign dialog and append it.

**Size.** M–L (sync + migration S; UI + rollups M). Independent of
everything else; high meeting priority (first action item).

### K2 — Customer profile completeness: primary contact, sales rep, industry tags

> "requested a primary contact field on customer records" · "assigning a
> primary sales rep, tagging industry/partner types for segmentation" ·
> "[Ashley] Audit Customer Profiles… apply relevant industry tags"

**Today.**
- **Primary contact exists but is invisible**: `external_contacts` has
  `is_primary` with single-primary enforcement
  (`api/external-contacts/[id]/route.ts:40-45`) and it already drives
  estimate approval sends, pickup notifications, and SMS matching. The CRM
  side (`prospect_contacts`) has **no** `is_primary` (only
  `is_decision_maker`), and the prospect detail page is where staff
  actually look at contacts.
- **Sales rep**: `customers.account_owner_id` (migrations/080) exists but
  is settable **only** inside the at-risk report
  (`admin/reports/at-risk/page.tsx:111-119`) and is used only for at-risk +
  approval notifications — exactly what `docs/ceo-dashboard-plan.md` says
  blocks per-rep revenue attribution.
- **Industry tags**: `prospect_tags` is free-text chips; `customers` has
  nothing; no controlled vocabulary anywhere.

**Change.**
1. Surface primary contact on the customer/prospect detail header (read it
   from `external_contacts`; add `is_primary` to `prospect_contacts` or —
   better — render the `external_contacts` primary on the prospect page via
   the netsuite_id join, so there is ONE primary, not two).
2. Promote `account_owner_id` to a first-class "Sales rep" field on the
   customer/prospect page (same picker the at-risk report uses). This is
   also the prerequisite for CEO-dashboard per-rep revenue rollups.
3. **Migration 192**: `customer_tags` (or extend `prospect_tags` usage) +
   a small controlled vocabulary table for industry/partner types so
   Ashley's audit produces consistent values (free-text chips defeat
   segmentation). Filterable on the customers list.

**Size.** M total (1: S, 2: S, 3: S–M). Ashley's profile audit is the data
half and can start as soon as the fields exist.

### K3 — Billing workflows on the customer profile

> "Customer profiles must include selectable billing workflows to route
> invoices to the correct portal (e.g., Master Act PO, Bogle portal)" ·
> "[The group] Update customer profiles: integrate billing workflow
> selection into the customer profile setup"

**Today.** No per-customer routing field of any kind. The only delivery
data is `prospects.billing_emails TEXT[]` (prefilled into
`EmailInvoicesModal`, which is the single send surface mounted from 5
screens); `customers.ap_email`/`billing_contact_email` exist (migration
080) but are **never read by the invoice email path**. Customer-specific
behavior is hardcoded: `src/lib/invoice-location.ts` maps Masterack/Designs
That Stick to NetSuite locations in code ("the rules live here"), and
Masterack PO parsing/senders are special-cased in four more places. "Bogle"
appears nowhere in the repo — that workflow lives entirely in someone's
head today.

**Change.** Ashley defines the workflow taxonomy first (her action item —
e.g. `po_portal` / `email_ap` / `no_po_direct`, portal name, required
fields), then:
1. **Migration 192** (shared with K2): `customers.billing_workflow`,
   `customers.billing_portal` (+ notes), FleetSuite-owned.
2. `EmailInvoicesModal` + the invoice-creation surfaces read it: prefill
   recipients from the workflow (and finally read `ap_email`), show a
   "this customer bills via the Masterack portal — don't email" banner for
   portal-type customers, and default the Scan Log grouping accordingly.
3. Fold the `invoice-location.ts` hardcodes into per-customer config so the
   next Masterack doesn't require a deploy (S, optional but this is the
   moment).
4. The **VIN-scanning/invoicing process** half of Ashley's action item is
   K10/K8 + the training doc, not new schema.

**Size.** M once the taxonomy lands. Blocked on Ashley's workflow list.

### K4 — Human job numbers that carry through the chain

> "Job numbers generated by the system are currently cryptic and need a
> shorter, meaningful format that carries through estimates, sales orders,
> and invoices"

**Today.** Six independent generators, five of them
`base36(Date.now())`-style: graphics jobs get `GFX-MSG7L76U` from four
different call sites (from-wrap-quote/from-estimate/schedule/graphics page,
plus Gmail-import and AI-agent variants with random suffixes), estimates
get `EST-YYMM-XXXX` from **two duplicated generators**
(`api/estimates/route.ts:51-57` and `api/graphics/create-estimate/route.ts:20-26`),
wrap quotes get `WQ-MMDDYY-N` client-side. The only sequential, DB-side
generator in the app is CNI's `generate_cni_job_number()`
(`migrations/033`, `CNI-YYYYMMDD-NNN`). Carry-through exists only via
NetSuite's Reference-No field: convert-to-so writes the estimate number
into `poNumber` (`convert-to-so/route.ts:180`) and invoicing writes the
customer PO into `otherrefnum` — nothing FleetSuite-native survives
estimate → SO → invoice.

**Change.**
1. **Migration 193**: per-prefix DB sequence function modeled on CNI's
   (`EST-2608-041`, `GFX-2608-017` — short, dated, sequential), replacing
   the six generators; keep old numbers as-is. This also retires B14
   (collision retry) properly.
2. Thread one number through the chain: the estimate number already lands
   on the SO's Reference No; make invoicing-from-SO carry it to the
   invoice, and stamp it on the graphics job when spawned from an
   estimate/quote (columns exist: `estimate_id`/`wrap_quote_id`) so every
   record shows the same human number. Where a customer PO must own
   `otherrefnum` (PO-billed work), put the FleetSuite number in the memo —
   don't fight the customer's PO for the field.
3. Meeting also wants VINs in job naming — with K5, include the VIN last-6
   in the graphics-job title convention (naming, not schema).

**Size.** M. Touches every creation path once; coordinate with the roadmap's
estimates-page bottleneck (land after B4/E3).

### K5 — VIN on estimates

> "Is there a VIN number field on FleetSuite estimates so it appears on the
> PDF?" (No.) · VINs persist "through documentation"

**Today.** Estimates have no vehicle/VIN field at all — the roadmap called
this the hard blocker for V1. The NetSuite SO's `custbody_vin_number_` is
already selected by the SuiteQL reads (`netsuite.ts:215`) and read nowhere.

**Change.** Fold into E1's header-fields work (**migration 186**, the
renumbered E1 slot): `estimates.vin` (+ optional unit#), shown in the
builder, printed by the shared `estimate-document.ts` renderer (E2 —
sequence this after it exists), passed on push and on convert-to-SO into
`custbody_vin_number_`. Then V1 Option A stops depending on NetSuite
data hygiene: the `shop_inbound` "expected" row gets its VIN from the
estimate chain. Multi-vehicle estimates: keep it simple — one VIN header
field now, per-line VINs only if asked.

**Size.** S once E2's renderer exists (M if it must carry per-line VINs).

### K8 — Completion photos + import-installs multi-part

> "verify and, if needed, enable the scan interface to allow bulk-uploaded
> scans to be associated with multiple part numbers and to support optional
> completion photos"

**Today.** Multi-part: see §2 — done except import-installs. Photos: the
scan flow has **none** — no capture, no table, no FK
(`scan/page.tsx`, `api/scans/log`, `scan-log.ts` are photo-free). Photo
machinery exists in two *other* flows: `vehicle_photos` →
`fleet_checkins` via `CompletionModal.tsx`, and `cni_job_photos`.

**Change.**
1. Extend import-installs to per-row or multi part numbers (S).
2. **Migration 194**: `scan_photos(scan_log_id, storage_path, …)` on R2 +
   an optional camera step in the field scanner after a successful scan —
   explicitly optional, zero extra taps when skipped (the meeting stressed
   optional). CNI's per-VIN photo review stays its own flow
   (`cni-redesign.md` §2.5 keeps it and makes the required set per-job).
3. Surface scan photos wherever the scan renders (Scan Log expand, vehicle
   page) — with K12's part-file link this completes "what was quoted vs
   what was actually installed."

**Size.** M.

### K9 — "Exported" semantics: make it visible, make it reversible

> "How do we move invoices that are marked exported back to a purchase
> order?"

**Today.** See §2 — `exported_at` is real and load-bearing but invisible:
nothing in the UI says *why* a scan is in the Exported tab or what that
implies, which is how the meeting concluded it was meaningless. Un-export
is technically reachable (`api/scans/bulk-update` allowlists the fields)
but has no button; attach-to-PO-inline exists in the redesign plan
(`cni-redesign.md` §3.4).

**Change.** (1) A one-line explainer on the Exported tab + an "exported by
X on date (CSV export / invoiced)" chip per row. (2) An explicit
**Un-export** (back to Ready/Waiting) bulk action with a confirm that
states the queue consequences. (3) Keep using the existing Exported-tab
Create Invoice for "invoice them anyway." Coordinate with
`cni-redesign.md` Phase 3 (Scan Log source filter + attach-PO-inline) so
this ships as one Scan Log pass, not two.

**Size.** S.

### K10 — Invoice reconciliation assist (NetSuite vs FleetSuite)

> "[Ashley] Audit invoicing: compare NetSuite and FleetSuite invoicing to
> identify and resolve discrepancies" · "inconsistencies between financial
> systems regarding August invoicing"

**Today.** The audit is Ashley's ops task, but doing it by hand means
eyeballing two lists. FleetSuite already knows its side
(`scan_logs.invoice_number/date_invoiced/invoiced_amount`, `invoice_emails`,
graphics `netsuite_invoice_number`) and can read the NetSuite side via
SuiteQL invoice queries that already exist for reports.

**Change (optional, cheap).** A one-page admin report: NetSuite invoices
for a period vs FleetSuite records claiming them — flag NetSuite invoices
no FleetSuite record points at, FleetSuite records whose invoice number
doesn't exist in NetSuite, and amount mismatches. CSV export. This turns
the August audit into an hour and stays useful monthly. Paginate both
sides (`fetchAllRows`).

**Size.** S–M. Do it before the audit if timing allows; the $21 journal
entry stays with the accountant.

### K11 — Parts catalog: scheduled sync, categories, prefixes

> "[The group] Rebuild parts sync: rebuild the parts catalog sync
> functionality with NetSuite" · "parts catalog requires cleanup and
> standardized part-number prefixes (BMG-…)" · "[Ashley] Categorize
> Products… product analytics and department-level P&L"

**Today.** The parts *pull* (`api/parts/sync`) is manual-only —
`create-item/route.ts:89-90` says it outright: "there is no scheduled item
sync." So the catalog is stale except where FleetSuite itself created the
item. `ns_category` is hardcoded `null` in the sync; catalog assignment is
a two-line prefix heuristic that mis-files the Verizon RFID part under
graphics (roadmap S1's evidence). Kit/Assembly items import flat.

**Change.**
1. **Cron the sync** (same pattern as `netsuite-sync`), incremental on
   `lastmodifieddate`, paginated. This is the "rebuild" that matters.
2. Stop discarding classification: select NetSuite class/department/
   category into real columns; **migration 190** (renumbered S1 slot) adds
   `product_line` + override per the roadmap design — Ashley's category
   list becomes the mapping table, closing the loop to department-level
   P&L (K17) and the N4-A facets.
3. BMG- prefix standard for internal items (repairs, install-GPS labor) is
   convention + the existing create-item modal; document it in the help
   docs. The two specific parts the meeting named are data entry once this
   lands.

**Size.** M (cron S; classification M with Ashley's list).

### K12 — Auto-attach proofs from email to part records

> "[Craig] create and run a script to search email for proofs and part
> numbers and attempt to attach found proofs to part-number records" ·
> Ashley seeds part numbers active on POs first

**Today.** Single-part attach-from-Gmail already exists
(`api/parts/[id]/attach-proof`), as does the Gmail/Dropbox proof search UI.
What's missing is the bulk sweep. The Gmail cron infrastructure
(auto-import, parts-email-scan) is the established pattern.

**Change.** A batch job (admin-triggered first, cron later): for each part
in scope (Ashley's active-PO seed list), run the existing email search,
auto-attach high-confidence hits (filename/subject contains the part
number) as `part_files`, queue ambiguous ones for review in a small
approve/reject list. Never auto-attach low-confidence matches — wrong
proof on a part record is worse than none, because installers see these in
the scanner.

**Size.** M.

### K13 — Estimate builder: proofs, price overrides, live margin

> "an estimating workflow that allows uploading proofs, manual adjustments
> to box/nesting calculations, and price overrides with live margin
> feedback" · "a pricing tab exists but he has not fully configured pricing
> templates or discounts yet"

**Today.** These capabilities exist on the **wrap-quote** side (nesting
adjustments, margin floor from `quote_settings`, diagram) and not on
estimates (no file upload, no margin display). This is exactly the C1
split: the asks are the wrap builder's strengths requested inside the
estimate flow.

**Change.** Don't build a third thing. Fold into the existing sequence:
per-line price override + a live margin readout in the estimate builder
(cost data exists: `netsuite_parts.purchase_price`, `avg_install_cost`) is
a self-contained S–M and worth doing on its own; proof/file upload on
estimates rides E5's `customer_files`/attachment work; nesting stays
wrap-side pending the C1 answer. Flag the rest to the C1 question rather
than duplicating machinery.

**Size.** S–M for margin/override; rest tracked under C1/E5.

### K15 — "Needs attention" assignment: investigate

> "The 'needs attention' assignment behavior appears broken"

**Today.** The ops-dashboard "Needs attention" block is a computed count
list — **no assignment concept exists on it** (`OpsDashboard.tsx:275-371`).
The only nearby "assignment" is the at-risk report's account-owner picker,
and the only stored "attention" is PO `invoice_check_status='attention'`,
which notifies super-admins only (`po-billing-notify.ts:52-91`). None of
the roadmap's B1–B15 covers this.

**Change.** Get a repro from Craig/Ashley (which screen, which action,
expected vs actual) before building anything — the report may mean "we
expected to assign these and can't," which is a feature request (per-queue
assignee), not a bug. Park until answered — Question 3 below.

**Size.** Unknown (XS investigation).

### K17 — Department-level P&L (extends the CEO-dashboard plan)

> "The team prefers department-level P&L and monthly analysis rather than
> strict per-job, per-employee profitability"

**Today.** The CEO plan's `incomeStatement` RESTlet mode groups by account
*type* only. Department/class dimensions and the product-line rollup don't
exist yet; the classification data is K11's.

**Change.** When building the RESTlet `incomeStatement` mode (CEO plan
Phase 2 item 7), add a `groupBy: class|department` option — NetSuite
already carries the dimension on posting lines if BMG codes them. Pair
with K11's `product_line` for the product-analytics cut Ashley's
categories enable. Confirm with the accountant that departments/classes
are actually populated on transactions; if not, this is a NetSuite
data-entry decision before it's an engineering one.

**Size.** S on top of the already-planned RESTlet work.

---

## 4. Ops actions from the meeting (no engineering — tracked so nothing drops)

| Owner | Action | Engineering touchpoint |
|---|---|---|
| Ashley | Research + document state tax-exemption rules for cross-state shipping | Becomes the rules content for E5 (cert storage) / B12 (flag → NetSuite); the doc itself is the estimator reference |
| Ashley | Product-category list | Input to K11/K17/N4-A |
| Ashley | Customer-profile audit + industry tags | Needs K2 fields first |
| Ashley | Billing-workflow taxonomy | Needs K3; defines the enum |
| Ashley | Training resource for customer/invoicing workflows | Update `docs/help/*` after K3/K10 ship; the help system exists |
| Ashley | Forward home-team repair details → Craig invoices Masterack (~$15k) | None |
| Ashley | Mike Baker email — Northwest/Rollins repricing | None (≈40 open POs, ~$6k loss context) |
| Ashley | Wings of Hope (Heather Patterson), partner-portal login restore | None |
| Craig | Paychex: MO/MS withholding question | Same call should push the "Payroll and check APIs" scope enablement the CEO plan is blocked on |
| Craig | Ask Brian re: Bad Wraps raster templates | If adopted, graphics-side only; Core Vehicle Outlines 25/day limit noted |
| Craig | PO for Northwest removals; $21 journal entry with accountant; Atlanta flights | None |
| — | Veterans discount (5%, ~$260 → ~$4,940) | Decided in-meeting; done |

---

## 5. Sequencing

**Migration numbering (supersedes the roadmap's table — 182 is taken by
`182-fix-exec-readonly-sql.sql`):**

| # | Item | Contents |
|---|---|---|
| 183 | W2 | `wrap_quotes.hide_line_items` — **landed** |
| 184 | E5 | `customers.tax_exempt*`, `customer_files` — **landed** |
| 185 | V1/V2 | `fleet_checkins.arrived_at`, `shop_inbound` SO source — **landed** |
| 186 | K1 | customer parent/leasing linkage — **landed** (K1 built first, so it took the next free number per migrations/README) |
| 187 | K2/K3 | customer tags vocabulary, `billing_workflow` — **landed** |
| 188 | E1 + K5 | estimate header fields **incl. `vin`** |
| 189 | N3 | `netsuite_sales_orders` + lines |
| 190 | A2 ph2 | `updated_by` on six job tables |
| 191 | A2 ph3 | audit diff trigger |
| 192 | S1/K11 | `product_line`, `customer_product_lines`, `upsell_nudges` |
| 193 | K4 | job-number sequences |
| 194 | K8 | `scan_photos` |

**Order of operations, folded into the roadmap's phases:**

1. **Immediately, standalone:** K6 (access bypass — security). Verify-only
   items from §2 (tagging check, AI-tool demo, multi-part demo) cost
   nothing and clear meeting anxiety.
2. **Roadmap Phase 1 (bug/quick-win checklist) proceeds unchanged** — the
   meeting reinforced N1 (now unblocked by the Q4 answer: gate + recorded
   override) and B12/E5 (tax handling).
3. **Roadmap Phase 2 additions:** K5 rides E1/E2 (migration 186); K9 rides
   the Scan Log pass; K13's margin readout is a cheap add to the estimates
   work already scheduled there.
4. **New mid-size track (independent of the estimates-page bottleneck, can
   run in parallel):** K1 → K2 → K3 (customer model; K3 blocked on
   Ashley's taxonomy), K11 (parts sync cron first), K10 before/during
   Ashley's August audit, K12 after Ashley's seed list, K8, K4 (after
   B4/E3 land to avoid the single-file rebase trap).
5. **Big rocks, unchanged order, one at a time:** C1-C → N2 → N3 → A2 → N4-A
   (now with K11's facets) → S1 detector (now with K11/K2's data). The
   **installer-portal rebuild executes `docs/cni-redesign.md`** — recommend
   pain-first order (Phase 2 → 3 → 0 → 1 → 4); it is its own track and
   shouldn't queue behind the estimates work.
6. **CEO dashboard plan proceeds as written**, with three meeting deltas:
   rev-per-employee's headcount half is unblocked now (worker scope works),
   K17's department dimension goes into the RESTlet spec, and K6 closes the
   access finding.

**Dependencies added by this doc:**

| First | Then | Why |
|---|---|---|
| K6 | any AI-tool promotion (§2) | don't advertise the tool while it leaks GL balances |
| E2 (shared renderer) | K5 (VIN on the PDF) | the PDF is the renderer |
| Ashley's taxonomy | K3 schema | don't guess the enum |
| Ashley's category list | K11 classification, K17, N4-A facets | data before facets |
| K11 sync cron | K12 bulk attach | attach against a live catalog, not a stale mirror |
| B4/E3 land | K4 estimates-side numbering | same-file rebase hazard (roadmap "single-file bottleneck") |
| K1 | K2 tag rollups by parent | tags roll up the hierarchy |

---

## 6. Questions for Craig / Ashley

Carried over, still open: roadmap Q1 (combine — which reading?), Q2 ("New
quote"), Q3 (labor × qty pricing fix — **still gating E2**), Q5 (does
FleetSuite write vendor POs?), Q7 (opt-in email), Q8 (upsell smart vs
simple). New from this session:

1. **Leasing-company model (K1):** is a leasing company itself a customer
   record (Glesby Marks has its own NetSuite account?) or a new lookup
   list? Default: it's a customer record and the link is
   customer→customer.
2. **Billing workflows (K3):** Ashley's taxonomy — and is "Bogle portal"
   a customer portal we log into (pure process, FleetSuite just flags it)
   or something FleetSuite should integrate with?
3. **"Needs attention" (K15):** what exactly was being assigned, on which
   screen, and what happened instead? Can't reproduce from code — there is
   no assignment on those queues today.
4. **Job numbers (K4):** confirm format preference (`GFX-2608-017` style
   date+sequence?) and whether existing records keep old numbers
   (recommended: yes).
5. **Scan photos (K8):** required for any part types, or always optional?
   Meeting said optional — confirming before we build a skip-able step.
6. **AI agent scope (K6):** after the gate, which roles should the AI tool
   serve at all, and should its write actions (create estimate/job, send
   message) stay?
7. **Installer portal (cni-redesign §6 Q3):** pain-first build order OK?
   And Q11's scheduling preferences are waiting on Ashley.
8. **Department P&L (K17):** are class/department actually coded on
   NetSuite transactions today? (If not, that's the accountant
   conversation before any RESTlet work.)
