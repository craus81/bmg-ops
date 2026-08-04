# CEO Dashboard — gap analysis & build plan

Zach's requested metric list (Aug 2026) mapped against what bmg-ops has
today, with a phased path to close the gaps. File references point at the
code that exists now; statuses come from a full sweep of the app, API
routes, migrations, and NetSuite integration.

## Where we stand

A lot of the foundation is already live:

- **Home → Financials tab** (`executive`/`super_admin` only, served by
  `/api/reports/financials` behind `requireFinancials`): cash on hand and
  credit-card balance from NetSuite GL (via the financials RESTlet,
  `scripts/netsuite-financials-restlet.js`), full 5-bucket A/R aging with
  drill-downs and customer statements, open vendor bills, and net
  position. `migrations/176-executive-role.sql` exists precisely so a
  leadership login sees this and nothing else — Zach's login would get
  the `executive` role.
- **Ops dashboard** (`src/components/OpsDashboard.tsx`): invoiced this
  month vs last, sales pipeline by CRM stage, open quotes (buggy — see
  below), top customers YTD.
- **Admin reports**: sales performance (quoted/won/win-rate/days-to-close,
  per rep), sales-by-customer detail, installer costs vs invoiced,
  graphics costs, monthly accounting package.

Two structural gaps block most of what's missing:

1. **No P&L access.** The app can read A/R, open bills, and specific GL
   account balances, but has no income-statement source — so gross
   margin %, net profit %, labor % of revenue, and total payroll (wages)
   don't exist anywhere. The SuiteQL integration role can't read the
   `account` table or payment records; the financials RESTlet (which runs
   under its own role) is the established workaround and can be extended.
2. **No bank data.** "Cash" is the NetSuite GL balance, which lags
   reconciliation. There is no Plaid/bank-feed/CSV integration of any
   kind today.

A third, cheaper gap: **nothing is snapshotted** — every financial number
is read live from NetSuite, so there is no history and no trend lines.

## Scorecard

Legend: ✅ have it · 🟡 partial / needs surfacing · ❌ missing

### CEO dashboard

| Metric | Status | Today / gap |
|---|---|---|
| Revenue | 🟡 | `/api/reports/invoiced-summary` (NetSuite invoice lines): this month + last month only. No YTD/quarter/trailing-12, gross of credit memos, and not shown on the Financials tab. |
| Gross Margin % | ❌ | No COGS/P&L source. Only per-job dollar margins (installer-costs, graphics-costs) and quote-time margin floors (`quote_settings.margin_floor_pct`). |
| Net Profit % | ❌ | No expense data in the app at all. |
| Cash Balance | ✅* | NetSuite GL via RESTlet (`NETSUITE_BANK_ACCOUNT_IDS`). *Book balance only — stale vs the bank; see bank section. |
| A/R over 60 days | ✅ | Aging buckets 61–90 and 90+ already computed (`computeArAging`, `src/lib/financials-data.ts`); just needs an explicit "over 60" callout tile. |
| Sales Pipeline | ✅ | `prospect_opportunities` by stage on the ops dashboard. Values are hand-entered; no link to actual quotes. |
| Labor Utilization % | ❌ | Time clock (`time_entries`) has no job linkage and there's no scheduled-hours denominator. Proxy possible from `work_shifts` start/end times. |
| Revenue per Employee | 🟡 | Revenue exists; headcount doesn't — `profiles` mixes staff, customers, and CNI subcontractors with no employment-type field. |
| Warranty/Rework Cost | ❌ | No rework/warranty flag anywhere. Only `scanned_vehicles.denial_count` (photo re-shoots, never reported on). |
| Gross Profit by Customer | ❌ | Revenue by customer exists; no cost on invoice lines. Part costs exist (`netsuite_parts.purchase_price`, `avg_install_cost`) for an estimated-GP join. |

### Sales (per-rep: Valarie & co.)

