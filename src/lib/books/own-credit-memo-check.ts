import type { TaxRateFrom } from '@/lib/credit-memo';
import { SHIP_ITEM_TYPE } from './invoice-charges';
import { centsOf } from './invoice-check';
import { isLayoutItem } from './invoice-rule';
import {
  costLinesText, dayText, differsSummary, explainTax, ownLists, pairLines, takeApartSpread,
  type LineWords, type NetSide, type NetsuiteInvoiceData, type NetsuiteLineData, type OwnCheckStatus, type OwnFieldCheck,
  type OwnLinePair, type OwnLists, type OwnSide,
} from './own-invoice-check';
import { TAKES_OFF } from './own-invoices';
import { pct } from './sales-tax-rates';

/**
 * Books' own credit memos next to NetSuite's (migration 518, docs/books.md
 * "Posting FleetSuite's own credit memos"; NetSuite Exit Checklist, "Gaps in
 * what's built", thread "Replacing NetSuite with FleetSuite", 2026-11-03).
 *
 * Each copy Books kept of a credit memo FleetSuite made against an invoice
 * (src/lib/books/own-credit-memos.ts, migration 466) is put next to
 * NetSuite's credit memo as the ledger mirror copied it: who it's for, its
 * date, the location it books to, each line it credits, what it comes to
 * before tax, the sales tax it gives back and its total. Where they differ
 * the check says how, and for sales tax why where it can tell: NetSuite's
 * rate against the invoice's, or the lines one taxed and the other didn't.
 * NetSuite's lines that book the cost of the stock coming back aren't
 * compared: that cost posts under Stock and cost.
 *
 * A copy:
 *   - waits until NetSuite's credit memo, its lines and its posting are
 *     copied (the ledger mirror and the copy of NetSuite's general ledger,
 *     each every two hours);
 *   - is voided when NetSuite voided or deleted its credit memo;
 *   - differs when anything compared differs;
 *   - matches otherwise. FleetSuite works every part of a credit memo out
 *     itself, so a copy is never incomplete.
 *
 * Pure. Amounts are whole cents, what the customer is credited, a discount
 * credited back negative.
 */

// ── What gl_own_credit_memo_pairs returns ──────────────────────────────────

export interface OwnCreditLineData {
  line_no: number;
  /** The invoice line it credits; null for an amount of its own. */
  invoice_line: number | null;
  /** The invoice line's own item, or the credit item. */
  item_id: string | null;
  item_number: string | null;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  /** What the line credits, a discount the invoice gave, credited back, negative. */
  amount: string;
  taxable: boolean;
  tax: string;
  back_to_stock: boolean;
  on_credit_item: boolean;
}

export interface OwnCreditMemoData {
  netsuite_id: string;
  number: string | null;
  invoice_id: string;
  invoice_number: string | null;
  made_from_id: string | null;
  customer_netsuite_id: string | null;
  customer_id: string | null;
  date: string;
  /** The invoice's: NetSuite makes the credit memo from it. */
  location_id: string | null;
  reason: string;
  tax_rule: string;
  /** A fraction, as text. */
  tax_rate: string;
  tax_rate_from: TaxRateFrom;
  subtotal: string;
  tax: string;
  total: string;
  made_at: string;
  lines: OwnCreditLineData[];
}

/** NetSuite's credit memo as the ledger mirror copied it; its lines' netamount is NetSuite's own, a credited sale positive. */
export type NetsuiteCreditMemoData = Omit<NetsuiteInvoiceData, 'due_date' | 'po_number'>;

export interface OwnCreditPairData {
  own: OwnCreditMemoData;
  netsuite: NetsuiteCreditMemoData | null;
  /** From the credit memo's receivable line in the copy of NetSuite's general ledger; null before that copy has it. */
  netsuite_gl: { location_id: string | null } | null;
  customer_name: string | null;
}

export interface OwnCreditPairsData {
  credit_memos: OwnCreditPairData[];
  items: Record<string, { number: string; type: string | null }>;
  tax_codes: Record<string, { name: string; rate: string | null }>;
  locations: Record<string, string>;
}

// ── What the check says ────────────────────────────────────────────────────

export type OwnCreditStatus = Exclude<OwnCheckStatus, 'incomplete'>;

/** In the order the pages list them. */
export const CREDIT_CHECK_STATUSES: readonly OwnCreditStatus[] = ['differs', 'waiting', 'matches', 'voided'];

