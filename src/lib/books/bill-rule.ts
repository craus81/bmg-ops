import { isLayoutItem, type RuleLine } from './invoice-rule';

/**
 * How a vendor bill, and a bill credit, posts: bill@1 (docs/books.md "Vendor
 * bills").
 *
 * A bill is what BMG owes a vendor. Payables are credited with its total and
 * each line is debited to where NetSuite puts it:
 *
 * - an expense line, an installer's labor say, to its own account;
 * - a stock item (inventory or an assembly) to the account NetSuite holds
 *   received stock against until it's billed, when the line came from a
 *   purchase order's line (or the bill from a purchase order, when NetSuite
 *   doesn't say line by line) and the company's item receipts post to such
 *   an account; otherwise to the item's asset account, as the bill itself
 *   brings the stock in: a line added on a purchase order's bill, say;
 * - any other item (non-stock, service, other charge) to its expense
 *   account, or a discount or markup to its own account; an item the copy
 *   has no account for goes where NetSuite posts its bill lines.
 *
 * Each line goes in at its own amount: a discount line is a credit of its
 * own (src/lib/books/bill-check.ts withOwnBillAmounts).
 *
 * A bill credit takes some of what BMG owes back, so it posts the same way
 * the other way round: its signed amounts carry the direction.
 *
 * During 2027 FleetSuite copies NetSuite's account choices exactly, so the
 * accounts come from the copied NetSuite lists (migration 363) and from
 * NetSuite's own postings (src/lib/books/bill-check.ts): the payables
 * account, and where received stock is held.
 *
 * Pure: it works out a document's entry, or says why it can't, and posts
 * nothing; the posting job (src/lib/books/invoice-posting.ts) posts it, the
 * vendor on the payables line. Amounts are whole cents, debit positive.
 */

export const BILL_RULE = 'bill@1';

export type BillType = 'VendBill' | 'VendCred';

/**
 * What the journal files each one's entries under (gl_entries.source_type,
 * migration 386), and keys them by: vendor_bill:<NetSuite id>:<n>.
 */
export const BILL_SOURCE_TYPE = { VendBill: 'vendor_bill', VendCred: 'vendor_credit' } as const satisfies Record<BillType, string>;
export type BillSourceType = (typeof BILL_SOURCE_TYPE)[BillType];

/** The entry's payables line; the other lines are the document's, by NetSuite's line id. */
export const PAYABLES_LINE = 'payables';

/** Items NetSuite keeps in stock. */
export const STOCK_TYPES: ReadonlySet<string> = new Set(['InvtPart', 'Assembly']);

/** Items that carry one account of their own, which the items copy reads as the income account. */
const OWN_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['Discount', 'Markup']);

export interface BillLine {
  /** NetSuite's transaction line id. */
  lineId: string;
  /** NetSuite id of the line's item; null on an expense line. */
  itemId: string | null;
  /** An expense line's own account; null when NetSuite didn't give it. */
  account: string | null;
  /** Debit positive: a bill's line is positive, a bill credit's negative. Null when it couldn't be read. */
  cents: number | null;
  tax: boolean;
  /**
   * Whether the line came from a purchase order's line (a vendor return's,
   * on a bill credit); null or left out when NetSuite doesn't say line by
   * line, and the document's `ordered` goes.
   */
  ordered?: boolean | null;
}

export interface BillItem {
  /** NetSuite's item name (its item number). */
  number: string;
  /** NetSuite's item type ('InvtPart', 'NonInvtPart', 'Service', 'OthCharge', …). */
  type: string | null;
  assetAccount: string | null;
  expenseAccount: string | null;
  incomeAccount: string | null;
}

export interface BillAccounts {
  /** The copied NetSuite items, by NetSuite id. */
  items: Map<string, BillItem>;
  /** The payables account the document credits; null when there isn't one. */
  payables: string | null;
  /** Where NetSuite holds received stock until it's billed; null when the company's item receipts post nowhere. */
  received: string | null;
  /** Where NetSuite posts each item's bill lines (gl_bill_item_accounts, migration 385), for an item the copy has no account for. */
  posted?: Map<string, string>;
}