| Metric | Status | Today / gap |
|---|---|---|
| Open Quotes ($) | 🟡 | Exists in three places that disagree. Bug: the home tile counts only `wrap_quotes` — `estimates` (the bigger quote table) is excluded, so the number understates open quote dollars. |
| Sales Pipeline ($) | ✅ | Same as above. |
| Quote Win Rate | ✅ | `/api/reports/sales-performance`: win rate on decided quotes, per rep, plus avg days to close, CSV export. |
| Average Job Size | 🟡 | Not displayed, but trivially derivable (won $ ÷ won count; invoiced $ ÷ invoice count). `customers.avg_order_value` already exists per customer. |
| Revenue by Customer | ✅ | `customers.ytd_spend / last_year_spend / total_spend` synced every 2h; top-customers band; per-customer detail report. |
| Gross Profit by Customer | ❌ | See above. |
| Per-rep attribution | 🟡 | Reports group by `created_by` (whoever built the quote in the app) — works if reps create their own quotes. NetSuite's salesrep field is never synced; `customers.account_owner_id` exists but is only used for at-risk notifications, not revenue rollups. |

### Employees

| Metric | Status | Today / gap |
|---|---|---|
| Revenue per Employee | 🟡 | See above (headcount). |
| Gross Profit per Employee | ❌ | Needs P&L + headcount. |
| Labor Cost as % of Revenue | ❌ | Only labor cost captured is installer piece-rate pay (`install_credits`). No wages for shop/graphics/sales/admin. Path: payroll GL accounts via the RESTlet P&L, or the Paychex API. |
| Total Payroll | 🟡 | Biweekly installer piece-rate payroll exists (`/admin/payroll`, CSV, mark-paid, accounting package totals). No W-2 wages, salaries, taxes, or burden anywhere. |
| Time Clock Accuracy / Billable Hours | 🟡/❌ | Attendance clock exists (clock in/out, breaks, weekly OT view) but has no API/report (the help doc's "Admin → Reports → Time Clock" page doesn't exist), no missed-punch detection, no edit trail. No job linkage → billable hours not derivable from the clock. |

### Cash flow

| Metric | Status | Today / gap |
|---|---|---|
| Cash In vs Cash Out | ❌ | No cash-flow model. The integration role can't see payment records via SuiteQL; needs RESTlet extension (book view) or bank transactions (actual view). |
| Customer Collections | 🟡 | Per-customer payment history via RESTlet (`/api/netsuite/customer-payments`). No company-wide or period rollup. |
| Outstanding Invoices 30/60/90 | ✅ | The A/R aging is the most complete feature in the app. |
| Credit Card Balance | ✅* | GL balance via RESTlet (`NETSUITE_CARD_ACCOUNT_ID`). *Book, not the issuer's actual balance. |
| Bank Balance | ❌ | No bank integration of any kind. See below. |

## The structural unlocks

### 1. Extend the financials RESTlet (unblocks 6+ metrics)

`scripts/netsuite-financials-restlet.js` already runs under its own
NetSuite role (deployed because the SuiteQL integration role can't read
the `account` table or `CustPymt`). Adding search modes to that one
script + redeploying it unlocks, at company level:

- **`incomeStatement` mode** — posting-transaction totals for a date
  range grouped by account type (Income / COGS / Expense / Other), plus
  a configurable payroll account group (env like
  `NETSUITE_PAYROLL_ACCOUNT_IDS`) →
  **Revenue (GL-true), Gross Margin %, Net Profit %, Total Payroll,
  Labor Cost % of Revenue**, and Warranty Cost if they book rework to a
  dedicated account/class.
- **`collections` mode** — date-ranged, company-wide CustPymt/CustDep
  search (the per-customer version already exists) →
  **Customer Collections** and the cash-in side of cash flow.
- Optional **`cashActivity` mode** — period debits/credits on bank-type
  accounts → book-view **Cash In vs Cash Out**.

Accuracy caveat (Zach already knows it): NetSuite P&L numbers are only
as good as the close cadence. Label periods clearly and treat closed
months as reliable, current month as directional.

