# Owner setup runbook — turning on what's already been built

Rounds 4–6 of `docs/feature-audit-2026-09.md` shipped ~40 features across
PRs #837–#895. Most of them are live the moment they deploy. A minority are
**built but dark**, waiting on something only a human with a NetSuite login,
a Vercel dashboard, or knowledge of the business can do.

This is that list — every outstanding external action, in the order worth
doing them.

> **What this document is not.** It is not a status report. The session
> container can't reach production (Postgres 5432 and HTTPS to
> `ops.bmgfleet.com` are both blocked by the egress policy), so nothing here
> is a claim that a given env var is unset or a given table is empty — it's
> the complete list of what each feature *requires*, compiled from the code.
> Skip any line you know is already done.
>
> **The app can now tell you, though.** Open **System Health → Connections**
> (`/admin/system-health`). It probes NetSuite auth, all three RESTlets,
> connected apps, every environment variable and the migration state live,
> and lists exactly what is unset with what each thing breaks. It defaults
> to "Needs attention", so it opens on the short list. Treat that page as
> the status report and this document as the procedures behind it.

---

## The short version

If you only do five things, do these:

| # | Do this | Where | Time | Turns on |
|---|---------|-------|------|----------|
| 1 | Re-upload the financials RESTlet + grant the role transaction search | NetSuite | ~15 min | The whole P&L band — GM%, Net profit %, Labor % of revenue, Collections |
| 2 | Set `NETSUITE_PAYROLL_ACCOUNT_IDS` | Vercel | ~10 min | Payroll tile, Labor % of revenue, real payroll in the cash outlook |
| 3 | Confirm the NetSuite labor item resolves | Settings | ~2 min | Stops labor silently vanishing off pushed estimates/SOs |
| 4 | Set reorder points on your fast-moving parts | Parts catalog | ~1 hr | The nightly auto-replenishment sweep (today it reorders nothing) |
| 5 | Subscribe the customers who should get automatic email | Customer Notifications | ~20 min | Weekly digests, pickup nudges, portal notices — all off by default |

Items 1–3 are the ones where the app is currently showing a hole where a
number should be. Items 4–5 are features that ran, found nothing enrolled,
and correctly did nothing.

---

## 1. NetSuite

### 1a. Re-deploy the financials RESTlet — *the biggest single unlock*

The P&L band shipped in #851 and has been waiting on this since. Full
runbook with verification and rollback: **`docs/pnl-restlet-deploy.md`**.
Short form:

1. **Documents → Files → File Cabinet**, find `bmg-financials-restlet.js`
   (usually under SuiteScripts).
2. Upload the repo's current `scripts/netsuite-financials-restlet.js` **over
   it** — Edit → replace file, same name and path. The existing Script
   record and deployment pick up the new code automatically. No new script
   record, no new deployment, and `NETSUITE_FINANCIALS_RESTLET_URL` does not
   change.

Until this is done the Financials tab says "P&L unavailable" and names the
doc, rather than guessing. P&L metric snapshots only start accruing after
the redeploy verifies — and like all snapshot history, **that can't be
backfilled**, so every week costs a week of trend data.

**Confirm it took.** Open System Health → Connections and look at the
Financials RESTlet row. Each script now reports its own version, so the row
reads "Deployed and current" only when NetSuite is genuinely running the code
this app expects. A re-upload that silently didn't take shows as "running
code older than this app expects" instead of looking fine.

### 1b. Grant the RESTlet's role transaction search

Same role as the deployment (Setup → Users/Roles → Manage Roles). It already
has Lists → Accounts: View. The two new modes run transaction searches, so
add:

- **Transactions → Find Transaction: View**
- **View** on the posting types the P&L sums, at minimum: Invoice, Credit
  Memo, Journal Entry, Bill, Bill Credit, Check, Credit Card, Customer
  Payment, Customer Deposit. (Full is fine — the RESTlet only reads.)

If a probe returns a permission error, the error text names the missing
piece. Nothing changes on the SuiteQL integration role.

