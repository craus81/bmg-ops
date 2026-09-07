import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { normalizeItemNumber, isOpenPoStatus } from './vendor-po-sync';

/**
 * Reorder points & auto-replenishment (R4-7). Ordering used to be entirely
 * reactive — a shortage existed only when someone opened a readiness card
 * and noticed. Parts with a reorder_point set (netsuite_parts, migration
 * 271) are watched nightly: when free stock + on-order falls to the point,
 * the sweep raises a purchase_request tagged 'auto_reorder' into the
 * existing /admin/purchasing queue. The sweep queues; a person still cuts
 * every PO.
 *
 * Key space: everything is keyed by normalizeItemNumber (the last ':'
 * segment, uppercased) — the same space part_allocations, vendor PO lines,
 * purchase requests, and demand dismissals already use. scan_logs stores
 * catalog-cased part numbers, so scan chunks query with the raw catalog
 * item numbers and counts fold into the normalized key.
 */

export interface ReorderInputs {
  reorderPoint: number;
  orderUpTo: number | null;
  free: number;
  onOrder: number;
  pendingRequested: number;
}

/**
 * Min/max trigger: reorder when cover (free + on-order) is at or below the
 * point; suggest enough to fill back to the target counting what's already
 * requested. A misconfigured order_up_to below the point falls back to the
 * point (never suggest less than getting back to the line).
 */
export function computeReorderSuggestion(i: ReorderInputs): { triggered: boolean; suggestedQty: number } {
  const cover = i.free + i.onOrder;
  if (cover > i.reorderPoint) return { triggered: false, suggestedQty: 0 };
  const target = Math.max(i.orderUpTo ?? 0, i.reorderPoint);
  return { triggered: true, suggestedQty: Math.max(0, Math.ceil(target - (cover + i.pendingRequested))) };
}

/** Installs per week from a 90-day install count, one decimal. */
export function weeklyVelocity(installs90d: number): number {
  return Math.round((installs90d / (90 / 7)) * 10) / 10;
}

export interface ReorderCandidate {
  itemNumber: string; // normalized key
  catalogItemNumbers: string[]; // raw catalog casings behind the key
  netsuiteItemId: string | null;
  description: string | null;
  vendor: string | null;
  reorderPoint: number;
  orderUpTo: number | null;
  available: number;
  reserved: number;
  free: number;
  onOrder: number;
  pendingRequested: number;
  installs90d: number;
  /** Pending auto_reorder request already in the queue for this part, if any. */
  pendingAutoRequestId: string | null;
  pendingAutoQty: number;
  /** Demand-tab dismissal watermark (needed_at_dismiss), if the part carries one. */
  dismissedWatermark: number | null;
}

/**
 * Every managed part (reorder_point set) with the numbers the trigger needs:
 * live availability, reserved allocations, open on-order, pending requests,
 * 90-day install velocity, and any standing dismissal.
 */
