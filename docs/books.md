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
a month stops matching NetSuite, part 20, the documents behind each
account line on the reports, part 21, each item's stock at each
location, counted from a copy of every NetSuite document that moves it and
checked against NetSuite's own count, part 22, what each customer owes
and each vendor is owed, next to NetSuite's and checked each morning, and
part 23, FleetSuite's own copy of each invoice it makes, worked out by its
own rules and checked against NetSuite's invoice each morning, part 24,
those copies posted to the books in place of NetSuite's invoices when they
match them, part 25, FleetSuite's own copy of each fulfillment it
makes, with what it cost worked out from stock by item, checked against
NetSuite's fulfillment each morning, part 26, a look each night through
the copies of NetSuite's bills, checks and card charges for likely mistakes,
listed for a super admin to clear, and part 27, Books' own copy of each bill
and PO receipt FleetSuite puts into NetSuite, checked against NetSuite's
each morning, with one bill per approved vendor invoice or installer payout,
part 28, Snap a bill, which enters a vendor's bill in NetSuite from a
picture of it, part 29, PO bills, which bills the purchase order a
snapped bill names, any freight on its own line, part 30, Books' own
copies of fulfillments, receipts and bills posted to the books in place of
NetSuite's when they match them and make the same entry, and part 31, each
change made with Inventory Adjust checked against NetSuite's inventory
adjustment each morning, valued at FleetSuite's own average cost, and
posted in place of it the same way. The screens are the accounts page at `/admin/books`, the trial
balance at `/admin/books/trial-balance`, the lists at `/admin/books/lists`,
the invoices at `/admin/books/invoices`, the differences at
`/admin/books/differences`, the reports at `/admin/books/reports`, an
account line's detail at `/admin/books/reports/detail`, stock by item at
`/admin/books/stock`, an item's moves at `/admin/books/stock/item`,
customer and vendor balances at `/admin/books/balances`, the documents
behind one at `/admin/books/balances/party`, FleetSuite's own invoices at
`/admin/books/own-invoices` and one's check at
`/admin/books/own-invoices/invoice`, and its own fulfillments at
`/admin/books/own-fulfillments` and one's check at
`/admin/books/own-fulfillments/fulfillment`, its own bills at
`/admin/books/own-bills` and one's check at `/admin/books/own-bills/bill`,
its own receipts at `/admin/books/own-receipts` and one's check at
`/admin/books/own-receipts/receipt`, the Inventory Adjusts at
`/admin/books/own-adjustments` and one's check at
`/admin/books/own-adjustments/adjustment`, the mistake checks at
`/admin/books/mistake-checks`, Snap a bill at `/admin/books/snap-a-bill`, and sales by location at `/admin/books/sales`, which only super admins can open. Only they see the Books entry on the More page (Admin), which opens
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
| Daily check, and its notifications | `src/lib/books/daily-check.ts`, `src/app/api/cron/books-daily-check/route.ts`, `books_month_differs`, `books_stock_differs`, `books_balance_differs`, `books_own_invoice_differs`, `books_own_fulfillment_differs`, `books_own_bill_differs`, `books_own_receipt_differs`, `books_own_adjustment_differs` and `books_mistake_found` in `src/lib/notification-registry.ts` |
| Daily check tests | `src/lib/books/daily-check.test.ts`, `src/lib/books/daily-check-sql.test.ts` |
| An account line's documents (report detail) | `migrations/400-books-report-detail.sql`, `src/lib/books/report-detail.ts`, `lineSpan` in `src/lib/books/reports.ts`, `src/lib/books/report-data.ts` (what Reports and the detail read), `src/lib/books/report-links.ts` (the months a line opens on), `src/app/(main)/admin/books/reports/detail/page.tsx`, `src/app/api/admin/books/reports/detail/route.ts` |
| Report detail tests | `src/lib/books/report-detail.test.ts`, `src/lib/books/report-detail-sql.test.ts`, `src/lib/books/report-links.test.ts`; `lineSpan`'s are in `src/lib/books/reports.test.ts` |
| Sales by location and class, with returns, discounts and transportation apart (made for the insurance premium audit) | `migrations/426-books-sales-report.sql`, `src/lib/books/sales-report.ts`, `src/app/(main)/admin/books/sales/page.tsx`, `src/app/api/admin/books/sales/route.ts`; tests `src/lib/books/sales-report.test.ts`, `src/lib/books/sales-report-sql.test.ts` |
| NetSuite's stock moves, copied, and each item's count and value at each location | `migrations/401-books-stock-by-item.sql`, `migrations/402-books-stock-values.sql` (what's valued), `migrations/403-books-stock-item-setup.sql` (items set up wrong), `migrations/404-books-stock-ledger-parts.sql` (the ledger account by account), `migrations/405-books-stock-account-items.sql` (the items behind each account), `src/lib/books/netsuite-stock.ts`, `src/lib/books/stock-items.ts`, `src/app/api/cron/books-netsuite-stock/route.ts` |
| Stock by item and an item's moves, and their APIs | `src/app/(main)/admin/books/stock/page.tsx`, `src/app/(main)/admin/books/stock/item/page.tsx`, `src/app/api/admin/books/stock/route.ts`, `src/app/api/admin/books/stock/item/route.ts` |
| Stock by item tests | `src/lib/books/netsuite-stock.test.ts`, `src/lib/books/stock-items.test.ts`, `src/lib/books/stock-items-sql.test.ts`; the daily check's are in its test files |
| Each customer's and vendor's balance, and the starting entry by name | `migrations/406-books-party-balances.sql`, `src/lib/books/party-balances.ts`, `partyOpeningQuery` and `storePartyOpening` in `src/lib/books/netsuite-gl.ts` |
| Customer and vendor balances and one balance's documents, and their APIs | `src/app/(main)/admin/books/balances/page.tsx`, `src/app/(main)/admin/books/balances/party/page.tsx`, `src/app/api/admin/books/balances/route.ts`, `src/app/api/admin/books/balances/party/route.ts` |
| Balance tests | `src/lib/books/party-balances.test.ts`, `src/lib/books/party-balances-sql.test.ts`; the starting entry by name's are in the copy test files, the daily check's in its own |
| FleetSuite's own invoices, saved as each is made and checked against NetSuite's, and NetSuite's customers in the lists | `migrations/407-books-own-invoices.sql`, `src/lib/books/own-invoices.ts`, `src/lib/books/own-invoice-check.ts`; saved by `src/app/api/vehicle-tracking/invoice/route.ts`, `src/app/api/netsuite/create-invoice/route.ts`, `src/app/api/pos/invoice-open/route.ts`, `src/app/api/netsuite/invoice-vehicles/route.ts` and `src/app/api/graphics/create-invoice/route.ts`, from what `createDirectInvoice` and `createInvoiceFromSO` in `src/lib/netsuite.ts` say they billed |
| Own invoices and one invoice's check, and their API | `src/app/(main)/admin/books/own-invoices/page.tsx`, `src/app/(main)/admin/books/own-invoices/invoice/page.tsx`, `src/app/api/admin/books/own-invoices/route.ts` |
| Own invoice tests | `src/lib/books/own-invoices.test.ts`, `src/lib/books/own-invoice-check.test.ts`, `src/lib/books/own-invoices-sql.test.ts`; the customers list's are in the lists test files, the daily check's in its own |
| FleetSuite's own invoices posted in place of NetSuite's when they match | `migrations/409-books-own-invoice-posting.sql`, `src/lib/books/own-invoice-posting.ts`, `src/lib/books/invoice-posting.ts` |
| Own invoice posting tests | `src/lib/books/own-invoice-posting.test.ts`; the posting decisions are in `invoice-posting.test.ts`, end to end in `invoice-posting-sql.test.ts` |
| FleetSuite's own fulfillments, saved as each is made, costed from stock by item and checked against NetSuite's | `migrations/416-books-own-fulfillments.sql`, `src/lib/books/own-fulfillments.ts`, `src/lib/books/own-fulfillment-check.ts`; saved by `src/app/api/vehicle-tracking/invoice/route.ts` and `src/app/api/netsuite/create-invoice/route.ts` right after `fulfillSalesOrder` in `src/lib/netsuite.ts` |
| Own fulfillments and one fulfillment's check, and their API | `src/app/(main)/admin/books/own-fulfillments/page.tsx`, `src/app/(main)/admin/books/own-fulfillments/fulfillment/page.tsx`, `src/app/api/admin/books/own-fulfillments/route.ts` |
| Own fulfillment tests | `src/lib/books/own-fulfillments.test.ts`, `src/lib/books/own-fulfillment-check.test.ts`, `src/lib/books/own-fulfillments-sql.test.ts`; the daily check's are in its test files |
| Books' own bills and receipts, saved as FleetSuite makes each and checked against NetSuite's, and one bill per approved vendor invoice or payout | `migrations/435-books-own-bills.sql`, `src/lib/books/own-bills.ts`, `src/lib/books/own-receipts.ts`, `src/lib/books/own-bill-check.ts`, `src/lib/books/own-receipt-check.ts`, `src/lib/bill-once.ts`, `findVendorBill` in `src/lib/netsuite.ts`; saved by `src/app/api/vendor-invoices/workflow/route.ts`, `src/app/api/admin/payouts/route.ts`, `src/app/api/parts-mail/create-bill/route.ts` and `src/app/api/po-receipts/route.ts` |
| Own bills and own receipts and one's check, and their APIs | `src/app/(main)/admin/books/own-bills/page.tsx`, `src/app/(main)/admin/books/own-bills/bill/page.tsx`, `src/app/(main)/admin/books/own-receipts/page.tsx`, `src/app/(main)/admin/books/own-receipts/receipt/page.tsx`, `src/app/api/admin/books/own-bills/route.ts`, `src/app/api/admin/books/own-receipts/route.ts` |
| Own bill and receipt tests | `src/lib/books/own-bills.test.ts`, `src/lib/books/own-receipts.test.ts`, `src/lib/books/own-bill-check.test.ts`, `src/lib/books/own-receipt-check.test.ts`, `src/lib/books/own-bills-sql.test.ts`, `src/lib/bill-once.test.ts`; the daily check's are in its test files |
| Books' own fulfillments, receipts and bills posted in place of NetSuite's when they match, and what the books hold for each on the Own pages | `migrations/456-books-own-postings.sql`, `src/lib/books/own-stock-posting.ts`, `src/lib/books/own-bill-posting.ts`, `src/lib/books/invoice-posting.ts`, `src/lib/books/own-posting-view.ts`, `src/lib/books/own-posting-text.ts`, `src/components/BooksOwnPosting.tsx` |
| Own posting tests | `src/lib/books/own-stock-posting.test.ts`, `src/lib/books/own-bill-posting.test.ts`, `src/lib/books/own-posting-text.test.ts`, and end to end, with the Own pages' reads, `src/lib/books/own-postings-sql.test.ts`; the posting decisions are in `invoice-posting.test.ts` |
| The Inventory Adjusts, checked against NetSuite's adjustments and posted in place of them when they match | `migrations/457-books-own-adjustments.sql`, `src/lib/books/own-adjustment-check.ts`, `src/lib/books/own-stock-posting.ts`, `src/lib/books/invoice-posting.ts`; Inventory Adjust's own record is `inventory_adjustments` (`migrations/454-inventory-adjustments.sql`, `src/lib/inventory-adjust.ts`) |
| Own adjustments and one adjustment's check, and their API | `src/app/(main)/admin/books/own-adjustments/page.tsx`, `src/app/(main)/admin/books/own-adjustments/adjustment/page.tsx`, `src/app/api/admin/books/own-adjustments/route.ts` |
| Own adjustment tests | `src/lib/books/own-adjustment-check.test.ts`, and end to end `src/lib/books/own-adjustments-sql.test.ts`; the posting's are in `own-stock-posting.test.ts` and `invoice-posting.test.ts`, the daily check's in its test files |
| Snap a bill: each snapped bill, the reader, the suggestions and checks, sending once, and a vendor's earlier bills | `migrations/436-books-snap-a-bill.sql`, `src/lib/books/bill-reader.ts`, `src/lib/books/snap-a-bill.ts`, `src/lib/books/typed-dollars.ts`, `makeBillOnce` in `src/lib/bill-once.ts`, `createVendorBill` in `src/lib/netsuite.ts` |
| Snap a bill's page and its API | `src/app/(main)/admin/books/snap-a-bill/page.tsx`, `src/app/api/admin/books/snap-a-bill/route.ts` |
| Snap a bill tests | `src/lib/books/bill-reader.test.ts`, `src/lib/books/snap-a-bill.test.ts`, `src/lib/books/typed-dollars.test.ts`, `src/lib/books/snap-a-bill-sql.test.ts`; sending once is in `src/lib/bill-once.test.ts`, the bill NetSuite is sent in `src/lib/netsuite.test.ts` |
| PO bills: the PO a snapped bill names, its checks, the extra line, and billing it | `migrations/444-books-po-bills.sql`, `src/lib/books/snap-po.ts`, `src/lib/books/snap-a-bill.ts`, `canBillPoStatus` and `loadPoMatchFacts` in `src/lib/three-way-match.ts`, `createBillFromPo` in `src/lib/netsuite.ts`; on Snap a bill's page and its API |
| PO bill tests | `src/lib/books/snap-po.test.ts`, `src/lib/books/snap-a-bill.test.ts`, `src/lib/three-way-match.test.ts`, `src/lib/books/snap-a-bill-sql.test.ts`, `src/lib/books/own-bills.test.ts`, `src/lib/netsuite.test.ts` |
| Mistake checks: the night's look for likely mistakes in the copies of NetSuite's bills, checks and card charges, each kept for a super admin to clear | `migrations/431-books-mistake-checks.sql`, `src/lib/books/mistake-checks.ts`, `src/app/api/cron/books-mistake-checks/route.ts` |
| Mistake checks page and its API | `src/app/(main)/admin/books/mistake-checks/page.tsx`, `src/app/api/admin/books/mistake-checks/route.ts` |
| Mistake check tests | `src/lib/books/mistake-checks.test.ts`, `src/lib/books/mistake-checks-sql.test.ts`; the daily check's are in its test files |
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
| Customers | `customer` | terms, whether NetSuite taxes them and with which tax code, the entity id when the name is the company's |

Customers came with migration 407, for FleetSuite's own invoices: their
terms give each invoice FleetSuite makes its due date, and whether NetSuite
taxes them explains a sales tax that differs ("FleetSuite's own invoices").
Each is named by its company name, else its entity id. The lists page looks
them up by name, as it does vendors and items.

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
- In the cron the lists get the first 90 seconds of the run, items and then
  customers last, so the ledger mirror after them keeps most of its time. A list there wasn't
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
   what the copy is checked against. The starting entry on the receivable
   and payable accounts is read again by name, so each customer's and
   vendor's balance starts where NetSuite's does
   (`gl_netsuite_opening_parties`, migration 406, see "Customer and vendor
   balances"); when NetSuite won't give the names, the split by name it had
   stays and that page says so.
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

An invoice FleetSuite made posts from FleetSuite's own copy of it instead
when that copy matches NetSuite's invoice and makes the same entry
("Posting FleetSuite's own invoices", under "FleetSuite's own invoices").

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
1084's post the same way (Both companies). A bill FleetSuite made posts
from Books' own copy of it instead when that copy matches NetSuite's bill
and makes the same entry ("Posting FleetSuite's own fulfillments, receipts
and bills").

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
companies). A fulfillment FleetSuite made, a Receive NetSuite took, or a
change made with Inventory Adjust, posts from Books' own copy of it instead
when that copy matches NetSuite's document and makes the same entry
("Posting FleetSuite's own fulfillments, receipts and bills", "FleetSuite's
own adjustments").
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

Stock by item is looked at the same way (owner decision 2026-10-18): an
item whose count at a location stops matching NetSuite's own count is
noted at the first look and told about at the second if it still differs,
and so is one whose counts have drawn further apart, by whole units, than
when the super admins last heard of it. Each look comes fifteen minutes
after a copy of NetSuite's stock moves, which reads NetSuite's counts as it
ends, so both counts are of the same moment; when the last copy didn't get
that far (the first copies of the whole history, or one that ran out of
time), stock waits for the next look. Values aren't told about, since
NetSuite works costs out again after the fact and may not give its values
at all; the page shows them. Each item gets its own notification
(`books_stock_differs`, in the app and by push) with both counts, linking
to its moves; more than three at once get one, linking to Stock by item
open on the items that differ. The record holds the items whose counts
differ, by item and location, with how many units apart, never an amount.
When NetSuite's counts are read another way (each item company-wide
instead of at each location, or back), the items are keyed another way, so
the next look starts afresh and tells nobody.

Customer and vendor balances are looked at the same way too (owner
decision 2026-10-19, "Balance checks"): a customer's or vendor's balance
that stops matching NetSuite's is noted at the first look and told about at
the second if it still differs, and so is one more of whose documents
differ than when the super admins last heard of it. One whose documents
differ while its balance matches isn't told about; the page shows it. Each
balance gets its own notification (`books_balance_differs`, in the app and
by push) naming the newest two of its documents that differ, linking to its
documents; more than three of a company at once get one, linking to
Customer and vendor balances open on those that differ. The record holds
whose balances differ, by FleetSuite's id for a customer and NetSuite's for
a vendor (`c:` and `v:` alone for the group FleetSuite can't name), with
how many of their documents differ, never an amount. The check's first
look at a company's balances learns where they stand and tells nobody.

So are FleetSuite's own invoices (owner decision 2026-10-19, "Own
invoices"): one that differs from NetSuite's invoice is noted at the first
look and told about at the second if it still differs, and so is one where
more of what's compared differs than when the super admins last heard of
it. FleetSuite keeps them only from the day it began to, so none is taken
as known at the check's first look at them. One that's waiting for
NetSuite's copies, incomplete or voided isn't told about. Each gets its own
notification (`books_own_invoice_differs`, in the app and by push) saying
what differs first, linking to its check; more than three at once get one,
linking to Own invoices open on the newest one's month with those that
differ. The record holds the invoices that differ, by NetSuite's id for
each, with how many things differ, never an amount.

So are FleetSuite's own fulfillments, the same way as its own invoices
(owner decision 2026-10-19, "Fulfillments"): one that differs from
NetSuite's fulfillment, on what it took from stock, where from, on what day
or at what cost, is noted at the first look and told about at the second if
it still differs, and so is one where more differs than before. Each gets
its own notification (`books_own_fulfillment_differs`, in the app and by
push) saying what differs first, linking to its check; more than three at
once get one, linking to Own fulfillments open on the newest one's month
with those that differ. The record (`fulfillments`) holds them by
NetSuite's id for each, with how many things differ, never an amount.

So are Books' own bills and receipts, the same way (owner decision
2026-10-24, "Shared bills"): a bill that differs from NetSuite's, on its
vendor, number, date, company, lines or total, and a receipt that differs
from NetSuite's item receipt, on its date, company, items or what it added
to stock, is noted at the first look and told about at the second if it
still differs, and so is one where more differs than before. A Receive
NetSuite didn't take isn't told about: it's on Receiving's list to enter by
hand. Each gets its own notification (`books_own_bill_differs`, naming the
vendor and the bill, and `books_own_receipt_differs`, naming the PO and its
vendor, in the app and by push) saying what differs first, linking to its
check; more than three of either at once get one, linking to Own bills or
Own receipts open on the newest one's month with those that differ. The
record holds them (`bills` by NetSuite's id for each bill, `receipts` by
each copy's key) with how many things differ, never an amount.

So are the changes made with Inventory Adjust, the same way (owner decision
2026-10-30, "Own postings"): one that differs from NetSuite's inventory
adjustment, on its date, location, change, value or account, is noted at the
first look and told about at the second if it still differs, and so is one
where more differs than before. One NetSuite didn't say it made isn't told
about: Own adjustments lists it as incomplete. Each gets its own notification
(`books_own_adjustment_differs`, naming NetSuite's number for it, the item and
the change, in the app and by push) saying what differs first, linking to its
check; more than three at once get one, linking to Own adjustments open on
the newest one's month with those that differ. It's the books' first alert
since "Copy me on new alerts" (Craig, 2026-10-28), so a super admin with that
ticked is emailed it too, right away; nobody else is. The record
(`adjustments`) holds them by FleetSuite's id for each, with how many things
differ, never an amount.

So are the likely mistakes the night's mistake checks keep (owner decision
2026-10-24, "Mistake checks"): one nobody has cleared is noted at the first
look and told about at the second if it's still open, so one a super admin
clears in between says nothing, and one that comes back is told about
again. Each gets its own notification (`books_mistake_found`, in the app
and by push) naming the vendor and what looks wrong, with why, opening it
on Mistake checks; more than three at once get one naming the first three,
opening the list. The record (`mistakes`) holds the open ones by their id
on Mistake checks, never a vendor or an amount. They start the day the
check began to look at them, so none is taken as known at its first look.

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
differs opens on the documents that differ, with the rest a tap away, from
the first month it differs in when that's earlier than the months it
covers (owner decision 2026-10-18, `detailMonths` in
`src/lib/books/report-links.ts`): a balance carries a difference forward
from the month it started in, so the line's own month alone would list
none. From and To pick other months.

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

## Stock by item

`/admin/books/stock` shows each item's count and value at each location,
FleetSuite's next to NetSuite's own, so FleetSuite knows its stock without
NetSuite before the changeover (owner decision 2026-10-18, "Stock by item",
counted from "Every move"). Until then it only had each item's company-wide
count, copied from NetSuite onto the parts catalog, with no location, cost
or history. What stock costs already posts to the books from the copy of
NetSuite's general ledger ("Stock and cost"); this is what lies behind the
inventory accounts, item by item. Nothing is written to NetSuite or to the
books.

### Copying stock moves

`/api/cron/books-netsuite-stock`, at :43 past each odd hour UTC, or Copy
now on the page, copies every NetSuite document dated from January 1, 2025
with a line that moves stock (`transactionline.isinventoryaffecting`):
fulfillments, item receipts, inventory adjustments and transfers, assembly
builds and unbuilds, and the invoices, credit memos and bills that move
stock themselves, for BMG and 1084. Each comes with every line of it that
names an item: the item, location, quantity (positive into stock, negative
out of it) and whether NetSuite counts the line in the item's stock. A
line that names the item without moving it, such as a cost of goods line,
is kept for its cost.

The copy is shaped like the deposits copy: the documents changed since the
last run that finished, newest first a page at a time with a saved cursor,
so the first copy of the whole history can span runs (each stops for time
after four minutes and the next carries on) and a run cut short loses
nothing. Once every changed document is in, the run lists every such
document NetSuite has and marks the ones it no longer has as gone; a list
that looks cut short, under half of the ones FleetSuite holds, marks
nothing and says so. Then it reads where each item's count starts, its
count and value at each location on December 31, 2024, from NetSuite's own
lines before 2025, and last NetSuite's own count of each item now, so that
count is as close as it can be to the copy it is checked against. Each of
those steps waits for the next run when there isn't time for it.

NetSuite's own counts are read the first way NetSuite allows:

1. each item's count and value at each location (`aggregateitemlocation`,
   with `onhandvaluemli` for the value);
2. its count at each location alone, with no value, so only counts are
   compared;
3. each item's company-wide count (`item.totalquantityonhand`, as the parts
   catalog reads it), against which FleetSuite's counts at all of the
   item's locations are put together.

