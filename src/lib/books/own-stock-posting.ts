import type { SupabaseClient } from '@supabase/supabase-js';
import { entryDate, type ChartAccount } from './invoice-check';
import { lineMemo, type JournalRuleLine } from './journal-entry-rule';
import { pickReceivedAccount } from './bill-check';
import { STOCK_SOURCE_TYPE } from './stock-rule';
import type { StockDocument, WorkedStockDocument } from './stock-check';
import { checkOwnFulfillments, type CopiesThrough, type FulfilPairsData, type OwnFulfillmentCheck } from './own-fulfillment-check';
import { checkOwnReceipts, type OwnReceiptCheck, type ReceiptPairsData } from './own-receipt-check';
import { dayText } from './own-invoice-check';
import { ownCopyDays, type OwnBooksRead } from './own-invoice-posting';
import { OWN_COMPANY } from './own-invoices';

/**
 * FleetSuite's own fulfillments and receipts posted to its books (migration
 * 456; owner decision 2026-10-30, thread "Replacing NetSuite with
 * FleetSuite", "Own postings", then "Build it"; docs/books.md "Posting
 * FleetSuite's own fulfillments, receipts and bills").
 *
 * A fulfillment FleetSuite made, or a Receive on the Receiving page that
 * NetSuite took, posts from Books' own copy of it
 * (src/lib/books/own-fulfillments.ts, own-receipts.ts) instead of from
 * NetSuite's document, as an invoice FleetSuite made does
 * (src/lib/books/own-invoice-posting.ts), when:
 *   - the copy matches NetSuite's document, as Own fulfillments or Own
 *     receipts checks it (src/lib/books/own-fulfillment-check.ts,
 *     own-receipt-check.ts): its date, where it took stock from or the
 *     company it's for, each item and how many, and what that cost or added
 *     to stock;
 *   - and the entry the copy makes is the one NetSuite's makes (its lines in
 *     the copy of NetSuite's GL, as the stock rule posts them), account by
 *     account and on the same day, so nothing in the books moves when a
 *     document changes copies.
 * Otherwise NetSuite's document posts, with the stock rule, and the pages
 * say why.
 *
 * The copies' entries:
 *   - own_fulfillment@1: each item's cost, as the check worked it out (its
 *     average at the location just before), comes off the item's asset
 *     account in the copy of NetSuite's items and goes to its cost of goods
 *     account. NetSuite won't give an item's cost of goods account, so it's
 *     the one NetSuite's last fulfillment of the item before this one debited
 *     its cost to, or for an item NetSuite hasn't fulfilled before the one
 *     most of the company's fulfillments debit theirs to
 *     (gl_own_stock_accounts, migration 456);
 *   - own_receipt@1: each item NetSuite keeps in stock goes onto its asset
 *     account at the purchase order's price, as the check worked it out, and
 *     what they come to is credited to the account the company's item
 *     receipts hold received stock against until it's billed, the one most of
 *     them credit, as the bill rule picks it (pickReceivedAccount in
 *     src/lib/books/bill-check.ts).
 * Each is the document's entry as NetSuite's is, keyed
 * `item_fulfillment:<NetSuite id>:<n>` or `item_receipt:…`, in the month
 * NetSuite booked the document into, its lines naming FleetSuite's own
 * (`own:<item>:cost`, `own:<item>:asset`, `own:received`), each with the
 * customer's or vendor's name and the item in its memo.
 *
 * Pure but for the reads. Amounts are whole cents, debit positive.
 */

export const OWN_FULFILLMENT_RULE = 'own_fulfillment@1';
export const OWN_RECEIPT_RULE = 'own_receipt@1';

/** The rule a stock document's own copy posts with: a fulfillment's or an item receipt's; null for any other kind. */
export function ownStockRule(type: string): string | null {
  if (type === 'ItemShip') return OWN_FULFILLMENT_RULE;
  if (type === 'ItemRcpt') return OWN_RECEIPT_RULE;
  return null;
}

/** NetSuite's document a stock copy stands for, in words. */
const THEIRS: Readonly<Record<string, string>> = { ItemShip: 'fulfillment', ItemRcpt: 'receipt' };

// ── The accounts ───────────────────────────────────────────────────────────

