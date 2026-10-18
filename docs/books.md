# FleetSuite books

FleetSuite is taking over the books from NetSuite: built hidden through the
end of 2026, run side by side with NetSuite for all of 2027, and the only
books from 2028-01-01 (owner decision 2026-10-09/10; the full plan is the
"Replacing NetSuite with FleetSuite" doc). It keeps two companies: BMG Fleet
Installations LLC and 1084 Cool Springs LLC, which owns the building.

This file covers part 1, the ledger core, part 2, the chart of accounts
copied from NetSuite, part 3, NetSuite's general ledger from 2025 copied
and checked month by month, part 4, the NetSuite lists the posting rules
need, part 5, the invoice rule, checked against NetSuite, part 6, every
BMG invoice since 2025 posted to FleetSuite's own journal with it, part 7,
credit memos, checked and posted the same way, the other way round,
part 8, customer payments, checked against NetSuite with the payment rule
and posted in the same run as invoices, part 9, a page that puts
FleetSuite's books next to NetSuite's and shows what still differs and why,
part 10, customer deposits and their applications, copied from NetSuite,
checked with the deposit rule and posted in the same run as invoices,
part 11, vendor bills and bill credits, copied from NetSuite, checked with
the bill rule and posted in the same run as invoices, and the bill
payments that pay them, copied from NetSuite, checked with the bill
payment rule and posted in the same run too, part 12, checks and
credit card charges and refunds, copied from NetSuite, checked with the
spending rule and posted in the same run as invoices, part 13,
NetSuite's journal entries, posted line for line from the copy of its
general ledger in the same run as invoices, part 14, its bank deposits
and transfers, posted the same way, part 15, the documents that move
its stock and book their cost, with the cost lines of its invoices and
credit memos, posted the same way too, part 16, the profit and loss,
balance sheet and trial balance from FleetSuite's own books, each next to
NetSuite's, part 17, its customer refunds, posted with its bank
deposits, part 18, 1084 Cool Springs' books, posted in the same run as
BMG's, part 19, a check each morning that tells the super admins when
a month stops matching NetSuite, and part 20, the documents behind each
account line on the reports.
The screens are the accounts page at `/admin/books`, the trial
balance at `/admin/books/trial-balance`, the lists at `/admin/books/lists`,
the invoices at `/admin/books/invoices`, the differences at
`/admin/books/differences`, the reports at `/admin/books/reports` and an
account line's detail at `/admin/books/reports/detail`, which only super
admins can
open. Only they see the Books entry on the More page (Admin), which opens
the accounts page; the others are linked from there.

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
| NetSuite's lists, copied | `migrations/363-books-netsuite-lists.sql`, `src/lib/books/netsuite-lists.ts` |
| Lists page and its API | `src/app/(main)/admin/books/lists/page.tsx`, `src/app/api/admin/books/lists/route.ts` |
| Lists tests | `src/lib/books/netsuite-lists.test.ts`, `src/lib/books/netsuite-lists-sql.test.ts` |
| Invoice rule and its check | `src/lib/books/invoice-rule.ts`, `src/lib/books/invoice-check.ts`, `src/lib/books/invoice-line-facts.ts`, `migrations/364-books-invoice-check.sql` |
| Invoices page and its API | `src/app/(main)/admin/books/invoices/page.tsx`, `src/app/api/admin/books/invoices/route.ts` |
| Invoice tests | `src/lib/books/invoice-rule.test.ts`, `src/lib/books/invoice-check.test.ts`, `src/lib/books/invoice-line-facts.test.ts`, `src/lib/books/invoice-check-sql.test.ts` |
| Invoices posted to the journal | `migrations/367-books-invoice-posting.sql`, `src/lib/books/invoice-posting.ts`, `src/app/api/cron/books-invoice-posting/route.ts` |
| Invoice posting tests | `src/lib/books/invoice-posting.test.ts`, `src/lib/books/invoice-posting-sql.test.ts` |
| Credit memos, checked and posted like invoices | `migrations/370-books-credit-memos.sql`, with the invoice files above; their tests are in the invoice test files |
| Payment rule and its check, on the invoices page | `src/lib/books/payment-rule.ts`, `src/lib/books/payment-check.ts`, `migrations/374-books-payment-check.sql` |
| Payments posted to the journal, with invoices | `migrations/376-books-payment-posting.sql`, `src/lib/books/invoice-posting.ts`; the mirror's delete sweep in `src/lib/ledger/netsuite-mirror.ts` |
| Payment tests | `src/lib/books/payment-rule.test.ts`, `src/lib/books/payment-check.test.ts`, `src/lib/books/payment-check-sql.test.ts`, `src/lib/books/payment-posting-sql.test.ts`; the posting decisions are in `invoice-posting.test.ts` |
| Differences vs NetSuite | `migrations/377-books-differences.sql`, `src/lib/books/differences.ts`, `src/app/(main)/admin/books/differences/page.tsx`, `src/app/api/admin/books/differences/route.ts` |
| Differences tests | `src/lib/books/differences.test.ts`, `src/lib/books/differences-sql.test.ts` |
| Invoices and credit memos in the month NetSuite booked them to | `migrations/380-books-netsuite-month.sql`, `entryDate` in `src/lib/books/invoice-check.ts`; their tests are in the invoice test files |
| Customer deposits, copied from NetSuite | `migrations/382-books-customer-deposits.sql`, `src/lib/books/netsuite-deposits.ts`, `src/app/api/cron/books-netsuite-deposits/route.ts`, `src/app/api/admin/books/deposits/route.ts` |
| Deposit rule and its check, on the invoices page | `src/lib/books/deposit-rule.ts`, `src/lib/books/deposit-check.ts` |
| Deposits posted to the journal, with invoices | `migrations/383-books-deposit-posting.sql`, `src/lib/books/invoice-posting.ts` |
| Deposit tests | `src/lib/books/deposit-rule.test.ts`, `src/lib/books/deposit-check.test.ts`, `src/lib/books/netsuite-deposits.test.ts`, `src/lib/books/deposits-sql.test.ts`, `src/lib/books/deposit-posting-sql.test.ts`; the posting decisions are in `invoice-posting.test.ts` |
| Vendor bills and bill credits, copied from NetSuite | `migrations/384-books-vendor-bills.sql`, `src/lib/books/netsuite-bills.ts`, `src/app/api/cron/books-netsuite-bills/route.ts`, `src/app/api/admin/books/bills/route.ts` |
| Bill rule and its check, on the invoices page | `src/lib/books/bill-rule.ts`, `src/lib/books/bill-check.ts`; where an item with no account posts: `migrations/385-books-bill-item-accounts.sql` |
| Bills posted to the journal, with invoices | `migrations/386-books-bill-posting.sql`, `src/lib/books/invoice-posting.ts` |
| Bill tests | `src/lib/books/bill-rule.test.ts`, `src/lib/books/bill-check.test.ts`, `src/lib/books/netsuite-bills.test.ts`, `src/lib/books/bills-sql.test.ts`, `src/lib/books/bill-posting-sql.test.ts`; the posting decisions are in `invoice-posting.test.ts` |
| Bill payments, copied from NetSuite | `migrations/389-books-bill-payments.sql`, `src/lib/books/netsuite-bill-payments.ts`, `src/app/api/cron/books-netsuite-bill-payments/route.ts`, `src/app/api/admin/books/bill-payments/route.ts` |
| Bill payment rule and its check, on the invoices page | `src/lib/books/bill-payment-rule.ts`, `src/lib/books/bill-payment-check.ts` |
| Bill payments posted to the journal, with invoices | `migrations/390-books-bill-payment-posting.sql`, `src/lib/books/invoice-posting.ts` |
| Bill payment tests | `src/lib/books/bill-payment-rule.test.ts`, `src/lib/books/bill-payment-check.test.ts`, `src/lib/books/netsuite-bill-payments.test.ts`, `src/lib/books/bill-payments-sql.test.ts`, `src/lib/books/bill-payment-posting-sql.test.ts`; the posting decisions are in `invoice-posting.test.ts` |
| Checks and credit card charges and refunds, copied from NetSuite | `migrations/391-books-checks-and-cards.sql`, `src/lib/books/netsuite-spending.ts`, `src/app/api/cron/books-netsuite-spending/route.ts`, `src/app/api/admin/books/spending/route.ts` |
| Spending rule and its check, on the invoices page | `src/lib/books/spending-rule.ts`, `src/lib/books/spending-check.ts` |
| Checks and card charges posted to the journal, with invoices | `migrations/392-books-spending-posting.sql`, `src/lib/books/invoice-posting.ts` |
| Check and card tests | `src/lib/books/spending-rule.test.ts`, `src/lib/books/spending-check.test.ts`, `src/lib/books/netsuite-spending.test.ts`, `src/lib/books/spending-sql.test.ts`, `src/lib/books/spending-posting-sql.test.ts`; the posting decisions are in `invoice-posting.test.ts` |
| Journal entry rule and its check, on the invoices page | `src/lib/books/journal-entry-rule.ts`, `src/lib/books/journal-entry-check.ts` |
| Journal entries posted to the journal, with invoices | `migrations/393-books-journal-entries.sql`, `src/lib/books/invoice-posting.ts` |
| Journal entry tests | `src/lib/books/journal-entry-rule.test.ts`, `src/lib/books/journal-entry-check.test.ts`, `src/lib/books/journal-entry-posting-sql.test.ts`; the posting decisions are in `invoice-posting.test.ts` |
| Bank deposits, transfers and customer refunds, checked and posted like journal entries | `migrations/394-books-bank-deposits.sql`, `migrations/399-books-customer-refunds.sql`, `src/lib/books/bank-rule.ts`, `src/lib/books/bank-check.ts`, `src/lib/books/invoice-posting.ts` |
| Bank deposit, transfer and refund tests | `src/lib/books/bank-check.test.ts`, `src/lib/books/bank-posting-sql.test.ts`; the posting decisions are in `invoice-posting.test.ts` |
| Fulfillments, item receipts, inventory adjustments and invoices' cost lines, checked and posted like journal entries | `migrations/395-books-stock-cost.sql`, `migrations/397-books-stock-postings-once.sql`, `src/lib/books/stock-rule.ts`, `src/lib/books/stock-check.ts`, `src/lib/books/invoice-posting.ts` |
| Stock and cost tests | `src/lib/books/stock-check.test.ts`, `src/lib/books/stock-posting-sql.test.ts`; the posting decisions are in `invoice-posting.test.ts` |
| Reports from FleetSuite's own books | `migrations/396-books-reports.sql`, `src/lib/books/reports.ts`, `src/app/(main)/admin/books/reports/page.tsx`, `src/app/api/admin/books/reports/route.ts` |
| Report tests | `src/lib/books/reports.test.ts`, `src/lib/books/reports-sql.test.ts` |
| Daily check, and its notification | `src/lib/books/daily-check.ts`, `src/app/api/cron/books-daily-check/route.ts`, `books_month_differs` in `src/lib/notification-registry.ts` |
| Daily check tests | `src/lib/books/daily-check.test.ts`, `src/lib/books/daily-check-sql.test.ts` |
| An account line's documents (report detail) | `migrations/400-books-report-detail.sql`, `src/lib/books/report-detail.ts`, `lineSpan` in `src/lib/books/reports.ts`, `src/lib/books/report-data.ts` (what Reports and the detail read), `src/app/(main)/admin/books/reports/detail/page.tsx`, `src/app/api/admin/books/reports/detail/route.ts` |
| Report detail tests | `src/lib/books/report-detail.test.ts`, `src/lib/books/report-detail-sql.test.ts`; `lineSpan`'s are in `src/lib/books/reports.test.ts` |
| Documents post to accounts NetSuite has made inactive since | `migrations/387-books-retired-accounts.sql`; its tests are in `src/lib/books/netsuite-accounts-sql.test.ts`, `src/lib/books/ledger-core-sql.test.ts` and the posting tests |

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
- A typed entry can't post to an inactive account either. Documents copied
  from NetSuite post to the accounts NetSuite posted them to, even ones it
  has made inactive since, and so do opening balances, which are worked out
  from the copy of NetSuite's general ledger (owner decision 2026-10-16,
  after twelve 2025 bills to 23700 Apex Commercial - Printer Loan were
  refused; migration 387). The checks against NetSuite are what hold those
  entries to NetSuite. A reversal may hit an account made inactive since
  its original posted. Once FleetSuite makes its own documents, whatever
  picks their accounts has to keep off inactive ones itself.
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
  follow NetSuite. An inactive account takes no typed entries, but
  documents copied from NetSuite still post to it.
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

