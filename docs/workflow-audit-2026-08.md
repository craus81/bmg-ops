# FleetSuite End-to-End Workflow & Role Audit — August 2026

> A start-to-finish walkthrough of one job (a vehicle that gets **both** an upfit
> package **and** graphics) from the first phone call to the paid invoice —
> examined through the eyes of each role — plus a full audit of what every role
> can see. The goal was to find gaps, question everything, and leave no feature
> unexamined.
>
> Method: sixteen agents each did a deep static read of one slice of the app
> (pages, components, API handlers, migrations, docs), then a completeness critic
> re-checked coverage and spot-verified the highest-severity claims against the
> code. Every finding below carries `file:line` evidence in the per-slice detail.
> No claim was accepted without code.

---

## TL;DR — what this audit found

**The app is far more built-out than "a bunch of half-finished features."** The
estimate builder, the wrap-quote estimator, the proof-approval loop, the 3D
Upfit Designer, the parts-readiness engine, the CNI pay-splits engine, and the
invoice-emailing pipeline are all genuinely strong, well-engineered systems. The
Aug-2026 roadmap is ~85% executed and the codebase is unusually clean of
TODO-rot.

**The problems cluster in three places:**

1. **Authorization is enforced in the browser, not the server.** Page access is
   a client-side redirect; the real data gate is Supabase RLS, and RLS currently
   treats *every non-customer account as internal staff* — and, through
   never-dropped legacy policies, lets even the `customer` role read and write
   core tables. On top of that, ~40 write/money/comms API routes guard with only
   "are you logged in?", and the entire R2 file store is an open object store to
   any account. **This is the single biggest theme and it spans every stage.**

2. **The workflow is a chain of strong machines connected by humans.** Almost
   every hand-off on the happy path — estimate→sales-order, SO→upfit-project,
   approved-estimate→graphics-job, arrival→check-in, completion→invoice,
   invoice→payment, graphics-install→CNI-job — is a manual re-typing step that
   someone can silently forget. The machines are good; the conveyor belt between
   them barely exists.

3. **Roles and features drifted.** ~8 of 31 feature keys are dead or cosmetic,
   per-user overrides are pure UI theater (no server enforcement), the two
   internal install roles (`field_tech`, `shop_tech`) are locked *out* of the
   install screens while the external CNI `installer` role is let *in*, and
   several menus route roles to pages that bounce them.

The rest of this document is the walkthrough (Part 1), the cross-cutting
security findings (Part 2), the role-visibility audit the owner explicitly asked
for (Part 3), the "would help if fully built" list including the 3D configurator
(Part 4), and a prioritized fix roadmap (Part 5). **Part 6 is the 2026-08-28
re-verification** — every finding above re-checked against the code as it
actually stands after Round 1 shipped, with the Round 2 roadmap. Where Part 6
and the prose above disagree, Part 6 is current.

---

## How to read the severity tags

- **CRITICAL** — data loss, money error, security hole, or a workflow dead-end
  that stops the job. Fix before it bites.
- **MAJOR** — real friction, silent failure, or double-entry that will cause
  field bugs and wrong numbers.
- **MINOR** — polish, naming, hygiene, edge cases.

---

## Progress tracker

_Living status of the Part 5 roadmap. Updated as fixes ship._

**Legend:** ✅ done (shipped & merged) · ⚠️ partial (some sub-parts open) ·
🔄 in progress · ❌ not started

