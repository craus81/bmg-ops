# FleetSuite roadmap — working-session notes (Chris + Valarie)

**23 notes, each one traced to real code. No code written yet.**

They cluster into six workstreams: (1) what the customer actually sees on a quote —
the biggest cluster, and the one with the most half-built machinery already in place;
(2) the estimate → sales order → parts chain, which is three disconnected hops each
needing a human today; (3) job-record hygiene — save, audit, notifications; (4) a
pre-arrival "arriving" lane for vehicles that does not exist in any form; (5) sales
nudges; (6) small polish (decimals, phone masks, mentions dock).

Investigation turned up **15 live defects**, several of which are the notes themselves
in disguise — the wrap-quote notification that "goes to the screen" is a re-entry bug,
the missing Qty/Rate/Total is an email that never reads line items, and "vehicle
arrived when not received" is a button that writes a status and nothing else.
**Ship the bug list first.** It is almost entirely XS/S, it clears three of the notes
outright, and two of the bugs are silently destroying data today.

Two project rules were checked throughout: **deep links** (no notification omits a URL —
the sweep in `8212e1d` already fixed that — but 7 producers hand-build URLs where a
builder exists) and **pagination** (four unbounded reads found, one of which will make
automated parts ordering wrong).

## How to read this

Every item below carries: the note **quoted verbatim**, what it means (and whether
that's ambiguous), what the code does today with `file:line`, the concrete change, and
a size. Sizes are XS (<1h), S (half day), M (1–2 days), L (3–5 days), XL (>1 week).

Nothing here is a commitment to build. Seven items should not start until the questions
at the bottom are answered — they're marked **ASK FIRST**.

---

## Note coverage

| # | Note | Item |
|---|---|---|
| 1 | Auto format phone numbers with parentheses and dash | [X1](#x1--phone-number-formatting) |
| 2 | Send coverage pic and Netsuite quote as an option | [W1](#w1--send-options) |
| 3 | Line items not to show up but the picture to | [W2](#w2--hide-line-items-keep-the-picture) |
| 4 | Click notification about wrap quote accepted | [W3](#w3--accepted-quote-notification-destination) |
| 5 | New quote | [E1](#e1--new-quote) **ASK FIRST** |
| 6 | Graphics job square footage too many decimals | [G1](#g1--too-many-decimals) |
| 7 | Save button on graphics jobs | [G2](#g2--save-button) |
| 8 | Add mentions to top dock | [A1](#a1--mentions-in-the-top-dock) |
| 9 | Proof sent notification | [G3](#g3--proof-sent-notification) |
| 10 | Use rangers configurator as a roadmap | [N4](#n4--ranger-style-configurator) **ASK FIRST** |
| 11 | Sync to netsuite should keep you in that estimate | [E3](#e3--stay-in-the-estimate-after-sync) |
| 12 | Upload tax exempt forms | [E5](#e5--tax-exempt-forms) |
| 13 | No quantity, rate or total when sending for approval | [E2](#e2--missing-qty--rate--total) |
| 14 | Create sales order only after estimate is accepted | [N1](#n1--gate-so-creation-on-acceptance) |
| 15 | Order parts after conversion to sales order | [N2](#n2--order-parts-after-conversion) **ASK FIRST** |
| 16 | Pull sales orders from Netsuite link to estimates | [N3](#n3--pull-sales-orders-from-netsuite) |
| 17 | Once sales order is put in vehicle goes to "arriving" | [V1](#v1--arriving-in-shop) **ASK FIRST** |
| 18 | Vehicle in arrived status when not received | [V2](#v2--arrived-vs-received) |
| 19 | Expand audit log and timestamp all changes | [A2](#a2--expand-the-audit-log) |
| 20 | Combine estimates with wrap quotes | [C1](#c1--combine-estimates-with-wrap-quotes) **ASK FIRST** |
| 21 | Reminder to sales person to sell equipment, telematics, graphics | [S1](#s1--upsell-reminders) **ASK FIRST** |
| 22 | Email estimates from fleetsuite customize with fields | [E4](#e4--customizable-estimate-email) |
| 23 | Opt in to email notifications when sending any communication??? | [A3](#a3--opt-in-to-email-notifications) **ASK FIRST** |

---

## Fix first — these are live bugs

| # | Symptom | Root cause | Size |
|---|---|---|---|
| B1 | Clicking the "quote accepted" notification a second time lands on the wrap-quote screen with no modal | `src/app/(main)/admin/wrap-quote/page.tsx:357` — `handledQuoteId` is a one-shot ref; the same URL is a no-op forever after | XS |
| B2 | Saving a graphics job silently reverts customer approval, invoice ids, status, wrap/estimate links | `src/app/(main)/graphics/[id]/page.tsx:500` rest-spreads the whole row and writes back every column at page-load values | S |
| B3 | Builder total ≠ saved/emailed/NetSuite total on any labor line with qty > 1 | `src/app/(main)/estimates/page.tsx:423` multiplies `labor_hours × quantity`; `src/lib/estimate-totals.ts:13` does not | XS — **pricing, needs sign-off** |
| B4 | Saving or pushing an already-accepted estimate downgrades it to `draft`/`pushed`, destroying approval state | `src/app/(main)/estimates/page.tsx:1785` and `:539` pass a status derived from sync state, not sales state; `src/app/api/estimates/route.ts:136` writes it with no guard | XS |
| B5 | "Arrived ✓" on the Arriving widget creates no check-in and no record — the vehicle vanishes, and the flip is permanent | `src/components/ShopArrivals.tsx:96-99` writes `shop_inbound.status='arrived'` only; `shop_inbound.fleet_checkin_id` (migrations/160) is written by **no code in the repo**; `src/lib/shop-inbound.ts:63-67` never demotes an `arrived` row | M |
| B6 | Approval email shows no Qty / Rate / Total | `src/app/api/estimates/[id]/send-for-approval/route.ts:42-46` never reads `estimate_line_items`; body goes through `buildNotificationEmail`, which HTML-escapes (`src/lib/resend.ts:139`) — a line table is impossible by construction | S |
| B7 | On-order part quantities silently under-report | `src/lib/parts-readiness.ts:175-178` reads `netsuite_vendor_po_lines` with `.in(...)` and no pagination — caps at 1000 | XS |
| B8 | Wrong "days in stage" chips and wrong stuck-vehicle counts | `src/app/(main)/tracking/page.tsx:261` reads `vehicle_status_history` with `.limit(3000)`; PostgREST caps at 1000 and the code silently falls back to `created_at` | XS |
| B9 | Proof reminder sweep can truncate | `src/app/api/cron/proof-reminder-check/route.ts:42-48` — bare `.limit(500)`, no deterministic order | XS |
| B10 | Seven notification/navigation producers hand-build URLs where a `deep-links.ts` builder exists | `RecentActivity.tsx:168`, `Popout.tsx:59`, `graphics/[id]/page.tsx:487` and `:523`, `graphics/page.tsx:590`, `cron/health-check:98`, `messages/send-sms:67`, `vehicle-tracking/update-status:253` | XS |
| B11 | `api/mentions/route.ts:111` falls back to `/home` whenever `mentionSourceUrl` returns null — a dead click for any new mention surface | `src/lib/deep-links.ts:120-150` maps a fixed source list | XS |
| B12 | Tax-exempt flag never reaches NetSuite — exempt estimates push as taxable | `src/app/api/estimates/push/route.ts:370` passes `taxExempt`; the request body at `:93-101` only sends entity/item/memo | XS |
| B13 | Graphics job Content shows `47.382978723404256"` | `src/app/api/graphics/from-wrap-quote/route.ts:161` interpolates raw floats | XS |
| B14 | Estimate number collisions have no retry | `src/app/api/estimates/route.ts:51-57` generates against a UNIQUE constraint with no 23505 retry (wrap-quote already retries) | XS |
| B15 | Estimate popout from search silently returns nothing | `src/components/Popout.tsx:100-104` selects `estimates.total` — that column does not exist; it's `grand_total` | XS |

Three of these need a decision before they ship:

- **B3** raises prices on every qty>1 labor line and changes what gets pushed to NetSuite.
  `src/lib/estimate-totals.test.ts:13-21` is a *characterization* test locking today's
  behavior — changing it is deliberate, not incidental. See Question 4.
- **B4** matters more than it looks: `status` is doing double duty for sales stage and
  NetSuite sync state. Anything gating on "accepted" must key on `customer_approved`,
  not `status`. This must land **before** N1.
- **B1**'s guard is deliberate — the code comment explains that `loadAll()` refreshes
  history while `?id=` persists in the URL. Deleting the ref regresses that. The fix is
  to consume the URL with `router.replace`, not to remove the guard.

Also worth noting, not scheduled: `GET /api/estimates` (`route.ts:77-88`) is an unbounded
`select('*')` capped at 1000 and will silently truncate the list as estimates accumulate.
The wrap-quote history has the same shape at `wrap-quote/page.tsx:417` (`.limit(200)`).

---

## Wrap quotes

### W1 — send options

> "Send coverage pic and Netsuite quote as an option for wrap quotes"

**What it means.** ~90% already exists as send mode `netsuite_pdf` (coverage diagram +
attached NetSuite PDF, no body pricing). **This may be a discoverability problem, not a
missing feature — showing you the existing dropdown could close the note for zero
engineering.** The real gaps are that the dropdown label never says the picture is
included, and that `mode` is a single-select enum, so you can't mix pricing + PDF, or
coverage-only + PDF. Alternate readings: Send should be reachable from the History list
(today you must click Edit/Resend first); or "coverage pic" means the roll-nesting
layout, which is **not rendered to an image anywhere** — only the vehicle diagram is.

**Today.** Mode state at `src/app/(main)/admin/wrap-quote/page.tsx:341`, picker `<select>`
at `:2771-2776`. Server derives `pricing` and `showDiagram` from `mode` at
`src/app/api/wrap-quote/send/route.ts:43-46`; guards at `:185-190`; NetSuite PDF unshifted
as first attachment at `:289-301`. Diagram is rasterized client-side
(`page.tsx:1227 renderDiagramBlob`) and stored on `wrap_quotes.diagram_path` (migrations/131).

**Change.** Widen `SendSchema` to accept an `include` flag set (`pricing` / `lineItems` /
`diagram` / `netsuitePdf`) while still accepting the legacy `mode` string mapped to flag
sets. Derive `pricing`/`showDiagram` from flags; move the subject line (`:246`) and the
mark-as-sent rule (`:312-317`) off `mode`. Replace the select with checkboxes; pass the
same object to both preview and real send. If `netsuitePdf` is checked with no
`netsuite_estimate_id`, offer inline "create it now" instead of the current dead-end
alert at `page.tsx:1373`.

**Size.** S — but see W2; these should ship as one work item.

### W2 — hide line items, keep the picture

> "i want the Line items not to show up but i want the picture to"

**What it means.** Suppress the itemized rows on the customer-facing quote while keeping
the coverage picture and the money (at minimum the Total). Today pricing is
all-or-nothing: `coverage_only` = picture + no money + no accept button; `netsuite_pdf`
= picture + PDF + no body pricing. Neither gives "picture + total, no lines."
**The independent leak:** the acceptance page renders the full itemized table regardless
of how the email was sent.

**Today.** Three customer-facing renderers, all unconditional except the email: email body
`src/app/api/wrap-quote/send/route.ts:61-89` with the table and totals fused into one
ternary at `:128-146`; approval page `src/app/approve/quote/[token]/page.tsx:116-207`,
fed by `publicQuote()` at `src/app/api/approve/quote/[token]/route.ts:158-187` which ships
`measurements`/`labor`/`nesting` over the wire; and the **signed E-SIGN snapshot**
`renderQuoteHtml()` at `route.ts:234-335`.

**Change.** Migration **182** adds `wrap_quotes.hide_line_items BOOLEAN NOT NULL DEFAULT
false` (or a `presentation JSONB`, matching the existing `adjustments`/`nesting` pattern).
Persist it in `buildSnapshot` (`page.tsx:1120-1220`). Split the items table from the
totals table in the email. Strip line data **server-side** in `publicQuote` — don't hide
it client-side. Mirror the suppression in `renderQuoteHtml` so the frozen legal record
matches what the customer saw.

**Size.** M. Medium-high risk on exactly one point: the signed snapshot is the E-SIGN
evidence record. **All three renderers ship in one PR or none of them do.**

### W3 — accepted-quote notification destination

> "Click on notification about wrap quote accepted and go to quote job not screen"

**What it means.** Ambiguous, but one reading has a reproducible defect. **Reading A:**
the notification lands on the wrap-quote screen instead of opening the quote — that's
bug B1. **Reading B:** it should go to the graphics *job* spawned from the quote, not
the quote screen. **Reading C:** the quote if there's no job yet, the job once one exists.

**Today.** Producer `notifySalesRep()` at `src/app/api/approve/quote/[token]/route.ts:189-221`
correctly uses `deepLinks.wrapQuote(quote.id)` (`src/lib/deep-links.ts:39`), and the
destination page really does handle `?id=` (`wrap-quote/page.tsx:358-378`). The one-shot
`handledQuoteId` ref at `:357` is what breaks re-entry. **There is no graphics job at
accept time** — jobs are created manually via the History modal button at `page.tsx:2898-2905`.

Separately: `notifySalesRep` includes `customers.account_owner_id` (`route.ts:193-198`),
but the page gates on admin/sales/graphics (`wrap-quote/page.tsx:290, 1922`) — some
recipients get "You don't have access to Wrap Quotes."

**Change.** Fix the re-entry (consume the URL with `router.replace`) — that alone likely
resolves the complaint. Then, if Reading B/C: in `notifySalesRep`, look up
`graphics_jobs.wrap_quote_id` (indexed, migrations/168) and link to
`deepLinks.graphicsJob(job.id)` when one exists, else the quote. Auto-*creating* a job on
acceptance is a workflow change, not a link change — don't do it unquestioned. Sweep B10
and the access-gate mismatch in the same PR.

**Size.** S.

---

## Estimates & NetSuite

### E1 — "New quote"

> "New quote"

**ASK FIRST. Genuinely ambiguous — one word.** A create button already exists
(`src/app/(main)/estimates/page.tsx:940-945`). The concrete gap the code shows: **you
cannot start an estimate for a customer who isn't already in the synced `customers`
table** — the picker is search-only (`page.tsx:1058-1119`, `:279-290`), while wrap-quote
solved this with `POST /api/wrap-quote/create-customer` (already generic, already reused
by `CustomerPicker.tsx:79` and `GraphicsInvoiceReviewModal.tsx:242` — only its URL is
wrap-specific). Other live readings: terminology (the app says "Estimate", NetSuite says
"Quote"); a "new quote for this customer" entry point from the customer record (today
`admin/prospects/[id]/page.tsx:1394-1401` just routes to the bare list); a duplicate/clone
action (does not exist anywhere); or missing quote-document header fields (no expiration
date, customer PO, terms, ship-to, sales rep).

**Today.** `resetBuilder` at `page.tsx:809-836`; header fields limited to Customer / Title
/ Customer-facing Notes / Install Context (`:1057-1216`).

**Change.** Cheapest useful slice, in order: customer-record → `/estimates?new=1&customerId=…`
prefill; "Create new NetSuite customer" in the estimates picker reusing the wrap-quote
route; Duplicate on each list row; harden the number generator (B14). Renaming
Estimate→Quote collides with the separate wrap-quote product and should only happen if
explicitly confirmed.

**Size.** M — dominated by the risk of building the wrong thing.

### E2 — missing Qty / Rate / Total

> "there is No quantity, rate or total when sending estimate for approval…need to fix"

**What it means.** Two real defects; the note most likely means the first. **(a)** The
approval email carries no line detail at all — it is a generic dark internal-notification
card with one prose sentence and a button. **(b)** The totals themselves are wrong on
qty>1 labor lines (B3). Note the landing page at
`src/app/approve/estimate/[token]/page.tsx:128-159` *does* render Item/Qty/Rate/Total
today — so if that's the surface you were looking at, I need the estimate number.

**Today.** `src/app/api/estimates/[id]/send-for-approval/route.ts:42-46` loads only the
estimates row; body built at `:114-127` and escaped by `src/lib/resend.ts:139`. The
renderer that should be shared already exists at
`src/app/api/approve/estimate/[token]/route.ts:250-319`.

**Change.** Extract `renderEstimateHtml` into `src/lib/estimate-document.ts` (light theme,
company letterhead, modeled on wrap-quote's `buildQuoteHtml`), have the email render it
with the existing approval CTA, and read line items with `.order('sort_order').order('id')`.
Keep `buildNotificationEmail` for internal staff notices only. Fix B3 separately with
sign-off. No migration.

**Size.** S.

### E3 — stay in the estimate after sync

> "sync changes to netsuite in estimates should keep you in that estimate not bring you back to the estimates screen"

**What it means.** Unambiguous.

**Today.** `src/app/(main)/estimates/page.tsx:554-567` — on success it unconditionally runs
`loadEstimates(); resetBuilder(); setView('list')`. Secondary: `loadEstimates()` (`:270-276`)
sets the page-level `loading` flag and the page early-returns a full-screen spinner
(`:915-922`), so the builder unmounts on every Save/Push/Sync anyway. Same reset-and-leave
after convert-to-SO (`:639-641`).

**Change.** Drop the reset/navigate on the sync path (recommended: on both paths — the
NetSuite banner at `:1749-1780` re-derives state from the refreshed array automatically).
Add a silent-refresh path so the mid-session refetch doesn't trigger the full-page spinner.
Optionally swap the blocking `dialog.alert` for an inline toast. **Fix B4 in the same
function while you're there.**

**Size.** XS.

### E4 — customizable estimate email

> "Email estimates from fleetsuite customize email with fields"

**What it means.** A compose step before sending — editable recipients, subject, message
body, preview — instead of today's fire-and-forget with hardcoded copy to whatever address
the system guessed. Both patterns already exist elsewhere in the app, so this is a port.
Alternate reading: an admin-editable stored template with `{{merge_fields}}` — nothing like
it exists (no `email_templates` table anywhere) and it roughly doubles scope.

**Today.** Copy hardcoded at `send-for-approval/route.ts:110, 116-119`; recipient resolution
is invisible (`:61-81`). The schema **already accepts** `{email, phone, expiryDays}` (`:16-20`)
but the UI POSTs a literal `{}` (`src/app/(main)/estimates/page.tsx:595-599`). Precedents to
copy: `src/components/EmailInvoicesModal.tsx` (editable recipients + body + test-send), and
wrap-quote's `preview: true` dry run (`src/app/api/wrap-quote/send/route.ts:17-33`).

**Change.** Extend the schema with `cc`/`subject`/`message`/`preview`; render from the shared
`estimate-document.ts` built in E2 with the sender's message as an escaped intro block; the
preview branch must return **before** the row mutation at `route.ts:91-104` so it doesn't
mint a token or set status `sent`. Client gets a compose modal with `srcDoc` preview.
Reply-To is already correct.

**Size.** M. Depends on E2.

### E5 — tax exempt forms

> "Upload tax exempt forms"

**What it means.** Store the resale/exemption certificate against the customer and use it
to drive the estimate's tax-exempt flag. Today `tax_exempt` is a bare per-estimate checkbox
with nothing backing it — no cert, no expiry, no customer default, no audit trail for why
tax was zeroed. And it doesn't even reach NetSuite (B12).

**Today.** `estimates.tax_exempt` (migrations/021:31), ticked at
`src/app/(main)/estimates/page.tsx:1651-1665`, consumed at `src/lib/estimate-totals.ts:17`.
**There is no `tax_exempt` column on `customers`.** File storage exists only on the CRM side
— `prospect_files` (migrations/179) + `src/app/api/prospects/files/route.ts` — and **there is
no file table keyed to `customers`**; estimates reference `customers.id`, prospects are a
separate table linked only by `netsuite_id`.

**Change.** Migration **183**: `customers.tax_exempt`, `tax_exempt_cert_number`,
`tax_exempt_expires_at` (comment them FleetSuite-owned so the NetSuite sync's SET list never
clobbers them — follow migrations/080). For storage, prefer a new `customer_files` table
mirroring 179 if the cert must be visible from the estimate builder. Copy the prospects files
route. Extend `loadCustomerDefaults` (`page.tsx:654-662`) to prefill the checkbox and render
"Cert on file · exp 12/2026" or an amber warning next to it. Fix B12 while here.

**Size.** M. Main trap is the customers↔prospects split; secondary: certs carry EINs and
`prospect_files` today stores a **public** R2 URL — the cert table must be private.

### N1 — gate SO creation on acceptance

> "Create sales order only after estimate is accepted"

**What it means.** Today the causality is **inverted** — converting is what *sets*
`status='accepted'`. Most likely ask: block the convert button until the customer has
actually accepted. Alternate: auto-create the SO on acceptance.

**Today.** Button renders whenever there's a customer + lines + no SO id, with no status
condition (`src/app/(main)/estimates/page.tsx:1851-1866`); the API is `requireStaff` only
(`src/app/api/estimates/convert-to-so/route.ts:31-64`) and writes `status:'accepted'` at
`:193-200`. The real acceptance signal is `customer_approved` (migrations/082), set by the
magic-link flow at `src/app/api/approve/estimate/[token]/route.ts:155-174`. `status='accepted'`
is written by **three unrelated paths**, so gating on status is unsafe. Conversion sends
**no notification at all**.

**Change.** Server-side gate on `estimate.customer_approved`, returning a machine-readable
reason. Stop writing `status:'accepted'` on conversion. Add the missing notification with
`deepLinks.estimate(id)`. Disable the button with an explanatory tooltip rather than hiding
it. Auto-creation on acceptance should **not** be an inline NetSuite call from the public
unauthenticated approval endpoint.

**Size.** S. **Blocked by B4** — the gate is meaningless if a Save can wipe the field it
reads. Real workflow risk: many customers approve by phone/PO/email and never touch the magic
link, so an admin override is almost certainly required, not optional. See Question 5.

### N2 — order parts after conversion

> "Order parts after an estimate gets converted to sales order in fleetsuite allocation"

**ASK FIRST.** Three nested scopes hide in this note. **(1)** The real blocker: nothing
connects a converted estimate to the allocation UI — a human must hand-create an
`upfit_project` and hand-type the SO number. **(2)** Auto-compute readiness and reserve stock
on conversion. **(3)** FleetSuite actually creates the NetSuite vendor PO — **this capability
does not exist anywhere in the codebase.**

**Today.** Conversion writes the SO id onto `estimates` only (`convert-to-so/route.ts:193-200`).
Projects are created by hand (`src/app/(main)/upfit/page.tsx:580-603`) and the SO is attached
by typing a number into a lookup box (`:362-403`). Readiness math bails with `no_sales_order`
unless `upfit_projects.netsuite_so_id` is set (`src/lib/parts-readiness.ts:80-89`). Allocations
are only ever user-initiated (`src/app/api/upfit-projects/allocations/route.ts:29-47`).
**Nothing in the repo creates a NetSuite purchase order** — vendor POs are a one-way pull
(`src/lib/vendor-po-sync.ts`).

**Change.** Phase 1 (S, most of the value): find-or-create the `upfit_project` inside
convert-to-so after the NetSuite write succeeds, stamping estimate + SO ids; add a partial
unique index on `estimate_id` so re-runs can't fan out duplicates. Non-fatal on failure.
Phase 2 (S): compute readiness, optionally auto-reserve, notify with
`deepLinks.upfitProject(id)`. Phase 3 (M–L): a `parts_order_requests` queue and either a
purchasing notification or a real `createVendorPurchaseOrder`.

**Size.** M for phases 1–2; L if FleetSuite writes POs. **Fix B7 before anything automated
reads on-order quantities.** Blocker for phase 3: `netsuite_parts.vendor` holds a display
**name**, not an internal id — using it directly will 500, exactly the trap documented in
`docs/cni-vendor-bills.md`. See Question 3.

### N3 — pull sales orders from NetSuite

> "Pull sales orders from Netsuite link to estimates in fleetsuite"

**What it means.** SOs created directly in NetSuite should be pulled in and matched back to
the originating estimate. Today the linkage is push-only.

**Today.** No local sales-order table and no SO pull. `estimates.netsuite_so_id`
(migrations/067) is written by exactly one code path. The sync cron
(`src/app/api/cron/netsuite-sync/route.ts:43-412`) has no SalesOrd phase. **Key insight:**
`createSalesOrder` (`src/lib/netsuite.ts:1030-1076`) posts a standalone record instead of
using NetSuite's Estimate→SO transform, so `transaction.createdfrom` is **NULL on every
FleetSuite-created SO** — the one join key NetSuite would maintain for free. The transform
pattern is already proven for invoices at `netsuite.ts:1739`. Also unused: the SO carries a
VIN in `custbody_vin_number_`, already selected at `netsuite.ts:215` and read nowhere.

**Change.** Fix the key at the source first (switch to `salesOrder?init=estimate`), then build
`src/lib/sales-order-sync.ts` as a near-copy of `vendor-po-sync.ts` (cursor + day overlap +
`BUILTIN.DF` fallback + chunked line fetch). Migration **186** adds `netsuite_sales_orders` /
`netsuite_sales_order_lines` mirroring migrations/161. Match in strict precedence —
`createdfrom` → `otherrefnum` → memo regex → unmatched — recording `match_source`; only the
first two auto-write onto the estimate.

**Size.** M. Two honest unknowns: the transform is unverified against this integration role,
and `otherrefnum` is a free-text field reps edit by hand (it's where the customer PO number
goes) — a collision could attach an SO to the wrong estimate.

### N4 — Ranger-style configurator

> "Use rangers configurator as a roadmap to create estimates…choose from list style"

**ASK FIRST.** Two very different builds hide in "choose from list style." **(A) Light:** a
browsable, faceted catalog panel replacing the free-text search box — no new data model.
**(B) Full:** a real configurator with vehicle fitment, kits/BOMs, option groups,
compatibility rules. Assume A unless kits + fitment are explicitly wanted.

**Today.** The builder is a debounced `.limit(10)` search over `netsuite_parts`
(`src/app/(main)/estimates/page.tsx:312-325`), clicked into lines at `:370-390`. **No category
tree, no vehicle fitment, no kit/BOM, no option groups, no compatibility rules, no images.**
The parts sync already imports Kit and Assembly item types
(`src/app/api/parts/sync/route.ts:71`) but stores them flat with no component expansion.
`labor_hours` comes from one NetSuite custom field (`custitem1`) and is probably sparse.
Catalog assignment is a two-line heuristic (`:26-34`).

**Change.** Ship A first: a two-pane browser with facets from existing
`ns_class`/`ns_category`/`vendor`/`vehicle_type`, served by a paginated endpoint modeled on
`src/app/api/parts/route.ts:29-42` — **do not** load the whole catalog into the browser
(`netsuite_parts` is explicitly flagged unbounded in `CLAUDE.md`). Then B1: let a rep add a
NetSuite Kit item as one line and expand components for display only — zero new tables, real
"pick a package" UX. B2 (own tables + fitment) only if NetSuite kits are insufficient.

**Size.** L (XL for full). **The binding constraint is data, not code** — see Big rocks.

---

## Graphics

### G1 — too many decimals

> "Graphics job information square footage..too many decimals"

**What it means.** Ambiguous but cheap to cover both. **Reading A:** graphics jobs spawned
from a wrap quote get raw un-rounded inch dims baked into `content`
(`Left Side: 2x 47.382978723404256" × 92.15384615384616"`). **Reading B:** the ft² readouts
use a *money* formatter (2 decimals) — area to the hundredth of a square foot is meaningless.
Worth flagging: `/graphics/[id]` and `/graphics` contain **zero** ft² strings, so "graphics
job information" most likely means the Content block — Reading A.

**Today.** Reading A: `src/app/api/graphics/from-wrap-quote/route.ts:161`. Reading B:
`src/app/(main)/admin/wrap-quote/page.tsx:222` (`fmt`, 2dp, reused for area at 14 call sites)
plus the three quote-document renderers. Already correct and not to be touched:
`src/components/RollNesting.tsx:47` (1dp), `GraphicsMaterialsCard.tsx:144,161` and the
graphics-costs report (0dp).

**Change.** Add shared `fmtSqft`/`fmtIn` display helpers in one place; apply to the ft² call
sites and the job-content dims. **Do not** round `computeUsage`, the `totals` memo
(`page.tsx:640-724`), or `buildSnapshot` — pricing is computed from raw floats and feeds
NetSuite. Bump the `> 0.005` visibility thresholds to `> 0.05` when the formatter changes.

**Size.** XS. If you take Reading B, note it touches the same three quote renderers as W2 —
those must stay in lockstep with the signed snapshot.

### G2 — save button

> "Save button on graphics jobs"

**What it means.** The button exists, but only at the bottom of a ~20-field form — 2–3 phone
screens down — while the top action row in edit mode shows only Discard / Delete / Cancel Job.
The model is also inconsistent: status, assignees, materials, files and notes on the same page
all save instantly with no button. Alternate reading: you want autosave instead.

**Today.** Edit state `src/app/(main)/graphics/[id]/page.tsx:117`; top row `:878-910`; the only
Save at `:1154-1167`; `saveJob` at `:494-547`. No dirty state, no navigation guard —
`beforeunload`/`unsaved` returns nothing repo-wide.

**Change.** Minimum (XS): render Save in the top action row too, and make the bottom row a
sticky footer (check it against the Capacitor safe-area/tab bar). Recommended (S): also fix
B2 with an explicit 20-column allowlist, add a dirty badge + navigation guard, sweep the two
hardcoded deep links at `:487`/`:523`, and add the missing `approval_*`/invoice columns to
`GraphicsJob` in `src/lib/types.ts:526-574` so the compiler can catch the next clobber.

**Size.** S.

### G3 — proof sent notification

> "Proof sent notification"

**What it means.** Sending a proof fires **no internal notification** — the only feedback is a
`dialog.alert` seen once by whoever clicked. Approved / revision-requested / stale-7-days all
notify. Alternate reading: the *customer* isn't receiving the proof — that path works, so that
would be a contact-resolution issue instead (see below).

**Today.** `src/lib/proof-approval-send.ts:44-179` sends the customer email/SMS, patches the
job, and never imports `notify`. Templates to copy:
`src/app/api/approve/proof/[token]/route.ts:235-262` and
`src/app/api/cron/proof-reminder-check/route.ts:78-99`. `deepLinks.graphicsJob` already exists
(`src/lib/deep-links.ts:24`); `notifications.type` is free text with no CHECK constraint, so no
migration.

**Change.** Notify from the route (`src/app/api/graphics-jobs/[id]/send-for-approval/route.ts`),
**not** the shared lib — the cron reminder path uses the same lib and must not fire "sent" on
every auto-nudge. Target job assignees + creator, minus the actor. Also write a
`graphics_status_history` note row so the job timeline shows the send. Use exactly the type
string `proof_sent` — anything containing "status"/"ready"/"shipped"/"new"/"flagged" gets
silently preference-gated by `src/lib/notify.ts:186-205`, and unmapped types default to
in_app+push with **no email**.

**Size.** XS. Worth checking with you: the customer recipient is resolved by
`ilike('company_name', job.customer)` (`proof-approval-send.ts:76-79`) — a free-text customer
name that doesn't match a `customers` row silently 400s the send.

---

## Vehicle status

### V1 — "arriving" in shop

> "Once sales order is put in then vehicle goes to 'arriving' in shop"

**ASK FIRST — there is a hard blocker.** A pre-arrival stage. **There is no `arriving` value
anywhere in the vehicle status vocabulary.** The nearest concept is the ShopArrivals widget
(heading literally "🚚 Arriving") backed by `shop_inbound` rows with status `expected` —
derived only from graphics jobs and upfit projects, **never from a sales order**.

**The blocker: an estimate has no VIN or vehicle field.** At SO-entry time, nobody knows
*which* vehicle is arriving. The NetSuite SO does carry `custbody_vin_number_` (already
selected at `src/lib/netsuite.ts:215`, read nowhere) — so whether this note is buildable at
all depends on whether sales reliably fills that field.

**Today.** Vocabulary at `src/lib/types.ts:304-326`, DB CHECK at migrations/001:126-128, state
machine at `src/app/api/vehicle-tracking/update-status/route.ts:16-27`. Only two writers of
vehicle status exist: the check-in wizard insert (`src/components/VehicleCheckIn.tsx:460`,
hardcoded `received`) and the manual update route. `shop_inbound` is derived only by
`src/lib/shop-inbound.ts:81-134`. Conversion (`convert-to-so/route.ts:188-196`) touches none
of it.

**Change.** Two options. **Option A (recommended)** — SO entry produces a `shop_inbound`
"expected" row, no enum change: extend `shop_inbound.source_type` to include `sales_order`,
add VIN/SO columns (migration **184**), add a `syncShopInboundForSalesOrder` following the
existing idempotency contract (`shop-inbound.ts:33-79`), call it from convert-to-so. Change
"Arrived ✓" to a "Check in" action that opens the wizard prefilled — which also fixes V2/B5.
**Option B** — `arriving` becomes a real value on `fleet_checkins.status`, sitting before
`received`.

**Size.** M. Concrete blocker for a naive Option A: `shop_inbound.source_id` is UUID NOT NULL
while NetSuite ids are numeric strings. Option B's blast radius is 6+ hardcoded status arrays
(OpsDashboard, customer portal, weekly digest, ready-for-install, notify-ready) — miss one and
counts silently drift. Option B is also impossible without a VIN (`fleet_checkins.vin` is NOT
NULL). See Question 6.

### V2 — arrived vs received

> "Vehicle in arrived status when not received"

**What it means.** Most likely the `shop_inbound` dead end (B5) — "arrived" in one system,
non-existent in the receiving system — plus its mirror image: checking a vehicle in does **not**
close its `shop_inbound` row, so a vehicle physically in the shop still shows under "Overdue —
expected but not arrived." Ruled out by evidence: no automated path (PO import, invoice import,
ETA sweep, scan) sets vehicle status.

**Today.** `src/components/ShopArrivals.tsx:96-99` and `:74`; `shop_inbound.fleet_checkin_id`
(migrations/160:34) written nowhere; `src/lib/shop-inbound.ts:59-68` explicitly never demotes an
`arrived` row, so the flip is permanent and invisible. Supporting defect: **`fleet_checkins` has
no arrival timestamp** — `created_at` is the de facto arrival time at
`src/app/(main)/tracking/page.tsx:1030-1033` and `src/app/api/cron/stuck-vehicle-check/route.ts:73`.

**Change.** Make "Arrived" mean received: a server action that either links an existing check-in
or returns `needsCheckin` and opens the wizard prefilled, always writing `fleet_checkin_id`
alongside the status. Close the loop in the other direction from the check-in insert. Add
`fleet_checkins.arrived_at` (migration **184**, backfill from `created_at`) and switch stage-day
math to `arrived_at ?? created_at`. Fix B8 and B10 while here. Delete the stale comment at
`update-status/route.ts:14-15` claiming invoicing flips status.

**Size.** M. Sequence V1's Option A/B decision first — it changes the shape of the timestamp
work. Note the backfill will instantly change stage-day chips and may fire a burst of
stuck-vehicle alerts on the next cron run.

---

## Notifications & audit

### A1 — mentions in the top dock

> "Add mentions to top dock"

**What it means.** A Mentions badge + popover in the sticky Header button cluster, mirroring the
Alerts bell. "Top dock" = `src/components/Header.tsx:399-691`, not the bottom tab bar.

**Today.** `MentionsInbox` has **no global home** — it is mounted inline on exactly three pages
(`home/page.tsx:45`, `tracking/page.tsx:1066`, `graphics/page.tsx:930`) and renders nothing when
there are zero unread (`MentionsInbox.tsx:86`). So a mention is invisible from POs, upfit,
estimates, schedule, CNI. The Alerts bell is the exact pattern to clone: count query
`Header.tsx:102-110`, 30s poll `:94-100`, dropdown `:479-600`, outside-click/Escape already wired
at `:62-86`. `note_mentions` RLS already allows a user to read/update their own rows
(migrations/159:28-37) with an unread partial index.

**Change.** Extract the mention data layer out of `MentionsInbox.tsx` into a shared hook so the
card and the popover can't drift on URL rebuilding. Add the count to the **existing** 30s effect
rather than a third timer. Add the button + popover; decide the fate of the three inline cards.
Fix B11 (the `/home` fallback) at the same time. No migration.

**Size.** S. Watch: the header cluster is width-constrained on mobile, and a mention currently
fires **twice** — a `note_mentions` row and a `type:'mention'` bell notification
(`api/mentions/route.ts:107`).

### A2 — expand the audit log

> "Expand audit log and timestamp all changes to any job record"

**What it means.** Three layers: (L1) write a trail on operational job records, not just the
money tables; (L2) show it on the record itself; (L3) expand the admin viewer.

**Today.** `src/lib/audit.ts` is 34 lines — one helper, one freeform `detail` jsonb, no
before/after diff. 19 call sites across 11 files, **all money-adjacent** (payouts, credits, pay
rates, vendor invoices, parts). `audit_log` (migrations/147) is admin-read-only with **no INSERT
policy** — every write must be service-role. **Seven job tables have zero audit calls:**
`graphics_jobs` (29 mutation sites), `fleet_checkins` (24, ten of them client-side including
invoice number and is_paid), `cni_jobs` (24, fifteen client-side), `purchase_orders` (24),
`estimates` (15), `upfit_projects` (8), `wrap_quotes` (13). Partial coverage exists via three
status-history tables with triggers — but those cover **status transitions only**, on 3 of the 7
tables. The viewer (`src/app/(main)/admin/audit/page.tsx:44-48`) reads 300 rows and searches
**client-side over only those 300**.

**Change.** Trigger-first hybrid. Roughly 40 of ~137 job mutation sites are client-side direct
`supabase.update()` calls — per-call-site instrumentation cannot reach them without rewriting the
busiest screens into API routes. A `SECURITY DEFINER` row-diff trigger catches all of them by
construction. Actor attribution is the hard part and is already solved once in this codebase:
`cni_jobs.updated_by` + trigger reading `NEW.updated_by` (migrations/115, 045:183-200) — replicate
on the other six tables (migration **187**), with `COALESCE(NEW.updated_by, auth.uid())`. See Big
rocks for the phasing and the volume problem.

**Size.** L.

### A3 — opt in to email notifications

> "Opt in to email notifications when sending any communication???"

**ASK FIRST — your own "???". This is the most ambiguous note in the batch and should not be
built before it's answered.** Readings, in descending likelihood: **(R1)** per-send self-copy — an
"email me a copy / BCC me" checkbox on the send dialogs (estimate approval, wrap quote, proof,
thread reply). Nothing like this exists today. **(R2)** send-event notification — when any customer
communication goes out, notify interested staff, gated by a new `notification_preferences` flag
matching the `notify_invoicing` opt-in pattern from migration 144. **(R3)** auto-subscribing
someone to follow-ups on the thread.

**Today.** Notification channel preferences and per-type gating live in `src/lib/notify.ts:136-205`;
`notification_preferences` already carries per-type opt-in flags (migration 144 precedent). No send
path offers a self-copy or BCC option. Related and worth knowing: `notify.ts:136-163` silently
defaults unmapped types to in_app+push with **no email** — which is why `quote_accepted` never
emails today.

**Change.** Depends entirely on the answer. R1 is a schema-light per-send flag on each send route.
R2 is a new notification type + a preferences column + migration + a producer in each send path.

**Size.** S (R1) / M (R2). See Question 7.

---

## Sales nudges

### S1 — upsell reminders

> "Reminder to sales person to sell equipment, telematics, graphics"

**ASK FIRST — the data this note assumes does not exist.** Most likely reading: a cross-sell gap
detector — for each account, work out which of BMG's lines of business the customer has actually
bought, and nudge the owning rep about the missing ones ("Acme bought upfit + graphics, never
telematics"). **Alternate reading A (much cheaper):** a dumb recurring reminder with no per-customer
detection — a weekly prompt to every sales rep. XS, no data model. **Alternate reading B:** a
point-of-quote prompt in the estimate builder when a quote only covers one line of business.

**Today — the honest answer.** Greps for `telematics` and `upsell` across the whole repo return
**zero hits**. There is no product-line field on any part, estimate line, job, or customer.

- `netsuite_parts.catalog` ∈ {`upfit`,`graphics`} (migrations/018:11) is the only product-ish
  classifier, derived by a two-line heuristic at `src/app/api/parts/sync/route.ts:26-34`.
- **It actively mislabels telematics:** the Verizon RFID part is `06CS901033`
  (`src/lib/rfid.ts:11`), which starts with `06`, so the heuristic files it under **graphics**.
  `src/lib/parts-catalog.ts:19` then collapses anything not `upfit` to `graphics`.
- `ns_category` is hard-coded `null` at `route.ts:222` — always empty. `ns_class`/`ns_department`
  do exist, but their actual values in BMG's NetSuite are not knowable from this repo.
- Per-customer purchase data locally is **money only** — `customers.total_spend`/`ytd_spend`, header
  totals with zero item detail (`cron/netsuite-sync/route.ts:136-153`). There is no local table of
  customer purchase lines anywhere. It *is* reachable via SuiteQL
  (`reports/sales-by-customer-detail/route.ts:76-131` proves the join) — it's just never materialized.

Machinery that exists and should be reused: the at-risk cron (`src/lib/at-risk.ts:44-93` +
`cron/at-risk-check/route.ts`) is the exact right shape — a pure evaluator, a per-account owner, a
dismiss action. One dormant table also exists: `prospect_reminders` (migrations/061) is written by
AI voice notes but has **no cron**, so a due reminder never notifies anyone. (`sales_cadences`,
created by migrations/054 with zero code references, was already dropped by migrations/059.)

**Change.** **Phase 0 (XS, ships same day, de-risks everything):** a plain weekly recurring reminder
with no detection — new cron, `notifyMany` over sales reps, linking to
`/admin/prospects?sort=ytd_spend` (a true many-record digest, allowed by the deep-link rule).
Confirms cadence and audience before any data model gets built. **Phases 1–4 (L)** are the real
detector: migration **189** adds `netsuite_parts.product_line` + `product_line_override` (mirroring
the `catalog_override` pattern from migrations/126), a `customer_product_lines` fact table, and an
`upsell_nudges` table for per-gap dismiss/snooze; then a classifier lib, a SuiteQL materialization
step in the netsuite-sync cron, an `evaluateUpsellGaps` evaluator, and a nudge cron.

**Size.** XS (Phase 0) / L (full detector). **Two risks worth naming.** Classification is a
data-entry project, not an engineering one, if `ns_class`/`ns_department` don't cleanly encode the
three lines — expect to hand-classify through the override UI. And notification fatigue kills this
feature: every customer has at least one gap by construction, so a naive cron produces hundreds of
nudges on day one and reps mute the channel — which degrades the existing at-risk and quote-followup
nudges too, since they share the bell. Ship with a spend floor, a per-rep cap, and the dismiss before
it goes live. See Question 8.

---

## Quick wins & cross-cutting

### X1 — phone number formatting

> "Auto format phone numbers with parentheses and dash when entering customer"

**What it means.** Mask US phones to `(555) 123-4567` as you type. The only real decision is
storage format.

**Today.** **No display/mask formatter exists anywhere.** `src/lib/utils.ts` exports only date/time
helpers; the only phone helpers are three near-duplicate E.164 normalizers for outbound SMS
(`src/lib/twilio.ts:47-63`, `src/lib/sms-provider/twilio.ts:95`,
`src/lib/sms-provider/ringcentral.ts:53-60`). **18 phone inputs**, all bare `<input>` with a
formatted placeholder as a hint and nothing enforcing it — the customer-entry one is
`src/app/(main)/admin/wrap-quote/page.tsx:2673-2680` (its value forwards to NetSuite via
`create-customer`). Note `CustomerPicker.tsx` has no phone field; the inline customer-create phone
lives in `GraphicsInvoiceReviewModal.tsx:392`.

**Change.** Add `formatPhoneInput`/`formatPhoneDisplay` to `src/lib/utils.ts` (pass through untouched
on `+`, letters, or >10 digits so international numbers and extensions survive), a shared `PhoneInput`
component, and swap the 18 call sites. The blur-reformat trick avoids the classic caret-jump bug. No
migration — format on read covers existing rows; a backfill is not recommended. Optional cleanup:
collapse the three normalizer copies.

**Size.** S.

---

## C1 — Combine estimates with wrap quotes

> "Combine estimates with wrap quotes"

**ASK FIRST.** This is the largest note in the batch and the one where the wrong choice costs the
most. Most likely reading: "stop running two parallel quoting products" — one place a rep goes to see
all quotes, and ONE customer-facing quote document, regardless of how the quote was built.

**Today — two systems, and they are genuinely different.**

| | `estimates` | `wrap_quotes` |
|---|---|---|
| Lines | relational `estimate_line_items` w/ NetSuite item ids | **no child table** — `measurements` JSONB (canvas geometry) |
| Pricing | server-side, unit-tested (`src/lib/estimate-totals.ts`) | client-side, untested (`wrap-quote/page.tsx:621-727`) |
| Tax | rate is a **fraction**, taxed on **parts only** | rate is a **percent**, taxed on the **whole subtotal** |
| Labor | hours × shop rate | $/ft² per film + three flat/hourly sections |
| NetSuite | per-line item ids, create/PATCH/DELETE, **+ convert to SO** | exactly two rollup lines, create-only, **no SO** |
| Writes | service-role API (`api/estimates/route.ts`) | **direct from the browser** under RLS (`page.tsx:1318`) |
| Customer doc | **none** — a generic notification card + the NetSuite PDF | branded document, coverage diagram, 4 send modes, dry-run preview |
| RLS | admin + sales | admin + sales + graphics_production + production |

**What is already combined — this changes the recommendation.** The unified follow-up queue
(`api/quotes/follow-up/route.ts:32-140`), the unified sales funnel report
(`api/reports/sales-performance/route.ts:45-95`), the shared margin floor (`quote_settings`,
migrations/150), the shared magic-link approval machinery (`src/lib/magic-link-approval.ts`), the
shared signed-documents bucket, and graphics-job bridges from both sides
(`graphics_jobs.estimate_id` + `.wrap_quote_id`) all exist today. Search, Popout, RecentActivity,
OpsDashboard and the prospect detail page already list both. **The classic payoff of a table merge —
"one report, one queue, one dashboard number" — has already been paid for at the code level.**

**The duplication that actually costs money is the customer-facing document, which is written out
four times:** the wrap email (`api/wrap-quote/send/route.ts:43-160`), the wrap signed snapshot
(`api/approve/quote/[token]/route.ts:234-335`), the estimate signed snapshot
(`api/approve/estimate/[token]/route.ts:250-319`), and the two public approval pages' JSX (625 lines,
189 of which differ — ~70% is byte-identical scaffolding).

**Three strategies.**

| | Blast radius | Data risk | Effort |
|---|---|---|---|
| **A** — merge into one `quotes` table + `kind` discriminator | all 43 files + new migration; both 1900- and 3300-line pages rewritten | **HIGH** | XL (2–4 wks) |
| **B** — keep tables, unify the UI shell + share approval/email/NetSuite | ~22 files, mostly additive | none | L–XL, ships in ~4 PRs |
| **C** — unify the customer-facing output + the list only | ~14 files | **zero** | M–L |

**Recommendation: C now, the shared-shell half of B next, and explicitly not A** unless the answer
to Question 1 is "one quote must carry both catalog parts and measured wrap areas."

C means: one `quote-document.ts` renderer with per-type adapters (delete the four copies); one
generalized send endpoint, which finally gives **estimates a branded customer quote email** — the
single biggest capability gap; one shared public approval page behind both existing URLs (keep
`/approve/estimate/[token]/` and `/approve/quote/[token]/` as thin re-exports **forever** — live
30-day tokens are already in customers' inboxes); and one merged `GET /api/quotes` list generalizing
the follow-up merge that already works.

**Why not A.** Four hazards, any one of which is a real incident:

1. **Live approval tokens** are 30-day and already sitting in customer inboxes.
2. **R2 signed-document paths are keyed by row UUID** (`estimates/{id}/signed`) — regenerating ids
   orphans the E-SIGN evidence for every already-accepted quote.
3. **`netsuite_estimate_id`/`netsuite_so_id` are the only guards against duplicate NetSuite financial
   records** — mis-mapping them during backfill risks real duplicate transactions.
4. **The wrap page writes direct from the browser**, so a deployed client keeps writing to the old
   table during any cutover window unless that page is server-routed first.

Plus the tax-convention clash: one shared totals function silently 100×'s or ÷100's a tax line. And
wrap's `materials_total`/`labor_total` already have the discount and shop minimum folded in
proportionally — re-deriving them from measurements desyncs the quote, the NetSuite estimate, and the
invoice.

**And the two builders should stay different.** One prices catalog parts by quantity and labor by the
hour; the other measures a vehicle on a calibrated 1:20 outline, nests shapes on a vinyl roll, and
prices by the square foot. Merging those UIs produces a worse tool for both jobs.

**Size.** L for C. Note that C also naturally fixes B15, B10, and the two unpaginated quote reads.

---

## First-pass checklist — everything XS/S

Ship these together; none need a migration except where noted.

- [ ] **B4** Stop Save/Push from downgrading an accepted estimate's status *(do this first — N1 depends on it)*
- [ ] **B1** Wrap-quote `?id=` re-entry via `router.replace` — *closes W3 Reading A*
- [ ] **B10 / B11** Route 7 hand-built URLs through `deep-links.ts`; fix the `/home` mention fallback
- [ ] **B7 / B8 / B9** Three unpaginated reads → `fetchAllRows` with a unique tiebreaker
- [ ] **B12** Send `taxExempt` in the NetSuite estimate payload
- [ ] **B13 / G1** Shared `fmtSqft`/`fmtIn` display helpers + job-content dims
- [ ] **B14** 23505 retry on estimate number generation
- [ ] **B15** `Popout.tsx` selects a non-existent `estimates.total`
- [ ] **E3** Stay in the estimate after Sync + silent refresh (removes the spinner flash on every Save)
- [ ] **G2** Save in the top action row + sticky footer; **B2** allowlist in `saveJob`; `GraphicsJob` interface gaps
- [ ] **G3** `proof_sent` notification + a `graphics_status_history` row
- [ ] **E2** Shared `estimate-document.ts` + line table in the approval email *(B3 held for sign-off)*
- [ ] **X1** Phone input mask across 18 fields
- [ ] **A1** Mentions in the header dock
- [ ] **N1** Gate convert-to-SO on `customer_approved` + the missing notification
- [ ] **W1 + W2** Composable wrap-quote send options + hide-line-items *(ships as one PR, migration 182)*
- [ ] **S1 Phase 0** Weekly upsell reminder cron, no detection *(optional — confirms cadence before the L build)*

That's roughly the full XS/S surface: about half of it is defect repair, and it clears or
substantially advances 10 of the 23 notes.

---

## Sequencing

### Cross-cutting hazards

**Single-file bottleneck.** `src/app/(main)/estimates/page.tsx` (1,897 lines) is the edit target for
**eight** notes, four of which cluster in the same 500–660 line block. Under the one-PR-per-change +
squash-merge rule in `CLAUDE.md`, every PR after the first rebases onto a squashed change it wasn't
written against. **Sequence these, don't parallelize** — land B4 and E3 together and first. Every
line number in this document goes stale after that PR.

**Migration numbering.** Five planned changes independently want "the next number." Assigned centrally:

| # | Item | Contents |
|---|---|---|
| 182 | W2 | `wrap_quotes.hide_line_items` |
| 183 | E5 | `customers.tax_exempt*`, `customer_files` |
| 184 | V1/V2 | `fleet_checkins.arrived_at`, `shop_inbound` sales-order source |
| 185 | E1 | estimate header fields *(only if built)* |
| 186 | N3 | `netsuite_sales_orders` + lines |
| 187 | A2 ph2 | `updated_by` on six job tables |
| 188 | A2 ph3 | audit diff trigger |
| 189 | S1 | `product_line`, `customer_product_lines`, `upsell_nudges` |

**Signed-snapshot coupling — the highest-severity design risk here.** W2 and G1 (Reading B) both
change customer-facing quote rendering that exists in three parallel copies: the email, the approval
page, and the **frozen E-SIGN snapshot**. If these drift, the legal record stops matching what the
customer agreed to. Any change touching quote presentation updates all three in one PR.

**New notification producers.** This plan adds at least four (`proof_sent`, SO-converted, upsell,
parts-ready). Each needs an explicit entry in the `notify.ts:136-163` preference map — unmapped types
silently default to in_app + push with **no email**, which is why `quote_accepted` never emails today.
Note `po-billing-notify.ts:66` and `at-risk-check:59` link to list pages **correctly** — those are true
digests. Don't let anyone "fix" them.

### Hard dependencies

| This must land first | Before this | Why |
|---|---|---|
| B4 (status downgrade) | N1 (SO gate) | The gate reads a field that Save currently wipes |
| B3 decision (labor × qty) | E2 (estimate email) | Otherwise you ship a beautiful new price table containing wrong numbers |
| W2 (`hide_line_items` across all 3 renderers) | W1 (send options UI) | W1 alone ships a nicer dropdown that still leaks itemization on the acceptance page |
| E2 (shared `estimate-document.ts`) | E4 (compose + preview) | Otherwise the renderer gets written twice |
| N1 | N2 (parts on conversion) | N2 hooks the same post-create block |
| NetSuite Estimate→SO **transform** fix | N3 (SO pull) | Without `createdfrom`, the sync is stuck matching on a hand-editable field forever |
| B7 (paginate PO lines) | N2 phase 2 (auto-reserve) | Automated ordering decisions off truncated on-order data |
| B5 / V2 (arrived bug) | V1 (SO → arriving) | Don't feed a third source into a board whose arrived state is broken |
| V1 Option A vs B decision | V2 step 3 (`arrived_at`) | Option B changes where arrival time comes from |
| A2 phase 2 (`updated_by`) | A2 phase 3 (triggers) | Triggers with no actor log NULL, which is worse than no entry |

### Three phases

**Phase 1 — bugs and quick wins (about a week).** The entire checklist above. One migration (182).
Highest value per hour in the batch, and it retires three notes outright.

**Phase 2 — customer documents and the order gate (1–2 weeks).** W1+W2 as one item. E2→E4 as one item.
N1 with the override decision made. E5. V1 Option A + V2 as one item. Migrations 183–184.

**Phase 3 — big rocks, one at a time.** C1 Strategy C → N2 phases 1–2 → N3 → A2 phased → N4 phase A →
S1 full detector. E1 stays parked until "New quote" is defined.

---

## Questions for you

Only the ones where a different answer changes the work materially.

**1. "Combine estimates with wrap quotes" — which reading?**
(a) One place to see all quotes; (b) one customer-facing quote document + approval page; (c) **one
quote that can hold BOTH catalog part lines AND measured wrap areas** — upfit + graphics on the same
vehicle, one number to the customer; (d) just collapse the two nav entries.
**Default: (a) + (b) — Strategy C, zero data risk.** Only (c) justifies the full table merge, and (c)
is a real business question worth answering honestly, not an engineering preference.
Sub-question: should wrap quotes gain convert-to-Sales-Order, or is wrap → graphics job → invoice the
permanent terminal path? Today only estimates can become an SO.

**2. What does "New quote" mean?**
(a) Quote a customer who isn't in NetSuite yet — the concrete gap the code shows; (b) a "New quote"
button on the customer record; (c) duplicate an existing estimate; (d) rename Estimate→Quote;
(e) missing header fields (expiration, customer PO, terms, ship-to, sales rep).
**Default: (a) + (b), roughly a day.** Renaming is discouraged — "quote" already means the wrap-quote
product and would make search ambiguous.

**3. The labor × quantity fix — is it intended?**
The builder multiplies labor hours by quantity; the server does not. Fixing the server **raises prices**
on every qty>1 labor line and changes what's pushed to NetSuite.
**Default: fix the server** (the builder is what reps see and quote from), but this needs your explicit
yes, and it gates the estimate-email work.

**4. Sales order gate — hard or soft?**
(a) Hard block until `customer_approved`; (b) allow an admin override with a recorded reason.
**Default: (b).** Many customers approve by phone/PO/email and never touch the magic link — a hard gate
blocks legitimate conversions on day one.

**5. "Order parts" — does FleetSuite create the NetSuite PO?**
(a) Auto-create the upfit project + compute readiness + tell purchasing what's short; (b) FleetSuite
actually writes the vendor PO into NetSuite.
**Default: (a).** This is the difference between S and L. FleetSuite has **never** written a purchase
order to NetSuite — no precedent, unverified role permission, and the vendor name→internal id trap from
`docs/cni-vendor-bills.md` applies verbatim.

**6. "Arriving" — and does the sales order carry a VIN?**
This is the blocker, not a preference: an estimate has no vehicle field, so at SO-entry time nobody knows
which vehicle is arriving. The NetSuite SO has `custbody_vin_number_`, already available to us and read
nowhere. **Does sales reliably fill it?** If yes → (a) an SO produces a `shop_inbound` "expected" row in
the 🚚 Arriving widget, or (b) `arriving` becomes a real vehicle status before `received`. If no, this
note can't be built as written.
**Default: (a)** — a `fleet_checkins` row requires a VIN, and (b) also means sweeping 6+ hardcoded status
arrays including the customer portal and weekly digest.

**7. "Opt in to email notifications when sending any communication???" — which one?**
(a) A per-send "email me a copy / BCC me" checkbox; (b) a notification to staff whenever a customer
communication goes out, with a per-user opt-in flag; (c) something else.
**Default: (a)** — smallest, and the one that matches "opt in… when sending." Nothing gets built here
until you pick.

**8. Upsell reminders — smart or simple?**
(a) A weekly "ask about equipment, telematics, graphics" nudge to every rep — XS, ships same day;
(b) a real per-customer gap detector — L, and it needs a product-line classification that does not exist
today (the telematics part is currently mis-filed as graphics).
**Default: (a) first.** If you want (b), I need to know what NetSuite class/department values identify
each line, whether "telematics" is just the Verizon part `06CS901033` or a broader family, and whether
the gap should measure what the customer *bought* (NetSuite invoice lines) or what *BMG installed*
(scan logs — free and local, but blind to anything sold elsewhere).

**Assumptions I'll run with unless you say otherwise:** hidden line items still show Subtotal / Tax /
Total (tax has to be visible or the number looks wrong), and the suppression applies to the email, the
acceptance page, **and** the signed snapshot; ft² rounds to 1 decimal; phone masking applies to every
phone field, not just customer ones, with international numbers passing through untouched; existing
phone records are not backfilled (format-on-read only); automated NetSuite syncs are **excluded** from
the audit trail as noise.

---

## Big rocks

### 1. One customer-facing document engine

**Items:** C1 (Strategy C) + W1 + W2 + E2 + E4. **Honest size: L, roughly 5–8 days combined — but only
if built as one thing.**

The same itemized table is currently reimplemented **four times** on the wrap-quote side and estimates
got none of it — they got a dark internal-notification card instead. Any one of these notes forces
editing three of the four in lockstep.

**Strategy:** extract `src/lib/quote-document.ts` and `src/lib/estimate-document.ts` up front, then drive
the email, the compose preview, the acceptance page, and the signed snapshot from them. That extraction
is maybe half a day and pays for itself on this batch alone.

**The one trap to not miss:** on accept, a frozen signed HTML snapshot is uploaded as the E-SIGN evidence
record. If the emailed document hides lines but the snapshot shows them, the legal record no longer
matches what the customer agreed to. All the suppression work ships in one PR or none of it does.

### 2. The estimate → SO → parts chain

**Items:** N1 + N2 + N3. **Honest size: S + M + M ≈ 5–8 days for the automation; L and open-ended if
FleetSuite writes purchase orders.**

Today this is **three disconnected hops, each requiring a human**: a rep clicks Convert (writes the SO id
onto the estimate only) → someone hand-creates an upfit project → someone hand-types the SO number into a
lookup box. Only after the third hop does any parts/allocation machinery become reachable at all.

**Strategy:** close hops 2 and 3 inside `convert-to-so`. That single change is the highest-leverage item
in this batch — it unblocks N2 almost entirely and makes the readiness math reachable automatically for
the first time. Do N1's gate in the same PR since it edits the same block. Then fix SO creation to use
NetSuite's Estimate→SO transform *before* building N3's sync, or the pull is permanently stuck matching on
`otherrefnum` — a free-text field reps overwrite with real customer PO numbers.

**Honest risk:** PO creation (N2 phase 3) is genuinely unknown territory. The integration role is already
known to be restricted, and the vendor-bill rollout burned real time on opaque 500s. A
`parts_order_requests` queue that notifies purchasing — leaving the PO keyed in NetSuite, where
`vendor-po-sync` remains the single source of truth — gets most of the value at a fraction of the risk.

### 3. Configurator

**Item:** N4. **Honest size: S–M for a catalog browser; L–XL for a real configurator, and the engineering
is not the long pole.**

There is no vehicle fitment data and no BOM data in the system. Someone at BMG has to author kits and
fitment per part, and that effort dwarfs the code. `labor_hours` comes from a single NetSuite custom field
and is likely sparse, so a configurator promising auto-labor will under-quote wherever it's blank. Catalog
classification is currently a two-line heuristic, so facets will only be as good as NetSuite's
classification hygiene.

**Strategy:** ship the browser, then test the appetite for kits using NetSuite's existing Kit/Assembly
items — the sync already imports them. If BMG already curates kits in NetSuite, that path gets most of the
value for a fraction of the cost. Build FleetSuite-owned kit tables only if NetSuite kits prove
insufficient. Compatibility *rules* ("if A then not B") are a rules engine and should be deferred until
the data exists. Use Ranger's configurator as UX inspiration only — importing their catalog data is a
licensing question, not an engineering one.

### 4. Audit expansion

**Item:** A2. **Honest size: L — 1.5–2 weeks done properly, and it should be phased, not shipped as one
drop.**

The reason this is L and not M: about 40 of ~137 job-record mutation sites are **client-side direct
Supabase updates** — 9 in `tracking/page.tsx` alone (including invoice number and paid status), 10 in the
CNI job page, 6 across the PO pages. Per-call-site instrumentation can't reach those without rewriting the
busiest screens, and calling an audit endpoint from the browser is spoofable and can silently no-op. A
Postgres row-diff trigger catches all of them by construction, including future ones.

**Strategy, in four phases:**

1. **(S)** Server-side filtering + keyset pagination + per-record drill-in on `/admin/audit`. No write
   changes. The current page loads 300 rows and searches client-side over only those 300 — that's already
   misleading and becomes useless the moment volume rises.
2. **(M)** Add `updated_by` to the six job tables and set it in every service-role route that mutates them.
3. **(M–L)** The `SECURITY DEFINER` diff trigger, enabled **one table at a time** behind a per-table
   noisy-column ignore list, starting with the lowest-volume/highest-value (`upfit_projects`, then
   `graphics_jobs`, then `cni_jobs`); `fleet_checkins` and `purchase_orders` last because of sync volume.
4. **(S)** A "Changes" tab on the record itself, reconciled with `RecentActivity.tsx` so status-history and
   `audit_log` don't show the same event twice.

**Honest risks:** bulk NetSuite syncs can multiply audit volume by 10–100× — the answer to "are automated
writes auditable?" is the single biggest cost driver, and retention/partitioning needs a plan on day one.
Service-role routes that forget `updated_by` log a NULL actor, which reads as "the system did it" — worse
than no entry. And the event you most want recorded is the one that's hardest: `graphics/[id]/page.tsx:553`
**hard-deletes** a job today, so DELETE auditing must capture OLD, or that action should become a soft
delete.
