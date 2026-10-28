/**
 * Server half of the customer Order status page (src/lib/order-status.ts
 * decides what the rows mean). Loads every place an approved estimate's
 * progress leaves a trace and hands back ONLY customer-safe values: no
 * prices, no internal notes, no staff-only names beyond the rep to call.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { deriveOrderStatus, type OrderStatusInput, type OrderStatusView } from './order-status';
import { appBaseUrl } from './cni-schedule-feed';
import { deepLinks } from './deep-links';

type Db = SupabaseClient;

export const ORDER_STATUS_ESTIMATE_COLUMNS =
  'id, estimate_number, title, customer_id, customer_name, customer_netsuite_id, customer_approved, customer_approved_at, customer_responder, status, netsuite_so_id, fleet_checkin_id, parts_all_in_at, parts_all_in_by, order_status_token, approval_confirmation_sent_at, approval_confirmation_sent_by, created_by, sent_for_approval_by';

export function isEstimateApproved(est: { customer_approved?: boolean | null; status?: string | null }): boolean {
  return !!(est.customer_approved || est.status === 'accepted');
}

export function orderStatusUrl(token: string): string {
  return `${appBaseUrl()}${deepLinks.orderStatus(token)}`;
}

/** The estimate's link token, minted on first use. */
export async function ensureOrderStatusToken(service: Db, estimate: { id: string; order_status_token?: string | null }): Promise<string> {
  if (estimate.order_status_token) return estimate.order_status_token;
  const token = crypto.randomUUID();
  // Only fill an empty slot, so two first clicks can't leave two links.
  await service.from('estimates').update({ order_status_token: token }).eq('id', estimate.id).is('order_status_token', null);
  const { data } = await service.from('estimates').select('order_status_token').eq('id', estimate.id).maybeSingle();
  return (data?.order_status_token as string) || token;
}

const GRAPHICS_FINISHED: Record<string, string> = { installed: 'Installed', picked_up: 'Picked up', shipped: 'Shipped' };
const VEHICLE_DONE = new Set(['complete', 'shipped']);
const earliest = (a: string | null, b: string | null) => (!a ? b : !b ? a : (a < b ? a : b));
const latest = (a: string | null, b: string | null) => (!a ? b : !b ? a : (a > b ? a : b));

