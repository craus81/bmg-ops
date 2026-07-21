/**
 * Push one graphics job's install date to the shared Google calendar —
 * the single implementation behind both the user-triggered
 * /api/calendar/sync-graphics route and the calendar-pull cron's
 * reconciliation sweep (which retries jobs whose original push failed,
 * e.g. while the Calendar API was still disabled).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { syncCalendarEvent, deleteCalendarEvent } from './google';

type Service = SupabaseClient<any, any, any>;

export interface GraphicsCalendarSyncResult {
  synced: boolean;
  eventId?: string;
  reason?: 'not_found' | 'no_install_date' | 'cancelled' | 'calendar_error';
}

export async function pushGraphicsJobToCalendar(
  supabase: Service,
  jobId: string,
): Promise<GraphicsCalendarSyncResult> {
  const { data: job, error } = await supabase
    .from('graphics_jobs')
    .select('id, title, job_number, part_number, customer, quantity, content, notes, scheduled_install_date, calendar_event_id, ship_to, status')
    .eq('id', jobId)
    .single();
  if (error || !job) return { synced: false, reason: 'not_found' };

  // No install date (or cancelled) → the calendar shouldn't show it.
  if (!job.scheduled_install_date || job.status === 'cancelled') {
    if (job.calendar_event_id) {
      await deleteCalendarEvent(job.calendar_event_id);
      await supabase.from('graphics_jobs').update({ calendar_event_id: null }).eq('id', jobId);
    }
    return { synced: false, reason: job.scheduled_install_date ? 'cancelled' : 'no_install_date' };
  }

  const descLines = [
    `Job: ${job.job_number || job.id.slice(0, 8)}`,
    job.customer ? `Customer: ${job.customer}` : '',
    job.part_number ? `Part: ${job.part_number}` : '',
    `Qty: ${job.quantity}`,
    job.content ? `\nContent:\n${job.content}` : '',
    job.notes ? `\nNotes:\n${job.notes}` : '',
    `\nStatus: ${job.status}`,
  ].filter(Boolean).join('\n');

  const eventId = await syncCalendarEvent({
    eventId: job.calendar_event_id,
    title: `Graphics: ${job.title}${job.customer ? ` — ${job.customer}` : ''}`,
    date: job.scheduled_install_date,
    description: descLines,
    location: job.ship_to || '',
    colorId: '6', // Orange for graphics
  });

  if (eventId) {
    await supabase.from('graphics_jobs').update({ calendar_event_id: eventId }).eq('id', jobId);
    return { synced: true, eventId };
  }
  return { synced: false, reason: 'calendar_error' };
}
