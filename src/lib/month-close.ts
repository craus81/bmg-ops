import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { deepLinks } from './deep-links';

/**
 * Month-End Close Cockpit (R6-12).
 *
 * One page per accounting month, with the questions a close actually asks:
 * is everything finished in the month billed, is the AP/payout pipeline
 * drained, did a money email bounce and never get fixed, and have the
 * checks that live in NetSuite been done by a person.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: a gate the app did not evaluate is
 * never a pass. There are five states and they are all distinguishable —
 *
 *   pass          computed, and clean
 *   fail          computed, and there is work outstanding
 *   unknown       the query FAILED. Not clean, not dirty — unmeasured.
 *   pending       a manual gate nobody has signed off yet
 *   acknowledged  a manual gate a person signed off
 *   waived        a FAILING computed gate a person accepted, with a reason
 *
 * A waiver is not a pass. It renders as a failure someone took
 * responsibility for, and the count of outstanding items stays visible.
 * `unknown` can never be waived or closed over — you cannot accept a
 * number you were never shown.
 */

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export type GateKind = 'computed' | 'manual';
export type GateState = 'pass' | 'fail' | 'unknown' | 'pending' | 'acknowledged' | 'waived';

export interface GateDef {
  key: string;
  title: string;
  /** What a pass means, in the language the person closing the month uses. */
  passMeans: string;
  /** Where to go do the work. Always a real destination, never a list page
   *  when a queue exists. */
  link: string;
  fixLabel: string;
  kind: GateKind;
  /** Manual gates say WHY the app can't compute them — otherwise "sign this
   *  off" reads like busywork. */
  manualBecause?: string;
}

export const CLOSE_GATES: GateDef[] = [
  {
    key: 'vehicles_invoiced',
    title: 'Every vehicle finished this month is invoiced',
    passMeans: 'No vehicle completed or shipped in the month is missing an invoice.',
    link: deepLinks.neverInvoicedQueue(),
    fixLabel: 'Open the recovery queue',
    kind: 'computed',
  },
  {
    key: 'graphics_invoiced',
    title: 'Every graphics job delivered this month is invoiced',
    passMeans: 'No graphics job shipped, picked up or installed in the month is missing its NetSuite invoice.',
    link: '/invoices',
    fixLabel: 'Open the invoicing hub',
    kind: 'computed',
  },
  {
    key: 'ap_approved_not_billed',
    title: 'No vendor bill stuck at approved',
    passMeans: 'Every vendor invoice approved on or before month end has been billed into NetSuite.',
    link: '/admin/ap',
    fixLabel: 'Open the AP queue',
    kind: 'computed',
  },
  {
    key: 'payouts_billed_not_paid',
    title: 'No installer payout stuck at billed',
    passMeans: 'Every payout billed on or before month end has been marked paid.',
    link: '/admin/cni/payouts',
    fixLabel: 'Open payouts',
    kind: 'computed',
  },
  {
    key: 'money_email_bounces',
    title: 'No unresolved bounce on an invoice or statement',
    passMeans: 'Every invoice/statement email that bounced, was complained about, or failed in the month has been resolved.',
    link: deepLinks.emailDelivery(),
    fixLabel: 'Open email delivery',
    kind: 'computed',
  },
  {
    key: 'reconciliation',
    title: 'Invoice reconciliation deltas resolved',
    passMeans: 'The FleetSuite↔NetSuite invoice reconciliation for the month shows no unexplained delta.',
    link: '/admin/reports/invoice-reconciliation',
    fixLabel: 'Run reconciliation',
    kind: 'manual',
    manualBecause: 'The comparison runs live against NetSuite (SuiteQL) — the cockpit will not claim a result it did not fetch.',
  },
  {
    key: 'invoice_locations',
    title: 'Invoice locations and PO references backfilled',
    passMeans: 'No invoice for the month is missing its NetSuite location or PO reference.',
    link: '/admin/invoice-locations',
    fixLabel: 'Open invoice locations',
    kind: 'manual',
    manualBecause: 'Location and PO live on the NetSuite invoice record, not in FleetSuite — the backfill tool is the only thing that can see them.',
  },
];

export const GATE_BY_KEY = new Map(CLOSE_GATES.map(g => [g.key, g]));

/* ── periods ─────────────────────────────────────────────────────────── */

/** 'YYYY-MM' for a date on the shop calendar (America/Chicago), matching
 *  the calendar exec-metrics snapshots on. */
export function periodFor(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' })
    .format(at).slice(0, 7);
}

export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number);
  const idx = y * 12 + (m - 1) + months;
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/**
 * UTC instants bounding a shop-calendar month. Chicago is UTC-6/-5, so a
 * month runs from 05:00/06:00Z on the 1st to the same on the 1st of the
 * next month — computing bounds in plain UTC would pull the last evening
 * of the previous month into this one and drop this month's last evening.
 */
