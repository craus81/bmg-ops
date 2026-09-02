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
| **Round 2** — re-verified 2026-08-28 (Part 6) | ⚠️ partial | A fresh code-level re-verification of all 118 findings: 32 fixed, 65 open, 21 partial. Roadmap items **1–8 are shipped** (#679, #680, #682, #683, #684, #685, #686) — including a CRITICAL this document never had (self-service privilege escalation, migration 233). Four owner decisions were taken 2026-08-28 and built; only the R2-goes-private call is still open. **Items 19 and 21 remain open** (2 — R2-goes-private, labor capture). Shipped 2026-08-30: the Stage 1 build-out (#701–#704, closing item 18), the two Stage 1 owner decisions (#706 lead tier, #707 deletion→NetSuite), and estimate integrity (#708–#710, items 9–11). Shipped 2026-08-30: the whole **vehicle custody** block (#712–#715, items 12–16). Shipped 2026-08-30 (second wave): **parts ordering & receiving** (#717–#719, item 17 — the audit's largest build: request queue → NetSuite PO → receiving with item receipts) and the **route→permission manifest** (#721, item 20 — all 251 routes declare + prove their guard; the sweep fixed the unauthenticated Google OAuth pair). |

| **Round 3** — re-audit 2026-08-30 (Part 7) | 🔄 roadmap open | Nine-probe re-verification at `1ea2015`, every MAJOR+ finding re-verified by hand. **Round 2 holds** — all 19 ships confirmed at HEAD (5 partial caveats). ~90 new findings distilled into the Part 7 roadmap: 6 CRITICAL truncation bugs that move money/state, 8 E-SIGN forgery/loss holes, 7 non-idempotent NetSuite money paths (zero unique-index backing), 3 custody/CNI blockers — one, CNI company invites, failing 500 in production since #715 — the `forceChannels` no-op, and this week's parts-loop regressions (hotfixed same day, #724). Items 19 and 21 now carry written decision packages (the R2-flip tier checklist, the labor-capture touch-map). Shipped 2026-08-31: **Stage 2 closed** — the estimate correctness set (#726) and E-SIGN hardening (#727, migration 242) retire R3-6, R3-7, and every remaining Stage 2 walkthrough finding, and #729 ships the R3-17 change-order core (Duplicate + duplicate-as-revision with `supersedes_estimate_id` lineage, migration 243) — Stage 2 closed outright. **R3-1 closed in full** (#732 the six CRITICALs with fail-closed reads, #733 the MAJOR sweep) — every §7.2.2 truncation finding fixed. **Stage 3 closed** (#735 wrap-quote reconciliation + honest win counting + visible provenance, #736 customer reminders w/ migration 244) — all six capture-side findings shipped. **Stage 4 closed** (#740 atomic conversion claim + vendor-PO sync honesty, #741 schema-cache hardening after the live SO1064 stranding that #738/#739 repaired in parallel with migration 246 + a manual SO link) — the earlier findings were verified already fixed at HEAD (N2 phase 1 auto-project, item 9 staff walls, item 10 estimate closing, 17A–C ordering) and the dead-list re-verdicted. **Stage 5 closed** (#746 + migration 247: graphics_jobs UPDATE wall, presigned proof artwork, pre-invoice packing list; fan-out/transition-rules/proof-gate verified already shipped) — roll-nesting for production stays as the stage's one open enhancement. **Stage 6 closed** (#751 + migration 248: guide links w/ auto-stamp on attach, the CNI completion photo gate, scale-change recalibration with px_source provenance, the verification modal's 📐 guide link, super_admin walls; the inverted checklist was already fixed) — a full CNI checklist stays as its open enhancement, and the app-wide requireAdmin-excludes-super_admin question is flagged for an owner call. **Stage 7 closed** 2026-09-01 (#756 + migration 249: `POST /api/checkins` is the one writer with photos verified in storage before the row exists and the table's INSERT policies dropped — Round 3 caveat 12; arrival back-link + dedupe walk VIN → SO → unique customer and upfit rows carry SO identifiers — caveat 14; and the VIN→SO prefill the docs promised finally exists) — #712/#713/#714 held; R3-10's remainder (per-visit links, profileRoles, scans gate, auto-archive) stays with Stage 8. **Stage 8 closed** 2026-09-02 (#759 + migration 250: the completion gate moves to the DB — a 233-style trigger denies signed-in clients writing status/lane/QC, closing the route-only bypass; roles[]-aware admin override; scans allowlist; per-visit `?visit=` pick-list links; daily auto-archive of week-old shipped visits; Message Customer admin-only, ending the installer dead-end) — R3-10 shipped in full across the two custody closes; #650/#632/#634/#635/#638/#663 re-verified at HEAD; R3-21 labor capture stays the stage's open decision-package build. **Stage 9 closed** 2026-09-02 (#761 + migration 251: the invoice money paths get the claim/checked-stamp/never-falsy discipline — create-invoice refuses re-billing without an explicit tranche flag, graphics + parts-mail claims, the `created-id-unknown` sentinel keeps every already-created guard armed; invoice-vehicles always stamps billed scans; ar-payment-sync matches internal ids and backfills tranids; billing asks fall back to all admins and fire on picked_up/installed too; finance admitted to /invoices, ending the bounce-alert dead-end; dead scanPhotos deleted) — R3-8's invoice half shipped; the estimates/push, create-customer and promote-prospect paths ride with R3-9/R3-16, unique netsuite_*_id indexes stay open (blind index builds could brick deploys on existing dupes); R3-14's build half (per-SO invoices, a send step, a never-invoiced tile) is the stage's open build. **Stage 10 closed** 2026-09-02 (#763 + migration 252: the shop sees the approved 3D layout — the project's Linked Records resolves the design through the shared estimate id, snapshot for every role + designer link for configurator holders; a confirmed Cancel action finally reaches 228's release-on-cancel; unplaced parts get an undoable remove in the Review card; and `upfit_designs`' USING(true) read — the stage's own CRITICAL class, recreated on a post-224 table — is staff-only) — API walls/auto-project/allocation trigger held at HEAD; per-SKU meshes, trade packages and the magic-link viewer stay Part 4's build tier. **CNI subsystem closed** 2026-09-02 (#765 + migration 253: R3-2 in full — reviewers see the photos they judge via the credentialed download route, denials are re-reviewable and closure counts the newest photo per vin+type so a reshoot un-bricks the payout, `photos_approved` is route-maintained, installers get thumbnails; invites/bids writes close at the DB with the mark-seen stamp routed and scoped; R3-15's writeback flips the source check-in's graphics lane on VIN completion) — the notification lifecycle, 226's job walls, the invoice-flow kill (231) and the outsource bridge (232) all held at HEAD; the CNI task checklist stays the section's open build. Every Part 1 walkthrough section is now closed. **Shipped 2026-09-02 (post-Part-1):** the **estimate change-request reply path** (#767 — a rejected estimate's change request opens as a seeded customer thread in the comms inbox via "Reply to customer", and the rejection alert reliably emails the sales targets with Reply-To pointed at the customer, so a plain mail-client reply reaches them; the inbox's estimate context now links back to the estimate) and **R3-4 in full** (#768 — the `forceChannels` no-op fixed: explicit channels intersect with user preferences and force is the real bypass, all 38 force sites triaged to 11 justified keeps; `getCniStaffIds` scoped to `cni_admin` feature holders with an all-admins fallback; per-VIN CNI photo fan-out collapsed to one ping per review batch). |

Per-item status is tagged inline in Part 5 below; Part 6 carries the Round 2 verification and roadmap; Part 7 carries Round 3.

---

# Part 1 — The walkthrough, stage by stage

## Stage 1 — The phone rings: lead → customer record

**Role: sales.** The CRM is genuinely deep: one-step customer creation with an
instant NetSuite push and local mirror, business-card scanning (Claude vision),
a deals pipeline, AI voice-note logging, statements with A/R aging, and a rich
single-surface customer record. A "Create + Start Estimate" button takes a phone
lead straight to the estimate builder.

**What breaks at the edges:** _(All four findings below were built and
merged 2026-08-30 — #701 reminders, #702 credit application, #703 duplicate
guard, #704 phone intake; the two design leftovers followed the same day
as #706 lead tier and #707 deletion propagation. Annotations inline.)_

- ✅ **CRITICAL — The credit application is a black hole.** The public
  `/credit-application` form writes rows into `credit_applications` (EINs, bank
  references) that **nothing in the app ever reads** — no review queue, no API,
  no notification. The customer is promised review "within 2–3 business days" by
  a workflow that does not exist. The migration's `status`/`reviewed_by`/
  `review_notes` columns are dead. Staff can't even send a customer the form URL
  from inside the app. _(Fixed: #702 — hardened public submit route
  (trusted-IP rate limit + global ceiling + honeypot, service-role write,
  migration 237 made the table service-role-only), reviewer notifications,
  the gated review queue at /admin/credit-applications working every dead
  column, review-time prospect linking, and a "Credit App" send flow on the
  record page per the email standard.)_
- ✅ **MAJOR — Phone-intake basics are missing.** No lead-source field on the
  *create* form (it's edit-only, with an odd hardcoded option list), **no
  phone-number search anywhere** (the first thing you'd do with caller ID), no
  structured "what do they want" capture — a combined upfit+graphics inquiry
  can't be represented (single deal `type`), so it all lives in free-text notes
  and gets re-typed into the estimate later. _(Fixed: #704 — caller-ID search
  across prospect/contact/NetSuite-mirror phones in any stored format
  (migrations 238/239 phone_digits), lead source on the create form from a
  shared vocabulary, and an "Interested in" chip row that starts one deal per
  selected type — upfit+graphics is two deals.)_
- ✅ **MAJOR — Follow-up reminders never notify.** Manual and AI-voice-note
  reminders are written and displayed but **no cron fires them** — they surface
  only if someone happens to open the record or the Schedule page. The roadmap
  flagged this a year ago. _(Fixed: #701 — daily /api/cron/prospect-reminder-check
  sweep, migration 236 notified_at dedupe, admin fallback for creator-less
  voice-note rows, 30-day stale guard so the first run doesn't blast a year
  of backlog.)_
- ✅ **MAJOR — Duplicate guard is exact-name-only**, client-side, and inconsistent
  across the four customer-create paths; phone/email are never checked. Every
  inquiry instantly becomes a NetSuite customer (no lead tier), and deleting a
  linked record only deletes the CRM row — it resurrects on the next sync.
  _(Guard fixed: #703 — one shared server-side checker (normalized name +
  email + phone digits, prospects AND the customers mirror, migration 238)
  wired into all four create paths with an explicit force override. The two
  design conversations were then decided by the owner 2026-08-30 and built
  the same day: the **lead tier** (#706 — a record without `netsuite_id` IS
  a lead, promoted explicitly from its record page or automatically when its
  first estimate is pushed/converted; no schema change) and the
  **delete/resurrect asymmetry** (#707 — deleting a linked record deletes
  the NetSuite customer, falling back to deactivation when NetSuite refuses;
  both syncs filter `isinactive='F'`, so nothing flows back; admin-gated per
  the #680 precedent). This bullet is now fully closed.)_

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

**What breaks:** _(every finding below is now closed — see the Stage 2
status note at the end of this section)_

- ✅ **CRITICAL — `GET /api/estimates` leaks live approval tokens to every staff
  role.** The list is `select('*')`, which includes `approval_token`. Any staff
  member can read it, open the customer's magic link, and **forge an
  acceptance** — the E-SIGN record the sales-order gate trusts.
  _(Fixed: `stripApprovalSecrets` strips tokens from every list/read; Round 3
  found the same forge vector reopened through send-for-approval's response
  echoing the live link — closed 2026-08-31, #727: the token is never echoed
  to staff, and delivery always goes through email/SMS.)_
- ✅ **CRITICAL — All estimate APIs are `requireStaff` only.** Shop/field techs and
  finance can delete (including the NetSuite copy), rewrite prices, push, and
  email any estimate to a customer — despite the admin/sales-only UI.
  _(Fixed 2026-08-30, #708 — item 9: all nine routes gated
  `requireFeature('estimates')`, held under Round 3 re-verification, pinned by
  the #721 manifest.)_
- ✅ **MAJOR — No revision lock and no versioning.** An `accepted` estimate stays
  fully editable in the main upsert, and the customer's still-live approval link
  renders the *current* rows, not what was emailed. Someone can edit after
  sending; the customer approves something different, silently. No duplicate/
  clone, no templates, no version stamp.
  _(Fixed in three layers: the Save lock (2026-08-28, admin override + audit),
  its coverage extended to Delete (#726) and add-wrap-quote (#727), and the
  edit-during-approval window closed by the send-time content hash — the
  accept route refuses when items/prices no longer match what was sent
  (migration 242, #727). Duplicate-as-revision shipped in #729 — the lock's
  "start a new estimate" now has a one-click escape hatch (R3-17).)_
- ✅ **MAJOR — The graphics-job prompt misses the two main graphics paths.** The
  "Spawn graphics job" panel only fires off part-backed graphics-catalog lines;
  wrap-quote-fold lines and quick-graphics lines don't trip it — so a combined
  upfit+graphics estimate can reach a sales order **with no graphics job and no
  prompt**.
  _(Fixed in two halves: `isGraphicsLine` learned the wrap-fold and
  quick-graphics markers, and #726 made it a WALL — convert-to-so 409s when
  graphics lines have no linked graphics job, with a deliberate "Convert
  anyway" confirm; the shared predicate lives in `src/lib/graphics-lines.ts`
  so panel and gate can't drift.)_
- ✅ **Bugs:** deleting a pushed estimate *always* fails (the internal NetSuite-
  delete fetch forwards no auth → 401 every time); "Add Graphics" silently
  demotes a `pushed` estimate back to `draft`; push vs convert-to-SO resolve the
  labor item by `LIKE '%LABOR%'` first-match, so the same estimate can bill labor
  to different NetSuite items (including "Graphics Install Labor").
  _(Fixed: the delete 401 in #660, the demotion in #661, and the labor split —
  the last surviving Round 1 finding — in #726: one deterministic
  `resolveLaborItemId()` shared by push and convert.)_

**Stage 2 status (2026-08-31): CLOSED.** Every finding above plus the Round 3
additions against this stage (§7.2.3's eight E-SIGN holes, §7.2.8's estimate
quick set) shipped in #726 (correctness: labor resolver, qty-0 honesty,
checked line inserts, delete lock, resend/rejection, graphics gate) and #727
(E-SIGN: token echo, server-held agreement text, send-time content hash,
add-wrap-quote lock, oversized-snapshot delivery). The last enhancement —
duplicate-as-revision / change orders (roadmap R3-17) — shipped in #729
(2026-08-31): nothing remains open against this stage.

## Stage 3 — Sending for approval & capturing it

**Role: sales → customer.** The *send* side is the app's best-built stage: full
compliance with the customer-email compose standard, a zero-side-effect live
preview, rotating 30-day magic-link tokens, one shared renderer for
email/page/snapshot, delivery + bounce tracking, and correct deep-linked
notifications to the sales team on accept/decline. The customer sees the real
estimate document (line photos, product links, vinyl/graphics blocks, E-SIGN
checkbox), and acceptance freezes a hashed signed snapshot.

**What breaks — the capture side:**

- ✅ **CRITICAL — The estimate stays fully editable during and after approval**
  (see Stage 2), and the live approval page shows current rows, not what was
  emailed. No lock, no "document changed since sent" guard, no re-approval.
  _(Fixed with Stage 2's closure: the revision lock (Save 2026-08-28, Delete
  #726, add-wrap-quote #727) and the send-time content hash — the accept
  route refuses when the document no longer matches what was sent
  (migration 242, #727).)_
- ✅ **MAJOR — The signed E-SIGN snapshot is write-only.** It's saved with a SHA
  hash but **no viewer, download, or verification exists anywhere** — in a
  dispute you're spelunking R2 by hand.
  _(Fixed: item 11's viewer with a bytes-vs-hash integrity verdict, #727's
  presigned delivery for oversized snapshots, and #735's provenance panel.)_
- ✅ **MAJOR — Rejection reasons and approval provenance vanish from the UI.** The
  reason is pushed once in a notification, then *destroyed* on resend; "when/how
  did they approve" is never shown in-app.
  _(Fixed in halves: #726 archives the objection to internal notes on resend;
  #735 shows the decision in the builder — declined banner with the
  customer's reason and date, approved chip with when/via — and the
  signed-document viewer now displays the full provenance captured at
  acceptance: channel, target, IP, browser, time on page.)_
- ✅ **MAJOR — Resend bookkeeping only handles draft→sent.** A resent *rejected*
  estimate keeps status `rejected` (drops out of the whole follow-up system); a
  `pushed` estimate is pre-counted as **won** in sales-performance before the
  customer decides.
  _(Fixed: #726 reopens rejected estimates on resend; #735 makes won require
  the customer's word — accepted status or a recorded approval — so pushed
  merely means "mirrored to NetSuite".)_
- ✅ **MAJOR — `/api/graphics/from-estimate` is `requireAuth`** — a customer or
  installer account can flip any estimate to `accepted`. And approving the
  estimate never reconciles the linked wrap quote, so the combined job keeps
  nagging reps and mis-books reporting.
  _(Fixed: item 9 moved the route to `requireStaff` (manifest-pinned by #721);
  #735 adds `wrap-quote-reconcile` — folded quotes follow the estimate's
  fate on accept/reject and reopen with a resend, and sales-performance
  excludes folded quotes so the win isn't double-booked.)_
- ✅ **MAJOR — No customer-facing reminders for stale estimates** (proofs get
  auto-resend ×3 + escalation; estimates rely on the rep remembering).
  _(Fixed: #736 + migration 244 — the daily followup cron emails the original
  approval recipients after 3 quiet days (×3, live token reused, bounces
  tracked), escalates internally at 7+ days weekly, and honors rep-set
  deferrals and logged manual follow-ups so nobody is double-pestered.)_

**Stage 3 status (2026-08-31): CLOSED.** The send side was already the app's
best-built stage; the capture side's one CRITICAL and five MAJORs above are
all shipped — #726/#727 (with Stage 2), #735 (reconciliation, honest win
counting, visible provenance), and #736 (customer reminders). Nothing
remains open against this stage.

## Stage 4 — Sales order, NetSuite, and ordering the parts

**Role: sales/admin.** The convert-to-SO step is well-gated (`customer_approved`
+ admin override with a recorded reason + audit log). The parts machinery
downstream — **Parts Readiness** (live need vs reserved vs free vs on-order with
a clear verdict), allocations with safe caps, vendor-PO sync, an hourly ETA
email scan with a review queue, and one-click vendor bills — is genuinely
strong.

**But the chain between them is held together by humans:**

- ✅ **CRITICAL — Converting an estimate creates nothing downstream.** No upfit
  project, no graphics job. The user must go create the project by hand and
  **re-type the SO number the app just generated** into a lookup box before any
  readiness math is reachable. (Roadmap N2 phase 1, still unbuilt.)
  _(Fixed since: N2 phase 1 landed — convert-to-so finds-or-creates the upfit
  project with the SO number stamped (migration 225's unique index guards the
  race), and #726's graphics wall refuses conversion when graphics lines have
  no linked job. Nothing is re-typed by hand.)_
- ~~**CRITICAL — "Order the upfit parts" has no software at all.**~~ **Fixed
  2026-08-30 (#717–#719, Round 2 item 17):** short readiness rows now carry an
  Order button that raises purchase requests into a vendor-grouped queue at
  `/admin/purchasing`; admins turn a group into a **real NetSuite PO** from the
  queue (immediately mirrored locally, so readiness flips to "on order" without
  the 2-hour wait); and `/admin/receiving` checks arrivals in, posting the
  NetSuite item receipt — with a manual-entry worklist when the transform can't
  run. Requesters are notified at ordered and at arrived.
- ✅ **MAJOR — NetSuite sync failures are invisible to the people who act on the
  data.** System Health is super-admin-only by default; per-row sync errors are
  silently `continue`d; a degraded `quantityshiprecv` fallback zeroes received
  quantities with no flag — and stale on-order data then drives scheduling
  verdicts.
  _(Fixed: System Health is admin-visible; #740 makes the degraded fallback
  carry each PO's previous received quantities forward instead of zeroing
  them, and counts both the degradation and header-upsert failures (with
  samples) into the sync heartbeat — a stale mirror is now a visible
  condition.)_
- ✅ **MAJOR — Convert-to-SO isn't idempotent.** The post-create write-back is
  unchecked and there's no lock, so a failed write or a double-click makes a
  **second real SO in NetSuite**. Pushed NS estimates are left open forever
  (`createdfrom` NULL), permanently degrading the SO↔estimate matcher.
  _(Fixed in layers: the Round 2 work made the write-back conditional and
  checked (first-writer-wins, duplicates loudly reported) and item 10 closes
  pushed NS estimates; #740 + migration 245 add the atomic conversion claim
  so the second request turns away BEFORE a duplicate SO exists (R3-8's
  flagship path); #741 hardens the claim against PostgREST schema-cache lag
  after the real SO1064 stranding, which #739 + migration 246 repaired,
  adding a manual SO link for strandings.)_
- ✅ **MAJOR — Upfit-project APIs are `requireAuth` + `.passthrough()`** —
  customer/installer accounts can read, arbitrarily edit, or **delete** any
  project.
  _(Fixed: item 9 moved all five upfit-project routes to `requireStaff`,
  manifest-pinned by #721 — customer/installer accounts are out. The
  `.passthrough()` body remains, now behind the staff wall.)_
- **Dead:** the `netsuite_sales_orders` mirror is synced every 2h and rendered
  nowhere; `SalesOrderPdf` + its route are orphaned; the parts-ETA→project
  propagation keys on a column no UI ever writes.
  _(Re-verdicts 2026-08-31: `SalesOrderPdf` was already removed; the SO
  mirror now feeds item 10's `closeConvertedEstimates` sweep — no longer
  dead; and #718's PO stamp writes `netsuite_vendor_po_number` on projects,
  lighting up the parts-ETA propagation this note said no UI ever fed.)_

**Stage 4 status (2026-08-31): CLOSED.** The conversion chain now runs
gate → claim → SO → checked stamp → NS-estimate close → auto project, the
parts machinery (17A/B/C) covers order-through-receive, sync degradation is
visible, and the upfit APIs are staff-walled. Nothing remains open against
this stage.

## Stage 5 — Graphics production (design → proof → print → pack)

**Role: graphics_production.** The most complete slice: a solid board with
metrics and stage-age/proof-age flags, a full job record, and a **genuinely good
proof-approval loop** (compose → magic link → hashed E-SIGN snapshot → auto-
reminders → escalation). Four intake paths (wizard, PO, estimate, wrap quote)
all converge on one pipeline.

**But the pipeline itself is honor-system:**

- ✅ **CRITICAL — The "New Graphics Job" notification fan-out is dead.** It reads
  other users' `notification_preferences` from the browser, but RLS is
  own-rows-only, so the target list is always empty and `notify_new_job` never
  sends. Nobody is told when a job is created.
  _(Fixed since: creation now calls the server-side `notify-assignees` route
  (kind `created`), which resolves the audience by role — the browser never
  reads other users' preferences.)_
- ✅ **CRITICAL — No status state machine, and RLS lets every staff role update or
  *delete* graphics jobs.** The record page renders a flat button row — any
  status jumps to any status in either direction — and the "admin-only Delete"
  is JSX-only; the DB allows any internal staff to delete. A sales rep opening a
  notification link can flip a job from Designing straight to Shipped.
  _(Fixed in layers: `src/lib/graphics-status.ts` (2026-08-28, owner decision)
  encodes the floor's real rules — forward skips free, backward moves require
  a typed reason landing in the status history; migration 234 made delete
  admin/super_admin at the DB with a drift-safe pg_policies sweep; and #746 +
  migration 247 close the last gap, tightening UPDATE to
  admin/super_admin/graphics_production so the client-side rules can't be
  bypassed from a non-graphics console.)_
- ✅ **MAJOR — Printing is never gated on proof approval.** A rejected or never-sent
  proof can move to `printing` with zero warning — defeating the entire point of
  the E-SIGN loop.
  _(Fixed 2026-08-28: `proofGateApplies` — entering `printing` without
  `customer_approved` takes an admin plus a recorded reason, matching the
  convert-to-SO override pattern; jobs already past printing aren't re-gated
  so a late approval can't strand work. Migration 247 backs it server-side.)_
- ✅ **MAJOR — The packing stage has no packing list.** The packing-list PDF only
  renders *after* an invoice exists, and there's no pick/pack checklist. A packer
  at the `packing` stage of a not-yet-invoiced job has nothing.
  _(Fixed: #746 — `GET /api/graphics/packing-list` renders a printable
  pick/pack sheet from the job + material log (checkbox rows, description,
  ship-to, packed-by sign-off), invoice-free; the job page header carries the
  button.)_
- **MAJOR — Roll-nesting never reaches production.** The excellent RollNesting
  component is wrap-quote-only; production jobs get a flattened text summary and
  the material log is manual, inventory-blind typing.
  _(Remaining enhancement — the stage's one build-scale item, same posture
  R3-17 held for Stage 2 until pulled. Porting RollNesting into production
  jobs' material planning is scoped in the Round 3 roadmap's build tier.)_
- ✅ **MAJOR — Proof files are served from public R2 URLs** — the token gates the
  *page*, not the *artwork*.
  _(Fixed: #746 — the customer proof page and estimate approval page mint
  1-hour presigned links per load. Two deliberate exceptions: approval-email
  image embeds stay public (mail clients fetch days later, beyond presign
  life) and signed snapshots never depended on URLs (artwork is inlined as
  data URIs).)_

**Stage 5 status (2026-08-31): CLOSED** — every correctness/security finding
shipped (fan-out, transition rules + DB walls via 234/247, the proof gate,
presigned artwork, the pre-invoice packing list). One enhancement remains
open by design: roll-nesting for production jobs.

## Stage 6 — The graphics install guide

**Role: graphics_production/admin → installer.** Authoring is surprisingly
strong: a full dimension editor at `/graphics/install-guides` with PDF import,
auto/manual calibration, a branded PDF export, a "dimensioned proof" rebuild,
and email/attach-to-CNI-job delivery.

**But the guide is an orphan, and its audience isn't gated:**

- ✅ **CRITICAL — The guide has no link to the job, vehicle, or CNI job.** Customer
  and vehicle are free text; nothing references the guide from `graphics_jobs`,
  `fleet_checkins`, or `cni_jobs`. Finding "the guide for this Transit" means
  eyeballing a flat list.
  _(Fixed: #751 + migration 248 — first-class `graphics_job_id` /
  `cni_job_id` / `fleet_checkin_id` links, editor link selects, and the
  existing attach-PDF-to-CNI-job flow stamps the link automatically:
  attaching IS the linkage moment.)_
- ✅ **CRITICAL — CNI installers — the guide's actual audience — have no checklist
  and no photo gate at completion.** The guide's own text promises "photos of
  each side" and "deviations may be redone at the installer's expense," but the
  system enforces none of it on CNI jobs (checklists instantiate only onto
  in-shop check-ins).
  _(Photo gate fixed: #751 — with a guide linked to the job, `complete-vin`
  refuses until the vehicle's install photos are submitted (the existing
  submit-photos flow); admins completing on an installer's behalf pass.
  Remaining enhancement: a full CNI task **checklist** — build-scale, same
  posture as roll-nesting for Stage 5.)_
- ✅ **MAJOR — Checklist category selection is inverted** (detailed under Stage 8):
  upfit-only vehicles get the *mixed* template and are blocked on a required
  graphics task that has no meaning for them.
  _(Verified already fixed: the shared `install-checklist.ts` lookup replaced
  the inverted order-by with exact-category-first + mixed fallback for both
  routes.)_
- ✅ **MAJOR — Stale calibration:** changing a guide's template scale after PDF
  import silently skews every exported dimension, and the export footer prints
  the new scale next to numbers computed from the old one.
  _(Fixed: #751 — committing a scale change recalibrates scale-derived pages
  to the new scale and reports the count; manual calibrations (traced length
  / DPI — scale-independent) are never touched, with legacy pages recognized
  by the old scale's import constant. Pages carry `px_source` provenance
  going forward.)_
- ✅ **MAJOR — The in-shop tech verifying "Graphics applied per proof" never sees
  the dimensioned guide** — the completion modal shows the raw proof only.
  _(Fixed: #751 — the tracking modal links the dimensioned guide (📐) beside
  the raw proof, resolved via the vehicle's graphics job or check-in link.)_
- ✅ **MAJOR — Install guides bypass the feature system** (raw role flags), and a
  pure `super_admin` account is locked out of them in both UI and RLS.
  _(Fixed: #751 + migration 248 — the RLS role array and both pages' gates
  add super_admin. Flagged for an owner decision, not changed here:
  `requireAdmin`/`isAdmin` test only the literal `admin` role APP-WIDE, so a
  pure super_admin is refused by every requireAdmin route — the newer
  DB policies (233/234/248) already treat super_admin ⊇ admin.)_

**Stage 6 status (2026-08-31): CLOSED** — links, the completion photo gate,
recalibration, verification-modal access, and the super_admin walls all
shipped in #751/migration 248; the inverted checklist was already fixed.
One enhancement remains open by design: a full CNI install checklist.

## Stage 7 — Vehicle arrives: check-in with photos

**Role: shop_tech.** The check-in wizard (VIN → Sales Order → Proof) is the
best-built UI in the stage: barcode + partial-VIN scanning, NHTSA decode with an
offline fallback, multi-SO linking, cloning, and a good "graphics needed"
hand-off. But the physical arrival — the moment custody and liability transfer —
is unprotected and unlinked.

- ✅ **CRITICAL — "Photograph BEFORE we take possession" is policy, not software.**
  Photos are explicitly optional: no required angles, no minimum count, no
  odometer, **no damage capture** (`photo_type='damage'` has no writer anywhere,
  so the timeline's "Issues" section is dead code). For a liability dispute, the
  system happily produces check-ins with zero photographic evidence.
  _(Fixed in two layers: #713 made ≥1 condition photo + a damage-note rule the
  wizard's law and gave `photo_type='damage'` its first writer; Round 3's
  caveat 12 — the gate was browser-only, "no check-in API route and no DB
  constraint" — closed 2026-09-01, #756 + migration 249: photos upload BEFORE
  the save under a client-generated id, `POST /api/checkins` verifies the
  objects exist in storage (HEAD, paths pinned to the id) and is now the only
  writer — the table's INSERT policies are dropped, so a browser console
  can't create a photo-less check-in either.)_
- ✅ **CRITICAL — Arrival and check-in are two unlinked systems.** "Mark Arrived"
  on the arrival board writes `shop_inbound.status='arrived'` and *nothing else*
  — no check-in, `fleet_checkin_id` written by no code — while check-in never
  closes the expected row. Two buttons for one physical event; vehicles show
  "overdue — expected but not arrived" while sitting in the shop.
  _(Fixed: #714's arrival brain links both directions; Round 3's caveat 14 —
  back-link and dedupe matched VIN only, which no graphics/upfit/manual row
  carries — closed by #756: both walk the same VIN → SO number → unique-
  customer ladder as the forward link, upfit rows now carry their project's
  SO id/number, and the wizard writes its multi-SO join rows before calling
  the brain so secondary SOs match too.)_
- ✅ **CRITICAL — A returning vehicle can never be checked in again.** The
  duplicate-VIN guard matches archived/shipped rows with no re-check-in path.
  Fleet vans come back; the only workaround destroys the prior job's history.
  _(Fixed 2026-08-30, #712 — active-custody-only guard, returning-vehicle
  banner; held under Round 3. #756 re-enforces the same rule server-side in
  the new check-in route, where a second tab can't race it.)_
- ✅ **MAJOR — No notification when a vehicle arrives** — not to the customer
  ("we've got your van"), not to sales, not to the assigned installer.
  _(Fixed 2026-08-30, #714 — every arrival notifies admins in-app; push is
  reserved for EXPECTED vehicles; same-day board-arrival + check-in dedupe
  to one ping — a dedupe #756 extends beyond VIN.)_
- ✅ **MAJOR — RLS hole:** the never-dropped 001-era permissive policies let *any*
  authenticated account (customer role included) read the whole shop board and
  update any check-in; `/api/vehicles/[vin]/photos` is `requireAuth`, so any
  login can enumerate any vehicle's photos and captions.
  _(Fixed in halves long since: #634 dropped the 001-era policies and rebuilt
  `fleet_checkins`/`vehicle_status_history` staff-only (migration 224), and
  the photos route is `requireStaff`, pinned by the #721 manifest. Migration
  249 tightens further: INSERT now has no browser path at all.)_
- ✅ **MAJOR — No VIN→SO auto-match** despite the VIN being on the SO and estimate
  — the docs promise a pre-fill that doesn't exist, forcing double entry on every
  multi-van drop-off.
  _(Fixed: #756 — the wizard's literal `// Pre-fill customer search if we
  find a matching sales order by VIN` comment finally has code behind it:
  decoding a VIN whose estimate converted to an SO prefills the customer,
  runs the search, pre-selects the matched SO, and banners the result;
  Clone / same-customer flows keep their own context.)_

**Stage 7 status (2026-09-01): CLOSED** — the custody gate is server-enforced
(#756 + migration 249), arrival↔check-in links match VIN → SO → unique
customer in both directions, the VIN→SO prefill exists, and the ships
from #712/#713/#714 held under re-verification. Adjacent items deliberately
left for Stage 8 / R3-10's remainder: per-visit deep links, `profileRoles`
in update-status, the scans role gate, and auto-archiving shipped visits.

## Stage 8 — Performing the upfit + graphics install

**Role: shop_tech / field_tech.** The In-Shop board and the completion ceremony
(gated on photos + required tasks + the graphics-install lane, with mentions and
a stuck-vehicle cron) are genuinely strong. But the role model is **inverted for
this stage:**

- ✅ **CRITICAL — The two roles built to install can't run the install.**
  `field_tech` has no In-Shop access at all; both `field_tech` and `shop_tech`
  are bounced off the pick-list install runner and the assignment picker — while
  the external CNI `installer` role passes every gate.
  _(Fixed: #650 (Round 1 item 19) — techs run the pick-list by role, external
  installers gain no internal surface; re-verified at HEAD 2026-09-02.)_
- ✅ **CRITICAL — The status APIs are `requireAuth`-only.** Any approved account
  (customer included) can flip any vehicle's status and trigger "your vehicle is
  ready"/"shipped" customer emails, or mark graphics lanes complete.
  _(Fixed: the #632 sweep moved them to `requireStaff`, pinned by the #721
  manifest; #759 + migration 250 go further — see the gate bullet below.)_
- ✅ **CRITICAL — RLS counts external CNI installers as internal staff** with full
  CRUD on `fleet_checkins`, `estimates`, `customers`, `purchase_orders` from the
  browser client.
  _(Fixed: #634/migration 224 — `is_internal_staff()` is a real staff
  allowlist; installer and customer are out. Held under Round 3.)_
- ✅ **MAJOR — `received → complete` bypasses the entire completion gate** — no
  photos, no checklist, no QC stamp, no notifications.
  _(Fixed in layers: #635 made every transition into `complete` run the full
  ceremony, instantiating the checklist on demand; Round 3 found the gate was
  route-level only — a direct browser status write skipped it — closed
  2026-09-02, #759 + migration 250: a BEFORE UPDATE trigger (233's shape)
  denies signed-in clients changing `status`, the graphics lane, or the QC
  stamps; the routes (service role) are the only writers. The same PR makes
  the admin force-override read `roles[]`, so an admin granted via the array
  can actually override.)_
- **MAJOR — No job-level labor capture.** Nothing links time entries or shifts to
  a vehicle, so actual install hours vs. the estimate are unknowable — on a job
  the whole app exists to invoice.
  _(Open by design — R3-21, the stage's build-tier item. The decision package
  is written (the `work_shifts` touch-map: `fleet_checkin_id` + `'shop'`
  context, rate resolution, pick-list start/stop); it awaits the owner's go,
  same posture roll-nesting holds for Stage 5.)_
- ✅ **MAJOR — Assignment is split-brained:** the picker writes `job_assignments`,
  but the board card, the stuck-alert cron, and notify-ready all read
  `fleet_checkins.assigned_to`, which nothing writes.
  _(Fixed: #638 — jobs/assign mirrors the first assignee onto `assigned_to`
  (and re-mirrors on unassign); re-verified at HEAD 2026-09-02.)_
- ✅ **MAJOR — Checklist template selection inverted** (pure-upfit vehicles get the
  mixed template with a required graphics task); **"Message Customer"
  dead-ends** for shop_tech/installer (thread created, then bounced to /home);
  **marking a vehicle stuck notifies nobody for 48h**.
  _(Three verdicts: the inversion fixed in #635 (shared exact-category-first
  lookup, re-verdicted with Stage 6); the dead-end was STILL live for
  installers — the button created a thread in /admin/inbox, whose gate then
  bounced them — closed by #759: the button is admin-only, and CNI installers
  coordinate through their job chat, which notifies coordinators; the 48h
  stuck floor stands as designed — the daily sweep exists and works.)_
- ✅ **Bug:** the migration-092 trigger never writes graphics history on the success
  path and writes a bogus row for cancelled jobs.
  _(Fixed: #663, migration 229 — captures the prior status before the update.)_

**Stage 8 status (2026-09-02): CLOSED** — the completion gate is enforced at
the DB (#759 + migration 250), the role gates match their intent (scans
allowlist, roles[]-aware override, admin-only Message Customer), per-visit
deep links pin pick-list notifications to the exact visit, and the In-Shop
board finally empties itself (daily auto-archive of 7-day-old shipped
visits) — with #650/#632/#634/#635/#638/#663 all re-verified at HEAD. One
build remains open by design: R3-21 job-level labor capture, whose written
decision package awaits the owner's call.

## Stage 9 — Completion, invoice, and getting paid

**Role: admin/shop → finance.** Where it's finished, the completion→invoice→email
pipeline is strong: photo/checklist gates, a verify-before-create invoice review
modal, an all-or-nothing invoice emailer with delivery tracking and bounce
alerts, and a scan-to-invoice batch path with an over-billing gate. **But the
money loop never closes:**

- ✅ **CRITICAL — Invoice/status/notify APIs are `requireAuth`-only** — customer and
  installer accounts can create real NetSuite invoices, mark jobs invoiced, flip
  any vehicle's status, and harvest customer email/phone via the preview
  endpoints.
  _(Fixed: the #632 sweep; all five invoice writers are admin/role/staff-
  walled, pinned by the #721 manifest. Re-verified at HEAD 2026-09-02.)_
- ✅ **CRITICAL — Payment status never flows back.** `is_paid` is a hand-ticked
  checkbox on the vehicle/scan; the "awaiting payment" dashboard tile is fiction.
  The AP side has a paid-sync; the **AR side has none**, even though the data is
  already fetched elsewhere.
  _(Fixed: #639's `ar-payment-sync` runs from the netsuite-sync cron; Round 3
  found its blindspot — routes stamp the internal id when the tranid lookup
  fails, and the sync matched tranids only, so those rows could never be
  marked paid — closed 2026-09-02, #761: the sync matches internal ids too
  (tranid interpretation wins, so digit-only tranids can't false-flip) and
  backfills the real tranid once NetSuite reports it.)_
- ✅ **CRITICAL — `received → complete` skips every gate** (also Stage 8) — no
  photos, no QC, no customer notification.
  _(Closed with Stage 8: #635 made every completion run the full ceremony,
  and #759 + migration 250 enforce it at the DB.)_
- ✅ **MAJOR — The graphics billing prompt can silently reach nobody.** It fires
  only on `shipped`, client-side fire-and-forget, to admins opted into a
  preference that **defaults to false** — so with zero opt-ins it dispatches to
  an empty list. `picked_up`/`installed` jobs never prompt at all.
  _(Fixed in halves: the prompt had since moved server-side
  (`notify-shipped-invoice` + `getBillingUserIds`) with a staff-confirmed
  customer email — but the default-false opt-in intersection could still be
  empty, and only `shipped` fired. #761 closes both: an empty opt-in set
  falls back to ALL active admins (money asks always reach someone), and
  `picked_up`/`installed` exits fire the billing-only ask too.)_
- ✅ **MAJOR — Finance dead-ends everywhere.** The bounce alert deep-links finance
  users to `/invoices`, which redirects them to /home; their More menu shows
  Invoicing/Reports/Scan Log that all bounce; they can't see A/R aging at all.
  _(Fixed across rounds: #651 landed finance on Reports and fixed their
  menus; their feature set carries reports/customers (statements + aging).
  The one dead-end still live — the invoice-bounce alert sends finance to
  /invoices, whose gate bounced non-admin/sales to /home — closed by #761:
  finance is admitted; the tile deliberately stays off their nav.)_
- ✅ **MAJOR — Dead flags:** `photo_reviews` gates nothing; `deepLinks.scanPhotos`
  points at a nonexistent `/photos` page; the only partial-SO billing route is
  orphaned. **Vehicle invoicing is full-SO only, one per check-in, with no email
  step.**
  _(Three verdicts and one open build: `photo_reviews` died in #648, the
  partial-SO orphan went in the hygiene sweeps, and #761 deletes
  `scanPhotos`. The full-SO-only / no-send-step half is R3-14's build tier —
  see the status note.)_

**Stage 9 status (2026-09-02): CLOSED** — the invoice money paths carry the
claim/checked-stamp/never-falsy discipline (#761 + migration 251: create-
invoice's allowAdditional tranche gate, graphics + parts-mail claims, the
`created-id-unknown` sentinel that keeps every already-created guard armed),
AR payment sync sees internal-id-stamped invoices from both ends, billing
asks always reach someone and fire on every terminal exit, and the finance
bounce-alert dead-end is gone. Open by design: **R3-14's build half** —
per-SO invoices, an invoice send step per the customer-email standard, and
a "complete but never invoiced" tile + sweep — plus R3-22 (R2 flip), which
owns the wider payment-surface decision.

## Stage 10 — Upfit Projects & the 3D Upfit Designer

**Role: sales.** These are **not** the half-built stubs you might expect. The 3D
Upfit Designer is a complete v1 — vehicle picker → trade packages → live 3D
editor with snapping/undo/warnings → PDF → a real draft-estimate hand-off
carrying NetSuite item IDs. Upfit Projects is a working tracker with live
parts-readiness and stock reservations.

**What's broken is the connective tissue and the locks:**

- ✅ **CRITICAL — The upfit-projects API + RLS are open to any account.**
  `requireAuth` + `USING(true)` RLS means customer/installer (and even the
  anon key) can read, rewrite, and **DELETE** all projects.
  _(Fixed: item 9 moved all five routes to `requireStaff` (manifest-pinned by
  #721) and migration 224 rebuilt the projects tables staff-only; re-verified
  at HEAD 2026-09-02. Same-class hardening with the close: `upfit_designs` —
  created AFTER that fix with the same `USING(true)` read — is staff-read as
  of #763 + migration 252.)_
- ✅ **CRITICAL — Estimate→SO conversion never creates the project** (the manual
  chasm from Stage 4).
  _(Fixed: N2 phase 1 — convert-to-so find-or-creates the project keyed on
  estimate_id, migration 225's unique index guarding the race; held under
  Round 3 and hardened by Stage 4's conversion claim.)_
- ✅ **MAJOR — The 3D design dead-ends at the estimate.** There's no design link on
  the project, so the shop builds without ever seeing the approved layout.
  _(Fixed: #763 — no new schema needed: the designer's hand-off already
  stamps `upfit_designs.estimate_id` and the auto-created project carries
  the same estimate id, so the project's Linked Records resolves the design
  through that chain — layout snapshot shown to every role that can see the
  project (the shop's build reference), open-in-designer link for
  `upfit_configurator` holders so the link never bounces its audience.)_
- ✅ **MAJOR — The ship-complete DB trigger strands part allocations in
  `reserved`** — permanently shrinking free stock for every other job's readiness
  math.
  _(Fixed: #662, migration 228 — status-change trigger consumes on complete,
  releases on cancel, with the stranded-rows backfill; re-verified.)_
- ✅ **MAJOR — No UI can cancel a project** (cancellation is the only path that
  releases reservations), and unplaced (no-dimension) parts can never be removed.
  _(Fixed: #763 — the pipeline row deliberately hid the cancelled chip and
  nothing else offered it, so 228's release-on-cancel was unreachable from
  the UI: a confirmed Cancel action on the project modal closes that, and
  any pipeline click revives a cancelled project. The designer's Review card
  now carries an undoable ✕ on unplaced rows — they priced onto the quote
  but the 3D delete only reached placed items.)_

**Stage 10 status (2026-09-02): CLOSED** — the design→shop link, the cancel
affordance, unplaced-part removal, and the designs-table RLS hardening
shipped in #763 + migration 252; the API walls, auto-created project, and
allocation trigger all held at HEAD. Open by design (Part 4's build tier):
per-SKU 3D meshes, seeded trade packages, and the customer magic-link
viewer.

## The CNI (contract-installer) subsystem

**Role: installer.** The *mechanics* are mature — the pay-splits/credits/payout
engine, scan-to-Scan-Log unification, and the AP vendor-invoice flow are all
shipped. **But the coordination layer is hollow:**

- ✅ **CRITICAL — A notification vacuum across the entire lifecycle.** Invited,
  assigned, scheduled, bid, completed, photo-denied, payout approved/paid,
  chat — **none** fire a notification, and the UI falsely says "you'll be
  notified." For a workforce that's *outside the building*, the whole loop runs
  on phone calls.
  _(Fixed across two waves: #640–#646 wired assignment, schedule,
  photos-ready, job-complete, docs-complete, invoice-submitted and payouts;
  #715 closed the remainder — job invites, bids, and photo denials — with
  the invite half's production 42P10 caught and fixed in #724. Re-verified
  at HEAD 2026-09-02.)_
- ✅ **CRITICAL — RLS lets installers update any column of their jobs** from the
  browser: `pay_per_vehicle`, `invoice_status`, `netsuite_bill_id`, `status`.
  _(Fixed in halves: migration 226 made `cni_jobs` read-only for installers
  with whitelisted routes owning the status flips; the deliberately deferred
  half — `cni_job_invites`/`cni_job_bids` stayed installer-writable while
  the #715 routes soaked — closed 2026-09-02, #765 + migration 253: writes
  are service-role-only, scoped SELECTs stay, and the one legitimate browser
  write (mark invites seen) moved to /api/cni/invites-seen, stamping
  `seen_at` only on invites addressed to the caller.)_
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

**CNI subsystem status (2026-09-02): CLOSED** — the coordination layer is no
longer hollow: the full notification lifecycle fires, installer writes are
read-only at the DB on jobs AND invites/bids (#765 + migration 253), the
photo-review loop works end to end (R3-2: reviewers see the photos they
judge, denials are re-reviewable, closure counts the newest photo per
vin+type so a reshoot un-bricks the payout, `photos_approved` is
route-maintained, installers see thumbnails), and the outsource bridge runs
BOTH ways — R3-15's writeback flips the source check-in's graphics lane
when the CNI install completes. The pay/credits/payout mechanics were
always the mature part; the dimensioned-guide task checklist (Stage 6's
enhancement) remains the section's one open build.

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

_(Shipped 2026-08-30, #721: `src/lib/route-permissions.ts` declares all 251
routes and the rewritten guard test proves each file carries its declared
guard — unlisted routes, downgrades, stale entries, and undeclared bare
`requireAuth` all fail. Feature keys are typed against the same
`src/lib/features.ts` registry the UI resolves, which is the
consistency proof at the registry level. The coarse-RLS-backstop aside
remains a separate hardening idea; the sweep itself found and fixed one
live hole — the unauthenticated Google OAuth pair.)_

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
biggest ones. _(Status re-checked 2026-08-29 at `4cc8507`; ✅/❌ added then.)_

- ⚠️ **The 3D Upfit Designer → shop bridge.** The designer is already a complete v1
  that produces a priced, to-scale 3D BOM and hands it to an estimate. Of the two
  things missing when this was written, (1) auto-create the upfit project on SO
  conversion **has since shipped** in `convert-to-so`; (2) the shop-sees-the-
  layout link **shipped 2026-09-02 with Stage 10's close (#763)** — no
  `design_id` column needed: the project's Linked Records resolves the design
  through the shared estimate id and shows the layout snapshot to the whole
  shop, with an open-in-designer link for configurator holders. Still the
  build tier: per-SKU 3D meshes (the seam is
  already built: `resolveItemMesh`) and seeded trade packages would turn it into
  a real closing tool. A magic-link 3D viewer (the scene already has a read-only
  mode) would let customers see their van.
- ⚠️ **Auto-create the upfit project + parts-order queue on conversion**
  (roadmap N2) — removes the single biggest manual gap in the whole workflow.
  **The project half shipped:** `convert-to-so` now find-or-creates the
  `upfit_projects` row keyed on `estimate_id`. **The ordering software now
  exists** (item 17, #717–#719) and the readiness card feeds the purchasing
  queue; what's still manual is *raising* the requests — someone clicks the
  Order button on the card rather than conversion auto-queuing shortages.
- ✅ **In-app parts ordering & receiving** — **shipped 2026-08-30 (#717–#719)**:
  the "Request purchase" action on `short` parts, the purchasing queue that
  turns a vendor group into a real NetSuite PO, and the "Receive against PO"
  screen that posts the NetSuite item receipt — the 2-hour blind spot closed by
  immediate local mirroring in both directions. _(Was Round 2 item 17, the
  largest unbuilt thing in the workflow.)_
- ✅ **AR payment sync-back** — **shipped**: `src/lib/ar-payment-sync.ts`, run
  from the `netsuite-sync` cron, flips `fleet_checkins.is_paid` and
  `scan_logs.is_paid` from NetSuite's Paid-In-Full status, so the "awaiting
  payment" tile no longer inflates forever.
- ✅ **Signed-document viewer** — **shipped** (#710): `/signed/[type]/[id]`
  with sha256 integrity verdicts, linked from all three record surfaces.
- 🔑 **RingCentral SMS provider (`SMS_PROVIDER_ENABLED`)** — the entire SMS
  channel (approval links, pickup/complete customer texts, staff DM texts) is
  wired and still waiting behind one flag; turning it on fixes several dead
  spots at once. **This is a config decision, not a build.**
- ⚠️ **CNI lifecycle notifications + `sync-cni` calendar + a graphics→CNI job
  bridge** — **mostly shipped**: assignment, schedule proposal/accept/decline,
  photos-ready, job-complete, docs-complete and invoice-submitted all notify
  now (#640–#646), and the graphics/check-in → CNI job bridge landed in #671
  (migration 232). What is left is Round 2 item 16 — the job invite/bid loop and
  photo denials.
- ❌ **CEO dashboard plan** (~5% built) — the daily `metric_snapshots` cron is
  the time-sensitive one ("history can't be backfilled") and **still has zero
  references anywhere in the repo**; every day it stays unbuilt is a day of
  history that cannot be recovered. The RESTlet P&L/collections work is the only
  route to the owner's margin/cash metrics.
- ❌ **The customer portal's missing 5%** — its only provisioning path
  (`/api/admin/link-customer`) still has no UI (the route is its sole
  reference), so a customer login can't be set up from the app; and the portal
  shows no invoices/balances.
- ❌ **Offline scanning** — relevant if field techs scan VINs in dead zones. (The
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
3. ✅ **`/api/auth/signup` profile takeover.** _(#682.)_ Unauthenticated service-role
   upsert on a client-supplied `userId` resets any existing user to
   `status:'pending'`, `role:'installer'` — an account-lockout primitive.
   Fix designed: narrow the write rather than reject it (prove ownership
   against `auth.users`, then INSERT when no row exists, no-op when the target
   is approved/admin/deactivated, and stop writing `role`/`roles` on the
   update path). Rejecting outright risks orphaning accounts, because the
   `handle_new_user()` trigger this would rely on is defined but never
   attached to `auth.users`.
4. ✅ **AI agent reaches sensitive tables** — the sharpest edges. _(#683: credentials and approval tokens blocked for every role. Still a regex stopgap; the durable `ai_ro` view schema remains open below.)_ The per-query gate is real now
   (server-side roles, financial-table blocks, audit rows) but it is a
   *denylist* of five pay tables — so `credit_applications` (EINs, bank
   references) and `profiles` are still reachable through the chat by any
   non-customer role, including external installers. Needs an allowlist, and
   table extraction rather than a regex on the SQL string.
5. ✅ **New-graphics-job notification fan-out is dead** — the browser read
   other users' `notification_preferences`, which RLS returns empty, so the
   recipient list was always zero and no such notification had ever been
   delivered. _(#684 — moved onto `/api/graphics/notify-assignees` as a third
   `created` audience, resolved BY ROLE: graphics production + admins. The
   `notify_new_job` toggle is deliberately ignored; it defaults to true, so
   honoring it would have silently opted in everyone who ever saved Settings.)_
6. ✅ **Printing is never gated on proof approval.** _(#685 — printing without
   an approved proof is now an admin override with a recorded reason, matching
   the convert-to-SO and vehicle-completion precedents. Only the move INTO
   `printing` is gated, so a late approval can't strand a job mid-pipeline.)_
7. ✅ **Graphics status: any state to any state, from the browser.** _(#685 —
   rules in a pure tested module: forward skips free (the floor runs ahead of
   the buttons), backward moves need a typed reason into job history, and
   flagged/revision/cancelled stay free in both directions. A test asserts
   every value in `GRAPHICS_STATUS_ORDER` has a rule. Still a client-side
   gate — the durable shape is a server route fronting the write, which is
   why the rules live in a server-safe module.)_

### Next — estimate integrity

8. ✅ **No revision lock on an accepted estimate.** _(#686 — contents freeze on
   acceptance; an admin can still save with a typed reason, logged as
   `estimate_edit_after_approval` with the before/after grand total. Gated on
   `customer_approved` OR `status = 'accepted'`: `convert-to-so` and
   `graphics/from-estimate` set the status without the boolean, so a
   boolean-only check would have left exactly those estimates editable.
   Still no clone/duplicate feature, so "start a new estimate" means retyping
   — the natural companion to this lock.)_
9. ✅ **All estimate APIs are `requireStaff` only** — shop/field techs and
   finance can price, push, email and delete any estimate. _(Fixed 2026-08-30,
   #708 — all nine routes now `requireFeature(req, 'estimates')` (super_admin,
   admin, sales, graphics_production; per-user overridable). The estimates
   page URL itself was never gated — only the nav tab was — so the page and
   the approval-preview page gained `useRequireFeature`. The guard test now
   asserts the feature guard verbatim per route (`FEATURE_GATED_DIRS`), so
   the tightening can't silently regress.)_
10. ✅ **Pushed NetSuite estimates are left open forever** (`createdfrom` NULL),
    permanently degrading the SO↔estimate matcher. _(Fixed 2026-08-30, #709 —
    NetSuite derives an estimate's Document Status, so the supported write is
    probability-0 (→ Closed): `convert-to-so` closes the pushed estimate at
    conversion, and a stateless netsuite-sync sweep drains the historical
    backlog at 25 per run, keyed on NetSuite's own status. A transform rework
    (native `createdfrom`) was deliberately not attempted — it reshapes the
    money path and can't be validated offline; the matcher's memo tier
    already covers FS-created SOs.)_
11. ✅ **The signed E-SIGN snapshot is write-only** — no viewer, download, or
    verification anywhere, which is exactly what a dispute needs. _(Fixed
    2026-08-30, #710 — `/api/signed-documents` reads the snapshot from the
    private R2 prefix through credentials and re-hashes the bytes against the
    sha256 recorded at approval, so tampering reads `verified:false`; the
    `/signed/[type]/[id]` viewer shows the integrity badge, the acceptance
    timestamp, a download, and the document in a fully sandboxed iframe.
    Linked from approved estimates, accepted wrap quotes, and approved
    proofs.)_

### Soon — vehicle custody and the shop floor

12. ✅ **Check-in photos are optional, with no damage capture** — the moment
    liability transfers is unprotected, and `photo_type='damage'` still has no
    writer. _(Fixed 2026-08-30, #713 — at least one photo required before a
    check-in saves (upload stays best-effort so a flaky connection can't
    strand it), plus an amber Damage-on-Arrival section: damage photos land
    as `photo_type 'damage'` — its first writer ever — with a required
    what-and-where note folded into the check-in notes.)_
13. ✅ **A returning vehicle can never be checked in again** — the duplicate-VIN
    guard matches archived and shipped rows. _(Fixed 2026-08-30, #712 — the
    guard blocks only ACTIVE custody (`archived_at IS NULL AND status !=
    'shipped'`); terminal-only vehicles start a new visit with a
    returning-vehicle banner and the customer prefilled from last time.)_
14. ✅ **Arrival and check-in remain two unlinked systems** —
    `shop_inbound.fleet_checkin_id` has no writer in either direction, so
    vehicles read "overdue, expected but not arrived" while sitting in the shop.
    _(Fixed 2026-08-30, #714 — POST /api/shop-inbound/arrival is the one
    arrival brain: a check-in matches its expected row (VIN → SO numbers →
    unique customer) and links it; the Shop Board's Arrived button back-links
    any active check-in for the VIN. Idempotent both directions.)_
15. ✅ **A stuck vehicle notifies nobody for 48 hours**, and **nothing notifies
    anyone when a vehicle arrives**. _(Arrival half fixed 2026-08-30, #714 —
    every arrival notifies admins in-app; push fires only for EXPECTED
    vehicles (a matched Shop Board row), so routine walk-ins don't buzz
    phones. Same-day board-arrival + check-in dedupes to one ping. The 48h
    stuck-latency floor below stands as designed — the daily sweep exists
    and works.)_ _(Read this precisely: the sweep exists
    and works — `/api/cron/stuck-vehicle-check` runs daily at 14:15 UTC per
    `vercel.json`, alerts admins plus the assignee with per-recipient deep
    links, and re-alerts every 48h. The finding is the **latency floor**
    (`STUCK_HOURS = 48`, and only for `stuck_parts`/`stuck_graphics`) plus the
    arrival half, which is genuinely absent: nothing in
    `src/app/api/shop-inbound/route.ts`, `src/lib/shop-inbound.ts`, or
    `ShopArrivals.tsx` calls `notify`.)_
16. ✅ **CNI notification vacuum** — job invites, bids and photo denials reach
    nobody, while the portal tells installers they will be notified.
    _(Fixed 2026-08-30, #715 — three routes own the writes and notify
    server-side: invite-company pings the invited roster, bid pings the
    coordinators (interested with proposed start, or declined with reason),
    review-photo pings the assigned installer on denial with a reshoot deep
    link. RLS on invites/bids deliberately unchanged — the migration-226
    read-only treatment is the follow-up once the routes soak.)_
    `cni_job_invites` and `cni_job_bids` are written straight from the browser
    (`admin/cni/jobs/[id]/page.tsx:718`, `installer/available/[id]/page.tsx:117`)
    with no `notify` on either side, and the photo review screen writes
    `review_status` inline (`admin/cni/jobs/[id]/photos/page.tsx:88`) so a denial
    never reaches the installer who has to reshoot. _(Scope correction, verified
    2026-08-29: **schedule** declines are NOT in this gap — `update-schedule`
    sends `cni_schedule_declined` to the coordinator. Account invites do send a
    branded email. What is missing is the job-level invite/bid loop and the
    photo denial.)_

### Later — the builds, not the patches

17. ✅ **Parts ordering and receiving** — still no software at all: no PO from
    the readiness card, no purchase request, and no receiving flow.
    _(Fixed 2026-08-30, #717–#719, in three PRs: purchase requests from short
    readiness rows into the vendor-grouped queue at `/admin/purchasing`
    (migration 240); the queue's Create PO button placing a real NetSuite PO —
    `createPurchaseOrder()` on the proven SO POST pattern, race-proof claim on
    the request rows, immediate local mirror so readiness flips to "on order"
    instantly, and the never-written `upfit_projects` PO columns finally
    stamped; and `/admin/receiving` (migration 241) checking arrivals in while
    posting the NetSuite item receipt via the purchaseOrder→itemReceipt
    transform — every line sent explicitly so nothing defaults to
    fully-received, with a manual-entry worklist when the transform can't run.
    Requesters are notified at ordered and at arrived, deep-linked to the
    record each time.)_
18. ✅ **The credit application black hole** — an unauthenticated, unrate-limited
    public write path for EINs and bank references that nothing in the app
    reads, while the customer is promised an answer in 2-3 business days.
    _(Fixed 2026-08-30, #702, as part of the Stage 1 build-out — see the
    Stage 1 annotations. The design took three adversarial review passes
    before build; migration 237 made the table service-role-only after the
    bypass reviewer showed the staff RLS policy left EINs readable from any
    staff browser console.)_
19. ❌ **R2 objects are world-readable.** A gated download route exists and
    internal pages use it, but the bucket is public and `createSignedUrl` is a
    no-op. _High risk, owner decision: going private breaks images in every
    customer email already sent (logos, coverage diagrams, part photos), which
    cannot carry a session._ **One prerequisite has since shipped:** #688 moved
    PDF assembly off `r2PublicUrl()` onto credentialed reads, so the server no
    longer depends on the bucket being public to build its own documents — one
    fewer thing that breaks on the day the call is made.
20. ✅ **The route→permission manifest** — the durable fix Part 2 called for.
    The one guard regression test still covers 7 directories and accepts an
    unguarded route.
    _(Fixed 2026-08-30, #721: `src/lib/route-permissions.ts` maps every one
    of the 251 API routes to its required guard — staff/admin/role/feature
    plus reviewed authScoped/token/cron/webhook/public entries, each weak
    kind carrying a one-sentence why — and the rewritten test fails on
    unlisted routes, missing guard markers, stale entries, and undeclared
    bare `requireAuth`. Building it surfaced one live hole, fixed in the
    same PR: the Google OAuth connect pair was unauthenticated and its
    callback overwrites the shared `google_tokens` row; both now
    `requireStaff`.)_
21. ❌ **Job-level labor capture** — nothing links shifts or time entries to a
    vehicle, so actual install hours versus the estimate stay unknowable on the
    job the whole app exists to invoice.

**How to read the ❌ items:** each was verified open at `0c48f1f` with
`file:line` evidence, and **re-verified still open at `4cc8507` on
2026-08-29** — the evidence below is the state at that commit:

| # | Still open because |
|---|---|
| 9 | ~~Open~~ **Fixed 2026-08-30 (#708)**: all nine routes gated `requireFeature(req, 'estimates')`, the page URL gated client-side, verbatim-guard regression test added. |
| 10 | ~~Open~~ **Fixed 2026-08-30 (#709)**: probability-0 close at conversion + a capped stateless backlog sweep in the netsuite-sync cron. |
| 11 | ~~Open~~ **Fixed 2026-08-30 (#710)**: `/api/signed-documents` + the `/signed/[type]/[id]` viewer with sha256 integrity verdicts, linked from all three record surfaces. |
| 12 | ~~Open~~ **Fixed 2026-08-30 (#713)**: ≥1 photo required at save; damage photos write `photo_type 'damage'` with a required note. |
| 13 | ~~Open~~ **Fixed 2026-08-30 (#712)**: guard filters to active custody; terminal rows start a new visit with history noted. |
| 14 | ~~Open~~ **Fixed 2026-08-30 (#714)**: written from both directions by the /api/shop-inbound/arrival brain. |
| 15 | ~~Open~~ **Fixed 2026-08-30 (#714)**: arrival notifications, push reserved for expected vehicles. |
| 16 | ~~Open~~ **Fixed 2026-08-30 (#715)**: invite/bid/review-photo routes notify roster, coordinators, and installer respectively. |
| 17 | ~~Open~~ **Fixed 2026-08-30 (#717–#719)**: `/api/purchase-requests` (+ `create-po`) and `/api/po-receipts` exist, feature-gated on `parts_ordering`; the queue creates real NetSuite POs and receiving posts item receipts. |
| 18 | ~~Open~~ **Fixed 2026-08-30 (#702)**: submit moved to a hardened service-role route, review queue + notifications + audit-logged decisions shipped, RLS policies dropped (migration 237). |
| 19 | `R2_PUBLIC_URL` still backs `r2PublicUrl()` (`src/lib/r2.ts:157-160`); the bucket is unchanged. |
| 20 | ~~Open~~ **Fixed 2026-08-30 (#721)**: `route-permissions.ts` declares all 251 routes; the test fails on unlisted routes, missing declared guards, stale entries, and undeclared bare `requireAuth`. |
| 21 | `work_shifts` links to `cni_job_id` only (migration 110:56); nothing ties a shift to a `fleet_checkins` row. |

**Shipped 2026-08-28 (items 1-8):** the entire Now block plus the revision
lock — #679, #680, #682, #683, #684, #685, #686. Four owner decisions were
taken that day and built the same session: signed estimates lock with an admin
override, graphics forward-skips stay free while backward moves need a reason,
printing without an approved proof is admin-with-reason, and new-job
notifications go to the graphics team by role.

Of the five items that needed a judgement call, only **R2 going private**
(item 19) is still open — deliberately, because it breaks images in every
customer email already sent and deserves its own conversation rather than a
quick answer.

**Shipped since this part was written (2026-08-28 → 29), none of it from the
list above:** the estimate/proof merge (#699, migration 235), NetSuite's
estimate number as the headline (#696), thread emails on account history
(#695), PO import + graphics job (#694), customer tagging (#692, #693), the
staff approval preview (#691), the approval-page column fix (#690), the
double-click Send fix (#689), and #688 above.

## Appendix — the sixteen source reports

Each stage above is backed by a full report with `file:line` evidence, a
features-used inventory, a bugs list, and improvement suggestions with effort
estimates. The slices were: intake, estimate, approval, salesorder, graphicsjob,
installguide, checkin, install, completion, upfit3d, cni (walkthrough); roleaudit,
apiguard, comms, deadends (audit); plus a completeness critique that verified the
high-severity claims and surfaced the payroll/PO-hub/schedule gaps.


---

# Part 7 — Round 3: the re-audit (2026-08-30, at `1ea2015`)

**Method.** Nine parallel code probes over the tree as it stands after #722:
four re-verification passes covering every Round 2 ship, three cross-cutting
hunts (silently truncated reads, the deep-link contract, external-write
idempotence), and a fresh two-half workflow walkthrough. Probe output was then
**re-verified by hand**: every CRITICAL/BLOCKER/MAJOR below was confirmed by
reading the cited code directly; MINORs carry the probe's citation. The
`file:line` is the evidence — audit prose never is.

## 7.1 Does Round 2 hold?

Yes. All 19 shipped items (1–18, 20) verified present and working at HEAD —
the gates gate, the crons cap, the manifest covers all 251 routes exactly, the
claim in create-po serializes correctly for two different admins, the
provisional mirror converges with the 2-hourly sync. Five caveats worth
recording:

| # | Verdict | Caveat |
|---|---|---|
| 3 (dupe guard) | ⚠️ partial | The guard is real in every API create path — but the main CRM create never calls one: `admin/prospects/page.tsx:381` inserts from the browser, and its pre-flight check is swallowed by `catch {}` (`:352`). See 7.2.5. |
| 6 (deletion→NS) | ⚠️ partial | CRM records covered; but the `customers`-mirror delete is unchecked and FK-blocked by `wrap_quotes`/`fleet_checkins` (no `ON DELETE` clause), and when it *does* succeed it cascades away `customer_files` (W-9s, tax certs) without the confirm ever mentioning them. See 7.2.5. |
| 12 (photos) | ⚠️ partial | ~~The ≥1-photo and damage-note gates are browser-only. There is no check-in API route and no DB constraint — a photo-less `fleet_checkins` row inserts fine under staff RLS (`migrations/224:95`).~~ **Closed 2026-09-01 (#756 + migration 249, Stage 7's close):** `POST /api/checkins` is the one writer (photos verified in storage before the row exists) and the table's INSERT policies are dropped. |
| 14 (arrival link) | ⚠️ partial | ~~Back-link and dedupe match on VIN only, and only `sales_order` inbound rows carry a VIN (`shop-inbound.ts:146`) — graphics/upfit/manual arrivals can never link, and double-notify past the dedupe.~~ **Closed 2026-09-01 (#756):** back-link and dedupe walk VIN → SO number → unique customer, and upfit rows carry their SO identifiers. |
| 20 (manifest) | ⚠️ note | Markers are file-wide, not per HTTP method (no live gap today — all 251 files scanned method-by-method), and two `authScoped` whys oversell: `cni/bid` checks *visibility*, not membership (`bid/route.ts:65-79`), and the storage ACL is prefix-level — any approved login can write/delete under another customer's prefix (`storage-guard.ts:51`). |

## 7.2 New findings

The build waves themselves hold; the new findings cluster in the seams. In
severity order:

### 7.2.1 Shipped-this-week regressions — hotfixed same day

Round 3's first job is eating its own cooking. These are bugs in the
2026-08-30 waves, verified and fixed the same day in **#724**:

- **CNI company invites 500 on every click** — `invite-company/route.ts:44-50`
  upserts `onConflict: 'job_id,company_id'`, but the only matching unique
  index is *partial* (`WHERE company_id IS NOT NULL`, migration 111) and the
  table constraint is `(job_id, installer_id)` — Postgres can't infer the
  partial index without its predicate, which PostgREST can't send → `42P10`
  at plan time, every call. The invite half of #715 never worked in
  production. (The pre-#715 browser upsert ignored its error, which is why
  nobody saw it.)
- **The Order button can silently do nothing forever** — the readiness card
  sends a *delta* (`short − requested`, `upfit/page.tsx:932`) to a server
  that treats quantity as a *maximum* (`purchase-requests/route.ts:157`
  raises only when greater). Once the pending row exceeds the next delta,
  clicks no-op with no feedback.
- **One project's request suppresses another's** — `parts-readiness.ts:219`
  sums pending requests across ALL projects, and the card uses that as a
  per-project "already asked" test — project B renders "🛒 Requested" on the
  strength of project A's ask, and B's parts are never ordered.
- **A second submit by the same admin releases the first's in-flight PO
  claim** — `create-po`'s `releaseClaim` filters on `ordered_by = me`
  (`:90-100`), which matches exactly the rows the first request is still
  holding while it talks to NetSuite; a third attempt then double-orders.
  And `resolveDefaultLocationId()` sits outside any try/catch (`:147`) — a
  NetSuite hiccup there 500s with the claim still set, leaving rows
  permanently "being ordered" with no unclaim lever anywhere.
- **Readiness counts labor and FS-CUSTOM as short parts** — the readiness
  SuiteQL has no `itemtype` filter (`parts-readiness.ts:103-111`) while
  conversion deliberately pushes labor and custom lines as items — so every
  converted job with labor reads perpetually short, and the Order button
  will happily put `LABOR` on a real vendor PO.
- **manual_needed receipts are invisible to every over-receive guard** —
  `po-receipts` deliberately skips the mirror bump for worklist rows, but
  the open-quantity checks (server `:110-113`, client prefill) read only
  the mirror — so a part received into the worklist still shows fully open,
  inviting a double receipt.
- **Arrival pings deep-link the wrong board** — the common no-check-in
  branch sends `/upfit` (`arrival/route.ts:170`); the arrivals board lives
  on `/tracking`.
- **Denied CNI photos: the reshoot notifies nobody** — `submit-photos`
  short-circuits on `photos_submitted` (`:62-64`) and `review-photo` never
  resets it on deny; the denial link also lands one page short of the
  review UI.
- Smaller: `parts_ordered_date` overwritten on stamped projects; the
  "last vendor" enrichment sorts an arbitrary unordered 400-row slice
  (`purchase-requests/route.ts:119`); status H mislabeled "closed".

### 7.2.2 CRITICAL — truncation that silently moves money or state _(all closed 2026-08-31 — #732 CRITICALs, #733 MAJOR sweep)_

PostgREST caps every read at 1000 rows (`.limit(N>1000)` does not lift it).
Six reads where that cap changes money or writes wrong state:

1. **Duplicate PO imports** — `gmail/search-pos/route.ts:45-48`: the
   "already imported" set is a bare unpaginated read of `purchase_orders`
   (already past 1000 rows); missing POs re-import as duplicates with
   duplicate line items and graphics jobs.
2. **Scan matching starves** — `scan-match.ts:106-117`: open POs + all
   their lines read unbounded; truncated lines make scans unmatchable and
   inflate "waiting on PO", non-deterministically.
3. **POs flipped `complete` with unreceived lines** —
   `scan-match.ts:53-63` (`recomputePoFulfillment`): a PO whose lines are
   partially truncated has all *surviving* lines satisfied → wrong state
   written to the DB.
4. **The billing sweep never reaches POs past the cap** —
   `po-invoice-verify.ts:211-218`: unpaginated whole-book select (with
   embedded line items burning the row budget faster); POs past the cap
   keep stale `invoice_check_status` forever, deterministically.
5. **The monthly accountant package under-sums** —
   `reports/accounting-package/route.ts:68-88`: `.limit(1000/2000/10000)`
   all cap at 1000; totals and CSVs silently drop rows.
6. **Duplicate installer pay** — `cni/import-scans/route.ts:57-58`: the
   org-wide "already imported" VIN set is unbounded; past 1000 links, the
   same VIN imports twice → duplicate `install_credits`.

Behind these, ~15 MAJOR truncation findings (at-risk snapshot, weekly digest,
quote nudges, sales-performance and graphics/installer-cost reports, the
wrap-quote "already converted" map, `backfillCniJobPayout`, the parts pages'
missing `.order('id')` tiebreaker on non-unique `item_number`, prospects
sync loops with `range()` and **no order at all**) — the full list lives in
the Round 3 roadmap below.

### 7.2.3 The E-SIGN record can be forged, altered, or lost _(all eight closed 2026-08-31 — #726/#727, migration 242)_

Eight verified holes in the approval/signature chain items 9–11 built on:

1. **Staff can forge a customer acceptance** — `send-for-approval` returns
   the live token/URL to the caller (`:358-364`) and the UI displays it in
   an alert (`estimates/page.tsx:1651`) — defeating `stripApprovalSecrets`,
   whose comment names this exact threat. Any estimates-feature user can
   open the customer's page and click Accept; the convert gate opens with
   no override, no audit row.
2. **The "signed" sentence is client-supplied** — the approve route accepts
   `agreementText` (≤2000 chars) and freezes it verbatim into the snapshot
   (`approve/estimate/[token]/route.ts:31,165`); it never compares against
   the canonical text. A link-holder can accept with "received for review
   only; no commitment" as the assented sentence — hash-verified green.
   Same in proof and quote approvals.
3. **The heaviest evidence is unviewable** — snapshots inline proof images
   at up to 4 MB *per asset* (`estimate-graphics.ts:173,205`) but the
   viewer read caps at 5 MB total (`signed-documents/route.ts:58`) → the
   disputes with the most photos 502 forever, with no download fallback.
4. **`add-wrap-quote` bypasses the revision lock entirely** — zero
   approval/SO checks in the route; it rewrites lines and totals on any
   estimate id, signed and converted ones included.
5. **Save can silently wipe every line** — `estimates/route.ts:297` deletes
   all lines, then the re-insert's error is discarded on both paths
   (`:315`, `:392`) and the handler returns success.
6. **Quantity 0 becomes quantity 1 in NetSuite** — stored lines use
   `parseFloat(l.quantity || 1)` while the totals lib uses `|| 0`: a
   "$0 / included" qty-0 line totals to nothing on the signed document and
   bills one full unit on the pushed estimate and SO.
7. **An accepted/converted estimate can be deleted outright** — the DELETE
   handler has the feature gate and nothing else; deleting destroys the
   only row holding `signed_document_storage_path` (orphaning the snapshot)
   and the SO↔project `estimate_id` link, unaudited.
8. **Linking a graphics job freezes a draft** — `from-estimate`'s
   `markEstimateWon` writes `status:'accepted'` on any linked estimate; the
   revision lock keys on exactly that, so a never-sent quote becomes
   uneditable.

Plus the structural gap: **the edit-during-approval window** — while a link
is live, lines remain editable and both the approval page and snapshot read
current rows; nothing captures a send-time content hash, so what the
customer saw and what got frozen can differ.

### 7.2.4 Money paths: one good idempotence pattern, used exactly once

`create-po`'s claim → 409 → release-on-failure → success-after-NetSuite shape
exists nowhere else. Verified consequences:

- ✅ `netsuite/create-invoice` **re-bills the same installed units on every
  POST** — nothing consumes or checks anything (`:161-170`, `:220-240`).
  _(Closed 2026-09-02, #761 + migration 251 with Stage 9's close:
  already-invoiced POs refuse without an explicit allowAdditional tranche
  flag, and an atomic claim turns a concurrent double-POST away first.)_
- ✅ `graphics/create-invoice` and `netsuite/create-sales-order` stamp
  **falsy ids** when NetSuite's Location header can't be parsed — which
  defeats their own truthy guards on the next click → duplicates. Both
  stamps are unchecked; both guards are check-then-act.
  _(Closed 2026-09-02, #761: a visible `created-id-unknown` sentinel
  replaces every falsy stamp so the guards stay armed, both stamps are
  checked and loud, and the graphics path adds the claim for its
  check-then-act race.)_
- `estimates/push` shows "pushed!" while the unchecked write-back can fail →
  the next push takes the CREATE branch → guaranteed duplicate NS estimate.
- ✅ `netsuite/invoice-vehicles` gates ALL bookkeeping on a truthy
  `invoiceNumber` (`:310`) — a successful invoice whose tranid lookup
  failed leaves the scans looking un-invoiced and re-billable.
  _(Closed 2026-09-02, #761: billed scans are always stamped, with an
  internal-id fallback the AR sync now resolves.)_
- `wrap-quote/create-customer` returns **502 "create failed" on a
  successful create** whose id didn't parse (`:77-79`) — the textbook
  retry-to-duplicate invitation.
- ✅ `parts-mail/create-bill` stamps `billed` **unchecked** after the bill
  exists (`:54-60`) — a failed stamp leaves the invoice re-billable.
  _(Closed 2026-09-02, #761: claimed, checked, and a failed stamp reports
  success with a loud warning while the claim blocks a re-bill.)_
- `promote-prospect` is a read-then-write race: two concurrent pushes of
  the same lead mint two NetSuite customers (`promote-prospect.ts:59,86`).
- **No unique index backs any of it**: `netsuite_so_id`,
  `netsuite_estimate_id`, `netsuite_invoice_id`, `netsuite_bill_id`,
  `netsuite_vendor_id` — none are unique columns anywhere.

### 7.2.5 CRM lifecycle

- The main CRM create (`admin/prospects/page.tsx:381`) and `addToCrm`
  (`[id]/page.tsx:512`) insert from the browser, bypassing the server dupe
  guard entirely (its pre-flight is `catch {}`-swallowed).
- `PUT /api/prospects` is `.passthrough()` + `requireStaff`, no audit: any
  staff can re-point `netsuite_id` at an arbitrary NetSuite customer — and
  the delete path then hard-deletes *that* NetSuite record.
- Deleting a customer: the mirror delete is unchecked and FK-blocked by
  `wrap_quotes`/`fleet_checkins` (stale mirror resurrects the record); when
  it succeeds, `customer_files` (W-9s, tax certs) cascade away unmentioned.
- The credit-app reviewer's "candidate matches" honors `*` as a wildcard
  (`[id]/route.ts:37` strips `%_,()` but not `*`) — a hostile submitter
  steers which real customers appear as link candidates. The per-IP rate
  limit also fails open when no IP header is present.

### 7.2.6 Custody & CNI

- ✅ **The photo reviewer QCs blind** — the review page builds every image URL
  as `/api/storage/view?…` (`photos/page.tsx:135-138`), a route that does
  not exist; `onError` hides the img, so reviewers see grey boxes with
  Approve/Deny buttons. The installer side renders no thumbnails at all.
  _(Closed 2026-09-02, #765 with the CNI close: photos serve through the
  credentialed download route (both storage_path shapes handled), a failed
  load says so in red, and the installer page gets thumbnails.)_
- ✅ **One denied photo bricks the job** — closure requires `denied === 0`
  (`[id]/page.tsx:1650`) but review buttons render only on `pending`
  (`photos/page.tsx:288`); no un-deny, no photo delete exists → permanent
  `completed_pending_review`, payout blocked.
  _(Closed 2026-09-02, #765: verdicts render on every photo for re-review,
  and the closure stats count the NEWEST photo per vin+type — an approved
  reshoot supersedes the denied original.)_
- ✅ `photos_approved` is written only by a browser-side bulk loop; the
  route-level per-photo path never sets it.
  _(Closed 2026-09-02, #765: every verdict and the new route-side bulk mode
  recompute the flag from the newest-per-type set.)_
- ✅ `update-status`'s admin force-override reads the scalar `role` only —
  an admin whose grant lives in `roles[]` can't override; and the
  completion gate is route-level only (a direct browser status write
  bypasses photos/tasks/QC entirely).
  _(Both closed 2026-09-02, #759 + migration 250 with Stage 8's close: the
  override reads roles[], and a DB trigger denies signed-in clients writing
  status / the graphics lane / QC stamps at all.)_
- ✅ The scans in-route gate rejects only customer-ONLY accounts —
  `['customer','executive']` or a bare `executive` passes and can log
  scans and mint pay credits (`scans/log/route.ts:56`).
  _(Closed 2026-09-02, #759: scans/log and scans/photos gate on an
  internal-staff-or-installer allowlist.)_
- ✅ Post-#712, VIN-keyed surfaces (pick-list, `/api/vehicles/[vin]/photos`,
  `pickList` deep links) resolve to the *newest* visit — links about the
  old visit open the new one; no per-visit link exists.
  _(Closed 2026-09-02, #759: `pickList(vin, checkinId)` pins the visit via
  `?visit=`, the page banners when a newer check-in exists, and
  update-status / mentions / `vehicleLinkFor` all pass the id.)_
- ✅ The In-Shop board never empties (nothing auto-archives; archive is
  admin-only), so returning vehicles now double-list.
  _(Closed 2026-09-02, #759: a daily cron archives vehicles 7+ days past
  their shipped transition, history-timestamped.)_

### 7.2.7 Notifications & deep links

- ✅ **`forceChannels` is a no-op** — `notify.ts:64`'s condition reduces to
  `!channels`: ANY caller passing explicit channels bypasses user
  preferences (38 of 63 call sites do). Combined with per-VIN fan-out in
  the CNI loop (`submit-photos` pushes+emails every admin per VIN), a
  30-VIN job = 30 pushes + 30 emails to every admin, preferences ignored.
  _(Closed 2026-09-02, #768 — R3-4: explicit channels are now the event's
  ceiling intersected with the user's preferences; forceChannels is the
  real bypass, kept by exactly 11 sites (money-out, delivery-failure and
  system-health alarms, plus the four external-installer CNI sends whose
  audience has no preference rows) with the rationale commented at each;
  the other 27 respect preferences. submit-photos pings only when a
  submission lands on an empty review queue, so a 30-VIN trickle is one
  ping. The un-silenceable type list is the exported ALWAYS_ALL_CHANNELS.)_
- ✅ CNI notify audiences are "every admin" (`getCniStaffIds`) while the
  routes themselves gate on the narrower `cni_admin` feature; and
  super_admin membership differs between call sites.
  _(Closed 2026-09-02, #768 — `getCniStaffIds` resolves holders of the
  `cni_admin` feature via the same `resolveFeatures` the console gates on,
  covering super_admins consistently and honoring grants/revokes, with an
  all-admins fallback so a coordination alert can never dead-end; my-docs
  switched to the helper too.)_
- Four broken deep-link contracts: CNI chat mentions store the *sender's*
  portal path (cross-portal recipients bounce; no `cniJobLinkFor` exists);
  "graphics ready" sends shop/field techs to a page that ejects them;
  customer-thread reply emails CTA to the bare app origin instead of
  `customerPortal()`; `deepLinks.scanPhotos` targets a route that doesn't
  exist. Thirteen more sites hand-build correct URLs outside the builders.

### 7.2.8 Assorted sharp edges (selected)

Estimate resend erases the rejection while `status='rejected'` keeps it out
of every follow-up queue; two different labor-item resolvers
(`'%LABOR%'` vs `'LABOR%'`) can bill the same job's labor to different GL
items; `pushed_by` is client-asserted; the estimates list API and
`AddToEstimateModal` read the newest-1000 only; the receiving page downloads
the entire PO mirror history per interaction; ~~`vehicle-tracking/invoice`
stamps the internal id when tranid lookup fails, so AR sync can never mark
it paid~~ _(✅ closed 2026-09-02, #761 — the AR sync resolves internal ids
and backfills the tranid)_; four dead `r2PublicUrl` imports.

## 7.3 The Round 3 roadmap

### Now — verified bugs, small fixes

1. **R3-1 · The truncation set** — fix all six CRITICALs (7.2.2) with
   `fetchAllRows` + tiebreakers; add the `.order('id')` tiebreaker to
   `parts/page.tsx` / `parts-cache` / `ar-payment-sync`; give the
   prospects sync loops an ORDER BY. Then sweep the MAJOR list.
   _(✅ Shipped 2026-08-31 in two halves: #732 — the six CRITICALs, with
   chunked `.in()` lists and fail-closed error paths so a failed read
   can't masquerade as an empty result — and #733, the MAJOR sweep
   (digest, nudges + deferral set, sales-performance, graphics/installer
   costs, at-risk, the wrap-quote converted map, `backfillJobCredits`).)_
2. **R3-2 · CNI photo review** — point images at `storageDownloadUrl`;
   allow re-review of non-pending photos (count newest per vin+type);
   installer thumbnails; fold bulk-approve into the route.
   _(✅ Shipped 2026-09-02 in full, #765 with the CNI section's close.)_
3. **R3-3 · This week's regressions** — the 7.2.1 hotfix (shipping now).
4. **R3-4 · notify repair** — fix the `forceChannels` condition; scope CNI
   audiences to `cni_admin`; collapse per-VIN events into per-job digests
   (the `po-billing-notify` threshold pattern).
   _(✅ Shipped 2026-09-02, #768: explicit channels intersect with user
   preferences and force is the real bypass — all 38 force sites triaged,
   11 kept with rationale (money-out, delivery-failure, system-health
   alarms; external-installer CNI sends), 27 now preference-respecting;
   `getCniStaffIds` resolves `cni_admin` feature holders with an
   all-admins fallback; per-VIN photo pings collapse to
   empty-review-queue-only, which beats a digest — one ping per batch,
   zero storage.)_
5. **R3-5 · Deep links** — `cniJobLinkFor` per-recipient; widen the
   ready-for-install gate or send per-audience URLs; `customerPortal()` on
   thread replies; delete `scanPhotos`; migrate the 13 hand-built strings.
6. **R3-6 · Estimate quick set** — `|| 0` quantity consistency; check the
   line re-insert errors; resend sets `status='sent'` and preserves
   rejection history; one configured labor item; `pushed_by` from auth;
   uuid-validate GET ids. _(✅ Shipped 2026-08-31, #726 — plus the
   graphics-line gate at conversion and the Delete revision lock.)_

### Next — integrity programs

7. **R3-7 · E-SIGN hardening** — server-held agreement text; stop echoing
   the token to staff (or audit-log link opens); fix the 5 MB read cap vs
   4 MB assets; extend the revision lock to `add-wrap-quote` and DELETE;
   decouple `markEstimateWon` from the lock; capture a send-time content
   hash to close the edit-during-approval window; conditional accept.
   _(✅ Shipped 2026-08-31, #727 + migration 242; the DELETE lock and
   `markEstimateWon` decoupling rode #726.)_
8. **R3-8 · Money-path idempotence** — unique indexes on every
   `netsuite_*_id` column; roll the create-po claim/checked-stamp pattern
   across the seven paths in 7.2.4; a written policy for
   success-with-unparseable-id (never report failure, never stamp falsy).
   _(⚠️ The invoice/bill half shipped 2026-09-02 with Stage 9's close,
   #761 + migration 251 — create-invoice, graphics/create-invoice,
   parts-mail/create-bill claimed with checked, never-falsy stamps;
   invoice-vehicles and create-sales-order follow the same policy; the
   `created-id-unknown` sentinel IS the written policy in practice.
   Still open: estimates/push (Stage 2's write-back), wrap-quote/
   create-customer's 502-on-success, promote-prospect's race (both with
   R3-9/R3-16), and the unique netsuite_*_id indexes — deliberately not
   attempted blind from a session container, since existing production
   duplicates would fail the index build and block every deploy.)_
9. **R3-9 · CRM lifecycle** — route the CRM creates through
   `POST /api/prospects`; drop `.passthrough()` and make `netsuite_id`
   admin-only + audited; decide the deletion policy for files/mirror
   (checked deletes, honest confirm); escape `*`; rate-limit fail-closed.
10. **R3-10 · Custody hardening** — ✅ **shipped in full** across the two
    custody stage closes:
    a server-side check-in route that enforces photos
    _(2026-09-01, #756 + migration 249)_;
    per-visit deep links (pick-list by check-in id),
    `profileRoles` in update-status, the scans role gate tightened to a
    staff-or-installer allowlist, and auto-archive of shipped visits off
    the board _(2026-09-02, #759 + migration 250 — which also puts the
    completion gate itself at the DB)_.

### Later — the workflow builds

11. **R3-11 · Projects for PO-driven SOs** — the find-or-create block from
    convert-to-so, in `create-sales-order` + the SO sync (kills the last
    SO-number re-type).
12. **R3-12 · Readiness that pushes** — compute at conversion (+ one-click
    request shorts), a daily aging sweep over pending requests, verdicts on
    the schedule board, ETA-change notifications, multi-PO project links.
13. **R3-13 · Receiving → allocation** — auto-reserve received quantities
    to the requesting project.
14. **R3-14 · Completion→invoice** — widen the gate off requireAdmin,
    per-SO invoices, a send step, and a "complete but never invoiced"
    tile + sweep for vehicles.
15. **R3-15 · CNI writeback** — VIN completion flips the linked check-in's
    graphics lane (closes the one-way bridge).
    _(✅ Shipped 2026-09-02, #765 — VIN-matched against the source
    check-in, idempotent, with 092's trigger carrying 'installed' onto the
    matched graphics job.)_
16. **R3-16 · Promote carries everything** — contacts + notes to NetSuite
    on promote; estimate↔lead link by id, not name.
17. **R3-17 · Change orders** — duplicate-as-revision with
    `supersedes_estimate_id`; surface `expiration_date`; customer-facing
    estimate status in the portal. _(✅ Core shipped 2026-08-31, #729 —
    `POST /api/estimates/[id]/duplicate` (plain copy vs revision decided
    server-side from the lock state), migration 243, lineage banners both
    directions, and the non-admin locked-save 409 now offers one-click
    "Duplicate as Revision" that carries the on-screen edits. Still open,
    cosmetic: surfacing status/expiration to the customer portal.)_
18. **R3-18 · Lead lifecycle** — lost/nurture outcomes with reasons, wired
    into reminders and tiles.
19. **R3-19 · The job-margin report** — parts cost (receipts/bills) +
    labor (once R3-21 lands) against the invoice, per vehicle; cycle-time
    and damage-volume reports from data that already exists.
20. **R3-20 · Floor ergonomics** — graphics lane on the pick-list;
    pickup-path billing prompt; purchasing/receiving count badges.

### Carried decisions

21. **R3-21 (= item 21) · Job-level labor capture** — the touch-map is now
    written: migration (add `fleet_checkin_id` + `'shop'` context to
    `work_shifts`, relax both CHECKs), the shifts routes' context enums and
    rate resolution, `ensureCniShift`/`getOpenCniShift` generalization,
    `CompletionRef` accepting a check-in, and start/stop on the pick-list.
    The browser-only `time_entries` day-clock stays a separate system or
    gets absorbed.
22. **R3-22 (= item 19) · R2 goes private** — the flip checklist is now
    written, tiered: (A) 13 client `<img>` surfaces off `getPublicUrl()`
    — the fallback `/api/storage` path can't authenticate an `<img>` tag
    reliably; (B) token-scoped proxies for the sessionless approval pages
    and PDF assembly inputs; (C) the irreversible part — images inside
    already-sent emails — which is the actual owner decision; (D) two easy
    internal swaps; (E) a `public_url` **column** on prospect files that
    needs a backfill; (F) four dead imports to delete now. #688 already
    moved server-side PDF assembly onto credentialed reads.

**Reading the numbers:** Round 2 shipped 19 of 21 and every ship held.
Round 3's ~90 findings are narrower but sharper: almost everything above is
a seam *between* working systems — a guard that lives client-side, a read
that silently truncates, a stamp that isn't checked, a link that lands one
page short. The Now column is a week of small fixes; Next is where the
audit's remaining risk actually lives.
