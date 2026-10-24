import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { pushGraphicsJobToCalendar } from '@/lib/graphics-calendar';
import { syncShopInboundForGraphicsJob } from '@/lib/shop-inbound';
import { longDate } from '@/lib/install-scheduling';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

const Schema = z.object({
  // YYYY-MM-DD, or null to clear the date.
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  arrivalTime: z.string().trim().max(40).optional().nullable(),
});

/**
 * POST /api/graphics-jobs/[id]/install-schedule
 *
 * The job page's Install card: set (or clear) the install date and arrival
 * time, then put it on the install calendar and the shop arrival schedule
 * the same way an Edit Job save does. Answers with whether the calendar
 * took it, so the card says so plainly instead of assuming.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { date, arrivalTime } = parsed.data;

  const { data: job, error: readErr } = await supabase
    .from('graphics_jobs')
    .select('id, status, scheduled_install_date, install_arrival_time')
    .eq('id', params.id)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const now = new Date().toISOString();
  const patch = {
    scheduled_install_date: date,
    install_arrival_time: date ? (arrivalTime || null) : null,
    updated_at: now,
  };
  const { error } = await supabase.from('graphics_jobs').update(patch).eq('id', job.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const was = job.scheduled_install_date ? String(job.scheduled_install_date).slice(0, 10) : null;
  if (was !== date || (job.install_arrival_time || null) !== patch.install_arrival_time) {
    await supabase.from('graphics_status_history').insert({
      job_id: job.id,
      from_status: job.status,
      to_status: job.status,
      changed_by: auth.user.id,
      note: date
        ? `Install scheduled for ${longDate(date)}${patch.install_arrival_time ? `, ${patch.install_arrival_time}` : ''}`
        : 'Install date cleared',
    });
  }

  let calendar: { synced: boolean; reason?: string } = { synced: false };
  try {
    calendar = await pushGraphicsJobToCalendar(supabase, job.id);
  } catch (err: any) {
    console.error('install-schedule calendar push failed:', err);
    calendar = { synced: false, reason: 'calendar_error' };
  }
  try {
    await syncShopInboundForGraphicsJob(supabase, job.id);
  } catch (err) {
    console.error('install-schedule shop inbound sync failed:', err);
  }

  return NextResponse.json({
    ok: true,
    scheduled_install_date: patch.scheduled_install_date,
    install_arrival_time: patch.install_arrival_time,
    calendar,
  });
}
