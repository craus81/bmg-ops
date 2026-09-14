# NetSuite ledger — role grants and the PDF RESTlet

The ledger mirrors NetSuite invoices and credit memos into the same tables the
QuickBooks history lands in, with PDF copies pulled through the existing PDF
RESTlet. Two NetSuite-side permissions decide how much of that actually
works, and neither can be granted from code: customer **payments** need a
grant on the SuiteQL integration role, and **credit-memo PDFs** need the PDF
RESTlet's role to see Credit Memo. Everything here is a one-time task in the
NetSuite UI; nothing in the app changes behavior when you finish, it simply
stops reporting the limitation.

Until the grants exist the app degrades honestly rather than failing: the
payments mirror reports *"not permitted — see runbook"* and credit-memo
documents sit at `needs_restlet`. Neither blocks invoice mirroring.

> **Verifying afterwards.** System Health → Connections shows the rows that
> answer each step: **NetSuite ledger — credit memos** (can the SuiteQL role
> read them), **NetSuite ledger — customer payments** (`not permitted` →
> `mirroring`), and the **PDF RESTlet** version row. Those rows are the
> check that a grant took — no redeploy is involved, they change on the next
> scheduled run.

## 0. Record the two role names (~2 minutes)

NetSuite has two distinct roles in play and the repo names neither. Write
them down here the first time, because every step below says "that same
role" and picking the wrong one is the usual failure:

- **SuiteQL integration role** — the role behind the TBA token
  (`NETSUITE_TOKEN_ID`/`NETSUITE_TOKEN_SECRET`; Setup → Users/Roles → Access
  Tokens). Name: `________________`
- **PDF RESTlet deployment role** — the role on the RESTlet's script
  deployment (Setup → Users/Roles → Manage Roles). Name: `________________`

## 1. SuiteQL role: credit memos and customer payments (~5 minutes)

1. **Credit memos** — confirm the integration role can already read Credit
   Memo headers and lines: System Health → Connections → *NetSuite ledger —
   credit memos*. If it reads `query shape rejected`, that is an engineering
   bug, not a grant: report it rather than granting anything.
2. **Customer payments** — on the SuiteQL integration role (Setup →
   Users/Roles → Manage Roles → the role from step 0) add:
   - **Transactions → Customer Payment: View**
   - **Transactions → Find Transaction: View**

   Save. The payments row flips from `not permitted` to `mirroring` on the
   next 2-hourly run — no redeploy, no code change.
3. If a probe reports a permission error naming something else, the error
   text names the missing piece; grant that and let the next run re-probe.

## 2. PDF RESTlet: credit-memo PDFs (~5 minutes)

1. In NetSuite: **Documents → Files → File Cabinet**, find the existing
   `bmg-pdf-restlet.js` and upload the repo's current
   `scripts/netsuite-pdf-restlet.js` **over it** (Edit → replace file, same
   name and path), exactly as docs/pnl-restlet-deploy.md §1. The Script
   record and deployment pick up the new code automatically; the RESTlet URL
   does not change.
2. Grant that deployment's role **View on Credit Memo**.

## 3. Verify (~5 minutes)

System Health → Connections:

- The **PDF RESTlet** row reads `Deployed and current (2026-09-15.1)`. A
  reachable RESTlet that reports **no** version is an OLD deployment, not a
  success — the row says so. `2026-09-15.1` is the version the credit-memo
  script in step 2 carries; until that script exists in the repo and is
  uploaded, the row reads the earlier version this deployment is still
  running, which means step 2 has not been done yet. The repo's copy of the
  expected value is `src/lib/restlet-versions.ts` (`pdf`), and
  `restlet-versions.test.ts` fails if the script and that value ever drift.
- The ledger mirror job shows `ok` on its own schedule (System Health →
  Jobs), and the *customer payments* row reads `mirroring`.
- Credit-memo document rows leave `needs_restlet` on the next PDF pull.

## Rollback

Re-upload the previous version of the RESTlet script (the File Cabinet keeps
prior versions under the file's history): invoice PDFs keep working and
credit-memo PDFs simply return to `needs_restlet`. Removing the Customer
Payment grant returns the payments mirror to `not permitted`; already-
mirrored payment rows stay.

## Later

- Vendor bills and journal entries are the same shape and the same kind of
  grant, deliberately not mirrored yet.
- If the SuiteQL role is ever replaced, redo step 1 against the new role —
  the Connections rows will show `not permitted` again the moment it is.
