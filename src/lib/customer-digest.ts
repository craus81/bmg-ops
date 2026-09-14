/**
 * The weekly customer update: what we're holding for a customer, what
 * finished or shipped last week, and what was invoiced — the "where are my
 * vehicles?" call, pre-answered.
 *
 * The Monday cron used to build these AND send them. Owner decision
 * 2026-09-14: no customer email leaves FleetSuite without a person sending
 * it. So the cron now builds them to count who has one worth reading and
 * tells the admins, and the send is a button on Customer Notifications
 * (/api/customers/digest/email) with the standard compose screen in front
 * of it. Both call the builders here, so the count the admins are told and
 * the email a customer gets describe the same week.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

type Service = SupabaseClient<any, any, any>;

export const ACTIVE_STATUSES = ['received', 'in_progress', 'stuck_parts', 'stuck_graphics'];

const STATUS_LABELS: Record<string, string> = {
  received: 'Received',
  in_progress: 'In progress',
  stuck_parts: 'Waiting on parts',
  stuck_graphics: 'Waiting on graphics',
  complete: 'Complete — ready for pickup',
  shipped: 'Shipped',
};

/** Rows past this per section are summarised as "…and N more". */
const MAX_ROWS_PER_SECTION = 30;

export interface DigestVehicle {
  id: string;
  vin?: string | null;
  vehicle_year?: string | number | null;
  vehicle_make?: string | null;
  vehicle_model?: string | null;
  status?: string | null;
  invoice_number?: string | null;
}

export interface DigestBucket {
  active: DigestVehicle[];
  completed: DigestVehicle[];
  shipped: DigestVehicle[];
  invoiced: DigestVehicle[];
}

export const emptyBucket = (): DigestBucket => ({ active: [], completed: [], shipped: [], invoiced: [] });

export const bucketSize = (b: DigestBucket): number =>
  b.active.length + b.completed.length + b.shipped.length + b.invoiced.length;

export const vehicleLabel = (v: DigestVehicle): string => {
  const name = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ');
  const vin = v.vin ? ` · VIN …${String(v.vin).slice(-8)}` : '';
  return `${name || 'Vehicle'}${vin}`;
};

const capped = (rows: string[]): string[] =>
  rows.length > MAX_ROWS_PER_SECTION
    ? [...rows.slice(0, MAX_ROWS_PER_SECTION), `…and ${rows.length - MAX_ROWS_PER_SECTION} more`]
    : rows;

/** The four sections, in reading order. Empty ones are dropped downstream. */
export function digestSections(b: DigestBucket): { title: string; rows: string[] }[] {
  return [
    {
      title: `In our shop (${b.active.length})`,
      rows: capped(b.active.map(v => `${vehicleLabel(v)} — ${STATUS_LABELS[v.status || ''] || v.status || ''}`)),
    },
    { title: 'Completed this week', rows: capped(b.completed.map(vehicleLabel)) },
    { title: 'Shipped this week', rows: capped(b.shipped.map(vehicleLabel)) },
    {
      title: 'Invoiced this week',
      rows: capped(b.invoiced.map(v => `${vehicleLabel(v)}${v.invoice_number ? ` — Invoice #${v.invoice_number}` : ''}`)),
    },
  ];
}

export function digestSubject(b: DigestBucket): string {
  const finished = b.completed.length + b.shipped.length;
  return `[BMG Fleet] Weekly vehicle update — ${b.active.length} in shop${finished > 0 ? `, ${finished} finished` : ''}`;
}

/**
 * Every customer's bucket for the past week, keyed by the free-text
 * customer name on the vehicle (the only linkage that exists).
 *
 * Throws on a read failure rather than returning a short week: a digest
 * that silently omits a customer's vehicles reads to them as "nothing
 * happening", which is worse than no digest at all.
 */
export async function loadDigestBuckets(service: Service, sinceMs = Date.now() - 7 * 86_400_000): Promise<Map<string, DigestBucket>> {
  const weekAgo = new Date(sinceMs).toISOString();

  // Paginated (R3-1 MAJOR sweep): PostgREST caps each response at 1000 rows
  // regardless of .limit(), so a busy week silently dropped vehicles.
  const [activeRes, historyRes, invoicedRes] = await Promise.all([
    fetchAllRows<any>((from, to) =>
      service.from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, status, customer_name')
        .in('status', ACTIVE_STATUSES)
        .not('customer_name', 'is', null)
        .order('id')
        .range(from, to)),
    fetchAllRows<any>((from, to) =>
      service.from('vehicle_status_history')
        .select('vehicle_id, to_status, created_at')
        .in('to_status', ['complete', 'shipped'])
        .gte('created_at', weekAgo)
        .order('id')
        .range(from, to)),
    fetchAllRows<any>((from, to) =>
      service.from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, invoice_number, date_invoiced')
        .gte('date_invoiced', weekAgo.slice(0, 10))
        .not('customer_name', 'is', null)
        .order('id')
        .range(from, to)),
  ]);
  const readErr = activeRes.error || historyRes.error || invoicedRes.error;
  if (readErr) throw new Error(`digest reads failed (${readErr.message})`);

  // Resolve the vehicles behind last week's transitions.
  const eventVehicleIds = [...new Set((historyRes.data || []).map((h: any) => h.vehicle_id))];
  const eventVehicles = new Map<string, any>();
  for (let i = 0; i < eventVehicleIds.length; i += 200) {
    const { data } = await service.from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, status, customer_name')
      .in('id', eventVehicleIds.slice(i, i + 200));
    for (const v of data || []) eventVehicles.set(v.id, v);
  }

  const byCustomer = new Map<string, DigestBucket>();
  const bucket = (name: string): DigestBucket => {
    const key = name.trim();
    let b = byCustomer.get(key);
    if (!b) { b = emptyBucket(); byCustomer.set(key, b); }
    return b;
  };
  for (const v of activeRes.data || []) bucket(v.customer_name).active.push(v);
  const seenEvent = new Set<string>();
  for (const h of historyRes.data || []) {
    const v = eventVehicles.get(h.vehicle_id);
    if (!v?.customer_name) continue;
    // One event per vehicle per bucket even if history has repeats.
    const key = `${h.vehicle_id}-${h.to_status}`;
    if (seenEvent.has(key)) continue;
    seenEvent.add(key);
    bucket(v.customer_name)[h.to_status === 'complete' ? 'completed' : 'shipped'].push(v);
  }
  for (const v of invoicedRes.data || []) bucket(v.customer_name).invoiced.push(v);
  return byCustomer;
}

/**
 * One customer's bucket, matched on the same free-text name the vehicles
 * carry. Case-insensitive so "Acme Fleet" and "ACME FLEET" are one
 * customer — the same latitude resolveCustomerContact gives the address.
 */
export async function loadDigestForCustomer(service: Service, customerName: string): Promise<DigestBucket> {
  const wanted = customerName.trim().toLowerCase();
  const all = await loadDigestBuckets(service);
  for (const [name, b] of all) {
    if (name.toLowerCase() === wanted) return b;
  }
  return emptyBucket();
}
