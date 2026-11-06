/**
 * Server half of the Job progress bar (src/lib/job-progress.ts decides what
 * the rows mean). Loads, for a batch of approved estimates, every place a
 * job's progress leaves a trace: purchase requests and the PO lines they
 * landed on, drop ships, graphics jobs, drop-off appointments, the Arriving
 * list, the vehicles and their status history, and the sales order.
 *
 * Batch-shaped so the Job stages board can load a few hundred orders with a
 * handful of queries; one estimate is just a batch of one.
 *
 * Server-only: callers pass a service-role client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { deriveJobProgress, chicagoToday, describeJobParts, type JobProgressInput, type JobProgressView, type JobPart, type JobPartTrace } from './job-progress';
import { normalizeItemNumber } from './incoming-parts';
import { isOpenSalesOrderStatus } from './parts-demand';
import { VEHICLE_ROW_LABELS, vehicleRowKey } from './types';
import { loadSoPartsCover } from './so-parts-cover-server';
import type { SoPartsCover } from './so-parts-cover';
import { isGraphicsLine } from './graphics-lines';

type Db = SupabaseClient;

export const JOB_PROGRESS_ESTIMATE_COLUMNS =
  'id, estimate_number, title, customer_name, customer_approved, customer_approved_at, status, netsuite_so_id, fleet_checkin_id, fleet_group_id, parts_all_in_at, created_by, updated_at';

export function isApprovedEstimate(est: { customer_approved?: boolean | null; status?: string | null }): boolean {
  return !!(est.customer_approved || est.status === 'accepted');
}

const CHUNK = 150;
function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

/** Run one `.in(column, ids)` query per chunk and gather the rows. */
async function inChunks(
  ids: string[],
  run: (part: string[]) => PromiseLike<{ data: any[] | null; error: any }>,
): Promise<any[]> {
  const uniq = [...new Set(ids.filter(Boolean))];
  const out: any[] = [];
  for (const part of chunks(uniq)) {
    const { data, error } = await run(part);
    if (error) throw new Error(error.message || String(error));
    out.push(...(data || []));
  }
  return out;
}

const GRAPHICS_FINISHED: Record<string, string> = { installed: 'Graphics installed', picked_up: 'Picked up', shipped: 'Shipped' };
const VEHICLE_DONE = new Set(['complete', 'shipped']);
const earliest = (a: string | null, b: string | null) => (!a ? b : !b ? a : (a < b ? a : b));
const latest = (a: string | null, b: string | null) => (!a ? b : !b ? a : (a > b ? a : b));
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

export interface JobProgressResult {
  estimate: any;
  view: JobProgressView;
  /** Sales order number (SO1234) when synced. */
  soNumber: string | null;
  /** The sales order is billed, closed or cancelled. */
  soClosed: boolean;
  /** Fleet check-ins tied to the order. */
  vehicleIds: string[];
  /** Every part on the order and where it stands (the bar's parts list). */
  parts: JobPart[];
  /** NetSuite id of the sales order, for its Parts card link. */
  soNetsuiteId: string | null;
}