/** Where an item's cost went on a fulfillment, as gl_own_stock_accounts (migration 456) learned it. */
export interface LearnedCost {
  /** The account NetSuite's last fulfillment of the item before this one debited its cost to; null when there's none. */
  cost: string | null;
  /** That fulfillment. */
  from: { netsuite_id: string; number: string | null; date: string } | null;
  /** The account this fulfillment debited the item's cost to in the copy of NetSuite's GL; null when it has none. */
  netsuite: string | null;
}

/** What gl_own_stock_accounts (migration 456) returns. */
export interface OwnStockAccountsData {
  /** Each item's asset account, by NetSuite's id for the item; null when the copy of NetSuite's items has none. */
  items: Record<string, string | null>;
  /** By NetSuite's id for the fulfillment, then the item's. */
  fulfillments: Record<string, Record<string, LearnedCost>>;
  /** The account most of the company's fulfillments debit their cost to; null when none does. */
  usual_cost: string | null;
  /** The accounts the company's item receipts credit, by how many receipts credit each. */
  received: Array<{ account: string; documents: number }>;
}

const NO_ACCOUNTS: OwnStockAccountsData = { items: {}, fulfillments: {}, usual_cost: null, received: [] };

/** How the chart of accounts names an account: in full ('58000 Cost of Goods Sold'), by its number ('58000'), and its type. */
export interface ChartNames {
  account: (id: string) => string;
  number: (id: string) => string;
  types: Map<string, string>;
}

export function chartNames(chart: ChartAccount[]): ChartNames {
  const types = new Map<string, string>();
  const names = new Map<string, string>();
  const numbers = new Map<string, string>();
  for (const a of chart) {
    if (!a.netsuite_account_id) continue;
    types.set(a.netsuite_account_id, a.account_type);
    names.set(a.netsuite_account_id, [a.number, a.name].filter(Boolean).join(' '));
    if (a.number) numbers.set(a.netsuite_account_id, a.number);
  }
  const account = (id: string) => names.get(id) ?? `NetSuite account ${id}`;
  return { account, number: (id) => numbers.get(id) ?? account(id), types };
}

// ── The copies' entries ────────────────────────────────────────────────────

/** A line of a copy's entry: as the stock rule's, with the item it's for. */
export interface OwnStockLine extends JournalRuleLine {
  itemNumber: string | null;
}

/** A copy's entry: its lines, and its date. */
export interface OwnStockEntry {
  lines: OwnStockLine[];
  date: string;
}

type OwnStockProblem =
  | { kind: 'no_asset'; item: string }
  | { kind: 'no_cost'; item: string }
  | { kind: 'no_received'; company: string };

/** Where one item's cost went on a copy of a fulfillment, and where NetSuite's fulfillment put it. */
interface CostPlace {
  item: string;
  cents: number;
  account: string;
  /** NetSuite's earlier fulfillment it was learned from; null when it's where most fulfillments put theirs. */
  from: LearnedCost['from'];
  netsuite: string | null;
}

interface BuiltEntry {
  lines: OwnStockLine[];
  problems: OwnStockProblem[];
  costs: CostPlace[];
}

/** A copy of a fulfillment's entry: each item's cost off its asset account, onto its cost of goods account. */
function fulfillmentEntry(check: OwnFulfillmentCheck, accounts: OwnStockAccountsData): BuiltEntry {
  const lines: OwnStockLine[] = [];
  const problems: OwnStockProblem[] = [];
  const costs: CostPlace[] = [];
  for (const p of check.items) {
    const f = p.fleetsuite;
    if (!f || f.kind !== 'stock' || f.cents === null || f.cents === 0) continue;
    const asset = accounts.items[p.itemId] ?? null;
    const learned = accounts.fulfillments[check.netsuiteId]?.[p.itemId];
    const cost = learned?.cost ?? accounts.usual_cost ?? null;
    if (!asset) problems.push({ kind: 'no_asset', item: p.item });
    if (!cost) problems.push({ kind: 'no_cost', item: p.item });
    if (!asset || !cost) continue;
    const memo = lineMemo(check.customer, p.item);
    lines.push(
      { lineId: `own:${p.itemId}:cost`, account: cost, cents: f.cents, memo, customerId: null, vendorRef: null, itemNumber: p.item },
      { lineId: `own:${p.itemId}:asset`, account: asset, cents: -f.cents, memo, customerId: null, vendorRef: null, itemNumber: p.item },
    );
    costs.push({ item: p.item, cents: f.cents, account: cost, from: learned?.cost ? learned.from : null, netsuite: learned?.netsuite ?? null });
  }
  return { lines, problems, costs };
}