export function monthBounds(period: string): { startIso: string; endIso: string; label: string } {
  if (!PERIOD_RE.test(period)) throw new Error(`Invalid period: ${period}`);
  const start = chicagoMidnightUtc(`${period}-01`);
  const end = chicagoMidnightUtc(`${shiftPeriod(period, 1)}-01`);
  const [y, m] = period.split('-').map(Number);
  const label = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { startIso: start, endIso: end, label };
}

/** The UTC instant of midnight America/Chicago on a YYYY-MM-DD date. */
function chicagoMidnightUtc(ymd: string): string {
  // Start from the naive UTC midnight, then correct by the zone's offset at
  // that moment (which absorbs DST — the correction is read from the very
  // date being converted, not assumed). Reading the offset at UTC midnight
  // on the 1st is safe for MONTH boundaries specifically: US transitions
  // land on a Sunday in March and November at 2am local, never on the
  // 6-7pm-local instant this looks at.
  const naive = Date.parse(`${ymd}T00:00:00Z`);
  const offsetMin = chicagoOffsetMinutes(new Date(naive));
  return new Date(naive + offsetMin * 60_000).toISOString();
}

/** Minutes to ADD to a UTC instant to get the same wall clock in Chicago's
 *  offset — 300 during CST (UTC-6), 240 during CDT (UTC-5). */
function chicagoOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', timeZoneName: 'shortOffset',
  }).formatToParts(at);
  const name = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-6';
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!m) return 360;
  const sign = m[1] === '-' ? 1 : -1;   // UTC-6 → add 6h to reach that wall clock in UTC
  return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/* ── gate evaluation (pure) ──────────────────────────────────────────── */

/** What a computed gate's query found. `count: null` means the read FAILED. */
export interface GateFinding {
  count: number | null;
  /** A few example records, for the "what exactly" line under the gate. */
  examples?: { label: string; url?: string }[];
  error?: string | null;
}

export interface GateSignoff {
  kind: 'acknowledged' | 'waived';
  note: string | null;
  signedByName: string | null;
  signedAt: string;
}

export interface GateResult extends GateDef {
  state: GateState;
  count: number | null;
  examples: { label: string; url?: string }[];
  error: string | null;
  signoff: GateSignoff | null;
}

/**
 * Resolve one gate's state. Pure.
 *
 * A manual gate has no count — it is pending until acknowledged. A computed
 * gate whose read failed is `unknown` and a sign-off CANNOT rescue it: you
 * cannot waive a number you were never shown, so a stale waiver on an
 * unmeasured gate is ignored rather than allowed to look like acceptance.
 */
export function resolveGate(
  def: GateDef,
  finding: GateFinding | null,
  signoff: GateSignoff | null,
): GateResult {
  const base = {
    ...def,
    count: finding?.count ?? null,
    examples: finding?.examples || [],
    error: finding?.error || null,
    signoff,
  };
  if (def.kind === 'manual') {
    return { ...base, count: null, state: signoff?.kind === 'acknowledged' ? 'acknowledged' : 'pending' };
  }
  if (!finding || finding.count == null) return { ...base, state: 'unknown', signoff: null };
  if (finding.count === 0) return { ...base, state: 'pass' };
  return { ...base, state: signoff?.kind === 'waived' ? 'waived' : 'fail' };
}

/** States that no longer stand in the way of closing the month. */
const SETTLED: GateState[] = ['pass', 'acknowledged', 'waived'];

export interface CloseVerdict {
  ready: boolean;
  blocking: GateResult[];
  /** Gates that are settled only because someone accepted them — the close
   *  summary names these, so "closed" never reads as "all clean". */
  waived: GateResult[];
  unmeasured: GateResult[];
  passed: number;
}

export function closeVerdict(gates: GateResult[]): CloseVerdict {
  const blocking = gates.filter(g => !SETTLED.includes(g.state));
  return {
    ready: blocking.length === 0,
    blocking,
    waived: gates.filter(g => g.state === 'waived'),
    unmeasured: gates.filter(g => g.state === 'unknown'),
    passed: gates.filter(g => g.state === 'pass').length,
  };
}

/* ── loader ──────────────────────────────────────────────────────────── */

export interface MonthClose {
  period: string;
  label: string;
  gates: GateResult[];
  verdict: CloseVerdict;
  closed: {
    closedByName: string | null;
    closedAt: string;
    note: string | null;
  } | null;
  /** True when `gates` came out of the close snapshot rather than a fresh
   *  read — the page says so rather than implying live numbers. */
  fromSnapshot: boolean;
  meta: { startIso: string; endIso: string; generatedAt: string };
}

