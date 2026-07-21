import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { syncCalendarEvent, deleteCalendarEvent } from '@/lib/google';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  eventId: z.string().uuid(),
  // true when the FleetSuite event was completed/removed and the Google
  // copy should go away too.
  remove: z.boolean().optional(),
});

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/**
 * POST /api/calendar/sync-event
 *
 * Push a manual FleetSuite schedule event (calendar_events row) to the
 * shared Google calendar — the counterpart of sync-graphics/sync-upfit
 * for hand-added events, so the two calendars line up in both
 * directions. Stores the Google event id back on the row so later edits
 * update instead of duplicating.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { eventId, remove } = parsed.data;

  try {
    const supabase = getSupabase();
    const { data: row } = await supabase
      .from('calendar_events')
      .select('id, title, description, event_date, google_event_id, source')
      .eq('id', eventId)
      .maybeSingle();
    if (!row) return NextResponse.json({ error: 'Event not found' }, { status: 404 });

    if (remove) {
      if (row.google_event_id) {
        await deleteCalendarEvent(row.google_event_id);
        await supabase.from('calendar_events').update({ google_event_id: null }).eq('id', row.id);
      }
      return NextResponse.json({ success: true, action: 'removed' });
    }

    const googleId = await syncCalendarEvent({
      eventId: row.google_event_id,
      title: row.title,
      date: row.event_date,
      description: row.description || '',
      // App-created events get grape (distinct from graphics 6 / upfit 9);
      // events a human made on Google keep whatever color they chose.
      colorId: row.source === 'google' ? null : '3',
    });
    if (googleId && googleId !== row.google_event_id) {
      await supabase.from('calendar_events').update({ google_event_id: googleId }).eq('id', row.id);
    }
    return NextResponse.json({ success: !!googleId, googleEventId: googleId });
  } catch (err: any) {
    console.error('calendar/sync-event error:', err);
    return NextResponse.json({ error: err.message || 'Calendar sync failed' }, { status: 500 });
  }
}
