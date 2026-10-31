/**
 * Credit memos made in FleetSuite against an invoice (migration 466,
 * docs/books.md "Credit memos made in FleetSuite"; owner decisions
 * 2026-10-31, thread "Replacing NetSuite with FleetSuite": from January 1,
 * 2027 the team works only in FleetSuite, and FleetSuite sends each
 * document on to NetSuite).
 *
 * From an invoice in Invoicing → Invoiced, pick what to credit:
 *
 *   - a line by quantity and price each, never more than the invoice
 *     charged for it. A stock part credited on its own item goes back on
 *     the shelf at O'Fallon, as NetSuite does with a credit memo; with "back
 *     to stock" off, the money goes on the credit item named in Settings, so
 *     no part comes back;
 *   - a discount or markup the invoice had, by amount;
 *   - an amount of its own (a goodwill credit), on the credit item.
 *
 * Each line is taxed as the invoice taxed it, at the invoice's own rate, so
 * the credit gives back the tax the customer paid. Earlier credit memos
 * FleetSuite made against the invoice count against what's left to credit.
 * NetSuite makes the credit memo from the invoice (its "Credit"), so the
 * customer, location and terms come from the invoice, and applies it to the
 * invoice while it's still owed; anything more stays as the customer's
 * credit.
 *
 * Pure, so the page and the route agree on the lines, the tax and the total.
 */

import { roundCentsHalfEven } from '@/lib/estimate-totals';
import { isPartTaxable } from '@/lib/line-taxability';

export const MAX_CREDIT_LINES = 100;

/** Amounts of its own (goodwill credits) one credit memo can have. */
export const MAX_ADDED_AMOUNTS = 20;

/** The location stock comes back to: O'Fallon is the only one that keeps stock. */
export const STOCK_LOCATION_ID = '1';

/** How the credit's tax is worked out: each line as the invoice taxed it, at the invoice's rate. */
export const CREDIT_TAX_RULE = 'credit_tax@1';

/** NetSuite item types whose stock it tracks: a credit memo line of one puts the part back on the shelf. */
const STOCK_TYPES = new Set(['invtpart', 'inventoryitem', 'assembly', 'assemblyitem', 'kit', 'kititem']);
/** Lines that only lay the invoice out. */
const LAYOUT_TYPES = new Set(['subtotal', 'subtotalitem', 'description', 'descriptionitem', 'group', 'groupitem', 'itemgroup', 'endgroup']);
/** Lines with an amount and no quantity. */
const AMOUNT_TYPES = new Set(['discount', 'discountitem', 'markup', 'markupitem']);

export type TaxRateFrom = 'invoice' | 'tax_code' | 'worked_out' | 'untaxed';

export interface InvoiceLine {
  /** NetSuite's line key on the invoice's item sublist. */
  line: number;
  itemId: string | null;
  itemNumber: string;
  itemType: string | null;
  description: string;
  /**
   * 'quantity': credited by quantity and price each; 'amount': a discount or markup, or a line that took money off,
   * credited by amount.
   */
  kind: 'quantity' | 'amount';
  /** A discount or markup: NetSuite takes it as a rate alone, with no quantity or price level. */
  rateOnly: boolean;
  /** 0 on an amount line. */
  quantity: number;
  /** The price each; null when NetSuite gave none. */
  rate: number | null;
  /** What the line charged, in cents; a discount negative. */
  cents: number;
  taxable: boolean;
  /** NetSuite tracks the item's stock. */
  stock: boolean;
}

export interface InvoiceView {
  id: string;
  number: string;
  date: string | null;
  customerId: string | null;
  customerName: string;
  locationId: string | null;
  locationName: string | null;
  poNumber: string;
  memo: string;
  status: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** What's still owed on it; null when NetSuite didn't say. */
  owedCents: number | null;
  /** A fraction; null when FleetSuite can't tell it. */
  taxRate: number | null;
  taxRateFrom: TaxRateFrom | null;
  taxItemId: string | null;
  voided: boolean;
  lines: InvoiceLine[];
}