### 2. Bank integration for actual cash

Options, in recommended order:

- **A. Plaid (or similar aggregator — Teller, MX).** Link the account(s)
  once, then a daily cron pulls balances and transactions into new
  `bank_balances` / `bank_transactions` tables. Financials tab shows
  **Bank (actual, as-of time)** next to **NetSuite (book)**. Also covers
  credit-card actual balances, and bank transactions give real cash
  in/out for free. Modest per-account monthly cost; occasional re-link
  when the bank forces re-auth. **Coverage confirmed:** Plaid lists
  First Bank as a supported institution with Auth, Balance, and Assets
  products — Balance is exactly what the cash tile needs; confirm the
  Transactions product (for cash in/out) during the sandbox Link test.
- **B. Daily balance-alert email → existing Gmail pipeline (quick MVP).**
  Most business banks can email a daily balance alert. The app already
  ingests and parses Gmail on cron (`/api/gmail/auto-import`,
  parts-email-scan) — a small parser writes `bank_balances`. Zero new
  vendors and fast, but balance-only and fragile to email format changes.
  Reasonable stopgap while deciding on A. First Bank's eBanking supports
  email/text account alerts (low-balance threshold, large-deposit);
  whether a scheduled daily-balance alert type exists needs a look
  inside the portal.
- **C. NetSuite Bank Feeds SuiteApp.** Free SuiteApp that imports bank
  lines into NetSuite for reconciliation. Would reduce the book-vs-bank
  drift at the source but doesn't expose "available balance" to this app
  and still requires someone to match transactions. Complementary, not a
  substitute.
- **D. Scraping the bank website — not recommended** (MFA, ToS,
  breakage).

**Bank identified (Aug 2026): First Bank (first.bank), the family-owned
bank out of Creve Coeur, MO (MO/IL/CA/KS footprint).** Plaid lists it as
a supported institution (Auth, Balance, Assets). Remaining verification:
run a Plaid sandbox→development Link test with the real Business
eBanking login (business portals occasionally appear as a separate
institution entry), confirm the Transactions product, and check which
alert types the eBanking portal offers. Card issuer still unknown.

### 3. Paychex payroll data (provider identified Aug 2026)

