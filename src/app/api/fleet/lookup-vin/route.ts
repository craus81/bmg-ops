import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface Match {
  vin: string;
  customerName: string | null;
  source: 'fleet_checkin' | 'scan_log';
  lastSeenAt: string | null;
  vehicleDescription: string | null;
  checkinId?: string;
}

/**
 * GET /api/fleet/lookup-vin?partial=ABCDEFGH[&customer=Name]
 *
 * Partial-VIN matching. Accepts 6+ trailing characters of a VIN and returns
 * candidate full VINs from fleet_checkins and scan_logs. Optional customer
 * filter narrows the candidate set.
 *
 * Used by fleet check-in when a handwritten "last 8" comes in and we want to
 * auto-complete against prior full VINs under the same customer.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(req.url);
  const partial = (searchParams.get('partial') || '').toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
  const customer = searchParams.get('customer') || '';

  if (partial.length < 6) {
    return NextResponse.json({ error: 'partial must be at least 6 characters' }, { status: 400 });
  }
  if (partial.length > 17) {
    return NextResponse.json({ error: 'partial cannot exceed 17 characters' }, { status: 400 });
  }

  // fleet_checkins — ilike on the tail of the VIN
  let fleetQuery = supabase
    .from('fleet_checkins')
    .select('id, vin, customer_name, vehicle_year, vehicle_make, vehicle_model, created_at')
    .ilike('vin', `%${partial}`)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(20);
  if (customer) {
    fleetQuery = fleetQuery.ilike('customer_name', `%${customer}%`);
  }
  const { data: fleetRows } = await fleetQuery;

  // scan_logs — same tail match
  let scanQuery = supabase
    .from('scan_logs')
    .select('vin, billable_customer, scanned_at')
    .ilike('vin', `%${partial}`)
    .order('scanned_at', { ascending: false })
    .limit(20);
  if (customer) {
    scanQuery = scanQuery.ilike('billable_customer', `%${customer}%`);
  }
  const { data: scanRows } = await scanQuery;

  // Merge + dedupe by VIN; prefer the fleet_checkin entry when both sides have it
  const byVin = new Map<string, Match>();

  for (const r of scanRows || []) {
    if (!r.vin) continue;
    byVin.set(r.vin, {
      vin: r.vin,
      customerName: r.billable_customer || null,
      source: 'scan_log',
      lastSeenAt: r.scanned_at,
      vehicleDescription: null,
    });
  }
  for (const r of fleetRows || []) {
    const desc = [r.vehicle_year, r.vehicle_make, r.vehicle_model].filter(Boolean).join(' ') || null;
    byVin.set(r.vin, {
      vin: r.vin,
      customerName: r.customer_name || null,
      source: 'fleet_checkin',
      lastSeenAt: r.created_at,
      vehicleDescription: desc,
      checkinId: r.id,
    });
  }

  const matches = Array.from(byVin.values()).sort((a, b) => {
    // fleet_checkin entries sort first
    if (a.source !== b.source) {
      return a.source === 'fleet_checkin' ? -1 : 1;
    }
    return (b.lastSeenAt || '').localeCompare(a.lastSeenAt || '');
  });

  return NextResponse.json({ matches, count: matches.length });
}
