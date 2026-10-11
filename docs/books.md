# FleetSuite books

FleetSuite is taking over the books from NetSuite: built hidden through the
end of 2026, run side by side with NetSuite for all of 2027, and the only
books from 2028-01-01 (owner decision 2026-10-09/10; the full plan is the
"Replacing NetSuite with FleetSuite" doc). It keeps two companies: BMG Fleet
Installations LLC and 1084 Cool Springs LLC, which owns the building.

This file covers part 1, the ledger core, part 2, the chart of accounts
copied from NetSuite, and part 3, NetSuite's general ledger from 2025 copied
and checked month by month. The screens are the accounts page at
`/admin/books` and the trial balance at `/admin/books/trial-balance`, which
only super admins can open and no menu links to yet.

| Piece | Where |
| --- | --- |
| Companies, chart of accounts, months, journal | `migrations/359-books-ledger-core.sql` |
| Server helper (validate, post, reverse, close, reset) | `src/lib/books/journal.ts` |
| Database rule tests (PGlite) | `src/lib/books/ledger-core-sql.test.ts` |
| Account sync from NetSuite | `migrations/360-books-netsuite-accounts.sql`, `src/lib/books/netsuite-accounts.ts` |
| Account sync tests | `src/lib/books/netsuite-accounts.test.ts`, `src/lib/books/netsuite-accounts-sql.test.ts` |
| Accounts page and its API | `src/app/(main)/admin/books/page.tsx`, `src/app/api/admin/books/accounts/route.ts` |
| NetSuite's general ledger, copied | `migrations/361-books-netsuite-gl.sql`, `src/lib/books/netsuite-gl.ts`, `src/app/api/cron/books-netsuite-gl/route.ts` |
| Trial balance check | `src/lib/books/trial-balance.ts`, `src/app/(main)/admin/books/trial-balance/page.tsx`, `src/app/api/admin/books/trial-balance/route.ts` |
| Copy and check tests | `src/lib/books/netsuite-gl.test.ts`, `src/lib/books/netsuite-gl-sql.test.ts`, `src/lib/books/trial-balance.test.ts` |

The `ledger_*` tables from migration 314 are a different thing: copies of
QuickBooks and NetSuite history that importers replace wholesale. They stay
as they are. The books FleetSuite keeps itself live in `gl_*`.

## Rules the database enforces

These hold for any writer, including a direct insert with the service role.

- An entry has at least two lines and its debits equal its credits. This is
  checked when the posting transaction commits.
- Each line has an amount on exactly one side, above zero, in whole cents.
- A posted entry or line is never updated or deleted. To correct one,
  reverse it (`reverseEntry`) and post the right entry.
- Lines can only be added in the transaction that posts their entry.
- A reversal names the entry it reverses, in the same company
  (`gl_reverse_entry` posts them). An entry is reversed at most once, and a
  reversal is never reversed.
- A closed month refuses new entries. Closing and reopening are logged in
  `gl_period_events`, and reopening needs a reason. Each company has its own
  months.
- A typed entry (`source_type = 'manual'`) can't post to a control account
  (AR, AP, inventory). Only the documents behind those accounts post there.
- An account restricted to one company can't be used by the other. Once an
  account has postings, its type and company can't change.
- A heading (summary) account takes no postings.
- The same idempotency key never posts twice, so a retried post is safe.
- Until a company has `books_live_from` set, `resetJournal` empties the
  journal and its months for another rehearsal. Once any company is live,
  that is refused, the live date can't change, and entries dated before it
  are refused unless they are opening balances.

Only the service role can read or write the `gl_*` tables or call the
`gl_*` functions. RLS is on with no policies.

## Chart of accounts

Until the changeover NetSuite is the master for accounts (owner decision
2026-10-10). Accounts are added and changed in NetSuite, and FleetSuite
copies them every two hours, at the start of the ledger mirror cron
(`/api/cron/ledger-netsuite-mirror`, :35 on even hours). **Sync now** on the
accounts page runs the same job. Nothing is written back to NetSuite.

