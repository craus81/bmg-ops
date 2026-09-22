import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { normalizeItemNumber, isOpenPoStatus } from '@/lib/vendor-po-sync';
import { isStockableItemType } from '@/lib/parts-demand';
import { normalizeVehicleCount } from '@/lib/estimate-totals';
import { allocationMath, type PartState, type PoRef } from '@/lib/parts-readiness';
import { fetchAllRows } from '@/lib/fetch-all';

/**
 * "Do we actually have the parts for this quote?" — the readiness math an
 * estimate can run before there is a sales order to hang it on.
 *
 * Same arithmetic as the upfit project's Parts Readiness card
 * (`allocationMath`, deliberately shared so the two screens can never
 * disagree about what "free" means), with three differences that come from
 * quoting rather than building:
 *
 *  1. Need comes from the estimate's own lines, multiplied by
 *     `vehicle_count` — a twelve-van fleet quote needs twelve sets
 *     (migration 304 multiplies LINE QUANTITIES, and so does this).
 *  2. Lines are read from the CALLER, not the database, so the panel tracks
 *     the builder as it is edited rather than the last save. The estimate id
 *     is used only to work out which holds are this estimate's own.
 *  3. A line whose item isn't in the mirrored catalog is reported as
 *     `unknown`, never as short. Custom lines are how the builder handles
 *     one-off parts, and painting them red would make the banner cry wolf on
 *     every estimate that has one. The count is surfaced instead, so the
 *     banner can say plainly that it couldn't check everything.
 *
 * Server-only: callers pass a service-role Supabase client.
 */

export type EstimatePartState = PartState | 'unknown';

export interface EstimatePartRow {
  item_number: string;
  description: string | null;
  /** Line quantity × vehicle count. */
  needed: number;
  /** Reserved to THIS estimate. */
  allocated: number;
  /** Free pool after every hold, this estimate's included. */
  free: number;
  usable: number;
  /** The pool the math ran against — NetSuite "available". */
  on_hand: number;
  on_order: number;
  short: number;
  state: EstimatePartState;
  /** What "Reserve available" would take: min(needed - allocated, free). */
  allocatable: number;
  pos: PoRef[];
  netsuite_item_id: string | null;
  /** True when no catalog row matched, so nothing about it could be checked. */
  uncatalogued: boolean;
}

export interface EstimateReadiness {
  vehicleCount: number;
  /** 'live' = asked NetSuite just now · 'mirror' = the 2-hourly sync's copy. */
  stockSource: 'live' | 'mirror';
  parts: EstimatePartRow[];
  /** Labor/service lines dropped — they have no inventory to check. */
  skippedNonStock: number;
  summary: {
    covered: number;
    onOrder: number;
    short: number;
    /** Lines that couldn't be checked at all (not in the catalog). */
    unknown: number;
    verdict: 'reserved' | 'ready' | 'waiting' | 'short' | 'unknown';
    lastEta: string | null;
  };
}

export interface EstimateReadinessLine {
  item_number?: string | null;
  quantity?: number | string | null;
}

/** The placeholder the builder and the SO push both use for a custom line. */
const PLACEHOLDER = 'FS-CUSTOM';

