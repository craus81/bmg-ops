/**
 * How a NetSuite bank deposit or transfer posts: bank@1 (docs/books.md "Bank
 * deposits and transfers").
 *
 * A bank deposit (NetSuite's Deposit) puts money into a bank account, most
 * often the customer payments waiting in Undeposited Funds; a transfer
 * (NetSuite's Transfer) moves money from one bank account to another. Both
 * post the way a journal entry does (owner decision 2026-10-17, thread
 * "Replacing NetSuite with FleetSuite": posted "From the ledger copy"): their
 * lines for a company in the copy of NetSuite's GL (migration 361), to the
 * same accounts and for the same amounts, are that company's entry, worked
 * out with the journal entry rule (journal-entry-rule.ts) line for line. So
 * each line keeps its memo with its name in front, a receivables line
 * carries its customer and a payables line its vendor, a line of $0 posts
 * nothing, and one whose lines for the company don't balance on their own
 * can't be worked out.
 */

export const BANK_RULE = 'bank@1';

/** NetSuite's transaction types for a bank deposit and a transfer, as the copy of its GL keeps them. */
export type BankType = 'Deposit' | 'Transfer';

/** What a bank deposit's and a transfer's entries are filed as (gl_entries.source_type, migration 394), keyed <source type>:<NetSuite id>:<n>. */
export const BANK_SOURCE_TYPE = { Deposit: 'bank_deposit', Transfer: 'bank_transfer' } as const satisfies Record<BankType, string>;
export type BankSourceType = (typeof BANK_SOURCE_TYPE)[BankType];