export interface OwnCreditMemoCheck {
  netsuiteId: string;
  number: string;
  date: string;
  invoiceId: string;
  invoiceNumber: string;
  reason: string;
  customer: string | null;
  status: OwnCreditStatus;
  /** One sentence for the list. */
  summary: string;
  /** How many of the things compared differ. */
  differing: number;
  fleetsuiteTotal: number;
  /** Null before the copy of NetSuite's credit memo has it. */
  netsuiteTotal: number | null;
  fields: OwnFieldCheck[];
  lines: OwnLinePair[];
  /** How many of the copy's lines put a part back on the shelf. */
  backToStock: number;
  /** How FleetSuite worked its copy out, a sentence each. */
  workedOut: string[];
}

export const CREDIT_LINE_WORDS: LineWords = { did: 'credited', do: 'credit', doc: 'credit memo' };

/** Where the copy's rate is from, after it in a sentence; nothing taxed is at no rate. */
const RATE_FROM: Readonly<Record<TaxRateFrom, string | undefined>> = {
  invoice: "the invoice's own rate",
  tax_code: "the rate of the invoice's tax code",
  worked_out: "worked out from the invoice's sales tax",
  untaxed: undefined,
};

// ── Helpers ────────────────────────────────────────────────────────────────

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = (cents: number) => money.format(cents / 100);
const listed = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const DAY_MS = 86_400_000;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** How far NetSuite's amount is from FleetSuite's, in a sentence. */
const apart = (fleetsuite: number, netsuite: number) =>
  `NetSuite's is ${dollars(Math.abs(netsuite - fleetsuite))} ${netsuite > fleetsuite ? 'more' : 'less'}.`;

/** What a line of NetSuite's credit memo credits, a discount credited back negative: NetSuite's own signed amount, else the mirror's. */
function creditedCents(line: NetsuiteLineData, type: string | null | undefined): number | null {
  if (line.netamount !== null && line.netamount !== undefined && line.netamount !== '') return centsOf(line.netamount);
  const amount = centsOf(line.amount);
  return amount === null ? null : type && TAKES_OFF.has(type) ? -amount : amount;
}

// ── One credit memo ────────────────────────────────────────────────────────