| Block | Status | Notes |
|---|---|---|
| **Now** — security & data-loss (1–9) | ✅ done | PRs #630–#634; item 9's `cni_jobs` half finished by the CNI hardening (#641–#646, migration 226). |
| **Next** — close the workflow chain (10–16) | ✅ done | PRs #635–#640; #14 CNI notifications fully wired (#640–#646), the legacy CNI invoice flow killed (closure gate reads AP coverage, migration 231), and the graphics/check-in → CNI job bridge shipped (migration 232). |
| **Soon** — the role cleanup (17–20) | ✅ done | #17 infra + owner-page gates (#649), #18a registry (#648), #18b all ten tools keyed (#652, #654, #655), #19 install roles (#650), #20 dead-end menus (#651). The ungated-by-URL pages are gated and the dev route deleted (#656). An adversarial gate audit (every tile/nav/redirect/deep-link entry point traced per role) confirmed 20 regressions, all fixed: client dead-clicks + two redirect loops (#657) and per-recipient vehicle notification links (#658). |
| **Data-integrity bugs to fix in passing** | ✅ done | All 6 re-verified as live, then fixed: pushed-estimate delete (#660), Add-Graphics demotion (#661), stranded allocations — trigger + backfill, migration 228 (#662), graphics history trigger, migration 229 (#663), the 1000-row-cap sweep across payroll/payouts/credits/pay-rates/scans/invoices/pos/dashboard (#664), and the Open Quotes tile (#665). |
| **Hygiene** — delete the dead set | ✅ done | Dead routes/components/libs/page deleted + stale doc passages fixed after a 14-agent zero-reference verification (#667). CI dead-code check added (knip `--include files` in ci.yml), which also caught + deleted the two orphaned demo Buttons. Dormant tables dropped after owner sign-off 2026-08-27 (migration 230, #669) — the drop surfaced a production-only policy drift that blocked deploys for ~4h until #675; see the Hygiene section. |
| **Round 2** — re-verified 2026-08-28 (Part 6) | 🔄 in progress | A fresh code-level re-verification of all 118 findings: 32 fixed, 65 open, 21 partial. Two shipped since: profile privilege escalation (a CRITICAL this document never had — migration 233, #679) and graphics-job delete (migration 234, #680). Five Round 2 items are blocked on an owner decision. |

Per-item status is tagged inline in Part 5 below; Part 6 carries the Round 2 verification and roadmap.

---

# Part 1 — The walkthrough, stage by stage

## Stage 1 — The phone rings: lead → customer record

**Role: sales.** The CRM is genuinely deep: one-step customer creation with an
instant NetSuite push and local mirror, business-card scanning (Claude vision),
a deals pipeline, AI voice-note logging, statements with A/R aging, and a rich
single-surface customer record. A "Create + Start Estimate" button takes a phone
lead straight to the estimate builder.

**What breaks at the edges:**

- **CRITICAL — The credit application is a black hole.** The public
  `/credit-application` form writes rows into `credit_applications` (EINs, bank
  references) that **nothing in the app ever reads** — no review queue, no API,
  no notification. The customer is promised review "within 2–3 business days" by
  a workflow that does not exist. The migration's `status`/`reviewed_by`/
  `review_notes` columns are dead. Staff can't even send a customer the form URL
  from inside the app.
- **MAJOR — Phone-intake basics are missing.** No lead-source field on the
  *create* form (it's edit-only, with an odd hardcoded option list), **no
  phone-number search anywhere** (the first thing you'd do with caller ID), no
  structured "what do they want" capture — a combined upfit+graphics inquiry
  can't be represented (single deal `type`), so it all lives in free-text notes
  and gets re-typed into the estimate later.
- **MAJOR — Follow-up reminders never notify.** Manual and AI-voice-note
  reminders are written and displayed but **no cron fires them** — they surface
  only if someone happens to open the record or the Schedule page. The roadmap
  flagged this a year ago.
- **MAJOR — Duplicate guard is exact-name-only**, client-side, and inconsistent
  across the four customer-create paths; phone/email are never checked. Every
  inquiry instantly becomes a NetSuite customer (no lead tier), and deleting a
  linked record only deletes the CRM row — it resurrects on the next sync.

## Stage 2 — Building the estimate (upfit parts + graphics)

**Role: sales.** This is the most mature slice in the app. VIN decode with live
platform/qualifier cascade, a fitment-filtered catalog browser, kits/packages,
per-line margin chips against a shared floor, and a genuinely well-engineered
**wrap-quote round trip**: "Add Graphics" saves the estimate, hands the vehicle
to the wrap estimator (draw measured shapes over a 1:20 template, assign films,
optional roll-nesting re-price), and folds the result back into the estimate as
two lines with replace-on-re-add semantics and a double-bill guard. The merged
customer PDF stitches the coverage diagram and proofs onto the estimate. Local
autosave, follow-up machinery, and a combined `/quotes` list round it out.

**What breaks:**

- **CRITICAL — `GET /api/estimates` leaks live approval tokens to every staff
  role.** The list is `select('*')`, which includes `approval_token`. Any staff
  member can read it, open the customer's magic link, and **forge an
  acceptance** — the E-SIGN record the sales-order gate trusts.
- **CRITICAL — All estimate APIs are `requireStaff` only.** Shop/field techs and
  finance can delete (including the NetSuite copy), rewrite prices, push, and
  email any estimate to a customer — despite the admin/sales-only UI.
- **MAJOR — No revision lock and no versioning.** An `accepted` estimate stays
  fully editable in the main upsert, and the customer's still-live approval link
  renders the *current* rows, not what was emailed. Someone can edit after
  sending; the customer approves something different, silently. No duplicate/
  clone, no templates, no version stamp.
- **MAJOR — The graphics-job prompt misses the two main graphics paths.** The
  "Spawn graphics job" panel only fires off part-backed graphics-catalog lines;
  wrap-quote-fold lines and quick-graphics lines don't trip it — so a combined
  upfit+graphics estimate can reach a sales order **with no graphics job and no
  prompt**.
- **Bugs:** deleting a pushed estimate *always* fails (the internal NetSuite-
  delete fetch forwards no auth → 401 every time); "Add Graphics" silently
  demotes a `pushed` estimate back to `draft`; push vs convert-to-SO resolve the
  labor item by `LIKE '%LABOR%'` first-match, so the same estimate can bill labor
  to different NetSuite items (including "Graphics Install Labor").

## Stage 3 — Sending for approval & capturing it

**Role: sales → customer.** The *send* side is the app's best-built stage: full
compliance with the customer-email compose standard, a zero-side-effect live
preview, rotating 30-day magic-link tokens, one shared renderer for
email/page/snapshot, delivery + bounce tracking, and correct deep-linked
notifications to the sales team on accept/decline. The customer sees the real
estimate document (line photos, product links, vinyl/graphics blocks, E-SIGN
checkbox), and acceptance freezes a hashed signed snapshot.

**What breaks — the capture side:**

- **CRITICAL — The estimate stays fully editable during and after approval**
  (see Stage 2), and the live approval page shows current rows, not what was
  emailed. No lock, no "document changed since sent" guard, no re-approval.
- **MAJOR — The signed E-SIGN snapshot is write-only.** It's saved with a SHA
  hash but **no viewer, download, or verification exists anywhere** — in a
  dispute you're spelunking R2 by hand.
- **MAJOR — Rejection reasons and approval provenance vanish from the UI.** The
  reason is pushed once in a notification, then *destroyed* on resend; "when/how
  did they approve" is never shown in-app.
- **MAJOR — Resend bookkeeping only handles draft→sent.** A resent *rejected*
  estimate keeps status `rejected` (drops out of the whole follow-up system); a
  `pushed` estimate is pre-counted as **won** in sales-performance before the
  customer decides.
- **MAJOR — `/api/graphics/from-estimate` is `requireAuth`** — a customer or
  installer account can flip any estimate to `accepted`. And approving the
  estimate never reconciles the linked wrap quote, so the combined job keeps
  nagging reps and mis-books reporting.
- **MAJOR — No customer-facing reminders for stale estimates** (proofs get
  auto-resend ×3 + escalation; estimates rely on the rep remembering).

## Stage 4 — Sales order, NetSuite, and ordering the parts

**Role: sales/admin.** The convert-to-SO step is well-gated (`customer_approved`
+ admin override with a recorded reason + audit log). The parts machinery
downstream — **Parts Readiness** (live need vs reserved vs free vs on-order with
a clear verdict), allocations with safe caps, vendor-PO sync, an hourly ETA
email scan with a review queue, and one-click vendor bills — is genuinely
strong.

**But the chain between them is held together by humans:**

- **CRITICAL — Converting an estimate creates nothing downstream.** No upfit
  project, no graphics job. The user must go create the project by hand and
  **re-type the SO number the app just generated** into a lookup box before any
  readiness math is reachable. (Roadmap N2 phase 1, still unbuilt.)
- **CRITICAL — "Order the upfit parts" has no software at all.** The readiness
  card can say "✗ 3 parts not in stock or on order — don't schedule yet" and
  offers *nothing*: no PO creation, no purchase request, no notification to
  purchasing. You place the vendor PO in NetSuite by hand and wait up to 2 hours
  for it to mirror back. **There is no receiving flow either.**
- **MAJOR — NetSuite sync failures are invisible to the people who act on the
  data.** System Health is super-admin-only by default; per-row sync errors are
  silently `continue`d; a degraded `quantityshiprecv` fallback zeroes received
  quantities with no flag — and stale on-order data then drives scheduling
  verdicts.
- **MAJOR — Convert-to-SO isn't idempotent.** The post-create write-back is
  unchecked and there's no lock, so a failed write or a double-click makes a
  **second real SO in NetSuite**. Pushed NS estimates are left open forever
  (`createdfrom` NULL), permanently degrading the SO↔estimate matcher.
- **MAJOR — Upfit-project APIs are `requireAuth` + `.passthrough()`** —
  customer/installer accounts can read, arbitrarily edit, or **delete** any
  project.
- **Dead:** the `netsuite_sales_orders` mirror is synced every 2h and rendered
  nowhere; `SalesOrderPdf` + its route are orphaned; the parts-ETA→project
  propagation keys on a column no UI ever writes.

## Stage 5 — Graphics production (design → proof → print → pack)

**Role: graphics_production.** The most complete slice: a solid board with
metrics and stage-age/proof-age flags, a full job record, and a **genuinely good
proof-approval loop** (compose → magic link → hashed E-SIGN snapshot → auto-
reminders → escalation). Four intake paths (wizard, PO, estimate, wrap quote)
all converge on one pipeline.

**But the pipeline itself is honor-system:**

- **CRITICAL — The "New Graphics Job" notification fan-out is dead.** It reads
  other users' `notification_preferences` from the browser, but RLS is
  own-rows-only, so the target list is always empty and `notify_new_job` never
  sends. Nobody is told when a job is created.
- **CRITICAL — No status state machine, and RLS lets every staff role update or
  *delete* graphics jobs.** The record page renders a flat button row — any
  status jumps to any status in either direction — and the "admin-only Delete"
  is JSX-only; the DB allows any internal staff to delete. A sales rep opening a
  notification link can flip a job from Designing straight to Shipped.
- **MAJOR — Printing is never gated on proof approval.** A rejected or never-sent
  proof can move to `printing` with zero warning — defeating the entire point of
  the E-SIGN loop.
- **MAJOR — The packing stage has no packing list.** The packing-list PDF only
  renders *after* an invoice exists, and there's no pick/pack checklist. A packer
  at the `packing` stage of a not-yet-invoiced job has nothing.
- **MAJOR — Roll-nesting never reaches production.** The excellent RollNesting
  component is wrap-quote-only; production jobs get a flattened text summary and
  the material log is manual, inventory-blind typing.
- **MAJOR — Proof files are served from public R2 URLs** — the token gates the
  *page*, not the *artwork*.

## Stage 6 — The graphics install guide

**Role: graphics_production/admin → installer.** Authoring is surprisingly
strong: a full dimension editor at `/graphics/install-guides` with PDF import,
auto/manual calibration, a branded PDF export, a "dimensioned proof" rebuild,
and email/attach-to-CNI-job delivery.

**But the guide is an orphan, and its audience isn't gated:**

- **CRITICAL — The guide has no link to the job, vehicle, or CNI job.** Customer
  and vehicle are free text; nothing references the guide from `graphics_jobs`,
  `fleet_checkins`, or `cni_jobs`. Finding "the guide for this Transit" means
  eyeballing a flat list.
- **CRITICAL — CNI installers — the guide's actual audience — have no checklist
  and no photo gate at completion.** The guide's own text promises "photos of
  each side" and "deviations may be redone at the installer's expense," but the
  system enforces none of it on CNI jobs (checklists instantiate only onto
  in-shop check-ins).
- **MAJOR — Checklist category selection is inverted** (detailed under Stage 8):
  upfit-only vehicles get the *mixed* template and are blocked on a required
  graphics task that has no meaning for them.
- **MAJOR — Stale calibration:** changing a guide's template scale after PDF
  import silently skews every exported dimension, and the export footer prints
  the new scale next to numbers computed from the old one.
- **MAJOR — The in-shop tech verifying "Graphics applied per proof" never sees
  the dimensioned guide** — the completion modal shows the raw proof only.
- **MAJOR — Install guides bypass the feature system** (raw role flags), and a
  pure `super_admin` account is locked out of them in both UI and RLS.

## Stage 7 — Vehicle arrives: check-in with photos

**Role: shop_tech.** The check-in wizard (VIN → Sales Order → Proof) is the
best-built UI in the stage: barcode + partial-VIN scanning, NHTSA decode with an
offline fallback, multi-SO linking, cloning, and a good "graphics needed"
hand-off. But the physical arrival — the moment custody and liability transfer —
is unprotected and unlinked.

- **CRITICAL — "Photograph BEFORE we take possession" is policy, not software.**
  Photos are explicitly optional: no required angles, no minimum count, no
  odometer, **no damage capture** (`photo_type='damage'` has no writer anywhere,
  so the timeline's "Issues" section is dead code). For a liability dispute, the
  system happily produces check-ins with zero photographic evidence.
- **CRITICAL — Arrival and check-in are two unlinked systems.** "Mark Arrived"
  on the arrival board writes `shop_inbound.status='arrived'` and *nothing else*
  — no check-in, `fleet_checkin_id` written by no code — while check-in never
  closes the expected row. Two buttons for one physical event; vehicles show
  "overdue — expected but not arrived" while sitting in the shop.
- **CRITICAL — A returning vehicle can never be checked in again.** The
  duplicate-VIN guard matches archived/shipped rows with no re-check-in path.
  Fleet vans come back; the only workaround destroys the prior job's history.
- **MAJOR — No notification when a vehicle arrives** — not to the customer
  ("we've got your van"), not to sales, not to the assigned installer.
- **MAJOR — RLS hole:** the never-dropped 001-era permissive policies let *any*
  authenticated account (customer role included) read the whole shop board and
  update any check-in; `/api/vehicles/[vin]/photos` is `requireAuth`, so any
  login can enumerate any vehicle's photos and captions.
- **MAJOR — No VIN→SO auto-match** despite the VIN being on the SO and estimate
  — the docs promise a pre-fill that doesn't exist, forcing double entry on every
  multi-van drop-off.

## Stage 8 — Performing the upfit + graphics install

**Role: shop_tech / field_tech.** The In-Shop board and the completion ceremony
(gated on photos + required tasks + the graphics-install lane, with mentions and
a stuck-vehicle cron) are genuinely strong. But the role model is **inverted for
this stage:**

- **CRITICAL — The two roles built to install can't run the install.**
  `field_tech` has no In-Shop access at all; both `field_tech` and `shop_tech`
  are bounced off the pick-list install runner and the assignment picker — while
  the external CNI `installer` role passes every gate.
- **CRITICAL — The status APIs are `requireAuth`-only.** Any approved account
  (customer included) can flip any vehicle's status and trigger "your vehicle is
  ready"/"shipped" customer emails, or mark graphics lanes complete.
- **CRITICAL — RLS counts external CNI installers as internal staff** with full
  CRUD on `fleet_checkins`, `estimates`, `customers`, `purchase_orders` from the
  browser client.
- **MAJOR — `received → complete` bypasses the entire completion gate** — no
  photos, no checklist, no QC stamp, no notifications.
- **MAJOR — No job-level labor capture.** Nothing links time entries or shifts to
  a vehicle, so actual install hours vs. the estimate are unknowable — on a job
  the whole app exists to invoice.
- **MAJOR — Assignment is split-brained:** the picker writes `job_assignments`,
  but the board card, the stuck-alert cron, and notify-ready all read
  `fleet_checkins.assigned_to`, which nothing writes.
- **MAJOR — Checklist template selection inverted** (pure-upfit vehicles get the
  mixed template with a required graphics task); **"Message Customer"
  dead-ends** for shop_tech/installer (thread created, then bounced to /home);
  **marking a vehicle stuck notifies nobody for 48h**.
- **Bug:** the migration-092 trigger never writes graphics history on the success
  path and writes a bogus row for cancelled jobs.

## Stage 9 — Completion, invoice, and getting paid

**Role: admin/shop → finance.** Where it's finished, the completion→invoice→email
pipeline is strong: photo/checklist gates, a verify-before-create invoice review
modal, an all-or-nothing invoice emailer with delivery tracking and bounce
alerts, and a scan-to-invoice batch path with an over-billing gate. **But the
money loop never closes:**

- **CRITICAL — Invoice/status/notify APIs are `requireAuth`-only** — customer and
  installer accounts can create real NetSuite invoices, mark jobs invoiced, flip
  any vehicle's status, and harvest customer email/phone via the preview
  endpoints.
- **CRITICAL — Payment status never flows back.** `is_paid` is a hand-ticked
  checkbox on the vehicle/scan; the "awaiting payment" dashboard tile is fiction.
  The AP side has a paid-sync; the **AR side has none**, even though the data is
  already fetched elsewhere.
- **CRITICAL — `received → complete` skips every gate** (also Stage 8) — no
  photos, no QC, no customer notification.
- **MAJOR — The graphics billing prompt can silently reach nobody.** It fires
  only on `shipped`, client-side fire-and-forget, to admins opted into a
  preference that **defaults to false** — so with zero opt-ins it dispatches to
  an empty list. `picked_up`/`installed` jobs never prompt at all.
- **MAJOR — Finance dead-ends everywhere.** The bounce alert deep-links finance
  users to `/invoices`, which redirects them to /home; their More menu shows
  Invoicing/Reports/Scan Log that all bounce; they can't see A/R aging at all.
- **MAJOR — Dead flags:** `photo_reviews` gates nothing; `deepLinks.scanPhotos`
  points at a nonexistent `/photos` page; the only partial-SO billing route is
  orphaned. **Vehicle invoicing is full-SO only, one per check-in, with no email
  step.**

## Stage 10 — Upfit Projects & the 3D Upfit Designer

**Role: sales.** These are **not** the half-built stubs you might expect. The 3D
Upfit Designer is a complete v1 — vehicle picker → trade packages → live 3D
editor with snapping/undo/warnings → PDF → a real draft-estimate hand-off
carrying NetSuite item IDs. Upfit Projects is a working tracker with live
parts-readiness and stock reservations.

**What's broken is the connective tissue and the locks:**

- **CRITICAL — The upfit-projects API + RLS are open to any account.**
  `requireAuth` + `USING(true)` RLS means customer/installer (and even the
  anon key) can read, rewrite, and **DELETE** all projects.
- **CRITICAL — Estimate→SO conversion never creates the project** (the manual
  chasm from Stage 4).
- **MAJOR — The 3D design dead-ends at the estimate.** There's no design link on
  the project, so the shop builds without ever seeing the approved layout.
- **MAJOR — The ship-complete DB trigger strands part allocations in
  `reserved`** — permanently shrinking free stock for every other job's readiness
  math.
- **MAJOR — No UI can cancel a project** (cancellation is the only path that
  releases reservations), and unplaced (no-dimension) parts can never be removed.

## The CNI (contract-installer) subsystem

**Role: installer.** The *mechanics* are mature — the pay-splits/credits/payout
engine, scan-to-Scan-Log unification, and the AP vendor-invoice flow are all
shipped. **But the coordination layer is hollow:**

- **CRITICAL — A notification vacuum across the entire lifecycle.** Invited,
  assigned, scheduled, bid, completed, photo-denied, payout approved/paid,
  chat — **none** fire a notification, and the UI falsely says "you'll be
  notified." For a workforce that's *outside the building*, the whole loop runs
  on phone calls.
- **CRITICAL — RLS lets installers update any column of their jobs** from the
  browser: `pay_per_vehicle`, `invoice_status`, `netsuite_bill_id`, `status`.
- ✅ **CRITICAL — Two competing company-mode invoice flows** existed; the closure
  checklist only recognized the legacy one, so a company using the modern AP
  flow left its jobs permanently unclosable. _(Fixed: the legacy flow is
  deleted — installer upload page, submit-invoice route, admin approve card,
  dashboard tile — and the closure gate now reads AP coverage per completed
  vehicle, with legacy-approved jobs grandfathered. Correction to the
  original finding: the legacy flow was live, not dead, and individual-mode
  closure was already correct.)_
- ✅ **MAJOR — No bridge from graphics/check-in to a CNI job** — outsourcing an
  install meant re-typing everything and losing the pay/photo/billing machinery
  unless the crew happened to scan the right part. _(Fixed: "Outsource
  Install" buttons on the graphics job page and tracking modal prefill the
  CNI job form and seed VINs; one job per source, linked both ways —
  migration 232.)_

---

# Part 2 — Cross-cutting security & authorization (the biggest theme)

Authorization is the thread that runs through every stage above. The pattern is
consistent: **the UI hides a feature, but the server still serves it.** Page
gates are client-side redirects; the real gate is RLS or a per-handler check,
and both have systemic holes.

### The critical list (fix these first)

1. **`/api/search` is a company-wide data oracle.** Service-role client, bare
   `requireAuth`, and the Search button is in the header for *every* role
   including customer-only accounts. It returns POs, estimates, customers,
   quotes, invoices — and **all private DM bodies** with no participant filter.
   A customer login is one click from BMG's jobs and quotes for their
   competitors.
2. **The R2 storage API is an open object store.** `storage` GET/POST/DELETE +
   download + presign guard only with `requireAuth` and take an arbitrary
   `bucket`+`path` on a service-role client. Any login can read, **overwrite**
   (including signed legal snapshots), or **delete any object in any bucket**.
3. **`is_internal_staff()` = `role != 'customer'`** gives external CNI installers
   full CRUD on the CRM, credit applications (EINs/bank refs), estimates,
   customers, POs, and fleet check-ins. **And** the never-dropped 001-era
   permissive policies on `fleet_checkins`/`vehicle_status_history` let even the
   `customer` role read and update every row. *(The fix must drop the 001
   policies, not only tighten the function.)*
4. **Deactivated accounts keep full access.** `requireAuth` never checks the
   `deactivated` flag despite its own docstring claiming it does, and nothing at
   login checks it either. "They can no longer log in" is false.
5. **A regular admin can mint a super_admin** via `/api/admin/create-user`
   (`requireAdmin` only). The wall between admin and owner-level (financials,
   user management, audit log) is one API call thick.
6. **`/api/admin/reset-data`** — a live, no-UI "DELETE ALL DATA" endpoint behind
   `requireAdmin` + a magic-string body. Any admin account can wipe operational
   data with one curl.
7. **`GET /api/estimates` leaks approval tokens** → forge customer acceptance
   (Stage 2).
8. **~40 write/money/comms routes behind bare `requireAuth`** — graphics
   invoice/notify, vehicle-tracking status, upfit-projects CRUD, `jobs/assign`,
   `customer-threads`, `messages/send-sms`, gmail PO import, calendar/dropbox
   writes. Any approved login (customer/installer) can invoke them.
9. **Twilio/SMS inbound webhooks fail OPEN** — signature verification is skipped
   unless an env var is explicitly `'true'`, so anyone can forge inbound SMS and
   overwrite a matched profile's phone number.
10. **`auth/signup`** is an unauthenticated service-role profile upsert keyed on a
    client-supplied `userId` — can reset an existing user to `pending` and
    downgrade their role.
11. **The AI agent runs arbitrary SELECTs on the whole DB** via service-role
    `exec_readonly_sql` for any non-customer account (installers get the UI). The
    table restrictions live only in the prompt.
12. **`admin/user-settings`'s super-admin gate is defeated** by `requireRole`
    auto-passing any admin — so every regular admin can edit any user's settings.

### Why this happened (and the durable fix)

The service-role client is used pervasively for legitimate RLS-bypassing work,
so a forgotten in-handler scope check has **no RLS backstop**. The one regression
test only forbids bare `requireAuth` in 7 directories — it accepts unguarded
routes, ignores graphics/storage/jobs/etc., and can't see semantically-wrong
guards. **The durable fix is a route→permission manifest** consumed by both the
UI feature gates and the server guards, so the two can be proven consistent
instead of hand-synced per file, plus coarse RLS as a backstop on the tables the
service role writes.

---

# Part 3 — Role × feature visibility audit (the explicit ask)

The system has **31 feature keys** resolved **client-side only**. Middleware
gates nothing; per-user overrides are stored but **never consulted by any server
route or page** — deny hides a button without removing access; grant shows a tab
that then bounces. About 8 keys are dead or cosmetic.

### What each role sees today (condensed)

| Role | Nav tabs (top 7 + More) | Notable | Problems |
|---|---|---|---|
| **super_admin** | Home, Upfit, Graphics, In-Shop, POs, Scans, Customers | All 31 features; Financials tab | — |
| **admin** | same as super_admin | all but the 6 owner-level keys | can be *granted* owner keys via override, but `financials` grant can't work (role-checked, not feature-checked) |
| **sales** | Home, Upfit, Graphics, In-Shop, Customers, Schedule, Time | full ops dashboard | has `graphics` production access; `fleet_checkin` only widens a tab |
| **graphics_production** | Home, Graphics, In-Shop, Schedule, Time, Estimates | redirected to /graphics | **"Parts Catalog" menu item bounces them** |
| **shop_tech** | Home, In-Shop, Schedule, Scan, Time | — | **locked out of the pick-list install runner** (Stage 8) |
| **field_tech** | Home, Scan, Time | — | **no In-Shop access at all — can't run an install** |
| **installer** (external) | Home, Scan, Time, CNI Jobs | gets the AI chat | **`cni_management` is portal access, not management** (misnomer); **Scan tab 403s**; **Time is the internal payroll clock**; passes install gates internal techs fail |
| **finance** | Home, Scans, Time | full ops dashboard (with 403 holes) | **Reports & Invoicing menu items both bounce**; can't see A/R aging; the one report they're allowed is only linked from a page that bounces them |
| **executive** | Home | straight to Financials | clean |
| **customer** | My Jobs, Settings | portal-scoped | **but the header still gives them Search (company-wide oracle), Chat, Mentions, Alerts**; many pages reachable by URL |

### The cleanup the owner asked for

**Dead/misnamed keys to remove or rename:**
- Kill `photo_reviews`, `all_jobs`, `catalog_management` — grantable toggles wired
  to nothing.
- Rename `proof_hygiene` → `proof_search` (it's split-brained: the menu item
  shows only to admins, but the page admits sales/graphics).
- Rename `cni_management` → `cni_portal` so the installer grant reads as what it
  is.

**Grants that don't match reality:**
- **8 admin tools bypass the feature system** (raw `isAdmin`) — plus `/admin/payroll`
  and `/admin/pay-rates` found by the critic, so **10** — none can be delegated
  via overrides.
- **Ungated pages reachable by URL:** `/admin/scans`, `/admin/inventory`,
  `/tracking`, `/upfit`, `/time`, `/admin/schedule` (shows Google-synced company
  calendar events to any account), `/invoices/bulk-download`, `/dev/button-demo`.
- **Dead-end menus:** finance → Reports/Invoicing; graphics → Parts Catalog.
- **Backwards install roles:** give `field_tech`/`shop_tech` the install surfaces;
  stop letting external installers pass internal-tech gates.

**The durable fixes:**
1. A `requireFeature(req, key)` server helper that resolves role defaults +
   `user_feature_overrides` — makes overrides *real* and the matrix enforceable.
2. One `useRequireFeature(key)` hook per page, replacing the ad-hoc
   `isAdmin || isSales…` combos, so every page has exactly one gate derived from
   its feature key.
3. Fix the three auth-layer holes (deactivated check, `requireRole` admin
   auto-pass, `/api/search` → `requireStaff`).

A full recommended role→feature table is in the per-slice `roleaudit` detail.

---

# Part 4 — "Would help if fully built" (including the 3D configurator)

The owner asked specifically about features that would help if finished. The
biggest ones:

- **The 3D Upfit Designer → shop bridge.** The designer is already a complete v1
  that produces a priced, to-scale 3D BOM and hands it to an estimate. What's
  missing: (1) auto-create the upfit project on SO conversion, and (2) a
  `design_id` link so the **shop builds from the approved 3D layout** instead of
  re-planning from tasks and file attachments. Per-SKU 3D meshes (the seam is
  already built: `resolveItemMesh`) and seeded trade packages would turn it into
  a real closing tool. A magic-link 3D viewer (the scene already has a read-only
  mode) would let customers see their van.
- **Auto-create the upfit project + parts-order queue on conversion** (roadmap
  N2) — removes the single biggest manual gap in the whole workflow.
- **In-app parts ordering & receiving** — a "Request purchase" action on `short`
  parts and a "Receive against PO" screen; today both happen entirely in NetSuite
  by hand with a 2-hour blind spot.
- **AR payment sync-back** — a cron mapping NetSuite invoice status onto
  `is_paid` (the AP side already has one), turning the "awaiting payment" tile
  into fact.
- **Signed-document viewer** — the storage path + hash columns exist for
  estimates, quotes, and proofs; only the read side is missing.
- **RingCentral SMS provider (`SMS_PROVIDER_ENABLED`)** — the entire SMS channel
  (approval links, pickup/complete customer texts, staff DM texts) is wired and
  waiting behind one flag; turning it on fixes several dead spots at once.
- **CNI lifecycle notifications + `sync-cni` calendar + a graphics→CNI job
  bridge** — the CNI machinery is built; it just doesn't talk. One shared
  `notifyCompanyInstallers` helper and a "Create CNI job from this graphics job"
  button close most of the coordination gap.
- **CEO dashboard plan** (~5% built) — the daily `metric_snapshots` cron is the
  time-sensitive one ("history can't be backfilled"); the RESTlet P&L/collections
  work is the only route to the owner's margin/cash metrics.
- **The customer portal's missing 5%** — its only provisioning path
  (`/api/admin/link-customer`) has no UI, so a customer login can't be set up from
  the app; and the portal shows no invoices/balances.
- **Offline scanning** — relevant if field techs scan VINs in dead zones. (The
  unwired IndexedDB queue `offline-db.ts` this bullet originally pointed at was
  deleted in the hygiene sweep after sitting unconnected; the scanner's own
  localStorage retry queue is the surviving starting point.)

---

# Part 5 — Prioritized fix roadmap

### Now — security & data-loss (small, high-leverage) — ✅ done

1. ✅ (#632) `/api/search` → `requireStaff` and scope/drop the messages group.
2. ✅ (#633) Storage API → bucket allowlist + record-scoped path check; drop
   arbitrary GET/DELETE.
3. ✅ (#634) Drop the 001-era `fleet_checkins`/`vehicle_status_history` permissive
   policies **and** change `is_internal_staff()` to a real staff allowlist.
4. ✅ (#631) Add the `deactivated` check to `requireAuth`; add `requireSuperAdmin` and use
   it in `create-user` (block admins from minting super_admins) and
   `user-settings`.
5. ✅ (#630) Delete or env-wall `/api/admin/reset-data`.
6. ✅ (#630) Strip `approval_token`/`internal_notes` from `GET /api/estimates`.
7. ✅ (#630) Make webhook signature verification fail **closed**.
8. ✅ (#632) Move the ~40 bare-`requireAuth` write/money/comms routes to
   `requireStaff`/role checks (graphics invoice/notify, vehicle-tracking,
   upfit-projects, jobs/assign, customer-threads, messages/send-sms).
9. ✅ (#634 upfit half; #641–#646 CNI half) Tighten `USING(true)` RLS on the
   upfit-projects tables and the CNI `cni_jobs` UPDATE policy (installer writes
   rerouted to whitelisted API routes; RLS reduced to SELECT-only, migration 226).

### Next — close the workflow chain — ✅ done

10. ✅ (#636) **Auto-create the upfit project inside convert-to-SO** (find-or-create by
    `estimate_id`) — kills the biggest manual hop.
11. ✅ (#636/#637) Make the graphics-job prompt fire on wrap-fold/quick-graphics lines, or
    prompt at convert-to-SO time.
12. ✅ (#635) Fix the checklist category-ordering inversion (both routes).
13. ✅ (#635) Close the `received → complete` gate bypass.
14. ⚠️ Wire CNI lifecycle notifications (one shared helper) — ✅ (#640 payouts;
    #641–#646 full assign→schedule→complete→photos→invoice set); ✅ legacy CNI
    invoice flow killed (installer upload page + submit-invoice route deleted,
    closure gate reads AP coverage via /api/cni/job-billing with a legacy
    grandfather, columns deprecated in place by migration 231 — two audit
    corrections: the legacy flow was live, not dead, and individual-mode
    closure was already handled; only company mode was broken); ✅ the
    graphics/check-in → CNI job bridge shipped: "Outsource Install" buttons
    on the graphics job page and the tracking vehicle modal prefill
    /admin/cni/jobs/new (title, customer, scope, part, deadline, ship-to,
    site contact) and seed the source's vehicles as pending VIN rows;
    one CNI job per source enforced by DB unique indexes (migration 232,
    `source_graphics_job_id`/`source_checkin_id` + find-or-create
    redirect); both sides link to each other, and creation-time company
    assignment now goes through /api/cni/assign-company so the
    cni_assigned notification finally fires for it. **Item 14 closed.**
15. ✅ (#639) AR payment sync-back cron.
16. ✅ (#638) Fix the assignment split-brain (write `assigned_to`, or read
    `job_assignments` everywhere).

### Soon — the role cleanup — ✅ done

17. ✅ (#649) `requireFeature` server helper + `useRequireFeature` page gate; the
    five owner-level admin pages gate purely on their feature key, and the
    ungated-by-URL pages (#656: /tracking, /upfit, /time, /scan, /messages,
    /fleet/update, /earnings, /invoices/bulk-download, /admin/scans,
    /admin/inventory, /admin/parts-mail, /admin/schedule) each gate on their
    tile's key; `/dev/button-demo` deleted.
18. ✅ 18a (#648) — deleted `photo_reviews`/`all_jobs`/`catalog_management`,
    renamed `proof_hygiene`→`proof_search` and `cni_management`→`cni_portal`
    (migration 227). 18b (#652, #654, #655) — all ten raw-`isAdmin` tools carry
    delegatable keys: `cni_admin` (12 console pages), `payroll`, `invoice_admin`,
    `data_import`, `proof_admin`, `install_admin`, `part_admin`.
19. ✅ (#650) `field_tech`/`shop_tech` can now run the pick-list install runner;
    external installers gain no internal surface (exclusion half was migration 224).
20. ✅ (#651) Finance lands on Reports; graphics lands (read-only) on Parts
    Catalog; the Invoicing tile is hidden from finance (they don't author invoices).

**Post-gating verification (#657, #658):** an adversarial audit traced every
entry point (tiles, nav tabs, home redirects, notification deep links,
cross-links) against each new gate's admitted roles — 20 confirmed
regressions, all fixed: audience-matching feature grants (`upfit_projects`
to graphics/techs, `schedule` to field_tech), the /tracking gate widened to
its nav-tab condition (killing an override-induced redirect loop),
dashboard/header/search controls hidden where the destination would bounce,
and vehicle notifications now build a per-recipient URL
(`deepLinks.vehicleLinkFor`) so installer clicks land on the pick-list
instead of bouncing off the In-Shop gate.

### Data-integrity bugs to fix in passing

- ✅ Deleting a pushed estimate always fails (forward auth). _(#660)_
- ✅ "Add Graphics" demotes pushed estimates to draft (pass current status).
  _(#661 — the sent/accepted/rejected half was already guarded server-side;
  #661 closes the remaining pushed→draft path on both client and server)_
- ✅ Ship-complete trigger strands allocations in `reserved` (release them).
  _(#662, migration 228 — status-change trigger on `upfit_projects` +
  backfill of already-stranded rows)_
- ✅ Migration-092 trigger never writes graphics history on success.
  _(#663, migration 229 — captures `from_status` before the update)_
- ✅ Payroll/pos/scans/invoices/OpsDashboard unpaginated reads (violate the
  repo's own 1000-row rule) — workers silently unpaid, billable scans hidden.
  _(#664 — fetchAllRows everywhere with id tiebreakers; payroll/payouts/
  credits APIs fail closed on partial reads)_
- ✅ Open Quotes tile counts only `wrap_quotes` (excludes estimate dollars).
  _(#665 — combined with estimates per quote-list.ts, deep-link → /quotes)_

### Hygiene — delete the dead set (~1,500 lines, zero behavior change)

✅ Deleted after a 14-agent adversarial reference sweep (imports, JSX, URL
strings, service workers, crons, configs, migrations, git history) confirmed
zero live references: routes `/api/netsuite/sales-order-pdf`,
`/api/netsuite/invoice-pdf`, `/api/netsuite/create-invoice-direct`,
`/api/netsuite/customer-purchases`, `/api/contacts`, `/api/push/send`
(NOT `/api/netsuite/contacts/sync` — that one is live via the prospects
page's Sync Contacts button); components `SalesOrderPdf`, `StatusPipeline`,
`SwipeToDelete`; libs `offline-db`, `use-is-mobile` (plus the orphaned
`getSalesOrderPdf`/`getInvoicePdf` wrappers in `lib/netsuite.ts`); the
orphan `/fleet/update` page; and the two stale doc passages.

✅ Dormant tables dropped (owner sign-off 2026-08-27): migration 230 (#669)
recreates the three RLS policies that referenced `customer_job_assignments`
in an OR arm as internal-staff-only, then drops it and `dashboard_layouts`
(`sales_cadences` was already dropped by migration 059). Zero code
references were re-confirmed for both before the drop.

The drop surfaced a finding about production itself: the database was
**baselined** from a hand-migrated state, and it held more legacy policies
referencing `customer_job_assignments` than the migration files show. The
deliberately non-CASCADE `DROP TABLE` refused (as designed), which failed
the pre-build migrate step and blocked every production deploy from #669
through #674 for ~4 hours — the gate did its job (no code shipped without
its schema; production stayed consistent, just stale). Diagnosis was slowed
by the runner printing only the Postgres error's summary line — the
blocking-object names live in its DETAIL field. Fixed in #675, both halves:

- Migration 230 now sweeps `pg_depend` for any *remaining* policy that
  depends on either dormant table and recreates it internal-staff-only
  (command type and permissive/restrictive preserved), RAISE NOTICEing each
  conversion so the deploy log records exactly what production held.
  Non-policy dependents (a view, an FK) still fail loudly. Verified against
  a local Postgres 16 scaffold reproducing the drift; a fresh-database
  replay is a no-op.
- `scripts/migrate.mjs` now prints Postgres error DETAIL/HINT on failure
  and surfaces migration RAISE NOTICEs into the build log.

The drop lands with the first green production deploy after #675; the
sweep's NOTICE lines in that deploy's build log are the record of which
legacy policies production actually carried.

✅ CI dead-code check: knip (`npm run deadcode`, `--include files`, config in
`knip.json` ignoring runtime-served `public/` and standalone `scripts/`) runs
in ci.yml between Lint and Test and fails the build on any file nothing
imports. Its first run caught two more orphans — `ui/Button.tsx` and
`ui/ButtonShadcn.tsx`, the deleted button-demo page's subjects — now gone
too. The next audit starts at zero.

---

---

# Part 6 — Round 2 (re-verified 2026-08-28)

Round 1 (Part 5) shipped in full. This part is what a **fresh, code-level
re-verification** of this document found afterwards — not a re-reading of the
prose above, which by then described a codebase that no longer existed in
several places.

**Method.** Twelve agents, one per section of Part 1 and Part 2, each extracted
every tagged finding in its section (splitting multi-part bullets, so the count
below is finer-grained than the 59 tagged lines) and re-checked it against the
code at `0c48f1f`, with `file:line` proof of the state *now*. Nothing was
accepted from the Part 5 checkmarks in either direction: a checkmark is not
proof a specific finding closed, and audit prose is not proof one is still open.
A parallel design pass then took the highest-priority open items through a
fix design and two adversarial reviewers each — one hunting for workflows the
fix would break, one hunting for bypasses it would leave open.

## What the re-verification found

| Severity | Open | Partial | Fixed | Total |
|---|---|---|---|---|
| CRITICAL | 19 | 12 | 18 | 49 |
| MAJOR | 42 | 8 | 9 | 59 |
| BUG | 4 | — | 4 | 8 |
| MINOR | — | 1 | 1 | 2 |
| **Total** | **65** | **21** | **32** | **118** |

Round 1 closed the whole *systemic* layer — the "any login can do anything"
era is over — and 32 findings with it. What remains is different in kind:
per-feature integrity gaps and missing workflow software, not a broken
authorization model. **PARTIAL** is its own verdict and matters: the sharp
edge is closed but a real gap remains (e.g. `/api/estimates` no longer leaks
`approval_token` to the list, but a token still reaches other surfaces).

## The finding this document did not have

**CRITICAL — any authenticated account could grant itself super_admin.**
`profiles_update_own` (027:99-102) is `FOR UPDATE TO authenticated USING (id =
auth.uid())`; RLS cannot scope columns, no column-level GRANTs existed in any
of the 232 migrations, and no trigger guarded the table — so one statement
against the browser's anon-key client (`role: 'super_admin', status:
'approved'` on your own row) made a customer portal login or an external CNI
installer a super_admin, since both `profileRoles()` and `get_my_roles()` read
those columns straight back. `profiles_insert WITH CHECK (true)` was the same
hole for an account with no profile row yet.

It was found while adversarially reviewing an unrelated fix, which is the
point worth keeping: the sixteen-agent audit that produced this document did
not catch it. _(Fixed: migration 233, #679 — a BEFORE INSERT OR UPDATE trigger
denying privilege-column changes from a normal signed-in user, verified by
reproducing the escalation on the unpatched schema and blocking it after.)_

## Round 2 roadmap

### Now — the sharp, small ones

1. ✅ **Profile privilege escalation** — migration 233. _(#679)_
2. ✅ **Any staff role could delete a graphics job** — migration 234, plus the
   client `.select()` that made a blocked delete look like a success. _(#680)_
3. ❌ **`/api/auth/signup` profile takeover.** Unauthenticated service-role
   upsert on a client-supplied `userId` resets any existing user to
   `status:'pending'`, `role:'installer'` — an account-lockout primitive.
   Fix designed: narrow the write rather than reject it (prove ownership
   against `auth.users`, then INSERT when no row exists, no-op when the target
   is approved/admin/deactivated, and stop writing `role`/`roles` on the
   update path). Rejecting outright risks orphaning accounts, because the
   `handle_new_user()` trigger this would rely on is defined but never
   attached to `auth.users`.
4. ❌ **AI agent reaches sensitive tables.** The per-query gate is real now
   (server-side roles, financial-table blocks, audit rows) but it is a
   *denylist* of five pay tables — so `credit_applications` (EINs, bank
   references) and `profiles` are still reachable through the chat by any
   non-customer role, including external installers. Needs an allowlist, and
   table extraction rather than a regex on the SQL string.
5. ❌ **New-graphics-job notification fan-out is dead** — the browser reads
   other users' `notification_preferences`, which RLS returns empty, so the
   recipient list is always zero. A correct server-side precedent already
   exists (`/api/graphics/notify-assignees`). _Owner decision: audience._
6. ❌ **Printing is never gated on proof approval.** _Owner decision: who may
   override, and what counts as a legitimate exception (reprints, internal
   test prints)._
7. ❌ **Graphics status: any state to any state, from the browser.** Precedent
   exists in `vehicle-tracking/update-status`. _Owner decision: which
   backward and skip-ahead transitions the floor actually uses._

### Next — estimate integrity

8. ❌ **No revision lock on an accepted estimate.** The customer signs a hashed
   snapshot; staff can then silently change what they signed, and the live
   approval link renders current rows. _Owner decision: whether an admin may
   override with a recorded reason (the `convert-to-SO` precedent) or the lock
   is absolute — there is no clone/duplicate feature, so an absolute lock
   means "start over"._
9. ❌ **All estimate APIs are `requireStaff` only** — shop/field techs and
   finance can price, push, email and delete any estimate.
10. ❌ **Pushed NetSuite estimates are left open forever** (`createdfrom` NULL),
    permanently degrading the SO↔estimate matcher.
11. ❌ **The signed E-SIGN snapshot is write-only** — no viewer, download, or
    verification anywhere, which is exactly what a dispute needs.

### Soon — vehicle custody and the shop floor

12. ❌ **Check-in photos are optional, with no damage capture** — the moment
    liability transfers is unprotected, and `photo_type='damage'` still has no
    writer.
13. ❌ **A returning vehicle can never be checked in again** — the duplicate-VIN
    guard matches archived and shipped rows.
14. ❌ **Arrival and check-in remain two unlinked systems** —
    `shop_inbound.fleet_checkin_id` has no writer in either direction, so
    vehicles read "overdue, expected but not arrived" while sitting in the shop.
15. ❌ **A stuck vehicle notifies nobody for 48 hours**, and **nothing notifies
    anyone when a vehicle arrives**.
16. ❌ **CNI notification vacuum** — invites, bids, declines and photo denials
    all reach nobody, while the portal tells installers they will be notified.

### Later — the builds, not the patches

17. ❌ **Parts ordering and receiving** — still no software at all: no PO from
    the readiness card, no purchase request, and no receiving flow.
18. ❌ **The credit application black hole** — an unauthenticated, unrate-limited
    public write path for EINs and bank references that nothing in the app
    reads, while the customer is promised an answer in 2-3 business days.
19. ❌ **R2 objects are world-readable.** A gated download route exists and
    internal pages use it, but the bucket is public and `createSignedUrl` is a
    no-op. _High risk, owner decision: going private breaks images in every
    customer email already sent (logos, coverage diagrams, part photos), which
    cannot carry a session._
20. ❌ **The route→permission manifest** — the durable fix Part 2 called for.
    The one guard regression test still covers 7 directories and accepts an
    unguarded route.
21. ❌ **Job-level labor capture** — nothing links shifts or time entries to a
    vehicle, so actual install hours versus the estimate stay unknowable on the
    job the whole app exists to invoice.

**How to read the ❌ items:** each was verified open at `0c48f1f` with
`file:line` evidence. Items 3-8 have fix designs that survived adversarial
review; the five marked _owner decision_ are blocked on a judgement call where
both answers are defensible and guessing wrong disrupts real work.

## Appendix — the sixteen source reports

Each stage above is backed by a full report with `file:line` evidence, a
features-used inventory, a bugs list, and improvement suggestions with effort
estimates. The slices were: intake, estimate, approval, salesorder, graphicsjob,
installguide, checkin, install, completion, upfit3d, cni (walkthrough); roleaudit,
apiguard, comms, deadends (audit); plus a completeness critique that verified the
high-severity claims and surfaced the payroll/PO-hub/schedule gaps.
