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
credit memos, checked and posted the same way, the other way round, and
part 8, customer payments, checked against NetSuite with the payment rule.
The screens are the accounts page at `/admin/books`, the trial
balance at `/admin/books/trial-balance`, the lists at `/admin/books/lists`
and the invoices at `/admin/books/invoices`, which only super admins can
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
| Payment tests | `src/lib/books/payment-rule.test.ts`, `src/lib/books/payment-check.test.ts`, `src/lib/books/payment-check-sql.test.ts` |

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
item's cost posts will come from NetSuite's own fulfillments, with that
posting rule. Until then `details.cogs_account`, which migration 363 names,
stays empty.

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
`gl_invoice_month(company, month)` reads one month: the invoices dated in it
from the ledger mirror (migration 314) with their lines, NetSuite's GL lines
for each from the copy (migration 361), and the copied items and tax codes
the lines name. The page shows how many invoices match, differ, can't be
worked out or are waiting on a copy, why the others don't match, and each
invoice side by side with NetSuite. **Check every month** runs the same
count for every month from January 2025.

- An invoice is a company's when NetSuite posted a GL line of it to that
  company. Invoices with no GL line in the copy (waiting for approval, which
  doesn't post, or newer than the last copy) are named in a note, not
  counted.
- An invoice that wasn't fulfilled first relieves the stock itself: NetSuite
  books its cost on lines of their own, one to a cost of goods account and
  one to an inventory asset account. FleetSuite will post that cost with the
  fulfillment rule, so the check leaves those lines out of the invoice's
  entry and doesn't compare them. They're the lines NetSuite flags itself
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

Every BMG invoice dated from January 2025 that the rule can work out posts
to FleetSuite's own journal once, as Invoices vs NetSuite shows it, whether
it matches NetSuite or not (owner decision 2026-10-13): during 2027 the
differences are what the side-by-side run is for. 1084's invoices join once
they've been checked against NetSuite (`POSTING_COMPANIES` in
`src/lib/books/invoice-posting.ts`). Nothing is written to NetSuite.

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

- An invoice with no entry gets one, dated as the invoice is and keyed
  `invoice:<NetSuite id>:1`.
- An invoice whose entry no longer fits what the rule works out now (an
  account, amount, division, line, customer or date changed in NetSuite, or
  in the copies of its lines, items or GL) has its entry reversed and the
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
  journal refuses (an account made inactive since, say), isn't posted. The
  run lists a few by number, with why.

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
running." The first run posts every invoice since 2025 and may take more
than one run: a run stops within its budget between months, or before a
write with under five seconds left, and the next carries on from the month
it stopped at (`sync_state` `books_invoice_posting`). Like the other books
jobs that record isn't a System Health monitor, and neither it nor the
cron's response carries any amount.

On the invoices page each invoice shows its entry ("Entry 12") and what the
next run will do to it: post, replace or reverse. Opening it lists its
earlier entries and what reversed them. Until a company's books go live the
journal can be emptied (`resetJournal`), and the next run posts every
invoice again.

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

The check comes first (owner decision 2026-10-14), as it did for invoices,
and payments post once it shows them matching. The **Payments** switch on
the invoices page checks every NetSuite customer payment against the GL
lines NetSuite posted for it, account by account, to the cent. NetSuite's
lines on one account are added together, since it may take a payment off
receivables on a line for each invoice it pays. Migration 374's
`gl_payment_month(company, month)` reads one month: the payments dated in it
from the ledger mirror, with what each was applied to and NetSuite's GL
lines for each from the copy (migration 361). Opening a payment shows what
it was applied to. Payments aren't posted yet.

- A payment is a company's when NetSuite posted a GL line of it to that
  company. Payments with no GL line in the copy are named in a note, not
  counted. The mirror keeps a payment NetSuite deleted (its delete sweep
  covers only invoices and credit memos), so a deleted one shows in that
  note. Before payments post, the sweep needs to cover them too.
- Anything else NetSuite posts for a payment shows as a line FleetSuite's
  entry doesn't have. So does a discount split across two income or
  expense accounts, since neither is then plainly the discount.
- Customer deposits, and applying them to invoices, are NetSuite documents
  of their own and aren't copied yet. Nor are bank deposits, which move the
  money from Undeposited Funds to the bank.

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