The page says which. Migration 401 holds the copy
(`gl_netsuite_stock_documents` and `gl_netsuite_stock_lines`, never
deleted, `gone_at` marking what NetSuite stopped listing, and
`gl_netsuite_stock_opening` and `gl_netsuite_stock_counts`, replaced on
each run), and `src/lib/books/netsuite-stock.ts` runs it. The run is
recorded in `sync_state` as `books_netsuite_stock`, with no amount in it.

### Counting

FleetSuite's count of an item at a location is its starting count plus the
quantity of every copied line of it there that moves stock. Its value is
its starting value plus what NetSuite posted to an inventory account on its
lines, read from the copy of NetSuite's general ledger by NetSuite's line
id, so a cost NetSuite works out again later shows here once the GL copy
has it. The inventory accounts are the asset accounts of the items NetSuite
keeps in stock (inventory items and assemblies) in the copy of its lists,
when the chart of accounts has them as asset accounts, and only those items
have a value. Migration 402 made it so (field bug 2026-10-18): migration
401 took every account an item named as its asset account, and some of
NetSuite's items name the cost of goods sold account and fixed asset
accounts there, so on the first look at the real books every count matched
NetSuite's while each item's value kept what it cost when it was sold. The
copy reads the starting values again with the new accounts on its next run.
Migration 401's `gl_stock_items` gives every item
at every location for each company, NetSuite's counts and what the GL copy
holds on the inventory accounts, and `compareStock` in
`src/lib/books/stock-items.ts` puts them side by side. A count differs when
the two are a millionth or more apart (NetSuite keeps quantities with
decimals); a value differs when the two aren't the same to the cent, and
only when NetSuite gives values.

