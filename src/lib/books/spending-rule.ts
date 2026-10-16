import { billEntry, type BillItem, type BillLine, type BillLineRole, type BillProblem, type BillRuleLine } from './bill-rule';
import { PAID_FROM_LINE } from './bill-payment-rule';

/**
 * How a check, a credit card charge and a credit card refund post:
 * spending@1 (docs/books.md "Checks and card charges").
 *
 * A check (NetSuite's Check) pays for something straight from a bank
 * account, and a credit card charge (CardChrg) puts it on a credit card.
 * Each has lines like a bill's, so it posts as a bill does
 * (src/lib/books/bill-rule.ts) with the account the money comes out of in
 * place of payables: that account is credited with the total, and each line
 * is debited where the bill rule puts a bill's line: an expense line to its
 * own account, a non-stock item to its expense account, and a stock item to
 * its asset account, since nothing on a check or a card is ordered and
 * received first. A credit card refund (CardRfnd) puts money back on the
 * card, so it posts the same way the other way round, as a bill credit does:
 * its signed amounts carry the direction.
 *
 * Which account the money comes out of is the document's own choice, as
 * where a bill payment's money came from is that payment's. The copy of the
 * document doesn't keep it, so it comes from NetSuite's posting of the
 * document (src/lib/books/spending-check.ts), and during 2027 FleetSuite
 * copies NetSuite's choice exactly.
 *
 * Pure: it works out a document's entry, or says why it can't, and posts
 * nothing. Amounts are whole cents, debit positive.
 */

export const SPENDING_RULE = 'spending@1';

export type SpendingType = 'Check' | 'CardChrg' | 'CardRfnd';

/**
 * What the journal files each one's entries under (gl_entries.source_type,
 * migration 392), and keys them by: check:<NetSuite id>:<n>.
 */
export const SPENDING_SOURCE_TYPE = { Check: 'check', CardChrg: 'card_charge', CardRfnd: 'card_refund' } as const satisfies Record<SpendingType, string>;
export type SpendingSourceType = (typeof SPENDING_SOURCE_TYPE)[SpendingType];

/** The documents that put money back, whose lines are credits and whose account is debited. */
export const REFUND_TYPES: ReadonlySet<SpendingType> = new Set(['CardRfnd']);

/** What a line of the entry is to the document: the account the money comes out of (PAID_FROM_LINE), or what one of its lines posts. */
export type SpendingLineRole = 'paid_from' | 'expense' | 'item' | 'stock';

export interface SpendingRuleLine extends Omit<BillRuleLine, 'role'> {
  role: SpendingLineRole;
}

export type SpendingProblem = Exclude<BillProblem, { kind: 'no_links' } | { kind: 'no_payables' }> | { kind: 'no_paid_from' };

export interface SpendingAccounts {
  /** The copied NetSuite items, by NetSuite id. */
  items: Map<string, BillItem>;
  /** The account the money comes out of, or a refund goes back to; null when NetSuite's posting doesn't say. */
  paidFrom: string | null;
  /** Where NetSuite posts each item's lines (gl_spending_item_accounts, migration 391), for an item the copy has no account for. */
  posted?: Map<string, string>;
}

export interface SpendingRuleResult {
  /** Empty whenever there's a problem: a document posts whole or not at all. */
  lines: SpendingRuleLine[];
  problems: SpendingProblem[];
}

/**
 * The bill rule's roles on a check or card: its payables are the account the
 * money comes out of. Received stock never comes, as nothing is received
 * first; the entry below asks the bill rule for none.
 */
const ROLES: Record<BillLineRole, SpendingLineRole> = {
  payables: 'paid_from', expense: 'expense', item: 'item', stock: 'stock', received: 'stock',
};

/**
 * One check's, card charge's or card refund's entry, its lines signed debit
 * positive: a check's and a charge's lines are debits, a refund's credits.
 * The account the money comes out of comes first. A line of $0 posts
 * nothing, and a document of $0 posts nothing at all.
 */
export function spendingEntry(doc: { lines: BillLine[] }, accounts: SpendingAccounts): SpendingRuleResult {
  const entry = billEntry(
    { lines: doc.lines, ordered: false },
    { items: accounts.items, payables: accounts.paidFrom, received: null, posted: accounts.posted },
  );
  return {
    lines: entry.lines.map((l) => ({
      ...l,
      lineId: l.role === 'payables' ? PAID_FROM_LINE : l.lineId,
      role: ROLES[l.role],
    })),
    problems: entry.problems.flatMap((p): SpendingProblem[] => (
      p.kind === 'no_payables' ? [{ kind: 'no_paid_from' }] : p.kind === 'no_links' ? [] : [p]
    )),
  };
}
