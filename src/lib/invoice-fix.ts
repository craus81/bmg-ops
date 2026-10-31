/**
 * Fixing an invoice in FleetSuite after it's made, and sending the fix on to
 * NetSuite (Books part 39, migration 471, docs/books.md "Invoices fixed in
 * FleetSuite"; owner decisions 2026-10-31, thread "Replacing NetSuite with
 * FleetSuite": from January 1, 2027 the team works only in FleetSuite, and
 * FleetSuite sends each document on to NetSuite).
 *
 * From an invoice in Invoicing → Invoiced, Fix changes:
 *
 *   - its PO number, memo and VIN, whatever has been paid on it;
 *   - while nothing on it is paid or credited, its date (its due date moves
 *     with it, by its terms) and its lines: a line's quantity, price each and
 *     description, a discount's or markup's amount, a line taken off, and a
 *     line added, of any item a new invoice can bill. Once money is on it, a
 *     credit memo takes money off instead.
 *
 * Each line is changed by NetSuite's own key for it, as the sales order page
 * changes an order's lines (src/lib/sales-order-edit.ts), so a line billed
 * off a sales order stays billed off it, and lines that only lay the invoice
 * out stay as they are. NetSuite works the sales tax out again: a line kept
 * keeps its tax box, and a line added is taxed by FleetSuite's own rule
 * (src/lib/line-taxability.ts), as on a new invoice. Undoing a whole invoice
 * isn't a fix: that's a credit memo for all of it (Credit it all on its
 * credit memo screen).
 *
 * Pure, so the page and the route agree on what changes and what NetSuite is
 * sent.
 */

import { centsOf, formatCents, lineTax, parseInvoiceRecord, type InvoiceView } from '@/lib/credit-memo';
import { isPartTaxable } from '@/lib/line-taxability';
import { NOT_BILLABLE_TYPES, isDiscountType } from '@/lib/new-invoice';

export const PO_MAX = 45;
export const MEMO_MAX = 999;
export const DESCRIPTION_MAX = 4000;
export const REASON_MAX = 300;
export const MAX_QUANTITY = 1_000_000;
export const MAX_PRICE = 10_000_000;
/** Lines one fix can add. */
export const MAX_ADDED = 50;

/** Lines that only lay the invoice out. */
const LAYOUT_TYPES = new Set(['subtotal', 'subtotalitem', 'description', 'descriptionitem', 'group', 'groupitem', 'itemgroup', 'endgroup']);
/** Lines with an amount and no quantity. */
const AMOUNT_TYPES = new Set(['discount', 'discountitem', 'markup', 'markupitem']);

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

/**
 * 'quantity': a quantity at a price each; 'amount': a discount or markup, by its amount; 'kept': one FleetSuite only
 * takes off, never changes (a line that takes money off without being a discount, or names no item); 'layout': a
 * subtotal, description or item group, kept as it is.
 */
export type FixLineKind = 'quantity' | 'amount' | 'kept' | 'layout';

export interface FixLine {
  /** NetSuite's line key on the invoice's item sublist. */
  line: number;
  itemId: string | null;
  itemNumber: string;
  itemType: string | null;
  description: string;
  kind: FixLineKind;
  /** 0 on an amount or layout line. */
  quantity: number;
  /** The price each on a quantity line, null when NetSuite gave none; null on the others. */
  rate: number | null;
  /** What the line charges, in cents, a discount negative; 0 on a layout line. */
  cents: number;
  /** Taxed on this invoice: NetSuite's tax box, as the credit memo screen reads it. */
  taxable: boolean;
  /** The sales order line it bills, for an invoice off a sales order. */
  orderLine: number | null;
}