const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};
const ref = (v: any): string | null => {
  if (v == null) return null;
  if (typeof v === 'object') return v.refName != null ? String(v.refName) : v.id != null ? String(v.id) : null;
  return String(v);
};
const refId = (v: any): string | null => {
  if (v == null) return null;
  const id = typeof v === 'object' ? v.id : v;
  return id != null && /^-?\d+$/.test(String(id).trim()) ? String(id).trim() : null;
};
const dateOnly = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

/** Whole cents, rounded half to even, of a dollar amount. */
export const centsOf = (dollars: number) => Math.round(roundCentsHalfEven(dollars) * 100);

/** One line's sales tax at a rate (a fraction), rounded half to even the way NetSuite and Books do. */
export const lineTax = (lineCents: number, rate: number) => (rate > 0 ? centsOf((lineCents / 100) * rate) : 0);

/** Item type, normalised: REST answers "InvtPart" or { id, refName }. */
function itemTypeOf(it: any): string | null {
  const t = it?.itemType ?? it?.itemtype;
  const raw = typeof t === 'object' && t ? (t.id ?? t.refName) : t;
  return raw != null && String(raw).trim() ? String(raw).trim() : null;
}

/** Item number as shown: the last ":" segment of the item's name. */
function itemNumberOf(it: any): string {
  const parts = (ref(it?.item) || '').split(':');
  return parts[parts.length - 1].trim();
}

const flag = (v: unknown): boolean | null => (v === true || v === 'T' ? true : v === false || v === 'F' ? false : null);

/**
 * The invoice from GET invoice/{id}?expandSubResources=true, as the credit memo screen shows it. `taxCodeRate` is the
 * rate (a fraction) of the tax code on the invoice's header, from the copy of NetSuite's lists, when the invoice
 * doesn't say its own.
 */
