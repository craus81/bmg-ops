import { LAYOUT_TYPES, revenueBucket } from '@/lib/division-revenue';

/**
 * How an invoice posts: invoice@1, the first posting rule (docs/books.md
 * "Invoices").
 *
 * Accounts receivable takes the invoice's total, each line goes to its item's
 * income account, and sales tax goes to the account its tax code posts to.
 * During 2027 FleetSuite copies NetSuite's account choices exactly, so the
 * accounts come from the copied NetSuite lists (migration 363): each item's
 * income account, and where each tax code's sales tax has posted since 2025.
 * An item with no income account, a payment item say, goes to the account
 * NetSuite has posted its invoice lines to since 2025.
 *
 * Pure: it works out an invoice's entry, or says why it can't, and posts
 * nothing. Amounts are whole cents, debit positive.
 */

export const INVOICE_RULE = 'invoice@1';

/** NetSuite's id for an invoice's own line, where its receivable posts. */
export const MAIN_LINE = '0';

export interface InvoiceLine {
  /** NetSuite's transaction line id. */
  lineId: string;
  /** NetSuite id of the line's item, or on a tax line its tax code. */
  itemId: string | null;
  itemNumber: string | null;
  tax: boolean;
  /** What the line charges the customer, in cents; a discount is negative. Null when it couldn't be read. */
  cents: number | null;
}

export interface RuleItem {
  /** NetSuite's item name (its item number). */
  number: string;
  /** NetSuite's item type ('InvtPart', 'Service', 'Discount', 'Subtotal', …). */
  type: string | null;
  incomeAccount: string | null;
  assetAccount: string | null;
  /**
   * For an item with no income account, a payment item say: the account
   * NetSuite posted its invoice lines to most since 2025, as the lists copy
   * counted them. Such an item posts to an account of its own, which the
   * items copy doesn't read.
   */
  postedAccount?: string | null;
}

export interface RuleAccounts {
  /** The copied NetSuite items, by NetSuite id. */
  items: Map<string, RuleItem>;
  /** The account each tax code's sales tax posts to, by tax code id ('' = a tax line with none). */
  taxAccounts: Map<string, string>;
  /** The receivable account the company's invoices debit; null when there isn't one. */
  receivable: string | null;
}

export interface RuleLine {
  /** NetSuite account id (gl_accounts.netsuite_account_id). */
  account: string;
  /** Debit positive, credit negative. */
  cents: number;
  /** The invoice line it posts; MAIN_LINE for the receivable. */
  lineId: string;
  itemNumber: string | null;
  /** Upfit or Graphics by the owner's rule of 2026-10-06; null for tax, discounts, freight, items with no income account and the receivable. */
  division: 'upfit' | 'graphics' | null;
}

export type RuleProblem =
  | { kind: 'unreadable'; lineId: string }
  | { kind: 'no_item'; lineId: string }
  | { kind: 'not_copied'; lineId: string; itemId: string; itemNumber: string | null }
  | { kind: 'no_income_account'; lineId: string; itemId: string; itemNumber: string }
  | { kind: 'no_tax_account'; lineId: string; taxCode: string }
  | { kind: 'no_receivable' };

export interface RuleResult {
  /** Empty whenever there's a problem: an invoice posts whole or not at all. */
  lines: RuleLine[];
  problems: RuleProblem[];
}

/**
 * A line that never posts: a subtotal, description or item group line, which
 * repeats amounts, or one of NetSuite's own lines, its subtotal say. Those
 * carry an item id below 1 (the subtotal is item -2): none is a real item,
 * so no item list has them.
 */
export function isLayoutLine(line: InvoiceLine, items: Map<string, RuleItem>): boolean {
  if (line.tax || !line.itemId) return false;
  if (/^(-\d+|0+)$/.test(line.itemId)) return true;
  const type = items.get(line.itemId)?.type;
  return !!type && LAYOUT_TYPES.has(type);
}

export function invoiceEntry(lines: InvoiceLine[], accounts: RuleAccounts): RuleResult {
  const out: RuleLine[] = [];
  const problems: RuleProblem[] = [];
  let total = 0;

  for (const line of lines) {
    if (line.cents === null) {
      problems.push({ kind: 'unreadable', lineId: line.lineId });
      continue;
    }
    if (line.cents === 0) continue;

    if (line.tax) {
      const taxCode = line.itemId ?? '';
      const account = accounts.taxAccounts.get(taxCode);
      if (!account) {
        problems.push({ kind: 'no_tax_account', lineId: line.lineId, taxCode });
        continue;
      }
      out.push({ account, cents: -line.cents, lineId: line.lineId, itemNumber: null, division: null });
      total += line.cents;
      continue;
    }

    if (!line.itemId) {
      problems.push({ kind: 'no_item', lineId: line.lineId });
      continue;
    }
    if (isLayoutLine(line, accounts.items)) continue;
    const item = accounts.items.get(line.itemId);
    if (!item) {
      problems.push({ kind: 'not_copied', lineId: line.lineId, itemId: line.itemId, itemNumber: line.itemNumber });
      continue;
    }
    const itemNumber = line.itemNumber || item.number;
    const account = item.incomeAccount ?? item.postedAccount ?? null;
    if (!account) {
      problems.push({ kind: 'no_income_account', lineId: line.lineId, itemId: line.itemId, itemNumber });
      continue;
    }
    // An item with no income account, a payment say, isn't a sale of either division.
    const bucket = item.incomeAccount ? revenueBucket(itemNumber, item.type) : null;
    out.push({
      account,
      cents: -line.cents,
      lineId: line.lineId,
      itemNumber,
      division: bucket === 'upfit' || bucket === 'graphics' ? bucket : null,
    });
    total += line.cents;
  }

  if (total !== 0) {
    if (accounts.receivable) {
      out.unshift({ account: accounts.receivable, cents: total, lineId: MAIN_LINE, itemNumber: null, division: null });
    } else {
      problems.push({ kind: 'no_receivable' });
    }
  }
  return problems.length ? { lines: [], problems } : { lines: out, problems };
}