const MONEY_EMAIL_KINDS = ['invoice', 'statement'];
const FAILED_DELIVERY = ['bounced', 'complained', 'failed'];
const GRAPHICS_DELIVERED = ['shipped', 'picked_up', 'installed'];

/** Run one gate's read, turning any throw into `count: null` (unknown) —
 *  a failed query must never be reported as a clean gate. */
async function finding(fn: () => Promise<GateFinding>): Promise<GateFinding> {
  try {
    return await fn();
  } catch (e: any) {
    return { count: null, error: String(e?.message || e).slice(0, 300) };
  }
}

export async function loadMonthClose(service: SupabaseClient, period: string): Promise<MonthClose> {
  const { startIso, endIso, label } = monthBounds(period);

  const [signoffRes, closedRes] = await Promise.all([
    service.from('month_close_gate_signoffs')
      .select('gate_key, kind, note, signed_by_name, signed_at')
      .eq('period', period),
    service.from('month_close_periods')
      .select('period, closed_by_name, closed_at, note, gate_snapshot, reopened_at')
      .eq('period', period)
      .maybeSingle(),
  ]);

  const signoffs = new Map<string, GateSignoff>();
  for (const r of signoffRes.data || []) {
    signoffs.set(r.gate_key, {
      kind: r.kind, note: r.note || null,
      signedByName: r.signed_by_name || null, signedAt: r.signed_at,
    });
  }

  const closedRow = closedRes.data && !closedRes.data.reopened_at ? closedRes.data : null;
  if (closedRow) {
    // A closed month renders from the snapshot taken at close time. A fresh
    // recomputation a year later would tell a different story about a month
    // that is already signed and filed.
    const snap = (closedRow.gate_snapshot || {}) as { gates?: GateResult[] };
    const gates = Array.isArray(snap.gates) && snap.gates.length ? snap.gates : [];
    if (gates.length) {
      return {
        period, label, gates, verdict: closeVerdict(gates),
        closed: { closedByName: closedRow.closed_by_name || null, closedAt: closedRow.closed_at, note: closedRow.note || null },
        fromSnapshot: true,
        meta: { startIso, endIso, generatedAt: closedRow.closed_at },
      };
    }
  }

  const findings = await computeFindings(service, startIso, endIso);
  const gates = CLOSE_GATES.map(def => resolveGate(def, findings.get(def.key) || null, signoffs.get(def.key) || null));

  return {
    period, label, gates, verdict: closeVerdict(gates),
    closed: closedRow
      ? { closedByName: closedRow.closed_by_name || null, closedAt: closedRow.closed_at, note: closedRow.note || null }
      : null,
    fromSnapshot: false,
    meta: { startIso, endIso, generatedAt: new Date().toISOString() },
  };
}

/** Every computed gate's read, each failing independently. */
export async function computeFindings(
  service: SupabaseClient,
  startIso: string,
  endIso: string,
): Promise<Map<string, GateFinding>> {
  const [vehicles, graphics, ap, payouts, emails] = await Promise.all([
    finding(() => vehiclesNotInvoiced(service, startIso, endIso)),
    finding(() => graphicsNotInvoiced(service, startIso, endIso)),
    finding(() => apApprovedNotBilled(service, endIso)),
    finding(() => payoutsBilledNotPaid(service, endIso)),
    finding(() => unresolvedMoneyBounces(service, startIso, endIso)),
  ]);
  return new Map<string, GateFinding>([
    ['vehicles_invoiced', vehicles],
    ['graphics_invoiced', graphics],
    ['ap_approved_not_billed', ap],
    ['payouts_billed_not_paid', payouts],
    ['money_email_bounces', emails],
  ]);
}

const EXAMPLES = 5;

/** Vehicles COMPLETED in the month (by status event, not check-in date)
 *  that carry no invoice — the never-invoiced predicate, scoped to one
 *  month rather than a rolling window. */
