import { centsOf } from './invoice-check';
import { isLayoutItem } from './invoice-rule';
import { dayText, OWN_CHECK_STATUSES, type OwnCheckStatus } from './own-invoice-check';
import type { BillMadeFrom, BillUnknown } from './own-bills';

/**
 * Books' own bills next to NetSuite's (migration 435, docs/books.md
 * "FleetSuite's own bills and receipts"; owner decision 2026-10-24, thread
 * "Replacing NetSuite with FleetSuite", "Shared bills").
 *
 * Each copy Books kept of a bill FleetSuite made (src/lib/books/own-bills.ts)
 * is put next to NetSuite's bill as the copy of its bills has it (migration
 * 384, every two hours): who it's from, its number and date, the company the
 * copy of NetSuite's general ledger books it to, each line, and its total.
 * Lines are paired by what they're for: an expense line by its account, an
 * item line by its item, its quantity and amount added up.
 *
 * A copy:
 *   - waits until the copy of NetSuite's bills has the bill, and the copy of
 *     its general ledger the bill's entry, which says the company. Once the
 *     bills copy has run since and doesn't have it, it's gone (status
 *     'voided'), as it is when NetSuite deleted or voided the bill;
 *   - differs when anything compared differs;
 *   - is incomplete when nothing compared differs but FleetSuite couldn't
 *     work something out, which isn't compared;
 *   - matches otherwise.
 *
 * Pure. Amounts are whole cents.
 */

// ── What gl_own_bill_pairs returns ─────────────────────────────────────────

export interface OwnBillLineData {
  line_no: number;
  account_id: string | null;
  item_id: string | null;
  item_number: string | null;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  amount: string | null;
  po_line_id: string | null;
}

export interface OwnBillData {
  netsuite_id: string;
  number: string | null;
  company: string;
  made_from: BillMadeFrom;
  made_from_id: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  reference_no: string | null;
  date: string;
  po_id: string | null;
  po_number: string | null;
  location_id: string | null;
  invoice_total: string | null;
  unknowns: BillUnknown[];
  made_at: string;
  lines: OwnBillLineData[];
}

/** One of NetSuite's bill lines as the copy of its bills has it, the amounts signed as NetSuite gives them. */
export interface NetsuiteBillLineData {
  line_id: string;
  item: string | null;
  account: string | null;
  amount: string | null;
  own_amount?: string | null;
  quantity: string | null;
  memo?: string | null;
  tax?: boolean;
}

export interface NetsuiteBillData {
  number: string | null;
  type: string;
  date: string;
  vendor_id: string | null;
  vendor_name: string | null;
  total: string;
  status: string | null;
  voided: boolean;
  gone: boolean;
  /** Null when the copy couldn't read them. */
  lines: NetsuiteBillLineData[] | null;
  /** The companies the copy of NetSuite's general ledger books it to; empty before that copy has it. */
  companies: string[];
}

export interface BillPairData {
  own: OwnBillData;
  /** Null before the copy of NetSuite's bills has it. */
  netsuite: NetsuiteBillData | null;
}

export interface BillPairsData {
  bills: BillPairData[];
  accounts: Record<string, { number: string | null; name: string }>;
  items: Record<string, { number: string; type: string | null; display_name: string | null }>;
}

/** How far the copies of NetSuite's bills and general ledger had come: each one's sync_state last_synced_at. */
export interface BillCopiesThrough {
  /** Every bill NetSuite changed before this is in the copy of its bills. */
  bills: string | null;
  /** When the copy of NetSuite's general ledger last finished a whole run. */
  ledger: string | null;
}

// ── What the check says ────────────────────────────────────────────────────

export type BillField = 'vendor' | 'number' | 'date' | 'company' | 'lines' | 'total';

