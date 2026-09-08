import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import {
  fetchOpenArInvoices, fetchOpenVendorBills, fetchAccountGroups, arCustomerKey,
  type OpenArInvoice, type OpenVendorBill,
} from './financials-data';
import { loadPnlPeriods } from './pnl';

/**
 * Cash Outlook — 4-week forward view (R6-12).
 *
 * Week by week: expected collections (open AR placed at the date each
 * customer ACTUALLY pays, from observed days-to-pay, falling back to the
 * stated due date), minus open vendor bills at their due dates, approved
 * installer payouts, and a payroll run-rate — over a projected balance that
 * starts at the real bank total from the financials RESTlet.
 *
 * A cash forecast is the easiest report in the app to make dangerously
 * optimistic, so four rules run through it:
 *
 *  1. NOTHING is placed by assumption. An invoice with neither payment
 *     history nor a due date is UNPLACEABLE and is reported as such — it
 *     never gets dropped into week 1 to make the chart look better.
 *  2. Money already past its expected pay date sits in its own OVERDUE
 *     figure and is NOT added to any week or to the projected balance.
 *     Assuming late money lands next week is exactly the optimism that
 *     sinks a cash forecast; the amount is shown so the reader can decide.
 *  3. Every outflow the app cannot see is NAMED. Payroll runs in a separate
 *     system, so it is modelled from the GL run-rate and labelled as
 *     modelled — and if that number is unavailable, the outlook says the
 *     outflow side is incomplete rather than quietly under-spending.
 *  4. The projected balance is null, not zero, when the bank total could
 *     not be read.
 */

export const HORIZON_WEEKS = 4;
/** Below this many paid invoices a customer's "observed" days-to-pay is
 *  noise; fall back to their stated terms instead. */
export const MIN_PAY_SAMPLES = 2;

export type PlacementBasis = 'history' | 'terms';
export type InflowSource = 'ar_history' | 'ar_terms';
export type OutflowSource = 'vendor_bills' | 'payouts' | 'payroll';

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The America/Chicago calendar date (YYYY-MM-DD) for an instant. */
export function chicagoDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(at);
}

/** The Monday on or before a YYYY-MM-DD date. Weeks are Mon–Sun. */
export function weekStartOf(ymd: string): string {
  const t = Date.parse(`${ymd}T00:00:00Z`);
  const dow = new Date(t).getUTCDay();            // 0 = Sunday
  const backToMonday = dow === 0 ? 6 : dow - 1;
  return new Date(t - backToMonday * DAY).toISOString().slice(0, 10);
}

export function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** The horizon's week starts, beginning with the week containing `today`. */
export function horizonWeeks(today: string, count = HORIZON_WEEKS): string[] {
  const first = weekStartOf(today);
  return Array.from({ length: count }, (_, i) => addDays(first, i * 7));
}

/* ── placement ───────────────────────────────────────────────────────── */

export interface Placement {
  date: string | null;
  basis: PlacementBasis | null;
}

/**
 * When do we expect this invoice's money? Pure.
 *
 * Observed days-to-pay from THIS customer's history wins — a customer who
 * reliably pays at 52 days does not pay at their stated net-30 just because
 * that is what the invoice says. With too little history, the stated due
 * date is the honest fallback. With neither, there is no answer, and null
 * is the answer rather than a guess.
 */
export function placeInvoice(
  inv: { date: string | null; dueDate: string | null; entityId: string | null; customer: string },
  medianDaysByCustomer: Map<string, { days: number; samples: number }>,
): Placement {
  const observed = medianDaysByCustomer.get(arCustomerKey(inv));
  if (observed && observed.samples >= MIN_PAY_SAMPLES && inv.date) {
    return { date: addDays(String(inv.date).slice(0, 10), Math.round(observed.days)), basis: 'history' };
  }
  if (inv.dueDate) return { date: String(inv.dueDate).slice(0, 10), basis: 'terms' };
  return { date: null, basis: null };
}

/** Median days-to-pay per customer key, from paid rows. One sample per
 *  distinct invoice number — a multi-line invoice is one payment event. */
