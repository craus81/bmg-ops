import { suiteqlQueryAll, isSuiteqlError } from '@/lib/netsuite';
import { fetchAllRows } from '@/lib/fetch-all';

/**
 * Which customer invoices were billed from which sales orders — and stamping
 * that onto the vehicles those SOs are linked to.
 *
 * The In-Shop record (#614) asked NetSuite one way only: header
 * `transaction.createdfrom = <so>`. On this account `createdfrom` is the
 * column that answers 500 UNEXPECTED_ERROR when SELECTed (the sales-order
 * sync's 2026-09-02 probe), and field evidence (SO1060, billed with the Bill
 * button, 2026-09-23) says the WHERE form doesn't find invoices either — and
 * the record fell back to "View SO PDF" with no sign anything had failed.
 *
 * So the lookup now walks a ladder, first answer wins:
 *   1. nexttransactionlinelink     — NetSuite's own line links (SO → invoice
 *   2. previoustransactionlinelink   is linktype OrdBill). The ledger mirror
 *                                    already reads these for payments.
 *   3. header createdfrom           — the old query, one SO at a time.
 * A rung NetSuite rejects as malformed (400) is skipped for the rest of the
 * process; anything else is retried next call. When every rung fails the
 * caller gets the error, never an empty "not invoiced".
 */

export interface SoInvoice {
  id: string;
  tranid: string;
  trandate: string | null;
  total: number;
  status: string | null;
}

export interface SoInvoiceLookup {
  /** SO internal id → invoices billed from it, oldest first. Every requested
   *  SO has an entry; [] means NetSuite answered and nothing is billed. */
  invoices: Map<string, SoInvoice[]>;
  /** SO internal id → its NetSuite status code, where known. */
  soStatus: Map<string, string>;
  /** Which rung answered — for logs and the sync's result payload. */
  via: LinkStrategy;
}

type LinkStrategy = 'nexttransactionlinelink' | 'previoustransactionlinelink' | 'createdfrom';
const LADDER: readonly LinkStrategy[] = ['nexttransactionlinelink', 'previoustransactionlinelink', 'createdfrom'];

/** Rungs NetSuite rejected as malformed (400) in this process. */
const rejected = new Set<LinkStrategy>();

/** Test hook: forget which rungs were rejected. */
export function resetSoInvoiceLadder(): void {
  rejected.clear();
}

const BATCH = 100;
/** Most SOs the per-SO createdfrom rung will take on in one call. */
const PER_SO_LIMIT = 10;
const SUITEQL_OPTS = { retries: 1 };

const isNsId = (s: string) => /^\d{1,15}$/.test(s);

/** `SalesOrd:G`, `G` or `Billed` → the letter or label after any prefix. */
function statusCode(raw: unknown): string {
  const s = String(raw ?? '').trim();
  const i = s.lastIndexOf(':');
  return i >= 0 ? s.slice(i + 1).trim() : s;
}

/**
 * True when NetSuite says the SO has nothing left to bill: Billed (G) or
 * Closed (H). Pending Billing / Partially Fulfilled etc. are not — a partly
 * billed SO must stay billable from FleetSuite, so it is shown but not
 * stamped.
 */
export function isFullyBilledSoStatus(raw: unknown): boolean {
  const s = statusCode(raw);
  return s === 'G' || s === 'H' || /^(billed|closed)$/i.test(s);
}

/** A voided invoice is not billing. */
function isVoidedInvoiceStatus(raw: unknown): boolean {
  const s = statusCode(raw);
  return s === 'V' || /^voided?$/i.test(s);
}

export function buildLinkTableQuery(table: 'nexttransactionlinelink' | 'previoustransactionlinelink', soIds: string[]): string {
  // One row per linked LINE, so an invoice repeats — deduped by the caller.
  // DISTINCT is avoided on purpose: this account's SuiteQL has refused
  // shapes that look harmless, and dedupe in JS costs nothing.
  return `
    SELECT l.previousdoc AS so_id, t.id, t.tranid, t.trandate,
           t.foreigntotal AS total, t.status, so.status AS so_status
    FROM ${table} l
    JOIN transaction t ON t.id = l.nextdoc
    JOIN transaction so ON so.id = l.previousdoc
    WHERE l.previousdoc IN (${soIds.join(', ')})
      AND t.type = 'CustInvc'
  `;
}