export async function computeEstimateReadiness(
  service: SupabaseClient,
  input: {
    estimateId: string | null;
    lines: EstimateReadinessLine[];
    vehicleCount: unknown;
  },
): Promise<EstimateReadiness> {
  const units = normalizeVehicleCount(input.vehicleCount);

  interface Working {
    item_number: string;
    description: string | null;
    needed: number;
    availPool: number;
    allocatedHere: number;
    allocatedOthers: number;
    on_order: number;
    pos: PoRef[];
    netsuite_item_id: string | null;
    uncatalogued: boolean;
  }
  const parts = new Map<string, Working>();
  for (const line of input.lines) {
    const key = normalizeItemNumber(line.item_number);
    if (!key || key === PLACEHOLDER) continue;
    const qty = Math.abs(Number(line.quantity) || 0) * units;
    if (qty <= 0) continue;
    const row = parts.get(key) || {
      item_number: key, description: null, needed: 0,
      availPool: 0, allocatedHere: 0, allocatedOthers: 0,
      on_order: 0, pos: [], netsuite_item_id: null, uncatalogued: true,
    };
    row.needed += qty;
    parts.set(key, row);
  }

  const empty: EstimateReadiness = {
    vehicleCount: units, stockSource: 'mirror', parts: [], skippedNonStock: 0,
    summary: { covered: 0, onOrder: 0, short: 0, unknown: 0, verdict: 'ready', lastEta: null },
  };
  if (parts.size === 0) return empty;

  // ── Catalog: what kind of thing is it, and the mirrored stock figure ──
  // Batched at 200 because `.in()` on a long list is a long URL, and chunked
  // reads are how every other catalog lookup in the app does it.
  const keys = [...parts.keys()];
  let skippedNonStock = 0;
  const catalogued = new Set<string>();
  for (let i = 0; i < keys.length; i += 200) {
    const { data: cat } = await service
      .from('netsuite_parts')
      .select('netsuite_id, item_number, description, display_name, item_type, quantity_available, quantity_on_hand')
      .in('item_number', keys.slice(i, i + 200));
    for (const c of cat || []) {
      const key = normalizeItemNumber(c.item_number);
      const row = parts.get(key);
      if (!row) continue;
      if (!isStockableItemType(c.item_type)) {
        // Labor and service items have no inventory. Dropping them is the
        // same guard parts-readiness applies to SO lines — without it every
        // estimate carrying labor reads "short LABOR".
        parts.delete(key);
        skippedNonStock++;
        continue;
      }
      catalogued.add(key);
      row.uncatalogued = false;
      row.description = row.description || c.display_name || c.description || null;
      row.netsuite_item_id = c.netsuite_id != null ? String(c.netsuite_id) : null;
      // Prefer "available" (on hand minus NetSuite-side commitments) and fall
      // back to on hand, the same preference inventory-sync writes with.
      const avail = c.quantity_available != null ? Number(c.quantity_available) : Number(c.quantity_on_hand);
      row.availPool = Math.max(0, Number.isFinite(avail) ? avail : 0);
    }
  }

  // ── Stock, live where we can get it ──
  // The project card queries NetSuite when it opens, and a quote is a
  // promise to a customer, so it deserves the same freshness rather than a
  // figure up to two hours old. The mirrored number already loaded above is
  // the fallback, so a NetSuite outage degrades the panel instead of
  // emptying it.
  let stockSource: 'live' | 'mirror' = 'mirror';
  const itemIds = [...parts.values()].map(p => p.netsuite_item_id).filter(id => id && /^\d+$/.test(id)) as string[];
  if (itemIds.length > 0) {
    try {
      let invRows: any[];
      try {
        invRows = await suiteqlQueryAll(`
          SELECT i.itemid AS item_number, i.totalquantityonhand AS qty, i.totalquantityavailable AS avail
          FROM item i
          WHERE i.id IN (${itemIds.join(', ')})
        `);
      } catch {
        invRows = await suiteqlQueryAll(`
          SELECT i.itemid AS item_number, i.totalquantityonhand AS qty
          FROM item i
          WHERE i.id IN (${itemIds.join(', ')})
        `);
      }
      for (const inv of invRows) {
        const row = parts.get(normalizeItemNumber(inv.item_number));
        if (!row) continue;
        const onHand = Math.max(0, parseFloat(inv.qty || '0') || 0);
        row.availPool = inv.avail != null ? Math.max(0, parseFloat(inv.avail || '0') || 0) : onHand;
      }
      stockSource = 'live';
    } catch { /* keep the mirrored figures */ }
  }

  // ── Holds: this estimate's vs everyone else's ──
  // Every reserved row counts against the pool whoever owns it — a job's
  // hold and another quote's hold both mean the parts are spoken for.
  // Paginated: holds across every project and estimate can pass the
  // 1000-row cap.
  const { data: allocations } = await fetchAllRows<any>((from, to) => service
    .from('part_allocations')
    .select('project_id, estimate_id, item_number, quantity')
    .eq('status', 'reserved')
    .in('item_number', [...parts.keys()])
    .order('id')
    .range(from, to));
  for (const a of allocations || []) {
    const row = parts.get(normalizeItemNumber(a.item_number));
    if (!row) continue;
    const qty = Number(a.quantity) || 0;
    if (input.estimateId && a.estimate_id === input.estimateId) row.allocatedHere += qty;
    else row.allocatedOthers += qty;
  }

  // ── On order across open vendor POs, matched on part number ──
  const { data: poLines } = await fetchAllRows<any>((from, to) => service
    .from('netsuite_vendor_po_lines')
    .select('item_number, quantity, quantity_received, netsuite_vendor_pos!inner(tranid, vendor_name, trandate, status, status_label, eta_date)')
    .in('item_number', [...parts.keys()])
    .order('id')
    .range(from, to));
  for (const l of poLines || []) {
    const po = (l as any).netsuite_vendor_pos;
    if (!isOpenPoStatus(po?.status)) continue;
    const remaining = Math.max(0, (l.quantity || 0) - (l.quantity_received || 0));
    if (remaining <= 0) continue;
    const row = parts.get(normalizeItemNumber(l.item_number));
    if (!row) continue;
    row.on_order += remaining;
    row.pos.push({
      tranid: po?.tranid || null,
      vendor_name: po?.vendor_name || null,
      trandate: po?.trandate || null,
      status_label: po?.status_label || po?.status || null,
      eta_date: po?.eta_date || null,
      remaining,
    });
  }

  const rows: EstimatePartRow[] = [...parts.values()].map(w => {
    const m = allocationMath({
      needed: w.needed, availPool: w.availPool,
      allocatedHere: w.allocatedHere, allocatedOthers: w.allocatedOthers,
      onOrder: w.on_order,
    });
    const uncatalogued = !catalogued.has(w.item_number);
    return {
      item_number: w.item_number,
      description: w.description,
      needed: w.needed,
      allocated: w.allocatedHere,
      free: m.free,
      usable: m.usable,
      on_hand: w.availPool,
      on_order: w.on_order,
      short: m.short,
      // An uncatalogued line has no stock figure to be short OF — saying so
      // is honest; calling it short would be a guess dressed as a fact.
      state: uncatalogued ? 'unknown' : m.state,
      allocatable: uncatalogued ? 0 : m.allocatable,
      pos: w.pos,
      netsuite_item_id: w.netsuite_item_id,
      uncatalogued,
    };
  });

  // Worst first: what needs doing should be at the top of the panel.
  const stateRank: Record<EstimatePartState, number> = {
    short: 0, waiting: 1, unknown: 2, available: 3, reserved: 4,
  };
  rows.sort((a, b) => (stateRank[a.state] - stateRank[b.state]) || a.item_number.localeCompare(b.item_number));

  return {
    vehicleCount: units, stockSource, parts: rows, skippedNonStock,
    summary: summarizeEstimateReadiness(rows),
  };
}