export function medianDaysToPay(
  rows: { key: string; invoice: string | null; invoiced: string | null; paid: string | null }[],
): Map<string, { days: number; samples: number }> {
  const byCustomer = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.key || !r.invoice || !r.invoiced || !r.paid) continue;
    const a = Date.parse(String(r.invoiced).slice(0, 10) + 'T00:00:00Z');
    const b = Date.parse(String(r.paid).slice(0, 10) + 'T00:00:00Z');
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    const days = Math.round((b - a) / DAY);
    if (days < 0 || days > 400) continue;      // hand-entered date errors
    let m = byCustomer.get(r.key);
    if (!m) { m = new Map(); byCustomer.set(r.key, m); }
    if (!m.has(r.invoice)) m.set(r.invoice, days);
  }
  const out = new Map<string, { days: number; samples: number }>();
  for (const [key, invoices] of byCustomer) {
    const days = [...invoices.values()].sort((a, b) => a - b);
    const mid = Math.floor(days.length / 2);
    out.set(key, {
      days: days.length % 2 ? days[mid] : (days[mid - 1] + days[mid]) / 2,
      samples: days.length,
    });
  }
  return out;
}

/* ── bucketing ───────────────────────────────────────────────────────── */

export type Bucket = number | 'overdue' | 'beyond' | 'unplaceable';

/** Which week does a dated amount land in? Pure. */
export function bucketFor(date: string | null, weeks: string[], today: string): Bucket {
  if (!date) return 'unplaceable';
  if (date < today) return 'overdue';
  const lastEnd = addDays(weeks[weeks.length - 1], 7);
  if (date >= lastEnd) return 'beyond';
  for (let i = weeks.length - 1; i >= 0; i--) if (date >= weeks[i]) return i;
  // Dated on or after today but before the first week start is impossible
  // (the first week contains today), so this is unreachable in practice.
  return 0;
}

export interface FlowLine {
  source: InflowSource | OutflowSource;
  amount: number;
  count: number;
}

export interface WeekBucket {
  weekStart: string;
  inflow: number;
  outflow: number;
  net: number;
  /** Null all the way down when the bank balance could not be read — the
   *  deltas are still real, the running total just has no starting point. */
  projectedBalance: number | null;
  inflowDetail: FlowLine[];
  outflowDetail: FlowLine[];
}

export interface SidelinedTotals {
  amount: number;
  count: number;
}

export interface CashOutlook {
  today: string;
  weeks: WeekBucket[];
  startingCash: number | null;
  startingCashError: string | null;
  /** Money whose expected pay date has already passed. Deliberately NOT in
   *  any week and NOT in the projected balance. */
  overdue: SidelinedTotals;
  /** Open AR with no payment history and no due date — unplaceable. */
  unplaceable: SidelinedTotals;
  /** Expected beyond the horizon. */
  beyond: SidelinedTotals;
  coverage: { byHistory: number; byTerms: number; unplaced: number };
  payroll: { weekly: number | null; basis: string | null; error: string | null };
  /** Anything that makes the picture incomplete, in plain words. */
  warnings: string[];
  meta: { horizonWeeks: number; minPaySamples: number; generatedAt: string };
}

const emptyWeek = (weekStart: string): WeekBucket => ({
  weekStart, inflow: 0, outflow: 0, net: 0, projectedBalance: null,
  inflowDetail: [], outflowDetail: [],
});

function addFlow(lines: FlowLine[], source: FlowLine['source'], amount: number) {
  const line = lines.find(l => l.source === source);
  if (line) { line.amount = round2(line.amount + amount); line.count += 1; }
  else lines.push({ source, amount: round2(amount), count: 1 });
}

export interface OutlookInputs {
  today: string;
  invoices: OpenArInvoice[];
  bills: OpenVendorBill[];
  /** Approved-but-unpaid installer payouts. These have no scheduled pay
   *  date, so they land in the current week with that said out loud. */
  payouts: { amount: number }[];
  medianDays: Map<string, { days: number; samples: number }>;
  startingCash: number | null;
  startingCashError: string | null;
  payrollWeekly: number | null;
  payrollBasis: string | null;
  payrollError: string | null;
}

/** Build the whole outlook from already-fetched inputs. Pure — the loader
 *  below only does I/O. */
