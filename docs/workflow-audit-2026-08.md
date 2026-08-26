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
(Part 4), and a prioritized fix roadmap (Part 5).

---

## How to read the severity tags

- **CRITICAL** — data loss, money error, security hole, or a workflow dead-end
  that stops the job. Fix before it bites.
- **MAJOR** — real friction, silent failure, or double-entry that will cause
  field bugs and wrong numbers.
- **MINOR** — polish, naming, hygiene, edge cases.

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
- **CRITICAL — Two competing company-mode invoice flows** exist; the closure
  checklist only recognizes the dead legacy one, so a company using the modern AP
  flow leaves its jobs permanently unclosable.
- **MAJOR — No bridge from graphics/check-in to a CNI job** — outsourcing an
  install means re-typing everything and losing the pay/photo/billing machinery
  unless the crew happens to scan the right part.

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
- **Offline scanning** — a finished IndexedDB queue (`offline-db.ts`) that was
  never wired to the scanner; relevant if field techs scan VINs in dead zones.

---

# Part 5 — Prioritized fix roadmap

### Now — security & data-loss (small, high-leverage)

1. `/api/search` → `requireStaff` and scope/drop the messages group.
2. Storage API → bucket allowlist + record-scoped path check; drop
   arbitrary GET/DELETE.
3. Drop the 001-era `fleet_checkins`/`vehicle_status_history` permissive
   policies **and** change `is_internal_staff()` to a real staff allowlist.
4. Add the `deactivated` check to `requireAuth`; add `requireSuperAdmin` and use
   it in `create-user` (block admins from minting super_admins) and
   `user-settings`.
5. Delete or env-wall `/api/admin/reset-data`.
6. Strip `approval_token`/`internal_notes` from `GET /api/estimates`.
7. Make webhook signature verification fail **closed**.
8. Move the ~40 bare-`requireAuth` write/money/comms routes to
   `requireStaff`/role checks (graphics invoice/notify, vehicle-tracking,
   upfit-projects, jobs/assign, customer-threads, messages/send-sms).
9. Tighten `USING(true)` RLS on the upfit-projects tables and the CNI
   `cni_jobs` UPDATE policy (whitelist installer-writable columns).

### Next — close the workflow chain

10. **Auto-create the upfit project inside convert-to-SO** (find-or-create by
    `estimate_id`) — kills the biggest manual hop.
11. Make the graphics-job prompt fire on wrap-fold/quick-graphics lines, or
    prompt at convert-to-SO time.
12. Fix the checklist category-ordering inversion (both routes).
13. Close the `received → complete` gate bypass.
14. Wire CNI lifecycle notifications (one shared helper); kill the legacy CNI
    invoice flow; add a "Create CNI job from graphics job / check-in" bridge.
15. AR payment sync-back cron.
16. Fix the assignment split-brain (write `assigned_to`, or read
    `job_assignments` everywhere).

### Soon — the role cleanup

17. `requireFeature` server helper + one `useRequireFeature` gate per page.
18. Delete dead keys, rename `proof_hygiene`/`cni_management`, give the 10
    raw-`isAdmin` tools real keys.
19. Give `field_tech`/`shop_tech` the install surfaces; stop external installers
    passing internal gates.
20. Fix the finance and graphics dead-end menus.

### Data-integrity bugs to fix in passing

- Deleting a pushed estimate always fails (forward auth).
- "Add Graphics" demotes pushed estimates to draft (pass current status).
- Ship-complete trigger strands allocations in `reserved` (release them).
- Migration-092 trigger never writes graphics history on success.
- Payroll/pos/scans/invoices/OpsDashboard unpaginated reads (violate the repo's
  own 1000-row rule) — workers silently unpaid, billable scans hidden.
- Open Quotes tile counts only `wrap_quotes` (excludes estimate dollars).

### Hygiene — delete the dead set (~1,500 lines, zero behavior change)

Routes (`sales-order-pdf`, `invoice-pdf`, `create-invoice-direct`,
`customer-purchases`, `contacts`, `push/send`), components (`SalesOrderPdf`,
`StatusPipeline`, `SwipeToDelete`), libs (`offline-db`, `use-is-mobile`), the
orphan `/fleet/update` page, dormant tables (`dashboard_layouts`,
`customer_job_assignments`, `sales_cadences`), and the stale help docs. Add a
CI dead-code check so the next audit starts at zero.

---

## Appendix — the sixteen source reports

Each stage above is backed by a full report with `file:line` evidence, a
features-used inventory, a bugs list, and improvement suggestions with effort
estimates. The slices were: intake, estimate, approval, salesorder, graphicsjob,
installguide, checkin, install, completion, upfit3d, cni (walkthrough); roleaudit,
apiguard, comms, deadends (audit); plus a completeness critique that verified the
high-severity claims and surfaced the payroll/PO-hub/schedule gaps.