/**
 * The one-line verdict the banner reads, rolled up from the part rows.
 *
 * Pure and exported so it can be pinned by tests: this sentence is what a
 * salesperson decides on, and the two traps it has to keep clear of are
 * (a) calling a quote ready when a line couldn't be checked at all, and
 * (b) letting those unknown lines make everything look short. Unknowns get
 * counted and named, never folded into either verdict.
 */
export function summarizeEstimateReadiness(rows: EstimatePartRow[]): EstimateReadiness['summary'] {
  const checkable = rows.filter(r => r.state !== 'unknown');
  return {
    covered: checkable.filter(r => r.state === 'reserved' || r.state === 'available').length,
    onOrder: checkable.filter(r => r.state === 'waiting').length,
    short: checkable.filter(r => r.state === 'short').length,
    unknown: rows.length - checkable.length,
    verdict: checkable.length === 0 ? (rows.length > 0 ? 'unknown' : 'ready')
      : checkable.every(r => r.state === 'reserved') ? 'reserved'
        : checkable.every(r => r.state === 'reserved' || r.state === 'available') ? 'ready'
          : checkable.some(r => r.state === 'short') ? 'short'
            : 'waiting',
    lastEta: checkable.filter(r => r.state === 'waiting' || r.state === 'short')
      .flatMap(r => r.pos.map(p => p.eta_date)).filter(Boolean).sort().pop() || null,
  };
}
