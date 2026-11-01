/**
 * Vendors paid in FleetSuite and sent on to NetSuite as bill payments (Books
 * part 57, docs/books.md "Vendors paid in FleetSuite"; owner decisions
 * 2026-10-31, thread "Replacing NetSuite with FleetSuite": making payments
 * moves into FleetSuite during 2027, and FleetSuite sends each on to NetSuite
 * so nobody types anything twice; the NetSuite Exit Checklist's "Pay
 * vendors": payment runs with a second approver).
 *
 * Opened from More → Money & Books → Pay Vendors. A payment run pays a
 * company's open bills, ticked from what NetSuite has open, from one of its
 * bank accounts on one day: one payment per vendor, by check or ACH, each
 * paying the bills ticked for it, none more than NetSuite has open on it. It's
 * saved as a draft and asked for approval, and a super admin who didn't ask
 * approves it. Then FleetSuite makes each payment in NetSuite once, as a bill
 * payment under its own External ID, and keeps Books' own copy. A check is
 * made To Be Printed, so it prints from NetSuite's Print Checks until
 * FleetSuite prints checks itself; an ACH payment isn't. Vendor credits,
 * early-payment discounts, the ACH file and bank numbers aren't done.
 *
 * The rules here are pure; /api/pay-vendors and the Pay vendors page both use
 * them, the page to show what a run would pay and the route to check it again
 * against what NetSuite has open when it's asked for, approved and made.
 */

import { isIsoDate } from '@/lib/books/journal';
import { MEMO_MAX, OLDEST_DAYS, formatCents } from '@/lib/receive-payment';
import { accountName, type BankAccount } from '@/lib/bank-deposit';

export { accountName, formatCents, MEMO_MAX };
export type { BankAccount };

export type PayMethod = 'check' | 'ach';

export const PAY_METHODS: Readonly<Record<PayMethod, string>> = { check: 'Check', ach: 'ACH' };

export const isPayMethod = (v: unknown): v is PayMethod => v === 'check' || v === 'ach';

/** The most vendors one run pays. */
export const MAX_PAYMENTS = 50;

/** The most bills one payment pays. */
export const MAX_BILLS = 100;

/** The most bills one run pays, its payments together. */
export const MAX_RUN_BILLS = 500;

/** The most one payment can be: $10,000,000.00. */
export const MAX_PAYMENT_CENTS = 1_000_000_000;

/** The longest reason for sending a run back, or for dropping a payment. */
export const REASON_MAX = 500;

/** How many days ahead a run can be dated. */
export const AHEAD_DAYS = 31;

/** What a bill payment's External ID in NetSuite starts with: the rest is the payment's id (vendor_payment_run_payments.id). */
const EXTERNAL_ID_PREFIX = 'fleetsuite-vp-';

export const vendorPaymentExternalId = (paymentId: string) => `${EXTERNAL_ID_PREFIX}${paymentId}`;

/** Where a run is. */
export type RunStatus = 'draft' | 'waiting' | 'approved' | 'done';

/** Where each of an approved run's payments is. */
export type PaymentStatus = 'to_make' | 'sending' | 'made' | 'refused' | 'dropped';

/** One of the company's open bills, as NetSuite lists them for a new run. */
export interface OpenBill {
  id: string;
  number: string;
  /** 'YYYY-MM-DD'. */
  date: string | null;
  dueDate: string | null;
  vendorId: string;
  vendorName: string;
  openCents: number;
}

/** A bill as NetSuite has it now, by its id: what's open on it, and whose it is. */
export interface BillNow {
  /** Whether it's open (NetSuite's status A): a bill paid in full, or not approved, isn't. */
  open: boolean;
  openCents: number;
  vendorId: string | null;
}

/** A bill ticked on a payment, as the page sends it and the run keeps it. */
export interface RunBill {
  billId: string;
  /** Its number, day, due day and what NetSuite had open on it when it was ticked, for showing. */
  number: string | null;
  date: string | null;
  dueDate: string | null;
  openCents: number;
  /** What this run pays on it. */
  cents: number;
}

/** One vendor's payment in a run, as picked. */
export interface RunPayment {
  vendorId: string;
  vendorName: string | null;
  method: PayMethod;
  bills: RunBill[];
}

/** A run as it's ticked and typed. */
export interface RunDraft {
  /** The day it's paid, 'YYYY-MM-DD'. */
  date: string;
  /** NetSuite's id for the bank account it's paid from. */
  accountId: string;
  memo: string;
  payments: RunPayment[];
}

export interface WorkedPayment {
  vendorId: string;
  vendorName: string;
  method: PayMethod;
  /** Its bills, oldest due first. */
  bills: RunBill[];
  cents: number;
}

export interface WorkedRun {
  /** Why it can't be asked for, approved or made; none when it can. */
  problems: string[];
  date: string;
  account: BankAccount | null;
  memo: string | null;
  /** Its payments, by vendor name. */
  payments: WorkedPayment[];
  totalCents: number;
  billCount: number;
}

