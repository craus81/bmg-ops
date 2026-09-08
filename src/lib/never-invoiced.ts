import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { deepLinks } from './deep-links';

/**
 * Never-Invoiced Recovery Queue (R6-12).
 *
 * The CEO band and the dashboard have counted this leak for a while
 * (`loadNeverInvoicedCount`) but the tile landed whoever clicked it on the
 * whole In-Shop board with no hint which vehicles were leaking or what each
 * one needed. This is the queue behind that number: every completed/shipped
 * vehicle with no invoice anywhere, oldest first, BUCKETED by the work it
 * actually needs — an SO is already linked (one click), only an estimate
 * exists (someone has to convert it), or there is no paperwork at all
 * (a human has to go find out what was done).
 *
 * Two honesty rules run through this file:
 *  - The headline predicate is IDENTICAL to `loadNeverInvoicedCount`'s
 *    (status complete/shipped, legacy scalar null, no stamped ledger row,
 *    same window, archived rows stay in) so the queue and the tile can
 *    never disagree about how many vehicles are leaking.
 *  - An unknown amount is null, never 0. A vehicle whose SO total never
 *    mirrored is worth an unknown amount, not nothing, and the UI must be
 *    able to tell those apart — so `expectedAmount` carries `amountPartial`
 *    whenever some of the linked paperwork had no total on it.
 */

export const NEVER_INVOICED_WINDOW_DAYS = 180;

export type RecoveryBucket = 'has_so' | 'estimate_only' | 'no_paperwork';

export const BUCKET_LABEL: Record<RecoveryBucket, string> = {
  has_so: 'Has a sales order — invoice it',
  estimate_only: 'Estimate needs converting',
  no_paperwork: 'No paperwork — assign a human',
};

export const BUCKET_HELP: Record<RecoveryBucket, string> = {
  has_so: 'A linked sales order has never been invoiced. Open the vehicle and use Invoice SO.',
  estimate_only: 'An estimate is linked but no sales order is. Someone has to accept/convert it before it can be billed.',
  no_paperwork: 'Neither a sales order nor an estimate is linked. Find out what was done to this vehicle before anything can be billed.',
};

export interface RecoverySalesOrder {
  netsuiteId: string;
  number: string | null;
  total: number | null;
  invoiced: boolean;
  invoiceNumber: string | null;
}

export interface RecoveryEstimate {
  id: string;
  number: string | null;
  status: string | null;
  total: number | null;
}

export interface RecoveryInput {
  salesOrders: RecoverySalesOrder[];
  estimates: RecoveryEstimate[];
}

export interface RecoveryClassification {
  bucket: RecoveryBucket;
  /** Sum of the open paperwork's totals. Null when NOTHING carried a total. */
  expectedAmount: number | null;
  /** True when at least one open record had no total — the sum is a floor. */
  amountPartial: boolean;
  amountSource: 'sales_order' | 'estimate' | null;
}

/**
 * What does this vehicle need before it can be billed? Pure — the loader
 * below and the tests both drive it.
 *
 * `has_so` wins whenever an uninvoiced sales order is linked, even if an
 * estimate is linked too: the SO is the billable document, and routing that
 * vehicle to "convert the estimate" would send someone to redo work that is
 * already done.
 */