/** A copy of a receipt's entry: each stock item onto its asset account, what they come to off the received account. */
function receiptEntry(check: OwnReceiptCheck, accounts: OwnStockAccountsData, names: ChartNames): BuiltEntry {
  const lines: OwnStockLine[] = [];
  const problems: OwnStockProblem[] = [];
  let total = 0;
  for (const p of check.items) {
    const f = p.fleetsuite;
    if (!f || f.stock !== true || f.cents === null || f.cents === 0) continue;
    const asset = p.itemId ? accounts.items[p.itemId] ?? null : null;
    if (!asset) {
      problems.push({ kind: 'no_asset', item: p.item });
      continue;
    }
    lines.push({
      lineId: `own:${p.itemId}:asset`, account: asset, cents: f.cents, memo: lineMemo(check.vendor, p.item),
      customerId: null, vendorRef: null, itemNumber: p.item,
    });
    total += f.cents;
  }
  if (total !== 0) {
    const received = pickReceivedAccount(accounts.received, check.company, names.types, names.account).account;
    if (!received) problems.push({ kind: 'no_received', company: check.company });
    else lines.push({ lineId: 'own:received', account: received, cents: -total, memo: lineMemo(check.vendor, null), customerId: null, vendorRef: null, itemNumber: null });
  }
  return { lines, problems, costs: [] };
}

/** Why a copy's entry can't be worked out, in a sentence. */
function problemText(p: OwnStockProblem): string {
  switch (p.kind) {
    case 'no_asset':
      return `${p.item} has no asset account in the copy of NetSuite's items.`;
    case 'no_cost':
      return `FleetSuite doesn't know which account ${p.item}'s cost goes to: no fulfillment in the copy of NetSuite's GL has debited a cost yet.`;
    case 'no_received':
      return `FleetSuite doesn't know which account holds received stock until it's billed: none of ${p.company}'s item receipts in the copy of NetSuite's GL credits one.`;
  }
}

// ── Comparing entries ──────────────────────────────────────────────────────

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = (cents: number) => money.format(cents / 100);
export const listed = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** What an entry puts in each account, nothing left out but $0. */
export function movements(lines: ReadonlyArray<{ account: string; cents: number }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.account, (out.get(l.account) ?? 0) + l.cents);
  for (const [account, cents] of out) if (cents === 0) out.delete(account);
  return out;
}

/** The accounts two entries put different amounts in, in NetSuite's order of ids. */
export function accountsApart(mine: ReadonlyArray<{ account: string; cents: number }>, theirs: ReadonlyArray<{ account: string; cents: number }>): string[] {
  const a = movements(mine);
  const b = movements(theirs);
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((k) => (a.get(k) ?? 0) !== (b.get(k) ?? 0))
    .sort((x, y) => Number(x) - Number(y) || x.localeCompare(y));
}

/**
 * How a copy's entry differs from NetSuite's, in a clause or two, and what a copy of a fulfillment takes from NetSuite's
 * posting of it next time; null when they don't differ. An item's cost put in another account than NetSuite's
 * fulfillment put it in is told item by item.
 */
function stockEntryDifference(
  mine: OwnStockEntry,
  theirs: { lines: JournalRuleLine[]; date: string },
  costs: CostPlace[],
  names: ChartNames,
): { text: string; learned: string[] } | null {
  const parts: string[] = [];
  const learned: string[] = [];
  if (mine.date !== theirs.date) parts.push(`it's dated ${dayText(mine.date)}, and NetSuite's ${dayText(theirs.date)}`);
  const apart = accountsApart(mine.lines, theirs.lines);
  const told = new Set<string>();
  for (const c of costs) {
    if (!c.netsuite || c.netsuite === c.account || !apart.includes(c.account) || !apart.includes(c.netsuite)) continue;
    told.add(c.account);
    told.add(c.netsuite);
    parts.push(c.from
      ? `FleetSuite put ${c.item}'s ${dollars(c.cents)} in ${names.account(c.account)}, where NetSuite's last fulfillment of it, `
        + `${c.from.number || `NetSuite ${c.from.netsuite_id}`} on ${dayText(c.from.date)}, put it, and NetSuite put it in ${names.account(c.netsuite)}`
      : `FleetSuite hadn't seen ${c.item} shipped before, so it put its ${dollars(c.cents)} in ${names.account(c.account)}, `
        + `where most fulfillments put theirs, and NetSuite put it in ${names.account(c.netsuite)}`);
    learned.push(`From now on FleetSuite puts ${c.item}'s cost in ${names.number(c.netsuite)}, as NetSuite did here.`);
  }
  const rest = apart.filter((a) => !told.has(a));
  if (rest.length) parts.push(`it posts differently to ${listed(rest.map(names.account))}`);
  return parts.length ? { text: parts.join('; '), learned } : null;
}