const DAY_MS = 86_400_000;
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** 'YYYY-MM-DD' moved by whole days. */
const daysAfter = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** A bill as a sentence names it. */
export const billName = (b: Pick<RunBill, 'billId' | 'number'>) => `Bill ${b.number || b.billId}`;

/** A vendor as a sentence names it. */
export const vendorNameOf = (p: Pick<RunPayment, 'vendorId' | 'vendorName'>) => clean(p.vendorName) || `Vendor ${p.vendorId}`;

/** Oldest due first, then oldest, then by number: how a payment lists its bills. */
export function byDue<T extends Pick<RunBill, 'billId' | 'dueDate' | 'date' | 'number'>>(bills: readonly T[]): T[] {
  const key = (b: T) => [b.dueDate || b.date || '9999-12-31', b.date || '9999-12-31', b.number || '', b.billId.padStart(20, '0')].join('|');
  return [...bills].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** By vendor name, then by NetSuite's id: how a run lists its payments. */
export function byVendor<T extends Pick<RunPayment, 'vendorId' | 'vendorName'>>(payments: readonly T[]): T[] {
  return [...payments].sort((a, b) => vendorNameOf(a).localeCompare(vendorNameOf(b), 'en', { sensitivity: 'base' })
    || a.vendorId.padStart(20, '0').localeCompare(b.vendorId.padStart(20, '0')));
}

/**
 * Why NetSuite can't take what a payment pays on one of its bills now, or null when it can: the bill is open, it's
 * this vendor's, and it has at least that much open.
 */
export function billProblem(bill: RunBill, payment: Pick<RunPayment, 'vendorId' | 'vendorName'>, now: BillNow | undefined): string | null {
  const name = billName(bill);
  if (!now) return `${name} isn't in NetSuite any more, so nothing can be paid on it.`;
  if (!now.open || now.openCents <= 0) return `${name} isn't open in NetSuite now: it's paid, or waiting for approval there.`;
  if (now.vendorId && now.vendorId !== payment.vendorId) return `${name} isn't ${vendorNameOf(payment)}'s in NetSuite now.`;
  if (bill.cents > now.openCents) {
    return `${name} has ${formatCents(now.openCents)} open in NetSuite now, less than the ${formatCents(bill.cents)} this pays on it.`;
  }
  return null;
}

/**
 * A run worked out from what's ticked and typed, the company's bank accounts and its bills as NetSuite has them now,
 * with every reason it can't be asked for, approved or made. `held` is the bills another run holds; `today` is the day
 * in O'Fallon.
 */
export function workOutRun(
  draft: RunDraft, now: ReadonlyMap<string, BillNow>, accounts: readonly BankAccount[],
  opts: { today: string; held?: ReadonlySet<string> },
): WorkedRun {
  const problems: string[] = [];

  const date = clean(draft.date);
  if (!isIsoDate(date)) problems.push(date ? `${date} isn't a day on the calendar.` : 'Fill in the day the vendors are paid.');
  else if (date > daysAfter(opts.today, AHEAD_DAYS)) problems.push("A payment run can't be dated more than a month ahead.");
  else if (date < daysAfter(opts.today, -OLDEST_DAYS)) problems.push("A payment run can't be dated more than a year back.");

  const accountId = clean(draft.accountId);
  const account = accounts.find((a) => a.netsuiteId === accountId) ?? null;
  if (!account) problems.push(accountId ? "That isn't one of the company's bank accounts." : 'Pick the bank account it pays from.');

  const memo = clean(draft.memo);
  if (memo.length > MEMO_MAX) problems.push(`The memo is ${MEMO_MAX} characters at most.`);

  if (draft.payments.length === 0) problems.push('Tick the bills to pay.');
  else if (draft.payments.length > MAX_PAYMENTS) problems.push(`One run pays ${MAX_PAYMENTS} vendors at most: pay the others in another run.`);

  const vendors = new Set<string>();
  const ticked = new Set<string>();
  const payments: WorkedPayment[] = [];
  let billCount = 0;
  for (const p of draft.payments) {
    const vendorName = vendorNameOf(p);
    if (vendors.has(p.vendorId)) {
      problems.push(`${vendorName} is in the run twice.`);
      continue;
    }
    vendors.add(p.vendorId);
    if (!isPayMethod(p.method)) problems.push(`Pick check or ACH for ${vendorName}.`);
    if (p.bills.length === 0) problems.push(`Tick a bill to pay ${vendorName}, or take them out of the run.`);
    else if (p.bills.length > MAX_BILLS) problems.push(`One payment pays ${MAX_BILLS} bills at most, and ${vendorName} has ${p.bills.length} ticked.`);

    const bills: RunBill[] = [];
    for (const b of p.bills) {
      if (ticked.has(b.billId)) {
        problems.push(`${billName(b)} is ticked twice.`);
        continue;
      }
      ticked.add(b.billId);
      if (!Number.isInteger(b.cents) || b.cents <= 0) {
        problems.push(`Fill in what it pays on ${billName(b)}, or untick it.`);
        continue;
      }
      const problem = billProblem(b, p, now.get(b.billId));
      if (problem) problems.push(problem);
      else if (opts.held?.has(b.billId)) problems.push(`${billName(b)} is in another payment run, waiting for approval or being paid.`);
      bills.push(b);
    }
    billCount += bills.length;
    const cents = bills.reduce((s, b) => s + b.cents, 0);
    if (cents > MAX_PAYMENT_CENTS) problems.push(`One payment is ${formatCents(MAX_PAYMENT_CENTS)} at most, and ${vendorName}'s comes to ${formatCents(cents)}.`);
    payments.push({ vendorId: p.vendorId, vendorName, method: isPayMethod(p.method) ? p.method : 'check', bills: byDue(bills), cents });
  }
  if (billCount > MAX_RUN_BILLS) problems.push(`One run pays ${MAX_RUN_BILLS} bills at most: pay the others in another run.`);

  const sorted = byVendor(payments);
  return {
    problems,
    date,
    account,
    memo: memo || null,
    payments: sorted,
    totalCents: sorted.reduce((s, p) => s + p.cents, 0),
    billCount,
  };
}

/**
 * Why NetSuite can't take one approved payment now, or none: each of its bills open, the vendor's, with at least what
 * it pays open. What the make step checks just before it sends.
 */
export function paymentProblems(payment: RunPayment, now: ReadonlyMap<string, BillNow>): string[] {
  return payment.bills.flatMap((b) => billProblem(b, payment, now.get(b.billId)) ?? []);
}

/** The memo NetSuite shows on the payment: as typed for a check; an ACH payment's says it's ACH. */
export function paymentMemo(method: PayMethod, memo: string | null): string {
  const typed = clean(memo);
  if (method === 'check') return typed;
  return typed ? `ACH: ${typed}`.slice(0, MEMO_MAX) : 'ACH';
}

/** What createVendorPayment sends (src/lib/netsuite.ts) for one of a run's payments. */
export function netsuiteVendorPayment(
  payment: RunPayment,
  p: { paymentId: string; subsidiaryId: string; accountId: string; date: string; memo: string | null },
) {
  const cents = payment.bills.reduce((s, b) => s + b.cents, 0);
  return {
    externalId: vendorPaymentExternalId(p.paymentId),
    vendorId: payment.vendorId,
    subsidiaryId: p.subsidiaryId,
    accountId: p.accountId,
    tranDate: p.date,
    memo: paymentMemo(payment.method, p.memo),
    toBePrinted: payment.method === 'check',
    amount: cents / 100,
    apply: payment.bills.map((b) => ({ billId: b.billId, amount: b.cents / 100 })),
  };
}

/** A payment's bills as the run keeps them (vendor_payment_runs.payments, migration 488). */
export interface KeptBill {
  bill_netsuite_id: string;
  number: string | null;
  date: string | null;
  due_date: string | null;
  open_cents: number;
  cents: number;
}

export interface KeptPayment {
  vendor_netsuite_id: string;
  vendor_name: string | null;
  method: string;
  bills: KeptBill[];
}

/** Whole cents as kept (a bigint may come back as text), else 0. */
const whole = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) ? n : 0;
};
const textOr = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const dayOr = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10)) ? v.slice(0, 10) : null);

