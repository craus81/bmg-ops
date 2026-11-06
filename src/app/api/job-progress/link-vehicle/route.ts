import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { IN_SHOP_STATUSES } from '@/lib/types';
import { normVin, vehicleLabel } from '@/lib/job-progress-server';

export const dynamic = 'force-dynamic';

const COLS = 'id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, customer_id, status, created_at';

/**
 * GET /api/job-progress/link-vehicle?estimate= — the vehicles in the shop
 * right now, for the Job progress bar's "Link vehicle in shop" picker. The
 * order's own customer comes first; a VIN match is flagged. Nothing is
 * linked from here: a dealer has many vans in at once, so a person picks.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const estimateId = req.nextUrl.searchParams.get('estimate');
  if (!estimateId) return NextResponse.json({ error: 'Missing estimate' }, { status: 400 });
  const supabase = createServiceClient();

  const { data: est } = await supabase.from('estimates')
    .select('id, customer_id, customer_name, vin').eq('id', estimateId).maybeSingle();
  if (!est) return NextResponse.json({ error: 'Order not found' }, { status: 404 });

  const { data, error } = await supabase.from('fleet_checkins')
    .select(COLS)
    .in('status', IN_SHOP_STATUSES)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) return NextResponse.json({ error: `Couldn't load the vehicles in the shop: ${error.message}` }, { status: 500 });

  const custName = String(est.customer_name || '').trim().toLowerCase();
  const estVin = normVin(est.vin);
  const vehicles = (data || []).map((c: any) => ({
    id: c.id as string,
    label: vehicleLabel(c),
    customer: c.customer_name || null,
    status: c.status as string,
    checkedInAt: c.created_at as string,
    sameCustomer: (!!est.customer_id && c.customer_id === est.customer_id)
      || (!!custName && String(c.customer_name || '').trim().toLowerCase() === custName),
    vinMatch: !!estVin && normVin(c.vin) === estVin,
  }));
  vehicles.sort((a, b) => Number(b.vinMatch) - Number(a.vinMatch) || Number(b.sameCustomer) - Number(a.sameCustomer));
  return NextResponse.json({ customer: est.customer_name || null, vehicles });
}

const Schema = z.object({
  estimateId: z.string().uuid(),
  checkinId: z.string().uuid(),
});

/**
 * POST /api/job-progress/link-vehicle — tie a checked-in vehicle to the
 * order: the same link as the estimate's "Link Checked-In Vehicle" button
 * (estimates.fleet_checkin_id), so Vehicle arrived and Install follow it.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { estimateId, checkinId } = parsed.data;
  const supabase = createServiceClient();

  const [{ data: est }, { data: veh }] = await Promise.all([
    supabase.from('estimates').select('id').eq('id', estimateId).maybeSingle(),
    supabase.from('fleet_checkins').select('id').eq('id', checkinId).maybeSingle(),
  ]);
  if (!est) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  if (!veh) return NextResponse.json({ error: 'That vehicle is no longer on the In-Shop board.' }, { status: 404 });

  const { error } = await supabase.from('estimates')
    .update({ fleet_checkin_id: checkinId })
    .eq('id', estimateId);
  if (error) return NextResponse.json({ error: `Couldn't link the vehicle: ${error.message}` }, { status: 500 });
  return NextResponse.json({ ok: true });
}