export function buildCreatedFromQuery(soId: string): string {
  return `
    SELECT t.id, t.tranid, t.trandate, t.foreigntotal AS total, t.status
    FROM transaction t
    WHERE t.type = 'CustInvc'
      AND t.createdfrom = ${soId}
  `;
}

export function buildSoStatusQuery(soIds: string[]): string {
  return `SELECT t.id, t.status FROM transaction t WHERE t.id IN (${soIds.join(', ')})`;
}

function toInvoice(row: any): SoInvoice {
  return {
    id: String(row.id),
    tranid: row.tranid ? String(row.tranid) : String(row.id),
    trandate: row.trandate ?? null,
    total: parseFloat(row.total) || 0,
    status: row.status != null ? String(row.status) : null,
  };
}

function addInvoice(into: Map<string, SoInvoice[]>, soId: string, row: any): void {
  if (row?.id == null || isVoidedInvoiceStatus(row.status)) return;
  const list = into.get(soId) || [];
  if (!list.some(inv => inv.id === String(row.id))) list.push(toInvoice(row));
  into.set(soId, list);
}

/** Oldest invoice first — the first one billed is the one a vehicle keeps. */
function sortInvoices(into: Map<string, SoInvoice[]>): void {
  for (const list of into.values()) {
    list.sort((a, b) => {
      const da = a.trandate ? Date.parse(a.trandate) : NaN;
      const db = b.trandate ? Date.parse(b.trandate) : NaN;
      if (!Number.isNaN(da) && !Number.isNaN(db) && da !== db) return da - db;
      return Number(a.id) - Number(b.id);
    });
  }
}

function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

async function viaLinkTable(
  table: 'nexttransactionlinelink' | 'previoustransactionlinelink',
  soIds: string[],
): Promise<Omit<SoInvoiceLookup, 'via'>> {
  const invoices = new Map<string, SoInvoice[]>();
  const soStatus = new Map<string, string>();
  // Sequential batches: one SuiteQL call in flight at a time
  // (netsuite-concurrency-limit — fan-out is what trips the governor).
  for (let i = 0; i < soIds.length; i += BATCH) {
    const rows = await suiteqlQueryAll(buildLinkTableQuery(table, soIds.slice(i, i + BATCH)), 1000, SUITEQL_OPTS);
    for (const row of rows) {
      const soId = String(row.so_id ?? '');
      if (!soId) continue;
      if (row.so_status != null) soStatus.set(soId, String(row.so_status));
      addInvoice(invoices, soId, row);
    }
  }
  return { invoices, soStatus };
}

async function viaCreatedFrom(soIds: string[]): Promise<Omit<SoInvoiceLookup, 'via'>> {
  const invoices = new Map<string, SoInvoice[]>();
  const soStatus = new Map<string, string>();
  for (const soId of soIds) {
    const rows = await suiteqlQueryAll(buildCreatedFromQuery(soId), 1000, SUITEQL_OPTS);
    for (const row of rows) addInvoice(invoices, soId, row);
  }
  // Status only matters for SOs that have an invoice (stamping gate).
  const billed = soIds.filter(id => (invoices.get(id) || []).length > 0);
  for (let i = 0; i < billed.length; i += BATCH) {
    const rows = await suiteqlQueryAll(buildSoStatusQuery(billed.slice(i, i + BATCH)), 1000, SUITEQL_OPTS);
    for (const row of rows) if (row?.id != null && row.status != null) soStatus.set(String(row.id), String(row.status));
  }
  return { invoices, soStatus };
}

/**
 * Invoices billed from each of these sales orders. Throws when no rung of
 * the ladder could answer — "couldn't check" must never read as "not billed".
 */