/** Books' own credit memo next to NetSuite's. */
export function checkOwnCreditMemo(pair: OwnCreditPairData, lists: OwnLists): OwnCreditMemoCheck {
  const own = pair.own;
  const ns = pair.netsuite;
  const customer = pair.customer_name ?? ns?.customer_name ?? null;
  const number = own.number || ns?.number || `NetSuite ${own.netsuite_id}`;
  const invoiceNumber = own.invoice_number || `NetSuite invoice ${own.invoice_id}`;
  const locationName = (id: string | null) => (id ? lists.locations.get(id) ?? `Location ${id}` : null);
  const itemName = (id: string | null, itemNumber: string | null, description: string | null) =>
    itemNumber || (id ? lists.items.get(id)?.number : null) || description || (id ? `NetSuite item ${id}` : 'A line with no item');
  const isCharge = (id: string | null) => !!id && lists.items.get(id)?.type === SHIP_ITEM_TYPE;

  const ownLines: OwnSide[] = (own.lines ?? []).map((l) => ({
    lineNo: l.line_no, itemId: l.item_id, itemNumber: l.item_number, description: l.description,
    quantity: num(l.quantity), rate: num(l.rate), cents: centsOf(l.amount) ?? 0, priced: true,
    taxable: !!l.taxable, taxCents: centsOf(l.tax) ?? 0,
  }));
  const ownSubtotal = centsOf(own.subtotal) ?? 0;
  const ownTax = centsOf(own.tax) ?? 0;
  const ownTotal = centsOf(own.total) ?? 0;
  const ownRate = num(own.tax_rate) ?? 0;

  // NetSuite's side: the lines it credits, each at what it credits on its own, the tax it gives back and its tax codes' rates.
  const nsCredited: NetSide[] = [];
  let nsTax = 0;
  let nsTaxReadable = true;
  const nsRates = new Set<number | null>();
  // The cost of the stock coming back, on lines of their own, posts under Stock and cost: it isn't credited.
  let nsCostLines = 0;
  for (const l of ns?.lines ?? []) {
    if (l.kind === 'tax') {
      const cents = creditedCents(l, null);
      if (cents === null) nsTaxReadable = false;
      else nsTax += cents;
      if (cents) nsRates.add(l.item_id ? lists.taxCodes.get(l.item_id)?.rate ?? null : null);
      continue;
    }
    if (l.cost) { nsCostLines++; continue; }
    const type = l.item_id ? lists.items.get(l.item_id)?.type ?? null : null;
    if (l.item_id && isLayoutItem(l.item_id, type)) continue;
    nsCredited.push({
      lineId: l.line_id, itemId: l.item_id, itemNumber: l.item_number, description: l.description,
      quantity: num(l.quantity), rate: num(l.rate), cents: creditedCents(l, type),
    });
  }
  const spread = takeApartSpread(nsCredited, (id) => (id ? lists.items.get(id)?.type ?? null : null));
  const nsLines = spread.lines.filter((l) => l.cents !== 0);
  const nsTotal = ns ? centsOf(ns.total) : null;
  const [onlyRate] = [...nsRates];
  const nsRate = nsRates.size === 1 && onlyRate !== undefined ? onlyRate : null;
  const linesThere = !!ns && ns.lines_copied;

  const fields: OwnFieldCheck[] = [];

  // Who it's for: the invoice's customer.
  {
    const mine = own.customer_netsuite_id ?? null;
    const theirs = ns?.customer_netsuite_id ?? null;
    const same = ns ? mine === theirs : null;
    fields.push({
      field: 'customer',
      label: 'Customer',
      fleetsuite: mine ? pair.customer_name ?? `NetSuite customer ${mine}` : 'None',
      netsuite: ns ? ns.customer_name ?? (theirs ? `NetSuite customer ${theirs}` : 'None') : null,
      same,
      why: same === false ? "NetSuite's credit memo is for another customer." : null,
    });
  }

  // Its date.
  {
    const same = ns ? own.date === ns.date : null;
    const days = ns ? Math.round((Date.parse(ns.date) - Date.parse(own.date)) / DAY_MS) : 0;
    fields.push({
      field: 'date',
      label: 'Date',
      fleetsuite: dayText(own.date),
      netsuite: ns ? dayText(ns.date) : null,
      same,
      why: same === false
        ? `FleetSuite made it ${dayText(own.date)}, and NetSuite's credit memo is dated ${plural(Math.abs(days), 'day', 'days')} ${days > 0 ? 'later' : 'earlier'}.`
        : null,
    });
  }

  // Where it books: the invoice's location.
  {
    const theirs = pair.netsuite_gl ? pair.netsuite_gl.location_id ?? null : null;
    const same = pair.netsuite_gl ? (own.location_id ?? null) === theirs : null;
    let why: string | null = null;
    if (!pair.netsuite_gl) why = ns ? "The copy of NetSuite's general ledger doesn't have the credit memo yet." : null;
    else if (same === false) {
      why = `FleetSuite's copy has the invoice's location, ${locationName(own.location_id) ?? 'none'}, `
        + `and NetSuite's credit memo books to ${locationName(theirs) ?? 'no location'}.`;
    }
    fields.push({
      field: 'location',
      label: 'Location',
      fleetsuite: locationName(own.location_id) ?? 'None',
      netsuite: pair.netsuite_gl ? locationName(theirs) ?? 'None' : null,
      same,
      why,
    });
  }

  // What it credits.
  const lines = linesThere ? pairLines(ownLines, nsLines, itemName, isCharge, CREDIT_LINE_WORDS) : [];
  {
    const same = linesThere ? lines.every((p) => p.same !== false) : null;
    const first = lines.find((p) => p.same === false);
    let why: string | null = null;
    if (ns && !ns.lines_copied) why = "NetSuite's lines aren't copied yet.";
    else if (first) {
      const more = lines.filter((p) => p.same === false).length - 1;
      why = `${first.why}${more > 0 ? ` ${plural(more, 'other line differs', 'other lines differ')}.` : ''}`;
    }
    fields.push({
      field: 'lines',
      label: 'Lines',
      fleetsuite: plural(ownLines.length, 'line', 'lines'),
      netsuite: linesThere ? plural(nsLines.length, 'line', 'lines') : null,
      same,
      why,
    });
  }

  // What it comes to.
  const nsSubtotal = nsTotal !== null && linesThere && nsTaxReadable ? nsTotal - nsTax : null;
  {
    const same = nsSubtotal !== null ? ownSubtotal === nsSubtotal : null;
    fields.push({
      field: 'subtotal',
      label: 'Before tax',
      fleetsuite: dollars(ownSubtotal),
      netsuite: nsSubtotal !== null ? dollars(nsSubtotal) : null,
      same,
      why: same === false ? apart(ownSubtotal, nsSubtotal!) : null,
    });
  }
  {
    const nsTaxShown = linesThere && nsTaxReadable ? nsTax : null;
    const same = nsTaxShown !== null ? ownTax === nsTaxShown : null;
    const untaxed = own.tax_rate_from === 'untaxed';
    fields.push({
      field: 'tax',
      label: 'Sales tax',
      fleetsuite: dollars(ownTax),
      netsuite: nsTaxShown !== null ? dollars(nsTaxShown) : null,
      same,
      why: same === false
        ? explainTax({
          lines: ownLines.map((l) => ({ item: itemName(l.itemId, l.itemNumber, l.description), cents: l.cents, taxable: l.taxable, priced: true })),
          // Nothing taxed is at no rate: the lines NetSuite taxed are looked for at NetSuite's.
          fleetsuite: ownTax, rate: untaxed ? nsRate ?? 0 : ownRate, basis: 'rate',
          netsuite: nsTax, netsuiteRate: nsRate, customer, customerTaxable: null,
          rateFrom: RATE_FROM[own.tax_rate_from],
          charged: 'took back',
        })
        : null,
    });
  }
  {
    const same = nsTotal !== null ? ownTotal === nsTotal : null;
    fields.push({
      field: 'total',
      label: 'Total',
      fleetsuite: dollars(ownTotal),
      netsuite: nsTotal !== null ? dollars(nsTotal) : null,
      same,
      why: same === false ? apart(ownTotal, nsTotal!) : null,
    });
  }

  const differing = fields.filter((f) => f.same === false).length;

  let status: OwnCreditStatus;
  let summary: string;
  if (!ns) {
    status = 'waiting';
    summary = "Waiting for NetSuite's credit memo: the ledger mirror copies NetSuite's credit memos every two hours.";
  } else if (ns.voided || ns.deleted) {
    status = 'voided';
    summary = ns.deleted ? "NetSuite's credit memo is gone from NetSuite." : "NetSuite's credit memo was voided.";
  } else if (!ns.lines_copied) {
    status = 'waiting';
    summary = "Waiting for NetSuite's lines: the credit memo is copied, its lines aren't yet.";
  } else if (!pair.netsuite_gl) {
    status = 'waiting';
    summary = "Waiting for the copy of NetSuite's general ledger to reach the credit memo.";
  } else if (differing) {
    status = 'differs';
    summary = differsSummary(fields);
  } else {
    status = 'matches';
    summary = "Matches NetSuite's credit memo.";
  }

  const named = (ls: OwnCreditLineData[]) => listed(ls.map((l) => itemName(l.item_id, l.item_number, l.description)));
  const backToStock = (own.lines ?? []).filter((l) => l.back_to_stock);
  const onCreditItem = (own.lines ?? []).filter((l) => l.on_credit_item);
  const workedOut = [
    `Made against ${invoiceNumber} on ${dayText(own.date)}.`,
    "Its lines are the ones FleetSuite sent NetSuite: each line of the invoice it credits at the quantity and price picked, "
      + 'or the amount, and any amount of its own on the credit item.',
    own.tax_rate_from === 'untaxed'
      ? 'No sales tax given back: none of the lines it credits was taxed on the invoice.'
      : `Sales tax given back at ${pct(ownRate)}, ${RATE_FROM[own.tax_rate_from] ?? 'the invoice\'s'}, on the lines the invoice taxed, `
        + "each line's rounded to the cent.",
    "Its location is the invoice's: NetSuite makes the credit memo from the invoice.",
  ];
  if (backToStock.length) {
    workedOut.push(`${named(backToStock)} ${backToStock.length === 1 ? 'goes' : 'go'} back on the shelf: the stock and its cost `
      + "post from NetSuite's credit memo, under Stock and cost.");
  }
  if (onCreditItem.length) {
    workedOut.push(`${plural(onCreditItem.length, 'line goes', 'lines go')} on the credit item, so no part comes back for ${onCreditItem.length === 1 ? 'it' : 'them'}.`);
  }
  if (spread.spread) {
    const discount = itemName(spread.spread.itemId, spread.spread.itemNumber, spread.spread.description);
    workedOut.push(`NetSuite spread ${discount} over the lines it applies to, so NetSuite's lines are taken at their quantities times their prices, `
      + `and ${discount} at the difference.`);
  }
  if (nsCostLines) workedOut.push(costLinesText(nsCostLines, "NetSuite's credit memo", 'that came back'));

  return {
    netsuiteId: own.netsuite_id,
    number,
    date: own.date,
    invoiceId: own.invoice_id,
    invoiceNumber,
    reason: own.reason,
    customer,
    status,
    summary,
    differing,
    fleetsuiteTotal: ownTotal,
    netsuiteTotal: nsTotal,
    fields,
    lines,
    backToStock: backToStock.length,
    workedOut,
  };
}

export interface OwnCreditMemosChecked {
  creditMemos: OwnCreditMemoCheck[];
  counts: Record<OwnCreditStatus, number>;
}

/** Every own credit memo gl_own_credit_memo_pairs returned, each checked. */
export function checkOwnCreditMemos(data: OwnCreditPairsData): OwnCreditMemosChecked {
  const lists = ownLists(data);
  const creditMemos = (data.credit_memos ?? []).map((pair) => checkOwnCreditMemo(pair, lists));
  const counts = Object.fromEntries(CREDIT_CHECK_STATUSES.map((s) => [s, 0])) as Record<OwnCreditStatus, number>;
  for (const c of creditMemos) counts[c.status]++;
  return { creditMemos, counts };
}