export function parseInvoiceRecord(rec: any, opts: { taxCodeRate?: number | null } = {}): InvoiceView {
  const subtotalCents = Math.round(num(rec?.subtotal) * 100);
  const taxCents = Math.round(num(rec?.taxTotal ?? rec?.taxtotal) * 100);
  const totalCents = Math.round(num(rec?.total) * 100);

  const items: any[] = rec?.item?.items || [];
  const lines: InvoiceLine[] = [];
  for (const it of items) {
    if (it?.line == null || !Number.isFinite(Number(it.line))) continue;
    const type = itemTypeOf(it);
    const lower = (type || '').toLowerCase();
    if (LAYOUT_TYPES.has(lower)) continue;
    const rateOnly = AMOUNT_TYPES.has(lower);
    const listedRate = numOrNull(it.rate);
    const amount = it.amount != null && it.amount !== '' ? num(it.amount) : (listedRate ?? 0) * Math.abs(num(it.quantity));
    const cents = Math.round(amount * 100);
    if (cents === 0) continue;
    // A line that took money off (a trade-in, say) is credited back by its amount, as a discount is.
    const kind: InvoiceLine['kind'] = rateOnly || cents < 0 ? 'amount' : 'quantity';
    const quantity = kind === 'amount' ? 0 : Math.abs(num(it.quantity));
    const rate = kind === 'amount' ? null : listedRate;
    // What NetSuite taxed on this invoice; where it doesn't say, FleetSuite's rule, and nothing when it charged none.
    const said = flag(it.isTaxable ?? it.istaxable);
    const taxable = taxCents === 0 ? false : said ?? isPartTaxable({ item_type: type, item_number: itemNumberOf(it) });
    lines.push({
      line: Number(it.line),
      itemId: refId(it.item),
      itemNumber: itemNumberOf(it),
      itemType: type,
      description: String(it.description ?? '').trim(),
      kind,
      rateOnly,
      quantity,
      rate: rate === null ? null : Math.abs(rate),
      cents,
      taxable,
      stock: STOCK_TYPES.has(lower),
    });
  }

  // The invoice's own rate first (NetSuite keeps it as a percent), then its tax code's, then what its tax comes to.
  let taxRate: number | null = null;
  let taxRateFrom: TaxRateFrom | null = null;
  const own = numOrNull(rec?.taxRate ?? rec?.taxrate);
  if (taxCents === 0) {
    taxRate = 0;
    taxRateFrom = 'untaxed';
  } else if (own !== null && own > 0 && own < 100) {
    taxRate = own / 100;
    taxRateFrom = 'invoice';
  } else if (opts.taxCodeRate != null && opts.taxCodeRate > 0 && opts.taxCodeRate < 1) {
    taxRate = opts.taxCodeRate;
    taxRateFrom = 'tax_code';
  } else {
    const taxedCents = lines.filter((l) => l.taxable).reduce((s, l) => s + l.cents, 0);
    if (taxedCents > 0 && taxCents > 0 && taxCents < taxedCents) {
      taxRate = Math.round((taxCents / taxedCents) * 1e6) / 1e6;
      taxRateFrom = 'worked_out';
    }
  }

  const owed = numOrNull(rec?.amountRemaining ?? rec?.amountremaining ?? rec?.amountRemainingTotalBox);
  const status = ref(rec?.status) || '';
  return {
    id: String(rec?.id ?? ''),
    number: String(rec?.tranId ?? rec?.tranid ?? rec?.id ?? ''),
    date: dateOnly(rec?.tranDate ?? rec?.trandate),
    customerId: refId(rec?.entity),
    customerName: ref(rec?.entity) || '',
    locationId: refId(rec?.location),
    locationName: rec?.location && typeof rec.location === 'object' && rec.location.refName ? String(rec.location.refName) : null,
    poNumber: String(rec?.otherRefNum ?? rec?.otherrefnum ?? '').trim(),
    memo: String(rec?.memo ?? '').trim(),
    status,
    subtotalCents,
    taxCents,
    totalCents,
    owedCents: owed === null ? null : Math.round(Math.abs(owed) * 100),
    taxRate,
    taxRateFrom,
    taxItemId: refId(rec?.taxItem ?? rec?.taxitem),
    voided: /void/i.test(status) || rec?.voided === true,
    lines,
  };
}

// ── What earlier credit memos took ─────────────────────────────────────────

/** A line of a credit memo FleetSuite already made against the invoice, as invoice_credit_memos keeps it. */
export interface EarlierCreditLine {
  invoiceLine: number | null;
  cents: number;
  quantity: number | null;
  backToStock: boolean;
}

export interface EarlierCredits {
  /** Invoice line → cents credited on it so far. */
  cents: Map<number, number>;
  /** Invoice line → quantity put back on the shelf so far. */
  backToStock: Map<number, number>;
}

export function earlierCredits(lines: EarlierCreditLine[]): EarlierCredits {
  const cents = new Map<number, number>();
  const backToStock = new Map<number, number>();
  for (const l of lines) {
    if (l.invoiceLine === null || !Number.isFinite(l.invoiceLine)) continue;
    cents.set(l.invoiceLine, (cents.get(l.invoiceLine) ?? 0) + l.cents);
    if (l.backToStock && l.quantity) backToStock.set(l.invoiceLine, (backToStock.get(l.invoiceLine) ?? 0) + l.quantity);
  }
  return { cents, backToStock };
}

export const NO_EARLIER: EarlierCredits = { cents: new Map(), backToStock: new Map() };

/** What's left to credit on an invoice line, in cents: a discount's is negative. */
export const leftToCredit = (l: InvoiceLine, earlier: EarlierCredits) => l.cents - (earlier.cents.get(l.line) ?? 0);

/**
 * A number as the screen's box starts it, never more than the number itself, so a box left as it was stays within
 * the invoice's caps: money to the cent when it's whole cents and otherwise to 6 decimals, a quantity to 4, each
 * rounded down.
 */
