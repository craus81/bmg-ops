/**
 * A customer's check or ACH payment received in FleetSuite and sent on to
 * NetSuite (Books part 54, docs/books.md "Payments received in FleetSuite";
 * owner decisions 2026-10-31, thread "Replacing NetSuite with FleetSuite":
 * receiving and making payments move into FleetSuite during 2027, and
 * FleetSuite sends each on to NetSuite so nobody types anything twice).
 *
 * Opened from an open invoice in Invoicing → Invoiced: the check or ACH
 * payment's day, amount and number or reference, and how much of it pays
 * each of the customer's open invoices in that invoice's company. Every
 * dollar of it pays an invoice, none more than NetSuite has open on it now.
 * FleetSuite makes the customer payment in NetSuite once, in Undeposited
 * Funds as payments go now, under its own External ID, and keeps Books' own
 * copy. Card payments wait on eBizCharge.
 *
 * The rules here are pure; /api/invoices/payment and the payment page both
 * use them, the page to show what Receive payment would find and the route to
 * check the payment again against what NetSuite has open when it's pressed.
 */

import { formatCents } from '@/lib/credit-memo';
import { isIsoDate } from '@/lib/books/journal';

export { formatCents };

export type PaymentMethod = 'check' | 'ach';

export const METHODS: Readonly<Record<PaymentMethod, { name: string; reference: string }>> = {
  check: { name: 'Check', reference: 'Check number' },
  ach: { name: 'ACH', reference: 'Reference' },
};

export const isMethod = (v: unknown): v is PaymentMethod => v === 'check' || v === 'ach';

/** The most invoices one payment pays. */
export const MAX_APPLIED = 50;

/** The most one payment can be: $10,000,000.00. */
export const MAX_PAYMENT_CENTS = 1_000_000_000;

export const MEMO_MAX = 300;

/** The longest check number or ACH reference. */
export const REFERENCE_MAX = 40;

/** How many days back a payment can be dated. */
export const OLDEST_DAYS = 366;

/** What a payment's External ID in NetSuite starts with: the rest is the press's id (received_payments.id). */
const EXTERNAL_ID_PREFIX = 'fleetsuite-cp-';

export const paymentExternalId = (pressId: string) => `${EXTERNAL_ID_PREFIX}${pressId}`;

/** One of the customer's open invoices, as NetSuite has it now. */
export interface OpenInvoice {
  id: string;
  number: string;
  /** 'YYYY-MM-DD'. */
  date: string | null;
  dueDate: string | null;
  po: string | null;
  totalCents: number;
  /** What's still open on it. */
  openCents: number;
}

/** A payment as typed: its amounts in whole cents. */
export interface PaymentDraft {
  /** The day it was received, 'YYYY-MM-DD'. */
  date: string;
  method: PaymentMethod | string;
  /** The check's number, or the ACH payment's reference. */
  reference: string;
  memo: string;
  amountCents: number;
  /** What it pays on each invoice. */
  applied: { invoiceId: string; cents: number }[];
}

/** What a payment pays on one invoice. */
export interface AppliedLine {
  invoiceId: string;
  number: string;
  cents: number;
  /** What NetSuite had open on the invoice when it was worked out. */
  openCents: number;
}

export interface WorkedPayment {
  /** Why it can't be sent; none when it can. */
  problems: string[];
  date: string;
  method: PaymentMethod;
  reference: string | null;
  memo: string | null;
  /** What goes on NetSuite's memo: the method and its number or reference, then the memo typed. */
  netsuiteMemo: string;
  amountCents: number;
  /** In the order NetSuite lists the invoices: oldest first. */
  applied: AppliedLine[];
  appliedCents: number;
}

const DAY_MS = 86_400_000;
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** 'YYYY-MM-DD' less whole days. */
const daysBefore = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

/** The open invoices oldest first, as NetSuite's own Accept Payment lists them: by date, then by number. */
export function oldestFirst<T extends Pick<OpenInvoice, 'id' | 'date' | 'number'>>(open: readonly T[]): T[] {
  return [...open].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.number.localeCompare(b.number) || a.id.localeCompare(b.id));
}

