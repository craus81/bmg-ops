import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { normalizeItemNumber, isOpenPoStatus } from '@/lib/vendor-po-sync';
import { fetchAllRows } from '@/lib/fetch-all';
import { genericLineStatus, groupGenericLines, type GenericLineInput, type GenericPoLine } from '@/lib/generic-lines';
import { loadGenericItems, loadGenericRequests } from '@/lib/generic-lines-server';

/**
 * The part-level math the shop runs on: for an upfit project's sales order,
 * per part — needed (live SO lines) vs reserved-for-this-job vs free stock
 * (NetSuite available minus every hold, jobs' and quotes' alike — see
 * estimate-readiness.ts for the quoting side) vs on order
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
  /** Unique per row: the part number, or for a generic part (Misc) one
   *  key per line description — see generic-lines.ts. */
  line_key: string;
  /** A generic part's line: never reserved, tracked by its own requests. */
  generic?: boolean;
  /** Generic lines only: how many have arrived (Receiving or "Got it"). */
  received?: number;
  /** Generic lines only: the requests behind the row, for "Got it". */
  request_ids?: string[];
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
  /** NetSuite item internal id (from the SO line) — what a purchase
   *  request / vendor PO line needs. Null for items the SO carried
   *  without a resolvable id. */
  netsuite_item_id: string | null;
  /** Quantity sitting in PENDING purchase requests for this item raised
   *  from THIS project. Per-project on purpose: a pool-wide sum let one
   *  project's ask suppress another's Order button while nobody ordered
   *  the second job's parts (Round 3 finding). Display-only: it does not
   *  change the state math. */
  requested: number;
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
    .select('id, netsuite_so_id, netsuite_so_number, estimate_id')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) return { available: false, reason: 'not_found' };
  if (!project.netsuite_so_id || !/^\d+$/.test(project.netsuite_so_id)) {
    return { available: false, reason: 'no_sales_order' };
  }

  // ── What the sales order needs (live) ──
  let soLines: any[];
  try {
    // Physical parts only: conversion deliberately pushes labor hours and
    // FS-CUSTOM placeholder lines as real item lines, and service/other-
    // charge items have no inventory — without this filter every converted
    // job with labor read "short LABOR ×N" forever, and the Order button
    // would put LABOR on a real vendor PO (Round 3 finding).
    soLines = await suiteqlQueryAll(`
      SELECT tl.item, i.itemid AS item_number, tl.memo AS description, tl.quantity
      FROM transactionline tl
      LEFT JOIN item i ON tl.item = i.id
      WHERE tl.transaction = ${project.netsuite_so_id}
        AND tl.mainline = 'F'
        AND tl.taxline = 'F'
        AND tl.item IS NOT NULL
        AND i.itemtype IN ('InvtPart', 'NonInvtPart', 'Assembly', 'Kit')
        AND UPPER(i.itemid) <> 'FS-CUSTOM'
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
  const linesByKey = new Map<string, GenericLineInput[]>();
  for (const line of soLines) {
    const key = normalizeItemNumber(line.item_number);
    if (!key) continue;
    const own = linesByKey.get(key) || [];
    own.push({ description: line.description, quantity: Math.abs(parseFloat(line.quantity || '0')) || 0 });
    linesByKey.set(key, own);
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

  // ── Generic parts (Misc): one row per SO line, never reserved ──
  // Out of the per-part math, so nothing is summed across their lines;
  // their state comes from their own requests (generic-lines.ts).
  const genericRows: PartRow[] = [];
  let genericItems = new Set<string>();
  try {
    genericItems = await loadGenericItems(service, [...parts.keys(), ...soLines.map(l => String(l.item_number || '').trim())]);
  } catch (e) {
    console.error('parts-readiness: generic parts lookup failed', e);
  }
  const genericKeys = [...parts.keys()].filter(k => genericItems.has(k));
  if (genericKeys.length > 0) {
    let scoped: Awaited<ReturnType<typeof loadGenericRequests>> = { requests: [], poLines: [] };
    try {
      scoped = await loadGenericRequests(service, { projectId, estimateId: project.estimate_id || null }, genericKeys);
    } catch (e) {
      console.error('parts-readiness: generic requests lookup failed', e);
    }
    for (const key of genericKeys) {
      const w = parts.get(key)!;
      parts.delete(key);
      const mine = scoped.requests.filter(r => r.item_number === key);
      for (const g of groupGenericLines(key, linesByKey.get(key) || [])) {
        const st = genericLineStatus(g, mine, scoped.poLines);
        genericRows.push({
          item_number: key, line_key: g.key, generic: true,
          received: st.received, request_ids: st.requestIds,
          description: g.description, needed: g.needed,
          allocated: 0, free: 0, usable: 0, on_hand: 0, on_order: st.ordered,
          short: st.short, state: st.state, allocatable: 0, pos: [],
          netsuite_item_id: [...w.itemIds][0] || null,
          requested: st.requested,
        });
      }
    }
  }

  if (parts.size === 0 && genericRows.length === 0) {
    return {
      available: true, soNumber: project.netsuite_so_number, parts: [],
      summary: { covered: 0, onOrder: 0, short: 0, verdict: 'ready', lastEta: null },
    };
  }

  // ── On hand (live — prefer "available", on hand minus NetSuite-side commitments) ──
  const allItemIds = [...new Set([...parts.values()].flatMap(p => [...p.itemIds]))];
  if (allItemIds.length > 0) try {
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
  // Paginated: reservations across all projects can pass the 1000-row cap.
  const { data: allocations } = await fetchAllRows<any>((from, to) => service
    .from('part_allocations')
    .select('project_id, item_number, quantity')
    .eq('status', 'reserved')
    .in('item_number', [...parts.keys()])
    .order('id')
    .range(from, to));
  for (const a of allocations || []) {
    const row = parts.get(a.item_number);
    if (!row) continue;
    const qty = Number(a.quantity) || 0;
    if (a.project_id === projectId) row.allocatedHere += qty;
    else row.allocatedOthers += qty;
  }

  // ── On order across all open vendor POs (synced, matched on part number) ──
  // Paginated: this table holds every line of every synced vendor PO — the
  // unpaginated read capped at 1000 rows and silently under-reported
  // on-order quantities (roadmap B7).
  const { data: poLines } = await fetchAllRows<any>((from, to) => service
    .from('netsuite_vendor_po_lines')
    .select('item_number, quantity, quantity_received, netsuite_vendor_pos!inner(tranid, vendor_name, trandate, status, status_label, eta_date)')
    .eq('netsuite_vendor_pos.drop_ship', false) // drop ship POs never come in (migration 429)
    .in('item_number', [...parts.keys()])
    .order('id')
    .range(from, to));
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

  // Pending purchase requests per item (audit item 17A) — so the card can
  // show "Requested" instead of a dead-end Short badge. Scoped to THIS
  // project's requests: pool-wide, project A's ask suppressed project B's
  // Order button while B's parts were never ordered (Round 3 finding).
  // Bounded by this SO's part list, so no pagination needed.
  const requestedByItem = new Map<string, number>();
  try {
    const { data: reqs } = await service
      .from('purchase_requests')
      .select('item_number, quantity')
      .eq('status', 'pending')
      .eq('source_project_id', projectId)
      .in('item_number', [...parts.keys()]);
    for (const r of reqs || []) {
      const key = normalizeItemNumber(r.item_number);
      requestedByItem.set(key, (requestedByItem.get(key) || 0) + (Number(r.quantity) || 0));
    }
  } catch { /* requests table optional pre-migration — card just shows Short */ }

  const rows: PartRow[] = [...parts.values()].map(w => {
    const m = allocationMath({
      needed: w.needed, availPool: w.availPool,
      allocatedHere: w.allocatedHere, allocatedOthers: w.allocatedOthers,
      onOrder: w.on_order,
    });
    return {
      item_number: w.item_number, line_key: w.item_number, description: w.description, needed: w.needed,
      allocated: w.allocatedHere, free: m.free, usable: m.usable,
      on_hand: w.availPool, on_order: w.on_order,
      short: m.short, state: m.state, allocatable: m.allocatable, pos: w.pos,
      netsuite_item_id: [...w.itemIds][0] || null,
      requested: requestedByItem.get(w.item_number) || 0,
    };
  });
  rows.push(...genericRows);
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

export interface BoardReadiness {
  verdict: 'reserved' | 'ready' | 'waiting' | 'short';
  covered: number;
  onOrder: number;
  short: number;
  lastEta: string | null;
}

/**
 * Board-scale readiness (R3-12: "verdicts on the board"): the same per-part
 * math as computePartsReadiness, but for N projects at once from SYNCED
 * data only — the mirror's SO lines, the parts catalog's hourly
 * quantity_available, reservations, and open vendor-PO lines. Zero NetSuite
 * calls, ~6 reads for a whole board, at-most-an-hour stale. The detail
 * panel keeps the live per-project compute; this feeds the card chips.
 *
 * Same physical-parts filter as the live path (InvtPart/NonInvtPart/
 * Assembly/Kit, never FS-CUSTOM), applied through the catalog's item_type —
 * an SO line whose item isn't in the catalog is skipped rather than
 * guessed at, so labor/service lines can't manufacture false shorts
 * (the exact Round 3 trap the live filter exists for).
 *
 * Returns only projects that resolve to a mirrored SO with at least one
 * physical line — absent keys mean "no chip", never "ready".
 */
export async function computePartsReadinessBoard(
  service: SupabaseClient,
  projectIds: string[],
): Promise<Record<string, BoardReadiness>> {
  const out: Record<string, BoardReadiness> = {};
  if (projectIds.length === 0) return out;

  const { data: projects } = await service
    .from('upfit_projects')
    .select('id, netsuite_so_id')
    .in('id', projectIds.slice(0, 100));
  const withSo = (projects || []).filter(p => p.netsuite_so_id && /^\d+$/.test(p.netsuite_so_id));
  if (withSo.length === 0) return out;

  const { data: soRows } = await service
    .from('netsuite_sales_orders')
    .select('id, netsuite_id')
    .in('netsuite_id', [...new Set(withSo.map(p => String(p.netsuite_so_id)))]);
  const mirrorIdByNsId = new Map((soRows || []).map(r => [String(r.netsuite_id), r.id]));
  const mirrorIds = [...mirrorIdByNsId.values()];
  if (mirrorIds.length === 0) return out;

  const { data: lines } = await fetchAllRows<any>((from, to) => service
    .from('netsuite_sales_order_lines')
    .select('so_id, item_number, description, quantity')
    .in('so_id', mirrorIds)
    .order('id')
    .range(from, to));

  // needed per (mirror SO row, item)
  const neededBySo = new Map<string, Map<string, number>>();
  const genericLinesBySo = new Map<string, Map<string, GenericLineInput[]>>();
  const itemSet = new Set<string>();
  for (const l of lines || []) {
    const key = normalizeItemNumber(l.item_number);
    if (!key || key === 'FS-CUSTOM') continue;
    itemSet.add(key);
    const g = genericLinesBySo.get(l.so_id) || new Map<string, GenericLineInput[]>();
    g.set(key, [...(g.get(key) || []), { description: l.description, quantity: Math.abs(Number(l.quantity)) || 0 }]);
    genericLinesBySo.set(l.so_id, g);
    const m = neededBySo.get(l.so_id) || new Map<string, number>();
    m.set(key, (m.get(key) || 0) + (Math.abs(Number(l.quantity)) || 0));
    neededBySo.set(l.so_id, m);
  }
  if (itemSet.size === 0) return out;
  const items = [...itemSet];

  // Catalog: physical types only + the hourly-synced available pool.
  const PHYSICAL = new Set(['InvtPart', 'NonInvtPart', 'Assembly', 'Kit']);
  const availByItem = new Map<string, number>();
  for (let i = 0; i < items.length; i += 200) {
    const { data: cat } = await service
      .from('netsuite_parts')
      .select('item_number, item_type, quantity_available')
      .in('item_number', items.slice(i, i + 200));
    for (const c of cat || []) {
      if (!PHYSICAL.has(String(c.item_type || ''))) continue;
      const key = normalizeItemNumber(c.item_number);
      availByItem.set(key, Math.max(availByItem.get(key) || 0, Math.max(0, Number(c.quantity_available) || 0)));
    }
  }

  // Generic parts (Misc) are judged per line from each job's own requests,
  // the same as the live card — never from stock.
  let genericItems = new Set<string>();
  try {
    genericItems = await loadGenericItems(service, items);
  } catch (e) {
    console.error('parts-readiness board: generic parts lookup failed', e);
  }
  const genericReqs: any[] = [];
  const genericPoLines: GenericPoLine[] = [];
  if (genericItems.size > 0) {
    const { data: reqs } = await service
      .from('purchase_requests')
      .select('id, item_number, description, quantity, status, received_at, ordered_po_id, source_project_id')
      .neq('status', 'cancelled')
      .in('source_project_id', withSo.map(p => p.id))
      .in('item_number', [...genericItems]);
    for (const r of reqs || []) genericReqs.push({ ...r, item_number: normalizeItemNumber(r.item_number) });
    const poIds = [...new Set(genericReqs.map(r => r.ordered_po_id).filter(Boolean))];
    if (poIds.length > 0) {
      const { data: pl } = await service
        .from('netsuite_vendor_po_lines')
        .select('po_id, item_number, description, quantity_received')
        .in('po_id', poIds);
      for (const l of pl || []) genericPoLines.push({ ...l, item_number: normalizeItemNumber(l.item_number) });
    }
  }

  // Reservations: this project's vs the whole pool's, per item.
  const { data: allocations } = await fetchAllRows<any>((from, to) => service
    .from('part_allocations')
    .select('project_id, item_number, quantity')
    .eq('status', 'reserved')
    .in('item_number', items)
    .order('id')
    .range(from, to));
  const allocTotal = new Map<string, number>();
  const allocByProject = new Map<string, Map<string, number>>();
  for (const a of allocations || []) {
    const qty = Number(a.quantity) || 0;
    // The pool total counts every hold, whoever owns it — a quote's hold
    // (migration 320) spends the same shelf as a job's. Only the per-project
    // split is project-only, so estimate rows are skipped there rather than
    // piling into a bucket keyed on null.
    allocTotal.set(a.item_number, (allocTotal.get(a.item_number) || 0) + qty);
    if (!a.project_id) continue;
    const m = allocByProject.get(a.project_id) || new Map<string, number>();
    m.set(a.item_number, (m.get(a.item_number) || 0) + qty);
    allocByProject.set(a.project_id, m);
  }

  // On order + latest ETA per item, open POs only.
  const { data: poLines } = await fetchAllRows<any>((from, to) => service
    .from('netsuite_vendor_po_lines')
    .select('item_number, quantity, quantity_received, netsuite_vendor_pos!inner(status, eta_date)')
    .eq('netsuite_vendor_pos.drop_ship', false) // drop ship POs never come in (migration 429)
    .in('item_number', items)
    .order('id')
    .range(from, to));
  const onOrderByItem = new Map<string, number>();
  const etaByItem = new Map<string, string>();
  for (const l of poLines || []) {
    const po = (l as any).netsuite_vendor_pos;
    if (!isOpenPoStatus(po?.status)) continue;
    const remaining = Math.max(0, (l.quantity || 0) - (l.quantity_received || 0));
    if (remaining <= 0) continue;
    onOrderByItem.set(l.item_number, (onOrderByItem.get(l.item_number) || 0) + remaining);
    if (po?.eta_date && (!etaByItem.has(l.item_number) || po.eta_date > etaByItem.get(l.item_number)!)) {
      etaByItem.set(l.item_number, po.eta_date);
    }
  }

  for (const proj of withSo) {
    const mirrorId = mirrorIdByNsId.get(String(proj.netsuite_so_id));
    const needed = mirrorId ? neededBySo.get(mirrorId) : undefined;
    if (!needed || needed.size === 0) continue;
    const myAlloc = allocByProject.get(proj.id) || new Map<string, number>();
    const states: PartState[] = [];
    let lastEta: string | null = null;
    for (const [item, qty] of needed) {
      if (genericItems.has(item)) {
        const mine = genericReqs.filter(r => r.source_project_id === proj.id && r.item_number === item);
        for (const g of groupGenericLines(item, genericLinesBySo.get(mirrorId!)?.get(item) || [])) {
          states.push(genericLineStatus(g, mine, genericPoLines).state);
        }
        continue;
      }
      if (!availByItem.has(item) && !myAlloc.has(item) && !onOrderByItem.has(item)) {
        // Not a catalog physical item and nothing tracked for it — skip
        // (labor/service lines, or an unsynced item we can't judge).
        continue;
      }
      const here = myAlloc.get(item) || 0;
      const m = allocationMath({
        needed: qty,
        availPool: availByItem.get(item) || 0,
        allocatedHere: here,
        allocatedOthers: Math.max(0, (allocTotal.get(item) || 0) - here),
        onOrder: onOrderByItem.get(item) || 0,
      });
      states.push(m.state);
      if (m.state === 'waiting' || m.state === 'short') {
        const eta = etaByItem.get(item) || null;
        if (eta && (!lastEta || eta > lastEta)) lastEta = eta;
      }
    }
    if (states.length === 0) continue;
    out[proj.id] = {
      covered: states.filter(s => s === 'reserved' || s === 'available').length,
      onOrder: states.filter(s => s === 'waiting').length,
      short: states.filter(s => s === 'short').length,
      verdict: states.every(s => s === 'reserved') ? 'reserved'
        : states.every(s => s === 'reserved' || s === 'available') ? 'ready'
          : states.some(s => s === 'short') ? 'short'
            : 'waiting',
      lastEta,
    };
  }
  return out;
}