Payroll runs on Paychex, and the Paychex Flex External API
(developer.paychex.com) is the official way in: OAuth2
client-credentials → bearer token, REST endpoints for companies,
workers, pay periods, and checks (per the External API OpenAPI spec:
`payperiods` carry start/end/check dates and status; `checks` are
queried per pay period and carry `grossEarnings`, `netPay`, and tax
components flagged employer- vs employee-paid), plus webhooks for
worker changes. That
covers **Total Payroll** (pay-period totals including employer taxes),
**active W-2 headcount** (workers endpoint — solves the "no employee
roster" problem without new profile fields), and — with revenue already
available — **Labor Cost % of Revenue** and **Revenue per Employee**.

- **Access**: check Paychex Flex → Company Settings → Access →
  Integrated applications for a "Create App" option (needs a Flex
  Super Admin / Security Admin; issues a client ID/secret with scoped
  data access). If that's not available on our plan, API access goes
  through a request on the developer portal and can take weeks.
  **Status: credentials are provisioned — the client-credentials
  token flow was verified working (bearer token issued, 10-minute
  expiry) on Aug 4, 2026.** Entitlement check:
  `PAYCHEX_CLIENT_ID=… PAYCHEX_CLIENT_SECRET=… node
  scripts/paychex-smoke-test.mjs` (prints counts/statuses only, no
  PII or pay data).
- **Build**: a `paychex-sync` cron (like `netsuite-sync`) storing
  aggregate pay-period totals and a daily headcount snapshot. Keep it
  aggregate — no per-person pay in the dashboard; gate behind
  `requireFinancials`.
- **Complementary**: if Paychex's GL service is (or can be) set to
  post payroll journals into NetSuite, the RESTlet P&L picks up
  payroll expense automatically — that's what makes **Net Profit %**
  honest. Worth confirming with the accountant either way.

## Phased plan

**Phase 1 — quick wins, existing data only (small PRs)**
1. Fix the home **Open Quotes tile** to include `estimates` alongside
   `wrap_quotes` and align status filters (real bug today).
2. **A/R over 60** explicit tile on the Financials tab (sum of the two
   existing buckets).
3. **Average job size** tiles (won-quote average + invoice average).
4. **Revenue periods**: extend `invoiced-summary` with YTD /
   trailing-12 / arbitrary range, and net credit memos out.
5. **Sales section on the Financials tab** (open quotes, pipeline, win
   rate, avg job size) so the executive login sees everything in one
   place without admin access.
6. **`metric_snapshots` daily cron** — persist cash, A/R buckets, A/P,
   open quotes, pipeline, MTD revenue once a day so trends start
   accruing immediately (everything is live-read today; history can't be
   backfilled, so the sooner this ships the sooner charts exist).

**Phase 2 — external data unlocks (RESTlet redeploy + Paychex API)**
7. `incomeStatement` mode + `/api/reports/financials/pnl` + tiles:
   Revenue, GM %, Net Profit %, Total Payroll, Labor % of Revenue.
8. **Paychex payroll sync** — pay-period totals + headcount snapshots
   → Total Payroll (actual), Labor % of Revenue, Revenue per Employee.
   (Unblocked: API credentials verified working Aug 2026 — needs the
   client ID/secret added as Vercel env vars.)
9. `collections` mode → collections this month + trend.
10. **Gross profit by customer**: first try selecting
   `costestimate`/`estgrossprofit` on invoice lines via SuiteQL (may or
   may not be visible to the role); fallback is estimated GP joining
   invoice lines to `netsuite_parts.purchase_price + avg_install_cost`.

**Phase 3 — bank integration**
11. Chosen option from above → `bank_balances` (+ `bank_transactions`
    if Plaid) + daily cron + "Bank vs Book" tiles + actual cash in/out.

**Phase 4 — metrics that need new data capture / process change**
12. **Warranty/rework flag** on `scan_logs` / `graphics_jobs` (and a
    `rework` source on `install_credits`) + monthly rework-cost report.
    Needs a shop process decision: who marks a job as rework and when.
13. **Headcount**: prefer the Paychex workers endpoint once connected
    (item 8); fallback is an employment-type field on `profiles` →
    Revenue per Employee, GP per Employee.
14. **Time clock accuracy report**: open entries (missed clock-outs),
    missing lunches on long days, weekly totals; move clock writes
    server-side for an edit/audit trail. (Also fixes the stale help-doc
    reference to a Time Clock report.)
15. **Labor utilization**: v1 proxy = `work_shifts` crew hours ÷ clocked
    hours for field crews; the real metric needs job-linked time
    entries, which is a workflow change to the time clock.

## Open questions for Zach / Craig

1. **Bank**: answered — First Bank (first.bank), Plaid-supported (see
   bank section). Remaining: who is the card issuer, and OK to sign up
   for Plaid and do the 2-minute Link flow with the Business eBanking
   login?
2. **Payroll**: provider answered — Paychex, and API credentials are
   provisioned (token flow verified Aug 2026). Remaining: does Paychex
   post GL journals into NetSuite today, and to which accounts (needed
   for Net Profit %)? To build the sync, add the client ID/secret as
   Vercel env vars (never in the repo).
3. **Sales rep**: is the Sales Rep field maintained on NetSuite
   customers/transactions? (Determines how revenue-per-rep is
   attributed; quote metrics already attribute to whoever creates the
   quote in the app.)
4. **Gross margin definition**: which costs count as COGS — materials,
   CNI subcontractors, in-house installer piece-rate, shop labor?
5. **Utilization definition**: billable ÷ clocked, or ÷ a 40-hour
   scheduled week?
6. **Warranty/rework**: flag at the vehicle/job level acceptable? Is
   rework ever billed (goodwill vs warranty vs chargeable)?
