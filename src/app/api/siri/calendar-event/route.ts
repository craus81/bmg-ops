import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { pushCalendarEventToGoogle } from '@/lib/google';
import { authenticateSiriKey } from '@/lib/siri-keys';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  title: z.string().trim().min(1).max(200),
  // The phone's local day and time, the same shape the schedule page saves.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
});

/**
 * POST /api/siri/calendar-event  Body: { title, date, time? }
 *
 * "Hey Siri, add a calendar entry in BMG FleetSuite" — the iPhone app's Siri
 * intent (ios/App/App/AddCalendarEntryIntent.swift) calls this with the
 * device's Siri key. Saves the same row the schedule page's New Event form
 * does (a Meeting owned by the key's user) and mirrors it to the shared
 * Google calendar the same way. Errors are spoken by Siri.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateSiriKey(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { title, date, time } = parsed.data;

  const supabase = createServiceClient();
  const { data: row, error } = await supabase
    .from('calendar_events')
    .insert({
      title,
      event_date: date,
      event_time: time ?? null,
      event_type: 'event',
      user_id: auth.userId,
    })
    .select('id, title, description, event_date, event_time, google_event_id, source')
    .single();
  if (error || !row) {
    console.error('siri/calendar-event insert failed:', error);
    return NextResponse.json({ error: "FleetSuite couldn't save that entry. Try again in a minute." }, { status: 500 });
  }

  // Best-effort, like the schedule page: the entry is saved either way.
  try {
    await pushCalendarEventToGoogle(supabase, row);
  } catch (err) {
    console.error('siri/calendar-event Google sync failed:', err);
  }

  return NextResponse.json({
    id: row.id,
    title: row.title,
    date: row.event_date,
    time: row.event_time ? String(row.event_time).slice(0, 5) : null,
  });
}