/** `estimates` must carry JOB_PROGRESS_ESTIMATE_COLUMNS and be approved. */
export async function loadJobProgress(service: Db, estimates: any[], now: Date = new Date()): Promise<Map<string, JobProgressResult>> {
  const out = new Map<string, JobProgressResult>();
  const ests = estimates.filter(e => e && isApprovedEstimate(e));
  if (ests.length === 0) return out;
  const ids = ests.map(e => e.id as string);
  const today = chicagoToday(now);

  // ── Things hung directly on the estimate ──
  const soIds = ests.map(e => e.netsuite_so_id).filter(Boolean).map(String);
  const fleetIds = [...new Set(ests.map(e => e.fleet_group_id).filter(Boolean).map(String))];
  // A job counts for the order when it was made from the estimate, from the
  // sales order's page (netsuite_so_id, migration 523), or is the fleet
  // order's one job (fleet_group_id, migration 411).
  const GJ = 'id, estimate_id, netsuite_so_id, fleet_group_id, status, customer_approved, customer_approved_at, delivery_method, scheduled_install_date, install_arrival_time, updated_at';
  const [projects, jobs, jobsBySo, jobsByFleet, gfxLineRows, dropShips, appts, sosById, sosByEst] = await Promise.all([
    inChunks(ids, part => service.from('upfit_projects').select('id, estimate_id').in('estimate_id', part)),
    inChunks(ids, part => service.from('graphics_jobs').select(GJ).in('estimate_id', part)),
    inChunks(soIds, part => service.from('graphics_jobs').select(GJ).in('netsuite_so_id', part)),
    inChunks(fleetIds, part => service.from('graphics_jobs').select(GJ).in('fleet_group_id', part)),
    // Graphics lines on the estimate: with no job, the step asks for one.
    // Filtered in the query (reads cap at 1000 rows); isGraphicsLine decides.
    inChunks(ids, part => service.from('estimate_line_items').select('estimate_id, item_number, description, wrap_quote_id')
      .in('estimate_id', part)
      .or('wrap_quote_id.not.is.null,item_number.in.("3M Vinyl","Graphics Install Labor"),description.ilike.*sqft @*,description.ilike.Graphics install labor*')),
    inChunks(ids, part => service.from('drop_ship_orders').select('estimate_id, lines, created_at, purchase_order_number, vendor_name').in('estimate_id', part)),
    inChunks(ids, part => service.from('shop_appointments').select('estimate_id, slot_date, slot_time, status')
      .in('estimate_id', part).eq('kind', 'dropoff').neq('status', 'cancelled')),
    inChunks(soIds, part => service.from('netsuite_sales_orders').select('netsuite_id, tranid, status, status_label, estimate_id').in('netsuite_id', part)),
    inChunks(ids, part => service.from('netsuite_sales_orders').select('netsuite_id, tranid, status, status_label, estimate_id').in('estimate_id', part)),
  ]);

  const projectToEst = new Map<string, string>();
  for (const p of projects) if (p.estimate_id) projectToEst.set(p.id, p.estimate_id);
  const jobsByEst = new Map<string, any[]>();
  const jobToEst = new Map<string, string>();
  const estsBySoId = new Map<string, string[]>();
  const estsByFleet = new Map<string, string[]>();
  for (const e of ests) {
    if (e.netsuite_so_id) push(estsBySoId, String(e.netsuite_so_id), e.id);
    if (e.fleet_group_id) push(estsByFleet, String(e.fleet_group_id), e.id);
  }
  const idSet = new Set(ids);
  const jobSeen = new Set<string>();
  const addJob = (estId: string | null | undefined, j: any) => {
    if (!estId || jobSeen.has(`${estId}:${j.id}`)) return;
    jobSeen.add(`${estId}:${j.id}`);
    push(jobsByEst, estId, j);
    if (!jobToEst.has(j.id)) jobToEst.set(j.id, estId);
  };
  for (const j of [...jobs, ...jobsBySo, ...jobsByFleet]) {
    if (j.status === 'cancelled' || j.status === 'flagged') continue;
    if (idSet.has(j.estimate_id)) addJob(j.estimate_id, j);
    for (const estId of estsBySoId.get(String(j.netsuite_so_id || '')) || []) addJob(estId, j);
    for (const estId of estsByFleet.get(String(j.fleet_group_id || '')) || []) addJob(estId, j);
  }
  const estHasGfxLines = new Set<string>();
  for (const l of gfxLineRows) if (isGraphicsLine(l)) estHasGfxLines.add(l.estimate_id);
  const dropByEst = new Map<string, any[]>();
  for (const d of dropShips) push(dropByEst, d.estimate_id, d);
  const apptsByEst = new Map<string, any[]>();
  for (const a of appts) push(apptsByEst, a.estimate_id, a);
  const soByEst = new Map<string, any[]>();
  const soSeen = new Set<string>();
  const estBySo = new Map<string, string>();
  for (const e of ests) if (e.netsuite_so_id) estBySo.set(String(e.netsuite_so_id), e.id);
  for (const so of [...sosById, ...sosByEst]) {
    const estId = estBySo.get(String(so.netsuite_id)) || so.estimate_id;
    const k = `${estId}:${so.netsuite_id}`;
    if (!estId || soSeen.has(k)) continue;
    soSeen.add(k);
    push(soByEst, estId, so);
  }

  // ── Purchase requests: from the estimate or its upfit project ──
  const REQ = 'id, item_number, description, vendor_name, quantity, status, ordered_at, ordered_po_id, ordered_po_number, received_at, source_estimate_id, source_project_id';
  const [reqByEstRows, reqByProjRows] = await Promise.all([
    inChunks(ids, part => service.from('purchase_requests').select(REQ).in('source_estimate_id', part)),
    inChunks([...projectToEst.keys()], part => service.from('purchase_requests').select(REQ).in('source_project_id', part)),
  ]);
  const reqsByEst = new Map<string, Map<string, any>>();
  const addReq = (estId: string | undefined, r: any) => {
    if (!estId) return;
    const m = reqsByEst.get(estId) || new Map<string, any>();
    m.set(r.id, r);
    reqsByEst.set(estId, m);
  };
  for (const r of reqByEstRows) addReq(r.source_estimate_id, r);
  for (const r of reqByProjRows) addReq(projectToEst.get(r.source_project_id), r);

  // PO lines those requests landed on, for what has been received.
  const allReqs = [...reqsByEst.values()].flatMap(m => [...m.values()]).filter(r => r.status === 'ordered');
  const poNumbers = allReqs.filter(r => !r.ordered_po_id && r.ordered_po_number).map(r => String(r.ordered_po_number));
  const posByNumber = await inChunks(poNumbers, part => service.from('netsuite_vendor_pos').select('id, tranid').in('tranid', part));
  const poIdByNumber = new Map<string, string>();
  for (const po of posByNumber) if (po.tranid) poIdByNumber.set(String(po.tranid), po.id);
  const poIdOf = (r: any): string | null => r.ordered_po_id || (r.ordered_po_number ? poIdByNumber.get(String(r.ordered_po_number)) || null : null);
  const poIds = allReqs.map(poIdOf).filter(Boolean) as string[];
  const poHeads = await inChunks(poIds, part => service.from('netsuite_vendor_pos').select('id, tranid, vendor_name, eta_date').in('id', part));
  const poHead = new Map<string, any>();
  for (const po of poHeads) poHead.set(po.id, po);
  const poLines = await inChunks(poIds, part => service.from('netsuite_vendor_po_lines')
    .select('po_id, item_number, quantity, quantity_received').in('po_id', part));
  // po_id:item → [ordered, received]
  const lineQty = new Map<string, { qty: number; got: number }>();
  for (const l of poLines) {
    const k = `${l.po_id}:${normalizeItemNumber(l.item_number)}`;
    const cur = lineQty.get(k) || { qty: 0, got: 0 };
    cur.qty += Number(l.quantity) || 0;
    cur.got += Number(l.quantity_received) || 0;
    lineQty.set(k, cur);
  }

  // ── The Arriving list ──
  const projIds = [...projectToEst.keys()];
  const jobIds = [...jobToEst.keys()];
  const INB = 'source_type, source_id, expected_date, status, updated_at, fleet_checkin_id';
  const [inbSo, inbJob, inbProj] = await Promise.all([
    inChunks(ids, part => service.from('shop_inbound').select(INB).eq('source_type', 'sales_order').in('source_id', part).neq('status', 'cancelled')),
    inChunks(jobIds, part => service.from('shop_inbound').select(INB).eq('source_type', 'graphics_job').in('source_id', part).neq('status', 'cancelled')),
    inChunks(projIds, part => service.from('shop_inbound').select(INB).eq('source_type', 'upfit_project').in('source_id', part).neq('status', 'cancelled')),
  ]);
  const inbByEst = new Map<string, any[]>();
  for (const r of inbSo) push(inbByEst, r.source_id, r);
  for (const r of inbJob) { const e = jobToEst.get(r.source_id); if (e) push(inbByEst, e, r); }
  for (const r of inbProj) { const e = projectToEst.get(r.source_id); if (e) push(inbByEst, e, r); }

  // ── Vehicles ──
  const VEH = 'id, status, shop_stage, graphics_install_status, upfit_completed_at, created_at, updated_at, invoice_number, date_invoiced, source_estimate_id';
  const linkedCheckins = new Map<string, string>(); // checkin → estimate
  for (const e of ests) if (e.fleet_checkin_id) linkedCheckins.set(e.fleet_checkin_id, e.id);
  for (const [estId, rows] of inbByEst) for (const r of rows) if (r.fleet_checkin_id) linkedCheckins.set(r.fleet_checkin_id, estId);
  const [vehBySource, vehById] = await Promise.all([
    inChunks(ids, part => service.from('fleet_checkins').select(VEH).in('source_estimate_id', part)),
    inChunks([...linkedCheckins.keys()], part => service.from('fleet_checkins').select(VEH).in('id', part)),
  ]);
  const vehByEst = new Map<string, Map<string, any>>();
  const addVeh = (estId: string | undefined, v: any) => {
    if (!estId) return;
    const m = vehByEst.get(estId) || new Map<string, any>();
    m.set(v.id, v);
    vehByEst.set(estId, m);
  };
  for (const v of vehBySource) addVeh(v.source_estimate_id, v);
  for (const v of vehById) addVeh(linkedCheckins.get(v.id), v);
  const vehicleIds = [...vehByEst.values()].flatMap(m => [...m.keys()]);
  const history = await inChunks(vehicleIds, part => service.from('vehicle_status_history')
    .select('vehicle_id, to_status, created_at').in('vehicle_id', part).in('to_status', ['in_progress', 'complete', 'shipped']));
  const histByVeh = new Map<string, any[]>();
  for (const h of history) push(histByVeh, h.vehicle_id, h);

  // ── Invoices billed from the sales order ──
  const billedEst = ests.filter(e => (soByEst.get(e.id) || []).some(so =>
    String(so.status || '').toUpperCase() === 'G' || /^billed$/i.test(String(so.status_label || '').trim()))).map(e => e.id);
  const invRows = await inChunks(billedEst, part => service.from('estimate_invoices')
    .select('estimate_id, invoice_number, invoice_date').in('estimate_id', part));
  const invByEst = new Map<string, any[]>();
  for (const r of invRows) push(invByEst, r.estimate_id, r);

  // ── Parts ordered on the sales order: on a PO or in stock (2026-11-06,
  //    src/lib/so-parts-cover.ts). A failure just leaves the request count. ──
  let covers = new Map<string, SoPartsCover>();
  const openSoIds = [...soByEst.values()].flat()
    .filter(so => isOpenSalesOrderStatus(so.status, so.status_label)).map(so => String(so.netsuite_id));
  if (openSoIds.length > 0) {
    try {
      covers = await loadSoPartsCover(service, openSoIds);
    } catch (e) {
      console.error('job progress: parts check failed', e);
    }
  }

  for (const est of ests) {
    const estId: string = est.id;
    const liveJobs = jobsByEst.get(estId) || [];
    const vehicles = [...(vehByEst.get(estId)?.values() || [])];
    const inbound = inbByEst.get(estId) || [];
    const sos = soByEst.get(estId) || [];

    // Parts: one entry per part number. Ordered when every live request for
    // it is ordered; received when every ordered one is (PO line received,
    // or "Got it"). Drop ships ship straight out, so they count as both.
    const parts = new Map<string, { ordered: boolean; received: boolean }>();
    const traces = new Map<string, JobPartTrace>();
    const trace = (k: string, item: string): JobPartTrace => {
      let t = traces.get(k);
      if (!t) {
        t = { itemNumber: item || k, description: null, quantity: null, requested: false, ordered: false, received: false,
          poNumbers: [], vendors: [], eta: null, gotItAt: null, fromStock: false, dropShip: null, markedOrdered: false };
        traces.set(k, t);
      }
      return t;
    };
    const addTo = (list: string[], v: string | null | undefined) => { if (v && !list.includes(v)) list.push(v); };
    let orderedAt: string | null = null;
    let receivedAt: string | null = null;
    for (const r of reqsByEst.get(estId)?.values() || []) {
      if (r.status === 'cancelled') continue;
      const k = normalizeItemNumber(r.item_number) || `#${r.id}`;
      const ordered = r.status === 'ordered';
      let received = !!r.received_at;
      if (ordered && !received) {
        const po = poIdOf(r);
        const line = po ? lineQty.get(`${po}:${normalizeItemNumber(r.item_number)}`) : null;
        received = !!line && line.qty > 0 && line.got >= line.qty;
      }
      const cur = parts.get(k) || { ordered: true, received: true };
      parts.set(k, { ordered: cur.ordered && ordered, received: cur.received && ordered && received });
      const tr = trace(k, String(r.item_number || '').trim());
      tr.requested = true;
      tr.description = tr.description || r.description || null;
      tr.quantity = (tr.quantity || 0) + (Number(r.quantity) || 0);
      if (ordered) {
        const head = poIdOf(r) ? poHead.get(poIdOf(r)!) : null;
        addTo(tr.poNumbers, head?.tranid || r.ordered_po_number || null);
        addTo(tr.vendors, head?.vendor_name || r.vendor_name || null);
        if (head?.eta_date && !received && (!tr.eta || head.eta_date < tr.eta)) tr.eta = String(head.eta_date).slice(0, 10);
      }
      if (r.received_at && !poIdOf(r)) tr.gotItAt = latest(tr.gotItAt, r.received_at);
      if (ordered) orderedAt = latest(orderedAt, r.ordered_at || null);
      if (r.received_at) receivedAt = latest(receivedAt, r.received_at);
    }
    for (const d of dropByEst.get(estId) || []) {
      for (const l of Array.isArray(d.lines) ? d.lines : []) {
        const k = normalizeItemNumber(String(l?.itemNumber || ''));
        if (!k) continue;
        parts.set(k, { ordered: true, received: true });
        const tr = trace(k, String(l.itemNumber).trim());
        tr.description = tr.description || l?.description || null;
        tr.quantity = tr.quantity ?? (Number(l?.quantity) || null);
        tr.dropShip = d.purchase_order_number || '';
        addTo(tr.vendors, d.vendor_name || null);
      }
      orderedAt = latest(orderedAt, d.created_at || null);
    }
    // The sales order's own check counts stock and every part line, not just
    // what was requested: a part filled from the shelf is ordered and in.
    for (const so of sos) {
      const cover = covers.get(String(so.netsuite_id));
      if (!cover) continue;
      for (const p of cover.parts) {
        const cur = parts.get(p.item_number);
        const tr = trace(p.item_number, p.item_number);
        tr.description = tr.description || p.description || null;
        tr.quantity = Math.max(tr.quantity || 0, p.needed || 0) || null;
        if (cover.marked && p.state === 'missing') tr.markedOrdered = true;
        if (p.state === 'stock') tr.fromStock = true;
        if (cover.marked || p.state === 'po' || p.state === 'mixed') {
          parts.set(p.item_number, { ordered: true, received: cur?.received ?? false });
        } else if (p.state === 'stock') {
          parts.set(p.item_number, { ordered: true, received: true });
        } else if (!cur) {
          parts.set(p.item_number, { ordered: false, received: false });
        }
      }
      if (cover.marked) orderedAt = latest(orderedAt, cover.marked.at);
    }
    const partList = [...parts.values()];
    for (const [k, v] of parts) { const tr = trace(k, k); tr.ordered = v.ordered; tr.received = v.received; }

    // Scheduled: the earliest live date anywhere.
    let schedule: JobProgressInput['schedule'] = null;
    const offer = (date: string | null | undefined, time: string | null | undefined, place: 'shop' | 'onsite') => {
      if (!date) return;
      if (!schedule || date < schedule.date) schedule = { date: String(date).slice(0, 10), time: time || null, place };
    };
    for (const a of apptsByEst.get(estId) || []) offer(a.slot_date, a.slot_time, 'shop');
    for (const r of inbound) offer(r.expected_date, null, 'shop');
    for (const j of liveJobs) {
      if (j.delivery_method === 'onsite_install') offer(j.scheduled_install_date, j.install_arrival_time, 'onsite');
      else if (j.delivery_method === 'bmg_shop') offer(j.scheduled_install_date, j.install_arrival_time, 'shop');
    }
    const onsite = vehicles.length === 0 && liveJobs.some(j => j.delivery_method === 'onsite_install');

    // Arrived: the earliest check-in.
    let arrivedAt: string | null = null;
    for (const v of vehicles) arrivedAt = earliest(arrivedAt, v.created_at || null);
    for (const r of inbound) if (r.status === 'arrived') arrivedAt = earliest(arrivedAt, r.updated_at || null);

    // Install: a tech moved a vehicle to work (Graphics / Upfit in progress).
    let installStartedAt: string | null = null;
    let installLabel: string | null = null;
    for (const v of vehicles) {
      const started = v.status === 'in_progress' || VEHICLE_DONE.has(v.status)
        || v.graphics_install_status === 'in_progress' || v.graphics_install_status === 'complete' || !!v.upfit_completed_at;
      if (!started) continue;
      let at: string | null = null;
      for (const h of histByVeh.get(v.id) || []) if (h.to_status === 'in_progress') at = earliest(at, h.created_at);
      installStartedAt = earliest(installStartedAt, at || v.updated_at || v.created_at || null);
      if (v.status === 'in_progress') installLabel = VEHICLE_ROW_LABELS[vehicleRowKey(v)] || null;
    }

    // Complete: every vehicle finished, or (no vehicles) every graphics job.
    let complete: JobProgressInput['complete'] = null;
    if (vehicles.length > 0) {
      if (vehicles.every(v => VEHICLE_DONE.has(v.status))) {
        let at: string | null = null;
        for (const v of vehicles) for (const h of histByVeh.get(v.id) || []) if (VEHICLE_DONE.has(h.to_status)) at = latest(at, h.created_at);
        for (const v of vehicles) if (!at) at = v.updated_at || null;
        complete = { at, label: vehicles.some(v => v.status === 'shipped') ? 'Shipped' : 'Ready for pickup' };
      }
    } else if (liveJobs.length > 0 && liveJobs.every(j => GRAPHICS_FINISHED[j.status])) {
      let at: string | null = null;
      for (const j of liveJobs) at = latest(at, j.updated_at || null);
      const labels = new Set(liveJobs.map(j => GRAPHICS_FINISHED[j.status]));
      complete = { at, label: labels.size === 1 ? [...labels][0] : 'Finished' };
    }

    // Invoiced: the sales order is billed, or every vehicle carries an invoice.
    let invoiced: JobProgressInput['invoiced'] = null;
    const soBilled = billedEst.includes(estId);
    if (soBilled || (vehicles.length > 0 && vehicles.every(v => v.invoice_number))) {
      const inv = invByEst.get(estId) || [];
      const fromSo = inv.map(r => r.invoice_number).filter(Boolean);
      const numbers = [...new Set(fromSo.length ? fromSo : vehicles.map(v => v.invoice_number).filter(Boolean))];
      let at: string | null = null;
      for (const r of inv) at = latest(at, r.invoice_date || null);
      for (const v of vehicles) at = latest(at, v.date_invoiced || null);
      invoiced = { at, number: numbers.length ? numbers.join(', ') : null };
    }

    const view = deriveJobProgress({
      approved: true,
      approvedAt: est.customer_approved_at || null,
      parts: {
        total: partList.length,
        ordered: partList.filter(x => x.ordered).length,
        received: partList.filter(x => x.received).length,
        orderedAt,
        receivedAt,
      },
      partsAllInAt: est.parts_all_in_at || null,
      graphics: liveJobs.map(j => ({ status: j.status, approved: !!j.customer_approved, approvedAt: j.customer_approved_at || null })),
      graphicsLines: estHasGfxLines.has(estId),
      schedule,
      onsite,
      arrivedAt,
      installStartedAt,
      installLabel,
      complete,
      invoiced,
      today,
    });

    out.set(estId, {
      estimate: est,
      view,
      soNumber: sos.map(s => s.tranid).filter(Boolean)[0] || null,
      soClosed: sos.length > 0 && sos.every(s => !isOpenSalesOrderStatus(s.status, s.status_label)),
      vehicleIds: vehicles.map(v => v.id),
      parts: describeJobParts([...traces.values()], est.parts_all_in_at || null),
      soNetsuiteId: sos.map(so => String(so.netsuite_id)).filter(Boolean)[0] || null,
    });
  }
  return out;
}