export function buildOutlook(input: OutlookInputs): CashOutlook {
  const weekStarts = horizonWeeks(input.today);
  const weeks = weekStarts.map(emptyWeek);
  const overdue: SidelinedTotals = { amount: 0, count: 0 };
  const unplaceable: SidelinedTotals = { amount: 0, count: 0 };
  const beyond: SidelinedTotals = { amount: 0, count: 0 };
  const coverage = { byHistory: 0, byTerms: 0, unplaced: 0 };

  for (const inv of input.invoices) {
    const amount = inv.unpaid;
    if (!(amount > 0)) continue;
    const { date, basis } = placeInvoice(inv, input.medianDays);
    if (basis === 'history') coverage.byHistory = round2(coverage.byHistory + amount);
    else if (basis === 'terms') coverage.byTerms = round2(coverage.byTerms + amount);
    else coverage.unplaced = round2(coverage.unplaced + amount);

    const bucket = bucketFor(date, weekStarts, input.today);
    if (bucket === 'unplaceable') { unplaceable.amount = round2(unplaceable.amount + amount); unplaceable.count += 1; continue; }
    if (bucket === 'overdue') { overdue.amount = round2(overdue.amount + amount); overdue.count += 1; continue; }
    if (bucket === 'beyond') { beyond.amount = round2(beyond.amount + amount); beyond.count += 1; continue; }
    weeks[bucket].inflow = round2(weeks[bucket].inflow + amount);
    addFlow(weeks[bucket].inflowDetail, basis === 'history' ? 'ar_history' : 'ar_terms', amount);
  }

  for (const bill of input.bills) {
    const amount = bill.unpaid;
    if (!(amount > 0)) continue;
    const date = bill.dueDate ? String(bill.dueDate).slice(0, 10) : null;
    // A bill with no due date, or already past it, is money we owe NOW —
    // unlike a receivable, an unknown payable is not optional, so it lands
    // in the current week rather than being sidelined.
    const bucket = date ? bucketFor(date, weekStarts, input.today) : 0;
    const idx = bucket === 'overdue' || bucket === 'unplaceable' ? 0 : bucket;
    if (idx === 'beyond') continue;
    weeks[idx as number].outflow = round2(weeks[idx as number].outflow + amount);
    addFlow(weeks[idx as number].outflowDetail, 'vendor_bills', amount);
  }

  for (const p of input.payouts) {
    if (!(p.amount > 0)) continue;
    weeks[0].outflow = round2(weeks[0].outflow + p.amount);
    addFlow(weeks[0].outflowDetail, 'payouts', p.amount);
  }

  if (input.payrollWeekly != null && input.payrollWeekly > 0) {
    for (const w of weeks) {
      w.outflow = round2(w.outflow + input.payrollWeekly);
      addFlow(w.outflowDetail, 'payroll', input.payrollWeekly);
    }
  }

  let balance = input.startingCash;
  for (const w of weeks) {
    w.net = round2(w.inflow - w.outflow);
    if (balance == null) w.projectedBalance = null;
    else { balance = round2(balance + w.net); w.projectedBalance = balance; }
  }

  const warnings: string[] = [];
  if (input.startingCash == null) {
    warnings.push(`No bank balance available${input.startingCashError ? ` (${input.startingCashError})` : ''} — the weekly swings below are real, but there is no running balance to put them against.`);
  }
  if (input.payrollWeekly == null) {
    warnings.push(`Payroll is NOT in these outflows${input.payrollError ? ` (${input.payrollError})` : ''} — it runs in a separate system, so the outflow side is understated by roughly a payroll per fortnight.`);
  }
  if (unplaceable.count > 0) {
    warnings.push(`${unplaceable.count} open invoice${unplaceable.count === 1 ? '' : 's'} have neither payment history nor a due date, so nothing here says when that money arrives.`);
  }
  if (overdue.count > 0) {
    warnings.push(`${overdue.count} invoice${overdue.count === 1 ? ' is' : 's are'} already past the date this customer normally pays. That money is NOT counted in any week below.`);
  }

  return {
    today: input.today,
    weeks,
    startingCash: input.startingCash,
    startingCashError: input.startingCashError,
    overdue, unplaceable, beyond, coverage,
    payroll: { weekly: input.payrollWeekly, basis: input.payrollBasis, error: input.payrollError },
    warnings,
    meta: { horizonWeeks: HORIZON_WEEKS, minPaySamples: MIN_PAY_SAMPLES, generatedAt: new Date().toISOString() },
  };
}

/* ── loader ──────────────────────────────────────────────────────────── */

/** Every source fails independently — a dead RESTlet costs the balance
 *  line and the payroll line, not the whole report. */
