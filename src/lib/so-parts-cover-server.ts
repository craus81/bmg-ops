/**
 * Server half of "Parts ordered" on sales orders (so-parts-cover.ts decides
 * what the rows mean). Works over every open order at once, because stock
 * is shared: an order only gets shelf stock that holds and older orders
 * haven't already taken. About a dozen reads, all from FleetSuite's own
 * copies (sales order mirror, parts catalog, purchase requests, holds), no
 * NetSuite calls.
 *
 * Server-only: callers pass a service-role client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';
import { normalizeItemNumber } from './incoming-parts';
import { isOpenSalesOrderStatus } from './parts-demand';
import { loadGenericItems } from './generic-lines-server';
import { deriveSoPartsCover, isCountedItem, shareStock, type CoverOrder, type SoPartsCover } from './so-parts-cover';

type Db = SupabaseClient;

const CHUNK = 150;
async function inChunks(ids: string[], run: (part: string[]) => PromiseLike<{ data: any[] | null; error: any }>): Promise<any[]> {
  const uniq = [...new Set(ids.filter(Boolean))];
  const out: any[] = [];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const { data, error } = await run(uniq.slice(i, i + CHUNK));
    if (error) throw new Error(error.message || String(error));
    out.push(...(data || []));
  }
  return out;
}

const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) || 0) + n);

export const SO_COVER_HEADER_COLUMNS =
  'id, netsuite_id, tranid, trandate, status, status_label, estimate_id, parts_marked_at, parts_marked_by_name, parts_marked_items';

/**
 * Cover for open sales orders, keyed by NetSuite id. `only` limits what
 * comes back (the math still runs over every open order). Orders with no
 * physical part lines, and closed / billed orders, are left out.
 */
