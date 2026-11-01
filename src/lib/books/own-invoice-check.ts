import { centsOf } from './invoice-check';
import { isLayoutItem } from './invoice-rule';
import { lineTax, OWN_TAX_RULE, TAKES_OFF, type MadeFrom, type TaxBasis, type Unknown } from './own-invoices';
import { parseRate, pct } from './sales-tax-rates';

/**
 * FleetSuite's own invoices next to NetSuite's (migration 407, docs/books.md
 * "FleetSuite's own invoices"; owner decision 2026-10-19, thread "Replacing
 * NetSuite with FleetSuite", "Own invoices").
 *
 * Each copy FleetSuite kept of an invoice it made
 * (src/lib/books/own-invoices.ts) is put next to NetSuite's invoice as the
 * ledger mirror copied it: who it's for, its date, location and due date,
 * each line it billed, what it comes to before tax, its sales tax and its
 * total. Where they differ the check says how, and for sales tax why where
 * it can tell: NetSuite's rate against FleetSuite's (the location's on Books
 * → Sales tax since part 66, else the one in Settings → Sales Tax), the
 * lines one taxed and the other didn't, or a customer NetSuite has as not
 * taxable.
 *
 * A copy:
 *   - waits until NetSuite's invoice, its lines and its posting are copied
 *     (the ledger mirror and the copy of NetSuite's general ledger, each
 *     every two hours);
 *   - is voided when NetSuite voided or deleted its invoice;
 *   - differs when anything compared differs;
 *   - is incomplete when nothing compared differs but FleetSuite couldn't
 *     work something out, which isn't compared;
 *   - matches otherwise.
 *
 * Pure. Amounts are whole cents, what the customer is charged, a discount
 * negative.
 */

// ── What gl_own_invoice_pairs returns ──────────────────────────────────────

export interface OwnLineData {
  line_no: number;
  item_id: string | null;
  item_number: string | null;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  amount: string;
  priced: boolean;
  taxable: boolean;
  tax: string;
  sales_order_line_id: string | null;
}

export interface OwnInvoiceData {
  netsuite_id: string;
  number: string | null;
  made_from: MadeFrom;
  made_from_id: string | null;
  sales_order_id: string | null;
  customer_netsuite_id: string | null;
  customer_id: string | null;
  date: string;
  location_id: string | null;
  location_from: 'sent' | 'rule' | null;
  po_number: string | null;
  memo: string | null;
  vin: string | null;
  terms_id: string | null;
  terms_name: string | null;
  terms_days: number | null;
  due_date: string | null;
  tax_rule: string;
  tax_basis: TaxBasis;
  tax_rate: string;
  subtotal: string;
  tax: string;
  total: string;
  /** 'fixed' since migration 471: FleetSuite fixed the invoice, and the copy is its version after the fix. */
  lines_from: 'sent' | 'sales_order_copy' | 'fixed';
  unknowns: Unknown[];
  made_at: string;
  lines: OwnLineData[];
}

export interface NetsuiteLineData {
  line_id: string;
  line_no: number | null;
  /** The ledger mirror's: 'tax' for a sales tax line. */
  kind: string;
  item_id: string | null;
  item_number: string | null;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  /** The mirror's, unsigned. */
  amount: string;
  /** NetSuite's own, signed, a sale negative; null when the mirror didn't keep it. */
  netamount: string | null;
}

export interface NetsuiteInvoiceData {
  number: string | null;
  date: string;
  due_date: string | null;
  total: string;
  customer_netsuite_id: string | null;
  customer_name: string | null;
  po_number: string | null;
  memo: string | null;
  status: string | null;
  voided: boolean;
  deleted: boolean;
  lines_copied: boolean;
  changed_at: string | null;
  copied_at: string | null;
  lines: NetsuiteLineData[];
}

export interface OwnPairData {
  own: OwnInvoiceData;
  netsuite: NetsuiteInvoiceData | null;
  /** From the invoice's receivable line in the copy of NetSuite's general ledger; null before that copy has it. */
  netsuite_gl: { location_id: string | null } | null;
  customer_name: string | null;
  /** NetSuite's customer as the lists copy has it (details: terms_id, taxable 'T'/'F', tax_item_id). */
  customer_list: Record<string, unknown> | null;
}

export interface OwnPairsData {
  invoices: OwnPairData[];
  items: Record<string, { number: string; type: string | null }>;
  tax_codes: Record<string, { name: string; rate: string | null }>;
  locations: Record<string, string>;
  terms: Record<string, { name: string; days: number | null }>;
}