export async function loadReorderCandidates(service: SupabaseClient): Promise<ReorderCandidate[]> {
  const { data: parts, error } = await fetchAllRows<any>((from, to) => service
    .from('netsuite_parts')
    .select('id, netsuite_id, item_number, display_name, description, vendor, quantity_available, reorder_point, order_up_to')
    .not('reorder_point', 'is', null)
    .order('id').range(from, to));
  if (error) throw new Error('reorder parts: ' + error.message);

  // Fold catalog rows into normalized keys (duplicate catalog rows for the
  // same part keep the max availability, the readiness convention).
  const byKey = new Map<string, ReorderCandidate>();
  for (const p of parts || []) {
    const key = normalizeItemNumber(p.item_number);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.catalogItemNumbers.push(p.item_number);
      existing.available = Math.max(existing.available, Math.max(0, Number(p.quantity_available) || 0));
      existing.reorderPoint = Math.max(existing.reorderPoint, Number(p.reorder_point) || 0);
      if (p.order_up_to != null) existing.orderUpTo = Math.max(existing.orderUpTo ?? 0, Number(p.order_up_to));
      continue;
    }
    byKey.set(key, {
      itemNumber: key,
      catalogItemNumbers: [p.item_number],
      netsuiteItemId: p.netsuite_id || null,
      description: p.display_name || p.description || null,
      vendor: p.vendor || null,
      reorderPoint: Number(p.reorder_point) || 0,
      orderUpTo: p.order_up_to != null ? Number(p.order_up_to) : null,
      available: Math.max(0, Number(p.quantity_available) || 0),
      reserved: 0,
      free: 0,
      onOrder: 0,
      pendingRequested: 0,
      installs90d: 0,
      pendingAutoRequestId: null,
      pendingAutoQty: 0,
      dismissedWatermark: null,
    });
  }
  if (byKey.size === 0) return [];

  const keys = [...byKey.keys()];
  const rawNumbers = [...byKey.values()].flatMap(c => c.catalogItemNumbers);
  const since90 = new Date(Date.now() - 90 * 86_400_000).toISOString();

  for (let i = 0; i < keys.length; i += 200) {
    const chunk = keys.slice(i, i + 200);

    // Reserved allocations (normalized keys, status 'reserved' only).
    const { data: allocs, error: aErr } = await fetchAllRows<any>((from, to) => service
      .from('part_allocations')
      .select('item_number, quantity')
      .eq('status', 'reserved')
      .in('item_number', chunk)
      .order('id').range(from, to));
    if (aErr) throw new Error('reorder allocations: ' + aErr.message);
    for (const a of allocs || []) {
      const row = byKey.get(normalizeItemNumber(a.item_number));
      if (row) row.reserved += Number(a.quantity) || 0;
    }

    // Open on-order (vendor PO mirror; open POs, unreceived remainder).
    const { data: poLines, error: pErr } = await fetchAllRows<any>((from, to) => service
      .from('netsuite_vendor_po_lines')
      .select('item_number, quantity, quantity_received, netsuite_vendor_pos!inner(status)')
      .in('item_number', chunk)
      .order('id').range(from, to));
    if (pErr) throw new Error('reorder PO lines: ' + pErr.message);
    for (const l of poLines || []) {
      if (!isOpenPoStatus((l as any).netsuite_vendor_pos?.status)) continue;
      const remaining = Math.max(0, (Number(l.quantity) || 0) - (Number(l.quantity_received) || 0));
      if (remaining <= 0) continue;
      const row = byKey.get(normalizeItemNumber(l.item_number));
      if (row) row.onOrder += remaining;
    }

    // Pending purchase requests — total requested plus any standing
    // auto_reorder row (topped up rather than duplicated).
    const { data: reqs, error: rErr } = await fetchAllRows<any>((from, to) => service
      .from('purchase_requests')
      .select('id, item_number, quantity, source')
      .eq('status', 'pending')
      .in('item_number', chunk)
      .order('id').range(from, to));
    if (rErr) throw new Error('reorder requests: ' + rErr.message);
    for (const r of reqs || []) {
      const row = byKey.get(normalizeItemNumber(r.item_number));
      if (!row) continue;
      row.pendingRequested += Number(r.quantity) || 0;
      if (r.source === 'auto_reorder' && !row.pendingAutoRequestId) {
        row.pendingAutoRequestId = r.id;
        row.pendingAutoQty = Number(r.quantity) || 0;
      }
    }

    // Demand-tab dismissals (migration 255): the same watermark semantics —
    // "not buying this" holds only until the suggested number grows past
    // what it was when dismissed.
    const { data: dismissals, error: dErr } = await service
      .from('purchasing_demand_dismissals')
      .select('item_number, needed_at_dismiss')
      .in('item_number', chunk);
    if (dErr) {
      console.warn('[reorder] dismissals unavailable:', dErr.message);
    } else {
      for (const d of dismissals || []) {
        const row = byKey.get(normalizeItemNumber(d.item_number));
        if (row) row.dismissedWatermark = Number(d.needed_at_dismiss) || 0;
      }
    }
  }

  // 90-day install velocity from scan_logs (one row = one unit installed).
  // scan_logs stores catalog casing, so chunk by the raw item numbers.
  for (let i = 0; i < rawNumbers.length; i += 200) {
    const chunk = rawNumbers.slice(i, i + 200);
    // Archived rows still count: archiving is export housekeeping, and the
    // unit was installed either way.
    const { data: scans, error: sErr } = await fetchAllRows<any>((from, to) => service
      .from('scan_logs')
      .select('id, part_number')
      .in('part_number', chunk)
      .gte('scanned_at', since90)
      .order('id').range(from, to));
    if (sErr) throw new Error('reorder scans: ' + sErr.message);
    for (const s of scans || []) {
      const row = byKey.get(normalizeItemNumber(s.part_number));
      if (row) row.installs90d += 1;
    }
  }

  for (const row of byKey.values()) {
    row.free = Math.max(0, row.available - row.reserved);
  }
  return [...byKey.values()].sort((a, b) => a.itemNumber.localeCompare(b.itemNumber));
}
