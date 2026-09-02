import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { linkInboundToCheckin, findActiveCheckinForInbound } from '@/lib/shop-inbound';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  /** A just-saved check-in — the definitive arrival moment. */
  checkinId: z.string().uuid().optional(),
  /** A Shop Board row marked arrived by hand (no formal check-in yet). */
  inboundId: z.string().uuid().optional(),
}).refine(b => !!b.checkinId !== !!b.inboundId, {
  message: 'Pass exactly one of checkinId or inboundId',
});

/**
 * POST /api/shop-inbound/arrival — the one place a vehicle "arrives"
 * (audit items 14 + 15).
 *
 * Two callers, one brain:
 *  - VehicleCheckIn after its save (checkinId): link the fulfilled
 *    shop_inbound row (VIN → SO → unique-customer match) and notify.
 *  - ShopArrivals' "Arrived" button (inboundId): mark the row arrived,
 *    back-link any active check-in for its VIN, and notify.
 *
 * Server-side because recipients must be resolved with the service role
 * (the #684 lesson: notification_preferences RLS makes browser-built
 * recipient lists silently empty). Notification posture: every arrival
 * lands in-app for admins; push fires only when the vehicle was EXPECTED
 * (a matched shop_inbound row) — those are the arrivals people are
 * actively waiting on, and routine walk-ins shouldn't buzz phones all day.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { checkinId, inboundId } = parsed.data;

  try {
    let linkedInbound: { id: string; vehicle_desc: string | null; expected_date: string | null } | null = null;
    let checkin: { id: string; vin: string | null; customer_name: string | null; vehicle_year: string | null; vehicle_make: string | null; vehicle_model: string | null } | null = null;
    let inboundDesc: string | null = null;

    if (checkinId) {
      const { data: c } = await supabase
        .from('fleet_checkins')
        .select('id, vin, customer_name, vehicle_year, vehicle_make, vehicle_model, sales_order_number')
        .eq('id', checkinId)
        .maybeSingle();
      if (!c) return NextResponse.json({ error: 'Check-in not found' }, { status: 404 });
      checkin = c;
      const { data: soRows } = await supabase
        .from('fleet_checkin_sales_orders')
        .select('sales_order_number')
        .eq('checkin_id', c.id);
      const soNumbers = [
        ...(c.sales_order_number ? [String(c.sales_order_number)] : []),
        ...((soRows || []).map((r: any) => String(r.sales_order_number || ''))),
      ].filter(Boolean);
      linkedInbound = await linkInboundToCheckin(supabase, {
        id: c.id, vin: c.vin, customer_name: c.customer_name, soNumbers,
      });
      // Someone may have hit "Arrived" on the Shop Board hours before the
      // formal check-in — that already notified. A recent arrived row that
      // matches this check-in means it's the same physical arrival:
      // link-only, no second ping. Round 3 caveat 14: matching on VIN alone
      // let graphics/upfit/manual board rows (which carry no VIN) slip past
      // this and double-notify — match the same VIN → SO number → customer
      // ladder the forward link uses.
      if (!linkedInbound) {
        const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const { data: recentRows } = await supabase
          .from('shop_inbound')
          .select('id, vin, netsuite_so_number, customer_name, fleet_checkin_id')
          .eq('status', 'arrived')
          .gte('updated_at', dayAgo)
          .limit(200);
        const recent = recentRows || [];
        const vinU = c.vin ? String(c.vin).trim().toUpperCase() : '';
        const custL = (c.customer_name || '').trim().toLowerCase();
        // Only rows linked to nothing, or already to THIS check-in (an
        // idempotent retry), count as "the same arrival".
        const linkable = recent.filter(r => !r.fleet_checkin_id || r.fleet_checkin_id === c.id);
        let same =
          (vinU && linkable.find(r => (r.vin || '').trim().toUpperCase() === vinU)) ||
          (soNumbers.length > 0 && linkable.find(r => r.netsuite_so_number && soNumbers.includes(String(r.netsuite_so_number).trim()))) ||
          null;
        if (!same && custL) {
          const byCust = linkable.filter(r => (r.customer_name || '').trim().toLowerCase() === custL);
          if (byCust.length === 1) same = byCust[0];
        }
        if (same) {
          await supabase.from('shop_inbound')
            .update({ fleet_checkin_id: c.id, updated_at: new Date().toISOString() })
            .eq('id', same.id)
            .is('fleet_checkin_id', null);
          return NextResponse.json({ success: true, alreadyArrived: true, linkedInboundId: same.id });
        }
      }
    } else if (inboundId) {
      const { data: row } = await supabase
        .from('shop_inbound')
        .select('id, status, vin, netsuite_so_number, customer_name, vehicle_desc, expected_date, fleet_checkin_id')
        .eq('id', inboundId)
        .maybeSingle();
      if (!row) return NextResponse.json({ error: 'Arrival row not found' }, { status: 404 });
      // Idempotent: a second click (or a check-in that already linked it)
      // must not re-notify.
      if (row.status === 'arrived') {
        return NextResponse.json({ success: true, alreadyArrived: true });
      }
      inboundDesc = row.vehicle_desc;

      // Back-link an active check-in when one exists (the vehicle was
      // checked in before anyone touched the Shop Board). VIN → SO number
      // → unique customer, so graphics/upfit/manual rows — which carry no
      // VIN — can link too (Round 3 caveat 14).
      let checkinLink: string | null = row.fleet_checkin_id;
      if (!checkinLink) {
        checkinLink = await findActiveCheckinForInbound(supabase, {
          vin: row.vin,
          netsuite_so_number: row.netsuite_so_number,
          customer_name: row.customer_name,
        });
      }
      await supabase
        .from('shop_inbound')
        .update({
          status: 'arrived',
          fleet_checkin_id: checkinLink,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      linkedInbound = { id: row.id, vehicle_desc: row.vehicle_desc, expected_date: row.expected_date };
      if (checkinLink) {
        const { data: c } = await supabase
          .from('fleet_checkins')
          .select('id, vin, customer_name, vehicle_year, vehicle_make, vehicle_model')
          .eq('id', checkinLink)
          .maybeSingle();
        checkin = c || null;
      }
    }

    // ── Arrival notification (item 15) ──
    const { data: staff } = await supabase
      .from('profiles')
      .select('id, role, roles, status, deactivated')
      .eq('status', 'approved');
    const adminIds = (staff || [])
      .filter((p: any) => {
        if (p.deactivated) return false;
        if (p.id === auth.user.id) return false; // don't ping the person doing the check-in
        const roles = p.roles?.length ? p.roles : [p.role];
        return roles.some((r: string) => r === 'admin' || r === 'super_admin');
      })
      .map((p: any) => p.id);

    const desc = checkin
      ? [checkin.vehicle_year, checkin.vehicle_make, checkin.vehicle_model].filter(Boolean).join(' ') || 'Vehicle'
      : inboundDesc || 'Vehicle';
    const customer = checkin?.customer_name || null;
    const wasExpected = !!linkedInbound;

    if (adminIds.length > 0) {
      await notifyMany(adminIds, {
        type: 'vehicle_arrived',
        title: `🚚 ${wasExpected ? 'Expected vehicle' : 'Vehicle'} arrived — ${desc}`,
        body: [
          customer ? `${customer}'s ${desc}` : desc,
          checkin?.vin ? `VIN …${String(checkin.vin).slice(-8)}` : null,
          wasExpected ? 'was on the arrival schedule' : 'walk-in / unscheduled',
        ].filter(Boolean).join(' · ').slice(0, 900),
        // No check-in yet (board "Arrived" pressed first — the common path)
        // → land on the arrivals board flashing this row. '/upfit' was the
        // wrong board entirely (Round 3 finding): ShopArrivals renders on
        // /tracking.
        url: checkin
          ? deepLinks.vehicle(checkin.id)
          : inboundId
            ? deepLinks.shopArrival(inboundId)
            : '/tracking',
        // Expected arrivals are the ones people are waiting on — those push.
        channels: wasExpected ? ['in_app', 'push'] : ['in_app'],
      });
    }

    return NextResponse.json({
      success: true,
      linkedInboundId: linkedInbound?.id || null,
      wasExpected,
      notified: adminIds.length,
    });
  } catch (e: any) {
    console.error('shop-inbound arrival failed:', e);
    return NextResponse.json({ error: e.message || 'Arrival processing failed' }, { status: 500 });
  }
}
