/**
 * Fixing a bill in FleetSuite after it's made, and sending the fix on to
 * NetSuite (Books part 40, migration 472, docs/books.md "Bills fixed in
 * FleetSuite"; owner decisions 2026-10-31, thread "Replacing NetSuite with
 * FleetSuite": from January 1, 2027 the team works only in FleetSuite, and
 * FleetSuite sends each document on to NetSuite).
 *
 * From a bill (More → Purchasing → Fix a Bill, or Fix on Books → Own bills),
 * Fix changes:
 *
 *   - its number (the vendor's own, NetSuite's Reference No.), memo and due
 *     date, whatever has been paid on it;
 *   - while nothing on it is paid or credited, its date (its due date moves
 *     with it, by its terms) and its lines: an expense line's account, amount
 *     and memo, a part's quantity, rate and description, a line taken off,
 *     and an expense line added. Once money is on it, a vendor credit takes
 *     money off instead.
 *
 * Each line is changed by NetSuite's own key for it on its list (expenses or
 * items), as an invoice's are (src/lib/invoice-fix.ts), so a part billed off
 * a purchase order stays billed off it and NetSuite moves the order's billed
 * quantity with it. Bills carry no sales tax. Undoing a whole bill isn't a
 * fix: that's a vendor credit for all of it (Credit all of it, which fills
 * the vendor credit screen with what the bill posted, the other way round,
 * applied to the bill: src/lib/vendor-credit.ts creditAllOfBill).
 *
 * Pure, so the page and the route agree on what changes and what NetSuite is
 * sent.
 */

import { centsOf, formatCents } from '@/lib/credit-memo';
import { addDays, dayText, priceText, quantityText } from '@/lib/invoice-fix';

export { dayText, formatCents, priceText, quantityText };

/** NetSuite takes a bill number (its Reference No.) this long at most, as Snap a bill sends one. */
export const BILL_NUMBER_MAX = 40;
export const MEMO_MAX = 999;
export const DESCRIPTION_MAX = 4000;
export const REASON_MAX = 300;
export const MAX_QUANTITY = 1_000_000;
export const MAX_AMOUNT = 10_000_000;
/** Lines one fix can add. */
export const MAX_ADDED = 50;

/** Item lines that only lay the bill out. */
const LAYOUT_TYPES = new Set(['subtotal', 'subtotalitem', 'description', 'descriptionitem', 'group', 'groupitem', 'itemgroup', 'endgroup']);
/** Item lines with an amount and no quantity. */
const AMOUNT_TYPES = new Set(['discount', 'discountitem', 'markup', 'markupitem']);

/** The bill's two lists of lines, as NetSuite keys them. */
export type BillSublist = 'expense' | 'item';
export const SUBLISTS: readonly BillSublist[] = ['expense', 'item'];

/**
 * 'expense': an amount to an account; 'quantity': a part, a quantity at a rate; 'kept': one FleetSuite only takes off,
 * never changes (a line that takes money off, a discount, or one that names no item or account); 'layout': a subtotal,
 * description or item group, kept as it is.
 */
export type BillLineKind = 'expense' | 'quantity' | 'kept' | 'layout';

export interface BillFixLine {
  list: BillSublist;
  /** NetSuite's key for the line on its list. */
  line: number;
  /** An expense line's account. */
  accountId: string | null;
  accountName: string;
  itemId: string | null;
  itemNumber: string;
  itemType: string | null;
  /** A part's description; an expense line's memo. */
  description: string;
  kind: BillLineKind;
  /** 0 on an expense or layout line. */
  quantity: number;
  /** A part's rate, null when NetSuite gave none; null on the others. */
  rate: number | null;
  /** What the line comes to, in cents; 0 on a layout line. */
  cents: number;
  /** The purchase order a part was billed off, and the order's line (NetSuite's sequence number for it). */
  orderId: string | null;
  orderLine: number | null;
}

/** What SuiteQL says of the bill's money (getVendorBillAmounts): REST doesn't say what's still owed. */
export interface BillAmounts {
  totalCents: number;
  /** What's still owed: the total less what's paid or credited. */
  owedCents: number;
  /** NetSuite's status, in words. */
  status: string | null;
  voided: boolean;
}

