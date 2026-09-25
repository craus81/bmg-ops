# Importing the QuickBooks history into the ledger

The import is deliberately slow to start and impossible to do by accident:
you look at a dry-run report first, confirm the QuickBooks → NetSuite cutover
date, and only then write rows. Every run is recorded, re-runnable and
resumable, so a failure costs a retry rather than a restart. Vercel functions
are capped, so the bulk pull is chunked — a run that stops at its budget
reports `partial`, which is normal, not a fault.

This document is the operating manual. Connect QuickBooks first
(docs/quickbooks-connect.md).

> **Verifying afterwards.** System Health → Connections shows the
> **QuickBooks Online** connection and the **Ledger PDF storage gate**;
> System Health → Jobs shows the daily sync's heartbeat. Import progress
> itself lives on /admin/ledger and in `sync_state.ledger_qbo_import`.

## 0. Before ANY PDF — the R2 privacy flip

Imported financial documents are not written to R2 until the flip in
docs/r2-private-flip.md is verified. Do its steps 1–3, then:

1. `node scripts/import-quickbooks.mjs --mode probe-r2 --confirm <host>` —
   it writes the fixed, non-sensitive `ledger/probe.txt` (no ledger data) and
   prints a `publicUrlToTest`.
2. Request that URL. It must be **blocked**. A printed `null` means
   `R2_PUBLIC_URL` is unset — finish the custom-domain step first.
3. Only then either set `LEDGER_PDFS_ENABLED=true` in Vercel (Production,
   then redeploy) or tick "R2 privacy flip verified" on Settings → Company
   (audited, no redeploy).
4. Confirm: System Health → Connections → Connected apps → **Ledger PDF
   storage gate** reads `Enabled via LEDGER_PDFS_ENABLED` or `Enabled via
   Settings → Company (stamped <date>)`.

Everything in §1–§4 and §6 works with the gate shut; only §5 needs it.

## 1. Dry run — nothing is written

From /admin/ledger (admin), or `--mode dry-run` from the script. The report
gives you:

- **Counts** per entity, as QuickBooks reports them.
- **The cutover window** — max QuickBooks TxnDate vs min NetSuite trandate in
  the sales-order/invoice mirror — or a plain warning that QuickBooks refused
  the date probe, in which case you supply the date yourself.
- **The customer buckets**: matched exactly / matched after cleanup /
  ambiguous / unmatched, plus *already decided* — rows a human attached or
  ignored in the review queue, which a re-run never re-grades. They always
  sum to the customer total.
- **Capabilities** the client probed (ordering, counts, CDC, per-type PDF
  support) and any warnings.

No ledger row, no import event and no resume pointer is written by a dry run.

A dry run is CHUNKED: keep looping `--mode dry-run --run <id>` until it
answers `complete`. A run that stopped at its deadline covers only part of the
customer list, so it cannot be marked read and cannot gate an import — both
answer `That dry run has not finished — re-run it to completion first.`

## 2. Mark it read, then confirm the cutover

Mark the report read on /admin/ledger, then confirm the cutover date:

```
node scripts/import-quickbooks.mjs --mode confirm-cutover --dry-run-id <id> --date YYYY-MM-DD
```

QuickBooks rows dated after the cutover are flagged `post_cutover` rather
than dropped — NetSuite owns that period. A later correction re-stamps the
flag; it never re-imports.

## 3. Import

Small realms can run from the page. Otherwise drive it from outside:

```
node scripts/import-quickbooks.mjs --mode import --dry-run-id <id> --budget 240000 --confirm <host>
```

or GitHub Actions → **ledger-import** (workflow_dispatch). Either way the
route does ≤ ~45 s of work per call and hands back a cursor the driver loops
on.

- `partial` is the normal outcome of a chunk — keep looping.
- `failed` names the fix; `--mode resume --run <id>` continues from the same
  page, not from the beginning.
- Progress: /admin/ledger and `sync_state.ledger_qbo_import`.

## 4. Review queue

Customers that didn't match cleanly land in the review queue on /admin/ledger:
attach to an existing customer, ignore, or unlink. Rows in the **unmatched**
bucket usually have no suggestions at all — that is what "unmatched" means —
so each row also carries **Search customers…**, which looks the FleetSuite
customer up by name and offers it as an Attach. Every attach backfills that
customer's history immediately. A customer later renamed in QuickBooks comes
back to the queue; a **manual** or **ignored** decision never does — no
import overwrites a human call.