/** The account the copy of NetSuite's items gives a non-stock item's bill line: its expense account, or a discount's or markup's own. */
export function billItemAccount(item: BillItem): string | null {
  return item.expenseAccount ?? (item.type && OWN_ACCOUNT_TYPES.has(item.type) ? item.incomeAccount : null);
}

/** What a line of the entry is to the document. */
export type BillLineRole = 'payables' | 'expense' | 'item' | 'stock' | 'received';

export interface BillRuleLine extends RuleLine {
  role: BillLineRole;
}

export type BillProblem =
  | { kind: 'unreadable'; lineId: string }
  | { kind: 'no_account'; lineId: string }
  | { kind: 'not_copied'; lineId: string; itemId: string }
  | { kind: 'no_item_account'; lineId: string; itemId: string; itemNumber: string; stock: boolean }
  | { kind: 'tax'; lineId: string }
  | { kind: 'no_links' }
  | { kind: 'no_payables' };

export interface BillRuleResult {
  /** Empty whenever there's a problem: a document posts whole or not at all. */
  lines: BillRuleLine[];
  problems: BillProblem[];
}

/**
 * One bill's or bill credit's entry. `ordered` says whether it came from a
 * purchase order (or a receipt, or for a bill credit a vendor return); null
 * when what it's linked to hasn't been copied. A line's own `ordered`, when
 * NetSuite said, goes before it. A line of $0 posts nothing, and a document
 * of $0 posts nothing at all.
 */
export function billEntry(doc: { lines: BillLine[]; ordered: boolean | null }, accounts: BillAccounts): BillRuleResult {
  const out: BillRuleLine[] = [];
  const problems: BillProblem[] = [];
  let total = 0;
  let needsLinks = false;
  const post = (account: string, cents: number, lineId: string, role: BillLineRole, itemNumber: string | null) => {
    out.push({ account, cents, lineId, itemNumber, division: null, role });
    total += cents;
  };

  for (const line of doc.lines) {
    if (line.cents === null) {
      problems.push({ kind: 'unreadable', lineId: line.lineId });
      continue;
    }
    if (line.cents === 0) continue;
    if (line.tax) {
      problems.push({ kind: 'tax', lineId: line.lineId });
      continue;
    }

    if (!line.itemId) {
      if (!line.account) problems.push({ kind: 'no_account', lineId: line.lineId });
      else post(line.account, line.cents, line.lineId, 'expense', null);
      continue;
    }
    const item = accounts.items.get(line.itemId);
    if (isLayoutItem(line.itemId, item?.type)) continue;
    if (!item) {
      problems.push({ kind: 'not_copied', lineId: line.lineId, itemId: line.itemId });
      continue;
    }

    if (item.type && STOCK_TYPES.has(item.type)) {
      const ordered = line.ordered ?? doc.ordered;
      if (accounts.received && ordered === null) {
        needsLinks = true;
      } else if (accounts.received && ordered) {
        post(accounts.received, line.cents, line.lineId, 'received', item.number);
      } else if (item.assetAccount) {
        post(item.assetAccount, line.cents, line.lineId, 'stock', item.number);
      } else {
        problems.push({ kind: 'no_item_account', lineId: line.lineId, itemId: line.itemId, itemNumber: item.number, stock: true });
      }
      continue;
    }
    const account = billItemAccount(item) ?? accounts.posted?.get(line.itemId) ?? null;
    if (account) post(account, line.cents, line.lineId, 'item', item.number);
    else problems.push({ kind: 'no_item_account', lineId: line.lineId, itemId: line.itemId, itemNumber: item.number, stock: false });
  }

  if (needsLinks) problems.push({ kind: 'no_links' });
  if (total !== 0) {
    if (accounts.payables) {
      out.unshift({ account: accounts.payables, cents: -total, lineId: PAYABLES_LINE, itemNumber: null, division: null, role: 'payables' });
    } else {
      problems.push({ kind: 'no_payables' });
    }
  }
  return problems.length ? { lines: [], problems } : { lines: out, problems };
}