export async function loadCashOutlook(service: SupabaseClient): Promise<CashOutlook> {
  const today = chicagoDate();

  const [arRes, billRes, cashRes, pnlRes, fleetPaid, scanPaid, payoutRes] = await Promise.allSettled([
    fetchOpenArInvoices(),
    fetchOpenVendorBills(),
    fetchAccountGroups(),
    loadPnlPeriods(),
    fetchAllRows<any>((from, to) => service
      .from('fleet_checkins')
      .select('customer_name, customer_netsuite_id, invoice_number, date_invoiced, paid_at')
      .not('paid_at', 'is', null).not('date_invoiced', 'is', null)
      .order('id').range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('scan_logs')
      .select('billable_customer, invoice_number, date_invoiced, paid_at')
      .not('paid_at', 'is', null).not('date_invoiced', 'is', null)
      .order('id').range(from, to)),
    fetchAllRows<any>((from, to) => service
      .from('payouts')
      .select('total_amount, status')
      .in('status', ['approved', 'billed'])
      .order('id').range(from, to)),
  ]);

  const invoices = arRes.status === 'fulfilled' ? arRes.value.invoices : [];
  const bills = billRes.status === 'fulfilled' ? billRes.value.bills : [];

  let startingCash: number | null = null;
  let startingCashError: string | null = null;
  if (cashRes.status === 'fulfilled' && cashRes.value.success) {
    const bank = cashRes.value.bank.filter(a => a.balance != null);
    startingCash = bank.length ? round2(bank.reduce((s, a) => s + (a.balance || 0), 0)) : null;
    if (!bank.length) startingCashError = 'no bank account balances returned';
  } else {
    startingCashError = cashRes.status === 'fulfilled'
      ? (cashRes.value.error || 'financials RESTlet unavailable')
      : 'financials RESTlet unavailable';
  }

  const { weekly: payrollWeekly, basis: payrollBasis, error: payrollError } = payrollRunRate(pnlRes);

  // Payment history keyed the same way the AR aging keys customers, so a
  // customer's observed days-to-pay actually reaches their open invoices.
  // scan_logs has no NetSuite id, so those rows key by name — which matches
  // arCustomerKey's own fallback for invoices with no entity id.
  const paidRows = [
    ...(fleetPaid.status === 'fulfilled' ? fleetPaid.value.data : []).map((r: any) => ({
      key: r.customer_netsuite_id ? `e:${r.customer_netsuite_id}` : `n:${(r.customer_name || '').trim()}`,
      invoice: r.invoice_number, invoiced: r.date_invoiced, paid: r.paid_at,
    })),
    ...(scanPaid.status === 'fulfilled' ? scanPaid.value.data : []).map((r: any) => ({
      key: `n:${(r.billable_customer || '').trim()}`,
      invoice: r.invoice_number, invoiced: r.date_invoiced, paid: r.paid_at,
    })),
  ].filter(r => r.key !== 'n:');

  const payouts = (payoutRes.status === 'fulfilled' ? payoutRes.value.data : [])
    .map((p: any) => ({ amount: Number(p.total_amount) || 0 }));

  const outlook = buildOutlook({
    today, invoices, bills, payouts,
    medianDays: medianDaysToPay(paidRows),
    startingCash, startingCashError,
    payrollWeekly, payrollBasis, payrollError,
  });

  if (arRes.status === 'rejected') {
    outlook.warnings.unshift('Open invoices could not be read from NetSuite — there are NO collections in this forecast.');
  }
  if (billRes.status === 'rejected') {
    outlook.warnings.unshift('Open vendor bills could not be read from NetSuite — payables are missing from these outflows.');
  }
  return outlook;
}

/**
 * A weekly payroll figure from the GL. FleetSuite does not know the shop's
 * pay dates (payroll lives in another system), so this is deliberately a
 * SMOOTHED weekly run-rate off recent months rather than a fortnightly
 * spike on a date we would be inventing. Over a 4-week horizon the total is
 * the same; only the shape inside a fortnight is approximate, and the page
 * says so.
 */
export interface PayrollPeriodish {
  directional: boolean;
  pnl: { payroll: number } | null;
}

export function payrollRunRate(
  pnlRes: PromiseSettledResult<{ periods: PayrollPeriodish[]; payrollConfigured: boolean }>,
): { weekly: number | null; basis: string | null; error: string | null } {
  if (pnlRes.status === 'rejected') {
    return { weekly: null, basis: null, error: 'P&L RESTlet unavailable' };
  }
  if (!pnlRes.value.payrollConfigured) {
    return { weekly: null, basis: null, error: 'no payroll accounts configured (NETSUITE_PAYROLL_ACCOUNT_IDS)' };
  }
  // Only CLOSED periods. A month-to-date figure is a partial month, and
  // averaging it in would drag the run-rate below what payroll costs.
  const months = (pnlRes.value.periods || [])
    .filter(p => !p.directional && p.pnl && Number.isFinite(p.pnl.payroll) && p.pnl.payroll > 0)
    .map(p => p.pnl!.payroll);
  if (months.length === 0) {
    return { weekly: null, basis: null, error: 'no payroll posted in the closed periods returned' };
  }
  const monthly = months.reduce((s, v) => s + v, 0) / months.length;
  return {
    weekly: round2((monthly * 12) / 52),
    basis: `${months.length}-month GL average, smoothed weekly`,
    error: null,
  };
}
