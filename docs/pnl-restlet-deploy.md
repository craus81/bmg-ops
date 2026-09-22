# P&L unlock — deploying the updated financials RESTlet

The Financials tab's new **Profit & loss band** (GM%, Net profit %, Payroll,
Labor % of revenue, Collections) reads two new modes of the financials
RESTlet: `incomeStatement` and `collections`. The app side shipped in R5-5
and degrades gracefully — the band shows a "P&L unavailable" note with this
document's name until the NetSuite side below is done. Everything here is a
one-time, ~15-minute task in the NetSuite UI; nothing else in the app changes
behavior.

The SuiteQL integration role deliberately cannot compute these numbers (it
can't read the `account` table or payment records — see the header of
`scripts/netsuite-financials-restlet.js`), which is why the RESTlet exists
and why this needs a human in NetSuite rather than a deploy.

> **Verifying afterwards.** System Health → Connections shows each RESTlet's
> deployed version against the version this app expects. That row is the
> check that the re-upload below actually took — it reads "Deployed and
> current" only on a genuine match, and calls out a deployment too old to
> report a version at all.

## 1. Re-upload the script

**Find the file through the Script record, not by name.** The File Cabinet
copy is NOT reliably called `bmg-financials-restlet.js` — that name is this
repo's suggestion (see the setup comment in the script itself), not what the
account actually holds, and hunting for it has wasted real time.

1. **Customization → Scripting → Scripts**. Find the financials RESTlet in
   the list (Type = RESTlet; the name is whatever it was created as — in this
   account the scripts are named things like "BMG Fleet PDF Generator" and
   "Fleetsuite parts sync1"). Open it: the **Script File** field names the
   real file and links straight to it.
2. Click through to that file, **Edit**, and upload the repo's current
   `scripts/netsuite-financials-restlet.js` over it, keeping the same name
   and path. The Script record and deployment pick up the new code
   automatically — no new Script record, no new deployment, and
   `NETSUITE_FINANCIALS_RESTLET_URL` does not change.

If two Script records share one file, replacing the file updates both. That
is fine and expected: they were already running identical code.

## 2. Grant the RESTlet role transaction search

The role is **the one the API token authenticates as** — in this account,
`Custom System Administrator 3` (Setup → Users/Roles → Access Tokens names it
on the token row; Manage Roles is where you edit it). Every call the app makes
— SuiteQL and all three RESTlets — goes through one token pair, so there is
one role to grant on, not one per RESTlet. (Caveat: a Script Deployment's
*Execute As Role* field can override this. It is not set that way here — the
grants below demonstrably changed the numbers.)

It already has **Lists → Accounts: View** (that's what made the balances mode
work). The new modes run transaction searches, so add:

- **Transactions → Find Transaction: View**
- **View on EVERY transaction type.** Tick the whole Transactions list. This
  is safe — the RESTlet only reads — and a shorter list is how this went
  wrong twice.

**Why the whole list, and why a shorter one fails silently.** The search
filters by *account* type, not transaction type (`incomeStatement()` in the
script), so it needs to see every transaction that posts to a P&L account. A
type the role cannot view is simply **left out of the sum** — no error, no
warning, just a total that is too small, which makes gross margin and net
income look better than they are. Proven on Aug 2026: the nine types this
document used to list gave 81.83% gross margin against NetSuite's 56.99%
(COGS short by $84,566.65 — accounts 58000 and 52000, fed by **Item
Fulfillment** and **Inventory Adjustment**, neither of which was listed).
Adding those two got to 58.43%; still $4,914.65 short from at least one more
type. View on everything landed on 56.99% exactly.

Note "Bill Credit" may not appear in the Transactions list at all in this
account. That is fine and was never the problem.

If a probe below returns a permission error, the error text names the missing
piece — grant it and re-run the probe.

## 3. Set the payroll account group (Vercel env)

In Vercel → Project → Settings → Environment Variables, add:

```
NETSUITE_PAYROLL_ACCOUNT_IDS=<comma-separated internal IDs>
```

Use the **Internal ID** column of the Chart of Accounts for every Expense
account that is payroll (wages, payroll taxes, benefits, payroll fees).
These feed the Payroll tile and Labor % of revenue; unset, those two show
"—" with a hint and everything else still works. Redeploy (or just wait for
the next deploy) so the env takes effect.

Honesty note: **Net profit is only as complete as what posts to the GL.** If
Paychex payroll journals are not being posted into NetSuite, NP% overstates
until they are — the band's footnote says so, and closed-month numbers are
the reliable ones either way.

## 4. Verify (~5 minutes)

Open the Financials tab as a super_admin or executive:

- Before step 1, the band shows *"P&L unavailable … re-upload
  scripts/netsuite-financials-restlet.js"* — that message coming from the
  **stale-deployment guard**, not a guess: an old deployment answers the
  balances shape and the app refuses to render it as a $0 P&L.
- After steps 1–2, the band renders the selected period (Last month by
  default, closed). **Reconcile it — this step is not optional**, because a
  missing transaction permission produces plausible-looking numbers rather
  than an error. Run NetSuite's own **Reports → Financial → Income
  Statement** for the same closed month and compare.

  That report prints no gross-profit subtotal, so derive it: Total Income −
  Total Cost Of Sales. Revenue, Total Expense and Gross margin should each
  match to the dollar.

  **Read the pattern of any mismatch.** Revenue, Total Expense and Payroll
  matching while gross margin does NOT is the signature of a transaction type
  the role cannot see — go back to step 2, not to the code. Signs inverted
  somewhere is a different thing: screenshot it, since the app normalizes
  orientation per account-type bucket and a mismatch there means an account
  is classified unusually.
- After step 3, the Payroll tile shows dollars and Labor % populates.

## Rollback

Re-upload the previous version of the script file (File Cabinet keeps prior
versions under the file's history) — the app immediately falls back to the
"P&L unavailable" note and everything that worked before (balances, payment
history) keeps working, since those modes are untouched.

## Later (optional)

- `groupBy=class|department` is already supported by the new mode for the
  K17 "P&L by class" ask — no further NetSuite work needed when the app
  grows that view.
- Once the band is verified, P&L rows can join the nightly
  `metric_snapshots` so GM%/NP% trend charts accrue — a small follow-up PR,
  deliberately not shipped before the deploy so snapshots don't accumulate
  permanent error rows.