export async function findSoInvoices(soIdsIn: string[], opts: { perSoLimit?: number } = {}): Promise<SoInvoiceLookup> {
  const soIds = [...new Set(soIdsIn.map(s => String(s).trim()).filter(isNsId))];
  if (soIds.length === 0) return { invoices: new Map(), soStatus: new Map(), via: 'nexttransactionlinelink' };

  const failures: string[] = [];
  for (const via of LADDER) {
    if (rejected.has(via)) continue;
    // createdfrom costs one call per SO — fine for a record, not for a sweep.
    if (via === 'createdfrom' && soIds.length > (opts.perSoLimit ?? PER_SO_LIMIT)) {
      failures.push(`${via}: skipped for ${soIds.length} sales orders (one call each)`);
      continue;
    }
    try {
      const found = via === 'createdfrom' ? await viaCreatedFrom(soIds) : await viaLinkTable(via, soIds);
      for (const id of soIds) if (!found.invoices.has(id)) found.invoices.set(id, []);
      sortInvoices(found.invoices);
      return { ...found, via };
    } catch (err) {
      if (isSuiteqlError(err) && err.status === 400) rejected.add(via);
      failures.push(`${via}: ${describe(err)}`);
    }
  }
  throw new Error(`NetSuite invoice lookup failed (${failures.join(' | ') || 'every lookup was rejected earlier'})`);
}

export interface StampOutcome {
  /** Invoice number now on the vehicle's own column (new or pre-existing). */
  invoiceNumber: string | null;
  dateInvoiced: string | null;
  /** True when this call wrote something. */
  stamped: boolean;
}

/**
 * Record NetSuite-side billing on a vehicle, the same two places the
 * completion flow's own invoice lands (src/app/api/vehicle-tracking/invoice):
 *
 *   - `fleet_checkin_invoices` — the per-SO ledger row. Inserted only when
 *     none exists: a row FleetSuite wrote (or is mid-claim on) is left alone.
 *     Its existence is what stops the completion modal billing the SO again.
 *   - `fleet_checkins.invoice_number` / `date_invoiced` — the legacy scalar,
 *     first invoice only (`.is('invoice_number', null)`). The board badge,
 *     the unpaid tile, the AR payment sweep and the Vehicle Margin report
 *     read it.
 *
 * Only a FULLY billed SO is stamped (see isFullyBilledSoStatus): stamping a
 * partly billed one would lock its remaining lines out of the completion
 * flow. Idempotent — safe to call on every record open and every sync run.
 */
export async function stampVehicleInvoice(
  supabase: any,
  checkinId: string,
  soId: string,
  invoices: SoInvoice[],
  soStatus: string | undefined,
): Promise<StampOutcome> {
  const first = invoices[0];
  if (!first || !isFullyBilledSoStatus(soStatus)) return { invoiceNumber: null, dateInvoiced: null, stamped: false };

  const dateInvoiced = isoDay(first.trandate) || new Date().toISOString().slice(0, 10);
  let stamped = false;

  const { error: ledgerErr } = await supabase
    .from('fleet_checkin_invoices')
    .insert({
      fleet_checkin_id: checkinId,
      netsuite_sales_order_id: soId,
      invoice_number: first.tranid,
      netsuite_invoice_id: first.id,
      invoiced_at: `${dateInvoiced}T12:00:00Z`,
    });
  if (!ledgerErr) stamped = true;
  else if (ledgerErr.code !== '23505') console.warn('[so-invoices] ledger stamp failed:', ledgerErr.message);

  const { data: scalar, error: scalarErr } = await supabase
    .from('fleet_checkins')
    .update({ invoice_number: first.tranid, date_invoiced: dateInvoiced, updated_at: new Date().toISOString() })
    .eq('id', checkinId)
    .is('invoice_number', null)
    .select('invoice_number, date_invoiced');
  if (scalarErr) console.warn('[so-invoices] vehicle stamp failed:', scalarErr.message);
  if (scalar && scalar.length > 0) {
    return { invoiceNumber: scalar[0].invoice_number, dateInvoiced: scalar[0].date_invoiced, stamped: true };
  }
  return { invoiceNumber: null, dateInvoiced: null, stamped };
}