How a sync works (`syncBooksAccounts`, which hands the list to
`gl_sync_netsuite_accounts`):

- It reads every NetSuite account with SuiteQL, plus which subsidiaries
  each one is limited to (`AccountSubsidiaryMap`) and the subsidiaries
  themselves. Only the account list is required. Without the other two,
  accounts keep the company limits they had and the run says why.
- Accounts match on NetSuite's internal id (`netsuite_account_id`). New ones
  are added. Number, name, parent, inactive flag, description and company
  follow NetSuite.
- Non-posting and statistical accounts are left out. A NetSuite type this
  code doesn't know is left out and listed on the page, so it can be added
  to `NETSUITE_ACCOUNT_TYPES`.
- An account limited to one company's subsidiary belongs to that company.
  Anything else is open to both. A company with no subsidiary yet (1084) is
  linked the first time a sync finds exactly one active subsidiary with its
  name or number in it. A sync never changes an existing link.
- NetSuite's summary accounts come across as headings (`is_summary`), so the
  hierarchy holds.
- Once an account has postings, a type or company change from NetSuite is
  not applied. The account keeps a `sync_issue` and the run lists it.
- An account missing from a complete list is marked inactive with "No
  longer in NetSuite", unless the list looks cut short (empty, or under half
  of the active synced accounts). It comes back if NetSuite lists it again.
- One sync runs at a time, and the whole list applies in one transaction or
  not at all.

Each run is recorded in `sync_state` as `books_netsuite_accounts`, which the
accounts page shows. It is deliberately not a System Health monitor: the
books are hidden, and a monitor would alert every System Health admin.

If the integration role can't read `account` through SuiteQL, the page shows
NetSuite's refusal. The fix is then the role's permission, or a RESTlet mode
that lists the accounts.

At the changeover the sync is switched off, and accounts are kept in
FleetSuite from then on.

## NetSuite's general ledger, copied

FleetSuite holds a copy of NetSuite's general ledger for both companies
(owner decision 2026-10-11): every posting GL line from the January 2025
accounting period on, with its transaction, plus one starting entry per
company equal to NetSuite's balances before 2025. Starting in 2025 keeps the
2024 entries that didn't reflect real activity out as transactions, while
every balance still starts where NetSuite's does. Nothing is written to
NetSuite.

The copy (`gl_netsuite_*`, migration 361) sits beside the journal, not in
it. It follows NetSuite: an edit there replaces the copied lines and a
delete removes them, while a posted journal entry never changes. It keeps
following NetSuite through 2027, next to what FleetSuite posts itself, so
the two can be compared, and FleetSuite's opening balances on the day its
books go live come from it. It can be emptied and copied again at any time.

It runs every two hours (`/api/cron/books-netsuite-gl`, :26 on odd hours)
and from **Copy now** on the trial balance page (`copyNetSuiteGl`):

1. Read NetSuite's accounting periods, so a transaction counts in the month
   it was posted to, as on NetSuite's reports. SuiteQL lists them only when
   the integration role has Manage Accounting Periods (View, on the role's
   Setup tab). If the periods can't be read, months follow the transaction
   date and the page says so; once they can, the next run copies again
   every month a transaction moves into or out of.
2. Read NetSuite's own totals per subsidiary, account and month, over all of
   its history, and store them. Everything before 2025 becomes the starting
   entry (`gl_netsuite_opening`); the rest (`gl_netsuite_month_totals`) is
   what the copy is checked against.
3. Work out the same totals from the copy. Every month that differs is
   copied again: its lines are read in pages of whole transactions, an
   unchanged transaction is only marked seen, and once the month is through,
   whatever NetSuite no longer has in that month is removed.
4. With time left, refresh one more month, the one copied longest ago, so an
   edit that moves no money (a memo) still comes across.

