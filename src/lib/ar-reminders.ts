/**
 * Past-due invoice reminders for A/R (Valarie's ask, owner decisions
 * 2026-10-09).
 *
 * An open NetSuite invoice alerts the A/R contact once at each step it
 * crosses — 1, 15, 30 and 60 days past its due date by default — in one
 * weekday-morning digest (/api/cron/ar-past-due). The digest links to
 * /invoices/past-due, where the contact ticks the customers to remind and
 * sends each one a statement through the standard compose screen. Nothing
 * here emails a customer: CLAUDE.md "No customer email sends itself".
 *
 * "Once per step" means the step an invoice is AT, not every step it has
 * passed: an invoice first seen 40 days late (the first run, or an invoice
 * entered late in NetSuite) alerts once at 30, not three times at 1/15/30.
 *
 * Pure helpers — the cron and the page share them so the step shown on the
 * page is the step that alerted.
 */

import type { OpenArInvoice } from '@/lib/financials-data';
import { arCustomerKey } from '@/lib/financials-data';

export const DEFAULT_AR_STEPS = [1, 15, 30, 60] as const;

export interface ArReminderSettings {
  enabled: boolean;
  stepDays: number[];
  recipientIds: string[];
}

/** Clean a step list: positive whole days, unique, ascending. Falls back to the defaults when empty. */
export function normalizeSteps(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : [];
  const steps = [...new Set(list.map(Number).filter(n => Number.isInteger(n) && n > 0 && n <= 3650))].sort((a, b) => a - b);
  return steps.length > 0 ? steps : [...DEFAULT_AR_STEPS];
}

export function resolveArSettings(row: any): ArReminderSettings {
  return {
    enabled: row?.enabled !== false,
    stepDays: normalizeSteps(row?.step_days),
    recipientIds: Array.isArray(row?.recipient_ids) ? row.recipient_ids.filter((id: any) => typeof id === 'string') : [],
  };
}

/** The highest step this many days past due has reached, or null when it hasn't reached the first. */
export function stepFor(daysPastDue: number, steps: number[]): number | null {
  let hit: number | null = null;
  for (const s of steps) if (daysPastDue >= s) hit = s;
  return hit;
}

export interface ArStepCrossing {
  invoice: OpenArInvoice;
  step: number;
}

/**
 * Invoices whose current step has not alerted yet. `alerted` holds
 * `${invoiceId}:${step}` keys already logged. An invoice whose current step
 * is LOWER than one it already alerted at (due date pushed out in NetSuite)
 * stays quiet until it climbs past what it already alerted.
 */
export function newCrossings(
  invoices: OpenArInvoice[],
  steps: number[],
  alerted: Set<string>,
): ArStepCrossing[] {
  const out: ArStepCrossing[] = [];
  for (const inv of invoices) {
    if (inv.unpaid <= 0.005) continue;
    const step = stepFor(inv.daysPastDue, steps);
    if (step == null) continue;
    if (steps.some(s => s >= step && alerted.has(`${inv.id}:${s}`))) continue;
    out.push({ invoice: inv, step });
  }
  return out;
}

export interface PastDueCustomerSummary {
  key: string;
  entityId: string | null;
  customer: string;
  invoices: OpenArInvoice[];
  pastDue: number;
  oldestDays: number;
}

/** Group past-due invoices by customer, most money first. */
export function groupPastDue(invoices: OpenArInvoice[]): PastDueCustomerSummary[] {
  const map = new Map<string, PastDueCustomerSummary>();
  for (const inv of invoices) {
    if (inv.daysPastDue <= 0 || inv.unpaid <= 0.005) continue;
    const key = arCustomerKey(inv);
    let cur = map.get(key);
    if (!cur) {
      cur = { key, entityId: inv.entityId, customer: inv.customer, invoices: [], pastDue: 0, oldestDays: 0 };
      map.set(key, cur);
    }
    cur.invoices.push(inv);
    cur.pastDue += inv.unpaid;
    cur.oldestDays = Math.max(cur.oldestDays, inv.daysPastDue);
  }
  const list = [...map.values()];
  for (const c of list) c.invoices.sort((a, b) => b.daysPastDue - a.daysPastDue || a.tranid.localeCompare(b.tranid));
  return list.sort((a, b) => b.pastDue - a.pastDue || a.customer.localeCompare(b.customer));
}

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * The digest text: one line per customer with something new today, then the
 * whole past-due book in one line so the reader knows the size of the pile.
 */
export function buildArDigest(crossings: ArStepCrossing[], allPastDue: PastDueCustomerSummary[]): { title: string; body: string } {
  const byCustomer = groupPastDue(crossings.map(c => c.invoice));
  const stepOf = new Map(crossings.map(c => [c.invoice.id, c.step]));
  const lines = byCustomer.slice(0, 12).map(c => {
    const steps = [...new Set(c.invoices.map(i => stepOf.get(i.id)!))].sort((a, b) => b - a);
    const nums = c.invoices.slice(0, 4).map(i => i.tranid).join(', ') + (c.invoices.length > 4 ? ` +${c.invoices.length - 4} more` : '');
    return `• ${c.customer}: ${c.invoices.length} invoice${c.invoices.length === 1 ? '' : 's'} hit ${steps.map(s => `${s}`).join('/')} days past due (${usd(c.pastDue)}) — ${nums}`;
  });
  const more = byCustomer.length - lines.length;
  const bookTotal = allPastDue.reduce((s, c) => s + c.pastDue, 0);
  const bookCount = allPastDue.reduce((s, c) => s + c.invoices.length, 0);
  const n = crossings.length;
  return {
    title: `💵 ${n} invoice${n === 1 ? '' : 's'} hit a past-due mark today`,
    body: [
      ...lines,
      more > 0 ? `…and ${more} more customer${more === 1 ? '' : 's'}` : '',
      '',
      `Total past due: ${usd(bookTotal)} on ${bookCount} invoice${bookCount === 1 ? '' : 's'} from ${allPastDue.length} customer${allPastDue.length === 1 ? '' : 's'}.`,
      'Open the Past Due page to pick customers and email them a statement.',
    ].filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== '')).join('\n'),
  };
}