/** One account of "The entry" on Own fulfillments, Own receipts and Own bills: what each side puts in it, debit positive. */
export interface EntryRow {
  account: string;
  /** Null when this side puts nothing in it. */
  fleetsuite: number | null;
  netsuite: number | null;
  same: boolean;
}

/** Two entries account by account, the debits first, each in the order its account first comes. */
export function entryRows(
  mine: ReadonlyArray<{ account: string; cents: number }>,
  theirs: ReadonlyArray<{ account: string; cents: number }>,
  account: (id: string) => string,
): EntryRow[] {
  const a = movements(mine);
  const b = movements(theirs);
  const order = [...new Set([...mine, ...theirs].map((l) => l.account))].filter((k) => a.has(k) || b.has(k));
  const debit = (k: string) => ((a.get(k) ?? b.get(k) ?? 0) > 0 ? 0 : 1);
  return order
    .map((k, i) => ({ k, i }))
    .sort((x, y) => debit(x.k) - debit(y.k) || x.i - y.i)
    .map(({ k }) => ({ account: account(k), fleetsuite: a.get(k) ?? null, netsuite: b.get(k) ?? null, same: (a.get(k) ?? 0) === (b.get(k) ?? 0) }));
}

// ── Picking ────────────────────────────────────────────────────────────────

/** Books' own copies of some NetSuite fulfillments and item receipts, checked, by NetSuite's id, and the accounts they post to. */
export interface OwnStockCopies {
  fulfillments: Map<string, OwnFulfillmentCheck>;
  receipts: Map<string, OwnReceiptCheck>;
  accounts: OwnStockAccountsData;
}

/** What the books post for a fulfillment or item receipt Books has its own copy of. */
export interface OwnStockPick {
  /** The copy's entry, when the books post it. */
  entry: OwnStockEntry | null;
  /** Why NetSuite's document posts instead, in a sentence or two; null when the copy posts, or there's nothing to say. */
  why: string | null;
  /** The copy's entry as worked out, whether or not the books post it; null when it isn't worked out. */
  own: OwnStockEntry | null;
  /** How the copy's entry differs from NetSuite's, when that's why NetSuite's posts. */
  differs: string | null;
  /** What a copy of a fulfillment takes from NetSuite's posting of it next time, a sentence each. */
  learned: string[];
  /** Where an item's cost goes on a copy of a fulfillment, a sentence; null for a receipt, or when it isn't worked out. */
  costs: string | null;
  /** Books' own key for a copy of a receipt, which its page is opened by. */
  receiptKey?: string;
}

const NUMBER_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
/** Every one of n items, in words: 'it', 'both', 'all three', 'all 12'. */
const allOf = (n: number) => (n === 1 ? 'it' : n === 2 ? 'both' : `all ${NUMBER_WORDS[n] ?? n}`);

/** Where a copy of a fulfillment put each item's cost, in a sentence or two: "… 58000 Cost of Goods Sold for all three." */
function costsText(costs: CostPlace[], names: ChartNames): string | null {
  if (!costs.length) return null;
  const learned = costs.filter((c) => c.from);
  const usual = costs.filter((c) => !c.from);
  const parts: string[] = [];
  if (learned.length) {
    const by = new Map<string, string[]>();
    for (const c of learned) by.set(c.account, [...(by.get(c.account) ?? []), c.item]);
    const one = by.size === 1 && !usual.length;
    const each = [...by].map(([account, items]) => `${names.account(account)} for ${one ? allOf(items.length) : listed(items)}`);
    parts.push(`Each item's cost comes out of its asset account and goes to the cost account NetSuite's last fulfillment of it used: ${listed(each)}.`);
  }
  for (const c of usual) {
    parts.push(`FleetSuite hadn't seen ${c.item} shipped before, so its cost goes to ${names.account(c.account)}, where most fulfillments put theirs.`);
  }
  return parts.join(' ');
}