## NetSuite's lists

The posting rules pick accounts the way NetSuite does, so they need what
NetSuite picks from (owner decision 2026-10-11). `syncBooksLists` copies
these lists, every two hours right after the chart of accounts in the same
cron, and from **Sync now** on the lists page:

| List | From NetSuite | Kept in `details` |
| --- | --- | --- |
| Locations | `location` | full name, subsidiary |
| Departments | `department` | full name |
| Classes | `classification` | full name |
| Terms | `term` | days until due, early payment discount and its days |
| Tax codes | `salestaxitem` | description, rate, tax type, tax agency |
| Vendors | `vendor` | default expense account, payables account, terms |
| Items | `item` | type, display name, income, asset and expense accounts |

Every row also keeps its NetSuite id, name, parent and inactive flag. They
all live in `gl_netsuite_lists` (migration 363), one row per list and
NetSuite id, and accounts are kept as NetSuite account ids, which
`gl_accounts.netsuite_account_id` names. Items leave out the tax items,
which are the tax codes. They keep the items that never post (descriptions,
subtotals, item groups), so the invoice rule can tell those lines from a
sale.

Items' COGS accounts aren't copied (owner decision 2026-10-11). NetSuite
answers 500 for `item.cogsaccount` every time in this account, and asking
for it sent every run into the slow field-by-field read below. Where an
item's cost posts comes from NetSuite's own fulfillments and invoices'
cost lines instead, which post from the copy of its general ledger as they
are ("Stock and cost"), so `details.cogs_account`, which migration 363
names, stays empty.

How a copy works:

- Each list is read whole with SuiteQL and handed to
  `gl_netsuite_lists_apply` in pages. A new row is added, and a row is
  rewritten only when something NetSuite holds for it changed.