export interface BillFieldCheck {
  field: BillField;
  label: string;
  /** What Books' copy says, in words; null when FleetSuite couldn't work it out. */
  fleetsuite: string | null;
  /** What NetSuite's bill says; null when its copies don't say yet. */
  netsuite: string | null;
  /** Null when it isn't compared. */
  same: boolean | null;
  /** Why it differs, or why it isn't compared. */
  why: string | null;
}

export interface BillLinePair {
  /** What the line is for: its account, or its item. */
  label: string;
  description: string | null;
  fleetsuite: { quantity: number | null; cents: number | null } | null;
  netsuite: { quantity: number | null; cents: number } | null;
  same: boolean | null;
  why: string | null;
}

export interface OwnBillCheck {
  netsuiteId: string;
  number: string;
  date: string;
  company: string;
  madeFrom: BillMadeFrom;
  /** 'a CNI vendor invoice', … */
  madeFromText: string;
  madeFromId: string | null;
  vendor: string | null;
  /** The purchase order a Parts Mail bill was made from: NetSuite's id for it, and its number. */
  poId: string | null;
  poNumber: string | null;
  status: OwnCheckStatus;
  /** One sentence for the list. */
  summary: string;
  /** How many of the things compared differ. */
  differing: number;
  /** What Books' copy comes to; null when FleetSuite couldn't work it out. */
  fleetsuiteCents: number | null;
  /** What NetSuite's bill comes to; null before its copy has it. */
  netsuiteCents: number | null;
  /** What the vendor's invoice said it came to, for a Parts Mail bill. */
  invoiceCents: number | null;
  fields: BillFieldCheck[];
  lines: BillLinePair[];
  /** What FleetSuite couldn't work out, in words. */
  unknowns: string[];
  /** How Books worked its copy out, a sentence each. */
  workedOut: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = (cents: number) => money.format(cents / 100);
const listed = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const DAY_MS = 86_400_000;
/** The ledger copy runs at most five minutes, so one that finished this long after a copy was made began after it. */
const LEDGER_RUN_MS = 10 * 60_000;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Whole cents, or null when there's no amount to read (centsOf reads nothing as $0). */
const cents = (v: string | null | undefined): number | null => (v === null || v === undefined || v === '' ? null : centsOf(v));
/** A quantity as people write it: 3, 1.5. */
const qty = (n: number) => String(Number(n.toFixed(4)));
const sameQuantity = (a: number, b: number) => Math.abs(a - b) < 0.00005;
/** A bill or vendor invoice number as two people might type it: letters and digits only, in capitals. */
const sameNumber = (a: string, b: string) => a.toUpperCase().replace(/[^A-Z0-9]/g, '') === b.toUpperCase().replace(/[^A-Z0-9]/g, '');

export const BILL_MADE_FROM_TEXT: Readonly<Record<BillMadeFrom, string>> = {
  vendor_invoice: 'a CNI vendor invoice',
  payout: 'an installer payout',
  parts_mail: 'a Parts Mail invoice',
};

const UNKNOWN_TEXT: Readonly<Record<BillUnknown, string>> = {
  lines: "what it billed (FleetSuite's copy of the purchase order didn't have the order)",
  prices: "the price of a line (FleetSuite's copy of the purchase order had none)",
};

const FIELD_WORDS: Readonly<Record<BillField, string>> = {
  vendor: 'the vendor',
  number: 'the number',
  date: 'the date',
  company: 'the company',
  lines: 'the lines',
  total: 'the total',
};

/** How far NetSuite's amount is from Books', in a sentence. */
const apart = (fleetsuite: number, netsuite: number) =>
  `NetSuite's is ${dollars(Math.abs(netsuite - fleetsuite))} ${netsuite > fleetsuite ? 'more' : 'less'}.`;

interface Side { quantity: number | null; cents: number | null; description: string | null }

/** Copied lists the check reads names from. */
export interface BillLists {
  accounts: Map<string, { number: string | null; name: string }>;
  items: Map<string, { number: string; type: string | null; displayName: string | null }>;
}

export function billLists(data: Pick<BillPairsData, 'accounts' | 'items'>): BillLists {
  return {
    accounts: new Map(Object.entries(data.accounts ?? {})),
    items: new Map(Object.entries(data.items ?? {}).map(([id, i]) => [id, { number: i.number, type: i.type, displayName: i.display_name }])),
  };
}

/**
 * NetSuite's bill lines that count, each at its own amount (the net one when it has none), turned so they add up to
 * the bill's total the right way round: NetSuite signs bill lines either way. Tax lines, and lines that never post (a
 * subtotal, say), are left out. Null when the copy couldn't read the lines. Pure.
 */
export function netsuiteBillLines(
  ns: Pick<NetsuiteBillData, 'lines'>,
  items: BillLists['items'],
): Array<{ key: string; item: string | null; account: string | null; quantity: number | null; cents: number }> | null {
  if (!ns.lines) return null;
  const kept = ns.lines
    .filter((l) => !l.tax && !(l.item && isLayoutItem(l.item, items.get(l.item)?.type)))
    .map((l) => ({ l, c: cents(l.own_amount ?? null) ?? cents(l.amount) }));
  if (kept.some(({ c }) => c === null)) return null;
  const sum = kept.reduce((n, { c }) => n + (c as number), 0);
  const turn = sum < 0 ? -1 : 1;
  return kept.map(({ l, c }) => ({
    key: l.item ? `item:${l.item}` : `account:${l.account ?? ''}`,
    item: l.item,
    account: l.item ? null : l.account,
    quantity: l.item ? (num(l.quantity) === null ? null : Math.abs(num(l.quantity)!)) : null,
    cents: (c as number) * turn || 0,
  }));
}

// ── One bill ───────────────────────────────────────────────────────────────

/** Books' own bill next to NetSuite's. */
export function checkOwnBill(pair: BillPairData, lists: BillLists, copies: BillCopiesThrough): OwnBillCheck {
  const own = pair.own;
  const unknowns = new Set(own.unknowns ?? []);
  const madeAt = Date.parse(own.made_at);
  const billsRanSince = !!copies.bills && Date.parse(copies.bills) > madeAt;
  const ledgerRanSince = !!copies.ledger && Date.parse(copies.ledger) > madeAt + LEDGER_RUN_MS;
  const gone = !!pair.netsuite && (pair.netsuite.gone || pair.netsuite.voided);
  // Not in the copy of NetSuite's bills, though it has run since: NetSuite no longer has it.
  const missing = !pair.netsuite && billsRanSince;
  const ns = pair.netsuite && !gone ? pair.netsuite : null;

  const number = own.number || pair.netsuite?.number || own.reference_no || `NetSuite ${own.netsuite_id}`;
  const vendor = own.vendor_name ?? pair.netsuite?.vendor_name ?? null;
  const accountName = (id: string | null) => {
    if (!id) return 'No account';
    const a = lists.accounts.get(id);
    return a ? [a.number, a.name].filter(Boolean).join(' ') : `NetSuite account ${id}`;
  };
  const itemName = (id: string | null, itemNumber: string | null) => itemNumber || (id ? lists.items.get(id)?.number : null) || (id ? `NetSuite item ${id}` : 'An item line');

  // Books' side, by what each line is for.
  const linesKnown = !unknowns.has('lines');
  const ownSides = new Map<string, Side & { label: string }>();
  for (const l of own.lines ?? []) {
    const key = l.item_id ? `item:${l.item_id}` : l.account_id ? `account:${l.account_id}` : `line:${l.line_no}`;
    const label = l.item_id || !l.account_id ? itemName(l.item_id, l.item_number) : accountName(l.account_id);
    const quantity = num(l.quantity);
    const c = cents(l.amount);
    const was = ownSides.get(key);
    if (was) {
      was.quantity = was.quantity === null || quantity === null ? null : was.quantity + quantity;
      was.cents = was.cents === null || c === null ? null : was.cents + c;
    } else {
      ownSides.set(key, { label, quantity, cents: c, description: l.description });
    }
  }
  const ownCents = linesKnown && !unknowns.has('prices') && [...ownSides.values()].every((s) => s.cents !== null)
    ? [...ownSides.values()].reduce((n, s) => n + (s.cents ?? 0), 0)
    : null;

  // NetSuite's side, likewise.
  const nsLines = ns ? netsuiteBillLines(ns, lists.items) : null;
  const nsSides = new Map<string, { quantity: number | null; cents: number; label: string }>();
  for (const l of nsLines ?? []) {
    const was = nsSides.get(l.key);
    const label = l.item ? itemName(l.item, null) : accountName(l.account);
    if (was) {
      was.quantity = was.quantity === null || l.quantity === null ? null : was.quantity + l.quantity;
      was.cents += l.cents;
    } else {
      nsSides.set(l.key, { quantity: l.quantity, cents: l.cents, label });
    }
  }
  const nsCents = ns ? cents(ns.total) : null;

  // Each line, Books' paired with NetSuite's.
  const lines: BillLinePair[] = [];
  const linesDiffer: string[] = [];
  const compareLines = !!ns && !!nsLines && linesKnown;
  for (const [key, o] of ownSides) {
    const n = nsSides.get(key);
    let same: boolean | null = null;
    let why: string | null = null;
    if (compareLines) {
      if (!n) {
        same = false;
        why = `Books' copy has ${o.label}${o.cents !== null ? ` for ${dollars(o.cents)}` : ''}, and NetSuite's bill has no line for it.`;
      } else {
        const quantitySame = o.quantity === null || n.quantity === null ? null : sameQuantity(o.quantity, n.quantity);
        const centsSame = o.cents === null ? null : o.cents === n.cents;
        const reasons: string[] = [];
        if (quantitySame === false) reasons.push(`Books' copy bills ${qty(o.quantity!)} of ${o.label}, and NetSuite's bill ${qty(n.quantity!)}.`);
        if (centsSame === false) reasons.push(`${o.label}: Books' copy says ${dollars(o.cents!)}, and NetSuite's bill ${dollars(n.cents)}. ${apart(o.cents!, n.cents)}`);
        if (o.cents === null) reasons.push(`FleetSuite had no price for ${o.label}, so its amount isn't compared.`);
        same = quantitySame === false || centsSame === false ? false : quantitySame === null && o.quantity !== null && n.quantity !== null ? null : centsSame;
        why = reasons.length ? reasons.join(' ') : null;
      }
      if (same === false) linesDiffer.push(why!);
    }
    lines.push({
      label: o.label,
      description: o.description,
      fleetsuite: { quantity: o.quantity, cents: o.cents },
      netsuite: n ? { quantity: n.quantity, cents: n.cents } : null,
      same,
      why,
    });
  }
  for (const [key, n] of nsSides) {
    if (ownSides.has(key)) continue;
    const why = `NetSuite's bill has ${n.label} for ${dollars(n.cents)}, and Books' copy has no line for it.`;
    if (compareLines) linesDiffer.push(why);
    lines.push({ label: n.label, description: null, fleetsuite: null, netsuite: { quantity: n.quantity, cents: n.cents }, same: compareLines ? false : null, why: compareLines ? why : null });
  }

  const fields: BillFieldCheck[] = [];

  // Who it's from.
  {
    const same = ns && own.vendor_id && ns.vendor_id ? own.vendor_id === ns.vendor_id : null;
    fields.push({
      field: 'vendor',
      label: 'Vendor',
      fleetsuite: own.vendor_name ?? (own.vendor_id ? `NetSuite vendor ${own.vendor_id}` : null),
      netsuite: ns ? ns.vendor_name ?? (ns.vendor_id ? `NetSuite vendor ${ns.vendor_id}` : null) : null,
      same,
      why: same === false ? `FleetSuite billed ${own.vendor_name ?? `vendor ${own.vendor_id}`}, and NetSuite's bill is from ${ns!.vendor_name ?? `vendor ${ns!.vendor_id}`}.` : null,
    });
  }

  // Its number.
  {
    const ours = own.number || own.reference_no;
    const same = ns && ours && ns.number ? sameNumber(ours, ns.number) : null;
    fields.push({
      field: 'number',
      label: 'Number',
      fleetsuite: ours,
      netsuite: ns ? ns.number : null,
      same,
      why: same === false ? `NetSuite's bill is numbered ${ns!.number} now. It was ${ours} when FleetSuite made it.` : null,
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
        ? `FleetSuite made it ${dayText(own.date)}, and NetSuite's bill is dated ${plural(Math.abs(days), 'day', 'days')} ${days > 0 ? 'later' : 'earlier'}.`
        : null,
    });
  }

  // The company the ledger books it to.
  const companies = ns?.companies ?? [];
  {
    const same = ns && companies.length ? companies.length === 1 && companies[0] === own.company : null;
    fields.push({
      field: 'company',
      label: 'Company',
      fleetsuite: own.company,
      netsuite: ns ? (companies.length ? listed(companies) : null) : null,
      same,
      why: same === false ? `FleetSuite made it for ${own.company}, and NetSuite books it to ${listed(companies)}.` : null,
    });
  }

  // Each line.
  {
    const same = !compareLines ? null : linesDiffer.length ? false : lines.some((l) => l.same === null) ? null : true;
    let why: string | null = null;
    if (!linesKnown) why = `FleetSuite didn't know ${UNKNOWN_TEXT.lines}.`;
    else if (ns && !nsLines) why = "The copy of NetSuite's bills couldn't read the bill's lines.";
    else if (linesDiffer.length) {
      const more = linesDiffer.length - 1;
      why = `${linesDiffer[0]}${more > 0 ? ` ${plural(more, 'other line differs', 'other lines differ')}.` : ''}`;
    }
    fields.push({
      field: 'lines',
      label: 'Lines',
      fleetsuite: linesKnown ? plural(ownSides.size, 'line', 'lines') : null,
      netsuite: nsLines ? plural(nsSides.size, 'line', 'lines') : null,
      same,
      why,
    });
  }

  // Its total.
  {
    const same = ownCents !== null && nsCents !== null && ns ? ownCents === nsCents : null;
    let why: string | null = null;
    if (!linesKnown) why = `FleetSuite didn't know ${UNKNOWN_TEXT.lines}.`;
    else if (unknowns.has('prices') || ownCents === null) why = `FleetSuite didn't know ${UNKNOWN_TEXT.prices}.`;
    else if (same === false) why = apart(ownCents, nsCents!);
    fields.push({
      field: 'total',
      label: 'Total',
      fleetsuite: ownCents !== null ? dollars(ownCents) : null,
      netsuite: ns && nsCents !== null ? dollars(nsCents) : null,
      same,
      why,
    });
  }

  const differing = fields.filter((f) => f.same === false).length;
  const unknownWords = [...unknowns].map((u) => UNKNOWN_TEXT[u]).filter(Boolean);

  let status: OwnCheckStatus;
  let summary: string;
  if (gone) {
    status = 'voided';
    summary = pair.netsuite!.voided ? "NetSuite's bill is voided." : "NetSuite's bill is gone from NetSuite.";
  } else if (missing) {
    status = 'voided';
    summary = "NetSuite's bill is gone from NetSuite: the copy of its bills, made since, doesn't have it.";
  } else if (!ns) {
    status = 'waiting';
    summary = "Waiting for NetSuite's bill: the copy of NetSuite's bills runs every two hours.";
  } else if (differing) {
    status = 'differs';
    const first = fields.find((f) => f.same === false)!;
    const what = first.why ?? `FleetSuite ${first.fleetsuite ?? 'nothing'}, NetSuite ${first.netsuite ?? 'nothing'}.`;
    // The total follows from the lines.
    const others = fields
      .filter((f) => f.same === false && f !== first && !(f.field === 'total' && fields.some((x) => x.field === 'lines' && x.same === false)))
      .map((f) => f.field);
    const too = listed(others.map((f) => FIELD_WORDS[f]));
    summary = `${first.label}: ${what}${others.length
      ? ` ${too.charAt(0).toUpperCase()}${too.slice(1)} ${others.length > 1 || others[0] === 'lines' ? 'differ' : 'differs'} too.`
      : ''}`;
  } else if (!companies.length && !ledgerRanSince) {
    status = 'waiting';
    summary = "Waiting for the copy of NetSuite's general ledger to say which company it's booked to.";
  } else if (unknownWords.length) {
    status = 'incomplete';
    summary = `Matches where it can be checked. FleetSuite didn't know ${listed(unknownWords)}.`;
  } else if (!companies.length) {
    status = 'incomplete';
    summary = "Matches where it can be checked. The copy of NetSuite's general ledger, made since, has no entry for it, so its company isn't checked.";
  } else {
    status = 'matches';
    summary = "Matches NetSuite's bill.";
  }

  const sent = own.lines?.[0];
  const workedOut: string[] = [];
  if (own.made_from === 'parts_mail') {
    workedOut.push(`Made by Create bill on a Parts Mail invoice on ${dayText(own.date)}, from ${own.po_number ?? 'its purchase order'}.`);
    workedOut.push(`NetSuite bills a purchase order at its own prices, so the lines are what FleetSuite's copy of ${own.po_number ?? 'the purchase order'} still had to bill, each at the PO's price, to the cent.`);
    const invoice = cents(own.invoice_total);
    if (invoice !== null) workedOut.push(`The vendor's invoice says ${dollars(invoice)}.`);
  } else {
    workedOut.push(`Made by Create Bill in NetSuite on ${BILL_MADE_FROM_TEXT[own.made_from]} on ${dayText(own.date)}.`);
    workedOut.push(`One line: ${sent ? `${dollars(cents(sent.amount) ?? 0)} to ${accountName(sent.account_id)}` : 'the amount FleetSuite sent'}, as FleetSuite sent it.`);
  }
  workedOut.push("Dated the day FleetSuite made it, in Central time: FleetSuite sends NetSuite no date for a bill, so NetSuite dates it that day.");

  return {
    netsuiteId: own.netsuite_id,
    number,
    date: own.date,
    company: own.company,
    madeFrom: own.made_from,
    madeFromText: BILL_MADE_FROM_TEXT[own.made_from] ?? own.made_from,
    madeFromId: own.made_from_id,
    vendor,
    poId: own.po_id,
    poNumber: own.po_number,
    status,
    summary,
    differing,
    fleetsuiteCents: ownCents,
    netsuiteCents: ns ? nsCents : null,
    invoiceCents: cents(own.invoice_total),
    fields,
    lines,
    unknowns: unknownWords,
    workedOut,
  };
}

export interface OwnBillsChecked {
  bills: OwnBillCheck[];
  counts: Record<OwnCheckStatus, number>;
}

/** Every own bill gl_own_bill_pairs returned, each checked. */
export function checkOwnBills(data: BillPairsData, copies: BillCopiesThrough): OwnBillsChecked {
  const lists = billLists(data);
  const bills = (data.bills ?? []).map((pair) => checkOwnBill(pair, lists, copies));
  const counts = Object.fromEntries(OWN_CHECK_STATUSES.map((s) => [s, 0])) as Record<OwnCheckStatus, number>;
  for (const b of bills) counts[b.status]++;
  return { bills, counts };
}
