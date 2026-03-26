import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/** GET /api/appointments — list appointments (optionally filtered by date range) */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get('from'); // YYYY-MM-DD
  const to = searchParams.get('to');     // YYYY-MM-DD

  let query = supabase
    .from('installer_appointments')
    .select(`
      *,
      certified_installer:certified_network_installers(id, name, company_name, phone, email),
      graphics_job:graphics_jobs(id, title, job_number, customer)
    `)
    .order('scheduled_date')
    .order('start_time');

  if (from) query = query.gte('scheduled_date', from);
  if (to) query = query.lte('scheduled_date', to);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/** POST /api/appointments — create appointment */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { certified_network_installer_id, graphics_job_id, title, description, scheduled_date, start_time, end_time } = body;

    if (!certified_network_installer_id || !title?.trim() || !scheduled_date) {
      return NextResponse.json({ error: 'certified_network_installer_id, title, and scheduled_date are required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('installer_appointments')
      .insert({
        certified_network_installer_id,
        graphics_job_id: graphics_job_id || null,
        title: title.trim(),
        description: description || null,
        scheduled_date,
        start_time: start_time || null,
        end_time: end_time || null,
        status: 'scheduled',
      })
      .select(`
        *,
        certified_installer:certified_network_installers(id, name, company_name, phone, email),
        graphics_job:graphics_jobs(id, title, job_number, customer)
      `)
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Sync to Google Calendar
    try {
      await fetch(`${process.env.NEXT_PUBLIC_APP_URL || ''}/api/calendar/sync-appointment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointmentId: data.id }),
      });
    } catch {
      // Non-fatal — calendar sync failure shouldn't block creation
    }

    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
