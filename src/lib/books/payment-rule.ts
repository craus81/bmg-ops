import type { RuleLine } from './invoice-rule';

/**
 * How a customer payment posts: payment@1 (docs/books.md "Payments").
 *
 * The money goes to the account the payment was deposited to, Undeposited
 * Funds or a bank account, and receivables are credited with the payment's
 * total. Where the money went is the payment's own choice, as its item is an
 * invoice line's. The copy of the payment doesn't keep it, so it comes from
 * NetSuite's posting of the payment (src/lib/books/payment-check.ts), and
 * during 2027 FleetSuite copies NetSuite's choice exactly. The receivable is
 * the company's, as the invoice rule picks it.
 *
 * Pure: it works out a payment's entry, or says why it can't, and posts
 * nothing. Amounts are whole cents, debit positive.
 */

export const PAYMENT_RULE = 'payment@1';

/** The entry's two lines, by what they post. */
export const DEPOSIT_LINE = 'deposit';
export const RECEIVABLE_LINE = 'receivable';

export type PaymentProblem =
  | { kind: 'unreadable' }
  | { kind: 'no_deposit_account' }
  | { kind: 'no_receivable' };

export interface PaymentRuleResult {
  /** Empty whenever there's a problem: a payment posts whole or not at all. */
  lines: RuleLine[];
  problems: PaymentProblem[];
}

/**
 * One payment's entry. `cents` is its total, null when the copy's can't be
 * read; a payment of $0, one that only applies a credit to an invoice, posts
 * nothing.
 */
export function paymentEntry(
  payment: { cents: number | null; depositAccount: string | null },
  receivable: string | null,
): PaymentRuleResult {
  if (payment.cents === null) return { lines: [], problems: [{ kind: 'unreadable' }] };
  if (payment.cents === 0) return { lines: [], problems: [] };

  const problems: PaymentProblem[] = [];
  if (!payment.depositAccount) problems.push({ kind: 'no_deposit_account' });
  if (!receivable) problems.push({ kind: 'no_receivable' });
  if (problems.length) return { lines: [], problems };

  return {
    lines: [
      { account: payment.depositAccount!, cents: payment.cents, lineId: DEPOSIT_LINE, itemNumber: null, division: null },
      { account: receivable!, cents: -payment.cents, lineId: RECEIVABLE_LINE, itemNumber: null, division: null },
    ],
    problems,
  };
}