/** NetSuite trandate (M/D/YYYY or ISO) → YYYY-MM-DD, or null. */
export function isoDay(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return iso ? iso[1] : null;
}

export interface VehicleInvoiceSyncResult {
  checkedSalesOrders: number;
  billedSalesOrders: number;
  vehiclesStamped: number;
  via: LinkStrategy | null;
  /** True when the run's time budget cut stamping short; the rest stamp next run. */
  stoppedEarly: boolean;
}

/** SOs checked per sync run — newest links first. */
const SYNC_CAP = 300;

/**
 * Background sweep (netsuite-sync): find linked SOs that were billed in
 * NetSuite and stamp their vehicles, so the board shows "Invoiced" without
 * anyone opening the record. Checks the newest SO links with no invoice on
 * the ledger yet, capped per run; older ones still stamp when opened.
 */
export async function syncVehicleInvoices(
  supabase: any,
  opts: { deadline?: number } = {},
): Promise<VehicleInvoiceSyncResult> {
  const deadline = opts.deadline ?? Date.now() + 15_000;
  // The newest 1000 links are plenty to fill a run's cap; older SOs still
  // stamp when their record is opened.
  const { data: links, error: linksErr } = await supabase
    .from('fleet_checkin_sales_orders')
    .select('checkin_id, netsuite_sales_order_id, added_at')
    .not('netsuite_sales_order_id', 'is', null)
    .order('added_at', { ascending: false })
    .order('id')
    .range(0, 999);
  if (linksErr) throw new Error(`fleet_checkin_sales_orders: ${linksErr.message}`);

  // Ledger rows for exactly those vehicles — paginated, the table only grows.
  const checkinIds = [...new Set<string>((links || []).map((l: any) => String(l.checkin_id)))];
  const done = new Set<string>();
  for (let i = 0; i < checkinIds.length; i += 200) {
    const chunk = checkinIds.slice(i, i + 200);
    const { data: ledger, error: ledgerErr } = await fetchAllRows<{ fleet_checkin_id: string; netsuite_sales_order_id: string }>((from, to) => supabase
      .from('fleet_checkin_invoices')
      .select('fleet_checkin_id, netsuite_sales_order_id')
      .in('fleet_checkin_id', chunk)
      .order('id')
      .range(from, to));
    if (ledgerErr) throw new Error(`fleet_checkin_invoices: ${ledgerErr.message}`);
    for (const r of ledger) done.add(`${r.fleet_checkin_id}|${r.netsuite_sales_order_id}`);
  }

  const pending = (links || [])
    .filter((l: any) => isNsId(String(l.netsuite_sales_order_id)) && !done.has(`${l.checkin_id}|${l.netsuite_sales_order_id}`))
    .slice(0, SYNC_CAP);
  if (pending.length === 0 || Date.now() >= deadline) {
    return { checkedSalesOrders: 0, billedSalesOrders: 0, vehiclesStamped: 0, via: null, stoppedEarly: pending.length > 0 };
  }

  const lookup = await findSoInvoices(pending.map((l: any) => String(l.netsuite_sales_order_id)));
  let billed = 0;
  let stampedVehicles = 0;
  let stoppedEarly = false;
  for (const link of pending) {
    if (Date.now() >= deadline) { stoppedEarly = true; break; }
    const soId = String(link.netsuite_sales_order_id);
    const invoices = lookup.invoices.get(soId) || [];
    if (invoices.length === 0) continue;
    billed++;
    const out = await stampVehicleInvoice(supabase, link.checkin_id, soId, invoices, lookup.soStatus.get(soId));
    if (out.stamped) stampedVehicles++;
  }
  return {
    checkedSalesOrders: new Set(pending.map((l: any) => String(l.netsuite_sales_order_id))).size,
    billedSalesOrders: billed,
    vehiclesStamped: stampedVehicles,
    via: lookup.via,
    stoppedEarly,
  };
}