export function boxText(n: number, kind: 'money' | 'quantity'): string {
  const scale = kind === 'money' ? 1e6 : 1e4;
  const down = Math.floor(n * scale + 1e-6) / scale;
  if (kind === 'quantity') return String(down);
  return Math.abs(down * 100 - Math.round(down * 100)) < 1e-6 ? down.toFixed(2) : String(down);
}

// ── The credit memo ────────────────────────────────────────────────────────

/** What the person picked on one of the invoice's lines. */
export interface CreditLineDraft {
  line: number;
  /** A quantity line: how many and at what price each. */
  quantity?: number;
  price?: number;
  /** An amount line: how much of its amount, in dollars, as a positive number. */
  amount?: number;
  /** A stock part: true puts it back on the shelf; false credits the money on the credit item. */
  backToStock?: boolean;
}

/** An amount of its own, on the credit item. */
export interface AddedCreditDraft {
  description: string;
  amount: number;
  taxable: boolean;
}

export interface CreditItem {
  id: string;
  itemNumber: string | null;
}

export interface WorkedCreditLine {
  /** The invoice line it credits; null for an amount of its own. */
  invoiceLine: number | null;
  /** The item it goes on in NetSuite: the invoice line's own, or the credit item. */
  itemId: string;
  itemNumber: string;
  description: string;
  /** Null on an amount line. */
  quantity: number | null;
  /** The price each; null on an amount line. */
  price: number | null;
  /** What it credits; a discount credited back negative. */
  cents: number;
  taxable: boolean;
  taxCents: number;
  backToStock: boolean;
  onCreditItem: boolean;
  /** A discount or markup: NetSuite takes the line as a rate alone, with no quantity or price level. */
  rateOnly: boolean;
}

export interface WorkedCreditMemo {
  lines: WorkedCreditLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Plain-English reasons it can't be made yet, one per problem. */
  problems: string[];
}

export const formatCents = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const qtyText = (n: number) => String(Number(n.toFixed(4)));

/**
 * What crediting all that's left of a line picks ("Credit it all"): the whole quantity at the invoice's price when
 * nothing's been credited on it; what's left of the quantity when earlier credits took whole ones; otherwise the
 * whole quantity at the most each, to the cent, that doesn't come to more than what's left. A discount or markup,
 * all that's left of its amount. Null when nothing is left.
 */
export function creditAllOf(l: InvoiceLine, earlier: EarlierCredits): CreditLineDraft | null {
  const left = leftToCredit(l, earlier);
  if (l.kind === 'amount') {
    // What's left keeps the line's sign until it's all been credited.
    if (l.cents < 0 ? left >= 0 : left <= 0) return null;
    return { line: l.line, amount: Math.abs(left) / 100 };
  }
  if (left <= 0 || !(l.quantity > 0)) return null;
  const fits = (quantity: number, price: number) => price > 0 && centsOf(quantity * price) <= left;
  const rate = l.rate ?? Number(boxText(l.cents / 100 / l.quantity, 'money'));
  if (left === l.cents && fits(l.quantity, rate)) return { line: l.line, quantity: l.quantity, price: rate };
  const rateCents = Math.round(rate * 100);
  if (rateCents > 0 && Math.abs(rate * 100 - rateCents) < 1e-6 && left % rateCents === 0 && left / rateCents <= l.quantity) {
    return { line: l.line, quantity: left / rateCents, price: rate };
  }
  let eachCents = Math.ceil(left / l.quantity);
  while (eachCents > 0 && !fits(l.quantity, eachCents / 100)) eachCents -= 1;
  return eachCents > 0 ? { line: l.line, quantity: l.quantity, price: eachCents / 100 } : null;
}

/**
 * The credit memo from what the person picked: its lines, tax and total, and what stops it. A line picked at
 * nothing is left off.
 */
