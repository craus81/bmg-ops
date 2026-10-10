# FleetSuite books

FleetSuite is taking over the books from NetSuite: built hidden through the
end of 2026, run side by side with NetSuite for all of 2027, and the only
books from 2028-01-01 (owner decision 2026-10-09/10; the full plan is the
"Replacing NetSuite with FleetSuite" doc). It keeps two companies: BMG Fleet
Installations LLC and 1084 Cool Springs LLC, which owns the building.

This file covers part 1, the ledger core. Nothing in the app reads or
writes these tables yet.

| Piece | Where |
| --- | --- |
| Companies, chart of accounts, months, journal | `migrations/359-books-ledger-core.sql` |
| Server helper (validate, post, reverse, close, reset) | `src/lib/books/journal.ts` |
| Database rule tests (PGlite) | `src/lib/books/ledger-core-sql.test.ts` |

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
- The same idempotency key never posts twice, so a retried post is safe.
- Until a company has `books_live_from` set, `resetJournal` empties the
  journal and its months for another rehearsal. Once any company is live,
  that is refused, the live date can't change, and entries dated before it
  are refused unless they are opening balances.

Only the service role can read or write the `gl_*` tables or call the
`gl_*` functions. RLS is on with no policies.

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
   `source_type = 'opening_balance'`.