### 1c. Confirm the labor item resolves

**Settings → NetSuite Labor Item.** This one is worth two minutes because
the failure mode is silent and expensive: with no labor item resolved, the
entire labor amount just *disappears* from every estimate and sales order
pushed to NetSuite. It has shipped broken twice before (see the labor-item
bullet in `CLAUDE.md`).

Resolution order is `NETSUITE_LABOR_ITEM_ID` (env) → the item configured in
Settings → a ranked search. The Settings page names which source won. If it
shows nothing resolved, fix it before anything else on this list.

### 1d. CNI installer vendor records

Per `docs/cni-vendor-bills.md`: each installer's `cni_profiles.netsuite_vendor_id`
must be the vendor's **numeric Internal ID**, not the Entity ID or name — a
name 500s the bill create. Any installer whose payouts have never posted is
worth checking. Bills also need subsidiary 2 and account 223 (override:
`NETSUITE_SUBCONTRACTOR_ACCOUNT_ID`).

### 1e. Verify the other two RESTlets are current

- `NETSUITE_ITEM_RESTLET_URL` → `scripts/netsuite-item-restlet.js`. Feeds
  catalog auto-enrichment and item creation.
- `NETSUITE_PDF_RESTLET_URL` → NetSuite's own transaction PDFs. Required by
  the house rule that every transaction email carries a PDF copy — invoices
  and statements pull their PDFs through this.

Both fail loudly with a "not configured" message rather than silently, so if
you haven't seen those errors they're probably fine.

### 1f. Chart of Accounts internal IDs

Collect the **Internal ID** column (not the account number) for the groups
below — they drive the Money band and its drill-downs, and each one unset
means that tile reads "—":

`NETSUITE_BANK_ACCOUNT_IDS` · `NETSUITE_CARD_ACCOUNT_ID` ·
`NETSUITE_AP_ACCOUNT_IDS` · `NETSUITE_SALES_TAX_ACCOUNT_IDS` ·
`NETSUITE_PAYROLL_ACCOUNT_IDS` (see §2a)

The drill-down panel names the env var behind each empty group, so the app
will tell you which one is missing when you open it.

---

## 2. Vercel environment variables

Vercel → Project → Settings → Environment Variables. Changes take effect on
the next deploy.

### 2a. `NETSUITE_PAYROLL_ACCOUNT_IDS` — the one that's definitely missing

Comma-separated Internal IDs of every Expense account that is payroll:
wages, payroll taxes, benefits, payroll fees.

Feeds: the Payroll tile, Labor % of revenue, and the 4-week cash outlook's
payroll line — which currently reports *no figure at all* rather than
guessing (`cash-outlook.ts` returns "no payroll accounts configured").

**Honesty note carried over from the deploy doc:** Net profit % is only as
complete as what posts to the GL. If Paychex payroll journals aren't being
posted into NetSuite, NP% overstates until they are. The band's footnote
says so, and closed-month numbers are the reliable ones either way.

### 2b. Dialpad (if you're keeping Dialpad — see §5)

The screen-pop and call logging shipped in #868 and need four things:

```
DIALPAD_API_KEY=          # Admin → Company Settings → API keys
DIALPAD_FROM_NUMBER=+1NXXNXXXXXX   # or DIALPAD_USER_ID to send as a user
DIALPAD_WEBHOOK_SECRET=   # the shared secret you set on the subscription
SMS_PROVIDER=dialpad
```

Then register the Event Subscription webhook in Dialpad, pointed at:

```
POST https://ops.bmgfleet.com/api/webhooks/dialpad
```

Without the subscription the outbound SMS path works but no call ever
screen-pops and nothing lands in the CRM timeline.

### 2c. Everything else — verify, don't assume

These are all referenced in code and all fail with a named message when
absent, so absence is visible in the app rather than silent:
`RESEND_*` (email + the delivery webhook), `R2_*` (photos/attachments),
`VAPID_*` / `APNS_*` (push), `GOOGLE_*` (calendar pull, Gmail auto-import),
`DROPBOX_*` (proof sync), `ANTHROPIC_API_KEY` (PO/invoice extraction, voice
notes, knowledge vision), `TWILIO_*`, `CRON_SECRET`.

