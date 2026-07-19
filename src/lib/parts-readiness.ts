import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { normalizeItemNumber, isOpenPoStatus } from '@/lib/vendor-po-sync';

/**
 * The part-level math the shop runs on: for an upfit project's sales order,
 * per part — needed (live SO lines) vs reserved-for-this-job vs free stock
 * (NetSuite available minus every project's reservations) vs on order
 * (synced open vendor-PO lines). Allocation lives in FleetSuite
 * (part_allocations), so two jobs can't count the same shelf stock; the
 * NetSuite "available" figure already nets out NetSuite-side commitments,
 * making our reservations a further (conservative) hold on top.
 */

export interface PoRef {
  tranid: string | null;
  vendor_name: string | null;
  trandate: string | null;
  status_label: string | null;
  eta_date: string | null;
  remaining: number;
}

export type PartState = 'reserved' | 'available' | 'waiting' | 'short';

export interface PartRow {
  item_number: string;
  description: string | null;
  needed: number;
  /** Reserved for THIS project. */
  allocated: number;
  /** Free pool after all projects' reservations (this one included). */
  free: number;
  /** allocated + free — what this project can count on right now. */
  usable: number;
  on_hand: number;
  on_order: number;
  short: number;
  state: PartState;
  /** What "Reserve available" would take: min(needed - allocated, free). */
  allocatable: number;
  pos: PoRef[];
}

export interface Readiness {
  available: boolean;
  reason?: string;
  error?: string;
  soNumber?: string | null;
  parts?: PartRow[];
  summary?: {
    covered: number;
    onOrder: number;
    short: number;
    verdict: 'reserved' | 'ready' | 'waiting' | 'short';
    lastEta: string | null;
  };
}

/** Pure allocation math — pinned by tests. availPool is NetSuite "available". */
export function allocationMath(input: {
  needed: number;
  availPool: number;
  allocatedHere: number;
  allocatedOthers: number;
  onOrder: number;
}): { free: number; usable: number; short: number; state: PartState; allocatable: number } {
  const { needed, availPool, allocatedHere, allocatedOthers, onOrder } = input;
  const free = Math.max(0, availPool - allocatedHere - allocatedOthers);
  const usable = allocatedHere + free;
  const short = Math.max(0, needed - usable - onOrder);
  const state: PartState =
    needed > 0 && allocatedHere >= needed ? 'reserved'
      : usable >= needed ? 'available'
        : short === 0 ? 'waiting'
          : 'short';
  return { free, usable, short, state, allocatable: Math.min(Math.max(0, needed - allocatedHere), free) };
}