// ── What the check says ────────────────────────────────────────────────────

export type OwnCheckStatus = 'matches' | 'differs' | 'incomplete' | 'waiting' | 'voided';

/** In the order the pages list them. */
export const OWN_CHECK_STATUSES: readonly OwnCheckStatus[] = ['differs', 'incomplete', 'waiting', 'matches', 'voided'];

export type OwnField = 'customer' | 'date' | 'location' | 'due_date' | 'lines' | 'subtotal' | 'tax' | 'total';

export interface OwnFieldCheck {
  field: OwnField;
  label: string;
  /** What FleetSuite's copy says, in words; null when it couldn't work it out. */
  fleetsuite: string | null;
  /** What NetSuite's invoice says; null when its copy doesn't say yet. */
  netsuite: string | null;
  /** Null when it isn't compared. */
  same: boolean | null;
  /** Why it differs, or why it isn't compared. */
  why: string | null;
}

export interface OwnLinePair {
  /** The item's number, or what the line says when it names none. */
  item: string;
  itemId: string | null;
  fleetsuite: {
    lineNo: number;
    description: string | null;
    quantity: number | null;
    rate: number | null;
    cents: number;
    priced: boolean;
    taxable: boolean;
    taxCents: number;
  } | null;
  netsuite: {
    lineId: string;
    description: string | null;
    quantity: number | null;
    rate: number | null;
    /** Null when NetSuite's amount couldn't be read. */
    cents: number | null;
  } | null;
  same: boolean | null;
  why: string | null;
}

export interface OwnInvoiceCheck {
  netsuiteId: string;
  number: string;
  date: string;
  madeFrom: MadeFrom;
  /** 'a finished vehicle', 'the Scan Log', … */
  madeFromText: string;
  customer: string | null;
  status: OwnCheckStatus;
  /** One sentence for the list. */
  summary: string;
  /** How many of the things compared differ. */
  differing: number;
  fleetsuiteTotal: number;
  /** Null before the copy of NetSuite's invoice has it. */
  netsuiteTotal: number | null;
  fields: OwnFieldCheck[];
  lines: OwnLinePair[];
  /** What FleetSuite couldn't work out, in words. */
  unknowns: string[];
  /** How FleetSuite worked its copy out, a sentence each. */
  workedOut: string[];
}

export const MADE_FROM_TEXT: Readonly<Record<MadeFrom, string>> = {
  vehicle: 'a finished vehicle',
  sales_order: "a sales order's installed quantities",
  po: "a PO's open quantities",
  scans: 'the Scan Log',
  graphics: 'a graphics job',
  typed: 'a new invoice typed in FleetSuite',
};

