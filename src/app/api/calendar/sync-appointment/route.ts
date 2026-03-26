import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { syncCalendarEvent, deleteCalendarEvent } from '@/lib/google';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/calendar/sync-appointment
 * Syncs an installer appointment to Google Calendar as an orange event.
 *
 * Body: { appointmentId: string }
 */
export async function POST(req: NextRequest) {
  try {
    const { appointmentId } = await req.json();

    if (!appointmentId) {
      return NextResponse.json({ error: 'Missing appointmentId' }, { status: 400 });
    }

    const { data: appt, error } = await supabase
      .from('installer_appointments')
      .select(`
        *,
        outside_installer:outside_installers(id, name, company_name, phone),
        graphics_job:graphics_jobs(id, title, job_number, customer)
      `)
      .eq('id', appointmentId)
      .single();

    if (error || !appt) {
      return NextResponse.json({ error: 'Appointment not found' }, { status: 404 });
    }

    // If cancelled, delete event
    if (appt.status === 'cancelled') {
      if (appt.calendar_event_id) {
        await deleteCalendarEvent(appt.calendar_event_id);
        await supabase.from('installer_appointments').update({ calendar_event_id: null }).eq('id', appointmentId);
      }
      return NextResponse.json({ synced: false, reason: 'cancelled' });
    }

    const installer = appt.outside_installer;
    const installerName = installer ? `${installer.name}${installer.company_name ? ` (${installer.company_name})` : ''}` : 'Unknown Installer';

    const descLines = [
      `Installer: ${installerName}`,
      installer?.phone ? `Phone: ${installer.phone}` : '',
      appt.start_time ? `Time: ${appt.start_time}${appt.end_time ? ` – ${appt.end_time}` : ''}` : '',
      appt.graphics_job ? `Job: ${appt.graphics_job.job_number || appt.graphics_job.title}${appt.graphics_job.customer ? ` — ${appt.graphics_job.customer}` : ''}` : '',
      appt.description ? `\nNotes:\n${appt.description}` : '',
    ].filter(Boolean).join('\n');

    const eventId = await syncCalendarEvent({
      eventId: appt.calendar_event_id,
      title: appt.title,
      summary: `🔧 ${appt.title}`,
      date: appt.scheduled_date,
      description: descLines,
      colorId: '6', // Orange
    });

    if (eventId) {
      await supabase.from('installer_appointments').update({ calendar_event_id: eventId }).eq('id', appointmentId);
      return NextResponse.json({ synced: true, eventId });
    }

    return NextResponse.json({ synced: false, reason: 'calendar_error' });
  } catch (err: any) {
    console.error('Appointment calendar sync error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