export async function loadSoPartsCover(service: Db, only?: string[]): Promise<Map<string, SoPartsCover>> {
  const out = new Map<string, SoPartsCover>();
  if (only && only.length === 0) return out;

  const { data: headerRows } = await fetchAllRows<any>((from, to) => service
    .from('netsuite_sales_orders')
    .select(SO_COVER_HEADER_COLUMNS)
    .or('status.is.null,status.not.in.(C,G,H)')
    .order('id')
    .range(from, to));
  const headers = (headerRows || []).filter(h => isOpenSalesOrderStatus(h.status, h.status_label));
  if (headers.length === 0) return out;
  const wanted = only ? new Set(only.map(String)) : null;
  if (wanted && !headers.some(h => wanted.has(String(h.netsuite_id)))) return out;

  const byMirrorId = new Map<string, any>(headers.map(h => [h.id, h]));
  const nsIds = headers.map(h => String(h.netsuite_id));

  // ── Lines: still needed = quantity minus billed ──
  const lines = await inChunks([...byMirrorId.keys()], part => service
    .from('netsuite_sales_order_lines')
    .select('so_id, item_number, description, quantity, quantity_billed')
    .in('so_id', part));
  const rawNeed = new Map<string, Map<string, number>>(); // mirror id → item → qty
  const desc = new Map<string, string | null>();
  const items = new Set<string>();
  for (const l of lines) {
    const k = normalizeItemNumber(l.item_number);
    if (!k || k === 'FS-CUSTOM' || k.startsWith('06')) continue;
    const left = Math.max(0, Math.abs(Number(l.quantity) || 0) - Math.abs(Number(l.quantity_billed) || 0));
    if (left <= 0) continue;
    const m = rawNeed.get(l.so_id) || new Map<string, number>();
    add(m, k, left);
    rawNeed.set(l.so_id, m);
    items.add(k);
    if (!desc.has(k) && l.description) desc.set(k, String(l.description));
  }
  if (items.size === 0) return out;

  // ── Catalog: physical parts only, with what's on the shelf ──
  const cat = await inChunks([...items], part => service
    .from('netsuite_parts')
    .select('item_number, item_type, quantity_on_hand, display_name')
    .in('item_number', part));
  const onHand = new Map<string, number>();
  const physical = new Set<string>();
  for (const c of cat) {
    const k = normalizeItemNumber(c.item_number);
    if (!isCountedItem(k, c.item_type)) continue;
    physical.add(k);
    onHand.set(k, Math.max(onHand.get(k) || 0, Math.max(0, Number(c.quantity_on_hand) || 0)));
  }
  let generic = new Set<string>();
  try {
    generic = await loadGenericItems(service, physical);
  } catch (e) {
    console.error('so-parts-cover: generic parts lookup failed', e);
  }

  // ── Which estimate and job belong to each order ──
  const soByEstimate = new Map<string, string>(); // estimate id → mirror id
  for (const h of headers) if (h.estimate_id) soByEstimate.set(h.estimate_id, h.id);
  const mirrorByNs = new Map<string, string>(headers.map(h => [String(h.netsuite_id), h.id]));
  const ests = await inChunks(nsIds, part => service.from('estimates').select('id, netsuite_so_id').in('netsuite_so_id', part));
  for (const e of ests) {
    const mid = mirrorByNs.get(String(e.netsuite_so_id));
    if (mid) soByEstimate.set(e.id, mid);
  }
  const [projByNs, projByEst] = await Promise.all([
    inChunks(nsIds, part => service.from('upfit_projects').select('id, netsuite_so_id, estimate_id').in('netsuite_so_id', part)),
    inChunks([...soByEstimate.keys()], part => service.from('upfit_projects').select('id, netsuite_so_id, estimate_id').in('estimate_id', part)),
  ]);
  const soByProject = new Map<string, string>();
  for (const p of [...projByNs, ...projByEst]) {
    const mid = (p.netsuite_so_id && mirrorByNs.get(String(p.netsuite_so_id))) || (p.estimate_id && soByEstimate.get(p.estimate_id));
    if (mid) soByProject.set(p.id, mid);
  }

  // ── On a PO for this order: ordered purchase requests + drop ships ──
  const onPo = new Map<string, Map<string, number>>();
  const poAdd = (mid: string | undefined, item: string, qty: number) => {
    if (!mid || !item) return;
    const m = onPo.get(mid) || new Map<string, number>();
    add(m, item, qty);
    onPo.set(mid, m);
  };
  const REQ = 'id, item_number, quantity, status, source_estimate_id, source_project_id';
  const [reqE, reqP, drops] = await Promise.all([
    inChunks([...soByEstimate.keys()], part => service.from('purchase_requests').select(REQ).eq('status', 'ordered').in('source_estimate_id', part)),
    inChunks([...soByProject.keys()], part => service.from('purchase_requests').select(REQ).eq('status', 'ordered').in('source_project_id', part)),
    inChunks([...soByEstimate.keys()], part => service.from('drop_ship_orders').select('estimate_id, lines').in('estimate_id', part)),
  ]);
  const seenReq = new Set<string>();
  for (const r of [...reqE, ...reqP]) {
    if (seenReq.has(r.id)) continue;
    seenReq.add(r.id);
    const mid = (r.source_project_id && soByProject.get(r.source_project_id)) || (r.source_estimate_id && soByEstimate.get(r.source_estimate_id)) || undefined;
    poAdd(mid, normalizeItemNumber(r.item_number), Math.max(0, Number(r.quantity) || 0));
  }
  for (const d of drops) {
    for (const l of Array.isArray(d.lines) ? d.lines : []) {
      // A drop ship covers the whole line: it ships straight to the customer.
      poAdd(soByEstimate.get(d.estimate_id), normalizeItemNumber(String(l?.itemNumber || '')), Number.MAX_SAFE_INTEGER);
    }
  }

  // ── Holds: a job's or an order's estimate's hold belongs to that order;
  //    a quote's hold just takes the stock off the shelf ──
  const { data: allocs } = await fetchAllRows<any>((from, to) => service
    .from('part_allocations')
    .select('project_id, estimate_id, item_number, quantity')
    .eq('status', 'reserved')
    .in('item_number', [...physical])
    .order('id')
    .range(from, to));
  const pool = new Map(onHand);
  const held = new Map<string, Map<string, number>>();
  for (const a of allocs || []) {
    const k = normalizeItemNumber(a.item_number);
    const qty = Math.max(0, Number(a.quantity) || 0);
    const mid = (a.project_id && soByProject.get(a.project_id)) || (a.estimate_id && soByEstimate.get(a.estimate_id)) || undefined;
    if (mid) {
      const m = held.get(mid) || new Map<string, number>();
      add(m, k, qty);
      held.set(mid, m);
    } else {
      pool.set(k, Math.max(0, (pool.get(k) || 0) - qty));
    }
  }

  // ── Share the shelf, then judge each order ──
  const orders: CoverOrder[] = [];
  for (const [mid, need] of rawNeed) {
    const h = byMirrorId.get(mid);
    if (!h) continue;
    const needed = new Map([...need].filter(([k]) => physical.has(k)));
    if (needed.size === 0) continue;
    orders.push({
      key: mid,
      date: h.trandate || null,
      netsuiteId: String(h.netsuite_id),
      needed,
      onPo: onPo.get(mid) || new Map(),
      // Generic parts are judged by their requests only, never by stock.
      held: new Map([...(held.get(mid) || new Map<string, number>())].filter(([k]) => !generic.has(k))),
    });
  }
  const stockPool = new Map([...pool].filter(([k]) => !generic.has(k)));
  const stock = shareStock(orders.map(o => ({ ...o, needed: new Map([...o.needed].filter(([k]) => !generic.has(k))) })), stockPool);

  for (const o of orders) {
    if (wanted && !wanted.has(o.netsuiteId)) continue;
    const h = byMirrorId.get(o.key);
    const cover = deriveSoPartsCover({
      needed: o.needed,
      descriptions: desc,
      onPo: o.onPo,
      fromStock: stock.get(o.key) || new Map(),
      noStock: generic,
      mark: h?.parts_marked_at ? { at: h.parts_marked_at, byName: h.parts_marked_by_name || null, items: h.parts_marked_items || [] } : null,
    });
    if (cover) out.set(o.netsuiteId, cover);
  }
  return out;
}

/** Part numbers an order has now, for a hand mark. */
export async function currentPartItems(service: Db, mirrorId: string): Promise<string[]> {
  const { data } = await service.from('netsuite_sales_order_lines').select('item_number').eq('so_id', mirrorId);
  return [...new Set((data || []).map(l => normalizeItemNumber(l.item_number)).filter(Boolean))];
}
