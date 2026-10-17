/**
 * How NetSuite's stock and its cost post: stock@1 (docs/books.md "Stock and
 * cost").
 *
 * NetSuite moves stock and books its cost on documents of their own: an item
 * fulfillment (NetSuite's ItemShip) takes stock out to cost of goods, an
 * item receipt (ItemRcpt) brings it in, an inventory adjustment (InvAdjst)
 * or transfer (InvTrnfr) changes or moves it, and an assembly build (Build)
 * or unbuild (Unbuild) turns parts into an assembly or back. An invoice that
 * wasn't fulfilled first takes the stock out itself, on cost lines of its
 * own, and a credit memo can bring stock back the same way; the invoice and
 * credit memo rules leave those lines out (costLines in invoice-check.ts),
 * and this rule posts them.
 *
 * All of them post the way a journal entry does (owner decision 2026-10-17,
 * thread "Replacing NetSuite with FleetSuite": "Stock and cost", posted from
 * the "Ledger copy"): their lines for a company in the copy of NetSuite's GL
 * (migration 361), to the same accounts and for the same amounts, are that
 * company's entry, worked out with the journal entry rule
 * (journal-entry-rule.ts) line for line, so FleetSuite takes NetSuite's
 * costs as they are. An invoice's or credit memo's lines here are only its
 * cost lines, as gl_netsuite_cost_lines (migration 377) recognizes them by
 * their accounts; the rest of it is the invoice rule's. Each line keeps its
 * memo with its name in front, a line of $0 posts nothing, and one whose
 * lines for the company don't balance on their own can't be worked out.
 */

export const STOCK_RULE = 'stock@1';

/**
 * NetSuite's transaction types posted with the stock rule, as the copy of its
 * GL keeps them: the ones that move stock, and invoices and credit memos for
 * their cost lines.
 */
export type StockType = 'ItemShip' | 'ItemRcpt' | 'InvAdjst' | 'InvTrnfr' | 'Build' | 'Unbuild' | 'CustInvc' | 'CustCred';

/**
 * What each one's entries are filed as (gl_entries.source_type, migration
 * 395), keyed <source type>:<NetSuite id>:<n>. An invoice's and a credit
 * memo's cost lines are filed alike, apart from the entry for the sale.
 */
export const STOCK_SOURCE_TYPE = {
  ItemShip: 'item_fulfillment',
  ItemRcpt: 'item_receipt',
  InvAdjst: 'inventory_adjustment',
  InvTrnfr: 'inventory_transfer',
  Build: 'assembly_build',
  Unbuild: 'assembly_unbuild',
  CustInvc: 'invoice_cost',
  CustCred: 'invoice_cost',
} as const satisfies Record<StockType, string>;
export type StockSourceType = (typeof STOCK_SOURCE_TYPE)[StockType];
