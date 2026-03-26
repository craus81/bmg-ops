import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { syncCalendarEvent, deleteCalendarEvent } from '@/lib/google';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/calendar/sync-production
 * Syncs a fleet check-in's production_schedule_date to Google Calendar as a green event.
 *
 * Body: { checkinId: string }
 */
export async function POST(req: NextRequest) {
  try {
    const { checkinId } = await req.json();

    if (!checkinId) {
      return NextResponse.json({ error: 'Missing checkinId' }, { status: 400 });
    }

    const { data: checkin, error } = await supabase
      .from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, sales_order_number, production_schedule_date, calendar_event_id, status')
      .eq('id', checkinId)
      .single();

    if (error || !checkin) {
      return NextResponse.json({ error: 'Check-in not found' }, { status: 404 });
    }

    // If no production schedule date, delete any existing event
    if (!checkin.production_schedule_date) {
      if (checkin.calendar_event_id) {
        await deleteCalendarEvent(checkin.calendar_event_id);
        await supabase.from('fleet_checkins').update({ calendar_event_id: null }).eq('id', checkinId);
      }
      return NextResponse.json({ synced: false, reason: 'no_production_schedule_date' });
    }

    const vehicle = [checkin.vehicle_year, checkin.vehicle_make, checkin.vehicle_model].filter(Boolean).join(' ') || checkin.vin;
    const descLines = [
      checkin.sales_order_number ? `SO #${checkin.sales_order_number}` : '',
      checkin.customer_name ? `Customer: ${checkin.customer_name}` : '',
      `VIN: ${checkin.vin}`,
    ].filter(Boolean).join('\n');

    const eventId = await syncCalendarEvent({
      eventId: checkin.calendar_event_id,
      title: vehicle,
      summary: `🏭 Production: ${vehicle}${checkin.customer_name ? ` — ${checkin.customer_name}` : ''}`,
      date: checkin.production_schedule_date,
      description: descLines,
      colorId: '2', // Green
    });

    if (eventId) {
      await supabase.from('fleet_checkins').update({ calendar_event_id: eventId }).eq('id', checkinId);
      return NextResponse.json({ synced: true, eventId });
    }

    return NextResponse.json({ synced: false, reason: 'calendar_error' });
  } catch (err: any) {
    console.error('Production calendar sync error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