## 5. PDFs and attachments (needs §0)

```
node scripts/import-quickbooks.mjs --mode import --phases pdfs,attachments_fetch --confirm <host>
```

These phases are gate-free in the dry-run sense — they only finish document
rows the gated import already created — but they write bytes, so the R2 gate
in §0 must be open or every write returns
`LEDGER_PDFS_ENABLED off — docs/r2-private-flip.md`.

## 6. Reports

```
node scripts/import-quickbooks.mjs --mode import --phases reports --dry-run-id <id> --confirm <host>
```

Reports WRITE financial rows, so they carry the same dry-run/cutover gate as a
full import — passing the dry run you already read and confirmed satisfies it.
A `--phases reports` run without one answers `412 needsDryRun`.

Which years: `--reports-from YYYY` (the Action's `reportsFrom` input) when
given, otherwise the year of the earliest QuickBooks transaction already
imported, through this year. Until 2026-09-24 the default was "last year",
which for a company that left QuickBooks fetched only empty post-cutover
months; the first full import (run 62ee000e) got 2025–2026 only. Re-running
`--phases reports` adds the missing years and leaves stored ones alone.

The monthly accrual P&Ls feed Reports → **Financial History**
(`src/lib/financial-history.ts`), which puts QuickBooks months before the
cutover and NetSuite months from it in one series. NetSuite months are cached
in the same table under source `netsuite`.

## 7. Daily sync

09:57 UTC. It renews the QuickBooks token from day one — before the bulk
import has finished — and syncs changes once the import is complete. It shows
up on System Health → Jobs like every other cron; a run that skips because
the import is still going is reported as skipped, not as a failure, and does
not touch the job's last-synced timestamp.

## 8. Where progress shows

| Where | What it tells you |
|---|---|
| /admin/ledger | Run history, counts, the dry-run report, the review queue |
| `sync_state.ledger_qbo_import` | The mirror of the authoritative cursor — safe to read while a run is in flight |
| System Health → Jobs | The daily sync's heartbeat (the one-off bulk import is deliberately NOT a monitored job) |
| System Health → Connections | The QuickBooks connection and the PDF storage gate |

## 9. Where the history shows in FleetSuite

Owner decision (2026-09-24): no separate "old" area. QuickBooks sales documents
join the lists people already use, tagged **QuickBooks**, so a build from years
ago can be found and repeated. Rules (enforced in `src/lib/ledger/history.ts`):

- Only rows dated before the cutover. From the cutover on, NetSuite is the
  record and the QuickBooks copy would show the same job twice.
- Never in a balance: AR, aging, statements and totals ignore them. Status is a
  word ("Paid", "Unpaid in QuickBooks"), never an open amount.
- Read-only: no email, push, payment or NetSuite PDF. A row opens its QuickBooks
  record window (lines, stored PDF, attachments).
- Under a customer only once matched in the review queue (section 4). Search
  finds them either way.

Where: the customer page's **Transactions** (invoices, estimates, credits), and
the Invoices page **Sent** tab, where a search of 3+ characters also brings in
matching QuickBooks invoices, including matches on line descriptions.

**Copy to new estimate** (record window, for invoices, estimates and sales
receipts): opens the estimate builder for the linked customer with the old
lines in the paste-to-estimate review grid (`src/lib/quickbooks-estimate-copy.ts`).
Prices are today's catalog prices, never the old ones, which ride in each
line's text; unmatched lines stay custom lines to price; nothing is added
until the rep ticks it.

Access: the money wall (sales, admin, finance, executive), so estimators can
find past builds. `GET /api/ledger/documents/[id]` lets sales open only a
document attached to one of these sales records; bills, payments, journals and
reports stay with the ledger readers (finance, executive, admins).

## Rollback

Nothing here is destructive: a sync never deletes a row, it tombstones it.
To stop importing, stop driving the route — a `partial` run left alone simply
never resumes. To stop everything, disconnect QuickBooks
(docs/quickbooks-connect.md §6); the imported rows stay readable.
