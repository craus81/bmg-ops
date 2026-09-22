# NetSuite ledger — role grants and the PDF RESTlet

The ledger mirrors NetSuite invoices and credit memos into the same tables the
QuickBooks history lands in, with PDF copies pulled through the existing PDF
RESTlet. Two NetSuite-side permissions decide how much of that actually
works, and neither can be granted from code: customer **payments** need
Customer Payment: View, and **credit-memo PDFs** need Credit Memo: View —
both on the single role of §0. Everything here is a one-time task in the
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

## 0. There is ONE role: `Custom System Administrator 3`

Every NetSuite call this app makes — SuiteQL and all three RESTlets — builds
its OAuth from the same single `NETSUITE_TOKEN_ID`/`NETSUITE_TOKEN_SECRET`
pair (`getConfig()` in `src/lib/netsuite.ts`). So one role decides what data
comes back, and in this account that role is **`Custom System Administrator
3`** (confirmed 2026-09-22). Every grant below goes there.

This section used to tell you to record *two* roles — a "SuiteQL integration
role" and a "PDF RESTlet deployment role" — and warned that picking the wrong
one was the usual failure. That framing misleads, and it cost time:

- A **Script Deployment's Audience** decides which roles may *execute* the
  script. The deployments here are set to **All Internal Roles**, which is
  why execution has never been the problem. It is not a data permission.
- The **token's role** decides what the script can read. That is the only
  thing a grant changes. (Caveat: a deployment's *Execute As Role* field can
  override this; it is not set that way here.)

So: don't go hunting for a deployment's role. If a read comes back empty,
short or "not permitted", grant on the token's role. If a RESTlet call fails
*outright*, then check that deployment's Audience.

As of 2026-09-22 that role has **View on every transaction type** (granted
wholesale while fixing the P&L — see `docs/pnl-restlet-deploy.md` §2), which
already satisfies the Customer Payment and Credit Memo grants in §1 and §2
below. Re-read them as "confirm", not "do".

## 1. Credit memos and customer payments (~5 minutes)

1. **Credit memos** — confirm the integration role can already read Credit
   Memo headers and lines: System Health → Connections → *NetSuite ledger —
   credit memos*. That row says one of four things:
   - `Header and line queries accepted in full` — nothing to do here.
   - `Mirroring without balance` (or another named column) — the role reads
     both types, but SuiteQL refused that one column. Working, just less
     completely; the row's impact line says what stays empty.
   - `The last run could not read invoice and credit-memo headers — …` — the
     header query itself was rejected. Check the role still has
     **Transactions → Invoice: View** and **Credit Memo: View**.
   - `The last run never reached the header query` / `No run yet` — nothing
     has been confirmed either way. Wait for the next 2-hourly run.
2. **Customer payments** — on the role from step 0 (Setup → Users/Roles →
   Manage Roles) add:
   - **Transactions → Customer Payment: View**
   - **Transactions → Find Transaction: View**

   Save. The payments row flips from `not permitted` to `mirroring` on the
   next 2-hourly run — no redeploy, no code change.

   This is also the only row that can read `query shape rejected`. That is
   an engineering bug — the app asked SuiteQL for something it does not
   understand — **not** a grant: report it rather than granting anything.
   The row says so itself, and no permission change will clear it. The same
   row reading *"Payments mirror, but what each one was applied to does
   not"* means the payment grant IS in place and only the link-table query
   failed — again a bug to report, not a permission to add.
3. If a probe reports a permission error naming something else, the error
   text names the missing piece; grant that and let the next run re-probe.

## 2. PDF RESTlet: credit-memo PDFs (~5 minutes)

1. Find the file **via Customization → Scripting → Scripts** → the PDF
   RESTlet → its **Script File** field, exactly as
   docs/pnl-restlet-deploy.md §1 describes. Do not search the File Cabinet
   for `bmg-pdf-restlet.js` — that name is a suggestion from the script's own
   setup comment, not necessarily what this account holds. Edit that file and
   upload the repo's current `scripts/netsuite-pdf-restlet.js` over it, same
   name and path. The Script record and deployment pick up the new code
   automatically; the RESTlet URL does not change.
2. Grant the step-0 role **View on Credit Memo** (already covered by the
   blanket grant — confirm rather than add).

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
  Jobs — it runs at :35 on even hours). `partial: true` while a first pass
  drains years of history is NORMAL, not a fault: the run saves a cursor and
  the next one continues.
- The *customer payments* row reads `mirroring via nexttransactionlinelink`
  (or `previoustransactionlinelink` — either name is fine, the mirror probes
  both).
- In the job's last result, `repaired` counts payment applications that
  found their invoice on this run. It falls to 0 once the window has
  drained; a number that keeps climbing run after run means invoices are
  still being mirrored behind their payments, which is what the newest-first
  window does on purpose.
- Credit-memo document rows leave `needs_restlet` on the next PDF pull —
  provided the R2 privacy gate is open. Until it is, the job reports
  `pdfs: { skipped: 'LEDGER_PDFS_ENABLED off — docs/r2-private-flip.md' }`
  and stores no bytes at all, which is the correct state, not a failure.
  `pdfs: { skipped: 'Could not read the PDF gate — …' }` is a different
  thing: the gate's setting could not be read, so nothing was written and
  nothing is known about whether the flip is done. Fix the read, don't
  read it as "off".
- `pdfs: { skipped: 'PDF RESTlet unreachable — …' }` is a third: the ping in
  step 2 got no answer (script disabled, deployment mid-re-upload, a network
  blip). The whole PDF phase is skipped for that run — no credit-memo row is
  parked at `needs_restlet`, and no document spends one of its three
  attempts — so nothing needs re-queueing once the RESTlet answers again.
  Do NOT read it as "re-upload the script": the version is unknown, not old.
- `tombstones: { problem: … }` in the last result means the sweep found
  mirrored rows that NetSuite no longer returns but refused to soft-delete
  any of them, because not one id in the whole sweep came back present —
  which reads as a narrowed role rather than as deleted history. Nothing was
  tombstoned; check the SuiteQL role's transaction access.

## Rollback

Re-upload the previous version of the RESTlet script (the File Cabinet keeps
prior versions under the file's history): invoice PDFs keep working and
credit-memo PDFs simply return to `needs_restlet`. Removing the Customer
Payment grant returns the payments mirror to `not permitted`; already-
mirrored payment rows stay.

## Later

- Vendor bills and journal entries are the same shape and the same kind of
  grant, deliberately not mirrored yet.
- If the token is ever reissued against a different role, redo the grants on
  that role — the Connections rows will show `not permitted` again the moment
  it happens. Note there are currently **three** active `BMG Fleet API`
  tokens (two on `Custom System Administrator 3`, one on `System
  Administrator`); which one the app uses is only knowable from
  `NETSUITE_TOKEN_ID` in Vercel. Worth pruning the unused ones, carefully.