### The page

The page opens with how the last copy went and the value of all stock both
ways, then each company's inventory accounts in the copy of NetSuite's
ledger next to what its stocked items come to, in all and account by
account, with where they part below (see "The ledger, account by
account"). Each item at each location follows, the ones whose
count differs first, by item number after that: FleetSuite's count,
NetSuite's and the difference, or the same for values, with how many
documents moved it since 2025 and the last one's date. Buttons show only
the ones that differ, and a search finds an item or location. An item and
location that both sides have none of now is left out. `?only=differs`
(`deepLinks.booksStock`) opens the page on the ones that differ.

An item opens `/admin/books/stock/item` (`deepLinks.booksStockItem`,
`?item=&location=`, the location highlighted): the item at each location,
its count and value on December 31, 2024, now, and NetSuite's now, then
every document that moved it, from migration 401's `gl_stock_item_moves`,
oldest first, each with what it moved and the count it left at its
location. The page lists the newest 1,000 and says how many older ones are
counted in but not listed. A document's number opens its line by line
check on Invoices vs NetSuite under the month NetSuite posted it to: the
Stock and cost switch for a stock document or an invoice's or credit
memo's stock, the Bills switch for a bill or bill credit.

### Items set up wrong, and value left over

On the first look at the real books after migration 402, two items' values
still stood apart from NetSuite's: in NetSuite each had its asset account
and its cost of goods sold account swapped. Their receipts put what they
cost on the cost of goods sold account instead of inventory, and each
shipment put it into inventory instead of taking it out, so NetSuite's
ledger held value on items none were left of. NetSuite's own count didn't
show it, as it values what's on hand at the average cost. So the page now
does two things (owner decision 2026-10-19, "Flag them"):

- **Before a sale.** Migration 403's `gl_stock_item_setup` lists each
  active item NetSuite keeps in stock whose asset account, in the copy of
  NetSuite's lists, the chart of accounts has as anything but an asset
  account, and the asset account most stocked items use. The page lists
  them in red with what to set the asset account to on the item's
  Accounting tab in NetSuite, marks their rows, and says so on each one's
  page; once every one is right, a green chip says the asset accounts
  check out. An item drops off once NetSuite has it right and the lists
  copy has read it again. FleetSuite can't read an item's cost of goods
  sold account (NetSuite answers 500 for it, see "NetSuite's lists"), so the
  page asks for that one to be checked by hand.
- **After a sale.** A line neither side has any of on hand, that NetSuite
  values at nothing while FleetSuite's value of it isn't nothing, is value
  left over (`StockLine.leftover`): amber rather than red, counted apart
  from the values that differ, with the amount beside the item and how
  much of the total's difference it makes. The item's page says where, and
  marks in amber each move that moved the count one way and the value the
  other (`StockMove.backwards`), which is how NetSuite posts a shipment
  when an item's cost of goods sold account is an inventory account.
  Fixing the item in NetSuite puts its next moves right. What it posted
  already stays on those documents' lines: a journal entry can move it off
  the inventory account, but names no item, so the line keeps its value
  left over, and the journal entry shows as the difference between the
  inventory accounts and the items.

### The ledger, account by account

The inventory accounts are the asset accounts stocked items name, so a
fixed asset account one stocked item names (equipment, vehicles) is one,
whole: on the real books the ledger line lumped together an inventory asset
account that held much less than the items were worth and fixed asset
accounts that held a lot more, and the one difference left said nothing of
either. Migration 404's `gl_stock_ledger_parts` splits it (owner decision
2026-10-19, "Break it down"). For each company and inventory account it
gives what the GL copy held on December 31, 2024 (its starting entry) and
what posted to it since; what the stocked items started at, each one's
starting value on its own asset account (on the inventory account most of
them name when its own isn't one), and what their stock lines posted to it
since, as `gl_stock_items` values them; and every document since that
posted to it on no stocked item's stock line, the biggest first, with how
many there are and what they come to, in all and by kind. So the items less
the ledger is the starting difference less those documents
(`ledgerParts` in `stock-items.ts`).

The value table lists each account under the company's line. Below it,
each account shows the four rows (December 31, 2024; received, shipped,
built and adjusted since, alike on both sides; the documents with no
stocked item; now) and its documents, ten at first and up to the hundred
biggest, each opening its check on Invoices vs NetSuite when FleetSuite
posts its kind, with a link to the account's detail on Reports from
January 2025. A fixed asset account's documents show on a tap, and its
difference isn't amber: most of what's on it is the company's own
equipment or vehicles. A document NetSuite deleted that the GL copy still
has shows here until the next GL copy drops it.

What puts an account on the page is a stocked item naming it, so every
account but the usual one (the inventory account most stocked items name)
also names the stocked items behind it, the first 20 by name with how many
more, active or not, each linked to its moves, with what to set them to in
NetSuite (migration 405; owner decision 2026-10-19, "Name it"). On the real
books, once the one stocked item on an equipment account was set right in
NetSuite, that account left the page, but a vehicles account with no stock
on it stayed, and no active item named it. An item gone
from NetSuite no longer makes its asset account an inventory account
(`gl_stock_inventory_accounts`): NetSuite won't delete an item anything was
received or shipped on, so it held no stock.

Not yet seen in NetSuite's data, so the page is what will show it:

- whether SuiteQL in BMG's account reads `isinventoryaffecting`; if it
  can't, the copy stops and says so;
- whether NetSuite gives the quantity of a line that takes stock out
  negative, as the copy expects; if not, every count of an item sold since
  2025 would differ from NetSuite's at once;
- items bought or sold in a different unit than they're stocked in, whose
  lines' quantities may be in that unit.

## Customer and vendor balances

`/admin/books/balances` shows what each customer owes and each vendor is
owed in one company's books, FleetSuite's next to NetSuite's, so a balance
that drifts shows up by name (owner decision 2026-10-19, "Balance checks").
Until then the books were compared account by account, month by month and
document by document, so a payment put on the wrong customer, which leaves
every account and month as it was, couldn't show. Nothing is written to
NetSuite or to the books.

### Who a line belongs to

A customer's balance is what the lines that name it come to on the chart's
receivable accounts, a vendor's on its payable accounts, as migration 406's
`gl_party_balances` sums them. A customer is the FleetSuite customer a line
names: on FleetSuite's side the journal line's customer, on NetSuite's the
FleetSuite customer the ledger mirror matched the line's name to by its
NetSuite id (`ledger_customers`, an exact match), the match journal
entries, deposits and bank documents post with. One FleetSuite customer can
be several NetSuite customers, and the page says how many. The lines that
name no customer, or one the mirror hasn't matched, make one row, "Not
matched to a FleetSuite customer", since FleetSuite's books can't tell them
apart; NetSuite's names in it are listed under it with what each holds in
NetSuite's books, the 200 largest. A vendor is NetSuite's id for the line's
name on both sides (the journal's vendor reference), and "No vendor named"
is the payables lines that name nobody. When the mirror matches a customer
after FleetSuite posted its documents, its NetSuite side moves out of the
row FleetSuite can't name at once, and its FleetSuite side when the posting
run posts those documents again.

Both sides start from the starting entry split by name: the copy of
NetSuite's ledger reads NetSuite's lines before 2025 on the receivable and
payable accounts by name, placing each in a month as the starting entry
does, and keeps what each name held (`gl_netsuite_opening_parties`, see
"NetSuite's general ledger, copied"). Then each side adds every document
since: FleetSuite's journal on one side, the copy of NetSuite's general
ledger on the other, a document being the same on both sides as on Report
detail. When the split doesn't add up to the starting entry line for line
on every account (NetSuite wouldn't give the names, or hasn't been asked
since a change), the page says so, and what isn't split counts in the
total but in no one's balance.

A customer's balance reads positive when it owes, a vendor's when it's
owed. A balance differs when its two sides aren't the same to the cent; a
document differs when its two sides aren't, for that customer or vendor.
One whose documents differ while its balance matches (two documents that
make up for each other) is listed in amber, not red, and the daily check
doesn't tell about it (see "Daily check").

### The page

The page opens on BMG's customers with how the last copy of NetSuite's
ledger, posting run and daily check went, and says when the copy doesn't
hold everything NetSuite's totals say moved the accounts (`copyHoldsAccounts`
in `src/lib/books/party-balances.ts`, as the trial balance check reads
them), since NetSuite's side may be short then. Buttons pick the company and
Customers or Vendors, each with how many differ. The total of every
customer's (vendor's) balance comes first, both sides, then each one: those
whose balances differ first, the largest difference first, then by name,
the row FleetSuite can't name last, each with how many documents moved it
since 2025 and its balance before 2025. A balance at nothing on both sides
with every document matching is left out. Buttons show only those that
differ (the amber ones too), and a search finds a name, a NetSuite id or a
NetSuite name in the row FleetSuite can't name. `?only=differs`
(`deepLinks.booksBalances`) opens the page on those that differ.