export interface FixBill {
  id: string;
  /** The vendor's number for it: NetSuite's Reference No. */
  number: string;
  vendorId: string | null;
  vendorName: string;
  subsidiaryId: string | null;
  locationId: string | null;
  date: string | null;
  dueDate: string | null;
  termsId: string | null;
  termsName: string | null;
  memo: string;
  status: string | null;
  voided: boolean;
  /** The purchase order it was billed off, if it was: NetSuite's id and number. */
  poId: string | null;
  poNumber: string | null;
  /** When NetSuite last changed it, as NetSuite says. */
  lastModified: string | null;
  /** NetSuite's total; null when it gave none FleetSuite can read. */
  totalCents: number | null;
  /** What's still owed; null when NetSuite couldn't be asked. */
  owedCents: number | null;
  /** Every line, expenses first then items, each in NetSuite's order. */
  lines: BillFixLine[];
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
const centsOfAmount = (v: unknown, fallback: number) => Math.round((v != null && v !== '' ? num(v) : fallback) * 100);

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

/** "Purchase Order #PO1234" → "PO1234". */
const orderNumberOf = (v: any): string | null => {
  const name = v && typeof v === 'object' && v.refName ? String(v.refName).trim() : '';
  if (!name) return null;
  return name.match(/#\s*(\S+)\s*$/)?.[1] ?? name;
};

/**
 * The bill from GET vendorBill/{id}?expandSubResources=true, with what SuiteQL says of its money, as the Fix screen
 * shows it: every line of both lists, the ones that only lay it out too, since a fix that takes a line off sends
 * NetSuite every line it keeps on that list.
 */
export function parseFixBill(rec: any, amounts: BillAmounts | null): FixBill {
  const lines: BillFixLine[] = [];
  for (const it of (rec?.expense?.items || []) as any[]) {
    if (it?.line == null || !Number.isFinite(Number(it.line))) continue;
    const accountId = refId(it.account);
    const cents = centsOfAmount(it.amount, 0);
    lines.push({
      list: 'expense',
      line: Number(it.line),
      accountId,
      accountName: it.account && typeof it.account === 'object' && it.account.refName ? String(it.account.refName) : '',
      itemId: null,
      itemNumber: '',
      itemType: null,
      description: String(it.memo ?? '').trim(),
      kind: accountId && cents >= 0 ? 'expense' : 'kept',
      quantity: 0,
      rate: null,
      cents,
      orderId: null,
      orderLine: null,
    });
  }
  for (const it of (rec?.item?.items || []) as any[]) {
    if (it?.line == null || !Number.isFinite(Number(it.line))) continue;
    const type = itemTypeOf(it);
    const lower = (type || '').toLowerCase();
    const itemId = refId(it.item);
    const listedRate = numOrNull(it.rate);
    const quantity = Math.abs(num(it.quantity));
    const cents = centsOfAmount(it.amount, (listedRate ?? 0) * quantity);
    // NetSuite's own lines (its subtotal is item -2) lay the bill out.
    const kind: BillLineKind = LAYOUT_TYPES.has(lower) || (itemId !== null && /^(-\d+|0+)$/.test(itemId)) ? 'layout'
      : AMOUNT_TYPES.has(lower) || !itemId || cents < 0 || (listedRate !== null && listedRate < 0) ? 'kept'
        : 'quantity';
    const orderLine = numOrNull(it.orderLine ?? it.orderline);
    lines.push({
      list: 'item',
      line: Number(it.line),
      accountId: null,
      accountName: '',
      itemId,
      itemNumber: itemNumberOf(it),
      itemType: type,
      description: String(it.description ?? '').trim(),
      kind,
      quantity: kind === 'quantity' || kind === 'kept' ? quantity : 0,
      rate: kind === 'quantity' ? listedRate : null,
      cents: kind === 'layout' ? 0 : cents,
      orderId: refId(it.orderDoc ?? it.orderdoc),
      orderLine: orderLine !== null && Number.isInteger(orderLine) ? orderLine : null,
    });
  }
  const listedTotal = numOrNull(rec?.userTotal ?? rec?.total);
  const statusLabel = ref(rec?.status);
  return {
    id: String(rec?.id ?? ''),
    number: String(rec?.tranId ?? '').trim(),
    vendorId: refId(rec?.entity),
    vendorName: rec?.entity && typeof rec.entity === 'object' && rec.entity.refName ? String(rec.entity.refName) : '',
    subsidiaryId: refId(rec?.subsidiary),
    locationId: refId(rec?.location),
    date: dateOnly(rec?.tranDate),
    dueDate: dateOnly(rec?.dueDate),
    termsId: refId(rec?.terms),
    termsName: rec?.terms && typeof rec.terms === 'object' && rec.terms.refName ? String(rec.terms.refName) : null,
    memo: String(rec?.memo ?? '').trim(),
    status: amounts?.status ?? statusLabel,
    voided: !!amounts?.voided || /\bvoid/i.test(statusLabel ?? ''),
    poId: refId(rec?.createdFrom),
    poNumber: orderNumberOf(rec?.createdFrom),
    lastModified: rec?.lastModifiedDate ? String(rec.lastModifiedDate) : null,
    totalCents: amounts ? amounts.totalCents : listedTotal === null ? null : Math.round(Math.abs(listedTotal) * 100),
    owedCents: amounts ? amounts.owedCents : null,
    lines,
  };
}

/** What the lines come to. */
export const linesCents = (lines: Array<{ cents: number }>) => lines.reduce((s, l) => s + l.cents, 0);

/** "Bill INV-1234", or NetSuite's id when it has no number. */
export const billName = (bill: Pick<FixBill, 'id' | 'number'>) => (bill.number ? `bill ${bill.number}` : `NetSuite bill ${bill.id}`);

// ── What can be fixed ──────────────────────────────────────────────────────

export interface BillFixAllows {
  /** Its number, memo and due date. */
  header: boolean;
  /** Its date and lines. */
  lines: boolean;
  /** Why its date and lines can't change, when they can't; why nothing can, when it's voided. */
  why: string | null;
}

const ONLY = 'only its number, memo and due date can be fixed';

/**
 * What a fix can change on the bill. `creditedHere`: FleetSuite made, or is making, a vendor credit applied to it,
 * which NetSuite may not show yet.
 */
export function billFixAllows(bill: FixBill, opts: { creditedHere: boolean }): BillFixAllows {
  const name = billName(bill);
  if (bill.voided) return { header: false, lines: false, why: `${cap(name)} is voided in NetSuite, so there's nothing to fix.` };
  const locked = (why: string): BillFixAllows => ({ header: true, lines: false, why });
  if (bill.owedCents === null) return locked(`NetSuite didn't say what's still owed on it, so ${ONLY}.`);
  if (bill.totalCents === null) return locked(`NetSuite didn't say what it comes to, so ${ONLY}.`);
  if (bill.owedCents === 0 && bill.totalCents > 0) return locked(`It's paid, so ${ONLY}. To take money off it, make a vendor credit.`);
  if (bill.owedCents !== bill.totalCents) return locked(`Part of it is paid or credited, so ${ONLY}. To take money off it, make a vendor credit.`);
  if (opts.creditedHere) return locked(`FleetSuite made a vendor credit against it, so ${ONLY}. To take more off it, make another vendor credit.`);
  const sum = linesCents(bill.lines);
  if (sum !== bill.totalCents) {
    return locked(`Its lines come to ${formatCents(sum)}, not the ${formatCents(bill.totalCents)} NetSuite says, so ${ONLY}.`);
  }
  return { header: true, lines: true, why: null };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── The fix ────────────────────────────────────────────────────────────────

export interface BillHeaderEdit {
  number?: string;
  date?: string;
  dueDate?: string;
  memo?: string;
}

/** What's typed against one of the bill's lines: an expense line's account, amount and memo; a part's quantity, rate and description. */
export interface BillLineEdit {
  list: BillSublist;
  line: number;
  accountId?: string;
  amount?: number;
  quantity?: number;
  rate?: number;
  /** A part's description; an expense line's memo. */
  description?: string;
  remove?: boolean;
}

/** An expense line added. */
export interface BillNewLine {
  accountId: string;
  amount: number;
  memo?: string;
}

export interface BillFixEdit {
  reason: string;
  header?: BillHeaderEdit;
  lines?: BillLineEdit[];
  add?: BillNewLine[];
}

export interface BillFixFacts {
  allows: BillFixAllows;
  /** The accounts an expense line of the bill's company can go to, by NetSuite id. */
  accounts: Map<string, { id: string; name: string }>;
  /** The days the bill's terms give: 0 with no terms; null when FleetSuite can't tell them. */
  termsDays: number | null;
  /** The vendor's other bill already numbered as typed, when the number changes to one NetSuite has; the page can't tell. */
  numberTaken?: string | null;
}

/** A line of the bill as the fix leaves it. */
export interface FixedBillLine {
  list: BillSublist;
  /** NetSuite's key; null on a line added. */
  line: number | null;
  accountId: string | null;
  accountName: string;
  itemId: string | null;
  itemNumber: string;
  itemType: string | null;
  description: string;
  kind: BillLineKind;
  /** Null on an expense or layout line. */
  quantity: number | null;
  rate: number | null;
  cents: number;
  orderId: string | null;
  orderLine: number | null;
  state: 'as_was' | 'changed' | 'added';
}

export interface FixedBill {
  number: string;
  date: string | null;
  dueDate: string | null;
  memo: string;
  /** Every line it keeps, expenses then items, then the ones added. */
  lines: FixedBillLine[];
  /** Null when NetSuite gave none and no line changes. */
  totalCents: number | null;
}

export interface BillFixPlan {
  /** Plain-English reasons it can't be sent yet, one per problem. */
  problems: string[];
  /** What changes, a sentence each, as the screen lists them and the fix's history keeps them. */
  changes: string[];
  /** What else the person should know, a sentence each. */
  notes: string[];
  /** The lists a line is taken off: NetSuite's lines on each become exactly the ones sent (?replace=). */
  replace: BillSublist[];
  /** The PATCH NetSuite is sent. */
  body: Record<string, unknown>;
  fixed: FixedBill;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const places = (n: number, p: number) => Math.abs(n * 10 ** p - Math.round(n * 10 ** p)) < 1e-6;
const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const realDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const keyOf = (list: BillSublist, line: number) => `${list}:${line}`;

/** How a line is named in what the screen says. */
export const lineName = (l: Pick<BillFixLine, 'list' | 'line' | 'accountName' | 'itemNumber'>) => (l.list === 'expense'
  ? l.accountName || `Expense line ${l.line}`
  : l.itemNumber || `Line ${l.line}`);

const asWas = (l: BillFixLine): FixedBillLine => ({
  list: l.list, line: l.line, accountId: l.accountId, accountName: l.accountName, itemId: l.itemId, itemNumber: l.itemNumber,
  itemType: l.itemType, description: l.description, kind: l.kind,
  quantity: l.kind === 'quantity' || l.kind === 'kept' ? (l.list === 'item' ? l.quantity : null) : null,
  rate: l.rate, cents: l.cents, orderId: l.orderId, orderLine: l.orderLine, state: 'as_was',
});

/**
 * The fix from what the person changed: what NetSuite is sent, what changes in words, the bill as it'll be, and what
 * stops it. A box left as it was changes nothing, so nothing that didn't change goes to NetSuite.
 */
export function planBillFix(bill: FixBill, edit: BillFixEdit, facts: BillFixFacts): BillFixPlan {
  const problems: string[] = [];
  const changes: string[] = [];
  const notes: string[] = [];
  const body: Record<string, unknown> = {};
  const fixed: FixedBill = {
    number: bill.number, date: bill.date, dueDate: bill.dueDate, memo: bill.memo, lines: bill.lines.map(asWas), totalCents: bill.totalCents,
  };
  const name = billName(bill);
  if (!facts.allows.header) {
    return { problems: [facts.allows.why || `${cap(name)} can't be fixed.`], changes, notes, replace: [], body, fixed };
  }

  let toldLocked = false;
  const locked = () => {
    if (!toldLocked) problems.push(facts.allows.why || `The date and lines of ${name} can't be fixed.`);
    toldLocked = true;
  };

  // ── The header ──
  const h = edit.header ?? {};
  if (h.number !== undefined && h.number.trim() !== bill.number) {
    const v = h.number.trim();
    if (!v) problems.push("Enter the vendor's number for the bill.");
    else if (v.length > BILL_NUMBER_MAX) problems.push(`The bill's number takes ${BILL_NUMBER_MAX} characters at most.`);
    else if (facts.numberTaken) {
      problems.push(`${bill.vendorName || 'The vendor'} already has a bill numbered ${facts.numberTaken} in NetSuite. Each of a vendor's bills has its own number.`);
    } else {
      body.tranId = v;
      fixed.number = v;
      changes.push(`Number ${bill.number || '(none)'} → ${v}`);
    }
  }
  const dueTyped = h.dueDate !== undefined && h.dueDate.trim() !== (bill.dueDate ?? '');
  if (h.date !== undefined && h.date.trim() !== (bill.date ?? '')) {
    const v = h.date.trim();
    if (!realDate(v)) problems.push('Pick the date.');
    else if (!facts.allows.lines) locked();
    else {
      body.tranDate = v;
      fixed.date = v;
      changes.push(`Date ${dayText(bill.date)} → ${dayText(v)}`);
      if (!dueTyped) {
        if (facts.termsDays === null) {
          notes.push(`NetSuite keeps its due date, ${dayText(bill.dueDate)}: FleetSuite can't tell the bill's terms. Change the due date too if it should move.`);
        } else {
          const due = addDays(v, facts.termsDays);
          fixed.dueDate = due;
          if (due !== bill.dueDate) {
            body.dueDate = due;
            changes.push(`Due ${dayText(bill.dueDate)} → ${dayText(due)}`);
          }
        }
      }
    }
  }
  if (dueTyped) {
    const v = h.dueDate!.trim();
    if (!realDate(v)) problems.push('Pick the due date.');
    else if (fixed.date && v < fixed.date) problems.push("The due date can't be before the bill's date.");
    else {
      body.dueDate = v;
      fixed.dueDate = v;
      changes.push(`Due ${dayText(bill.dueDate)} → ${dayText(v)}`);
    }
  }
  if (h.memo !== undefined && h.memo.trim() !== bill.memo) {
    const v = h.memo.trim();
    if (v.length > MEMO_MAX) problems.push(`The memo takes ${MEMO_MAX} characters at most.`);
    else {
      body.memo = v;
      fixed.memo = v;
      changes.push(v ? (bill.memo ? 'Memo changed' : 'Memo added') : 'Memo taken off');
    }
  }

  // ── Its lines ──
  const byKey = new Map(bill.lines.map((l) => [keyOf(l.list, l.line), l]));
  const edits = new Map<string, BillLineEdit>();
  for (const e of edit.lines ?? []) {
    const key = keyOf(e.list, e.line);
    const l = byKey.get(key);
    if (!l) { problems.push(`${e.list === 'expense' ? 'Expense line' : 'Line'} ${e.line} isn't on ${name} any more. Reload and try again.`); continue; }
    if (edits.has(key)) { problems.push(`${lineName(l)} was sent twice.`); continue; }
    edits.set(key, e);
  }

  const lines: FixedBillLine[] = [];
  const patches = new Map<string, Record<string, unknown>>();
  const removed = new Set<string>();
  // What each line the fix touches came to before, and after (0 when taken off).
  const moved: { before: number; after: number }[] = [];
  for (const l of bill.lines) {
    const key = keyOf(l.list, l.line);
    const e = edits.get(key);
    const ln = lineName(l);
    // Only what a line's kind takes is read: an account, amount and memo on an expense line, a quantity, rate and
    // description on a part. A line kept as it is can only be taken off.
    const accountChanges = l.kind === 'expense' && e?.accountId !== undefined && e.accountId !== l.accountId;
    const amountChanges = l.kind === 'expense' && e?.amount !== undefined && !same(e.amount, l.cents / 100);
    const quantityChanges = l.kind === 'quantity' && e?.quantity !== undefined && !same(e.quantity, l.quantity);
    const rateChanges = l.kind === 'quantity' && e?.rate !== undefined && (l.rate === null || !same(e.rate, l.rate));
    const descriptionChanges = (l.kind === 'expense' || l.kind === 'quantity') && e?.description !== undefined
      && e.description.trim() !== l.description;
    if (!e || !(e.remove || accountChanges || amountChanges || quantityChanges || rateChanges || descriptionChanges)) {
      lines.push(asWas(l));
      continue;
    }
    if (!facts.allows.lines) { locked(); lines.push(asWas(l)); continue; }
    if (e.remove) {
      if (l.kind === 'layout') {
        problems.push(`${ln} only lays the bill out, so it stays as it is.`);
        lines.push(asWas(l));
        continue;
      }
      removed.add(key);
      moved.push({ before: l.cents, after: 0 });
      changes.push(l.kind === 'quantity' && l.rate !== null
        ? `Took off ${ln} (${quantityText(l.quantity)} × ${priceText(l.rate)})`
        : `Took off ${ln} (${formatCents(l.cents)})`);
      continue;
    }

    const patch: Record<string, unknown> = {};
    let { accountId, accountName, quantity, rate, cents, description } = l;
    if (accountChanges) {
      const account = e.accountId ? facts.accounts.get(e.accountId) : undefined;
      if (!account) problems.push(`${ln}: pick an account this company's bills can go to.`);
      else {
        accountId = account.id;
        accountName = account.name;
        patch.account = { id: account.id };
        changes.push(`${ln} → ${account.name}`);
      }
    }
    if (amountChanges) {
      const a = e.amount!;
      if (!(Number.isFinite(a) && a > 0)) problems.push(`${ln}: enter an amount above $0. To drop the line, take it off.`);
      else if (a > MAX_AMOUNT) problems.push(`${ln}: the amount can be $10,000,000 at most.`);
      else if (!places(a, 2)) problems.push(`${ln}: the amount goes to the cent.`);
      else {
        cents = Math.round(a * 100);
        patch.amount = cents / 100;
        changes.push(`${ln} ${formatCents(l.cents)} → ${formatCents(cents)}`);
      }
    }
    if (quantityChanges) {
      const q = e.quantity!;
      if (!Number.isFinite(q)) problems.push(`${ln}: enter the quantity.`);
      else if (q <= 0) problems.push(`${ln}: the quantity has to be more than 0. To drop the line, take it off.`);
      else if (q > MAX_QUANTITY) problems.push(`${ln}: the quantity can be 1,000,000 at most.`);
      else if (!places(q, 4)) problems.push(`${ln}: the quantity takes 4 places at most.`);
      else {
        quantity = round4(q);
        patch.quantity = quantity;
        changes.push(`${ln} quantity ${quantityText(l.quantity)} → ${quantityText(quantity)}`);
      }
    }
    if (rateChanges) {
      const r = e.rate!;
      if (!Number.isFinite(r)) problems.push(`${ln}: enter the rate.`);
      else if (r < 0) problems.push(`${ln}: the rate can't be less than $0.`);
      else if (r > MAX_AMOUNT) problems.push(`${ln}: the rate can be $10,000,000 at most.`);
      else if (!places(r, 4)) problems.push(`${ln}: the rate takes 4 places at most.`);
      else {
        rate = round4(r);
        patch.rate = rate;
        changes.push(`${ln} rate ${l.rate === null ? '(none)' : priceText(l.rate)} → ${priceText(rate)}`);
      }
    }
    if ('quantity' in patch || 'rate' in patch) {
      // With no rate, the quantity alone can't say what the line comes to.
      if (rate === null) problems.push(`${ln}: NetSuite gave no rate for it, so enter the rate too.`);
      else {
        cents = centsOf(quantity * rate);
        // The amount goes with the quantity and rate, so NetSuite's line comes to the cent FleetSuite worked out.
        patch.amount = cents / 100;
      }
    }
    if (descriptionChanges) {
      const v = e.description!.trim();
      if (v.length > DESCRIPTION_MAX) problems.push(`${ln}: the ${l.kind === 'expense' ? 'memo' : 'description'} takes 4,000 characters at most.`);
      else {
        description = v;
        patch[l.kind === 'expense' ? 'memo' : 'description'] = v;
        changes.push(`${ln} ${l.kind === 'expense' ? 'memo' : 'description'} changed`);
      }
    }
    if (Object.keys(patch).length === 0) { lines.push(asWas(l)); continue; }
    patches.set(key, patch);
    moved.push({ before: l.cents, after: cents });
    lines.push({
      ...asWas(l), accountId, accountName, quantity: l.kind === 'quantity' ? quantity : null, rate, cents, description, state: 'changed',
    });
  }

  // ── Expense lines added ──
  const added: Record<string, unknown>[] = [];
  const adds = edit.add ?? [];
  if (adds.length > 0 && !facts.allows.lines) locked();
  else if (adds.length > MAX_ADDED) problems.push(`One fix adds ${MAX_ADDED} lines at most.`);
  else {
    adds.forEach((n, i) => {
      const ln = `New line ${i + 1}`;
      const account = facts.accounts.get(n.accountId);
      if (!account) { problems.push(`${ln}: pick an account this company's bills can go to.`); return; }
      if (!(Number.isFinite(n.amount) && n.amount > 0)) { problems.push(`${ln}: enter an amount above $0.`); return; }
      if (n.amount > MAX_AMOUNT) { problems.push(`${ln}: the amount can be $10,000,000 at most.`); return; }
      if (!places(n.amount, 2)) { problems.push(`${ln}: the amount goes to the cent.`); return; }
      const memo = (n.memo ?? '').trim();
      if (memo.length > DESCRIPTION_MAX) { problems.push(`${ln}: the memo takes 4,000 characters at most.`); return; }
      const cents = Math.round(n.amount * 100);
      added.push({ account: { id: account.id }, amount: cents / 100, ...(memo ? { memo } : {}) });
      moved.push({ before: 0, after: cents });
      lines.push({
        list: 'expense', line: null, accountId: account.id, accountName: account.name, itemId: null, itemNumber: '', itemType: null,
        description: memo, kind: 'expense', quantity: null, rate: null, cents, orderId: null, orderLine: null, state: 'added',
      });
      changes.push(`Added ${account.name} (${formatCents(cents)})`);
    });
  }

  if (moved.length > 0) {
    if (!lines.some((l) => l.kind !== 'layout')) {
      problems.push(`A bill needs a line. To undo all of ${name}, make a vendor credit for all of it.`);
    }
    const totalCents = (bill.totalCents ?? 0) + moved.reduce((s, m) => s + m.after - m.before, 0);
    if (totalCents <= 0) problems.push(`${cap(name)} has to come to more than $0. To undo all of it, make a vendor credit for all of it.`);
    fixed.totalCents = totalCents;
  }
  fixed.lines = lines;

  const reason = edit.reason.trim();
  if (!reason) problems.push("Say why it's being fixed.");
  else if (reason.length > REASON_MAX) problems.push(`Why it's being fixed takes ${REASON_MAX} characters at most.`);
  if (changes.length === 0 && problems.length === 0) problems.push('Nothing has changed yet.');

  const replace = SUBLISTS.filter((list) => bill.lines.some((l) => l.list === list && removed.has(keyOf(list, l.line))));
  for (const list of SUBLISTS) {
    const extra = list === 'expense' ? added : [];
    if (replace.includes(list)) {
      // NetSuite's lines on this list become exactly these: every line kept, by its key and with its change, then the ones added.
      body[list] = {
        items: [
          ...bill.lines
            .filter((l) => l.list === list && !removed.has(keyOf(list, l.line)))
            .map((l) => ({ line: l.line, ...(patches.get(keyOf(list, l.line)) ?? {}) })),
          ...extra,
        ],
      };
    } else {
      const changed = bill.lines.filter((l) => l.list === list && patches.has(keyOf(list, l.line)));
      if (changed.length > 0 || extra.length > 0) {
        body[list] = { items: [...changed.map((l) => ({ line: l.line, ...patches.get(keyOf(list, l.line))! })), ...extra] };
      }
    }
  }
  return { problems, changes, notes, replace, body, fixed };
}

/**
 * What a fix is planned against, as one string: when NetSuite last changed the bill, and everything the fix reads of
 * it. The route sends it to the page and the page back, and anything different means someone changed the bill while
 * the page was open.
 */
export function billFacts(bill: FixBill): string {
  return JSON.stringify([
    bill.lastModified, bill.number, bill.date, bill.dueDate, bill.memo, bill.status, bill.voided, bill.totalCents, bill.owedCents,
    bill.lines.map((l) => [l.list, l.line, l.kind, l.accountId, l.itemId, l.quantity, l.rate, l.cents, l.description, l.orderId, l.orderLine]),
  ]);
}

/**
 * The lines of a fixed bill that come to something, as Books' own copy takes them (saveFixedOwnBill): an expense line
 * names its account, a part its item, with the purchase order's line it bills (its sequence number on the order).
 */
export function ownCopyLines(fixed: FixedBill) {
  return fixed.lines
    .filter((l) => l.cents !== 0)
    .map((l) => ({
      accountId: l.list === 'expense' ? l.accountId : null,
      itemId: l.list === 'item' ? l.itemId : null,
      itemNumber: l.itemNumber || null,
      description: l.description || null,
      quantity: l.list === 'item' ? l.quantity : null,
      rate: l.list === 'item' ? l.rate : null,
      cents: l.cents,
      orderId: l.orderId,
      orderLine: l.orderLine,
    }));
}