/** A payment's bills as kept, for the rules. */
export const keptBills = (bills: unknown): RunBill[] => (Array.isArray(bills) ? bills : []).map((b: any) => ({
  billId: String(b?.bill_netsuite_id ?? ''),
  number: textOr(b?.number),
  date: dayOr(b?.date),
  dueDate: dayOr(b?.due_date),
  openCents: whole(b?.open_cents),
  cents: whole(b?.cents),
}));

/** A run's payments as kept, for the rules. */
export const keptPayments = (payments: unknown): RunPayment[] => (Array.isArray(payments) ? payments : []).map((p: any) => ({
  vendorId: String(p?.vendor_netsuite_id ?? ''),
  vendorName: textOr(p?.vendor_name),
  method: isPayMethod(p?.method) ? p.method : 'check',
  bills: keptBills(p?.bills),
}));

/** A run's payments as vendor_payment_run_save keeps them. */
export const paymentsToKeep = (payments: readonly RunPayment[]): KeptPayment[] => payments.map((p) => ({
  vendor_netsuite_id: p.vendorId,
  vendor_name: clean(p.vendorName) || null,
  method: p.method,
  bills: p.bills.map((b) => ({
    bill_netsuite_id: b.billId, number: clean(b.number) || null, date: b.date, due_date: b.dueDate, open_cents: b.openCents, cents: b.cents,
  })),
}));

/** NetSuite's ids for every bill in a run. */
export const runBillIds = (payments: readonly RunPayment[]) => payments.flatMap((p) => p.bills.map((b) => b.billId));
