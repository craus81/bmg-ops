import type { SupabaseClient } from '@supabase/supabase-js';
import { computeEstimateReadiness } from '@/lib/estimate-readiness';
import { suiteqlQueryAll } from '@/lib/netsuite';
import { isOpenSalesOrderStatus } from '@/lib/parts-demand';
import { derivePartsStage, soStock, type PartsStageRequest, type PartsStageResult, type SoStockLine } from '@/lib/estimate-parts-stage';

/**
 * Loads what derivePartsStage needs for a batch of estimates: approval, the
 * sales order's status, purchase requests (raised from the estimate or its
 * upfit project), drop ship POs, and, for approved estimates with nothing
 * requested, a stock check. Returns only the estimates that get a tag.
 *
 * Server-only: callers pass a service-role client.
 */

const CHUNK = 200;

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

export async function loadEstimatePartsStages(
  service: SupabaseClient,
  estimateIds: string[],
  opts: {
    /** Ask NetSuite for stock (one estimate's banner) or use the mirror (lists). */
    liveStock: boolean;
    /** Most stock checks to run in one call; the rest stay Approved. */
    maxStockChecks: number;
  },
): Promise<Record<string, PartsStageResult>> {
  const ids = [...new Set(estimateIds)];
  if (ids.length === 0) return {};

  const estimates: any[] = [];
  for (const part of chunks(ids)) {
    const { data, error } = await service.from('estimates')
      .select('id, status, customer_approved, netsuite_so_id, vehicle_count')
      .in('id', part);
    if (error) throw new Error(error.message);
    estimates.push(...(data || []));
  }
  // In the caller's order, so the stock-check cap goes to the rows it lists first.
  const order = new Map(ids.map((id, i) => [id, i]));
  const approved = estimates
    .filter(e => e.customer_approved || e.status === 'accepted')
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  if (approved.length === 0) return {};
  const approvedIds = approved.map(e => e.id as string);

  // ── Sales orders: a billed / closed / cancelled job gets no tag ──
  const soIds = [...new Set(approved.map(e => e.netsuite_so_id).filter(Boolean))] as string[];
  const closedSo = new Set<string>();
  for (const part of chunks(soIds)) {
    const { data } = await service.from('netsuite_sales_orders')
      .select('netsuite_id, status, status_label')
      .in('netsuite_id', part);
    for (const so of data || []) {
      if (!isOpenSalesOrderStatus(so.status, so.status_label)) closedSo.add(String(so.netsuite_id));
    }
  }

  // ── Upfit projects: asks made from the project card carry only its id ──
  const projectToEstimate = new Map<string, string>();
  for (const part of chunks(approvedIds)) {
    const { data } = await service.from('upfit_projects')
      .select('id, estimate_id')
      .in('estimate_id', part);
    for (const p of data || []) if (p.estimate_id) projectToEstimate.set(p.id, p.estimate_id);
  }

  // ── Purchase requests, by estimate or by its project ──
  const requestsByEstimate = new Map<string, Map<string, any>>();
  const addRequest = (estimateId: string, r: any) => {
    const m = requestsByEstimate.get(estimateId) || new Map<string, any>();
    m.set(r.id, r); // a row can match on both columns
    requestsByEstimate.set(estimateId, m);
  };
  const REQ_COLS = 'id, item_number, status, ordered_po_id, ordered_po_number, source_estimate_id, source_project_id';
  for (const part of chunks(approvedIds)) {
    const { data } = await service.from('purchase_requests').select(REQ_COLS).in('source_estimate_id', part);
    for (const r of data || []) addRequest(r.source_estimate_id, r);
  }
  for (const part of chunks([...projectToEstimate.keys()])) {
    const { data } = await service.from('purchase_requests').select(REQ_COLS).in('source_project_id', part);
    for (const r of data || []) {
      const est = projectToEstimate.get(r.source_project_id);
      if (est) addRequest(est, r);
    }
  }
  // PO numbers for requests linked to a mirrored PO.
  const poIds = new Set<string>();
  for (const m of requestsByEstimate.values()) for (const r of m.values()) if (r.ordered_po_id) poIds.add(r.ordered_po_id);
  const poNumber = new Map<string, string>();
  for (const part of chunks([...poIds])) {
    const { data } = await service.from('netsuite_vendor_pos').select('id, tranid').in('id', part);
    for (const po of data || []) if (po.tranid) poNumber.set(po.id, po.tranid);
  }

  // ── Drop ship POs made from the estimate ──
  const dropShips = new Map<string, { po_number: string | null; item_numbers: string[] }[]>();
  for (const part of chunks(approvedIds)) {
    const { data } = await service.from('drop_ship_orders')
      .select('estimate_id, purchase_order_number, lines')
      .in('estimate_id', part);
    for (const d of data || []) {
      if (!d.estimate_id) continue;
      const list = dropShips.get(d.estimate_id) || [];
      list.push({
        po_number: d.purchase_order_number || null,
        item_numbers: (Array.isArray(d.lines) ? d.lines : []).map((l: any) => String(l?.itemNumber || '')).filter(Boolean),
      });
      dropShips.set(d.estimate_id, list);
    }
  }

  // ── Stock check, only where nothing was requested (Craig's 2B) ──
  const nothingAsked = approved.filter(e => {
    if (e.netsuite_so_id && closedSo.has(String(e.netsuite_so_id))) return false;
    const reqs = [...(requestsByEstimate.get(e.id)?.values() || [])].filter(r => r.status !== 'cancelled');
    return reqs.length === 0 && !(dropShips.get(e.id)?.length);
  });
  const stockByEstimate = new Map<string, { parts: number; short: number; unknown: number; onOrder: number }>();

  // Converted to a sales order: NetSuite has already committed the stock to
  // that order, which takes it out of "available". Reading available would
  // call the job short of its own parts (Craig, 2026-10-31), so ask the
  // order itself instead: in stock = no inventory line is backordered.
  // One query covers every order in the batch.
  const withSo = nothingAsked.filter(e => e.netsuite_so_id && /^\d+$/.test(String(e.netsuite_so_id)));
  const soLinesById = new Map<string, SoStockLine[]>();
  for (const part of chunks(withSo.map(e => String(e.netsuite_so_id)))) {
    try {
      const rows = await suiteqlQueryAll(`
        SELECT tl.transaction AS so_id, tl.itemtype AS item_type,
               ABS(NVL(tl.quantity, 0)) AS qty, ABS(NVL(tl.quantitybackordered, 0)) AS backordered
        FROM transactionline tl
        WHERE tl.transaction IN (${part.join(', ')}) AND tl.mainline = 'F'
      `);
      for (const r of rows) {
        const id = String(r.so_id);
        const list = soLinesById.get(id) || [];
        list.push({ itemType: r.item_type, quantity: Number(r.qty) || 0, backordered: Number(r.backordered) || 0 });
        soLinesById.set(id, list);
      }
    } catch { /* NetSuite didn't answer: those jobs stay Approved */ }
  }
  for (const e of withSo) {
    const lines = soLinesById.get(String(e.netsuite_so_id));
    if (lines) stockByEstimate.set(e.id, soStock(lines));
  }

  // Not converted yet: the estimate's own lines against stock.
  const needStock = nothingAsked.filter(e => !withSo.includes(e)).slice(0, opts.maxStockChecks);
  const linesByEstimate = new Map<string, { item_number: string | null; quantity: number | null }[]>();
  for (const part of chunks(needStock.map(e => e.id as string))) {
    const { data } = await service.from('estimate_line_items')
      .select('estimate_id, item_number, quantity')
      .in('estimate_id', part)
      .order('estimate_id').order('sort_order').order('id')
      .limit(5000);
    for (const l of data || []) {
      const list = linesByEstimate.get(l.estimate_id) || [];
      list.push({ item_number: l.item_number, quantity: l.quantity });
      linesByEstimate.set(l.estimate_id, list);
    }
  }
  // Five at a time: each check is several reads, and a long list shouldn't
  // fire them all at once.
  for (let i = 0; i < needStock.length; i += 5) await Promise.all(needStock.slice(i, i + 5).map(async e => {
    try {
      const r = await computeEstimateReadiness(service, {
        estimateId: e.id,
        lines: linesByEstimate.get(e.id) || [],
        vehicleCount: e.vehicle_count ?? 1,
        liveStock: opts.liveStock,
      });
      stockByEstimate.set(e.id, {
        parts: r.parts.length, short: r.summary.short, unknown: r.summary.unknown, onOrder: r.summary.onOrder,
      });
    } catch { /* no stock answer: the tag stays Approved */ }
  }));

  const out: Record<string, PartsStageResult> = {};
  for (const e of approved) {
    const requests: PartsStageRequest[] = [...(requestsByEstimate.get(e.id)?.values() || [])].map(r => ({
      item_number: r.item_number,
      status: r.status,
      po_number: (r.ordered_po_id && poNumber.get(r.ordered_po_id)) || r.ordered_po_number || null,
    }));
    const result = derivePartsStage({
      approved: true,
      soClosed: !!(e.netsuite_so_id && closedSo.has(String(e.netsuite_so_id))),
      requests,
      dropShips: dropShips.get(e.id) || [],
      stock: stockByEstimate.get(e.id) || null,
    });
    if (result) out[e.id] = result;
  }
  return out;
}