---

## 3. In-app setup — features that shipped empty

This is the largest bucket and the least obvious one, because nothing is
broken. These features ran, found no data enrolled, and correctly did
nothing. Each is opt-in **by design** — the alternative was fabricating
numbers.

### 3a. Reorder points — *the sweep is running and reordering nothing*

**Where:** Parts catalog (`/parts`), per part.

`reorder_point` and `order_up_to` are NULL for all 3,000+ parts. NULL means
"not managed by the sweep" — the deliberate default. The nightly
`reorder-check` cron (04:45 UTC) has been running since #843 and has had
nothing to act on.

Pick your fast movers, set a reorder point and an order-up-to level, and the
sweep starts raising purchase requests tagged `source='auto_reorder'`.
Starting with 20–30 parts is a real result; you don't need all 3,000.

### 3b. Film catalog costs

**Where:** `/admin/wrap-quote` (the `wrap_substrates` catalog).

#866 made this the single catalog production prices against, and added the
two consumables the shop burns and never billed for. Per film:
`premask_cost_per_sqft`, `ink_cost_per_sqft`, `roll_width_in`,
`roll_length_ft`. Shop-wide fallbacks live in Settings
(`default_ink_cost_per_sqft`, `default_premask_cost_per_sqft`).

NULL stays **unknown, never $0** — so material yield and the graphics-costs
rollup show blanks, not wrong numbers, until these are filled.

### 3c. Material stock — opening count

**Where:** `/admin/materials`.

#867 gave the shop a roll/cartridge ledger for the first time. It needs an
opening count: film and premask by the roll (linear feet), ink **by
cartridge on hand** — not ml, because no printer API is reachable from
Vercel and the `unit` column keeps that distinction honest. Then set the
reorder policy per material so low-stock auto-requests fire.

### 3d. ZIP centroids — the CNI mileage dataset

**Where:** `POST /api/admin/zip-centroids` (CSV import).

Migration 286 ships the table **deliberately empty**. Fabricating 41,000
centroids would produce confidently wrong mileage ("42 mi, in radius" for a
company three states away), so invite ranking currently uses ZIP-list and
state service areas, ZIP3-prefix proximity reported honestly as "same area
(ZIP 606…)", capability, availability, and the scorecard — and every chip
says which of those it used.

Load any public ZIP centroid dataset and real mileage switches on
immediately. No code change needed.

### 3e. Install guide templates

**Where:** the install guide editor.

#881 made a template just a guide flagged as one, keyed to year/make/model.
"New from template" has nothing to offer until you go back through your best
existing guides — the ones where the calibration and dimensions are already
right — and flag them. A Transit 148" high-roof done once should never be
dimensioned again.

### 3f. Shop capacity and booking

**Where:** Settings.

- **Shop Crew Capacity** — crew size × shift hours. This is the *denominator*
  for the week planner's load bars; without it there are no load bars.
- **Customer Booking** — booking days, slot length, lead days, blocked
  dates. Gates the customer-facing pickup/drop-off booking (R5-17, migrations 280–281).
- **Shop Labor Cost Rate** — feeds the labor burn meter and the margin
  reports.
- **Sales Tax Rate**.

### 3g. Customer email enrollment — *everything is off by default*

**Where:** `/admin/customer-notifications`.

Migration 171 set an explicit philosophy: **nobody gets automatic email
unless individually subscribed.** Every customer is opted out. Weekly
digests, pickup nudges, and portal notices reach exactly the customers you
enroll here and no one else.

This is a policy you may want to keep — but it's worth knowing that several
shipped notification features are, from the customer's side, currently
silent.

### 3h. Owner's weekly brief

The Monday brief targets **approved** `super_admin`/`executive` accounts.
Worth confirming the right people are approved and none of them has the
opt-out flag set (migration 276).

