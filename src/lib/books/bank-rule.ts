/**
 * How a NetSuite bank deposit, transfer or customer refund posts: bank@1
 * (docs/books.md "Bank deposits, transfers and refunds").
 *
 * A bank deposit (NetSuite's Deposit) puts money into a bank account, most
 * often the customer payments waiting in Undeposited Funds; a transfer
 * (NetSuite's Transfer) moves money from one bank account to another; a
 * customer refund (NetSuite's CustRfnd) pays a customer back out of
 * Undeposited Funds or a bank account. All three post the way a journal
 * entry does (owner decisions 2026-10-17, thread "Replacing NetSuite with
 * FleetSuite": posted "From the ledger copy", and 2026-10-18 for refunds):
 * their lines for a company in the copy of NetSuite's GL (migration 361), to
 * the same accounts and for the same amounts, are that company's entry,
 * worked out with the journal entry rule (journal-entry-rule.ts) line for
 * line. So each line keeps its memo with its name in front, a receivables
 * line carries its customer and a payables line its vendor, a line of $0
 * posts nothing, and one whose lines for the company don't balance on their
 * own can't be worked out.
 */

export const BANK_RULE = 'bank@1';

/** NetSuite's transaction types for a bank deposit, a transfer and a customer refund, as the copy of its GL keeps them. */
export type BankType = 'Deposit' | 'Transfer' | 'CustRfnd';

/**
 * What a bank deposit's, a transfer's and a customer refund's entries are filed as (gl_entries.source_type, migrations 394 and
 * 399), keyed <source type>:<NetSuite id>:<n>.
 */
export const BANK_SOURCE_TYPE = {
  Deposit: 'bank_deposit', Transfer: 'bank_transfer', CustRfnd: 'customer_refund',
} as const satisfies Record<BankType, string>;
export type BankSourceType = (typeof BANK_SOURCE_TYPE)[BankType];
