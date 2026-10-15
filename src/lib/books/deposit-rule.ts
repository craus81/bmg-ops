import type { RuleLine } from './invoice-rule';
import { RECEIVABLE_LINE } from './payment-rule';

/**
 * How a customer deposit, and applying it, posts: deposit@1 (docs/books.md
 * "Customer deposits").
 *
 * A customer deposit is money a customer pays ahead of an invoice. The money
 * goes to the account the deposit went to, Undeposited Funds or a bank
 * account, and the customer deposits account, what BMG owes the customer
 * until the work is invoiced, is credited with it. Where the money went is
 * the deposit's own choice, as a payment's is, so it comes from NetSuite's
 * posting of the deposit (src/lib/books/deposit-check.ts), and during 2027
 * FleetSuite copies NetSuite's choice exactly.
 *
 * A deposit application applies a deposit to an invoice, or to a refund:
 * the customer deposits account is debited with what it applies and
 * receivables credited, so the invoice is paid by money already in hand.
 *
 * Which account holds customer deposits is the company's: the one NetSuite's
 * deposits use. The receivable is the company's, as the invoice rule picks
 * it.
 *
 * Pure: it works out a document's entry, or says why it can't, and posts
 * nothing; the posting job (src/lib/books/invoice-posting.ts) posts it, the
 * customer on the customer deposits line and an application's receivable.
 * Amounts are whole cents, debit positive.
 */

export const DEPOSIT_RULE = 'deposit@1';

export type DepositType = 'CustDep' | 'DepAppl';

/**
 * What the journal files each one's entries under (gl_entries.source_type,
 * migration 383), and keys them by: customer_deposit:<NetSuite id>:<n>.
 */
export const DEPOSIT_SOURCE_TYPE = { CustDep: 'customer_deposit', DepAppl: 'deposit_application' } as const satisfies Record<DepositType, string>;
export type DepositSourceType = (typeof DEPOSIT_SOURCE_TYPE)[DepositType];

/** The entry's lines, by what they post. Receivables are RECEIVABLE_LINE, as on a payment. */
export const MONEY_LINE = 'money';
export const DEPOSITS_LINE = 'deposits';

export type DepositProblem =
  | { kind: 'unreadable' }
  | { kind: 'no_money_account' }
  | { kind: 'no_deposits_account' }
  | { kind: 'no_receivable' };

export interface DepositRuleResult {
  /** Empty whenever there's a problem: a document posts whole or not at all. */
  lines: RuleLine[];
  problems: DepositProblem[];
}

/**
 * One customer deposit's or deposit application's entry. `cents` is its
 * total, null when the copy's can't be read; `moneyAccount` where a
 * deposit's money went. A document of $0, a voided one, posts nothing.
 */
export function depositEntry(
  doc: { type: DepositType; cents: number | null; moneyAccount: string | null },
  accounts: { deposits: string | null; receivable: string | null },
): DepositRuleResult {
  if (doc.cents === null) return { lines: [], problems: [{ kind: 'unreadable' }] };
  if (doc.cents === 0) return { lines: [], problems: [] };

  const problems: DepositProblem[] = [];
  if (doc.type === 'CustDep' && !doc.moneyAccount) problems.push({ kind: 'no_money_account' });
  if (!accounts.deposits) problems.push({ kind: 'no_deposits_account' });
  if (doc.type === 'DepAppl' && !accounts.receivable) problems.push({ kind: 'no_receivable' });
  if (problems.length) return { lines: [], problems };

  const line = (account: string, cents: number, lineId: string): RuleLine => ({ account, cents, lineId, itemNumber: null, division: null });
  if (doc.type === 'CustDep') {
    return { lines: [line(doc.moneyAccount!, doc.cents, MONEY_LINE), line(accounts.deposits!, -doc.cents, DEPOSITS_LINE)], problems };
  }
  return { lines: [line(accounts.deposits!, doc.cents, DEPOSITS_LINE), line(accounts.receivable!, -doc.cents, RECEIVABLE_LINE)], problems };
}
