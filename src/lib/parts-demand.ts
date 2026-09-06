import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeItemNumber, isOpenPoStatus } from './vendor-po-sync';
import { fetchAllRows } from './fetch-all';
import { evaluateHealthRow, HEALTH_MONITORS, type SyncStateRow } from './system-health';

/**
 * Total parts demand across every open job — "what do we need to buy to
 * finish everything we've sold", answered without consulting inventory.
 *
 * Two sources, deliberately:
 *   1. Open NetSuite sales orders, from the 2-hour mirror
 *      (netsuite_sales_orders / _lines, migration 196). The truest picture
 *      of sold work — it includes jobs that never passed through a
 *      FleetSuite estimate.
 *   2. Customer-approved estimates that have NOT become a sales order yet.
 *      Sold work that NetSuite can't see, so an SO-only list would miss it.
 *
 * An estimate that any mirrored SO already claims (estimates.netsuite_so_id,
 * or netsuite_sales_orders.estimate_id from the sync's own matching) is
 * dropped from source 2 — otherwise a converted job is counted twice, and
 * double-counting demand is how you over-order.
 *
 * On-hand stock is deliberately NOT netted out: this answers "what does the
 * work require", and the shop decides what to buy. Parts already on an open
 * vendor PO ride along as their own column (never subtracted from the need)
 * so a glance says what's already covered without the math hiding it.
 * Per-project reserving and the inventory-aware version of this math live in
 * parts-readiness.ts.
 */

/**
 * NetSuite SalesOrd statuses with nothing left to build: C = Cancelled,
 * G = Billed, H = Closed. Everything else (Pending Approval, Pending
 * Fulfillment, Partially Fulfilled, Pending Billing…) is still open work.
 *
 * NOTE these codes are the SalesOrd set — PurchOrd reuses the same letters
 * for different meanings, so isOpenPoStatus must never be used on an SO
 * (its F/G/H would drop Pending Billing orders that are still real work).
 */
export const CLOSED_SO_STATUS_CODES = ['C', 'G', 'H'];

/** Labels that mean closed regardless of code — a defensive second gate,
 *  since the code set above is the one assumption this file can't verify
 *  from inside FleetSuite. Matched whole, so "Pending Billing" stays open. */
const CLOSED_SO_LABELS = /^(closed|cancelled|canceled|billed|fully billed)$/i;

export function isOpenSalesOrderStatus(
  status: string | null | undefined,
  statusLabel?: string | null,
): boolean {
  if (CLOSED_SO_STATUS_CODES.includes(String(status || '').toUpperCase())) return false;
  if (statusLabel && CLOSED_SO_LABELS.test(String(statusLabel).trim())) return false;
  return true;
}

/**
 * Item types that are physical things somebody has to buy. Mirrors the
 * SuiteQL filter parts-readiness applies to SO lines — conversion pushes
 * labor as a real item line, and service/other-charge items have no
 * inventory, so without this every converted job reads "we need N LABOR".
 */
const STOCKABLE_ITEM_TYPES = new Set(['INVTPART', 'NONINVTPART', 'ASSEMBLY', 'KIT']);

export function isStockableItemType(itemType: string | null | undefined): boolean {
  return STOCKABLE_ITEM_TYPES.has(String(itemType || '').trim().toUpperCase());
}

/** Placeholder line the estimate builder and the SO push both use. */
const PLACEHOLDER_ITEMS = new Set(['FS-CUSTOM']);

export interface DemandSourceRef {
  kind: 'sales_order' | 'estimate';
  /** netsuite_sales_orders.id / estimates.id — the row to deep-link. */
  id: string;
  /** SO number or estimate number, as staff say it out loud. */
  label: string;
  customerName: string | null;
  /** SO trandate, or the estimate's approval date. */
  date: string | null;
  /** SO status label; null for estimates (they're all "approved"). */
  statusLabel: string | null;
  quantity: number;
}