export function workOutCreditMemo(
  invoice: InvoiceView,
  drafts: CreditLineDraft[],
  added: AddedCreditDraft[],
  opts: { earlier: EarlierCredits; creditItem: CreditItem | null; reason: string },
): WorkedCreditMemo {
  const problems: string[] = [];
  if (invoice.voided) problems.push(`Invoice ${invoice.number} is voided in NetSuite, so there's nothing to credit.`);
  if (!opts.reason.trim()) problems.push("Say why it's being credited.");

  const byLine = new Map(invoice.lines.map((l) => [l.line, l]));
  const seen = new Set<number>();
  const lines: WorkedCreditLine[] = [];
  const creditItemLine = (what: string) => {
    if (!opts.creditItem) {
      problems.push(`${what}: crediting money with no part coming back goes on the NetSuite Credit Item, and none is picked yet. A super admin picks it in Settings.`);
    }
    return opts.creditItem;
  };

  for (const d of drafts) {
    const l = byLine.get(d.line);
    if (!l) { problems.push(`Line ${d.line} isn't on invoice ${invoice.number} any more. Reload and try again.`); continue; }
    if (seen.has(d.line)) { problems.push(`${l.itemNumber || `Line ${d.line}`} was picked twice.`); continue; }
    seen.add(d.line);
    const name = l.itemNumber || `Line ${l.line}`;
    const before = opts.earlier.cents.get(l.line) ?? 0;
    const left = l.cents - before;

    if (l.kind === 'amount') {
      const amount = d.amount ?? 0;
      if (amount === 0) continue;
      if (!(Number.isFinite(amount) && amount > 0)) { problems.push(`${name}: enter an amount above $0.`); continue; }
      const sign = l.cents < 0 ? -1 : 1;
      const cents = sign * centsOf(amount);
      if (Math.abs(cents) > Math.abs(left)) {
        problems.push(before !== 0
          ? `${name}: only ${formatCents(Math.abs(left))} of it is left to credit.`
          : `${name}: that's more than the invoice's ${formatCents(Math.abs(l.cents))}.`);
      }
      if (!l.itemId) { problems.push(`${name}: NetSuite didn't say which item this line is.`); continue; }
      lines.push({
        invoiceLine: l.line, itemId: l.itemId, itemNumber: l.itemNumber, description: l.description,
        quantity: null, price: null, cents, taxable: l.taxable, taxCents: 0, backToStock: false, onCreditItem: false,
        rateOnly: l.rateOnly,
      });
      continue;
    }

    const quantity = d.quantity ?? 0;
    if (quantity === 0) continue;
    const price = d.price ?? 0;
    if (!(Number.isFinite(quantity) && quantity > 0)) { problems.push(`${name}: enter a quantity above 0.`); continue; }
    if (!(Number.isFinite(price) && price > 0)) { problems.push(`${name}: enter a price above $0.`); continue; }
    if (quantity > l.quantity + 1e-9) problems.push(`${name}: the invoice billed ${qtyText(l.quantity)}, so at most ${qtyText(l.quantity)} can be credited.`);
    if (l.rate !== null && price > l.rate + 1e-9) problems.push(`${name}: the invoice charged ${formatCents(Math.round(l.rate * 100))} each, so the price can't be more.`);
    const cents = centsOf(quantity * price);
    if (cents > left) {
      problems.push(before > 0
        ? `${name}: only ${formatCents(Math.max(0, left))} of this line is left to credit.`
        : `${name}: that's more than the invoice charged for it (${formatCents(l.cents)}).`);
    }

    const backToStock = l.stock && d.backToStock !== false;
    if (backToStock) {
      // More than the invoice billed is said above; this is what earlier credit memos already put back.
      const back = opts.earlier.backToStock.get(l.line) ?? 0;
      if (back > 0 && quantity > l.quantity - back + 1e-9) {
        problems.push(`${name}: ${qtyText(back)} already went back on the shelf, so at most ${qtyText(Math.max(0, l.quantity - back))} more can.`);
      }
    }
    const onCreditItem = l.stock && !backToStock;
    const item = onCreditItem ? creditItemLine(name) : null;
    const itemId = onCreditItem ? item?.id ?? null : l.itemId;
    if (!itemId) {
      if (!onCreditItem) problems.push(`${name}: NetSuite didn't say which item this line is.`);
      continue;
    }
    lines.push({
      invoiceLine: l.line,
      itemId,
      itemNumber: onCreditItem ? item?.itemNumber || 'Credit' : l.itemNumber,
      description: onCreditItem ? [l.itemNumber, l.description].filter(Boolean).join(' - ') : l.description,
      quantity, price, cents, taxable: l.taxable, taxCents: 0, backToStock, onCreditItem, rateOnly: false,
    });
  }

  added.forEach((a, i) => {
    const name = a.description.trim() || `Added amount ${i + 1}`;
    if (!a.description.trim()) problems.push(`Added amount ${i + 1}: say what it's for.`);
    if (!(Number.isFinite(a.amount) && a.amount > 0)) { problems.push(`${name}: enter an amount above $0.`); return; }
    const item = creditItemLine(name);
    if (!item) return;
    // An invoice that charged no tax has none to give back.
    lines.push({
      invoiceLine: null, itemId: item.id, itemNumber: item.itemNumber || 'Credit', description: a.description.trim(),
      quantity: 1, price: a.amount, cents: centsOf(a.amount), taxable: a.taxable && invoice.taxCents > 0, taxCents: 0,
      backToStock: false, onCreditItem: true, rateOnly: false,
    });
  });

  if (lines.length === 0 && problems.length === 0) problems.push('Pick at least one line to credit.');
  if (lines.length > MAX_CREDIT_LINES) problems.push(`A credit memo can have at most ${MAX_CREDIT_LINES} lines.`);
  const taxed = lines.some((l) => l.taxable);
  if (taxed && invoice.taxRate === null) {
    problems.push(`FleetSuite can't tell invoice ${invoice.number}'s sales tax rate, so it can't work out the tax to give back.`);
  }
  const rate = invoice.taxRate ?? 0;
  for (const l of lines) l.taxCents = l.taxable ? lineTax(l.cents, rate) : 0;

  const subtotalCents = lines.reduce((s, l) => s + l.cents, 0);
  const taxCents = lines.reduce((s, l) => s + l.taxCents, 0);
  if (lines.length > 0 && subtotalCents + taxCents <= 0) problems.push('The credit has to come to more than $0.');
  return { lines, subtotalCents, taxCents, totalCents: subtotalCents + taxCents, problems };
}

