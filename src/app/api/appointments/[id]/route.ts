import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/** PATCH /api/appointments/[id] — update appointment */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    const allowed = ['title', 'description', 'scheduled_date', 'start_time', 'end_time', 'status', 'graphics_job_id', 'outside_installer_id'];
    const updates: Record<string, any> = {};
    for (const key of allowed) {
      if (key in body) updates[key] = body[key];
    }

    const { data, error } = await supabase
      .from('installer_appointments')
      .update(updates)
      .eq('id', params.id)
      .select(`
        *,
        outside_installer:outside_installers(id, name, company_name, phone, email),
        graphics_job:graphics_jobs(id, title, job_number, customer)
      `)
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