- Once a list has been read whole, `gl_netsuite_lists_finish` marks what
  NetSuite no longer lists as gone (`gone_at`). Nothing is deleted, and a
  row comes back if NetSuite lists it again. A list that looks cut short
  (none, or under half of what's here) marks nothing.
- A list NetSuite won't give doesn't stop the others; the page says which
  and why. When NetSuite refuses a field by name, the list is read again
  without it and the page says what's missing. When it refuses without
  naming one, or answers 500 UNEXPECTED_ERROR (this account does that for
  some columns, as it did for the items' COGS account), the list is read
  field by field: the required fields, then each optional field on its
  own, so only the fields that fail are left out. SuiteQL shows little of
  tax codes, so every field of theirs but the id may be refused.
- In the cron the lists get the first 90 seconds of the run, items last, so
  the ledger mirror after them keeps most of its time. A list there wasn't
  time to start is copied by the next run.
- Which account a tax code posts to comes from what sales tax actually
  posted to: the copy counts sales tax's GL lines since 2025 (its tax lines)
  by tax code and account. That goes in the run's record, not the table.
- Where an item with no income account posts, a payment item say, comes
  from NetSuite's postings the same way. Such an item posts to an account
  of its own that the items copy doesn't read, so with the sales tax count
  the copy counts the invoice lines since 2025 whose item has no income
  account, by item and account (`ITEM_ACCOUNTS_QUERY`). That goes in the
  run's record too, and the items tab shows it.

The record of each run is `sync_state` `books_netsuite_lists`. Like the other
books jobs it is not a System Health monitor, and it carries counts, never
amounts.

The page also shows how many copied GL lines carry each location, department
and class, and which accounts the active items and vendors post to, so the
posting rules can be checked against what NetSuite actually does. Which of
the departments or classes FleetSuite's divisions (upfit, graphics, shared)
follow is decided with the posting rules.

Like the accounts, these are changed in NetSuite until the changeover.

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
  carry an amount, counted by transaction type so they can be found in
  NetSuite.
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

## Invoices

The first posting rule, `invoice@1` (`src/lib/books/invoice-rule.ts`), is
the plan's: accounts receivable takes the invoice's total, each line goes to
its item's income account, and sales tax goes to the account its tax code
posts to. During 2027 FleetSuite copies NetSuite's account choices exactly,
so the accounts come from the copied lists: each item's income account and,
for each tax code, the account its sales tax posted to most since 2025. An
item with no income account, a payment item say, goes to the account
NetSuite posted its invoice lines to most since 2025. The receivable is the
one receivable account the company can use. With more than one, it's the
one NetSuite's invoices used most that month, and the page says so.

- Lines that post nothing are skipped: a line of $0, and subtotal,
  description and item group lines, which repeat amounts. That's why the
  items copy keeps the items that never post. NetSuite's own lines, its
  subtotal say, carry an item id below 1 (the subtotal is item -2): none is
  a real item, so no item list has them, and they're skipped too.
- A discount line comes out as a debit to the discount item's account.
- A discount, markup or payment posts on a line of its own in NetSuite, to
  its item's account, while every other line posts at its own amount.
  That's so whether it's a line under the lines it applies to or set at the
  top of the invoice (a card fee say). NetSuite's net amount on each line
  (`netamount`, what the mirror keeps) already carries the line's share of
  it, though, and the discount's own line reads $0 net. So every line takes
  its own amount (`foreignamount`), as long as the own amounts add up to the
  net ones, so the total stays as it was (`withOwnAmounts` in
  `invoice-check.ts`). A discount or payment bigger than the line it applies
  to leaves that line's net amount a credit, the other way round from its
  own amount; that's fine. When the own amounts don't add up, a discount set
  at the top (`transactiondiscount`) with no amount of its own takes the
  difference; without one, the invoice keeps its net amounts and the page
  names it. Tax, lines that never post (a subtotal repeats the shares it
  adds up), the cost of goods NetSuite flags and a stock item's line of $0
  (an inventory or assembly item, where NetSuite may book the stock's cost)
  keep their amounts.
  Opening an invoice shows what NetSuite says about each line: its own
  amount, its net amount, quantity × rate and its flags. That reading of
  NetSuite's columns was worked out from the first checks, not from
  NetSuite's documentation.
- Each line is filed Upfit or Graphics by the owner's rule of 2026-10-06
  (`src/lib/division-revenue.ts`). Tax, discounts, freight, items with no
  income account and the receivable get no division.
- An invoice posts whole or not at all. When a line can't be worked out (an
  item not in the copy yet, an item with no income account that NetSuite
  hasn't posted on an invoice since 2025, a tax code whose account isn't
  known, a line with an amount but no item, no receivable account), the rule
  says why and posts nothing.

The check came first (owner's choice 2026-10-11), and invoices post once
it showed every BMG invoice since 2025 matching NetSuite (2026-10-13; see
Posting invoices below). For every NetSuite invoice, `/admin/books/invoices` works out the rule's entry and
checks it line by line against the GL lines NetSuite posted for the same
invoice, to the cent: the receivable against NetSuite's main line (line 0),
every other line by NetSuite's line id. Migration 364's
`gl_invoice_month(company, month)` reads one month: the invoices NetSuite
booked into it (since migration 380; before, the invoices dated in it), and
those dated in it that the GL copy has booked into no month, from the ledger
mirror (migration 314) with their lines, NetSuite's GL lines
for each from the copy (migration 361), and the copied items and tax codes
the lines name. The page shows how many invoices match, differ, can't be
worked out or are waiting on a copy, why the others don't match, and each
invoice side by side with NetSuite. **Check every month** runs the same
count for every month from January 2025.

- An invoice is a company's when NetSuite posted a GL line of it to that
  company. Invoices with no GL line in the copy (waiting for approval, which
  doesn't post, or newer than the last copy) are named in a note, not
  counted.
- The copy of an invoice and the GL copy are read at different times, and
  can number the same line differently (seen 2026-10-15 on an invoice's
  sales tax lines). So a line only the copy of the invoice has and a line
  only NetSuite's GL has, on the same account for the same amount, count as
  one line under the copy's number, each NetSuite line once (owner decision
  2026-10-15); the page shows NetSuite's number under it. A line whose
  account or amount differs still differs, and so does a line both copies
  have. Posting doesn't change: it goes by the copy's lines.
- An invoice that wasn't fulfilled first relieves the stock itself: NetSuite
  books its cost on lines of their own, one to a cost of goods account and
  one to an inventory asset account. FleetSuite posts that cost with the
  stock rule ("Stock and cost"), so the check leaves those lines out of the
  invoice's entry and doesn't compare them, and the page says they post
  under Stock and cost. They're the lines NetSuite flags itself
  (`iscogs`), and any NetSuite posts to a cost of goods sold account or to
  the item's inventory asset account (unless the line goes to the account
  the rule posts its item to), which covers them when the flag can't be
  read. The page counts the invoices that have them.
- Which lines are cost of goods, which line is a discount set at the top,
  and each line's own amount aren't in the copy of the invoice: the
  mirror's line read doesn't ask for them, and having it ask would mean
  reading every invoice again. So each time a month is checked, the API asks
  NetSuite for them, for that month's invoices
  (`src/lib/books/invoice-line-facts.ts`, `transactionline.iscogs`,
  `transactiondiscount` and `foreignamount`, plus `quantity` and `rate`,
  only to show). A column NetSuite won't give is
  left out, and when NetSuite can't be asked at all the check goes without;
  the page says which. Posting asks NetSuite the same way, and leaves a
  month alone when it can't.
- The mirror keeps NetSuite's signed `netamount` in each line's `raw`, where
  a sale is negative. A line whose amount it didn't keep can't be worked
  out.

### Credit memos

A credit memo is the invoice rule the other way round, `credit_memo@1`
(owner decision 2026-10-14): revenue and sales tax debited, receivables
credited. The working out is the same: the mirror keeps a credit memo's
lines' `netamount` positive where an invoice's is negative, so each line
debits its item's income account or its tax code's account and the
receivable takes the credit.

The page's **Invoices / Credit memos** switch checks credit memos month by
month just as it checks invoices, against the GL lines NetSuite posted for
each, and **Check every month** counts whichever is showing. Migration 370's
`gl_invoice_month` returns both kinds, each with its `doc_type`, and the API
keeps the kind asked for (`kind=credit_memo`). A credit memo that takes
stock back books the stock's cost coming back on lines of its own, a debit
to an inventory asset account and a credit to cost of goods; like an
invoice's cost lines, they're left out of the entry, not compared, and
counted.

## Posting invoices

Every BMG invoice NetSuite booked into a month from January 2025 that the
rule can work out posts to FleetSuite's own journal once, as Invoices vs
NetSuite shows it, whether it matches NetSuite or not (owner decision
2026-10-13): during 2027 the differences are what the side-by-side run is
for.

Each posts in the month NetSuite booked it to (owner decision 2026-10-15,
migration 380). The Differences page showed why that matters. Invoices
dated in 2023 and 2024 that NetSuite carried into January 2025 had never
posted, since FleetSuite's books start then. An invoice entered after its
own month had closed sat in its own month in FleetSuite but in a later one
in NetSuite. The entry keeps the invoice's date when that falls in
NetSuite's month. Otherwise it takes the month's first day, or its last
when NetSuite booked it into an earlier month (`entryDate` in
`src/lib/books/invoice-check.ts`). Invoices vs NetSuite lists such an
invoice under NetSuite's month, marked with it. 1084's post the same way,
in the same run (Both companies, below). Nothing is written to NetSuite.

Credit memos post in the same run, the same way (owner decision
2026-10-14), with the rule `credit_memo@1` and keys of their own
(`credit_memo:<NetSuite id>:<n>`); what follows about invoices goes for
them too. A credit memo's receivable must come to its total as a credit, so
one whose copied lines come out any other way keeps whatever it has, like an
invoice caught mid-refresh.

It runs every two hours (`/api/cron/books-invoice-posting`, :48 on odd
hours, after the GL copy at :26 and the ledger mirror's invoices at :35 on
even hours) and from **Post now** on the invoices page. Each run goes
through every month again:

- An invoice with no entry gets one, dated as above and keyed
  `invoice:<NetSuite id>:1`.
- An invoice whose entry no longer fits what the rule works out now (an
  account, amount, division, line, customer or date changed in NetSuite, or
  the month NetSuite booked it into, or the copies of its lines, items or
  GL) has its entry reversed and the
  new one posted under the next generation's key, in one transaction
  (`gl_repost_entry`, migration 367), so an invoice is never left with its
  old entry reversed and no new one. A new memo or item name alone changes
  nothing.
- An invoice NetSuite voids or deletes has its entry reversed, dated as the
  entry was. So does one that now comes to nothing.
- An invoice the rule can't work out yet, whose lines aren't copied yet, or
  whose lines in the copy don't add up to its total (caught mid-refresh)
  keeps whatever it has, and the next run looks again. The run's notes name
  the ones that don't add up.
- A month whose invoice lines NetSuite couldn't be asked about, or where it
  wouldn't say which lines are cost of goods, which is a discount set at
  the top, or the lines' own amounts, is left as it is, since its entries
  could come out different without them. The run's notes say which months.
- An invoice posting to an account the chart doesn't have yet, or one the
  journal refuses (an account limited to the other company, say), isn't
  posted. The run lists a few by number, with why. An account NetSuite has
  made inactive since still takes what NetSuite posted to it.

The receivable line carries the invoice's customer in FleetSuite, as the
ledger mirror matched it (`customer_id`, which `gl_invoice_month` now
returns). Migration 367's `gl_invoice_postings` reads what the journal holds
for each invoice: the entry that stands and its lines, every earlier entry
and what reversed it, and whether the copy of NetSuite's invoices says it's
deleted or voided. Migration 370 has it read credit memos' entries too,
each with its kind (`source_type`), looked up in the copy of NetSuite's
documents of that kind; `gl_repost_entry` won't replace an entry with one of
the other kind. Should a second entry ever stand for one invoice, the older
is reversed.

The run takes the GL copy's lock (`gl_netsuite_claim_copy`): it reads that
copy, so it never runs while the copy changes it, and two runs never
overlap. Whichever comes second does nothing and says "Another books job is
running." A read that fails stops the run, and its error, which the
invoices page shows, says what it was reading: "Reading the journal's
entries for BMG's stock and cost: canceling statement due to statement
timeout", say. The first run posts every invoice since 2025 and may take more
than one run: a run stops within its budget between months, or before a
write with under five seconds left, and the next carries on from the month
it stopped at (`sync_state` `books_invoice_posting`). Like the other books
jobs that record isn't a System Health monitor, and neither it nor the
cron's response carries any amount.

On the invoices page each invoice shows its entry ("Entry 12") and what the
next run will do to it: post, replace or reverse. Opening it lists its
earlier entries and what reversed them. One with no entry standing that
NetSuite voided, or that comes to $0, reads "Nothing to post" (owner
decision 2026-10-16), on every switch: each month counts those apart from
the ones in the books, and after Check every month the banner says how many
have nothing to post and why, so books that hold fewer documents than
NetSuite has explain themselves. The list of the ones that don't match or
aren't posted as they should be leaves them out. Until a company's books go
live the journal can be emptied (`resetJournal`), and the next run posts
every invoice again.

## Both companies

1084 Cool Springs' books post in the same run as BMG's (owner decision
2026-10-18, thread "Replacing NetSuite with FleetSuite", "1084's books"),
once its journal entries, the only kind of document Differences vs
NetSuite showed for it, matched NetSuite: Check every month on the Journal
entries switch, with 1084 Cool Springs picked, was green in every month. `POSTING_COMPANIES` in
`src/lib/books/invoice-posting.ts` names the companies that post. A run
goes through BMG's months, then 1084's, and carries on from the company and
month it stopped at. Everything this file says of BMG's documents holds for
1084's: each posts as 1084's, to 1084's accounts and the ones both
companies may use, and the journal refuses one on an account limited to
BMG, which the run names with why.

The journal takes each idempotency key once, whatever the company, so
1084's entries carry the company in front of their keys
(`1084:journal_entry:<NetSuite id>:<n>`, and so on for every kind) while
BMG's keep the form this file gives them (`entryKey`). A document with
lines for both companies, such as an entry between the two, posts once for
each: each company's lines are that company's entry, under its own key, and
a company whose lines don't balance on their own keeps whatever it has.
Keyed without the company, the second company's entry would have been taken
for the first's, already posted, and never written.

One run's record covers both companies, so its notes and the documents it
couldn't post name 1084's with the company in front ("1084's JE1207"); the
entries' memos keep the number alone. A run cut short for time says how many
months it went through, counting each company's. With 1084 posting,
Invoices vs NetSuite shows its Books column and Post now, Differences vs
NetSuite counts what it posts, and Reports says how many of its months
match NetSuite rather than that its side holds only the starting balances.

The posting tests run BMG's books alone where they show another company's
documents left out (`deps.companies`); "once 1084 posts too" in
`src/lib/books/journal-entry-posting-sql.test.ts` runs both.

## Payments

The payment rule, `payment@1` (`src/lib/books/payment-rule.ts`), is the
plan's: the money goes to the account the payment was deposited to,
Undeposited Funds or a bank account, and receivables are credited with the
payment's total, for its customer. Where the money went is the payment's own
choice, as an invoice line's item is. The ledger mirror's copy of the
payment (migration 314's `ledger_payments`) doesn't keep it, so it comes
from NetSuite's posting of the payment: the account its main line debits,
or, should that line be missing or a receivable, the one account outside
receivables, income and expenses NetSuite debits for it. The receivable is
the company's, picked as for invoices; with more than one, it's the one
NetSuite's payments used most that month. A payment of $0, one that only
applies a credit to an invoice, posts nothing.

A discount the customer took goes to the account NetSuite booked it to, and
receivables are credited with the money plus the discount, since that's what
paid the invoices (owner decision 2026-10-15, after the check showed
discounted payments differing). The copy of the payment doesn't keep the
discount either, so it comes from NetSuite's posting the same way: what
NetSuite debits to the one income or expense account it debits for the
payment, other than where the money went. A payment of $0 that only takes a
discount posts the discount alone.

The check came first (owner decision 2026-10-14), as it did for invoices.
The **Payments** switch on the invoices page checks every NetSuite customer
payment against the GL lines NetSuite posted for it, account by account, to
the cent. NetSuite's lines on one account are added together, since it may
take a payment off receivables on a line for each invoice it pays.
Migration 374's `gl_payment_month(company, month)` reads one month: the
payments dated in it from the ledger mirror, with what each was applied to
and NetSuite's GL lines for each from the copy (migration 361). Opening a
payment shows what it was applied to, its entry in FleetSuite's books and
what the next posting run does about it.

- A payment is a company's when NetSuite posted a GL line of it to that
  company. Payments with no GL line in the copy are named in a note, not
  counted.
- Anything else NetSuite posts for a payment shows as a line FleetSuite's
  entry doesn't have. So does a discount split across two income or
  expense accounts, since neither is then plainly the discount.
- Customer deposits, and applying them to invoices, are NetSuite documents
  of their own, checked and posted on their own ("Customer deposits"
  below). Bank
  deposits, which move the money from Undeposited Funds to the bank, aren't
  copied yet.

### Posting payments

Every BMG customer payment dated from January 2025 that the rule can work
out posts to FleetSuite's journal in the same run as invoices and credit
memos, the same way (owner decision 2026-10-15): once, dated as the payment
is, with the rule `payment@1` and keys of its own
(`payment:<NetSuite id>:<n>`), the receivable line carrying the payment's
customer. When NetSuite changes what a payment posts (where the money went,
the discount, the amount, the customer or the date) its entry is reversed
and the new one posted in one transaction; a new number or memo alone
changes nothing. A payment NetSuite voids or deletes has its entry reversed,
and so does one that comes to nothing now. NetSuite posts no GL lines for a
$0 payment, so a payment in neither company's GL copy is still looked at
while an entry of it stands: at $0 its entry is reversed, otherwise the copy
hasn't caught up and it keeps its entry. A payment the rule can't work out
keeps whatever it has too, and the next run looks again. 1084's payments
post the same way (Both companies).

Migration 376's `gl_payment_postings` reads what the journal holds for each
payment, as `gl_invoice_postings` does for invoices: the entry that stands
and its lines, every earlier entry and what reversed it, and whether the
ledger mirror's copy of the payment says it's deleted or voided.

The mirror marks payments NetSuite deleted the way it marks invoices
(`src/lib/ledger/netsuite-mirror.ts`, at the end of phase 3). Once the
payments pass has nothing left to read, the same delete sweep asks NetSuite
which mirrored payments still exist, 150 at a time, marks the rest deleted,
and marks voided the ones whose NetSuite status says Voided, carrying on
from `paymentTombstoneAfter` when it runs out of time. A payment NetSuite
returns again is no longer marked deleted. A sweep in which not one payment
comes back is read as a narrowed SuiteQL role, as for invoices, and marks
nothing (`payments.problem` in the mirror's last result says so). Whether
NetSuite's status for a voided customer payment reads Voided, as an
invoice's does, hasn't been seen yet.

## Customer deposits

A customer deposit (NetSuite's CustDep) is money a customer pays ahead of
an invoice; a deposit application (DepAppl) applies a deposit to an invoice,
or to a refund. Both are copied from NetSuite, checked against its GL with
the deposit rule (owner decision 2026-10-15), and posted to FleetSuite's
journal in the same run as invoices and payments ("Posting deposits"
below).

### Copying deposits

The ledger mirror doesn't copy deposits, so the books copy them themselves
(`src/lib/books/netsuite-deposits.ts`, into migration 382's
`gl_netsuite_deposits`): every two hours at :16 on odd hours
(`/api/cron/books-netsuite-deposits`), or when **Copy now** is pressed on
the invoices page's Deposits switch, which runs the same job with the same
four minutes. They aren't kept with the mirror's payments in
`ledger_payments`: the mirror's delete sweep would mark them deleted there,
and `gl_payment_month` would check them as payments.

The run works like the estimates copy. It reads the documents NetSuite
changed since the last run that finished, a day's overlap included (the
first reaches back to 2000), newest first, 200 at a time, and saves its
place after each page, so the first copy can span runs and a run cut short
picks up where it stopped. For each page it reads what each document
applies from NetSuite's transaction link table (`nexttransactionlinelink`,
or `previoustransactionlinelink` when the account refuses the first, the
pair the ledger mirror probes), with the type and number of each document
linked: an application's deposit and invoices, a deposit's sales order.
Two link rows for the same pair of documents are added together. When
NetSuite answers neither table, the documents are copied without links,
the ones already copied keep theirs, and the run says so.

Once a run has read everything changed, it lists every deposit and
application id NetSuite has and marks the ones NetSuite no longer has as
gone (`gone_at`); a list with none, or with under half of what the copy
holds, is read as cut short and marks nothing. A document NetSuite lists
again is back. Rows are never deleted, nothing is written to NetSuite, and
the run's record in `sync_state` (`books_netsuite_deposits`) holds counts
and words, never an amount.

### The deposit rule

The deposit rule, `deposit@1` (`src/lib/books/deposit-rule.ts`):

- A deposit debits the account its money went to, Undeposited Funds or a
  bank account, and credits customer deposits, with its total. Where the
  money went is the deposit's own choice, so it comes from NetSuite's
  posting of the deposit, as a payment's does.
- An application debits customer deposits and credits receivables with
  what it applies.
- A document of $0, a voided one, posts nothing.

Customer deposits is the company's account that NetSuite's deposits credit
and its applications debit, for the most of the company's documents in the
GL copy; a receivable, income or expense account never is, and a tie goes
to the lower NetSuite id. With more than one in use, the page says which
was taken. The receivable is the company's, picked from the month's
applications as it is from a month's payments.

### Checking deposits

The **Deposits** switch on the invoices page checks each deposit and
application dated in the month against the GL lines NetSuite posted for it,
account by account, to the cent, as payments are checked
(`src/lib/books/deposit-check.ts`). Migration 382's
`gl_deposit_month(company, month)` reads the month from the copy: each
document with what it applies, a deposit's applications (found through
their links), and NetSuite's GL lines for it from the GL copy. Opening one
shows NetSuite's status for it, what it applies or what its applications
applied it to, and the rule's lines next to NetSuite's. Above the list the
page says when the copy last ran and how it went.

- A document is a company's when NetSuite posted a GL line of it to that
  company, as for payments; one in neither company's GL copy isn't counted,
  and is named in a note unless it comes to $0.
- A note also names the documents the GL copy has in the month that the
  deposits copy doesn't have yet.

Not yet seen in NetSuite's data, so the check is what will show it:

- that a deposit puts its money on its main line and credits one customer
  deposits account, and an application debits that account and credits
  receivables;
- that an application lists its deposit and the invoices it pays as its
  previous documents in the link table, and a deposit its sales order;
- that a voided deposit's status reads Voided, and which way NetSuite signs
  the documents' totals (the copy keeps them positive);
- that refunding a deposit goes through an application.

Refunds themselves (CustRfnd) aren't copied: they post with bank deposits
(Deposit) from the copy of NetSuite's general ledger ("Bank deposits,
transfers and refunds").

### Posting deposits

Every BMG customer deposit and deposit application dated from January 2025
that the rule can work out posts to FleetSuite's journal in the same run as
invoices and payments, the way payments do (owner decision 2026-10-15,
after the deposits check): once, dated as the document is, with the rule
`deposit@1`. A deposit's entries are filed as `customer_deposit` and keyed
`customer_deposit:<NetSuite id>:<n>`, an application's as
`deposit_application`. The customer deposits line, and an application's
receivable, carry the document's customer: the FleetSuite customer the
ledger mirror matched its NetSuite customer to (`ledger_customers`, an
exact match, the one the mirror gives the customer's invoices and payments),
or none until it has one.

When NetSuite changes what a document posts (where a deposit's money went,
the amount, the date or the customer) its entry is reversed and the new one
posted in one transaction; a new number, memo or status alone changes
nothing. One NetSuite voids, or no longer has (the copy marks it gone), has
its entry reversed, and so does one that comes to nothing now. As for
payments, one in neither company's GL copy is still looked at while an
entry of it stands: at $0 its entry is reversed, otherwise the GL copy
hasn't caught up and it keeps its entry. One the rule can't work out keeps
whatever it has, and the next run looks again. 1084's post the same way
(Both companies).

Migration 383's `gl_deposit_postings` reads what the journal holds for each
deposit and application, as `gl_payment_postings` does for payments, and
whether the copy of the deposits says it's voided or gone; its
`gl_deposit_month` adds each document's FleetSuite customer. The Deposits
switch on the invoices page shows the Books column and Post now, as the
other switches do.

## Vendor bills

A vendor bill (NetSuite's VendBill) is what BMG owes a vendor; a bill
credit (VendCred) takes some of it back. Both are copied from NetSuite with
their lines and checked against its GL with the bill rule (owner decision
2026-10-16), as deposits were before they posted, and once the check showed
the rule matching, both post to FleetSuite's journal (owner decision
2026-10-16, "Post bills").

### Copying bills

The ledger mirror's `ledger_bills` (migration 314) holds QuickBooks' bills,
and its delete sweep takes the NetSuite rows of its tables for its own
documents, so the books copy bills themselves
(`src/lib/books/netsuite-bills.ts`, into migration 384's
`gl_netsuite_bills`): every two hours at :39 on odd hours
(`/api/cron/books-netsuite-bills`), done by :43, before the posting run at
:48, or when **Copy now** is pressed on the invoices page's Bills switch,
which runs the same job with the same four minutes.

The run works like the deposits copy: the documents NetSuite changed since
the last run that finished, a day's overlap included (the first reaches
back to 2000), newest first, 200 at a time, with its place saved after each
page. For each page it reads:

- each document's lines but the payables line, from `transactionline`: the
  item, the expense account (`expenseaccount`, on an expense line), the net
  amount (`netamount`, which shares a discount line's amount out over the
  lines above it) and the line's own amount (`foreignamount`), quantity,
  memo and whether it's a tax line. When NetSuite won't give the expense
  account, the lines are copied without it and the run says so; when it
  won't give the lines at all, the documents already copied keep theirs. A
  document with a line that has no line id keeps the lines it has, and is
  named.
- the documents each came from, in NetSuite's transaction link table (the
  pair the deposits copy probes): a bill's purchase order and item
  receipts, a bill credit's vendor return, and line by line (`nextline`)
  which of the document's own lines each link is on. When NetSuite won't
  say line by line, the links are read document by document and the run
  says so; when it answers neither table, the documents already copied
  keep their links.

What the copy keeps has a version (`COPY_VERSION`, in the run's record).
When it goes up, the next run starts over from the first bill, ignoring an
older run's place and window, so the documents copied before get the new
detail too. Version 2 (2026-10-16) added the own amounts and the lines each
link is on.

The status and vendor in words come from `BUILTIN.DF`; without them,
voided ones aren't marked voided and vendors are named from the copy of
NetSuite's vendors, which `gl_bill_month` prefers anyway. Once a run has
read everything changed, it lists every bill and bill credit id NetSuite
has and marks the ones it no longer has as gone, with the same guard
against a list that looks cut short. Rows are never deleted, nothing is
written to NetSuite, and the run's record in `sync_state`
(`books_netsuite_bills`) holds counts and words, never an amount. Totals
are kept positive; lines keep NetSuite's signs.

### The bill rule

The bill rule, `bill@1` (`src/lib/books/bill-rule.ts`):

- Payables are credited with the bill's total: the vendor's own payables
  account (the vendors copy) when the company can use it, else the
  company's only one; with more than one, the one the month's NetSuite
  bills used most, and the page says so.
- An expense line, an installer's labor say, is debited to its own account.
- A stock item (inventory or an assembly) is debited to the account
  NetSuite holds received stock against until it's billed, when the line
  came from a purchase order's or item receipt's line and the company's
  item receipts post to such an account; otherwise to the item's asset
  account, as the bill itself brings the stock in: a line added on a
  purchase order's bill, say. When NetSuite doesn't say which lines a link
  is on (or names none of the document's own lines, only its payables
  line), the bill as a whole goes: every stock line is received when it
  came from a purchase order or receipt. The received account is the
  liability the company's item receipts credit, for the most of its
  receipts in the GL copy.
- Any other item (non-stock, service, other charge) is debited to its
  expense account; a discount or markup to its own account. An item the
  copy of NetSuite's items has no such account for (a discount, whose
  account the items copy doesn't read, say) goes where NetSuite's GL posted
  most of its lines on the copied bills, the lower NetSuite id on a tie
  (migration 385's `gl_bill_item_accounts`).
- Each line goes in at its own amount, a discount as a credit on a line of
  its own, as NetSuite books it; its net amount has the discount shared out
  over it, and the discount line reads $0 net. That's so as long as the
  own amounts come to the same as the net ones, either way round
  (`withOwnBillAmounts` in `bill-check.ts`), and the bill's detail says so.
  When they don't, the net amounts go and the month names the bill; a line
  copied before version 2, with no own amount, keeps its net amount too.
  Tax and lines that never post keep their amounts.
- A bill credit posts the same way, the other way round: its signed amounts
  carry the direction. A bill credit's stock counts as ordered when it came
  from a vendor return or its shipment.
- A line of $0, and a subtotal, description or item group line, post
  nothing. A tax line, an expense line with no account, an item not in the
  copy of NetSuite's items or with no account of the kind it needs, ordered
  stock whose links haven't been copied, or no payables account: the
  document can't be worked out, and posts nothing.

Which way NetSuite signs bill lines isn't assumed: the month's documents
say (a bill's lines come to more than nothing, a bill credit's to less),
and the check turns them round when most of them say the other way.

### Checking bills

The **Bills** switch on the invoices page checks each bill and bill credit
NetSuite booked into the month (or, when it hasn't booked one, dated in it)
against the GL lines NetSuite posted for it, account by account, to the
cent, as deposits are checked (`src/lib/books/bill-check.ts`). Migration
384's `gl_bill_month(company, month)` reads the month from the copy: each
document with its lines and links, its vendor's name and payables account
from the vendors copy, and NetSuite's GL lines for it; the items its lines
name; the accounts the company's item receipts credit across the GL copy;
and the GL copy's bills and bill credits the bills copy doesn't have yet.
Opening one shows NetSuite's status for it, what it came from, its lines,
and the rule's accounts next to NetSuite's. Where FleetSuite and NetSuite
put the same amount in different accounts, the page gives it as one reason
(FleetSuite used this, NetSuite that).

The owner's first look at the check (2026-10-16) found two bills that
didn't match: one with a discount, which NetSuite booked at the lines' own
amounts with the discount on its own line, and one with a stock line added
on a purchase order's bill, which NetSuite put in the item's asset account
while the lines from the order went to received stock. The rule above
takes both (owner decision 2026-10-16, "Fix both"). Not yet seen in
NetSuite's data, so the check is what will show it:

- that `transactionline.expenseaccount` gives an expense line's account,
  and `netamount` and `foreignamount` are in BMG's own currency, as the GL
  is (a bill in another currency is the one to look at: its own amounts
  wouldn't add up, so it keeps its net ones);
- whether NetSuite puts non-stock items received on a receipt in the
  account the receipts credit (the rule sends those to their expense
  account);
- that a bill credit links its vendor return;
- whether BMG's bills have tax lines or landed costs.

Bill payments are copied and checked on their own ("Bill payments"
below).

### Posting bills

Every BMG vendor bill and bill credit NetSuite booked into a month from
January 2025 that the rule can work out posts to FleetSuite's journal in
the same run as invoices, whether it matches NetSuite or not, as invoices
do (owner decision 2026-10-16, after the bills check): once, in the month
NetSuite booked it into, dated as an invoice is (`entryDate`), with the
rule `bill@1`. A bill's entries are filed as `vendor_bill` and keyed
`vendor_bill:<NetSuite id>:<n>`, a bill credit's as `vendor_credit`. Each
of the rule's lines is a line of the entry, with its NetSuite line id
(`source_line_ref`) and item, and the payables line carries the vendor: its
NetSuite internal id, in `vendor_ref`, as FleetSuite's other tables name
NetSuite vendors (`netsuite_vendors.netsuite_id`).

When NetSuite changes what a document posts (an account, an amount, a
line, the vendor, the date or the month it's booked into, or the copies of
its lines, items or GL) its entry is reversed and the new one posted in one
transaction; a new number, memo, status or vendor name alone changes
nothing. One NetSuite voids, or no longer has (the copy marks it gone), has
its entry reversed, and so does one that comes to nothing now. A bill's
payables must come to its total as a credit, a bill credit's as a debit, so
one whose copied lines come out any other way (caught mid-refresh, or
signed the other way round) keeps whatever it has, and the run's notes
name it, as for invoices. One the rule can't work out, or whose lines or GL
lines aren't copied yet, keeps whatever it has too, and the next run looks
again. As for payments, one in neither company's GL copy (a bill waiting
for approval posts nothing) is looked at only while an entry of it stands.
1084's post the same way (Both companies).

The posting job and the Bills switch read a month the same way
(`readBillMonth` in `src/lib/books/invoice-posting.ts`: `gl_bill_month`,
and `gl_bill_item_accounts` for items with no account), so what the page
shows is what posts. Migration 386's `gl_bill_postings` reads what the
journal holds for each bill and bill credit, as `gl_deposit_postings` does
for deposits, and whether the copy of the bills says it's voided or gone.
The Bills switch shows the Books column and Post now, as the other
switches do. Not yet seen in NetSuite's data: a bill in another currency,
whose total the copy keeps in that currency; should its lines be in BMG's,
it won't come to its total and stays unposted, named in the run's notes.

## Bill payments

A bill payment (NetSuite's VendPymt) pays what BMG owes a vendor: it takes
the bills it pays off payables, and the money comes out of the account it
was paid from. Bill payments are copied from NetSuite with the bills each
one paid and checked against its GL with the bill payment rule (owner
decision 2026-10-16, "Bill payments"), as bills were before they posted,
and post to FleetSuite's journal in the same run as invoices ("Posting
bill payments" below).

### Copying bill payments

The ledger mirror copies only customer payments from NetSuite, so the books
copy bill payments themselves (`src/lib/books/netsuite-bill-payments.ts`,
into migration 389's `gl_netsuite_bill_payments`): every two hours at :21
on odd hours (`/api/cron/books-netsuite-bill-payments`), done by :25, after
the deposits copy and before the GL copy at :26, or when **Copy now** is
pressed on the invoices page's Bill payments switch, which runs the same
job with the same four minutes.

The run works like the deposits copy: the payments NetSuite changed since
the last run that finished, a day's overlap included (the first reaches
back to 2000), newest first, 200 at a time, with its place saved after
each page. For each page it reads what each payment paid from NetSuite's
transaction link table (the pair the deposits copy probes), with the type
and number of each bill or bill credit paid; when NetSuite answers neither
table, the payments already copied keep what they had. A payment's lines
aren't read: the rule needs only NetSuite's posting of it. The status and
payee in words come from `BUILTIN.DF`; without them, voided ones aren't
marked voided and vendors are named from the copy of NetSuite's vendors,
which `gl_bill_payment_month` prefers anyway. Once a run has read
everything changed, it lists every bill payment id NetSuite has and marks
the ones it no longer has as gone, with the same guard against a list that
looks cut short. Rows are never deleted, nothing is written to NetSuite,
and the run's record in `sync_state` (`books_netsuite_bill_payments`)
holds counts and words, never an amount. Totals are kept positive.

### The bill payment rule

The bill payment rule, `bill_payment@1`
(`src/lib/books/bill-payment-rule.ts`), is the payment rule the other way
round:

- Payables are debited with what the payment paid off: the money plus any
  discount taken. The payables account is picked as the bill rule picks
  it: the vendor's own payables account (the vendors copy) when the
  company can use it, else the company's only one; with more than one, the
  one the month's NetSuite bill payments used most, and the page says so.
  So a payment takes what it pays out of the account its vendor's bills
  put it in.
- The money comes out of the account the payment was paid from, a bank
  account or a credit card. That's the payment's own choice, and the copy
  of the payment doesn't keep it, so it comes from NetSuite's posting of
  the payment: the account its main line credits, or, should that line be
  missing or payables, the one account outside payables, income and
  expenses NetSuite credits for it.
- A discount BMG took goes to the account NetSuite booked it to: what
  NetSuite credits to the one income or expense account it credits for the
  payment, other than where the money came from.
- A payment of $0 with no discount, one that only applies a bill credit to
  a bill, posts nothing. A payment whose total can't be read, or whose
  money NetSuite's posting doesn't place, or a company with no payables
  account: it can't be worked out, and posts nothing.

### Checking bill payments

The **Bill payments** switch on the invoices page checks each bill payment
NetSuite booked into the month (or, when it hasn't booked one, dated in
it) against the GL lines NetSuite posted for it, account by account, to
the cent, as customer payments are checked
(`src/lib/books/bill-payment-check.ts`). NetSuite's lines on one account
are added together. Migration 389's `gl_bill_payment_month(company,
month)` reads the month from the copy: each payment with what it paid, its
vendor's name and payables account from the vendors copy, and NetSuite's
GL lines for it; and the GL copy's bill payments the copy doesn't have
yet. Opening one shows NetSuite's status for it, the bills it paid and the
rule's accounts next to NetSuite's.

- A payment is a company's when NetSuite posted a GL line of it to that
  company. Payments with no GL line in the copy are named in a note, not
  counted.
- Anything else NetSuite posts for a payment shows as a line FleetSuite's
  entry doesn't have. So does a discount split across two income or
  expense accounts, since neither is then plainly the discount.
- Where FleetSuite and NetSuite take the payment off different payables
  accounts, the page gives it as one reason (FleetSuite used this,
  NetSuite that).

Not yet seen in NetSuite's data, so the check is what will show it:

- that NetSuite's link table lists the bills a payment paid with the
  payment as the next document, as it does for customer payments;
- whether BMG pays bills by credit card, and where NetSuite books a
  discount BMG took;
- a payment in another currency, whose total the copy keeps in that
  currency while NetSuite's GL is in BMG's: it would show as differing
  from what NetSuite took out of the account it was paid from, and since
  a payment posts as the rule works it out, Differences would show it too.

### Posting bill payments

Every BMG bill payment NetSuite booked into a month from January 2025 that
the rule can work out posts to FleetSuite's journal in the same run as
invoices, whether it matches NetSuite or not, as bills do (owner decision
2026-10-16, after the bill payments check): once, in the month NetSuite
booked it into, dated as a bill is (`entryDate`), with the rule
`bill_payment@1`. Its entries are filed as `bill_payment` and keyed
`bill_payment:<NetSuite id>:<n>`. The entry's lines are payables, where
the money came from and any discount (`source_line_ref` `payables`,
`paid_from` and `discount`), and the payables line carries the vendor's
NetSuite internal id in `vendor_ref`, as a bill's does.

When NetSuite changes what a payment posts (its total, the account it was
paid from, the discount, the vendor, its date or the month it's booked
into) its entry is reversed and the new one posted in one transaction; a
new number, memo, status or vendor name alone changes nothing. One NetSuite
no longer has (the copy marks it gone) has its entry reversed, and so does
one that comes to nothing now. The entry is worked out from
the payment's total, so unlike a bill there are no copied lines to wait
for or to come to the total; one the rule can't work out, or that
NetSuite's GL copy has nothing of yet, keeps whatever it has, and the next
run looks again. As for payments, one in neither company's GL copy is
looked at only while an entry of it stands. 1084's post the same way (Both
companies).

NetSuite voids a bill payment by keeping its lines and booking a journal
entry that takes each of them back (seen 2026-10-17, when the balance
sheet's bank account came out higher than NetSuite's by the voided
payments and checks; owner decision the same day). FleetSuite posts that
journal entry as it does any other, so a voided payment posts all the same
while NetSuite's GL still books it, and the two come to nothing together,
as they do in NetSuite; until then FleetSuite posted the journal entry and
not the payment. Only one whose void took its lines away has its entry
reversed, by its month's decision rather than the run's first step, which
doesn't read the lines.

The posting job and the Bill payments switch read a month the same way
(`gl_bill_payment_month`), so payables are picked from the same payments
and what the page shows is what posts. Migration 390's
`gl_bill_payment_postings` reads what the journal holds for each bill
payment, as `gl_bill_postings` does for bills, and whether the copy of the
bill payments says it's voided or gone. The Bill payments switch shows the
Books column and Post now, as the other switches do.

## Checks and card charges

A check (NetSuite's Check) pays for something straight from a bank
account, and a credit card charge (CardChrg) puts it on a credit card,
BMG's Chase card say; a credit card refund (CardRfnd) puts money back on
the card. None of them goes through payables: the money comes straight out
of the account the document names. All three are copied from NetSuite with
their lines and checked against its GL with the spending rule (owner
decision 2026-10-16, "Checks and cards"), and posted to FleetSuite's
journal in the same run as invoices, as bills are.

### Copying checks and card charges

The ledger mirror's `ledger_bills` (migration 314) has slots for checks and
card charges, but it holds QuickBooks' documents, and its delete sweep
takes the NetSuite rows of its tables for its own documents, so the books
copy them themselves (`src/lib/books/netsuite-spending.ts`, into migration
391's `gl_netsuite_spending`): every two hours at :33 on odd hours
(`/api/cron/books-netsuite-spending`), done by :37, after the GL copy and
before the bills copy at :39, or when **Copy now** is pressed on the
invoices page's Checks and cards switch, which runs the same job with the
same four minutes.

The run works like the bills copy: the documents NetSuite changed since
the last run that finished, a day's overlap included (the first reaches
back to 2000), newest first, 200 at a time, with its place saved after
each page. For each page it reads each document's lines but the one for
the account the money comes out of, the same way and with the same
fallbacks as a bill's lines are read: the item, the expense account, the
net and own amounts, quantity, memo and whether it's a tax line. Nothing on
a check or a card is ordered first, so what a document is linked to isn't
read. The status and payee in words come from `BUILTIN.DF`; without them,
voided ones aren't marked voided and only payees that are vendors are
named, from the copy of NetSuite's vendors, which `gl_spending_month`
prefers anyway. A payee may be anyone NetSuite lists: a vendor, an
employee, or another name. Once a run has read everything changed, it
lists every check, card charge and card refund id NetSuite has and marks
the ones it no longer has as gone, with the same guard against a list that
looks cut short. What the copy keeps has a version, as the bills copy's
does (`COPY_VERSION`, 1). Rows are never deleted, nothing is written to
NetSuite, and the run's record in `sync_state` (`books_netsuite_spending`)
holds counts and words, never an amount. Totals are kept positive; lines
keep NetSuite's signs.

### The spending rule

The spending rule, `spending@1` (`src/lib/books/spending-rule.ts`), is the
bill rule with the account the money comes out of in place of payables:

- That account, the bank account a check is drawn on or the card a charge
  is put on, is credited with the document's total. It's the document's
  own choice, and the copy of the document doesn't keep it, so it comes
  from NetSuite's posting of the document, as a bill payment's does: the
  account on its main line, or, should that line be missing, the one
  account outside income and expenses NetSuite posts the other way from
  the document's lines.
- Each line is debited where the bill rule puts a bill's line: an expense
  line to its own account, a non-stock item to its expense account (a
  discount or markup to its own), and a stock item to its asset account,
  since nothing on a check or a card is ordered and received first. An item
  the copy of NetSuite's items has no such account for goes where NetSuite's
  GL posted most of its lines on the copied checks, card charges and
  refunds (`gl_spending_item_accounts`). Lines go in at their own amounts
  when they add up, as a bill's do.
- A card refund posts the same way, the other way round: its lines are
  credited and the card debited, as a bill credit is to a bill.
- A line of $0, and a subtotal or description line, post nothing, and a
  document of $0 posts nothing at all. A tax line, an expense line with no
  account, an item not in the copy of NetSuite's items or with no account
  of the kind it needs, or no account the money comes out of: the document
  can't be worked out.

Which way NetSuite signs the lines isn't assumed, as for bills: the
month's documents say (a check's or a charge's lines come to more than
nothing, a refund's to less).

### Checking checks and card charges

The **Checks and cards** switch on the invoices page checks each check,
card charge and card refund NetSuite booked into the month (or, when it
hasn't booked one, dated in it) against the GL lines NetSuite posted for
it, account by account, to the cent, as bills are checked
(`src/lib/books/spending-check.ts`). Migration 391's
`gl_spending_month(company, month)` reads the month from the copy: each
document with its lines, its payee and NetSuite's GL lines for it; the
items its lines name; and the GL copy's checks and card charges the copy
doesn't have yet. Opening one shows NetSuite's status for it, its lines,
and the rule's accounts next to NetSuite's, the bank account or card as
"Paid from" ("Refunded to" on a refund). Where FleetSuite and NetSuite put
the same amount in different accounts, the page gives it as one reason
(FleetSuite used this, NetSuite that).

Not yet seen in NetSuite's data, so the check is what will show it:

- that NetSuite's GL keeps the bank account or card on a check's or a
  charge's main line (line 0), as it keeps payables on a bill's;
- whether BMG's checks or card charges have tax lines, or items NetSuite
  books somewhere other than their expense or asset accounts;
- a document in another currency, whose total the copy keeps in that
  currency while NetSuite's GL is in BMG's.

### Posting checks and card charges

Every BMG check, credit card charge and credit card refund NetSuite booked
into a month from January 2025 that the rule can work out posts to
FleetSuite's journal in the same run as invoices, whether it matches
NetSuite or not, as bills do (owner decision 2026-10-16, "Checks and
cards", after the check): once, in the month NetSuite booked it into,
dated as a bill is (`entryDate`), with the rule `spending@1`. A check's
entries are filed as `check` and keyed `check:<NetSuite id>:<n>`, a card
charge's as `card_charge` and a card refund's as `card_refund`. Each of
the rule's lines is a line of the entry, with its NetSuite line id
(`source_line_ref`) and item; the account the money comes out of is
`paid_from`. No line carries a vendor: nothing is owed on a check or a
card, as it is on a bill's payables, so the payee is in the entry's memo,
and the copy keeps NetSuite's id for it.

When NetSuite changes what a document posts (an account, an amount, a
line, the bank account or card, its date or the month it's booked into,
or the copies of its lines, items or GL) its entry is reversed and the new
one posted in one transaction; a new number, memo, status or payee alone
changes nothing. One NetSuite no longer has (the copy marks it gone) has
its entry reversed, and so does one that comes to nothing now. One NetSuite
voided posts as a voided bill payment does: NetSuite voids a check by
keeping its lines and booking a journal entry that takes them back (seen
2026-10-17), so it posts while NetSuite's GL still books it, and only one
whose void took its lines away has its entry reversed.
The account the money comes out of must be credited with a check's or a
charge's total, and debited with a refund's, so one whose copied lines
come out any other way (caught mid-refresh, or signed the other way round)
keeps whatever it has, and the run's notes name it, as for bills. One the
rule can't work out, or whose lines or GL lines aren't copied yet, keeps
whatever it has too, and the next run looks again. As for payments, one in
neither company's GL copy is looked at only while an entry of it stands.
1084's post the same way (Both companies).

The posting job and the Checks and cards switch read a month the same way
(`readSpendingMonth` in `src/lib/books/netsuite-spending.ts`:
`gl_spending_month`, and `gl_spending_item_accounts` for items with no
account), so what the page shows is what posts. Migration 392's
`gl_spending_postings` reads what the journal holds for each check, card
charge and card refund, as `gl_bill_postings` does for bills, and whether
the copy says it's voided or gone. The Checks and cards switch shows the
Books column and Post now, as the other switches do.

## Journal entries

A journal entry (NetSuite's Journal) is lines typed straight into
NetSuite's books, such as the bookkeeper's entries for the Chase card
statements: NetSuite has no credit card charges of BMG's, as she enters the
statements as journal entries (owner, 2026-10-16). Every line of a journal
entry, with its account, amount, memo and name, is already in the copy of
NetSuite's general ledger (migration 361), so journal entries post from
that copy rather than from a copy of their own (owner decision 2026-10-17,
"Journal entries", "From the ledger copy"), in the same run as invoices.

### The journal entry rule

The journal entry rule, `journal_entry@1`
(`src/lib/books/journal-entry-rule.ts`), has nothing to work out: a
journal entry's lines for a company are that company's entry, each to the
same account for the same amount, in NetSuite's order.

- Each line keeps NetSuite's memo with the line's name in front ("Shell Oil
  · Fuel"), as FleetSuite's lines have no name of their own. Names come from
  the copy of NetSuite's vendors, else the ledger mirror's customers; anyone
  else (an employee, say) has no name in FleetSuite yet, so only the memo is
  kept.
- A receivables line carries its customer, the FleetSuite customer the
  ledger mirror matched NetSuite's to (as a deposit's does), and a payables
  line its vendor's NetSuite id (`vendor_ref`), as a bill's payables do. No
  other line carries either.
- A line of $0 posts nothing, and an entry of $0 posts nothing at all.
- An entry posts whole or not at all, and the journal takes only an entry
  that balances, so one whose lines for the company don't balance on their
  own can't be worked out.

### Checking journal entries

The **Journal entries** switch on the invoices page lists each journal
entry NetSuite booked into the month for the company, from migration 393's
`gl_journal_month(company, month)`: its number, date, first memo and total
(its debits), and, opened, each of its lines with its name and memo,
NetSuite's account and amount next to the line FleetSuite's entry has for
it. With nothing to work out, an entry whose lines balance matches line for
line, so the check is what shows one that doesn't balance. An entry with
lines for both companies is listed for each with that company's lines, and
the switch says so. It has no Copy now: its lines come from the GL copy,
whose Copy now is on the trial balance page, and the switch says when that
last ran.

### Posting journal entries

Every BMG journal entry NetSuite booked into a month from January 2025
posts to FleetSuite's journal in the same run as invoices: once, in the
month NetSuite booked it into, dated as a bill is (`entryDate`), with the
rule `journal_entry@1`. Its entries are filed as `journal_entry` and keyed
`journal_entry:<NetSuite id>:<n>`; each line has its NetSuite line id
(`source_line_ref`) and memo, and the entry's memo is its number. Like the
other documents copied from NetSuite, a journal entry may post to an
account NetSuite has made inactive since, and to receivables and payables,
which a typed entry can't (migration 387).

When NetSuite changes what an entry posts (an account, an amount, a line,
its date or the month it's booked into, a receivables line's customer or a
payables line's vendor) its entry is reversed and the new one posted in
one transaction; a new number, memo or name alone changes nothing. One the
GL copy no longer holds a line of for the company (deleted in NetSuite,
moved to the other company, or voided with its lines taken away) has its
entry reversed, and so does one that comes to nothing now. NetSuite's
other way of voiding an entry, a reversing journal entry, is a journal
entry of its own and posts like any other, as does the one that voids a
bill payment or check. One whose lines don't balance
keeps whatever it has, and the run's notes name it. 1084's post the same
way (Both companies).

The posting job and the Journal entries switch read a month the same way
(`gl_journal_month`, worked out by `workOutJournalMonth` in
`src/lib/books/journal-entry-check.ts`), so what the page shows is what
posts. `gl_journal_postings` reads what the journal holds for each, as
`gl_spending_postings` does for checks, and whether the GL copy still
holds a line of it for the company. The Journal entries switch shows the
Books column and Post now, as the other switches do.

Not yet seen in NetSuite's data, so the switch and Differences are what
will show it:

- whether an entry between BMG and 1084 ever doesn't balance for each
  company on its own: through October 2026 every journal entry balanced
  for its company (each company's Journal entries switch, Check every
  month, green in every month by 2026-10-18);
- whether NetSuite keeps entries of other types that work like journal
  entries (an intercompany journal entry, say), which Differences would
  list as not posted yet under their own type.

## Bank deposits, transfers and refunds

A bank deposit (NetSuite's Deposit) puts money into a bank account, most
often the customer payments waiting in Undeposited Funds, which is where a
payment posts when NetSuite put it there (the payment rule follows
NetSuite's account). A transfer (NetSuite's Transfer) moves money from one
bank account to another. Without them FleetSuite's Undeposited Funds would
run high and its bank accounts low. Every line of both is already in the
copy of NetSuite's general ledger, so they post from that copy as journal
entries do (owner decision 2026-10-17, "Bank deposits", "From the ledger
copy"), in the same run as invoices.

A customer refund (NetSuite's CustRfnd) pays a customer back a credit they
hold, such as an overpayment, out of Undeposited Funds or a bank account,
debiting receivables. Refunds post the same way, with bank deposits and
transfers (owner decision 2026-10-18, "Build it", migration 399): the
balance sheet check had shown receivables low and Undeposited Funds or the
bank high by exactly two refunds, whose payments had posted.

The bank rule, `bank@1` (`src/lib/books/bank-rule.ts`), is the journal
entry rule under its own name: a bank deposit's, transfer's or refund's
lines for a company are that company's entry, each to the same account for
the same amount, in NetSuite's order, with its memo and name, a receivables
line's customer and a payables line's vendor. A line of $0 posts nothing,
and one whose lines for the company don't balance on their own can't be
worked out.

The **Bank deposits, transfers and refunds** switch on the invoices page
lists each one NetSuite booked into the month for the company, from
`gl_bank_month(company, month)` (migrations 394 and 399): its number, with
Bank deposit, Transfer or Customer refund beside it, date, first memo and
total (its debits), and, opened, its lines next to the lines of
FleetSuite's entry, as the Journal entries switch shows a journal entry. It
has no Copy now either, and says when the GL copy last ran.

Every BMG bank deposit, transfer and refund NetSuite booked into a month
from January 2025 posts as a journal entry does: once, in the month
NetSuite booked it into, reversed and posted again when NetSuite changes
what it posts, and reversed when the GL copy no longer holds a line of it
for the company; 1084's post the same way (Both companies). A bank
deposit's entries
are filed as `bank_deposit` and keyed `bank_deposit:<NetSuite id>:<n>`, a
transfer's as `bank_transfer` and keyed `bank_transfer:<NetSuite id>:<n>`,
a refund's as `customer_refund` and keyed `customer_refund:<NetSuite
id>:<n>`, each line with its NetSuite line id and memo and the entry's memo
its number. `gl_bank_postings` reads what the journal holds for each, as
`gl_journal_postings` does for journal entries. The posting job and the
switch read a month the same way (`gl_bank_month`, worked out by
`workOutBankMonth` in `src/lib/books/bank-check.ts`), so what the page
shows is what posts.

Not yet seen in NetSuite's data, so the switch and Differences are what
will show it:

- whether a bank deposit's cash back or other deposit lines name anyone
  FleetSuite knows;
- whether a transfer ever moves money between BMG's and 1084's accounts,
  which would leave each company's lines unbalanced on their own;
- that a refund's lines are a receivables line naming its customer and the
  account the money left, as the two refunds behind the balance sheet
  differences moved receivables against Undeposited Funds and a bank
  account; and how NetSuite voids one. Either way FleetSuite posts what the
  GL copy holds of it, so a void that keeps its lines and books a journal
  entry taking them back posts both halves, as NetSuite does.

## Stock and cost

NetSuite moves stock and books its cost on documents of their own: an item
fulfillment (NetSuite's ItemShip) takes stock out to cost of goods sold
when an order ships, an item receipt (ItemRcpt) brings it in against a
purchase order, an inventory adjustment (InvAdjst) or transfer (InvTrnfr)
changes or moves it, and an assembly build (Build) turns parts into an
assembly, or an unbuild (Unbuild) turns it back. An invoice that wasn't
fulfilled first takes the stock out itself, on cost lines of its own, and a
credit memo can bring it back the same way; the invoice and credit memo
rules leave those lines out ("Invoices"). Without them FleetSuite's stock
accounts and cost of goods sold wouldn't match NetSuite's. Every line of
them is already in the copy of NetSuite's general ledger, so they post
from that copy as journal entries do (owner decision 2026-10-17, "Stock and
cost", posted from the "Ledger copy"), in the same run as invoices, and
FleetSuite takes NetSuite's costs as they are. The GL copy has no items or
quantities, so those come later.

The stock rule, `stock@1` (`src/lib/books/stock-rule.ts`), is the journal
entry rule under its own name: a stock document's lines for a company are
that company's entry, each to the same account for the same amount, in
NetSuite's order, with its memo and name. An invoice's or credit memo's
lines there are only its cost lines, as migration 377's
`gl_netsuite_cost_lines` recognizes them by their accounts and Differences
counts them; the rest of it is the invoice rule's. A line of $0 posts
nothing, and one whose lines for the company don't balance on their own
can't be worked out.

The **Stock and cost** switch on the invoices page lists each one NetSuite
booked into the month for the company, from migration 395's
`gl_stock_month(company, month)`: its number, with what it is beside it
(Fulfillment, Item receipt, Inventory adjustment, Inventory transfer,
Assembly build, Assembly unbuild, Invoice cost or Credit memo cost), date,
first memo and total (its debits), and, opened, its lines next to the
lines of FleetSuite's entry, as the Journal entries switch shows a journal
entry. It has no Copy now either, and says when the GL copy last ran.

Every BMG stock document NetSuite booked into a month from January 2025
posts as a journal entry does: once, in the month NetSuite booked it into,
reversed and posted again when NetSuite changes what it posts, and
reversed when the GL copy no longer holds a line of it for the company (for
an invoice or credit memo, a cost line); 1084's post the same way (Both
companies).
The entries are filed as `item_fulfillment`, `item_receipt`,
`inventory_adjustment`, `inventory_transfer`, `assembly_build`,
`assembly_unbuild` and `invoice_cost` (an invoice's and a credit memo's
cost lines alike, apart from the entry for the sale), keyed
`<source type>:<NetSuite id>:<n>`, each line with its NetSuite line id and
memo and the entry's memo its number. `gl_stock_postings` reads what the
journal holds for each, as `gl_bank_postings` does for bank deposits.
Migration 397 has it read the GL copy's cost lines once, from every month
and only when the journal holds a cost entry, then look each invoice and
credit memo up in them (field bug 2026-10-17): migration 395 looked for
each one month by month, and once the cost entries had posted, the first
read of every run ran past the database's statement timeout. The
posting job and the switch read a month the same way (`gl_stock_month`,
worked out by `workOutStockMonth` in `src/lib/books/stock-check.ts`), so
what the page shows is what posts.

Not yet seen in NetSuite's data, so the switch and Differences are what
will show it:

- whether an inventory transfer or an assembly ever moves stock between
  BMG and 1084, which would leave each company's lines unbalanced on their
  own;
- whether NetSuite books stock on other kinds of documents (a cash sale,
  say), which Differences would list as not posted yet under their own
  type.

## Differences

`/admin/books/differences` puts one company's own journal next to the copy
of NetSuite's general ledger, account by account and month by month, and
shows what still differs and why (owner decision 2026-10-15). Months are
compared by their activity, not their month-end balances, so a difference
shows in the month it comes from rather than in every month after it; the
trial balance check covers the balances. NetSuite's side counts in the
month NetSuite posted to (its accounting period), FleetSuite's by each
entry's date. A reversal counts with the document it reverses, and the
posting job dates it as that document's entry, so a document whose entry
was replaced comes to its new entry within the month.

Each month's NetSuite activity is split by the kind of document behind it:

- the kinds FleetSuite posts for the company (invoices, credit memos,
  payments, customer deposits, deposit applications, vendor bills, bill
  credits, bill payments, checks, credit card charges, credit card refunds,
  journal entries, bank deposits, transfers, customer refunds, item
  fulfillments, item receipts, inventory adjustments and transfers, assembly builds and
  unbuilds, and the cost of goods on invoices and credit memos for BMG)
  should come to the same as FleetSuite's entries for the same documents,
  matched by NetSuite's internal id. The cost of goods NetSuite books on an
  invoice or credit memo that wasn't fulfilled first is a kind of its own,
  posted with the stock rule as `invoice_cost`, and every other kind leaves
  it out. Migration 377's `gl_netsuite_cost_lines` recognizes those lines
  by their accounts, as the invoice check does: a cost of goods sold
  account or an item's inventory asset account, unless it is the income
  account of the line's own item. NetSuite's own cost of goods flag isn't
  copied, so a line it flags that went to another kind of account shows as
  a difference here, though the invoice check leaves it out;
- everything else is "not posted yet": the kinds FleetSuite has no rule
  for;
- a FleetSuite entry of a kind NetSuite has no counterpart for (a typed
  entry, an opening balance) is a difference of its own.

For every account the page shows FleetSuite's activity, NetSuite's, the
part of NetSuite's from kinds not posted yet, and what differs on the kinds
FleetSuite posts (FleetSuite = NetSuite − not posted yet + differs). A
month matches when nothing differs on any account; a month with nothing of
the kinds FleetSuite posts on either side shows neither mark. The share of
NetSuite's activity FleetSuite posts is what documents of those kinds moved
over what all documents moved, each document's activity counted as its
debits after its lines on the same account are netted.

For the month picked, `gl_books_difference_documents` lists the documents
of the kinds FleetSuite posts whose entries don't come to NetSuite's lines,
account by account, the largest difference first (the page shows 300), and
the page says why for each:

| Why | When |
| --- | --- |
| Dated before the books start | A payment, deposit or application NetSuite dated in 2024 and posted to 2025; FleetSuite only posts those dated from 2025 (an invoice, credit memo, bill, bill credit, bill payment, check, card charge, journal entry, bank deposit, transfer, customer refund or stock document like it posts in NetSuite's month) |
| Not posted | FleetSuite has never posted it; Invoices vs NetSuite shows why |
| Voided | NetSuite voided it and FleetSuite reversed its entry, but the copy of NetSuite's ledger still has lines of it (a bill payment, check, card charge or refund like it posts again on the next run) |
| Reversed | FleetSuite reversed its entry and has none standing |
| Gone | FleetSuite's entry stands but this company has no line of it in the copy: deleted or voided in NetSuite (the next posting run reverses the entry), or posted to the other company (for a journal entry, bank deposit, transfer, customer refund or stock document, the next posting run reverses that one too) |
| Another month | FleetSuite's entry is dated in one month, NetSuite posted it to another; for an invoice, credit memo, bill, bill credit, bill payment, check, card charge, journal entry, bank deposit, transfer, customer refund or stock document, until the next posting run moves it |
| No cost now | FleetSuite posted an invoice's or credit memo's cost of goods, and NetSuite books no cost on it now; the next posting run reverses the entry |
| Posted differently | Same month, different accounts or amounts |

Each document links to Invoices vs NetSuite (`?company=&kind=&month=&doc=`),
which opens it with its line by line check, under the month that page lists
it in: NetSuite's month for an invoice, credit memo, bill, bill credit,
bill payment, check, card charge, card refund, journal entry, bank deposit,
transfer, customer refund or stock document (bills and bill credits under the Bills switch, bill payments
under Bill payments, checks and card charges and refunds under Checks and
cards, journal entries under Journal entries, bank deposits, transfers and
customer refunds under Bank deposits, transfers and refunds, stock documents and invoices' and credit
memos' cost of goods under Stock and cost), its own date's for a payment,
deposit or application (deposits and applications under the Deposits
switch). What
the copy of NetSuite's documents says of each (its number, customer,
vendor or payee, and whether it's voided or deleted) comes from the ledger
mirror for invoices, credit memos and payments, from the deposits copy for
deposits and applications (migration 383), from the bills copy for bills
and bill credits (migration 386), from the bill payments copy for bill
payments (migration 390), and from the checks and cards copy for checks,
card charges and card refunds (migration 392); an invoice's or credit
memo's cost of goods has the invoice's or credit memo's (migration 395),
and a journal entry, bank deposit, transfer, customer refund or other stock
document has no copy but the GL's, which gives its number. When
the copy of NetSuite's ledger doesn't yet hold everything NetSuite's own
totals say a month moved, the page says so, since NetSuite's side is then
short.

## Daily check

Each morning FleetSuite puts every month of BMG's and 1084's books next to
NetSuite's, as Differences vs NetSuite does, and tells the super admins in
FleetSuite when a month stops matching, with a link to that month there
(owner decision 2026-10-18). A month stops matching when it matched and now
differs on what FleetSuite posts, or when it already differed and more of
its documents differ now than when the super admins last heard of it, so a
month that differs for a known reason (December 2025's sales tax on one
invoice, while a question for the CPA stands) says nothing more until
another of its documents differs. A month that matches again drops out,
and is told about again if it stops matching later. The check's first look
learns where things stand and tells nobody.

`/api/cron/books-daily-check` runs twice, each time just after a posting
run and before the next copy of NetSuite's ledger. A document someone was
changing in NetSuite while the copies ran can differ until the next posting
run catches it up, so the 09:58 UTC run (4:58 AM Central, 3:58 in winter),
when nobody works in NetSuite, only notes what newly differs, and the 13:58
UTC run (8:58, 7:58 in winter), two posting runs later, tells about what of
that still differs. What first differs at the 13:58 run waits for the next
morning. A run before noon UTC is the first look, after it the second.

Each month gets its own notification (`books_month_differs`: in the app and
by push, never by email unless someone picks email in Settings) naming the
two documents that differ most, or how many accounts differ when no
document of a kind FleetSuite posts is behind it; more than three months of
a company at once get one notification, linking to the first. It says so
when the last posting run or copy of NetSuite's ledger failed, which can be
why. The record in `sync_state`, `books_daily_check`, holds each company's
months that differ with how many of their documents, never an amount; a
company the check couldn't look at keeps what it had, and Differences vs
NetSuite says when the check last looked and what it couldn't do. When the
notifications can't go, nothing is recorded, so the next morning tells
again. Nothing is written to NetSuite or to the books.

## Reports

`/admin/books/reports` shows one company's profit and loss, balance sheet
and trial balance from FleetSuite's own books, each line next to the same
report worked out from NetSuite's own totals, so the owner and the CPA can
see they agree (owner decision 2026-10-17). The profit and loss covers the
months picked with From and To, as NetSuite's reports do (the owner chose
any range over a fixed twelve months the same day); the balance sheet and
trial balance are at the To month's end. Months run from January 2025 to
the latest month either side has, and the page opens on last month.

FleetSuite's side is its journal: migration 396's `gl_books_totals` sums
one company's `gl_lines` per account and month by each entry's date, keyed
by the account's NetSuite id, or `fs:<id>` for an account NetSuite doesn't
have. NetSuite's side is NetSuite's own totals, as `gl_netsuite_totals`
gives them to the trial balance check. FleetSuite's books post from January
2025, so both sides start from NetSuite's balances on December 31, 2024
(the starting entry), and anything FleetSuite's journal holds dated earlier
adds to its side. When FleetSuite posts its own opening balances (Going
live, step 3), its side must start from those instead, or they count twice.

`src/lib/books/reports.ts` lays each report out as NetSuite's is:

- Profit and loss: Income, Cost of sales, Gross profit, Expense, Net
  ordinary income, then Other income, Other expense and Net other income
  when there are any, and Net income. Income and expenses read positive; a
  loss reads negative.
- Balance sheet: Current assets (Bank, Accounts receivable, Other current
  assets), Fixed assets, Other assets and Total assets, then Current
  liabilities (Accounts payable, Credit card, Other current liabilities),
  Long term liabilities, Total liabilities, Equity and Total liabilities
  and equity. Liabilities and equity read positive. Earlier years' net
  income is in retained earnings, as the trial balance check puts it, and
  this year's is a Net income line; the year is the calendar year.
- Trial balance: as the trial balance check lays it out, debits and credits
  apart, with each side's totals.

Each account sits under its parent when the parent is in the same section,
with a total for the parent; one whose parent is in another section, or
whose parents loop, starts its own branch. Accounts with nothing on either
side don't show. A NetSuite account the chart doesn't have yet can't be
placed, so it shows apart at the end, debit positive, and out of net
income.

A line differs when its two sides aren't the same to the cent; the count
covers accounts, retained earnings and net income, not totals. The month
strip marks each month by its own report: its profit and loss alone, or the
balance sheet or trial balance at its end, so a difference shows on the
profit and loss in the month it comes from and on the balance sheet from
then on. When the report differs, the page links to Differences vs NetSuite
at the first month in it that differs (`?company=&month=`), where the
documents behind it are listed.

Each line that differs also lists the months whose own entries make up its
difference, with what each adds, so a gap on the balance sheet shows the
month it started in (asked for 2026-10-17, after the first look at the
real books). Every amount on a report is a sum of movements, so the report
of one month's movements alone, with no starting entry, is what that month
adds to each line; the months add up to the line's difference. On the
balance sheet and trial balance they run from the first month either side
has to the report's month, earlier years' income landing on retained
earnings; on the profit and loss, through the months picked. The page
shows a line's first month and the three that add the most, each opening
Differences at that month (a month before 2025, FleetSuite's alone, has no
link there).

On a phone the trial balance shows each side in one column, its balance
marked Dr or Cr, so it fits the screen as the other two reports do, and the
reports' text isn't enlarged by iOS.

The page keeps the company, report and months in its address
(`deepLinks.booksReport`), so coming back from a line's detail opens the
same report.

## Report detail

Each account line on Reports opens `/admin/books/reports/detail`
(`deepLinks.booksAccountDetail`): every document that moved the account in
the months the line covers, FleetSuite's journal next to the copy of
NetSuite's general ledger, so the owner or the CPA can trace any number on a
report back to its documents (owner decision 2026-10-18). A line that
differs opens on the documents that differ, with the rest a tap away; From
and To pick other months.

What a line covers: on the profit and loss, the months picked; on the
balance sheet, the To month, between the account's balance at the end of the
month before and at the end of To; on the trial balance, the same for a
balance sheet account and the year to date for income and expenses (those
lines carry `yearToDate`). `lineSpan` in `src/lib/books/reports.ts` works
out both ends as the report itself does, so the last one is the line, and
the amounts read as that report shows them: income, liabilities and equity
positive on the profit and loss and balance sheet, debit positive (Dr and
Cr) on the trial balance. Retained earnings takes in earlier years' net
income at each year's start, as the balance sheet puts it there, so a range
across a year's start shows that on a row of its own. A NetSuite account the
chart doesn't have yet counts as the report lists it.

The documents come from migration 400's `gl_books_account_documents`,
counted as Reports and Differences count them: NetSuite's in the month it
posted to, FleetSuite's by each entry's date, and a reversal with the
document it reverses, so a replaced entry shows once, at what stands. A
document is the same on both sides when FleetSuite's source_id is NetSuite's
internal id; a typed entry or an opening balance is a document of its own.
One whose lines on the account come to nothing on both sides is left out.
Each shows its date, type, number, name (from NetSuite's vendor list, else
the ledger mirror's customer, as journal entries name theirs) and first
memo, whether only one side has it, and, for a kind FleetSuite posts, a
link from its number to its line by line check on Invoices vs NetSuite
(`deepLinks.booksDocument`, as Differences links). The page lists 1,000 at
most, by date.

FleetSuite's documents always add up to its side of the line. NetSuite's
come from the copy of its ledger, while the report's NetSuite side is
NetSuite's own totals; when the copy doesn't hold all of a range yet, the
page says how much it holds.

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
