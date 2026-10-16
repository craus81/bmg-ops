import type { RuleLine } from './invoice-rule';
import { PAYABLES_LINE } from './bill-rule';

/**
 * How a bill payment posts: bill_payment@1 (docs/books.md "Bill payments").
 *
 * A bill payment (NetSuite's VendPymt) pays what BMG owes a vendor: payables
 * are debited with what it pays off, and the money comes out of the account
 * it was paid from, a bank account or a credit card say. Where the money came
 * from is the payment's own choice, as where a customer payment's money went
 * is that payment's. The copy of the payment doesn't keep it, so it comes
 * from NetSuite's posting of the payment (src/lib/books/bill-payment-check.ts),
 * and during 2027 FleetSuite copies NetSuite's choice exactly. Payables are
 * the vendor's, picked as the bill rule picks them (src/lib/books/bill-rule.ts),
 * so a payment takes what it pays out of the account its vendor's bills put
 * it in.
 *
 * A discount BMG took for paying early goes to its own account, and payables
 * are debited with it too: the bills are paid by the money plus the discount.
 * The copy of the payment doesn't keep the discount either, so it comes from
 * NetSuite's posting the same way.
 *
 * Pure: it works out a payment's entry, or says why it can't, and posts
 * nothing. Amounts are whole cents, debit positive.
 */

export const BILL_PAYMENT_RULE = 'bill_payment@1';

/** The entry's lines, by what they post: payables (PAYABLES_LINE), where the money came from, and the discount. */
export const PAID_FROM_LINE = 'paid_from';
export const DISCOUNT_LINE = 'discount';

export type BillPaymentProblem =
  | { kind: 'unreadable' }
  | { kind: 'no_paid_from' }
  | { kind: 'no_payables' };

export interface BillPaymentRuleResult {
  /** Empty whenever there's a problem: a payment posts whole or not at all. */
  lines: RuleLine[];
  problems: BillPaymentProblem[];
}

/**
 * One bill payment's entry. `cents` is the money paid, null when the copy's
 * total can't be read, and `discount` what BMG took off, with the account it
 * goes to. A payment of $0 with no discount, one that only applies a bill
 * credit to a bill, posts nothing.
 */
export function billPaymentEntry(
  payment: { cents: number | null; paidFrom: string | null; discount?: { account: string; cents: number } | null },
  payables: string | null,
): BillPaymentRuleResult {
  if (payment.cents === null) return { lines: [], problems: [{ kind: 'unreadable' }] };
  const discount = payment.discount?.cents ? payment.discount : null;
  if (payment.cents === 0 && !discount) return { lines: [], problems: [] };

  const problems: BillPaymentProblem[] = [];
  if (payment.cents !== 0 && !payment.paidFrom) problems.push({ kind: 'no_paid_from' });
  if (!payables) problems.push({ kind: 'no_payables' });
  if (problems.length) return { lines: [], problems };

  const lines: RuleLine[] = [
    { account: payables!, cents: payment.cents + (discount?.cents ?? 0), lineId: PAYABLES_LINE, itemNumber: null, division: null },
  ];
  if (payment.cents !== 0) {
    lines.push({ account: payment.paidFrom!, cents: -payment.cents, lineId: PAID_FROM_LINE, itemNumber: null, division: null });
  }
  if (discount) lines.push({ account: discount.account, cents: -discount.cents, lineId: DISCOUNT_LINE, itemNumber: null, division: null });
  return { lines, problems };
}