/** Which estimate an order, graphics job or vehicle belongs to. */
export async function resolveJobEstimateId(service: Db, ref: { estimate?: string | null; so?: string | null; graphicsJob?: string | null; checkin?: string | null }): Promise<string | null> {
  if (ref.estimate) return ref.estimate;
  if (ref.so) {
    const { data: est } = await service.from('estimates').select('id').eq('netsuite_so_id', ref.so).limit(1).maybeSingle();
    if (est?.id) return est.id;
    const { data: so } = await service.from('netsuite_sales_orders').select('estimate_id').eq('netsuite_id', ref.so).maybeSingle();
    return (so?.estimate_id as string) || null;
  }
  if (ref.graphicsJob) {
    const { data } = await service.from('graphics_jobs').select('estimate_id').eq('id', ref.graphicsJob).maybeSingle();
    return (data?.estimate_id as string) || null;
  }
  if (ref.checkin) {
    const { data: v } = await service.from('fleet_checkins').select('source_estimate_id').eq('id', ref.checkin).maybeSingle();
    if (v?.source_estimate_id) return v.source_estimate_id as string;
    const { data: est } = await service.from('estimates').select('id').eq('fleet_checkin_id', ref.checkin).limit(1).maybeSingle();
    if (est?.id) return est.id as string;
    const { data: inb } = await service.from('shop_inbound').select('source_type, source_id').eq('fleet_checkin_id', ref.checkin).neq('status', 'cancelled').limit(5);
    for (const r of inb || []) {
      if (r.source_type === 'sales_order') return r.source_id as string;
      if (r.source_type === 'graphics_job') {
        const { data } = await service.from('graphics_jobs').select('estimate_id').eq('id', r.source_id).maybeSingle();
        if (data?.estimate_id) return data.estimate_id as string;
      }
      if (r.source_type === 'upfit_project') {
        const { data } = await service.from('upfit_projects').select('estimate_id').eq('id', r.source_id).maybeSingle();
        if (data?.estimate_id) return data.estimate_id as string;
      }
    }
  }
  return null;
}