/** NetSuite's memo for a payment: 'Check 10442', 'ACH 0187', then the memo typed after a dot. */
export function netsuiteMemo(method: PaymentMethod, reference: string | null, memo: string | null): string {
  return [`${METHODS[method].name}${reference ? ` ${reference}` : ''}`, memo].filter(Boolean).join(' · ');
}

/**
 * A payment worked out from what's typed and the customer's open invoices as NetSuite has them now, with every
 * reason it can't be sent. `today` is the day in O'Fallon.
 */
export function workOutPayment(draft: PaymentDraft, open: readonly OpenInvoice[], opts: { today: string }): WorkedPayment {
  const problems: string[] = [];

  const date = clean(draft.date);
  if (!isIsoDate(date)) problems.push(date ? `${date} isn't a day on the calendar.` : 'Fill in the day it was received.');
  else if (date > opts.today) problems.push("A payment can't be dated after today.");
  else if (date < daysBefore(opts.today, OLDEST_DAYS)) problems.push("A payment can't be dated more than a year back.");

  const method = isMethod(draft.method) ? draft.method : null;
  if (!method) problems.push('Pick check or ACH.');
  const reference = clean(draft.reference);
  if (method === 'check' && !reference) problems.push("Fill in the check's number.");
  if (reference.length > REFERENCE_MAX) {
    problems.push(`The ${method === 'check' ? 'check number' : 'reference'} is ${REFERENCE_MAX} characters at most.`);
  }
  const memo = clean(draft.memo);
  if (memo.length > MEMO_MAX) problems.push(`The memo is ${MEMO_MAX} characters at most.`);

  const amountCents = draft.amountCents;
  const amountOk = Number.isInteger(amountCents) && amountCents > 0 && amountCents <= MAX_PAYMENT_CENTS;
  if (!Number.isInteger(amountCents) || amountCents <= 0) problems.push("Fill in the payment's amount.");
  else if (amountCents > MAX_PAYMENT_CENTS) problems.push(`One payment is ${formatCents(MAX_PAYMENT_CENTS)} at most.`);

  const byId = new Map(open.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const picked: AppliedLine[] = [];
  for (const a of draft.applied) {
    const invoice = byId.get(a.invoiceId);
    if (seen.has(a.invoiceId)) {
      problems.push(`${invoice?.number ?? `Invoice ${a.invoiceId}`} is ticked twice.`);
      continue;
    }
    seen.add(a.invoiceId);
    if (!invoice) {
      problems.push(`Invoice ${a.invoiceId} isn't open for this customer in NetSuite now, so nothing can be paid on it.`);
      continue;
    }
    if (!Number.isInteger(a.cents) || a.cents <= 0) {
      problems.push(`Fill in what it pays on ${invoice.number}, or untick it.`);
      continue;
    }
    if (a.cents > invoice.openCents) {
      problems.push(`${invoice.number} has ${formatCents(invoice.openCents)} open in NetSuite now, less than the ${formatCents(a.cents)} it pays.`);
    }
    picked.push({ invoiceId: invoice.id, number: invoice.number, cents: a.cents, openCents: invoice.openCents });
  }
  if (draft.applied.length === 0) problems.push('Tick the invoices it pays.');
  else if (draft.applied.length > MAX_APPLIED) problems.push(`One payment pays ${MAX_APPLIED} invoices at most.`);

  const order = new Map(oldestFirst(open).map((i, n) => [i.id, n]));
  const applied = picked.sort((a, b) => (order.get(a.invoiceId) ?? 0) - (order.get(b.invoiceId) ?? 0));
  const appliedCents = applied.reduce((s, a) => s + a.cents, 0);
  if (amountOk && applied.length > 0 && appliedCents !== amountCents) {
    problems.push(appliedCents < amountCents
      ? `It pays ${formatCents(appliedCents)} of the ${formatCents(amountCents)}: put the other ${formatCents(amountCents - appliedCents)} on an invoice, or change the amount.`
      : `It pays ${formatCents(appliedCents)} on the invoices, more than the ${formatCents(amountCents)} received.`);
  }

  const kept = method ?? 'check';
  return {
    problems,
    date,
    method: kept,
    reference: reference || null,
    memo: memo || null,
    netsuiteMemo: netsuiteMemo(kept, reference || null, memo || null),
    amountCents: amountOk ? amountCents : 0,
    applied,
    appliedCents,
  };
}

/**
 * An amount spread over the open invoices oldest first, each paid in full until what's left pays part of the next:
 * how NetSuite's own Accept Payment applies one. Invoice id → cents.
 */
export function applyOldestFirst(amountCents: number, open: readonly OpenInvoice[]): Map<string, number> {
  const spread = new Map<string, number>();
  let left = Number.isInteger(amountCents) && amountCents > 0 ? amountCents : 0;
  for (const invoice of oldestFirst(open)) {
    if (left <= 0) break;
    const cents = Math.min(left, invoice.openCents);
    if (cents <= 0) continue;
    spread.set(invoice.id, cents);
    left -= cents;
  }
  return spread;
}

/** What received_payment_claim keeps of what a payment pays: [{ invoice_netsuite_id, invoice_number, cents }]. */
export const appliedToKeep = (applied: readonly AppliedLine[]) =>
  applied.map((a) => ({ invoice_netsuite_id: a.invoiceId, invoice_number: a.number || null, cents: a.cents }));

/** A press's kept invoices read back (received_payments.applied); anything unreadable is left out. */
export function keptApplied(raw: unknown): { invoiceId: string; number: string; cents: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r: any) => {
    const invoiceId = typeof r?.invoice_netsuite_id === 'string' && /^\d+$/.test(r.invoice_netsuite_id) ? r.invoice_netsuite_id : null;
    const cents = typeof r?.cents === 'number' && Number.isInteger(r.cents) && r.cents > 0 ? r.cents : null;
    if (!invoiceId || cents === null) return [];
    return [{ invoiceId, number: typeof r.invoice_number === 'string' ? r.invoice_number : '', cents }];
  });
}