The first run finds every month different and works through them oldest
first, a few runs in all. A month can span runs; the cursor is kept in
`sync_state` as `books_netsuite_gl`. Like the account sync, that record is
not a System Health monitor, and neither it nor the cron's response carries
any amount.

Safeguards:

- One copy runs at a time (`gl_netsuite_claim_copy`), so the cron and Copy
  now never overlap.
- NetSuite totals that come back empty are refused, and nothing changes.
- A month whose pass read less than half the lines NetSuite's totals promise
  removes nothing.
- Lines in a subsidiary no company is linked to aren't copied, and the page
  says how many there are.
- Lines with no account aren't copied either. NetSuite has them on posting
  transactions for lines that post nowhere; the page notes only those that
  carry an amount.
- Two GL lines for the same transaction line stop the copy. That would mean
  NetSuite keeps more than one accounting book; the copy takes one.

The SuiteQL reads `TransactionAccountingLine` joined to the transaction and
its line, posting lines only. If NetSuite refuses the transaction-level
posting filter, the line's is used alone. If it refuses the lines' memo,
name, location, department and class, the copy keeps accounts and amounts.
Both fallbacks are noted on the page.

## Trial balance check

`/admin/books/trial-balance` shows one company's month-end trial balance from
the copy, next to the same balances worked out from NetSuite's own totals,
for the starting entry and every month from January 2025. It is laid out
like NetSuite's Trial Balance report: balance sheet accounts at their
month-end balance, income and expenses for the year to date, and earlier
years' net income in retained earnings (in the one equity account named
Retained Earnings that the company can use, or on a line of its own). The
year is taken as the calendar year. A month matches when every line of its
trial balance does, to the cent, so the month strip and the table always
agree.

Both columns come from NetSuite through the same integration role, so a
transaction type the role can't see would be missing from both. To prove the
role sees everything, compare one month's NetSuite column with NetSuite's
own Reports → Financial → Trial Balance for the same subsidiary and period.

## Posting

```ts
import { createServiceClient } from '@/lib/supabase-service';
import { postEntry } from '@/lib/books/journal';

const posted = await postEntry(createServiceClient(), {
  company: 'BMG',
  entryDate: '2027-01-04',
  sourceType: 'invoice',
  sourceId: invoice.id,
  postingRule: 'invoice@1',
  idempotencyKey: `invoice:${invoice.id}:1`,
  postedBy: { id: profile.id, name: profile.full_name },
  lines: [
    { accountId: ar.id, debit: 1250, customerId: invoice.customer_id, jobRef: `so:${so.id}` },
    { accountId: sales.id, credit: 1250, division: 'upfit', location: 'ofallon' },
  ],
});
```

- `idempotencyKey` names the document, the rule and the generation. Posting
  the same key again returns `alreadyPosted: true` and writes nothing.
- `postingRule` carries a version (`invoice@1`), so a change to how a
  document posts can be traced.
- Amounts may be numbers or plain decimal strings. They go to the database
  as exact two-decimal strings.
- Errors are `BooksError`s. `kind` is `invalid` (caught before the
  database), `refused` (a database rule, such as a closed month) or
  `failed` (anything else).

## Closing a month

```ts
await setPeriodStatus(client, { company: 'BMG', month: '2027-01', status: 'closed', actor });
await setPeriodStatus(client, { company: 'BMG', month: '2027-01', status: 'open', actor, reason: 'Missed a vendor bill' });
```

A month opens the first time anything posts to it.

## Going live

1. Rehearse as often as needed: load, compare with NetSuite, `resetJournal`,
   repeat.
2. Set `gl_companies.books_live_from` (planned 2027-01-01). This can't be
   undone.
3. Post the opening balances dated the day before, with
   `source_type = 'opening_balance'`, worked out from the copy of NetSuite's
   general ledger. When NetSuite's earlier months change after that (the
   CPA's year-end adjustments), the copy follows and the difference posts
   as another opening balance entry.