export const UNKNOWN_TEXT: Readonly<Record<Unknown, string>> = {
  lines: "the lines it billed (FleetSuite's copy of the sales order didn't have the order yet)",
  customer: 'who it was for',
  terms: "the customer's terms, so its due date",
  prices: 'the price of a line NetSuite priced itself',
  location: 'which location it books to',
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

/** 'Nov 18, 2026' from '2026-11-18'. */
export function dayText(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** How far NetSuite's amount is from FleetSuite's, in a sentence. */
const apart = (fleetsuite: number, netsuite: number) =>
  `NetSuite's is ${dollars(Math.abs(netsuite - fleetsuite))} ${netsuite > fleetsuite ? 'more' : 'less'}.`;

/** What's compared, in a sentence. */
const FIELD_WORDS: Readonly<Record<OwnField, string>> = {
  customer: 'the customer',
  date: 'the date',
  location: 'the location',
  due_date: 'the due date',
  lines: 'the lines',
  subtotal: 'the amount before tax',
  tax: 'the sales tax',
  total: 'the total',
};

/** A quantity as people write it: 3, 1.5. */
const qty = (n: number) => String(Number(n.toFixed(4)));

const sameQuantity = (a: number | null, b: number | null) => a === null || b === null || Math.abs(a - b) < 0.005;

/** The copied lists the check reads names from. */
export interface OwnLists {
  items: Map<string, { number: string; type: string | null }>;
  taxCodes: Map<string, { name: string; rate: number | null }>;
  locations: Map<string, string>;
}

export function ownLists(data: Pick<OwnPairsData, 'items' | 'tax_codes' | 'locations'>): OwnLists {
  return {
    items: new Map(Object.entries(data.items ?? {})),
    taxCodes: new Map(Object.entries(data.tax_codes ?? {}).map(([id, c]) => [id, { name: c.name, rate: parseRate(c.rate) }])),
    locations: new Map(Object.entries(data.locations ?? {})),
  };
}

/** What a line of NetSuite's invoice charges, a discount negative: NetSuite's own signed amount, else the mirror's. */
function netsuiteCents(line: NetsuiteLineData, type: string | null | undefined): number | null {
  if (line.netamount !== null && line.netamount !== undefined && line.netamount !== '') {
    const net = centsOf(line.netamount);
    return net === null ? null : net === 0 ? 0 : -net;
  }
  const amount = centsOf(line.amount);
  return amount === null ? null : type && TAKES_OFF.has(type) ? -amount : amount;
}

// ── Sales tax ──────────────────────────────────────────────────────────────

/** Lines at most this many are searched for which ones NetSuite taxed differently. */
const MAX_FLIP_LINES = 12;

const bits = (n: number) => { let c = 0; for (let m = n; m; m &= m - 1) c++; return c; };

/**
 * The fewest of FleetSuite's lines whose taxed or untaxed, the other way round, gives NetSuite's sales tax at `rate`,
 * worked out line by line as FleetSuite does: [] when none need to be, null when no set of them does or there are too
 * many lines to try.
 */
export function taxFlips<L extends { cents: number; taxable: boolean; priced: boolean }>(lines: L[], rate: number, target: number): L[] | null {
  const priced = lines.filter((l) => l.priced && l.cents !== 0);
  if (priced.length > MAX_FLIP_LINES) return null;
  const taxes = priced.map((l) => lineTax(l.cents, rate));
  const sets = Array.from({ length: 1 << priced.length }, (_, m) => m).sort((a, b) => bits(a) - bits(b) || a - b);
  for (const set of sets) {
    let tax = 0;
    for (let i = 0; i < priced.length; i++) if (priced[i].taxable !== !!(set & (1 << i))) tax += taxes[i];
    if (tax === target) return priced.filter((_, i) => set & (1 << i));
  }
  return null;
}

export interface TaxSides {
  lines: Array<{ item: string; cents: number; taxable: boolean; priced: boolean }>;
  /** FleetSuite's sales tax, its rate (a fraction) and why. */
  fleetsuite: number;
  rate: number;
  basis: TaxBasis;
  /** NetSuite's sales tax, and its rate when its tax lines all have the same one. */
  netsuite: number;
  netsuiteRate: number | null;
  customer: string | null;
  /** Whether NetSuite's customer list has the customer as taxable; null when it doesn't say. */
  customerTaxable: boolean | null;
  /** Where FleetSuite's rate is from, after it in the sentence; "from Settings → Sales Tax" when not given. */
  rateFrom?: string;
  /** What NetSuite did with its tax: "charged" when not given, "took back" on a credit memo. */
  charged?: string;
}

/** Why FleetSuite's sales tax and NetSuite's differ, as far as can be told; null when they don't. */
export function explainTax(t: TaxSides): string | null {
  if (t.fleetsuite === t.netsuite) return null;
  const who = t.customer || 'this customer';
  const charged = t.charged ?? 'charged';
  if (t.basis === 'georgia' && t.netsuite > 0) {
    return `FleetSuite doesn't tax work at Social Circle, Georgia, and NetSuite ${charged} ${dollars(t.netsuite)}.`;
  }
  if (t.basis === 'exempt_customer' && t.netsuite > 0) {
    return `FleetSuite has ${who} as tax-exempt, and NetSuite ${charged} ${dollars(t.netsuite)}.`;
  }
  if (t.netsuite === 0 && t.customerTaxable === false) {
    return `NetSuite has ${who} as not taxable, so it ${charged} no sales tax, and FleetSuite taxes them. `
      + 'If they are tax-exempt, mark them so on their FleetSuite customer record.';
  }

  const parts: string[] = [];
  const rateDiffers = t.basis === 'rate' && t.netsuiteRate !== null && Math.abs(t.netsuiteRate - t.rate) > 5e-7;
  if (rateDiffers) parts.push(`NetSuite's rate is ${pct(t.netsuiteRate!)} and FleetSuite's ${pct(t.rate)}, ${t.rateFrom ?? 'from Settings → Sales Tax'}.`);
  const rate = t.netsuiteRate ?? t.rate;
  const flips = rate > 0 ? taxFlips(t.lines, rate, t.netsuite) : null;
  if (flips?.length) {
    const named = (l: TaxSides['lines'][number]) => `${l.item} (${dollars(l.cents)})`;
    const also = flips.filter((l) => !l.taxable);
    const not = flips.filter((l) => l.taxable);
    if (also.length) parts.push(`NetSuite also taxed ${listed(also.map(named))}, which FleetSuite doesn't tax.`);
    if (not.length) parts.push(`NetSuite didn't tax ${listed(not.map(named))}, which FleetSuite taxes.`);
  }
  if (!flips || !parts.length) {
    if (t.netsuite === 0) parts.push(`NetSuite ${charged} no sales tax.`);
    else parts.push(`NetSuite ${charged} ${dollars(t.netsuite)} and FleetSuite worked out ${dollars(t.fleetsuite)}.`);
  }
  return parts.join(' ');
}

// ── Lines ──────────────────────────────────────────────────────────────────

/** NetSuite's item types for a discount or markup, which it spreads over the lines it applies to. */
const SPREAD_TYPES = new Set(['Discount', 'Markup']);

/**
 * NetSuite's lines at what each charges on its own. NetSuite spreads a
 * discount or markup over the lines it applies to: each one's net amount,
 * which is what the ledger mirror copies, carries its share, and the
 * discount's own line reads $0 net (docs/books.md "Invoices"). FleetSuite
 * bills a discount on a line of its own, so when NetSuite's invoice has one
 * discount or markup reading $0, its other lines are taken at quantity times
 * price and the discount at what that leaves, the total staying as it is.
 * With more than one, a line with no quantity or price, or one that's a
 * credit, or nothing taken off, the lines keep their net amounts. `spread`
 * is the discount's line when they were taken apart.
 */
export function takeApartSpread<L extends { itemId: string | null; quantity: number | null; rate: number | null; cents: number | null }>(
  lines: L[],
  typeOf: (itemId: string | null) => string | null,
): { lines: L[]; spread: L | null } {
  const isSpreadType = (l: L) => SPREAD_TYPES.has(typeOf(l.itemId) ?? '');
  const spreads = lines.filter((l) => isSpreadType(l) && l.cents === 0);
  if (spreads.length !== 1) return { lines, spread: null };
  const [spread] = spreads;
  let net = 0;
  let own = 0;
  const out: L[] = [];
  for (const l of lines) {
    if (l === spread || (isSpreadType(l) && l.cents !== null)) {
      // A discount NetSuite didn't spread charges its own amount.
      net += l.cents ?? 0;
      own += l.cents ?? 0;
      out.push(l);
      continue;
    }
    if (l.cents === null || l.cents < 0 || l.quantity === null || l.rate === null) return { lines, spread: null };
    const cents = Math.round(l.quantity * l.rate * 100);
    net += l.cents;
    own += cents;
    out.push(cents === l.cents ? l : { ...l, cents });
  }
  const off = net - own;
  // A discount takes money off and a markup adds it; anything else isn't a spread.
  if (off === 0 || (typeOf(spread.itemId) === 'Discount') !== (off < 0)) return { lines, spread: null };
  return { lines: out.map((l) => (l === spread ? { ...l, cents: off } : l)), spread };
}

type OwnSide = NonNullable<OwnLinePair['fleetsuite']> & { itemId: string | null; itemNumber: string | null };
type NetSide = NonNullable<OwnLinePair['netsuite']> & { itemId: string | null; itemNumber: string | null };

/** FleetSuite's lines paired with NetSuite's by item, a line at the same amount first, then in order. */
export function pairLines(own: OwnSide[], netsuite: NetSide[], itemName: (id: string | null, number: string | null, description: string | null) => string): OwnLinePair[] {
  const taken = new Set<number>();
  const match = new Map<number, number>();
  for (const exact of [true, false]) {
    own.forEach((o, i) => {
      if (match.has(i)) return;
      const j = netsuite.findIndex((n, k) => !taken.has(k) && n.itemId === o.itemId && (!exact || n.cents === o.cents));
      if (j >= 0) { taken.add(j); match.set(i, j); }
    });
  }

  const pairs: OwnLinePair[] = own.map((o, i) => {
    const n = match.has(i) ? netsuite[match.get(i)!] : null;
    const fleetsuite = {
      lineNo: o.lineNo, description: o.description, quantity: o.quantity, rate: o.rate,
      cents: o.cents, priced: o.priced, taxable: o.taxable, taxCents: o.taxCents,
    };
    const item = itemName(o.itemId, o.itemNumber, o.description);
    if (!n) {
      const amount = o.priced ? ` (${dollars(o.cents)})` : '';
      return { item, itemId: o.itemId, fleetsuite, netsuite: null, same: false, why: `FleetSuite billed ${item}${amount}, and NetSuite's invoice doesn't have it.` };
    }
    const netsuiteSide = { lineId: n.lineId, description: n.description, quantity: n.quantity, rate: n.rate, cents: n.cents };
    const quantitySame = sameQuantity(o.quantity, n.quantity);
    if (n.cents === null) {
      return { item, itemId: o.itemId, fleetsuite, netsuite: netsuiteSide, same: quantitySame ? null : false, why: `NetSuite's amount for ${item} couldn't be read.` };
    }
    const amountSame = !o.priced || o.cents === n.cents;
    const same = quantitySame && amountSame;
    let why: string | null = null;
    if (!quantitySame && !amountSame) {
      why = `FleetSuite billed ${qty(o.quantity!)} of ${item} for ${dollars(o.cents)}, and NetSuite ${qty(n.quantity!)} for ${dollars(n.cents)}.`;
    } else if (!quantitySame) {
      why = `FleetSuite billed ${qty(o.quantity!)} of ${item}, and NetSuite ${qty(n.quantity!)}.`;
    } else if (!amountSame) {
      why = `FleetSuite billed ${item} for ${dollars(o.cents)}, and NetSuite for ${dollars(n.cents)}.`;
    } else if (!o.priced) {
      why = `NetSuite priced ${item} at ${dollars(n.cents)}.`;
    }
    return { item, itemId: o.itemId, fleetsuite, netsuite: netsuiteSide, same, why };
  });

  netsuite.forEach((n, k) => {
    if (taken.has(k)) return;
    const item = itemName(n.itemId, n.itemNumber, n.description);
    pairs.push({
      item,
      itemId: n.itemId,
      fleetsuite: null,
      netsuite: { lineId: n.lineId, description: n.description, quantity: n.quantity, rate: n.rate, cents: n.cents },
      same: false,
      why: `NetSuite's invoice has ${item}${n.cents === null ? '' : ` (${dollars(n.cents)})`}, and FleetSuite didn't bill it.`,
    });
  });
  return pairs;
}

// ── One invoice ────────────────────────────────────────────────────────────

/** FleetSuite's own invoice next to NetSuite's. */
export function checkOwnInvoice(pair: OwnPairData, lists: OwnLists): OwnInvoiceCheck {
  const own = pair.own;
  const ns = pair.netsuite;
  const unknowns = new Set(own.unknowns ?? []);
  const customer = pair.customer_name ?? ns?.customer_name ?? null;
  const number = own.number || ns?.number || `NetSuite ${own.netsuite_id}`;
  const locationName = (id: string | null) => (id ? lists.locations.get(id) ?? `Location ${id}` : null);
  const itemName = (id: string | null, itemNumber: string | null, description: string | null) =>
    itemNumber || (id ? lists.items.get(id)?.number : null) || description || (id ? `NetSuite item ${id}` : 'A line with no item');

  const ownLines: OwnSide[] = (own.lines ?? []).map((l) => ({
    lineNo: l.line_no, itemId: l.item_id, itemNumber: l.item_number, description: l.description,
    quantity: num(l.quantity), rate: num(l.rate), cents: centsOf(l.amount) ?? 0, priced: l.priced !== false,
    taxable: !!l.taxable, taxCents: centsOf(l.tax) ?? 0,
  }));
  const ownSubtotal = centsOf(own.subtotal) ?? 0;
  const ownTax = centsOf(own.tax) ?? 0;
  const ownTotal = centsOf(own.total) ?? 0;
  const ownRate = num(own.tax_rate) ?? 0;
  // Since part 66 a copy taxed at a rate took its location's from Books → Sales tax; tax@1 is Settings' where Books had none.
  const ratedAt = own.tax_rule === OWN_TAX_RULE ? locationName(own.location_id) : null;

  // NetSuite's side: its billed lines, each at what it charges on its own, its sales tax and its tax codes' rates.
  const nsBilled: NetSide[] = [];
  let nsTax = 0;
  let nsTaxReadable = true;
  const nsRates = new Set<number | null>();
  for (const l of ns?.lines ?? []) {
    if (l.kind === 'tax') {
      const cents = netsuiteCents(l, null);
      if (cents === null) nsTaxReadable = false;
      else nsTax += cents;
      if (cents) nsRates.add(l.item_id ? lists.taxCodes.get(l.item_id)?.rate ?? null : null);
      continue;
    }
    const type = l.item_id ? lists.items.get(l.item_id)?.type ?? null : null;
    if (l.item_id && isLayoutItem(l.item_id, type)) continue;
    nsBilled.push({
      lineId: l.line_id, itemId: l.item_id, itemNumber: l.item_number, description: l.description,
      quantity: num(l.quantity), rate: num(l.rate), cents: netsuiteCents(l, type),
    });
  }
  const spread = takeApartSpread(nsBilled, (id) => (id ? lists.items.get(id)?.type ?? null : null));
  const nsLines = spread.lines.filter((l) => l.cents !== 0);
  const nsTotal = ns ? centsOf(ns.total) : null;
  const [onlyRate] = [...nsRates];
  const nsRate = nsRates.size === 1 && onlyRate !== undefined ? onlyRate : null;
  const linesThere = !!ns && ns.lines_copied;

  const fields: OwnFieldCheck[] = [];

  // Who it's for.
  {
    const mine = own.customer_netsuite_id;
    const theirs = ns?.customer_netsuite_id ?? null;
    const same = mine && ns ? mine === theirs : null;
    fields.push({
      field: 'customer',
      label: 'Customer',
      fleetsuite: mine ? pair.customer_name ?? `NetSuite customer ${mine}` : null,
      netsuite: ns ? ns.customer_name ?? (theirs ? `NetSuite customer ${theirs}` : 'None') : null,
      same,
      why: !mine ? `FleetSuite didn't know ${UNKNOWN_TEXT.customer}.`
        : same === false ? "NetSuite's invoice is for another customer." : null,
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
        ? `FleetSuite made it ${dayText(own.date)}, and NetSuite's invoice is dated ${plural(Math.abs(days), 'day', 'days')} ${days > 0 ? 'later' : 'earlier'}.`
        : null,
    });
  }

  // Where it books.
  {
    const theirs = pair.netsuite_gl ? pair.netsuite_gl.location_id : undefined;
    const same = own.location_id && pair.netsuite_gl ? own.location_id === theirs : null;
    let why: string | null = null;
    if (!own.location_id) why = `FleetSuite didn't know ${UNKNOWN_TEXT.location}: its invoice location rule couldn't tell from the customer.`;
    else if (!pair.netsuite_gl) why = ns ? "The copy of NetSuite's general ledger doesn't have the invoice yet." : null;
    else if (same === false) {
      why = own.location_from === 'rule'
        ? `FleetSuite's invoice location rule puts it in ${locationName(own.location_id)}, and NetSuite's invoice took ${locationName(theirs ?? null) ?? 'no location'} from its sales order.`
        : `FleetSuite gave NetSuite ${locationName(own.location_id)}, and NetSuite's invoice books to ${locationName(theirs ?? null) ?? 'no location'}.`;
    }
    fields.push({
      field: 'location',
      label: 'Location',
      fleetsuite: locationName(own.location_id),
      netsuite: pair.netsuite_gl ? locationName(theirs ?? null) ?? 'None' : null,
      same,
      why,
    });
  }

  // When it's due.
  {
    const terms = own.terms_name ? ` (${own.terms_name})` : own.terms_days === 0 ? ' (no terms: due when billed)' : '';
    const same = own.due_date && ns?.due_date ? own.due_date === ns.due_date : null;
    let why: string | null = null;
    if (!own.due_date) why = `FleetSuite didn't know ${UNKNOWN_TEXT.terms}.`;
    else if (ns && !ns.due_date) why = "The copy of NetSuite's invoice has no due date.";
    else if (same === false) {
      const days = Math.round((Date.parse(ns!.due_date!) - Date.parse(own.due_date)) / DAY_MS);
      const after = own.terms_days ? `${plural(own.terms_days, 'day', 'days')} after the invoice's date` : "the invoice's date";
      const from = own.terms_name
        ? `${after} (${own.terms_name}, the customer's terms in NetSuite)`
        : "the invoice's date, as the customer has no terms in NetSuite";
      why = `FleetSuite's is ${from}, and NetSuite's is ${plural(Math.abs(days), 'day', 'days')} ${days > 0 ? 'later' : 'earlier'}.`;
    }
    fields.push({
      field: 'due_date',
      label: 'Due',
      fleetsuite: own.due_date ? `${dayText(own.due_date)}${terms}` : null,
      netsuite: ns?.due_date ? dayText(ns.due_date) : null,
      same,
      why,
    });
  }

  // What it billed.
  const lines = linesThere && !unknowns.has('lines') ? pairLines(ownLines, nsLines, itemName) : [];
  {
    const same = linesThere && !unknowns.has('lines') ? lines.every((p) => p.same !== false) : null;
    const first = lines.find((p) => p.same === false);
    let why: string | null = null;
    if (unknowns.has('lines')) why = `FleetSuite didn't know ${UNKNOWN_TEXT.lines}.`;
    else if (ns && !ns.lines_copied) why = "NetSuite's lines aren't copied yet.";
    else if (first) {
      const more = lines.filter((p) => p.same === false).length - 1;
      why = `${first.why}${more > 0 ? ` ${plural(more, 'other line differs', 'other lines differ')}.` : ''}`;
    }
    fields.push({
      field: 'lines',
      label: 'Lines',
      fleetsuite: unknowns.has('lines') ? null : plural(ownLines.length, 'line', 'lines'),
      netsuite: linesThere ? plural(nsLines.length, 'line', 'lines') : null,
      same,
      why,
    });
  }

  // What it comes to.
  const moneyKnown = !unknowns.has('lines') && !unknowns.has('prices');
  const notKnown = unknowns.has('lines') ? `FleetSuite didn't know ${UNKNOWN_TEXT.lines}.` : `FleetSuite didn't know ${UNKNOWN_TEXT.prices}.`;
  const nsSubtotal = nsTotal !== null && linesThere && nsTaxReadable ? nsTotal - nsTax : null;
  {
    const same = moneyKnown && nsSubtotal !== null ? ownSubtotal === nsSubtotal : null;
    fields.push({
      field: 'subtotal',
      label: 'Before tax',
      fleetsuite: moneyKnown ? dollars(ownSubtotal) : null,
      netsuite: nsSubtotal !== null ? dollars(nsSubtotal) : null,
      same,
      why: !moneyKnown ? notKnown : same === false ? apart(ownSubtotal, nsSubtotal!) : null,
    });
  }
  {
    const nsTaxShown = linesThere && nsTaxReadable ? nsTax : null;
    const same = moneyKnown && nsTaxShown !== null ? ownTax === nsTaxShown : null;
    const customerTaxable = pair.customer_list?.taxable === 'T' ? true : pair.customer_list?.taxable === 'F' ? false : null;
    fields.push({
      field: 'tax',
      label: 'Sales tax',
      fleetsuite: moneyKnown ? dollars(ownTax) : null,
      netsuite: nsTaxShown !== null ? dollars(nsTaxShown) : null,
      same,
      why: !moneyKnown ? notKnown
        : same === false
          ? explainTax({
            lines: ownLines.map((l) => ({ item: itemName(l.itemId, l.itemNumber, l.description), cents: l.cents, taxable: l.taxable, priced: l.priced })),
            fleetsuite: ownTax, rate: ownRate, basis: own.tax_basis,
            netsuite: nsTax, netsuiteRate: nsRate, customer, customerTaxable,
            rateFrom: ratedAt ? `${ratedAt}'s on Books → Sales tax` : undefined,
          })
          : null,
    });
  }
  {
    const same = moneyKnown && nsTotal !== null ? ownTotal === nsTotal : null;
    fields.push({
      field: 'total',
      label: 'Total',
      fleetsuite: moneyKnown ? dollars(ownTotal) : null,
      netsuite: nsTotal !== null ? dollars(nsTotal) : null,
      same,
      why: !moneyKnown ? notKnown : same === false ? apart(ownTotal, nsTotal!) : null,
    });
  }

  const differing = fields.filter((f) => f.same === false).length;
  const unknownWords = [...unknowns].map((u) => UNKNOWN_TEXT[u]).filter(Boolean);

  let status: OwnCheckStatus;
  let summary: string;
  if (!ns) {
    status = 'waiting';
    summary = "Waiting for NetSuite's invoice: the ledger mirror copies NetSuite's invoices every two hours.";
  } else if (ns.voided || ns.deleted) {
    status = 'voided';
    summary = ns.deleted ? "NetSuite's invoice is gone from NetSuite." : "NetSuite's invoice was voided.";
  } else if (!ns.lines_copied) {
    status = 'waiting';
    summary = "Waiting for NetSuite's lines: the invoice is copied, its lines aren't yet.";
  } else if (!pair.netsuite_gl) {
    status = 'waiting';
    summary = "Waiting for the copy of NetSuite's general ledger to reach the invoice.";
  } else if (differing) {
    status = 'differs';
    const first = fields.find((f) => f.same === false)!;
    const what = first.why ?? `FleetSuite ${first.fleetsuite ?? 'nothing'}, NetSuite ${first.netsuite ?? 'nothing'}.`;
    const differs = (f: OwnField) => fields.some((x) => x.field === f && x.same === false);
    // The total follows from what's before tax and the tax, what's before tax from the lines.
    const follows = (f: OwnField) => (f === 'total' && (differs('subtotal') || differs('tax'))) || (f === 'subtotal' && differs('lines'));
    const others = fields.filter((f) => f.same === false && f !== first && !follows(f.field)).map((f) => f.field);
    const too = listed(others.map((f) => FIELD_WORDS[f]));
    summary = `${first.label}: ${what}${others.length
      ? ` ${too.charAt(0).toUpperCase()}${too.slice(1)} ${others.length > 1 || others[0] === 'lines' ? 'differ' : 'differs'} too.`
      : ''}`;
  } else if (unknownWords.length) {
    status = 'incomplete';
    summary = `Matches where it can be checked. FleetSuite didn't know ${listed(unknownWords)}.`;
  } else {
    status = 'matches';
    summary = "Matches NetSuite's invoice.";
  }

  const workedOut = [
    `Made from ${MADE_FROM_TEXT[own.made_from] ?? own.made_from} on ${dayText(own.date)}.`,
    own.lines_from === 'sales_order_copy'
      ? "Its lines are what FleetSuite's copy of the sales order still had to bill: NetSuite billed the order whole."
      : own.lines_from === 'fixed'
        ? 'Fixed in FleetSuite: its date and lines are the invoice\'s as FleetSuite fixed it, the lines it kept as NetSuite had them and the ones it changed or added as FleetSuite sent them.'
        : 'Its lines are the ones FleetSuite sent NetSuite, at the prices it sent.',
    own.tax_basis === 'georgia' ? "No sales tax: work at Social Circle, Georgia isn't taxed."
      : own.tax_basis === 'exempt_customer' ? 'No sales tax: the customer is tax-exempt in FleetSuite.'
        : `Sales tax at ${pct(ownRate)}, ${ratedAt ? `${ratedAt}'s rate on its date on Books → Sales tax` : 'the rate in Settings → Sales Tax'}, `
          + "on the lines FleetSuite taxes (not service items), each line's rounded to the cent.",
    own.terms_name ? `${own.terms_days ? `Due ${plural(own.terms_days, 'day', 'days')} after its date` : 'Due when billed'}: ${own.terms_name}, the customer's terms in NetSuite.`
      : own.terms_days === 0 ? 'Due when billed: the customer has no terms in NetSuite.'
        : "Its due date isn't known: the customer's terms weren't.",
    own.location_from === 'rule'
      ? "Its location is FleetSuite's invoice location rule's, from the customer: NetSuite took the sales order's."
      : own.location_from === 'sent' ? 'Its location is the one FleetSuite gave NetSuite.' : "Its location isn't known.",
  ];
  if (spread.spread) {
    const discount = itemName(spread.spread.itemId, spread.spread.itemNumber, spread.spread.description);
    workedOut.push(`NetSuite spread ${discount} over the lines it applies to, so NetSuite's lines are taken at their quantities times their prices, `
      + `and ${discount} at the difference.`);
  }

  return {
    netsuiteId: own.netsuite_id,
    number,
    date: own.date,
    madeFrom: own.made_from,
    madeFromText: MADE_FROM_TEXT[own.made_from] ?? own.made_from,
    customer,
    status,
    summary,
    differing,
    fleetsuiteTotal: ownTotal,
    netsuiteTotal: nsTotal,
    fields,
    lines,
    unknowns: unknownWords,
    workedOut,
  };
}

export interface OwnInvoicesChecked {
  invoices: OwnInvoiceCheck[];
  counts: Record<OwnCheckStatus, number>;
}

/** Every own invoice gl_own_invoice_pairs returned, each checked. */
export function checkOwnInvoices(data: OwnPairsData): OwnInvoicesChecked {
  const lists = ownLists(data);
  const invoices = (data.invoices ?? []).map((pair) => checkOwnInvoice(pair, lists));
  const counts = Object.fromEntries(OWN_CHECK_STATUSES.map((s) => [s, 0])) as Record<OwnCheckStatus, number>;
  for (const inv of invoices) counts[inv.status]++;
  return { invoices, counts };
}