/** Gather the rows and derive the view. `estimate` must carry ORDER_STATUS_ESTIMATE_COLUMNS. */
export async function loadOrderStatus(service: Db, estimate: any): Promise<OrderStatusView> {
  const estId: string = estimate.id;

  const [{ data: projects }, { data: jobs }, { data: dropShips }, { data: appts }, { data: sos }] = await Promise.all([
    service.from('upfit_projects').select('id').eq('estimate_id', estId),
    service.from('graphics_jobs').select('id, status, delivery_method, scheduled_install_date, install_arrival_time, updated_at').eq('estimate_id', estId),
    service.from('drop_ship_orders').select('lines, created_at').eq('estimate_id', estId),
    service.from('shop_appointments').select('slot_date, slot_time, status').eq('estimate_id', estId).eq('kind', 'dropoff').neq('status', 'cancelled'),
    estimate.netsuite_so_id
      ? service.from('netsuite_sales_orders').select('status, status_label').eq('netsuite_id', String(estimate.netsuite_so_id))
      : service.from('netsuite_sales_orders').select('status, status_label').eq('estimate_id', estId),
  ]);
  const projectIds = (projects || []).map((p: any) => p.id as string);
  const liveJobs = (jobs || []).filter((j: any) => j.status !== 'cancelled' && j.status !== 'flagged');

  // Purchase requests: from the estimate itself or its upfit project.
  const reqFilter = projectIds.length
    ? `source_estimate_id.eq.${estId},source_project_id.in.(${projectIds.join(',')})`
    : `source_estimate_id.eq.${estId}`;
  const inboundFilter = [
    `and(source_type.eq.sales_order,source_id.eq.${estId})`,
    ...(liveJobs.length ? [`and(source_type.eq.graphics_job,source_id.in.(${liveJobs.map((j: any) => j.id).join(',')}))`] : []),
    ...(projectIds.length ? [`and(source_type.eq.upfit_project,source_id.in.(${projectIds.join(',')}))`] : []),
  ].join(',');
  const [{ data: requests }, { data: inbound }] = await Promise.all([
    service.from('purchase_requests').select('item_number, status, ordered_at').or(reqFilter),
    service.from('shop_inbound').select('expected_date, status, updated_at, fleet_checkin_id').or(inboundFilter).neq('status', 'cancelled'),
  ]);

  // Vehicles: the linked check-in, any made from the estimate, and any the
  // Arriving list matched when they came in.
  const checkinIds = new Set<string>();
  if (estimate.fleet_checkin_id) checkinIds.add(estimate.fleet_checkin_id);
  for (const r of inbound || []) if ((r as any).fleet_checkin_id) checkinIds.add((r as any).fleet_checkin_id);
  const checkinOr = checkinIds.size
    ? `source_estimate_id.eq.${estId},id.in.(${[...checkinIds].join(',')})`
    : `source_estimate_id.eq.${estId}`;
  const { data: checkins } = await service
    .from('fleet_checkins')
    .select('id, status, created_at, updated_at, invoice_number, date_invoiced')
    .or(checkinOr);
  const vehicles = (checkins || []) as any[];
  const doneVehicleIds = vehicles.filter(v => VEHICLE_DONE.has(v.status)).map(v => v.id);
  const { data: history } = doneVehicleIds.length
    ? await service.from('vehicle_status_history').select('vehicle_id, to_status, created_at').in('vehicle_id', doneVehicleIds).in('to_status', [...VEHICLE_DONE])
    : { data: [] as any[] };

  // ── Scheduled: the earliest live date anywhere ──
  let schedule: OrderStatusInput['schedule'] = null;
  const offer = (date: string | null | undefined, time: string | null | undefined, place: 'shop' | 'onsite') => {
    if (!date) return;
    if (!schedule || date < schedule.date) schedule = { date, time: time || null, place };
  };
  for (const a of (appts || []) as any[]) offer(a.slot_date, a.slot_time, 'shop');
  for (const r of (inbound || []) as any[]) offer(r.expected_date, null, 'shop');
  for (const j of liveJobs as any[]) {
    if (j.delivery_method === 'onsite_install') offer(j.scheduled_install_date, j.install_arrival_time, 'onsite');
    else if (j.delivery_method === 'bmg_shop') offer(j.scheduled_install_date, j.install_arrival_time, 'shop');
  }

  // ── In the shop ──
  let inShopAt: string | null = null;
  for (const v of vehicles) inShopAt = earliest(inShopAt, v.created_at || null);
  for (const r of (inbound || []) as any[]) if (r.status === 'arrived') inShopAt = earliest(inShopAt, r.updated_at || null);

  // ── Done: every vehicle finished, or (no vehicles) every graphics job ──
  let done: OrderStatusInput['done'] = null;
  if (vehicles.length > 0) {
    if (vehicles.every(v => VEHICLE_DONE.has(v.status))) {
      let at: string | null = null;
      for (const h of (history || []) as any[]) at = latest(at, h.created_at || null);
      for (const v of vehicles) if (!at) at = v.updated_at || null;
      done = { at, label: vehicles.some(v => v.status === 'shipped') ? 'On its way back to you' : 'Ready for pickup' };
    }
  } else if (liveJobs.length > 0 && liveJobs.every((j: any) => GRAPHICS_FINISHED[j.status])) {
    let at: string | null = null;
    for (const j of liveJobs as any[]) at = latest(at, j.updated_at || null);
    const labels = new Set(liveJobs.map((j: any) => GRAPHICS_FINISHED[j.status]));
    done = { at, label: labels.size === 1 ? [...labels][0] : 'Finished' };
  }

  // ── Invoiced: the sales order is billed, or every vehicle carries an invoice ──
  let invoiced: OrderStatusInput['invoiced'] = null;
  // NetSuite SO status G = Billed.
  const soBilled = ((sos || []) as any[]).some(s =>
    String(s.status || '').toUpperCase() === 'G' || /^billed$/i.test(String(s.status_label || '').trim()));
  const vehiclesInvoiced = vehicles.length > 0 && vehicles.every(v => v.invoice_number);
  if (soBilled || vehiclesInvoiced) {
    const numbers = [...new Set(vehicles.map(v => v.invoice_number).filter(Boolean))];
    let at: string | null = null;
    for (const v of vehicles) at = latest(at, v.date_invoiced || null);
    invoiced = { at, number: numbers.length ? numbers.join(', ') : null };
  }

  return deriveOrderStatus({
    approved: isEstimateApproved(estimate),
    approvedAt: estimate.customer_approved_at || null,
    approvedBy: estimate.customer_responder || null,
    requests: (requests || []) as any[],
    dropShips: ((dropShips || []) as any[]).map(d => ({
      item_numbers: (Array.isArray(d.lines) ? d.lines : []).map((l: any) => String(l?.itemNumber || '')).filter(Boolean),
      created_at: d.created_at || null,
    })),
    partsAllInAt: estimate.parts_all_in_at || null,
    schedule,
    inShopAt,
    done,
    invoiced,
  });
}

/** The token is the credential: an approved estimate carrying it, or null
 *  (the caller 404s without saying which). */
export async function resolveOrderStatusToken(service: Db, token: string): Promise<any | null> {
  const t = String(token || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(t)) return null;
  const { data } = await service
    .from('estimates')
    .select(ORDER_STATUS_ESTIMATE_COLUMNS)
    .eq('order_status_token', t)
    .maybeSingle();
  if (!data || !isEstimateApproved(data as any)) return null;
  return data;
}