export interface FixInvoice extends Omit<InvoiceView, 'lines'> {
  dueDate: string | null;
  termsId: string | null;
  termsName: string | null;
  vin: string;
  /** The sales order it was billed off, if it was. */
  salesOrderId: string | null;
  /** When NetSuite last changed it, as NetSuite says. */
  lastModified: string | null;
  /** Every line, in order, the ones that only lay it out too. */
  lines: FixLine[];
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
const flag = (v: unknown): boolean | null => (v === true || v === 'T' ? true : v === false || v === 'F' ? false : null);

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

/**
 * The invoice from GET invoice/{id}?expandSubResources=true, as the Fix screen shows it: what the credit memo screen
 * reads (src/lib/credit-memo.ts), with its due date, terms, VIN, the sales order it was billed off, when NetSuite last
 * changed it, and every line, the ones that only lay it out and lines of nothing too, since a fix that takes a line off
 * sends NetSuite every line it keeps. `taxCodeRate` is as parseInvoiceRecord takes it.
 */
export function parseFixInvoice(rec: any, opts: { taxCodeRate?: number | null } = {}): FixInvoice {
  const { lines: _priced, ...header } = parseInvoiceRecord(rec, opts);
  const lines: FixLine[] = [];
  for (const it of (rec?.item?.items || []) as any[]) {
    if (it?.line == null || !Number.isFinite(Number(it.line))) continue;
    const type = itemTypeOf(it);
    const lower = (type || '').toLowerCase();
    const itemId = refId(it.item);
    const listedRate = numOrNull(it.rate);
    const quantity = Math.abs(num(it.quantity));
    const amount = it.amount != null && it.amount !== '' ? num(it.amount) : (listedRate ?? 0) * quantity;
    const cents = Math.round(amount * 100);
    // NetSuite's own lines (its subtotal is item -2) lay the invoice out, as the invoice rule says.
    const kind: FixLineKind = LAYOUT_TYPES.has(lower) || (itemId !== null && /^(-\d+|0+)$/.test(itemId)) ? 'layout'
      : AMOUNT_TYPES.has(lower) ? 'amount'
        : !itemId || cents < 0 || (listedRate !== null && listedRate < 0) ? 'kept'
          : 'quantity';
    const said = flag(it.isTaxable ?? it.istaxable);
    const orderLine = numOrNull(it.orderLine ?? it.orderline);
    lines.push({
      line: Number(it.line),
      itemId,
      itemNumber: itemNumberOf(it),
      itemType: type,
      description: String(it.description ?? '').trim(),
      kind,
      quantity: kind === 'quantity' || kind === 'kept' ? quantity : 0,
      rate: kind === 'quantity' ? listedRate : null,
      cents: kind === 'layout' ? 0 : cents,
      // What NetSuite taxed on this invoice; where it doesn't say, FleetSuite's rule, and nothing when it charged none.
      taxable: kind !== 'layout' && header.taxCents !== 0 && (said ?? isPartTaxable({ item_type: type })),
      orderLine: orderLine !== null && Number.isInteger(orderLine) ? orderLine : null,
    });
  }
  return {
    ...header,
    dueDate: dateOnly(rec?.dueDate ?? rec?.duedate),
    termsId: refId(rec?.terms),
    termsName: rec?.terms && typeof rec.terms === 'object' && rec.terms.refName ? String(rec.terms.refName) : null,
    vin: String(rec?.custbody_vin_number_ ?? '').trim().toUpperCase(),
    salesOrderId: refId(rec?.createdFrom),
    lastModified: rec?.lastModifiedDate ? String(rec.lastModifiedDate) : null,
    lines,
  };
}

// ── What can be fixed ──────────────────────────────────────────────────────

export interface FixAllows {
  /** Its PO number, memo and VIN. */
  header: boolean;
  /** Its date and lines. */
  lines: boolean;
  /** Why its date and lines can't change, when they can't; why nothing can, when it's voided. */
  why: string | null;
}

const ONLY = 'only its PO number, memo and VIN can be fixed';

/**
 * What a fix can change on the invoice. `creditedHere`: FleetSuite made a credit memo against it, which took its lines
 * as they were.
 */
export function fixAllows(inv: FixInvoice, opts: { creditedHere: boolean }): FixAllows {
  if (inv.voided) return { header: false, lines: false, why: `Invoice ${inv.number} is voided in NetSuite, so there's nothing to fix.` };
  const locked = (why: string): FixAllows => ({ header: true, lines: false, why });
  if (inv.owedCents === null) return locked(`NetSuite didn't say what's still owed on it, so ${ONLY}.`);
  if (inv.owedCents === 0 && inv.totalCents > 0) return locked(`It's paid, so ${ONLY}. To take money off it, make a credit memo.`);
  if (inv.owedCents !== inv.totalCents) return locked(`Part of it is paid or credited, so ${ONLY}. To take money off it, make a credit memo.`);
  if (opts.creditedHere) return locked(`FleetSuite made a credit memo against it, so ${ONLY}. To take more off it, make another credit memo.`);
  return { header: true, lines: true, why: null };
}

// ── The fix ────────────────────────────────────────────────────────────────

export interface FixHeaderEdit {
  date?: string;
  poNumber?: string;
  memo?: string;
  vin?: string;
}

/** What's typed against one of the invoice's lines. A discount's or markup's amount is typed as a positive number. */
export interface FixLineEdit {
  line: number;
  quantity?: number;
  price?: number;
  amount?: number;
  description?: string;
  remove?: boolean;
}

/** A line added: a discount's price is the amount it takes off, typed as a positive number. */
export interface FixNewLine {
  itemId: string;
  quantity: number;
  price: number;
  description?: string;
}

export interface InvoiceFixEdit {
  reason: string;
  header?: FixHeaderEdit;
  lines?: FixLineEdit[];
  add?: FixNewLine[];
}

/** An item a line can be added with, as the parts catalog has it (the new invoice search). */
export interface FixItem {
  itemId: string;
  itemNumber: string;
  itemType: string | null;
  taxableOverride: boolean | null;
  description: string;
}

export interface FixFacts {
  allows: FixAllows;
  /** The items of the lines added, by NetSuite id. */
  items: Map<string, FixItem>;
  /** Why lines added go untaxed, when they do: the customer is tax-exempt in FleetSuite, or the work is at Social Circle. */
  untaxed: 'exempt_customer' | 'georgia' | null;
  /** The days the invoice's terms give: 0 with no terms; null when FleetSuite can't tell them. */
  termsDays: number | null;
}

/** A line of the invoice as the fix leaves it. */
export interface FixedLine {
  /** NetSuite's key; null on a line added. */
  line: number | null;
  itemId: string | null;
  itemNumber: string;
  itemType: string | null;
  description: string;
  kind: FixLineKind;
  /** Null on an amount or layout line. */
  quantity: number | null;
  rate: number | null;
  cents: number;
  taxable: boolean;
  orderLine: number | null;
  state: 'as_was' | 'changed' | 'added';
}

export interface FixedInvoice {
  date: string | null;
  dueDate: string | null;
  poNumber: string;
  memo: string;
  vin: string;
  /** Every line it keeps, in order, then the ones added. */
  lines: FixedLine[];
  subtotalCents: number;
  /**
   * NetSuite's tax with what the fix changes taxed at the invoice's rate: NetSuite works the real tax out. Null when
   * FleetSuite can't tell the rate and a taxed line changes.
   */
  taxCents: number | null;
  totalCents: number | null;
}

export interface FixPlan {
  /** Plain-English reasons it can't be sent yet, one per problem. */
  problems: string[];
  /** What changes, a sentence each, as the screen lists them and the fix's history keeps them. */
  changes: string[];
  /** What else the person should know, a sentence each. */
  notes: string[];
  /** A line is taken off: NetSuite's lines become exactly the ones sent (?replace=item). */
  replace: boolean;
  /** The PATCH NetSuite is sent. */
  body: Record<string, unknown>;
  fixed: FixedInvoice;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const places = (n: number, p: number) => Math.abs(n * 10 ** p - Math.round(n * 10 ** p)) < 1e-6;
const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
export const quantityText = (n: number) => String(Number(n.toFixed(4)));
/** A price each, to the cent when it's whole cents and otherwise to four places. */
export const priceText = (n: number) => (places(n, 2) ? formatCents(Math.round(n * 100)) : `$${Number(n.toFixed(4))}`);

const realDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** 'YYYY-MM-DD' plus whole days. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 'Jan 15, 2027' from '2027-01-15'; '(none)' for none. */
export function dayText(ymd: string | null): string {
  if (!ymd) return '(none)';
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

const asWas = (l: FixLine): FixedLine => ({
  line: l.line, itemId: l.itemId, itemNumber: l.itemNumber, itemType: l.itemType, description: l.description, kind: l.kind,
  quantity: l.kind === 'quantity' || l.kind === 'kept' ? l.quantity : null, rate: l.rate, cents: l.cents, taxable: l.taxable,
  orderLine: l.orderLine, state: 'as_was',
});

/**
 * The fix from what the person changed: what NetSuite is sent, what changes in words, the invoice as it'll be, and
 * what stops it. A box left as it was changes nothing, so nothing that didn't change goes to NetSuite.
 */
export function planInvoiceFix(inv: FixInvoice, edit: InvoiceFixEdit, facts: FixFacts): FixPlan {
  const problems: string[] = [];
  const changes: string[] = [];
  const notes: string[] = [];
  const body: Record<string, unknown> = {};
  const fixed: FixedInvoice = {
    date: inv.date, dueDate: inv.dueDate, poNumber: inv.poNumber, memo: inv.memo, vin: inv.vin,
    lines: inv.lines.map(asWas), subtotalCents: inv.subtotalCents, taxCents: inv.taxCents, totalCents: inv.totalCents,
  };
  if (!facts.allows.header) {
    return { problems: [facts.allows.why || `Invoice ${inv.number} can't be fixed.`], changes, notes, replace: false, body, fixed };
  }

  let toldLocked = false;
  const locked = () => {
    if (!toldLocked) problems.push(facts.allows.why || `Invoice ${inv.number}'s date and lines can't be fixed.`);
    toldLocked = true;
  };

  // ── The header ──
  const h = edit.header ?? {};
  if (h.date !== undefined && h.date.trim() !== (inv.date ?? '')) {
    const v = h.date.trim();
    if (!realDate(v)) problems.push('Pick the date.');
    else if (!facts.allows.lines) locked();
    else {
      body.tranDate = v;
      fixed.date = v;
      changes.push(`Date ${dayText(inv.date)} → ${dayText(v)}`);
      if (facts.termsDays === null) {
        notes.push(`NetSuite keeps its due date, ${dayText(inv.dueDate)}: FleetSuite can't tell the invoice's terms.`);
      } else {
        const due = addDays(v, facts.termsDays);
        fixed.dueDate = due;
        if (due !== inv.dueDate) {
          body.dueDate = due;
          changes.push(`Due ${dayText(inv.dueDate)} → ${dayText(due)}`);
        }
      }
    }
  }
  if (h.poNumber !== undefined && h.poNumber.trim() !== inv.poNumber) {
    const v = h.poNumber.trim();
    if (v.length > PO_MAX) problems.push(`The PO number takes ${PO_MAX} characters at most.`);
    else {
      body.otherRefNum = v;
      fixed.poNumber = v;
      changes.push(`PO number ${inv.poNumber || '(none)'} → ${v || '(none)'}`);
    }
  }
  if (h.memo !== undefined && h.memo.trim() !== inv.memo) {
    const v = h.memo.trim();
    if (v.length > MEMO_MAX) problems.push(`The memo takes ${MEMO_MAX} characters at most.`);
    else {
      body.memo = v;
      fixed.memo = v;
      changes.push(v ? (inv.memo ? 'Memo changed' : 'Memo added') : 'Memo taken off');
    }
  }
  if (h.vin !== undefined && h.vin.trim().toUpperCase() !== inv.vin) {
    const v = h.vin.trim().toUpperCase();
    if (v && !VIN_RE.test(v)) problems.push('A VIN is 17 letters and numbers, with no I, O or Q.');
    else {
      body.custbody_vin_number_ = v || null;
      fixed.vin = v;
      changes.push(`VIN ${inv.vin || '(none)'} → ${v || '(none)'}`);
    }
  }

  // ── Its lines ──
  const byLine = new Map(inv.lines.map((l) => [l.line, l]));
  const edits = new Map<number, FixLineEdit>();
  for (const e of edit.lines ?? []) {
    const l = byLine.get(e.line);
    if (!l) { problems.push(`Line ${e.line} isn't on invoice ${inv.number} any more. Reload and try again.`); continue; }
    if (edits.has(e.line)) { problems.push(`${l.itemNumber || `Line ${l.line}`} was sent twice.`); continue; }
    edits.set(e.line, e);
  }

  const lines: FixedLine[] = [];
  const patches = new Map<number, Record<string, unknown>>();
  const removed = new Set<number>();
  // Each line the fix touches: what it charged and was taxed before, and after (0 when taken off).
  const moved: { before: number; after: number; taxedBefore: boolean; taxedAfter: boolean }[] = [];
  for (const l of inv.lines) {
    const e = edits.get(l.line);
    const name = l.itemNumber || `Line ${l.line}`;
    // Only what a line's kind takes is read: a quantity and price on a quantity line, an amount on a discount or
    // markup, a description on either. A line kept as it is can only be taken off.
    const quantityChanges = l.kind === 'quantity' && e?.quantity !== undefined && !same(e.quantity, l.quantity);
    const priceChanges = l.kind === 'quantity' && e?.price !== undefined && (l.rate === null || !same(e.price, l.rate));
    const amountChanges = l.kind === 'amount' && e?.amount !== undefined && !same(e.amount, Math.abs(l.cents) / 100);
    const descriptionChanges = (l.kind === 'quantity' || l.kind === 'amount') && e?.description !== undefined
      && e.description.trim() !== l.description;
    if (!e || !(e.remove || quantityChanges || priceChanges || amountChanges || descriptionChanges)) {
      lines.push(asWas(l));
      continue;
    }
    if (!facts.allows.lines) { locked(); lines.push(asWas(l)); continue; }
    if (e.remove) {
      if (l.kind === 'layout') {
        problems.push(`${name} only lays the invoice out, so it stays as it is.`);
        lines.push(asWas(l));
        continue;
      }
      removed.add(l.line);
      moved.push({ before: l.cents, after: 0, taxedBefore: l.taxable, taxedAfter: false });
      changes.push(l.kind === 'quantity' && l.rate !== null
        ? `Took off ${name} (${quantityText(l.quantity)} × ${priceText(l.rate)})`
        : `Took off ${name} (${formatCents(l.cents)})`);
      continue;
    }

    const patch: Record<string, unknown> = {};
    let { quantity, rate, cents, description } = l;
    if (quantityChanges) {
      const q = e.quantity!;
      if (!Number.isFinite(q)) problems.push(`${name}: enter the quantity.`);
      else if (q <= 0) problems.push(`${name}: the quantity has to be more than 0. To drop the line, take it off.`);
      else if (q > MAX_QUANTITY) problems.push(`${name}: the quantity can be 1,000,000 at most.`);
      else if (!places(q, 4)) problems.push(`${name}: the quantity takes 4 places at most.`);
      else {
        quantity = round4(q);
        patch.quantity = quantity;
        changes.push(`${name} quantity ${quantityText(l.quantity)} → ${quantityText(quantity)}`);
      }
    }
    if (priceChanges) {
      const p = e.price!;
      if (!Number.isFinite(p)) problems.push(`${name}: enter the price each.`);
      else if (p < 0) problems.push(`${name}: the price can't be less than $0.`);
      else if (p > MAX_PRICE) problems.push(`${name}: the price can be $10,000,000 at most.`);
      else if (!places(p, 4)) problems.push(`${name}: the price takes 4 places at most.`);
      else {
        rate = round4(p);
        // The Custom price level, as invoices FleetSuite makes have it, so NetSuite keeps the price.
        patch.price = { id: '-1' };
        patch.rate = rate;
        changes.push(`${name} price ${l.rate === null ? '(none)' : priceText(l.rate)} → ${priceText(rate)}`);
      }
    }
    if ('quantity' in patch || 'rate' in patch) cents = centsOf(quantity * (rate ?? 0));
    if (amountChanges) {
      const a = e.amount!;
      if (!(Number.isFinite(a) && a > 0)) problems.push(`${name}: enter an amount above $0. To drop it, take it off.`);
      else if (a > MAX_PRICE) problems.push(`${name}: the amount can be $10,000,000 at most.`);
      else if (!places(a, 2)) problems.push(`${name}: the amount goes to the cent.`);
      else {
        cents = (l.cents < 0 ? -1 : 1) * Math.round(a * 100);
        // A discount or markup is its rate alone, with no quantity or price level.
        patch.rate = cents / 100;
        changes.push(`${name} ${formatCents(Math.abs(l.cents))} → ${formatCents(Math.abs(cents))}`);
      }
    }
    if (descriptionChanges) {
      const v = e.description!.trim();
      if (v.length > DESCRIPTION_MAX) problems.push(`${name}: the description takes 4,000 characters at most.`);
      else {
        description = v;
        patch.description = v;
        changes.push(`${name} description changed`);
      }
    }
    if (Object.keys(patch).length === 0) { lines.push(asWas(l)); continue; }
    patches.set(l.line, patch);
    moved.push({ before: l.cents, after: cents, taxedBefore: l.taxable, taxedAfter: l.taxable });
    lines.push({ ...asWas(l), quantity: l.kind === 'quantity' ? quantity : null, rate, cents, description, state: 'changed' });
  }

  // ── Lines added ──
  const added: Record<string, unknown>[] = [];
  const adds = edit.add ?? [];
  if (adds.length > 0 && !facts.allows.lines) locked();
  else if (adds.length > MAX_ADDED) problems.push(`One fix adds ${MAX_ADDED} lines at most.`);
  else {
    adds.forEach((n, i) => {
      const item = facts.items.get(n.itemId);
      const name = item?.itemNumber || `New line ${i + 1}`;
      if (!item) { problems.push(`${name}: that item isn't in the parts list. Take the line off and pick the item again.`); return; }
      if (item.itemType && NOT_BILLABLE_TYPES.has(item.itemType)) { problems.push(`${name} is a ${item.itemType} item and can't be billed.`); return; }
      const discount = isDiscountType(item.itemType);
      if (!discount) {
        if (!(Number.isFinite(n.quantity) && n.quantity > 0)) { problems.push(`${name}: enter a quantity above 0.`); return; }
        if (n.quantity > MAX_QUANTITY) { problems.push(`${name}: the quantity can be 1,000,000 at most.`); return; }
        if (!places(n.quantity, 4)) { problems.push(`${name}: the quantity takes 4 places at most.`); return; }
      }
      if (!(Number.isFinite(n.price) && n.price > 0)) {
        problems.push(discount ? `${name}: enter how much the discount takes off.` : `${name}: enter a price above $0.`);
        return;
      }
      if (n.price > MAX_PRICE) { problems.push(`${name}: the price can be $10,000,000 at most.`); return; }
      if (!places(n.price, discount ? 2 : 4)) {
        problems.push(discount ? `${name}: the amount goes to the cent.` : `${name}: the price takes 4 places at most.`);
        return;
      }
      const description = (n.description ?? '').trim() || item.description.trim();
      if (description.length > DESCRIPTION_MAX) { problems.push(`${name}: the description takes 4,000 characters at most.`); return; }

      const quantity = discount ? null : round4(n.quantity);
      const rate = discount ? null : round4(n.price);
      const cents = discount ? -Math.round(n.price * 100) : centsOf(quantity! * rate!);
      // A discount is taxed as the line above it, as on a new invoice; nothing is for a tax-exempt customer or Georgia.
      const above = [...lines].reverse().find((x) => x.kind !== 'layout');
      const taxable = facts.untaxed !== null ? false
        : discount ? (above ? above.taxable : true)
          : isPartTaxable({ item_type: item.itemType, taxable_override: item.taxableOverride });
      added.push(discount
        ? { item: { id: item.itemId }, rate: cents / 100, ...(description ? { description } : {}), isTaxable: taxable }
        : { item: { id: item.itemId }, quantity, price: { id: '-1' }, rate, ...(description ? { description } : {}), isTaxable: taxable });
      moved.push({ before: 0, after: cents, taxedBefore: false, taxedAfter: taxable });
      lines.push({
        line: null, itemId: item.itemId, itemNumber: item.itemNumber, itemType: item.itemType, description,
        kind: discount ? 'amount' : 'quantity', quantity, rate, cents, taxable, orderLine: null, state: 'added',
      });
      changes.push(discount ? `Added ${name} (${formatCents(-cents)} off)` : `Added ${name} (${quantityText(quantity!)} × ${priceText(rate!)})`);
    });
  }

  const linesChange = moved.length > 0;
  if (linesChange) {
    if (!lines.some((l) => l.kind !== 'layout')) {
      problems.push(`An invoice needs a line. To undo all of invoice ${inv.number}, make a credit memo for all of it.`);
    }
    const subtotalCents = inv.subtotalCents + moved.reduce((s, m) => s + m.after - m.before, 0);
    if (subtotalCents <= 0) {
      problems.push(`Invoice ${inv.number} has to come to more than $0. To undo all of it, make a credit memo for all of it.`);
    }
    const taxMoves = moved.filter((m) => m.taxedBefore || m.taxedAfter);
    // An invoice that charged no tax says nothing of the rate a line added and taxed would be charged at.
    const rate = inv.taxRateFrom === 'untaxed' && taxMoves.some((m) => m.taxedAfter) ? null : inv.taxRate;
    const taxCents = taxMoves.length === 0 ? inv.taxCents
      : rate === null ? null
        : inv.taxCents + taxMoves.reduce((s, m) => s + (m.taxedAfter ? lineTax(m.after, rate) : 0) - (m.taxedBefore ? lineTax(m.before, rate) : 0), 0);
    fixed.subtotalCents = subtotalCents;
    fixed.taxCents = taxCents;
    fixed.totalCents = taxCents === null ? null : inv.totalCents + (subtotalCents - inv.subtotalCents) + (taxCents - inv.taxCents);
    if (taxMoves.length > 0) {
      notes.push(rate === null
        ? "NetSuite works the sales tax out again: FleetSuite can't tell this invoice's rate, so it can't say what it'll be."
        : 'NetSuite works the sales tax out again, so it can differ from this by a cent or so.');
    }
  }
  fixed.lines = lines;

  const reason = edit.reason.trim();
  if (!reason) problems.push("Say why it's being fixed.");
  else if (reason.length > REASON_MAX) problems.push(`Why it's being fixed takes ${REASON_MAX} characters at most.`);
  if (changes.length === 0 && problems.length === 0) problems.push('Nothing has changed yet.');

  const replace = removed.size > 0;
  if (replace) {
    // NetSuite's lines become exactly these: every line kept, by its key and with its change, then the ones added.
    body.item = {
      items: [
        ...inv.lines.filter((l) => !removed.has(l.line)).map((l) => ({ line: l.line, ...(patches.get(l.line) ?? {}) })),
        ...added,
      ],
    };
  } else if (patches.size > 0 || added.length > 0) {
    body.item = { items: [...[...patches].map(([line, patch]) => ({ line, ...patch })), ...added] };
  }
  return { problems, changes, notes, replace, body, fixed };
}

/**
 * What a fix is planned against, as one string: when NetSuite last changed the invoice, and everything the fix reads
 * of it. The route sends it to the page and the page back, and anything different means someone changed the invoice
 * while the page was open.
 */
export function invoiceFacts(inv: FixInvoice): string {
  return JSON.stringify([
    inv.lastModified, inv.date, inv.dueDate, inv.poNumber, inv.memo, inv.vin, inv.status, inv.voided,
    inv.subtotalCents, inv.taxCents, inv.totalCents, inv.owedCents,
    inv.lines.map((l) => [l.line, l.itemId, l.kind, l.quantity, l.rate, l.cents, l.taxable, l.description]),
  ]);
}

/**
 * The lines of a fixed invoice that charge something, as Books' own copy takes them (saveFixedOwnInvoice). A line
 * that only lays the invoice out charges nothing, and a discount or markup has no quantity or price each.
 */
export function ownCopyLines(fixed: FixedInvoice) {
  return fixed.lines
    .filter((l) => l.cents !== 0)
    .map((l) => ({
      itemId: l.itemId,
      itemNumber: l.itemNumber || null,
      description: l.description || null,
      quantity: l.quantity,
      rate: l.rate,
      cents: l.cents,
      orderLine: l.orderLine,
    }));
}