/** A check number or reference as two can be compared: 'No. 1044-2', '#10442' and '10442' are the same check. */
export const sameReference = (a: string | null | undefined, b: string | null | undefined) => {
  const key = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^no(?=\d)/, '');
  return key(a) !== '' && key(a) === key(b);
};

/** What createCustomerPayment sends (src/lib/netsuite.ts), dollars as NetSuite takes them. */
export function netsuitePayment(worked: WorkedPayment, p: { pressId: string; customerId: string; subsidiaryId: string }) {
  return {
    externalId: paymentExternalId(p.pressId),
    customerId: p.customerId,
    subsidiaryId: p.subsidiaryId,
    tranDate: worked.date,
    amount: worked.amountCents / 100,
    checkNumber: worked.method === 'check' ? worked.reference : null,
    memo: worked.netsuiteMemo,
    apply: worked.applied.map((a) => ({ invoiceId: a.invoiceId, amount: a.cents / 100 })),
  };
}

/**
 * Whether NetSuite applied a payment it just made as FleetSuite sent it: each invoice's open amount now (`after`,
 * invoice id → cents) is what was open before less what the payment paid on it. Null when every one is; otherwise
 * what's off, said for the person and kept on the press.
 */
export function appliedAsSent(applied: readonly AppliedLine[], after: ReadonlyMap<string, number>): string | null {
  const off = applied.filter((a) => (after.get(a.invoiceId) ?? 0) !== a.openCents - a.cents);
  if (off.length === 0) return null;
  const first = off[0];
  const more = off.length - 1;
  return `NetSuite shows ${first.number} with ${formatCents(after.get(first.invoiceId) ?? 0)} open now, not the `
    + `${formatCents(first.openCents - first.cents)} this payment leaves${more > 0 ? `, and ${more} more invoice${more === 1 ? '' : 's'} too` : ''}. `
    + "Look at the payment in NetSuite: it may not be applied the way FleetSuite sent it.";
}
