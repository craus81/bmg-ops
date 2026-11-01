/**
 * A customer's check or ACH deposit taken in FleetSuite on a sales order and
 * sent on to NetSuite (Books part 55, docs/books.md "Deposits taken in
 * FleetSuite"; owner decisions 2026-10-31, thread "Replacing NetSuite with
 * FleetSuite": taking deposits moves into FleetSuite during 2027, and
 * FleetSuite sends each on to NetSuite so nobody types anything twice).
 *
 * Opened from a sales order's Deposit button, or an estimate's once it has its
 * sales order: the deposit's day, amount and check number or ACH reference.
 * It goes on an order NetSuite still has open, never more than what's left of
 * the order after the deposits on it already. FleetSuite makes the customer
 * deposit in NetSuite once, on that order, in Undeposited Funds as payments go
 * now, under its own External ID, and keeps Books' own copy. NetSuite puts it
 * on the order's invoice when the order's billed. Card deposits wait on
 * eBizCharge.
 *
 * The rules here are pure; /api/sales-orders/deposit and the deposit page
 * both use them, the page to show what Take deposit would find and the route
 * to check the deposit again against the order as NetSuite has it when it's
 * pressed.
 */

import { isIsoDate } from '@/lib/books/journal';
import {
  MAX_PAYMENT_CENTS, MEMO_MAX, OLDEST_DAYS, REFERENCE_MAX, formatCents, isMethod, netsuiteMemo, type PaymentMethod,
} from '@/lib/receive-payment';

export { formatCents };

/** What a deposit's External ID in NetSuite starts with: the rest is the press's id (received_deposits.id). */
const EXTERNAL_ID_PREFIX = 'fleetsuite-cd-';

export const depositExternalId = (pressId: string) => `${EXTERNAL_ID_PREFIX}${pressId}`;

/**
 * NetSuite's status letters for a sales order a deposit can go on: pending approval, pending fulfillment, partly
 * fulfilled, and pending billing with or without part of it fulfilled. Not cancelled (C), billed (G) or closed (H).
 */
export const DEPOSIT_STATUSES: readonly string[] = ['A', 'B', 'D', 'E', 'F'];

/** The sales order a deposit goes on, as NetSuite has it now. */
export interface DepositOrder {
  id: string;
  number: string;
  /** NetSuite's status letter, and its name for it. */
  status: string;
  statusName: string;
  totalCents: number;
}

/** A deposit on the order already: taken in FleetSuite, or made in NetSuite (the books' copy of NetSuite's deposits). */
export interface DepositOnOrder {
  /** NetSuite's id for it; null while FleetSuite is making it. */
  netsuiteId: string | null;
  number: string | null;
  /** 'YYYY-MM-DD'. */
  date: string;
  cents: number;
  /** Taken in FleetSuite, made or being made. */
  inFleetSuite: boolean;
  /** Being made in NetSuite now, or NetSuite hasn't said whether it was. */
  making: boolean;
}

/** A deposit as typed: its amount in whole cents. */
export interface DepositDraft {
  /** The day it was received, 'YYYY-MM-DD'. */
  date: string;
  method: PaymentMethod | string;
  /** The check's number, or the ACH payment's reference. */
  reference: string;
  memo: string;
  amountCents: number;
}

export interface WorkedDeposit {
  /** Why it can't be sent; none when it can. */
  problems: string[];
  date: string;
  method: PaymentMethod;
  reference: string | null;
  memo: string | null;
  /** What goes on NetSuite's memo: the method and its number or reference, then the memo typed. */
  netsuiteMemo: string;
  amountCents: number;
  /** The deposits on the order already. */
  onOrderCents: number;
  /** What's left of the order after them, never below $0. */
  leftCents: number;
}

const DAY_MS = 86_400_000;
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** 'YYYY-MM-DD' less whole days. */
const daysBefore = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

/** Whether NetSuite still has the order open for a deposit. */
export const takesDeposits = (order: Pick<DepositOrder, 'status'>) => DEPOSIT_STATUSES.includes(order.status);

/**
 * The deposits on an order, oldest first: FleetSuite's own, and NetSuite's from the books' copy of them, each once.
 * A deposit FleetSuite made is in both once the copy has caught up; FleetSuite's row of it is kept.
 */
export function depositsOnOrder(taken: readonly DepositOnOrder[], copied: readonly DepositOnOrder[]): DepositOnOrder[] {
  const ours = new Set(taken.map((d) => d.netsuiteId).filter(Boolean));
  return [...taken, ...copied.filter((d) => !d.netsuiteId || !ours.has(d.netsuiteId))]
    .sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? '').localeCompare(b.number ?? ''));
}

/**
 * A deposit worked out from what's typed, the order as NetSuite has it now and the deposits on it already, with
 * every reason it can't be sent. `today` is the day in O'Fallon.
 */
export function workOutDeposit(
  draft: DepositDraft, order: DepositOrder, onOrder: readonly DepositOnOrder[], opts: { today: string },
): WorkedDeposit {
  const problems: string[] = [];

  const date = clean(draft.date);
  if (!isIsoDate(date)) problems.push(date ? `${date} isn't a day on the calendar.` : 'Fill in the day it was received.');
  else if (date > opts.today) problems.push("A deposit can't be dated after today.");
  else if (date < daysBefore(opts.today, OLDEST_DAYS)) problems.push("A deposit can't be dated more than a year back.");

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
  if (!Number.isInteger(amountCents) || amountCents <= 0) problems.push("Fill in the deposit's amount.");
  else if (amountCents > MAX_PAYMENT_CENTS) problems.push(`One deposit is ${formatCents(MAX_PAYMENT_CENTS)} at most.`);

  const open = takesDeposits(order);
  if (!open) {
    problems.push(order.status === 'G'
      ? `${order.number} is billed in NetSuite already: receive the payment on its invoice instead.`
      : `${order.number} is ${order.statusName ? order.statusName.toLowerCase() : 'not open'} in NetSuite, so a deposit can't go on it.`);
  }

  const onOrderCents = onOrder.reduce((s, d) => s + d.cents, 0);
  const leftCents = Math.max(0, order.totalCents - onOrderCents);
  if (amountOk && open && amountCents > leftCents) {
    problems.push(onOrderCents === 0
      ? `${order.number} comes to ${formatCents(order.totalCents)}, less than the ${formatCents(amountCents)} deposit.`
      : leftCents > 0
        ? `${order.number} has ${formatCents(leftCents)} left after the ${formatCents(onOrderCents)} in deposits on it, less than the ${formatCents(amountCents)} deposit.`
        : `${order.number} has deposits for all ${formatCents(order.totalCents)} of it already.`);
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
    onOrderCents,
    leftCents,
  };
}

/** What createCustomerDeposit sends (src/lib/netsuite.ts), dollars as NetSuite takes them. */
export function netsuiteDeposit(
  worked: WorkedDeposit, p: { pressId: string; customerId: string; subsidiaryId: string; salesOrderId: string },
) {
  return {
    externalId: depositExternalId(p.pressId),
    customerId: p.customerId,
    subsidiaryId: p.subsidiaryId,
    salesOrderId: p.salesOrderId,
    tranDate: worked.date,
    amount: worked.amountCents / 100,
    checkNumber: worked.method === 'check' ? worked.reference : null,
    memo: worked.netsuiteMemo,
  };
}