export interface DemandPoRef {
  tranid: string | null;
  vendor_name: string | null;
  eta_date: string | null;
  remaining: number;
}

export interface DemandRow {
  item_number: string;
  description: string | null;
  /** From netsuite_parts — null when the item isn't in the mirrored catalog. */
  netsuite_item_id: string | null;
  vendor: string | null;
  item_type: string | null;
  /** False when no catalog row matched: the line is shown (dropping real
   *  demand silently is worse) but nothing about it could be enriched. */
  in_catalog: boolean;
  /** Total still needed across every open job. THE number this page exists
   *  for — no stock, no PO, no reservation subtracted from it. */
  needed: number;
  /** Remaining quantity on open vendor POs. Informational, never netted. */
  on_order: number;
  /** Quantity already sitting in the pending purchase-request queue. */
  requested: number;
  pos: DemandPoRef[];
  sources: DemandSourceRef[];
  /** Staff dismissed this part (purchasing_demand_dismissals, migration
   *  255) and its needed quantity hasn't grown since — hidden by default.
   *  Null when live. A dismissal whose quantity has since grown is stale
   *  and reported as null: new demand is never hidden by an old decision. */
  dismissed: { at: string; by: string | null; reason: string | null; neededAtDismiss: number } | null;
}

/**
 * Health of the sales-order mirror this list reads, so "0 open sales orders"
 * can say WHY. The number is only as true as the sync feeding it, and the
 * sync's first version silently never finished (see sales-order-sync.ts) —
 * the page showed a confident zero for weeks.
 */
export interface SoMirrorHealth {
  /** Every SO row in the mirror, open or not. 0 after a healthy run means
   *  NetSuite returned nothing — a permission problem, not a sync bug. */
  mirrorRows: number;
  status: 'ok' | 'partial' | 'stale' | 'error' | 'never';
  lastRunAt: string | null;
  problem: string | null;
}

export interface PartsDemandResult {
  rows: DemandRow[];
  meta: {
    salesOrders: number;
    estimates: number;
    /** Distinct parts and total units, after the item-type filter. */
    parts: number;
    units: number;
    /** SO lines dropped as labor/service/placeholder, so the page can say
     *  so rather than leaving staff to wonder where the labor line went. */
    skippedNonStock: number;
    /** Newest last_synced_at across the open SOs — how fresh this is. */
    soSyncedAt: string | null;
    soSync: SoMirrorHealth;
    /** Rows hidden by a live dismissal — so the page can offer to show them. */
    dismissed: number;
  };
}

const SO_SYNC_TYPE = 'netsuite_sales_orders';

/** The mirror's health from its sync_state row, with the same verdict the
 *  System Health board gives plus the backfill-in-progress case. */
export function describeSoMirrorHealth(row: SyncStateRow | null | undefined, mirrorRows: number, now = Date.now()): SoMirrorHealth {
  const monitor = HEALTH_MONITORS.find(m => m.syncType === SO_SYNC_TYPE)
    || { syncType: SO_SYNC_TYPE, label: 'NetSuite sales order sync', intervalMinutes: 120 };
  const check = evaluateHealthRow(monitor, row, now);
  if (check.status === 'ok' && row?.last_result?.partial === true) {
    const processed = Number(row.last_result?.resume?.processed) || 0;
    return {
      mirrorRows,
      status: 'partial',
      lastRunAt: check.lastRunAt,
      problem: `backfill in progress — ${processed} sales order${processed !== 1 ? 's' : ''} pulled so far, newest first; the rest land over the next 2-hour runs`,
    };
  }
  return { mirrorRows, status: check.status, lastRunAt: check.lastRunAt, problem: check.problem };
}

interface Working {
  item_number: string;
  description: string | null;
  needed: number;
  on_order: number;
  requested: number;
  pos: DemandPoRef[];
  sources: DemandSourceRef[];
}

/**
 * A short read here doesn't shrink the list, it understates a number
 * somebody orders against — so a failed page fails the whole computation
 * instead of quietly returning most of it.
 */