export async function computePartsReadiness(service: SupabaseClient, projectId: string): Promise<Readiness> {
  const { data: project } = await service
    .from('upfit_projects')
    .select('id, netsuite_so_id, netsuite_so_number')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) return { available: false, reason: 'not_found' };
  if (!project.netsuite_so_id || !/^\d+$/.test(project.netsuite_so_id)) {
    return { available: false, reason: 'no_sales_order' };
  }

  // ── What the sales order needs (live) ──
  let soLines: any[];
  try {
    soLines = await suiteqlQueryAll(`
      SELECT tl.item, i.itemid AS item_number, tl.memo AS description, tl.quantity
      FROM transactionline tl
      LEFT JOIN item i ON tl.item = i.id
      WHERE tl.transaction = ${project.netsuite_so_id}
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
        AND tl.item IS NOT NULL
    `);
  } catch (e: any) {
    return { available: false, reason: 'netsuite_error', error: String(e?.message || e).slice(0, 200) };
  }

  interface Working {
    item_number: string; description: string | null; needed: number;
    availPool: number; allocatedHere: number; allocatedOthers: number;
    on_order: number; pos: PoRef[]; itemIds: Set<string>;
  }
  const parts = new Map<string, Working>();
  for (const line of soLines) {
    const key = normalizeItemNumber(line.item_number);
    if (!key) continue;
    const row = parts.get(key) || {
      item_number: key, description: null, needed: 0,
      availPool: 0, allocatedHere: 0, allocatedOthers: 0,
      on_order: 0, pos: [], itemIds: new Set<string>(),
    };
    row.needed += Math.abs(parseFloat(line.quantity || '0')) || 0;
    if (!row.description && line.description) row.description = line.description;
    if (line.item) row.itemIds.add(String(line.item));
    parts.set(key, row);
  }

  if (parts.size === 0) {
    return {
      available: true, soNumber: project.netsuite_so_number, parts: [],
      summary: { covered: 0, onOrder: 0, short: 0, verdict: 'ready', lastEta: null },
    };
  }

  // ── On hand (live — prefer "available", on hand minus NetSuite-side commitments) ──
  const allItemIds = [...new Set([...parts.values()].flatMap(p => [...p.itemIds]))];
  try {
    let invRows: any[];
    try {
      invRows = await suiteqlQueryAll(`
        SELECT i.id, i.itemid AS item_number, i.totalquantityonhand AS qty, i.totalquantityavailable AS avail
        FROM item i
        WHERE i.id IN (${allItemIds.join(', ')})
      `);
    } catch {
      invRows = await suiteqlQueryAll(`
        SELECT i.id, i.itemid AS item_number, i.totalquantityonhand AS qty
        FROM item i
        WHERE i.id IN (${allItemIds.join(', ')})
      `);
    }
    for (const inv of invRows) {
      const row = parts.get(normalizeItemNumber(inv.item_number));
      if (!row) continue;
      const onHand = Math.max(0, parseFloat(inv.qty || '0') || 0);
      const avail = inv.avail != null ? Math.max(0, parseFloat(inv.avail || '0') || 0) : onHand;
      row.availPool = avail;
    }
  } catch { /* non-inventory items have no on-hand — leave 0 */ }

  // ── FleetSuite reservations, this project vs everyone else ──
  const { data: allocations } = await service
    .from('part_allocations')
    .select('project_id, item_number, quantity')
    .eq('status', 'reserved')
    .in('item_number', [...parts.keys()]);
  for (const a of allocations || []) {
    const row = parts.get(a.item_number);
    if (!row) continue;
    const qty = Number(a.quantity) || 0;
    if (a.project_id === projectId) row.allocatedHere += qty;
    else row.allocatedOthers += qty;
  }

  // ── On order across all open vendor POs (synced, matched on part number) ──
  const { data: poLines } = await service
    .from('netsuite_vendor_po_lines')
    .select('item_number, quantity, quantity_received, netsuite_vendor_pos!inner(tranid, vendor_name, trandate, status, status_label, eta_date)')
    .in('item_number', [...parts.keys()]);
  for (const l of poLines || []) {
    const po = (l as any).netsuite_vendor_pos;
    if (!isOpenPoStatus(po?.status)) continue;
    const remaining = Math.max(0, (l.quantity || 0) - (l.quantity_received || 0));
    if (remaining <= 0) continue;
    const row = parts.get(l.item_number);
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

  const rows: PartRow[] = [...parts.values()].map(w => {
    const m = allocationMath({
      needed: w.needed, availPool: w.availPool,
      allocatedHere: w.allocatedHere, allocatedOthers: w.allocatedOthers,
      onOrder: w.on_order,
    });
    return {
      item_number: w.item_number, description: w.description, needed: w.needed,
      allocated: w.allocatedHere, free: m.free, usable: m.usable,
      on_hand: w.availPool, on_order: w.on_order,
      short: m.short, state: m.state, allocatable: m.allocatable, pos: w.pos,
    };
  });
  const stateRank: Record<PartState, number> = { short: 0, waiting: 1, available: 2, reserved: 3 };
  rows.sort((a, b) => (stateRank[a.state] - stateRank[b.state]) || a.item_number.localeCompare(b.item_number));

  const summary = {
    covered: rows.filter(r => r.state === 'reserved' || r.state === 'available').length,
    onOrder: rows.filter(r => r.state === 'waiting').length,
    short: rows.filter(r => r.state === 'short').length,
    verdict: (rows.every(r => r.state === 'reserved') ? 'reserved'
      : rows.every(r => r.state === 'reserved' || r.state === 'available') ? 'ready'
        : rows.some(r => r.state === 'short') ? 'short'
          : 'waiting') as 'reserved' | 'ready' | 'waiting' | 'short',
    lastEta: rows.filter(r => r.state === 'waiting' || r.state === 'short')
      .flatMap(r => r.pos.map(p => p.eta_date)).filter(Boolean).sort().pop() || null,
  };

  return { available: true, soNumber: project.netsuite_so_number, parts: rows, summary };
}