/**
 * What the books post for a stock document, given Books' own copies and the entry NetSuite's makes with the stock rule
 * (worked.checked.lines). Null when a copy has no say: there's none, the document isn't a fulfillment or item receipt,
 * or it's another company's, or posted to more than one.
 */
export function ownStockPick(worked: WorkedStockDocument, copies: OwnStockCopies, month: { company: string; names: ChartNames }): OwnStockPick | null {
  const doc = worked.entry;
  const fulfillment = doc.type === 'ItemShip' ? copies.fulfillments.get(doc.netsuite_id) : undefined;
  const receipt = doc.type === 'ItemRcpt' ? copies.receipts.get(doc.netsuite_id) : undefined;
  const check = fulfillment ?? receipt;
  if (!check) return null;
  const company = fulfillment ? OWN_COMPANY : receipt!.company;
  if (company !== month.company || doc.companies.length !== 1 || doc.companies[0] !== month.company) return null;
  const theirs = THEIRS[doc.type];
  const key = receipt ? { receiptKey: receipt.receiptKey } : {};
  const not = (why: string | null, more: Partial<OwnStockPick> = {}): OwnStockPick => ({
    entry: null, why, own: null, differs: null, learned: [], costs: null, ...key, ...more,
  });

  if (check.status === 'voided' || check.status === 'not_in_netsuite') return not(null);
  if (check.status === 'waiting') return not(`FleetSuite's own copy is waiting for NetSuite's ${theirs} to be copied, so the books post NetSuite's for now.`);
  if (check.status === 'differs') return not(`FleetSuite's own copy differs from NetSuite's ${theirs}, so the books post NetSuite's.`);
  if (check.status === 'incomplete') {
    return not(check.unknowns.length
      ? `FleetSuite's own copy matches where it can be checked but is incomplete, so the books post NetSuite's ${theirs}: FleetSuite didn't know ${listed(check.unknowns)}.`
      : `FleetSuite's own copy is incomplete, so the books post NetSuite's ${theirs}. ${check.summary}`);
  }
  // NetSuite's own lines don't balance: whatever stands stays, whichever copy made it.
  if (worked.checked.status === 'unworkable') return not(null);

  const built = fulfillment ? fulfillmentEntry(fulfillment, copies.accounts) : receiptEntry(receipt!, copies.accounts, month.names);
  const costs = costsText(built.costs, month.names);
  if (built.problems.length) {
    return not(`FleetSuite's own copy matches NetSuite's ${theirs}, but its entry can't be worked out, so the books post NetSuite's. ${problemText(built.problems[0])}`);
  }
  const own: OwnStockEntry = { lines: built.lines, date: entryDate({ date: check.date, posting_month: doc.posting_month }) };
  const differs = stockEntryDifference(own, { lines: worked.checked.lines, date: entryDate(doc) }, built.costs, month.names);
  if (differs) {
    return not(`FleetSuite's own copy matches NetSuite's ${theirs}, but its entry doesn't match NetSuite's, so the books post NetSuite's: ${differs.text}.`,
      { own, differs: differs.text, learned: differs.learned, costs });
  }
  // Nothing to post either way.
  if (!own.lines.length) return not(null, { own });
  return { entry: own, why: null, own, differs: null, learned: [], costs, ...key };
}

// ── Reading ────────────────────────────────────────────────────────────────

/** The first month Books has any own copy of a fulfillment and of a receipt in ('YYYY-MM-01'); null when it has none. */
export interface OwnStockSince {
  fulfillments: string | null;
  receipts: string | null;
}

/**
 * Books' own copies of one company's stock documents of a month (`documents`, gl_stock_month's), made on the days
 * they're dated and none before `since`, each checked against NetSuite's (`through`: how far the copies of NetSuite's
 * stock moves and general ledger had come), and the accounts the matching ones post to. A fulfillment is BMG's alone.
 */
