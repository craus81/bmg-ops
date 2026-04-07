import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { syncCalendarEvent, deleteCalendarEvent } from '@/lib/google';
import { requireAuth } from '@/lib/api-auth';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/calendar/sync-graphics
 * Syncs a graphics job's scheduled install date to Google Calendar.
 * Creates a new event or updates an existing one.
 *
 * Body: { jobId: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  try {
    const { jobId } = await req.json();

    if (!jobId) {
      return NextResponse.json({ error: 'Missing jobId' }, { status: 400 });
    }

    // Get the job
    const { data: job, error } = await supabase
      .from('graphics_jobs')
      .select('id, title, job_number, part_number, customer, quantity, content, notes, scheduled_install_date, calendar_event_id, ship_to, status')
      .eq('id', jobId)
      .single();

    if (error || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    // If no install date, delete any existing event
    if (!job.scheduled_install_date) {
      if (job.calendar_event_id) {
        await deleteCalendarEvent(job.calendar_event_id);
        await supabase
          .from('graphics_jobs')
          .update({ calendar_event_id: null })
          .eq('id', jobId);
      }
      return NextResponse.json({ synced: false, reason: 'no_install_date' });
    }

    // If job is cancelled, delete event
    if (job.status === 'cancelled') {
      if (job.calendar_event_id) {
        await deleteCalendarEvent(job.calendar_event_id);
        await supabase
          .from('graphics_jobs')
          .update({ calendar_event_id: null })
          .eq('id', jobId);
      }
      return NextResponse.json({ synced: false, reason: 'cancelled' });
    }

    // Build event description
    const descLines = [
      `Job: ${job.job_number || job.id.slice(0, 8)}`,
      job.customer ? `Customer: ${job.customer}` : '',
      job.part_number ? `Part: ${job.part_number}` : '',
      `Qty: ${job.quantity}`,
      job.content ? `\nContent:\n${job.content}` : '',
      job.notes ? `\nNotes:\n${job.notes}` : '',
      `\nStatus: ${job.status}`,
    ].filter(Boolean).join('\n');

    // Sync to Google Calendar
    const eventId = await syncCalendarEvent({
      eventId: job.calendar_event_id,
      title: `Graphics: ${job.title}${job.customer ? ` — ${job.customer}` : ''}`,
      date: job.scheduled_install_date,
      description: descLines,
      location: job.ship_to || '',
      colorId: '6', // Orange for graphics
    });

    if (eventId) {
      // Save the event ID back to the job
      await supabase
        .from('graphics_jobs')
        .update({ calendar_event_id: eventId })
        .eq('id', jobId);

      return NextResponse.json({ synced: true, eventId });
    }

    return NextResponse.json({ synced: false, reason: 'calendar_error' });
  } catch (err: any) {
    console.error('Calendar sync error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
