import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { sendEmail, buildCustomerDigestEmail } from '@/lib/resend';
import { resolveCustomerContact } from '@/lib/customer-notify';
import { recordHeartbeat } from '@/lib/system-health';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const service = createServiceClient();

const ACTIVE_STATUSES = ['received', 'in_progress', 'stuck_parts', 'stuck_graphics'];
const STATUS_LABELS: Record<string, string> = {
  received: 'Received',
  in_progress: 'In progress',
  stuck_parts: 'Waiting on parts',
  stuck_graphics: 'Waiting on graphics',
  complete: 'Complete — ready for pickup',
  shipped: 'Shipped',
};
const MAX_ROWS_PER_SECTION = 30;

const vehicleLabel = (v: any) => {
  const name = [v.vehicle_year, v.vehicle_make, v.vehicle_model].filter(Boolean).join(' ');
  const vin = v.vin ? ` · VIN …${String(v.vin).slice(-8)}` : '';
  return `${name || 'Vehicle'}${vin}`;
};

const capped = (rows: string[]) =>
  rows.length > MAX_ROWS_PER_SECTION
    ? [...rows.slice(0, MAX_ROWS_PER_SECTION), `…and ${rows.length - MAX_ROWS_PER_SECTION} more`]
    : rows;

/**
 * Monday-morning per-customer digest: every vehicle we're holding for them
 * (with its plain-language status), what finished or shipped last week,
 * and what was invoiced — the "where are my vehicles?" call, pre-answered.
 * Sends only to customers with something to say, only to those subscribed
 * to the digest (opt-in per customer since migration 171), and uses the
 * same primary-contact resolution as every other customer touchpoint.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

    // Active vehicles + last week's completions/ships (precise transitions
    // come from the status history) + last week's invoicing stamps.
    const [activeRes, historyRes, invoicedRes] = await Promise.all([
      service.from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, status, customer_name')
        .in('status', ACTIVE_STATUSES)
        .not('customer_name', 'is', null)
        .limit(2000),
      service.from('vehicle_status_history')
        .select('vehicle_id, to_status, created_at')
        .in('to_status', ['complete', 'shipped'])
        .gte('created_at', weekAgo)
        .limit(2000),
      service.from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, invoice_number, date_invoiced')
        .gte('date_invoiced', weekAgo.slice(0, 10))
        .not('customer_name', 'is', null)
        .limit(2000),
    ]);

    // Resolve the vehicles behind last week's transitions.
    const eventVehicleIds = [...new Set((historyRes.data || []).map(h => h.vehicle_id))];
    const eventVehicles = new Map<string, any>();
    for (let i = 0; i < eventVehicleIds.length; i += 200) {
      const { data } = await service.from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, status, customer_name')
        .in('id', eventVehicleIds.slice(i, i + 200));
      for (const v of data || []) eventVehicles.set(v.id, v);
    }

    // Group everything by customer name (the only linkage that exists).
    interface Bucket { active: any[]; completed: any[]; shipped: any[]; invoiced: any[] }
    const byCustomer = new Map<string, Bucket>();
    const bucket = (name: string): Bucket => {
      const key = name.trim();
      let b = byCustomer.get(key);
      if (!b) { b = { active: [], completed: [], shipped: [], invoiced: [] }; byCustomer.set(key, b); }
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

    let sent = 0, skippedNoEmail = 0, skippedOptOut = 0, skippedEmpty = 0;
    for (const [customerName, b] of byCustomer) {
      if (b.active.length + b.completed.length + b.shipped.length + b.invoiced.length === 0) { skippedEmpty++; continue; }

      const { customer, email } = await resolveCustomerContact(service, customerName);
      if (!customer || !email) { skippedNoEmail++; continue; }
      // Opt-IN since migration 171: only subscribed customers get the digest.
      if (customer.weekly_digest !== true) { skippedOptOut++; continue; }

      const html = buildCustomerDigestEmail(customerName, [
        {
          title: `In our shop (${b.active.length})`,
          rows: capped(b.active.map(v => `${vehicleLabel(v)} — ${STATUS_LABELS[v.status] || v.status}`)),
        },
        {
          title: 'Completed this week',
          rows: capped(b.completed.map(v => vehicleLabel(v))),
        },
        {
          title: 'Shipped this week',
          rows: capped(b.shipped.map(v => vehicleLabel(v))),
        },
        {
          title: 'Invoiced this week',
          rows: capped(b.invoiced.map(v => `${vehicleLabel(v)}${v.invoice_number ? ` — Invoice #${v.invoice_number}` : ''}`)),
        },
      ]);
      const ok = await sendEmail(
        email,
        `[BMG Fleet] Weekly vehicle update — ${b.active.length} in shop${b.completed.length + b.shipped.length > 0 ? `, ${b.completed.length + b.shipped.length} finished` : ''}`,
        html,
      );
      if (ok) sent++;
    }

    const syncStateWrite = await recordHeartbeat(
      service, 'weekly_customer_digest', { status: 'ok', customers: byCustomer.size, sent, skippedNoEmail, skippedOptOut, skippedEmpty },
    );

    return NextResponse.json({ status: 'ok', customers: byCustomer.size, sent, skippedNoEmail, skippedOptOut, syncStateWrite });
  } catch (e: any) {
    console.error('weekly-customer-digest failed:', e);
    await recordHeartbeat(service, 'weekly_customer_digest', { error: e.message || 'digest failed' }); // never throws; failure already logged
    return NextResponse.json({ error: e.message || 'digest failed' }, { status: 500 });
  }
}