A name opens `/admin/books/balances/party` (`deepLinks.booksBalance`,
`?company=&kind=&party=`, `party=none` for the row FleetSuite can't name):
the balance before 2025, what the documents since came to and the balance
now, each side, then every document that moved it, from migration 406's
`gl_party_documents`, those that differ first, then the newest, 1,000 at
most. Each shows as on Report detail: its date, type, number, name and first
memo, whether only one side has it, and, for a kind FleetSuite posts, a link
from its number to its line by line check on Invoices vs NetSuite.

### What isn't known yet

The first look at the real books will show whether SuiteQL in BMG's account
gives the name on lines before 2025 grouped as the copy asks; if it can't,
the page says the split isn't complete and every balance starts at nothing,
which is still the same on both sides. And balances will differ wherever
FleetSuite's books name a customer differently from NetSuite's lines (a
document FleetSuite posted before the mirror matched its customer, or one
NetSuite names on a line FleetSuite's rule doesn't); the documents on the
balance's page show which.

## FleetSuite's own invoices

From the day part 23 shipped, FleetSuite keeps its own copy of each invoice
it makes in NetSuite, worked out by its own rules from what it billed
rather than read back from NetSuite (owner decision 2026-10-19, "Own
invoices"). Until then FleetSuite's books held only what NetSuite booked;
for the side-by-side run in 2027, and alone from 2028, FleetSuite has to be
able to say what each invoice is on its own. The copies are
`gl_own_invoices` and `gl_own_invoice_lines` (migration 407). Since part
24 the books post a copy that matches NetSuite's invoice in place of it
("Posting FleetSuite's own invoices", below). Nothing is written to
NetSuite.

There are five ways FleetSuite invoices, and each saves a copy right after
NetSuite makes the invoice (`saveOwnInvoice` in
`src/lib/books/own-invoices.ts`): a finished vehicle, off its sales order;
a sales order's installed quantities; a PO's open quantities; the Scan
Log; and a graphics job. Saving never stops an invoice, which already
exists in NetSuite: a copy that can't be saved is logged (`[books] own copy
of NetSuite invoice … not saved`) and the invoice goes on. A copy is kept
once; saving the same invoice again changes nothing. Invoices made in
NetSuite by hand have no copy.

### How a copy is worked out

- **Lines.** The ones FleetSuite sent NetSuite, at the prices it sent
  (`createDirectInvoice` and `createInvoiceFromSO` say what they billed).
  For a sales order billed whole, a finished vehicle's say, they are what
  FleetSuite's copy of the order (`netsuite_sales_order_lines`, copied every
  two hours) still had to bill: each open line, a line billed whole at the
  order's own amount and one billed in part at its price, and the order's
  discounts and markups when nothing of it was billed before, since NetSuite
  bills those with an order's first invoice. An invoice off a sales order is
  for the order's customer. Lines that never post (subtotals, descriptions,
  item groups) and lines of nothing are left out, as the invoice rule
  leaves them out.
- **Amounts.** A line's amount is its quantity times its price, rounded
  half to even to the cent; a discount is negative.
- **Sales tax** (`tax@1`). FleetSuite's own quoting rule decides which lines
  are taxed (`src/lib/line-taxability.ts`): service items aren't, an
  admin's override wins either way, everything else is, and a discount is
  taxed as the line above it. The rate is the one in Settings → Sales Tax,
  worked out line by line and rounded half to even, as NetSuite does. A
  customer FleetSuite has as tax-exempt (every FleetSuite record with its
  NetSuite id) pays none, and nor does work at Social Circle, Georgia.
  NetSuite's Taxable box isn't used.
- **Due date.** The invoice's date, in Central time, plus the customer's
  terms as NetSuite's customer list has them (the lists copy, "NetSuite's
  lists"). A customer with no terms is due the day it's billed, as in
  NetSuite. Terms due on a day of the month aren't worked out.
- **Location.** The one FleetSuite gave NetSuite. A sales order billed whole
  books where NetSuite's order does, which FleetSuite's copy of the order
  doesn't say, so FleetSuite's invoice location rule
  (`src/lib/invoice-location.ts`) names it from the customer, when the rule
  is sure.

What FleetSuite can't work out is kept on the copy as unknown, never
guessed from NetSuite: the lines (its copy of the sales order didn't have
the order yet), the customer, the terms (a customer the lists copy doesn't
have, or terms due on a day of the month), a price (a line NetSuite priced
itself) or the location (a Masterack order with no plant named).

### The check

`checkOwnInvoice` (`src/lib/books/own-invoice-check.ts`) puts each copy next
to NetSuite's invoice as the ledger mirror copied it, from migration 407's
`gl_own_invoice_pairs`: the customer, the date, the location (from the
invoice's receivable line in the copy of NetSuite's general ledger), the due
date, each line, paired by item and a line at the same amount first, what
it comes to before tax, its sales tax and its total. A copy:

- **waits** until NetSuite's invoice, its lines and its posting are copied;
- is **voided** when NetSuite voided or deleted its invoice;
- **differs** when anything compared differs;
- is **incomplete** when nothing compared differs but FleetSuite didn't know
  something, which then isn't compared;
- **matches** otherwise.

NetSuite spreads a discount or markup over the lines it applies to: each
line's net amount, which the ledger mirror copies, carries its share, and
the discount's own line reads $0 ("Invoices"). FleetSuite bills a discount
on a line of its own, so when NetSuite's invoice has one discount or markup
reading $0, its other lines are taken at their quantities times their prices
and the discount at what that leaves, the total staying as it is
(`takeApartSpread`). With more than one such line, a line with no quantity
or price, a credit, or nothing taken off, NetSuite's lines keep their net
amounts. The copy's "How FleetSuite worked it out" says when this was done.

A sales tax that differs is explained where it can be: work at Social Circle
or a tax-exempt customer NetSuite charged, a customer NetSuite has as not
taxable, NetSuite's rate against the one in Settings, and the fewest lines
that one taxed and the other didn't (searched when an invoice has 12 lines
or fewer).

The list's sentence for a copy that differs says what differs first and why,
then names the rest, leaving out a total that differs only because the
amount before tax or the tax does, and an amount before tax that differs
only because the lines do.

### The pages

`/admin/books/own-invoices` (`deepLinks.booksOwnInvoices`, `?month=YYYY-MM`,
`&only=differs`) lists a month's copies, those that differ first, with how
many have each status, how the last ledger mirror run, copy of NetSuite's
ledger, lists copy and daily check went, and a search. Each opens
`/admin/books/own-invoices/invoice?id=` (`deepLinks.booksOwnInvoice`, by
NetSuite's id for the invoice): what's compared, side by side with why it
differs, each line, what FleetSuite didn't know and how it worked the copy
out, and a link to how the invoice posts on Invoices vs NetSuite. Both say
which copy the books posted the invoice from: the list with a chip ("Entry
901 · own copy", "Entry 812 · NetSuite's" or "Not posted yet") and how many
of the month's posted each way, the invoice's page in a sentence. The daily
check tells the super admins when one stops matching ("Daily check").

### Posting FleetSuite's own invoices

From part 24 (owner decision 2026-10-19, "Post own invoices") the books post
FleetSuite's own copy of an invoice in place of NetSuite's when:

- the copy **matches** NetSuite's invoice, as the check above says; and
- the entry the copy makes is the one NetSuite's makes with the invoice
  rule: the same amount to each account and division, the receivable for
  the same customer, on the same date.

Otherwise NetSuite's invoice posts, as it always has, since that's what the
customer was billed: when the copy differs, is incomplete or is waiting,
and when its entry can't be worked out or comes out different. Invoices vs
NetSuite says which, in a sentence. The second test means switching copies
never moves anything in the books, so Differences, the reports, the
balances and the daily check read the same whichever copy posted. A copy
that posts and then stops matching (NetSuite's invoice was changed, say)
goes back to NetSuite's at the next run, and the other way round.

The copy's entry, `own_invoice@1` (`ownEntry` in
`src/lib/books/own-invoice-posting.ts`), is the invoice rule's working on
FleetSuite's own lines: the receivable takes the copy's total and its
FleetSuite customer, each line goes to its item's income account and
division as NetSuite's line would, and the copy's sales tax goes to the
sales tax account. That's the one NetSuite's sales tax has posted to most
since January 2025, as the lists copy counted them (`salesTaxAccount`),
since FleetSuite works its tax out at one rate, with no tax code to look an
account up by. The entry is dated as NetSuite's is, in the month NetSuite
booked the invoice into, keyed as NetSuite's is (`invoice:<NetSuite
id>:<n>`) with the same memo, and its lines name FleetSuite's own
(`own:<line>`, `own:tax`). Only BMG's invoices have copies; credit memos
and 1084's invoices post as before.

The posting run reads the copies of each BMG month's invoices, from the
first month FleetSuite made any (`readOwnCopies`), and checks each as Own
invoices does. Migration 409 has `gl_invoice_postings` say which rule made
the entry that stands (`posting_rule`): an invoice whose entry was made by
the other copy's rule has it replaced, reversed and posted again in one
transaction, as when NetSuite changes an invoice. So the first run after
part 24 shipped replaced the entry of each invoice whose copy matched, and
each lists NetSuite's as an earlier entry. A read of the copies that fails
stops the run, saying what it was reading.

On Invoices vs NetSuite an invoice posted from FleetSuite's copy reads
"Entry 901 · own copy" and each month counts how many did. Opening one says
which copy made its entry, what the next run does about it, why NetSuite's
posts when it does, and links to FleetSuite's copy.

### What isn't done yet

- Credit memos, and the documents Books has no copies of, post from
  NetSuite's. Fulfillments, receipts and bills post from Books' own copies
  from part 30 ("Posting FleetSuite's own fulfillments, receipts and
  bills").
- There's no history: copies start the day part 23 shipped.
- FleetSuite's sales tax is one rate for everything but Social Circle, while
  NetSuite picks a tax code for each invoice. Where that differs, the check
  shows which invoices, by name.
- Shipping or handling NetSuite adds to an invoice's header shows as a line
  FleetSuite didn't bill.

## FleetSuite's own fulfillments

From the day part 25 shipped, FleetSuite keeps its own copy of each
fulfillment it makes in NetSuite: what it took from stock, from where and on
what day, worked out from what it knows rather than read back from
NetSuite, and it works out what that cost itself, from stock by item (owner
decision 2026-10-19, "Fulfillments"). FleetSuite fulfils a sales order
before it invoices it, every open line (`fulfillSalesOrder` in
`src/lib/netsuite.ts`), so its fulfillments are the cost side of its
invoices: what leaves stock, and the cost of goods sold it books. The copies
are `gl_own_fulfillments` and `gl_own_fulfillment_lines` (migration 416).
From part 30 the books post a copy in place of NetSuite's fulfillment when
it matches it and makes the same entry ("Posting FleetSuite's own
fulfillments, receipts and bills"), and NetSuite's otherwise ("Stock and
cost"). Nothing is written to NetSuite.

Both ways FleetSuite invoices a sales order save a copy right after NetSuite
makes the fulfillment (`saveOwnFulfillment` in
`src/lib/books/own-fulfillments.ts`): a finished vehicle
(`/api/vehicle-tracking/invoice`) and a sales order's installed quantities
(`/api/netsuite/create-invoice`). An order NetSuite already had fulfilled is
skipped, as `fulfillSalesOrder` skips it, and has no copy. Saving never
stops an invoice: a copy that can't be saved is logged (`[books] own copy of
NetSuite fulfillment … not saved`) and the invoice goes on. A copy is kept
once; saving the same fulfillment again changes nothing. Fulfillments made
in NetSuite by hand have no copy.

### How a copy is worked out

- **Items.** What FleetSuite's copy of the sales order
  (`netsuite_sales_order_lines`, copied every two hours) still had to bill,
  each line's quantity less what's billed, since FleetSuite fulfils an order
  just before it bills it, of the items that can move stock: inventory items
  and assemblies, by their types in the lists copy. A kit is kept, though
  FleetSuite doesn't know its parts, and so is an item the lists copy
  doesn't have yet, so the check can say so. Services, non-inventory items,
  discounts and the like are left out.
- **Location.** Where FleetSuite books the invoice: for a sales order's
  installed quantities, where its PO location rule puts the PO's invoice
  (`resolveLocationWithOverride` in `src/lib/invoice-location.ts`); for a
  finished vehicle, where its invoice location rule puts the customer's
  invoices, when the rule is sure.
- **Date.** The day FleetSuite made it, in Central time.

What FleetSuite can't work out is kept on the copy as unknown, never guessed
from NetSuite: the items (its copy of the order didn't have the order yet)
and the location (a Masterack order with no plant named).

### What it cost

The cost isn't kept on the copy. It's worked out each time the copy is
checked, from stock by item ("Stock by item"), FleetSuite's own count and
value of each item at each location: an item's cost each is the value
FleetSuite counted of it at that location just before the fulfillment, over
the count there, from its count and value on December 31, 2024 and every
NetSuite document since that comes before the fulfillment, by date and then
by NetSuite's id (`gl_own_fulfillment_pairs`). That's the item's average
cost at the location, as NetSuite costs an average-cost item. A line costs
its quantity at that, rounded half away from zero to the cent, and a copy
costs its lines added up. Working it out each time means a document NetSuite
dates earlier that reaches the copies later, a receipt entered the next day
and dated back say, counts, as it does in NetSuite, which costs the
fulfillment again. An item FleetSuite counted none of there can't be
costed.

NetSuite's cost is what its fulfillment took off the inventory accounts, as
the copy of its general ledger has it, line by line.

### The check

`checkOwnFulfillment` (`src/lib/books/own-fulfillment-check.ts`) puts each
copy next to NetSuite's fulfillment as the copy of NetSuite's stock moves
has it (migration 401): its date, where it took stock from, each item and
how many, and what it cost. A copy:

- **waits** until the copy of NetSuite's stock moves has NetSuite's
  fulfillment and the copy of its general ledger has its entry. The stock
  copy takes only documents that move stock, so once it has run since the
  copy was made (its `last_synced_at` in `sync_state`) without the
  fulfillment, NetSuite's took nothing from stock; once the ledger copy has
  finished a whole run more than ten minutes after, with no entry for it,
  NetSuite's booked no cost;
- is **voided** ("Deleted in NetSuite") when NetSuite deleted its
  fulfillment;
- **differs** when anything compared differs;
- is **incomplete** when nothing compared differs but FleetSuite didn't know
  something, which then isn't compared: a kit's parts (what NetSuite took
  that FleetSuite's copy doesn't have may be them), whether an item the
  lists copy doesn't have is kept in stock, where it took stock from, or
  the cost of an item it counted none of;
- **matches** otherwise.

What was taken, each item and how many, is compared apart from where it was
taken from and what it cost. So a fulfillment taken from another location
says so once, and the list's sentence doesn't name the cost too, which
follows from what was taken and from where.

### The pages

`/admin/books/own-fulfillments` (`deepLinks.booksOwnFulfillments`,
`?month=YYYY-MM`, `&only=differs`) lists a month's copies, those that
differ first, with FleetSuite's cost, NetSuite's and the difference, how
many have each status, how the last copies of NetSuite's stock moves,
ledger and lists and the daily check went, and a search. Each opens
`/admin/books/own-fulfillments/fulfillment?id=`
(`deepLinks.booksOwnFulfillment`, by NetSuite's id for the fulfillment):
what's compared, side by side with why it differs; each item with its
quantity, cost each and cost on both sides and the count and value
FleetSuite costed it from, linking to its moves on Stock by item; the
copy's entry next to NetSuite's, or what NetSuite's fulfillment posted,
account by account, when the copy's isn't worked out; what FleetSuite
didn't know; how it worked the copy out; and FleetSuite's own invoice off
the order. Both say what the books hold for it ("Posting FleetSuite's own
fulfillments, receipts and bills"). The daily check tells the super admins
when one stops matching ("Daily check").

### What isn't done yet

- There's no history: copies start the day part 25 shipped.
- FleetSuite doesn't know a kit's parts, so a fulfillment of a kit is
  incomplete.
- A fulfillment NetSuite took from more than one location differs on
  location: FleetSuite takes each one from one.

## FleetSuite's own bills and receipts

From the day part 27 shipped, Books keeps its own copy of each bill
FleetSuite puts into NetSuite, and of each receipt of a purchase order's
items, worked out from what FleetSuite knows rather than read back from
NetSuite (owner decision 2026-10-24, "Shared bills": each bill is entered
once, from FleetSuite, and Books keeps its copy to check against
NetSuite's). The copies are `gl_own_bills` and `gl_own_bill_lines`, and
`gl_own_receipts` and `gl_own_receipt_lines` (migration 435). From part 30
the books post a copy in place of NetSuite's bill or item receipt when it
matches it and makes the same entry ("Posting FleetSuite's own
fulfillments, receipts and bills"), and NetSuite's otherwise ("Vendor
bills", "Stock and cost"). Nothing more is written to NetSuite than
before.

FleetSuite makes bills four ways, and each saves a copy right after
NetSuite makes the bill (`saveOwnBill` in `src/lib/books/own-bills.ts`):

- **Create Bill in NetSuite on an approved CNI vendor invoice**
  (`/api/vendor-invoices/workflow`) and **on an approved installer payout**
  (`/api/admin/payouts`): one expense line, to the account and for the
  amount FleetSuite sent.
- **Create bill on a Parts Mail invoice** (`/api/parts-mail/create-bill`):
  NetSuite makes the bill from the invoice's purchase order, at the PO's
  prices, so the copy's lines are what FleetSuite's copy of the PO
  (`netsuite_vendor_po_lines`) still had to bill, each line's quantity less
  what's billed, at the line's price, to the cent. The vendor's invoice
  total is kept beside them, as the vendor's invoice says it.
- **Send to NetSuite on Snap a bill** (`/api/admin/books/snap-a-bill`):
  each line to the account and for the amount FleetSuite sent, with the
  bill's total beside them ("Snap a bill"). A snapped bill that billed a
  PO is the PO's open lines, as a Parts Mail bill's are, then the line for
  what the bill had beyond them ("PO bills").

A bill is dated the day FleetSuite made it, in Central time: FleetSuite
sends NetSuite no date for a bill, so NetSuite dates it that day. A snapped
bill is the exception: it's dated as the bill is, and FleetSuite sends
NetSuite that date. It's kept for the company whose NetSuite subsidiary it
was made in, else BMG.

Receive on the Receiving page (`/api/po-receipts`) saves a copy of each
Receive (`saveOwnReceipt` in `src/lib/books/own-receipts.ts`), keyed by its
first row in `po_receipts`, as one tap of Receive is one receipt: each item
and how many, at the price FleetSuite's copy of the PO has for its line,
with NetSuite's id for the item receipt when NetSuite took it, or what
NetSuite said when it didn't. It's dated as FleetSuite dated it for
NetSuite, and kept for BMG, as FleetSuite's copy of a PO doesn't say the
company.

Saving never stops a bill or a Receive: a copy that can't be saved is
logged (`[books] own copy of …`) and the work goes on. A copy is kept once;
saving the same one again changes nothing. Bills and receipts made in
NetSuite by hand have no copy. What FleetSuite can't work out is kept on the
copy as unknown, never guessed from NetSuite: a Parts Mail bill's lines (its
copy of the PO didn't have them yet) and a line's price.

### One bill each

Create Bill in NetSuite on a vendor invoice or a payout claims the row first
(`bill_claimed_at`, `makeBillOnce` in `src/lib/bill-once.ts`), as Parts
Mail's bills already did (migration 251), so only one try at a time gets
past it: a double tap, or two people at once, can't make two bills. Then it
asks NetSuite for a bill from that vendor with the same Reference No.
(`findVendorBill` in `src/lib/netsuite.ts`), so a try whose bill NetSuite
made but FleetSuite never heard back about finds that bill rather than
making another; when NetSuite can't be asked, it makes none. A bill NetSuite
refuses lets the claim go, the stamp that the row is billed clears it, and a
claim over 15 minutes old is taken over. Send to NetSuite on Snap a bill
claims the snapped bill the same way, while it's a draft.

### The checks

`checkOwnBill` (`src/lib/books/own-bill-check.ts`) puts each bill copy next
to NetSuite's bill as the copy of NetSuite's bills has it (migration 384):
its vendor, number and date, the company the copy of its general ledger
books it to, each line (an expense line by its account, an item line by its
item, with how many) and its total. NetSuite's tax and layout lines are
left out. `checkOwnReceipt` (`src/lib/books/own-receipt-check.ts`) puts each
receipt copy next to NetSuite's item receipt as the copy of NetSuite's stock
moves has it (migration 401): its date, its company, each item and how
many, and what it added to stock, the items NetSuite keeps in stock at the
PO's prices, to the cent, against what NetSuite's receipt posted to the
inventory accounts, as the copy of its general ledger has it. Where NetSuite
put it is shown, not compared. A copy:

- **waits** until the copies have NetSuite's bill or receipt, and the
  ledger entry that says a bill's company or values a receipt. Once the
  bills copy has run since without the bill, or the stock copy without a
  receipt of anything kept in stock, NetSuite's is gone;
- is **not in NetSuite** (a receipt) when NetSuite didn't take the Receive
  and it's on Receiving's list to enter by hand there;
- is **voided** ("Gone from NetSuite") when NetSuite's is gone, deleted or
  voided;
- **differs** when anything compared differs;
- is **incomplete** when nothing compared differs but FleetSuite didn't know
  something, which then isn't compared, or when there's nothing to check
  against: a receipt entered in NetSuite by hand (Receiving doesn't say
  which item receipt that is), or one NetSuite didn't say it made;
- **matches** otherwise.

A receipt's items and how many are compared apart from what it added to
stock, so another count says so once, and the list's sentence doesn't name
the cost too, which follows from it; a bill's total likewise follows from
its lines.

### The pages

`/admin/books/own-bills` (`deepLinks.booksOwnBills`, `?month=YYYY-MM`,
`&only=differs`) lists a month's bill copies, those that differ first, with
FleetSuite's total, NetSuite's and the difference and what each was made
from, how many have each status, how the last copies of NetSuite's bills,
ledger and lists and the daily check went, and a search. Each opens
`/admin/books/own-bills/bill?id=` (`deepLinks.booksOwnBill`, by NetSuite's
id for the bill): what's compared, side by side with why it differs, each
line on both sides, what FleetSuite didn't know and how it worked the copy
out, linking to the vendor invoice, payout or Parts Mail it was made from,
or the picture it was snapped from and who snapped it, and to the bill and
PO in NetSuite. `/admin/books/own-receipts` (`deepLinks.booksOwnReceipts`)
lists a month's receipt copies the same way,
with what each added to stock on both sides. Each opens
`/admin/books/own-receipts/receipt?key=` (`deepLinks.booksOwnReceipt`, by
the copy's key): what's compared, each item with its count and value on
both sides, linking to its moves on Stock by item, where Receiving's rows
for it stand, and what NetSuite said when it didn't take it. Each list and
page says what the books hold for it, and each page puts the copy's entry
next to NetSuite's ("Posting FleetSuite's own fulfillments, receipts and
bills"). The daily check tells the super admins when one stops matching
("Daily check").

### What isn't done yet

- There's no history: copies start the day part 27 shipped.
- FleetSuite's copy of a PO doesn't say the company, so a Parts Mail bill
  and a receipt are kept for BMG, and one for 1084 differs on its company.
- Receiving dates a receipt by the day in UTC, which in the evening, Central
  time, is already the next day, and NetSuite takes that date.
- Parts Mail's own claim on its bills doesn't ask NetSuite for the bill
  before making one, and isn't taken over when it's left behind.

## FleetSuite's own adjustments

From part 31 (owner decision 2026-10-30, "Own postings", then "Build it",
its second piece) Books checks each change made with Inventory Adjust
against NetSuite's inventory adjustment. Inventory Adjust (migration 454,
`src/lib/inventory-adjust.ts`) makes the adjustment in NetSuite and keeps a
row of it in `inventory_adjustments`: the item, where, how many more or
fewer, how it was entered (a number added or taken off, or what was on the
shelf), the reason, the note, who made it and NetSuite's id and number for
the adjustment. That row is Books' own copy, so no table is added: migration
457 only reads it (`gl_own_adjustment_pairs` and `gl_own_adjustment_months`).
Each is BMG's, as Inventory Adjust adjusts O'Fallon's stock, and is dated
the day it was made, in Central time.

FleetSuite values the change itself, as it costs its own fulfillments ("What
it cost"): at the item's average at that location just before, the value
FleetSuite counted of it there over the count, from its count and value on
December 31, 2024 and every NetSuite document since that comes before the
adjustment, by date and then NetSuite's id, to the cent. An item NetSuite
doesn't keep in stock comes to nothing. The other side goes to 52000
Inventory Adjustment, the account Inventory Adjust posts to.

### The check

`checkOwnAdjustment` (`src/lib/books/own-adjustment-check.ts`) puts each
one next to NetSuite's adjustment as the copy of NetSuite's stock moves has
it (migration 401), valued from the copy of its general ledger: its date,
where it changed stock, the item and by how many, what that came to against
what NetSuite's adjustment posted to the inventory accounts, and the account
on its other side. An Inventory Adjust:

- is **incomplete** when NetSuite didn't say which adjustment it made, so
  there's none to put it next to;
- **waits** until the stock copy (every two hours) has NetSuite's adjustment
  and the ledger copy has its entry. Once the stock copy has run since
  without it, NetSuite's is gone ("Gone from NetSuite"), as it is when
  NetSuite deleted it: an adjustment always moves stock. Once the ledger copy
  has run since with no entry for it, NetSuite's booked nothing;
- **differs** when anything compared differs;
- is **incomplete** when nothing compared differs but FleetSuite couldn't
  work something out (where it changed stock, whether the item is kept in
  stock, or a value when it counted none there just before), which then
  isn't compared;
- **matches** otherwise.

The value follows from the change and where it was made, so when either
differs the list's sentence doesn't name the value too.

### The pages

`/admin/books/own-adjustments` (`deepLinks.booksOwnAdjustments`,
`?month=YYYY-MM`, `&only=differs`) lists a month's Inventory Adjusts, those
that differ first, with what each change came to on FleetSuite's side, on
NetSuite's and the difference (stock taken out in brackets), the reason and
who made it, what the books hold for it, how many have each status, how the
last copies of NetSuite's stock moves, ledger and lists and the daily check
went, and a search. Each opens `/admin/books/own-adjustments/adjustment?id=`
(`deepLinks.booksOwnAdjustment`, by FleetSuite's id for it): what's
compared, side by side with why it differs, the copy's entry next to
NetSuite's, account by account ("Posting FleetSuite's own fulfillments,
receipts and bills"), what FleetSuite didn't know and how it worked the
value out, linking to the item's moves on Stock by item and to the
adjustment in NetSuite. Invoices vs NetSuite links each adjustment it lists
that has an Inventory Adjust to it. The daily check tells the super admins
when one stops matching ("Daily check").

### Posting

The books post an Inventory Adjust in place of NetSuite's adjustment when it
matches it and makes the same entry, with `own_adjustment@1`, keyed as
NetSuite's is (`inventory_adjustment:<NetSuite id>:<n>`), as they post the
own fulfillments and receipts ("Posting FleetSuite's own fulfillments,
receipts and bills"). One NetSuite didn't say it made posts nothing from
FleetSuite: NetSuite's adjustment posts as NetSuite booked it.

### What isn't done yet

- There's no history: Inventory Adjust began on 2026-10-30, and an
  adjustment made in NetSuite by hand has no Inventory Adjust, so it posts
  from NetSuite's.
- NetSuite values an adjustment at its own average cost, which a document
  dated earlier and entered later can move after the fact; FleetSuite's
  average comes from the copies as they stand, so the two can differ by
  cents, and NetSuite's posts.

## Posting FleetSuite's own fulfillments, receipts and bills

From part 30 (owner decision 2026-10-30, "Own postings", then "Build it")
the books post Books' own copy of a fulfillment FleetSuite made, of a
Receive NetSuite took and of a bill FleetSuite put into NetSuite, snapped
bills among them, in place of NetSuite's document, as they post its own
invoices ("Posting FleetSuite's own invoices"), and from part 31 a change
made with Inventory Adjust too ("FleetSuite's own adjustments"), when:

- the copy **matches** NetSuite's document, as Own fulfillments, Own
  receipts, Own adjustments or Own bills checks it; and
- the entry the copy makes is the one NetSuite's makes: the same amount to
  each account, on the same date, and for a bill the payables for the same
  vendor.

Otherwise NetSuite's document posts, as it always has: when the copy
differs, is incomplete or is waiting, and when its entry can't be worked
out or comes out different. The second test means switching copies never
moves anything in the books, so Differences, the reports, the ledger on
Stock by item, the balances and the daily check read the same whichever
copy posted. A copy that posts and then stops matching (NetSuite's
document was changed, say) goes back to NetSuite's at the next run, and
the other way round. A document whose own lines in NetSuite can't be worked
out, or are caught mid-refresh, keeps whatever entry stands.

The copies' entries (`src/lib/books/own-stock-posting.ts` and
`src/lib/books/own-bill-posting.ts`):

- **A fulfillment** (`own_fulfillment@1`): each item's cost, as Own
  fulfillments works it out (its average at the location just before),
  comes off the item's asset account, as the copy of NetSuite's items has
  it, and goes to its cost of goods account. NetSuite won't give an item's
  cost of goods account, so it's the account NetSuite's last fulfillment of
  the item before this one debited its cost to, or, for an item NetSuite
  hasn't fulfilled before, the one most of the company's fulfillments debit
  theirs to (`gl_own_stock_accounts`, migration 456). When NetSuite's
  fulfillment put an item's cost in another account, its page says so, and
  the item's next fulfillment takes NetSuite's account from it.
- **A receipt** (`own_receipt@1`): each item NetSuite keeps in stock goes
  onto its asset account at the purchase order's price, as Own receipts
  works it out, and what they come to is credited to the account the
  company's item receipts hold received stock against until it's billed,
  the one most of them credit, as the bill rule picks it.
- **A bill** (`own_bill@1`): the bill rule's working on the copy's own
  lines, with the accounts NetSuite's bill is worked out with: payables take
  the copy's total and carry its vendor, an expense line goes to its
  account, and an item line to where NetSuite puts the item, a stock item
  from a purchase order's line to the account received stock is held
  against until it's billed.
- **An adjustment** (`own_adjustment@1`): what the change came to, as Own
  adjustments works it out (the item's average at the location just
  before), goes onto the item's asset account, or comes off it, against
  52000 Inventory Adjustment, the account Inventory Adjust posts to.

Each is dated as NetSuite's is, in the month NetSuite booked the document
into, keyed as NetSuite's is (`item_fulfillment:<NetSuite id>:<n>`,
`item_receipt:…`, `inventory_adjustment:…`, `vendor_bill:…`), and its lines
name the copy's own (`own:<item>:cost`, `own:<item>:asset`, `own:received`,
`own:adjustment`, `own:<line>`). Fulfillments and adjustments are BMG's; a
receipt or a bill posts for the company it's kept for, and one NetSuite
booked to both companies posts from NetSuite's.

The posting run reads the copies of each month's fulfillments, receipts,
adjustments and bills, made on the days they're dated, from the first month
Books made any, and checks each as the Own pages do, against the copies of
NetSuite's stock moves, bills and general ledger as far as they had come.
Migration 456 has `gl_stock_postings` and `gl_bill_postings` say which rule
made the entry that stands (`posting_rule`), so a document whose entry was
made by the other copy's rule has it replaced, reversed and posted again in
one transaction, the reversal's memo saying why ("IF-1234 now posts from
FleetSuite's own copy"). So the first run after part 30 shipped replaced the
entry of each document whose copy matched, and the first after part 31 that
of each adjustment, and each lists NetSuite's as an earlier entry. A read of
the copies that fails stops the run, saying what it was reading.

Own fulfillments, Own receipts, Own adjustments and Own bills show on each
row what the books hold for NetSuite's document ("Entry 902 · own copy",
"Entry 871 · NetSuite's", "Not posted yet") and count them above the list.
Each one's page says which copy made its entry, what the next run does about
it and, when NetSuite's posts, why, with a link to the document on Invoices
vs NetSuite, and puts the copy's entry next to NetSuite's, account by
account, with what differs in red. On Invoices vs NetSuite each one posted
from its copy reads "Entry 902 · own copy", its month counts how many did,
and opening it links to its copy.

### What isn't done yet

- Transfers, builds and unbuilds and invoices' cost lines post from
  NetSuite's: Books keeps no copies of them yet. So do inventory
  adjustments made in NetSuite by hand, which have no Inventory Adjust.
- Bill credits and bill payments post from NetSuite's. A Receive NetSuite
  didn't take posts nothing until it's entered there by hand, and then
  NetSuite's receipt posts, as Receiving doesn't know which it is.
- An item's cost of goods account is learned from NetSuite's fulfillments,
  so after NetSuite moves an item to another account, its next fulfillment
  posts from NetSuite's, and the one after takes the new account.

## Snap a bill

From the day part 28 shipped, a super admin can enter a vendor's bill in
NetSuite from a picture of it (owner decision 2026-10-25, "Snap a bill", as
Books Previews drew it). Books → Snap a bill (`/admin/books/snap-a-bill`,
`deepLinks.booksSnapBill`) takes a picture with the phone's camera, or a
PDF or picture picked from the phone or computer. FleetSuite reads it, the
super admin checks each box against the bill, and Send to NetSuite enters
it as a vendor bill for BMG or 1084, once only. Books keeps its own copy, as
it does for the other bills FleetSuite makes ("FleetSuite's own bills and
receipts"). Each snapped bill is a row of `gl_snapped_bills` (migration
436), from its picture to NetSuite's bill.

### The picture

The page turns an iPhone's HEIC picture into a JPEG and shrinks a photo to
2400 pixels on its longest side before it uploads it
(`shrinkPhotoForUpload`), then uploads it as record files go
(`uploadRecordFile`): straight to storage, else through the route. A
picture is taken up to 5MB and a PDF up to 20MB, the most the reader takes.
It's kept under the storage prefix `books-bills`, named by a random id,
which `/api/storage` never serves (`src/lib/storage-guard.ts`): only the
route does (`?file=`, `deepLinks.booksSnapBillFile`), to super admins,
never cached. A bill thrown away is kept, marked thrown away, with its
picture.

### Reading it

`readBill` (`src/lib/books/bill-reader.ts`) sends the picture or PDF to
Claude (`claude-opus-5-5`, or the model `BILL_READER_MODEL` names, with
`ANTHROPIC_API_KEY`) and asks for a fixed shape back: whether it's a
vendor's bill at all, the vendor's name, the bill number, its date and due
date, its terms, the PO number it names, each charge with its amount, its
total, and what it says is due. What the reader couldn't read is left empty, never guessed: a total it
couldn't read too, rather than the lines added up, since the lines are
checked against it. It keeps a bill's first 200 lines, the most the form
takes, so a longer statement comes up short of its total. When the model
declines a bill, the API reads it again with the model Anthropic recommends
(server-side fallbacks); a busy API is tried again (`callAnthropicWithRetry`).
A read costs about 5 to 10 cents. A read that fails says why on the page,
with Read it again; one that isn't a bill says so, and the form can still be
filled in by hand. A read fills in the form only if nobody saved or sent it
while it read.

### The suggestions

From what was read, `formFromRead` (`src/lib/books/snap-a-bill.ts`) fills in
the form:

- **The vendor**: the vendor in the copy of NetSuite's vendor list whose
  name has the same words (`matchVendor`). A close match is shown in amber
  with the others like it to pick from. The vendor box searches the copy,
  and NetSuite itself for a vendor made since the copy last ran.
- **The company**: the one the copy of the general ledger books most of the
  vendor's bills to, else BMG. A note says when their bills went to the
  other one.
- **The location**: where the vendor's bills in the company usually go,
  else `NETSUITE_DEFAULT_LOCATION_ID`, else the company's O'Fallon
  location, or its first.
- **The due date**: the bill's date and the vendor's terms in NetSuite,
  else the due date on the bill. One picked by hand stays.
- **Each line's account**: a line like one on the vendor's earlier bills
  (half its words or more) goes where that one went, and the biggest line
  where their bills keep going (the same account on each of their latest
  bills, or on two thirds of up to twelve; a bill whose expense lines come
  to under half of it, such as a PO's bill, doesn't count). With no bills
  yet, it's the vendor's default expense account in NetSuite. Anything else
  waits for someone to pick it, in amber. Only accounts the company can use
  are suggested.

The vendor's earlier bills are what the copy of NetSuite's bills has
(`gl_vendor_bill_history`): their latest 24, voided ones left out, each
expense line's account and memo (tax and item lines left out), and the
companies and locations the copy of the general ledger books each to.

Each change on the page asks the route again (`check`, a moment after the
typing stops), which works out the suggestions again for what hasn't been
picked by hand. The page takes the answer only if nothing changed
meanwhile.

### Before Send

Under the lines, green first, then amber, then red (`viewSnapForm`):

- whether the lines add up to the bill's total, which they must;
- when the bill says more is due than its own charges, that it likely
  carries an earlier balance, which isn't entered;
- **Already in NetSuite**: NetSuite has a bill from the vendor with that
  number (`findVendorBill`, asked as typed), or the copy of NetSuite's bills
  has one of theirs numbered the same in its letters and digits, whatever
  its date. Send stays greyed out, and the card links to NetSuite's bill;
- a bill, check or card charge to the vendor for the same amount within a
  week of the bill's date (`gl_mistake_docs`), which may be this bill
  entered already. It doesn't stop Send;
- what must change before Send: the vendor picked from NetSuite's list, a
  bill number (up to 40 characters), the bill's date, a due date on or
  after it, one of the company's locations, a total over $0, and each
  line's amount and an account the company can use. A company not linked
  to a NetSuite subsidiary can't send.

Send to NetSuite saves the form first, so a refusal loses nothing, then
checks it all again on the server, asking NetSuite again. It claims the
snapped bill (`makeBillOnce`, as Create Bill does a vendor invoice), asks
NetSuite once more for a bill from the vendor with that number, and makes
the bill (`createVendorBill`): the vendor, the bill number as its Reference
No., the company's subsidiary, the location, the bill's date, the due date
(left out when there's none, so NetSuite works it out from the terms), the
memo "FleetSuite Snap a bill", and each line to its account for its amount,
its description as its memo. When NetSuite doesn't say which bill it made
(the connection drops, or no id comes back), FleetSuite asks it for the
bill before calling the Send failed. Then it marks the snapped bill sent
with NetSuite's id for the bill, keeping the form that went, and Books keeps
its own copy (`saveOwnBill`, made from `snapped`). What NetSuite says when it
refuses is kept on the snapped bill and shown in red. When NetSuite made the
bill but FleetSuite couldn't mark it sent, the claim stays, so nobody sends
it again while it reads as a draft, and the page says to find the bill in
NetSuite. Once the claim has gone stale (15 minutes), the Already in
NetSuite card of a bill whose Send didn't finish offers Mark it sent: it
asks NetSuite for the bill and keeps it as sent, with Books' own copy,
without sending anything.

### The page

Save for later keeps the form as it is, and the start screen lists the
bills saved for later. Nothing on a bill can change while it's being read,
saved or sent, and no Save goes onto a bill a Send holds. Throw it away
asks once more. A bill sent shows
NetSuite's bill, who sent it and Snap another. Own bills lists it with who
sent it ("Snapped by"), linking back here.

### What isn't done yet

- The picture isn't attached to NetSuite's bill; it stays with Books'.
- Vendor credits and paying bills aren't part of it.

## PO bills

From the day part 29 shipped, a snapped bill that names one of the vendor's
open purchase orders bills that PO in NetSuite, the way Parts Mail's Create
bill does (owner decision 2026-10-25, "Freight line", as Books Previews drew
it; `src/lib/books/snap-po.ts`, migration 444). NetSuite bills the PO's open
lines at its prices, which settles what Receiving booked for them, and the
PO shows billed. What the vendor's bill has beyond what's left on the PO,
freight say, goes on the same bill as its own line, to an account picked for
it. When that's only lines the bill prints that aren't on the PO, it needs
no reason (owner decision 2026-10-26, "No reason for freight").

### The PO

The reader reads the PO number off the bill, and the PO box under the due
date takes one typed. The PO is looked for in FleetSuite's copy of
NetSuite's POs (`netsuite_vendor_pos`, every two hours) by its number, case
aside, else the vendor's newest with the same digits ("453" or "P.O. #453"
for PO453-ACME), else the one PO anyone has with those digits (`findPo`). A
bill that names none is offered up to five of the vendor's POs that can take
a bill, to tap: one for exactly the bill's total first, then those received,
partly received and still to come, newest first in each (`pickOpenPos`).

A PO can take the bill when it's the vendor's, NetSuite bills it (not
pending approval, rejected, planned, fully billed or closed:
`canBillPoStatus`; a Pending Bill PO, fully received, can, which Parts
Mail's check used to show in red) and something on it is left to bill.
Without a vendor picked yet, the PO's vendor is offered. FleetSuite's copy
of a PO keeps no company, so a PO's bill is BMG's, and the page hides the
company and location while it bills the PO: the PO brings them.

### The checks

Bill PO453-ACME, the default once the PO can take the bill, shows what
NetSuite bills (the PO's open lines, each line's quantity less what's
billed at its price, and the extra line) and Parts Mail's three-way match
(`computeThreeWayMatch` in `src/lib/three-way-match.ts`), each leg on its
own:

- **Totals**: the bill's total against the PO's, green within $25 or 2%,
  whichever is more;
- **Received**: how much of what's ordered Receiving has had, the short
  lines named; billing the PO bills all of it;
- **Earlier bills**: Parts Mail's and snapped bills already on the PO, and
  the units NetSuite shows billed on it.

A bill beyond the PO only by lines it prints that aren't on the PO, each
saying what it is (freight, say), has its totals checked without them, so
it bills with one tap like a bill for the PO's total: "The bill is the PO's
$2,140.00 plus $240.00 for freight, which goes on its own line." That's
only for a PO with nothing billed on it yet. Leaving the extra line off, a
price that changed as well as the freight, a line that doesn't say what it
is, or more of one of the PO's items keeps the totals check as it is.

A check that didn't pass needs a reason (Why bill it anyway?), and Bill it
anyway logs it as Parts Mail's Create bill does
(`vendor_bill_variance_override`, which the weekly digest reads). Plain bill
enters the bill's own lines, as Snap a bill otherwise does, and says it
leaves the PO open, with what Receiving booked for it unsettled.

### The extra line

The extra line is what the bill is more than what's left to bill on the PO:
its total less what's billed on its lines at its prices (`poLeftCents`), so
a second bill on a PO is set against what's left. Its words come from the
bill's own lines that aren't on the PO (not for one of its lines' amounts,
nor naming one of its items): the one for exactly that amount, else all of
them when they add up to it (`linesBeyondPo`, `extraWords`), else they're
typed. When each of them says what it is, the totals check leaves them out
(The checks). Its account is suggested only from a line like it on the
vendor's earlier bills (`suggestExtraAccount`), never where their bills'
parts go, and must be one BMG can use. Leave it off bills the PO alone, and
the page says what's left off; Add it back puts it back.

### Send

Send checks it all again on the server, claims the snapped bill and asks
NetSuite once more for a bill from the vendor with that number, as Snap a
bill always does. Then it bills the PO (`createBillFromPo`, the transform
Parts Mail's Create bill uses) with the bill number as its Reference No.,
the bill's date, the due date, the memo and the extra line as an expense
line after the PO's. The snapped bill is marked sent with the PO it billed
(`billed_po_netsuite_id`, `billed_po_number`) and the extra line's amount
(`billed_extra`), and Books keeps its own copy: the PO's open lines, as a
Parts Mail bill's, then the extra line. Until FleetSuite's copy of the PO
shows it billed, a snapped bill that billed a PO counts as an earlier bill
on it, for Parts Mail's Create bill too.

### What isn't done yet

- FleetSuite's copy of a PO keeps only its item lines, so a PO's other
  lines aren't shown, and Books' own copy differs from NetSuite's by them.
- The totals check, as Parts Mail's, compares a second bill on a PO with
  the PO's whole total, so it needs a reason.
- Mark it sent, once FleetSuite's copy shows the PO billed, keeps the bill
  as a plain one.

## Mistake checks

Each night FleetSuite looks through the bills, checks and card charges it
copies from NetSuite for likely mistakes, and lists each one, with why, on
Books → Mistake checks for a super admin to clear (owner decision
2026-10-24, "Mistake checks": an idea borrowed from bookkeeping software,
built next to the crossover, for the owner alone). Nothing is written to
NetSuite or to the books: a mistake is fixed in NetSuite, and the copies
bring the fix back.

`/api/cron/books-mistake-checks` runs at 09:46 UTC (4:46 AM Central, 3:46
in winter), after the night's copies of NetSuite's checks and card charges
(:33 on odd hours) and bills (:39), and before the daily check (:58), which
tells the super admins about new ones ("Daily check"). Look now on the page
runs the same look straight away. The look (`runMistakeChecks` in
`src/lib/books/mistake-checks.ts`) reads the copies a quarter at a time
(`gl_mistake_docs`, migration 431) and keeps what it finds at once
(`gl_mistake_checks_save`); the record in `sync_state`,
`books_mistake_checks`, holds how it went.

It flags documents dated from September 1, 2026 (`LOOK_FROM`), and works
out what's usual for a vendor from everything the copies hold, since
January 2025 (`USUAL_FROM`). It looks at the bills, checks and card charges
NetSuite still has, not voided, with a vendor or payee; bill credits and
card refunds aren't flagged. A document's company is the one its GL lines
post to; one the copy of NetSuite's ledger hasn't reached yet goes with the
company the vendor's others post to most, or BMG.

### The four checks

- **Entered twice.** Two bills from the same vendor for the same amount
  with the same invoice number (its letters and digits, in any case), the
  likeliest; a bill and a check or card charge to the same vendor for the
  same amount within 7 days, which may be one bill entered both ways; and
  two checks or card charges to the same payee for the same amount on the
  same day, from $25, when there are just the two. Each pair is one item
  (`twice:<id>+<id>`), flagged when the later of the two is dated from
  September 1.
- **Far off usual.** A document from a vendor with at least six earlier
  ones: when their last six to twelve were all within 5% of each other and
  this one is ten times that or a tenth of it, the larger $100 or more,
  which can be a slipped decimal point; otherwise when it's $500 or more
  and over twice the most they've billed or charged (`far_off:<id>`).
- **Monthly charge missing.** A vendor that billed or charged a company
  every month for at least six months in a row, with nothing for the month
  a week after the day it usually comes (the middle of the days each
  month's first came on). The month just past is looked at until the
  current month's would be late. Its amount is about what the months came
  to (`missing:<company>:<vendor>:<YYYY-MM>`). It stays open until
  something comes for that month, even when later months break the run.
- **Odd account.** A document coded to an expense account none of the
  vendor's earlier documents used, when there are at least five with
  accounts and they used no more than three between them
  (`odd_account:<id>`). Tax lines and item lines aren't looked at: an
  item's account comes with the item.

### Clearing

Each item (`gl_mistake_checks`) is open until it's cleared:

- **Fixed in NetSuite**, by a super admin, with a note if they like. If the
  look still finds it once the copies made after the clear have it (the
  older of the bills' and the checks and card charges' last runs), it
  comes back, marked "Back" with the day.
- **Fine as it is**, by a super admin, with a note. For an odd account or a
  monthly charge a box, unticked to start, also teaches the check: those
  accounts are fine for that vendor from now on, or that monthly charge
  isn't watched. Opening the item again unlearns it.
- **On its own**, when the copies no longer show it: a document gone from
  NetSuite, voided, or changed so the two no longer match, the missing
  charge come in, or an account now fine for the vendor. It says what
  changed, and comes back if the look finds it again.

A super admin can open any cleared item again (`gl_mistake_check_reopen`).
Who cleared each one, when, how and with what note is kept.

### The page

`/admin/books/mistake-checks` (`deepLinks.booksMistakeChecks`,
`?company=`, `&item=` to pick one out) shows a company's open items, the
likeliest first, or its cleared ones, newest first, each with why, its
documents linked to NetSuite and the buttons to clear it; when the look
and the copies it looked through last ran, and anything that failed, in
red; and Look now. Books links to it, and the daily check's notifications
open it.

### What isn't done yet

- Bill credits, card refunds and journal entries aren't looked at.
- Amounts are compared to the cent, so a bill entered twice with a typo in
  its amount isn't caught.
- Only expense lines' accounts are looked at, not items'.

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