function must<T>(result: { data: T[]; error: { message: string } | null }, what: string): T[] {
  if (result.error) throw new Error(`Could not read ${what}: ${result.error.message}`);
  return result.data;
}

export async function computePartsDemand(service: SupabaseClient<any, any, any>): Promise<PartsDemandResult> {
  const parts = new Map<string, Working>();
  let skippedNonStock = 0;

  const bucket = (itemNumber: string, description: string | null): Working => {
    const existing = parts.get(itemNumber);
    if (existing) {
      if (!existing.description && description) existing.description = description;
      return existing;
    }
    const row: Working = {
      item_number: itemNumber, description, needed: 0,
      on_order: 0, requested: 0, pos: [], sources: [],
    };
    parts.set(itemNumber, row);
    return row;
  };

  // ── 1. Open sales orders ──────────────────────────────────────────────
  // Paginated: the mirror holds every SO ever synced, well past the 1000-row
  // PostgREST cap.
  const allSos = must(await fetchAllRows<any>((from, to) => service
    .from('netsuite_sales_orders')
    .select('id, tranid, customer_name, trandate, status, status_label, estimate_id, last_synced_at')
    .order('trandate', { ascending: false })
    .order('id')
    .range(from, to)), 'sales orders');
  const openSos = allSos.filter(so => isOpenSalesOrderStatus(so.status, so.status_label));
  const soById = new Map(openSos.map(so => [so.id, so]));
  // Not through must(): the list is still whole without its health note.
  const { data: syncState } = await service
    .from('sync_state')
    .select('sync_type, last_synced_at, last_result, updated_at')
    .eq('sync_type', SO_SYNC_TYPE)
    .maybeSingle();
  const soSync = describeSoMirrorHealth(syncState as SyncStateRow | null, allSos.length);
  const soSyncedAt = openSos.reduce<string | null>(
    (latest, so) => (!latest || (so.last_synced_at && so.last_synced_at > latest) ? so.last_synced_at || latest : latest),
    null,
  );

  // Lines for the open SOs only, chunked so the .in() list can't overflow
  // the request URL, and paginated inside each chunk (a big job's lines plus
  // its neighbours' can pass the 1000-row cap on their own).
  const soLines: any[] = [];
  const openSoIds = openSos.map(so => so.id);
  for (let i = 0; i < openSoIds.length; i += 100) {
    const chunk = openSoIds.slice(i, i + 100);
    soLines.push(...must(await fetchAllRows<any>((from, to) => service
      .from('netsuite_sales_order_lines')
      .select('so_id, item_number, item_netsuite_id, description, quantity, quantity_billed')
      .in('so_id', chunk)
      .order('id')
      .range(from, to)), 'sales order lines'));
  }

  // ── 2. Approved estimates with no sales order yet ─────────────────────
  const claimedEstimateIds = new Set(
    allSos.map(so => so.estimate_id).filter(Boolean) as string[],
  );
  const approvedEstimates = must(await fetchAllRows<any>((from, to) => service
    .from('estimates')
    .select('id, estimate_number, title, customer_name, status, customer_approved, customer_approved_at, netsuite_so_id')
    .eq('customer_approved', true)
    .is('netsuite_so_id', null)
    .neq('status', 'rejected')
    .order('customer_approved_at', { ascending: false })
    .order('id')
    .range(from, to)), 'approved estimates');
  const pendingEstimates = approvedEstimates.filter(e => !claimedEstimateIds.has(e.id));

  let estimateLines: any[] = [];
  if (pendingEstimates.length > 0) {
    const estimateIds = new Set(pendingEstimates.map(e => e.id));
    estimateLines = must(await fetchAllRows<any>((from, to) => service
      .from('estimate_line_items')
      .select('estimate_id, item_number, netsuite_item_id, description, quantity')
      .in('estimate_id', [...estimateIds])
      .order('id')
      .range(from, to)), 'estimate line items');
  }

  // ── Catalog enrichment, and the item-type filter it enables ───────────
  const lineKeys = new Set<string>();
  for (const l of [...soLines, ...estimateLines]) {
    const key = normalizeItemNumber(l.item_number);
    if (key) lineKeys.add(key);
  }
  const catalog = new Map<string, any>();
  if (lineKeys.size > 0) {
    const keys = [...lineKeys];
    // Chunked: a single .in() with thousands of item numbers overflows the
    // request URL long before it hits the row cap.
    for (let i = 0; i < keys.length; i += 200) {
      const { data, error } = await service
        .from('netsuite_parts')
        .select('item_number, netsuite_id, description, display_name, vendor, item_type')
        .in('item_number', keys.slice(i, i + 200));
      if (error) throw new Error(`Could not read the parts catalog: ${error.message}`);
      for (const c of data || []) catalog.set(normalizeItemNumber(c.item_number), c);
    }
  }

  /** A line is demand only if it's a physical part. Items missing from the
   *  catalog are kept — silently dropping real demand is the worse error —
   *  but a known service/labor/placeholder line is not demand. */
  const isDemandLine = (key: string): boolean => {
    if (PLACEHOLDER_ITEMS.has(key)) return false;
    const c = catalog.get(key);
    if (!c) return true;
    return isStockableItemType(c.item_type);
  };

  for (const line of soLines) {
    const key = normalizeItemNumber(line.item_number);
    if (!key) continue;
    if (!isDemandLine(key)) { skippedNonStock++; continue; }
    // Billed quantity is the only "already handled" signal the mirror
    // carries; a fully billed line is finished work, not something to buy.
    const qty = Math.max(0, (Number(line.quantity) || 0) - (Number(line.quantity_billed) || 0));
    if (qty <= 0) continue;
    const so = soById.get(line.so_id);
    const row = bucket(key, line.description || null);
    row.needed += qty;
    const existing = row.sources.find(s => s.kind === 'sales_order' && s.id === line.so_id);
    if (existing) existing.quantity += qty;
    else row.sources.push({
      kind: 'sales_order',
      id: line.so_id,
      label: so?.tranid || 'Sales order',
      customerName: so?.customer_name || null,
      date: so?.trandate || null,
      statusLabel: so?.status_label || so?.status || null,
      quantity: qty,
    });
  }

  const estimateById = new Map(pendingEstimates.map(e => [e.id, e]));
  for (const line of estimateLines) {
    const key = normalizeItemNumber(line.item_number);
    if (!key) continue;
    if (!isDemandLine(key)) { skippedNonStock++; continue; }
    const qty = Number(line.quantity) || 0;
    if (qty <= 0) continue;
    const est = estimateById.get(line.estimate_id);
    const row = bucket(key, line.description || null);
    row.needed += qty;
    const existing = row.sources.find(s => s.kind === 'estimate' && s.id === line.estimate_id);
    if (existing) existing.quantity += qty;
    else row.sources.push({
      kind: 'estimate',
      id: line.estimate_id,
      label: est?.estimate_number || 'Estimate',
      customerName: est?.customer_name || null,
      date: est?.customer_approved_at || null,
      statusLabel: null,
      quantity: qty,
    });
  }

  // ── On order (open vendor POs) and already-requested, for context ─────
  const demandKeys = [...parts.keys()];
  // Chunked like the catalog read: the key list is as long as the parts
  // list, and a single .in() with all of it overflows the request URL.
  const keyChunks: string[][] = [];
  for (let i = 0; i < demandKeys.length; i += 200) keyChunks.push(demandKeys.slice(i, i + 200));

  for (const chunk of keyChunks) {
    // Paginated: this table holds every line of every synced vendor PO.
    const poLines = must(await fetchAllRows<any>((from, to) => service
      .from('netsuite_vendor_po_lines')
      .select('item_number, quantity, quantity_received, netsuite_vendor_pos!inner(tranid, vendor_name, status, eta_date)')
      .in('item_number', chunk)
      .order('id')
      .range(from, to)), 'vendor PO lines');
    for (const l of poLines) {
      const po = (l as any).netsuite_vendor_pos;
      if (!isOpenPoStatus(po?.status)) continue;
      const remaining = Math.max(0, (Number(l.quantity) || 0) - (Number(l.quantity_received) || 0));
      if (remaining <= 0) continue;
      const row = parts.get(normalizeItemNumber(l.item_number));
      if (!row) continue;
      row.on_order += remaining;
      row.pos.push({
        tranid: po?.tranid || null,
        vendor_name: po?.vendor_name || null,
        eta_date: po?.eta_date || null,
        remaining,
      });
    }

    const requests = must(await fetchAllRows<any>((from, to) => service
      .from('purchase_requests')
      .select('item_number, quantity')
      .eq('status', 'pending')
      .in('item_number', chunk)
      .order('id')
      .range(from, to)), 'pending purchase requests');
    for (const r of requests) {
      const row = parts.get(normalizeItemNumber(r.item_number));
      if (row) row.requested += Number(r.quantity) || 0;
    }
  }

  // ── Dismissals (migration 255) ────────────────────────────────────────
  // A dismissal is a buying decision about the part and applies only while
  // the needed quantity is at or below what it was when dismissed: a new
  // job pushing the number past it brings the row back on its own, so an
  // old "not buying this" can never hide new demand. Read failures (e.g.
  // the migration not applied yet) degrade to "nothing dismissed".
  const dismissals = new Map<string, { at: string; by: string | null; reason: string | null; neededAtDismiss: number }>();
  if (parts.size > 0) {
    const keys = [...parts.keys()];
    for (let i = 0; i < keys.length; i += 200) {
      const { data, error } = await service
        .from('purchasing_demand_dismissals')
        .select('item_number, needed_at_dismiss, reason, dismissed_by, dismissed_at')
        .in('item_number', keys.slice(i, i + 200));
      if (error) { console.warn('[parts-demand] dismissals unavailable:', error.message); break; }
      for (const d of data || []) {
        dismissals.set(String(d.item_number), {
          at: d.dismissed_at,
          by: d.dismissed_by || null,
          reason: d.reason || null,
          neededAtDismiss: Number(d.needed_at_dismiss) || 0,
        });
      }
    }
  }

  const rows: DemandRow[] = [...parts.values()].map(p => {
    const c = catalog.get(p.item_number);
    const d = dismissals.get(p.item_number) || null;
    return {
      item_number: p.item_number,
      description: p.description || c?.description || c?.display_name || null,
      netsuite_item_id: c?.netsuite_id || null,
      vendor: c?.vendor || null,
      item_type: c?.item_type || null,
      in_catalog: !!c,
      needed: p.needed,
      on_order: p.on_order,
      requested: p.requested,
      pos: p.pos.sort((a, b) => (a.eta_date || '9999').localeCompare(b.eta_date || '9999')),
      // Biggest contributor first — the job driving the number is the one
      // you want to see without expanding anything else.
      sources: p.sources.sort((a, b) => b.quantity - a.quantity),
      dismissed: d && p.needed <= d.neededAtDismiss + 1e-6 ? d : null,
    };
  });
  // Most-needed first; ties alphabetical so the order is stable between loads.
  rows.sort((a, b) => b.needed - a.needed || a.item_number.localeCompare(b.item_number));

  const live = rows.filter(r => !r.dismissed);
  return {
    rows,
    meta: {
      salesOrders: openSos.length,
      estimates: pendingEstimates.length,
      // Counts describe what's LIVE — a dismissed part isn't something to buy.
      parts: live.length,
      units: live.reduce((sum, r) => sum + r.needed, 0),
      skippedNonStock,
      soSyncedAt,
      soSync,
      dismissed: rows.length - live.length,
    },
  };
}