/**
 * The item lines as NetSuite's invoice → credit memo transform takes them (?replace=item): a line at the Custom price
 * level so NetSuite keeps the price (one credited by its amount as one at that amount), a discount or markup as its
 * rate alone, each taxed as the invoice taxed it. A part going back on the shelf is booked to O'Fallon when the
 * invoice is from somewhere else.
 */
export function netsuiteCreditLines(worked: WorkedCreditLine[], opts: { invoiceLocationId: string | null }) {
  const elsewhere = opts.invoiceLocationId !== STOCK_LOCATION_ID;
  return worked.map((l) => ({
    item: { id: l.itemId },
    ...(l.rateOnly
      ? { rate: l.cents / 100 }
      : l.quantity === null
        ? { quantity: 1, price: { id: '-1' }, rate: l.cents / 100 }
        : { quantity: l.quantity, price: { id: '-1' }, rate: l.price }),
    ...(l.description ? { description: l.description } : {}),
    isTaxable: l.taxable,
    ...(l.backToStock && elsewhere ? { location: { id: STOCK_LOCATION_ID } } : {}),
  }));
}

/** The lines as invoice_credit_memos and Books' copy keep them. */
export function keptCreditLines(worked: WorkedCreditLine[]) {
  return worked.map((l) => ({
    invoiceLine: l.invoiceLine,
    itemId: l.itemId,
    itemNumber: l.itemNumber,
    description: l.description || null,
    quantity: l.quantity,
    price: l.price,
    cents: l.cents,
    taxable: l.taxable,
    taxCents: l.taxCents,
    backToStock: l.backToStock,
    onCreditItem: l.onCreditItem,
  }));
}