### 3i. Month-end close — assign an owner

**Where:** `/admin/reports/month-close`.

#884 built the cockpit, but gates that live in NetSuite (reconciliation,
invoice-location backfill) are **PENDING until a person says they checked
them**. A computed gate that fails can be waived with a written reason — a
waiver never turns a fail into a pass, it records who accepted it. Somebody
needs to own the monthly pass or the page is a dashboard nobody signs.

### 3j. Smaller ones worth a look

- **Pay rates** (`/admin/pay-rates`) — crew hours & field productivity read
  these.
- **Invoice locations** (`/admin/invoice-locations`) — plus the
  `NETSUITE_DEFAULT_LOCATION_ID` fallback.
- **Vendor master** (`/admin/purchasing`) — after the nightly mirror runs,
  the free-text vendor names ("Grimco" / "GRIMCO" / "Grimco Inc") need
  collapsing onto real NetSuite vendor IDs.
- **Three-way match tolerance** — the pct-of-PO and absolute-dollar variance
  thresholds. Check the defaults suit your vendors before they start
  generating amber verdicts nobody trusts.

---

## 4. Decisions only you can make

These are Tier 4 in the audit: **blocked on a decision or a provisioning
step, not on engineering.** Several jump straight to Tier 2 the day you
decide.

| Decision | What it unblocks | Note |
|---|---|---|
| **Dialpad vs RingCentral** | Finishes the phone integration | Open since Round 6; #868 built against Dialpad |
| **Stripe / ACH onboarding** | Pay-Now links & deposit collection (value 5) | ACH matters — fleet customers pay large invoices and card fees bite |
| **Reply-To policy** | Two-way customer inbox (3 lenses, value 5) | Today Reply-To is the sending staffer, per `docs/customer-email-standard.md`. A watched shared address reverses that, and needs Google Workspace DWD auth |
| **A/R dunning policy** | Automated past-due ladder | Collides with the m171 opt-in philosophy — must default off, roll out per customer |
| **Carrier aggregator account** (EasyPost/AfterShip) | Carrier tracking autopilot + dock radar (5 lenses) | Just needs the account + API key; the phase-1 CNI nudge loop has no dependency and could ship now |
| **Paychex payroll scope** | Payroll totals, revenue per employee | An owner phone call with unknown lead time. Headcount could ship early, ahead of the scope |
| **Payroll pay-date anchor** | Real payroll spikes in the cash outlook | Today it smooths payroll as a GL run-rate because FleetSuite doesn't know your pay dates — said plainly on the page, not faked |
| **Condition-report wording** | — | Should the customer acknowledgment say more than "this record is accurate"? |
| **Nurture cadences / m054 tables** | Lead follow-up autopilot | Building on tables the audit precedent marks as drop candidates. Explicit call needed |

---

## 5. What needs nothing

Worth stating so you don't go looking: the 23 crons in `vercel.json` all run
on `CRON_SECRET` and report to **System Health** (`/admin/system-health`) —
that page shows heartbeats and email deliverability today and is the right
first stop when something feels stale.

Migrations need nothing at all. `migrations/` auto-applies on every
production deploy (`node scripts/migrate.mjs --deploy && next build`), in
filename order, inside transactions, failing the deploy if one fails. 270
through 295 are live. **Do not run them in the Supabase SQL editor** — to
confirm one landed, check the production build log for `applied <file>.sql`.

---

## Suggested order

**This week (~40 min of NetSuite/Vercel work):** §1a redeploy → §1b role
grant → §2a payroll IDs → §1c labor item check. This closes every visible
hole on the Financials tab and starts P&L snapshot history accruing.

**Next (~2 hrs, spread out):** §3a reorder points on your fast movers →
§3g customer email enrollment → §3f shop capacity. These three turn on
machinery that's already running and currently idle.

**When there's time:** §3b/3c film costs and stock counts (they unlock the
material-yield reporting as a pair), §3e templates, §3d ZIP centroids.

**Whenever you're ready to decide:** §4.
