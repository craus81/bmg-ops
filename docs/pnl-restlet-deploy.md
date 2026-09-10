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

1. In NetSuite: **Documents → Files → File Cabinet**, find the existing
   `bmg-financials-restlet.js` (usually under SuiteScripts).
2. Upload the repo's current `scripts/netsuite-financials-restlet.js` **over
   it** (Edit → replace file, keep the same name/path). The existing Script
   record and deployment pick up the new code automatically — no new Script
   record, no new deployment, and `NETSUITE_FINANCIALS_RESTLET_URL` does not
   change.

## 2. Grant the RESTlet role transaction search

The deployment's role already has **Lists → Accounts: View** (that's what
made the balances mode work). The two new modes run transaction searches, so
add to that same role (Setup → Users/Roles → Manage Roles → the RESTlet
deployment's role):

- **Transactions → Find Transaction: View**
- **View** on the posting transaction types the P&L sums — at minimum:
  Invoice, Credit Memo, Journal Entry, Bill, Bill Credit, Check, Credit Card,
  Customer Payment, Customer Deposit. (Full = fine; the RESTlet only reads.)

If a probe below returns a permission error, the error text names the
missing piece — grant it and re-run the probe. Nothing needs to change on
the SuiteQL integration role.

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
- After steps 1–2, the band renders Last month (closed) with MTD
  directional subs. Sanity-check the closed month against NetSuite's own
  **Reports → Financial → Income Statement** for the same month: Revenue and
  Gross margin should match to the dollar; if the signs look inverted
  anywhere, screenshot it — the app normalizes orientation per account-type
  bucket and a mismatch means an account classified unusually.
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