async function vehiclesNotInvoiced(service: SupabaseClient, startIso: string, endIso: string): Promise<GateFinding> {
  const { data: events, error } = await fetchAllRows<{ vehicle_id: string }>((from, to) => service
    .from('vehicle_status_history')
    .select('vehicle_id')
    .in('to_status', ['complete', 'shipped'])
    .gte('created_at', startIso).lt('created_at', endIso)
    .order('created_at').order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  const ids = [...new Set((events || []).map(e => e.vehicle_id))];
  if (ids.length === 0) return { count: 0 };

  const open: { label: string; url: string }[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const [chkRes, invRes] = await Promise.all([
      service.from('fleet_checkins')
        .select('id, vin, customer_name, invoice_number')
        .in('id', slice),
      service.from('fleet_checkin_invoices')
        .select('fleet_checkin_id')
        .in('fleet_checkin_id', slice)
        .not('invoice_number', 'is', null),
    ]);
    if (chkRes.error) throw new Error(chkRes.error.message);
    if (invRes.error) throw new Error(invRes.error.message);
    const billed = new Set((invRes.data || []).map(r => r.fleet_checkin_id));
    for (const c of chkRes.data || []) {
      if (c.invoice_number || billed.has(c.id)) continue;
      open.push({ label: `${c.vin}${c.customer_name ? ` · ${c.customer_name}` : ''}`, url: deepLinks.vehicle(c.id) });
    }
  }
  return { count: open.length, examples: open.slice(0, EXAMPLES) };
}

async function graphicsNotInvoiced(service: SupabaseClient, startIso: string, endIso: string): Promise<GateFinding> {
  const { data: events, error } = await fetchAllRows<{ job_id: string }>((from, to) => service
    .from('graphics_status_history')
    .select('job_id')
    .in('to_status', GRAPHICS_DELIVERED)
    .gte('created_at', startIso).lt('created_at', endIso)
    .order('created_at').order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  const ids = [...new Set((events || []).map(e => e.job_id))];
  if (ids.length === 0) return { count: 0 };

  const open: { label: string; url: string }[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error: jErr } = await service
      .from('graphics_jobs')
      .select('id, job_number, title, customer, status, netsuite_invoice_id')
      .in('id', ids.slice(i, i + 200))
      .is('netsuite_invoice_id', null)
      .neq('status', 'cancelled');
    if (jErr) throw new Error(jErr.message);
    for (const j of data || []) {
      open.push({
        label: `${j.job_number || j.title || j.id}${j.customer ? ` · ${j.customer}` : ''}`,
        url: deepLinks.graphicsJob(j.id),
      });
    }
  }
  return { count: open.length, examples: open.slice(0, EXAMPLES) };
}

/** Bills approved on or before month end that never became a NetSuite bill.
 *  Not scoped to the month's start: a bill approved in March and still
 *  unbilled in June blocks June's close too — that is the point of the gate. */
async function apApprovedNotBilled(service: SupabaseClient, endIso: string): Promise<GateFinding> {
  const { data, error } = await fetchAllRows<any>((from, to) => service
    .from('vendor_invoices')
    .select('id, invoice_number, vendor_name, total_amount, approved_at')
    .eq('status', 'approved')
    .lt('approved_at', endIso)
    .order('approved_at').order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  const rows = data || [];
  return {
    count: rows.length,
    examples: rows.slice(0, EXAMPLES).map(r => ({
      label: `${r.invoice_number || 'no number'} · ${r.vendor_name}`,
      url: deepLinks.apInvoice(r.id),
    })),
  };
}

async function payoutsBilledNotPaid(service: SupabaseClient, endIso: string): Promise<GateFinding> {
  const { data, error } = await fetchAllRows<any>((from, to) => service
    .from('payouts')
    .select('id, total_amount, kind, period_start, period_end, created_at, netsuite_bill_id')
    .eq('status', 'billed')
    .lt('created_at', endIso)
    .order('created_at').order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  const rows = data || [];
  return {
    count: rows.length,
    examples: rows.slice(0, EXAMPLES).map(r => ({
      label: `${r.kind === 'payroll_period' ? `${r.period_start || '?'} – ${r.period_end || '?'}` : 'CNI job payout'}${r.total_amount != null ? ` · $${Number(r.total_amount).toFixed(2)}` : ''}`,
      url: '/admin/cni/payouts',
    })),
  };
}

async function unresolvedMoneyBounces(service: SupabaseClient, startIso: string, endIso: string): Promise<GateFinding> {
  const { data, error } = await fetchAllRows<any>((from, to) => service
    .from('email_log')
    .select('id, kind, subject, recipients, delivery_status, context_url, created_at')
    .in('kind', MONEY_EMAIL_KINDS)
    .in('delivery_status', FAILED_DELIVERY)
    .is('resolved_at', null)
    .gte('created_at', startIso).lt('created_at', endIso)
    .order('created_at').order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  const rows = data || [];
  return {
    count: rows.length,
    examples: rows.slice(0, EXAMPLES).map(r => ({
      label: `${r.delivery_status} · ${(r.recipients || []).join(', ') || 'no recipient'}${r.subject ? ` — ${r.subject}` : ''}`,
      // The record the email was about beats the delivery log whenever the
      // send recorded one — fixing the contact is done on the record.
      url: r.context_url || deepLinks.emailDelivery(r.id),
    })),
  };
}
