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
 * A discount the customer took goes to its own account, and receivables are
 * credited with it too: the invoices are paid by the money plus the
 * discount. The copy of the payment doesn't keep the discount either, so it
 * comes from NetSuite's posting the same way.
 *
 * Pure: it works out a payment's entry, or says why it can't, and posts
 * nothing. Amounts are whole cents, debit positive.
 */

export const PAYMENT_RULE = 'payment@1';

/** The entry's lines, by what they post. */
export const DEPOSIT_LINE = 'deposit';
export const DISCOUNT_LINE = 'discount';
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
 * read, and `discount` what the customer took off, with the account it goes
 * to. A payment of $0 with no discount, one that only applies a credit to an
 * invoice, posts nothing.
 */
export function paymentEntry(
  payment: { cents: number | null; depositAccount: string | null; discount?: { account: string; cents: number } | null },
  receivable: string | null,
): PaymentRuleResult {
  if (payment.cents === null) return { lines: [], problems: [{ kind: 'unreadable' }] };
  const discount = payment.discount?.cents ? payment.discount : null;
  if (payment.cents === 0 && !discount) return { lines: [], problems: [] };

  const problems: PaymentProblem[] = [];
  if (payment.cents !== 0 && !payment.depositAccount) problems.push({ kind: 'no_deposit_account' });
  if (!receivable) problems.push({ kind: 'no_receivable' });
  if (problems.length) return { lines: [], problems };

  const lines: RuleLine[] = [];
  if (payment.cents !== 0) {
    lines.push({ account: payment.depositAccount!, cents: payment.cents, lineId: DEPOSIT_LINE, itemNumber: null, division: null });
  }
  if (discount) lines.push({ account: discount.account, cents: discount.cents, lineId: DISCOUNT_LINE, itemNumber: null, division: null });
  lines.push({
    account: receivable!, cents: -(payment.cents + (discount?.cents ?? 0)), lineId: RECEIVABLE_LINE, itemNumber: null, division: null,
  });
  return { lines, problems };
}