export async function readOwnStockCopies(
  service: SupabaseClient,
  company: string,
  documents: ReadonlyArray<Pick<StockDocument, 'netsuite_id' | 'type' | 'date'>>,
  since: OwnStockSince,
  through: CopiesThrough,
): Promise<OwnStockCopies> {
  const shipped = documents.filter((d) => d.type === 'ItemShip');
  const received = documents.filter((d) => d.type === 'ItemRcpt');
  const ids = new Set(documents.map((d) => d.netsuite_id));
  const shipDays = company === OWN_COMPANY && since.fulfillments ? ownCopyDays(shipped, since.fulfillments) : null;
  const receiveDays = since.receipts ? ownCopyDays(received, since.receipts) : null;

  const [ships, receives] = await Promise.all([
    shipDays ? service.rpc('gl_own_fulfillment_pairs', { p_from: shipDays.from, p_to: shipDays.to, p_netsuite_id: null }) : null,
    receiveDays ? service.rpc('gl_own_receipt_pairs', { p_from: receiveDays.from, p_to: receiveDays.to, p_key: null }) : null,
  ]);
  if (ships?.error) throw new Error(ships.error.message);
  if (receives?.error) throw new Error(receives.error.message);
  const fulfillments = new Map(ships
    ? checkOwnFulfillments((ships.data ?? {}) as FulfilPairsData, through).fulfillments
      .filter((f) => ids.has(f.netsuiteId))
      .map((f) => [f.netsuiteId, f] as const)
    : []);
  const receipts = new Map(receives
    ? checkOwnReceipts((receives.data ?? {}) as ReceiptPairsData, through).receipts
      .filter((r): r is OwnReceiptCheck & { netsuiteId: string } => !!r.netsuiteId && ids.has(r.netsuiteId) && r.company === company)
      .map((r) => [r.netsuiteId, r] as const)
    : []);
  return { fulfillments, receipts, accounts: await readOwnStockAccounts(service, company, fulfillments, receipts) };
}

/** The accounts the matching copies post to (gl_own_stock_accounts, migration 456): nothing to read when none matches. */
export async function readOwnStockAccounts(
  service: SupabaseClient,
  company: string,
  fulfillments: ReadonlyMap<string, OwnFulfillmentCheck>,
  receipts: ReadonlyMap<string, OwnReceiptCheck>,
): Promise<OwnStockAccountsData> {
  const matching = (m: ReadonlyMap<string, { status: string }>) => [...m].filter(([, c]) => c.status === 'matches').map(([id]) => id);
  const shipped = matching(fulfillments);
  const received = matching(receipts);
  if (!shipped.length && !received.length) return NO_ACCOUNTS;
  const res = await service.rpc('gl_own_stock_accounts', { p_company: company, p_fulfillments: shipped, p_receipts: received });
  if (res.error) throw new Error(res.error.message);
  const data = (res.data ?? {}) as Partial<OwnStockAccountsData>;
  return {
    items: data.items ?? {},
    fulfillments: data.fulfillments ?? {},
    usual_cost: data.usual_cost ?? null,
    received: (data.received ?? []).map((r) => ({ account: String(r.account), documents: Number(r.documents) || 0 })),
  };
}

/** The first month each kind of own copy was made in, from gl_own_fulfillment_months and gl_own_receipt_months. */
export async function readOwnStockSince(service: SupabaseClient): Promise<OwnStockSince> {
  const [ships, receives] = await Promise.all([service.rpc('gl_own_fulfillment_months'), service.rpc('gl_own_receipt_months')]);
  if (ships.error) throw new Error(ships.error.message);
  if (receives.error) throw new Error(receives.error.message);
  const first = (rows: unknown) => ((rows ?? []) as Array<{ month: string }>).map((m) => m.month).sort()[0] ?? null;
  return { fulfillments: first(ships.data), receipts: first(receives.data) };
}

// ── The Own pages ──────────────────────────────────────────────────────────

/** How the journal says what it holds for a fulfillment and an item receipt (gl_stock_postings, migration 456). */
export const FULFILLMENT_BOOKS: OwnBooksRead = { fn: 'gl_stock_postings', list: 'documents', sourceType: STOCK_SOURCE_TYPE.ItemShip, ownRule: OWN_FULFILLMENT_RULE };
export const RECEIPT_BOOKS: OwnBooksRead = { fn: 'gl_stock_postings', list: 'documents', sourceType: STOCK_SOURCE_TYPE.ItemRcpt, ownRule: OWN_RECEIPT_RULE };
