import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { syncCalendarEvent, deleteCalendarEvent } from '@/lib/google';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({ checkinId: z.string().uuid() });

/**
 * POST /api/calendar/sync-upfit
 * Syncs a fleet check-in's scheduled upfit date to Google Calendar.
 * Body: { checkinId: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { checkinId } = parsed.data;

  try {

    const { data: checkin, error } = await supabase
      .from('fleet_checkins')
      .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, sales_order_number, scheduled_upfit_date, calendar_event_id, status')
      .eq('id', checkinId)
      .single();

    if (error || !checkin) {
      return NextResponse.json({ error: 'Check-in not found' }, { status: 404 });
    }

    // If no upfit date, delete any existing event
    if (!checkin.scheduled_upfit_date) {
      if (checkin.calendar_event_id) {
        await deleteCalendarEvent(checkin.calendar_event_id);
        await supabase.from('fleet_checkins').update({ calendar_event_id: null }).eq('id', checkinId);
      }
      return NextResponse.json({ synced: false, reason: 'no_upfit_date' });
    }

    const vehicle = [checkin.vehicle_year, checkin.vehicle_make, checkin.vehicle_model].filter(Boolean).join(' ');
    const descLines = [
      `VIN: ${checkin.vin}`,
      vehicle ? `Vehicle: ${vehicle}` : '',
      checkin.customer_name ? `Customer: ${checkin.customer_name}` : '',
      checkin.sales_order_number ? `SO: ${checkin.sales_order_number}` : '',
      `Status: ${checkin.status}`,
    ].filter(Boolean).join('\n');

    const title = `Upfit: ${vehicle || checkin.vin}${checkin.customer_name ? ` — ${checkin.customer_name}` : ''}`;

    const eventId = await syncCalendarEvent({
      eventId: checkin.calendar_event_id,
      title,
      date: checkin.scheduled_upfit_date,
      description: descLines,
      colorId: '9', // Blue for upfit
    });

    if (eventId) {
      await supabase.from('fleet_checkins').update({ calendar_event_id: eventId }).eq('id', checkinId);
      return NextResponse.json({ synced: true, eventId });
    }

    return NextResponse.json({ synced: false, reason: 'calendar_error' });
  } catch (err: any) {
    console.error('Upfit calendar sync error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