export function classifyRecovery(input: RecoveryInput): RecoveryClassification {
  const openSos = input.salesOrders.filter(so => !so.invoiced);
  if (openSos.length > 0) {
    const totals = openSos.map(so => so.total).filter((t): t is number => t != null);
    return {
      bucket: 'has_so',
      expectedAmount: totals.length ? round2(totals.reduce((a, b) => a + b, 0)) : null,
      amountPartial: totals.length > 0 && totals.length < openSos.length,
      amountSource: totals.length ? 'sales_order' : null,
    };
  }
  if (input.estimates.length > 0) {
    const totals = input.estimates.map(e => e.total).filter((t): t is number => t != null && t > 0);
    return {
      bucket: 'estimate_only',
      expectedAmount: totals.length ? round2(Math.max(...totals)) : null,
      amountPartial: false,
      amountSource: totals.length ? 'estimate' : null,
    };
  }
  return { bucket: 'no_paperwork', expectedAmount: null, amountPartial: false, amountSource: null };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface RecoveryRow extends RecoveryClassification {
  checkinId: string;
  vin: string;
  vehicle: string | null;
  customerName: string | null;
  status: string;
  /** When the vehicle was marked complete/shipped. Null when no status event
   *  was ever written (pre-history rows) — days-since is null too, NOT 0. */
  completedAt: string | null;
  daysSince: number | null;
  salesOrders: RecoverySalesOrder[];
  estimates: RecoveryEstimate[];
  url: string;
}

export interface RecoveryQueue {
  rows: RecoveryRow[];
  /** Vehicles where SOME sales orders billed and others never did. NOT part
   *  of `rows` or the headline count — the dashboard tile counts vehicles
   *  with no invoice anywhere, and this queue must not drift from it — but
   *  it is the same leak, so it is surfaced rather than dropped. */
  partiallyInvoiced: RecoveryRow[];
  totals: {
    count: number;
    /** Sum of every KNOWN expected amount. `unknownAmountCount` says how
     *  many rows contributed nothing because their total is unknown. */
    expectedTotal: number;
    unknownAmountCount: number;
    byBucket: Record<RecoveryBucket, { count: number; expectedTotal: number }>;
    oldestDays: number | null;
    partiallyInvoicedCount: number;
  };
  meta: { windowDays: number; generatedAt: string };
}

const vehicleLabel = (c: { vehicle_year?: string | null; vehicle_make?: string | null; vehicle_model?: string | null }) =>
  [c.vehicle_year, c.vehicle_make, c.vehicle_model].filter(Boolean).join(' ') || null;

/**
 * Build the queue. Every read paginates (`fetchAllRows` / chunked `.in()`)
 * — a shop doing volume blows past PostgREST's 1000-row cap on the
 * check-in, SO-link and status-history reads alike.
 */
export async function loadNeverInvoicedQueue(
  service: SupabaseClient,
  opts: { windowDays?: number } = {},
): Promise<RecoveryQueue> {
  const windowDays = opts.windowDays ?? NEVER_INVOICED_WINDOW_DAYS;
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  // Same predicate as loadNeverInvoicedCount: complete/shipped, no legacy
  // scalar invoice, inside the window, archived rows included.
  const { data: checkins, error } = await fetchAllRows<any>((from, to) => service
    .from('fleet_checkins')
    .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, status, created_at, netsuite_sales_order_id, sales_order_number, sales_order_total, source_estimate_id')
    .in('status', ['complete', 'shipped'])
    .is('invoice_number', null)
    .gte('created_at', cutoff)
    .order('id')
    .range(from, to));
  if (error) throw new Error(error.message);

  const rowsIn = checkins || [];
  const ids = rowsIn.map(c => c.id);
  const empty: RecoveryQueue = {
    rows: [], partiallyInvoiced: [],
    totals: {
      count: 0, expectedTotal: 0, unknownAmountCount: 0,
      byBucket: {
        has_so: { count: 0, expectedTotal: 0 },
        estimate_only: { count: 0, expectedTotal: 0 },
        no_paperwork: { count: 0, expectedTotal: 0 },
      },
      oldestDays: null, partiallyInvoicedCount: 0,
    },
    meta: { windowDays, generatedAt: new Date().toISOString() },
  };
  if (ids.length === 0) return empty;

  const soByCheckin = new Map<string, RecoverySalesOrder[]>();
  const invoicedSo = new Map<string, Set<string>>();
  const estByCheckin = new Map<string, RecoveryEstimate[]>();
  const completedAt = new Map<string, string>();

  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const [soRes, invRes, estRes, histRes] = await Promise.all([
      fetchAllRows<any>((from, to) => service
        .from('fleet_checkin_sales_orders')
        .select('checkin_id, netsuite_sales_order_id, sales_order_number, sales_order_total')
        .in('checkin_id', slice).order('checkin_id').order('id').range(from, to)),
      fetchAllRows<any>((from, to) => service
        .from('fleet_checkin_invoices')
        .select('fleet_checkin_id, netsuite_sales_order_id, invoice_number')
        .in('fleet_checkin_id', slice)
        .not('invoice_number', 'is', null)
        .order('fleet_checkin_id').order('id').range(from, to)),
      fetchAllRows<any>((from, to) => service
        .from('estimates')
        .select('id, estimate_number, status, grand_total, fleet_checkin_id')
        .in('fleet_checkin_id', slice).order('fleet_checkin_id').order('id').range(from, to)),
      fetchAllRows<any>((from, to) => service
        .from('vehicle_status_history')
        .select('vehicle_id, to_status, created_at')
        .in('vehicle_id', slice)
        .in('to_status', ['complete', 'shipped'])
        .order('created_at', { ascending: false }).order('id').range(from, to)),
    ]);
    for (const r of [soRes, invRes, estRes, histRes]) if (r.error) throw new Error(r.error.message);

    for (const r of invRes.data || []) {
      const set = invoicedSo.get(r.fleet_checkin_id) || new Set<string>();
      set.add(String(r.netsuite_sales_order_id));
      invoicedSo.set(r.fleet_checkin_id, set);
    }
    for (const r of soRes.data || []) {
      const arr = soByCheckin.get(r.checkin_id) || [];
      arr.push({
        netsuiteId: String(r.netsuite_sales_order_id),
        number: r.sales_order_number || null,
        total: r.sales_order_total == null ? null : Number(r.sales_order_total),
        invoiced: false,
        invoiceNumber: null,
      });
      soByCheckin.set(r.checkin_id, arr);
    }
    for (const r of estRes.data || []) {
      const arr = estByCheckin.get(r.fleet_checkin_id) || [];
      arr.push({
        id: r.id,
        number: r.estimate_number || null,
        status: r.status || null,
        total: r.grand_total == null ? null : Number(r.grand_total),
      });
      estByCheckin.set(r.fleet_checkin_id, arr);
    }
    // Descending scan → the LATEST completion event per vehicle wins. A
    // returning vehicle (m229) is on its newest visit, so the newest
    // completion is the one this row is about.
    for (const r of histRes.data || []) {
      if (!completedAt.has(r.vehicle_id)) completedAt.set(r.vehicle_id, r.created_at);
    }
  }

  const now = Date.now();
  const rows: RecoveryRow[] = [];
  const partiallyInvoiced: RecoveryRow[] = [];

  for (const c of rowsIn) {
    const invoiced = invoicedSo.get(c.id) || new Set<string>();
    const linked = soByCheckin.get(c.id) || [];
    // The legacy scalar columns mirror the OLDEST linked SO (m100). If the
    // join table has no row at all (a pre-m100 check-in whose backfill was
    // skipped, or a link written straight to the scalar), fall back to it —
    // otherwise a vehicle WITH an SO gets routed to "no paperwork" and a
    // human is sent to rediscover work that is already on file.
    const salesOrders: RecoverySalesOrder[] = linked.length > 0
      ? linked
      : (c.netsuite_sales_order_id
        ? [{
          netsuiteId: String(c.netsuite_sales_order_id),
          number: c.sales_order_number || null,
          total: c.sales_order_total == null ? null : Number(c.sales_order_total),
          invoiced: false,
          invoiceNumber: null,
        }]
        : []);
    for (const so of salesOrders) so.invoiced = invoiced.has(so.netsuiteId);

    const estimates = estByCheckin.get(c.id) || [];
    const done = completedAt.get(c.id) || null;
    const cls = classifyRecovery({ salesOrders, estimates });
    const row: RecoveryRow = {
      checkinId: c.id,
      vin: c.vin,
      vehicle: vehicleLabel(c),
      customerName: c.customer_name || null,
      status: c.status,
      completedAt: done,
      daysSince: done ? Math.floor((now - Date.parse(done)) / 86_400_000) : null,
      salesOrders,
      estimates,
      url: deepLinks.vehicle(c.id),
      ...cls,
    };
    if (salesOrders.length > 0 && salesOrders.some(so => so.invoiced)) partiallyInvoiced.push(row);
    else rows.push(row);
  }

  // Oldest first — a vehicle with no completion event on file sorts last
  // (unknown age is not "brand new", but it also can't jump the queue).
  const byAge = (a: RecoveryRow, b: RecoveryRow) =>
    (b.daysSince ?? -1) - (a.daysSince ?? -1);
  rows.sort(byAge);
  partiallyInvoiced.sort(byAge);

  const byBucket = {
    has_so: { count: 0, expectedTotal: 0 },
    estimate_only: { count: 0, expectedTotal: 0 },
    no_paperwork: { count: 0, expectedTotal: 0 },
  } as Record<RecoveryBucket, { count: number; expectedTotal: number }>;
  let expectedTotal = 0;
  let unknownAmountCount = 0;
  for (const r of rows) {
    byBucket[r.bucket].count += 1;
    if (r.expectedAmount == null) unknownAmountCount += 1;
    else {
      expectedTotal += r.expectedAmount;
      byBucket[r.bucket].expectedTotal += r.expectedAmount;
    }
  }

  return {
    rows,
    partiallyInvoiced,
    totals: {
      count: rows.length,
      expectedTotal: round2(expectedTotal),
      unknownAmountCount,
      byBucket: {
        has_so: { count: byBucket.has_so.count, expectedTotal: round2(byBucket.has_so.expectedTotal) },
        estimate_only: { count: byBucket.estimate_only.count, expectedTotal: round2(byBucket.estimate_only.expectedTotal) },
        no_paperwork: { count: byBucket.no_paperwork.count, expectedTotal: round2(byBucket.no_paperwork.expectedTotal) },
      },
      oldestDays: rows.length ? rows[0].daysSince : null,
      partiallyInvoicedCount: partiallyInvoiced.length,
    },
    meta: { windowDays, generatedAt: new Date().toISOString() },
  };
}
