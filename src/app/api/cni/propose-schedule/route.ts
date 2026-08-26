import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { getCompanyInstallerIds } from '@/lib/cni-access';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  jobId: z.string().uuid(),
  startAt: z.string().trim().min(1),
  endAt: z.string().trim().min(1).optional().nullable(),
});

const toIso = (s: string): string | null => {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Admin proposes a schedule (start/end) to the assigned company; the installer
 * then accepts or declines it (see /api/cni/update-schedule). Moved server-side
 * so the company's installers get a "please confirm this time" notification.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, startAt, endAt } = parsed.data;

  const startIso = toIso(startAt);
  if (!startIso) return NextResponse.json({ error: 'Invalid start date/time' }, { status: 400 });
  let endIso: string | null = null;
  if (endAt) {
    endIso = toIso(endAt);
    if (!endIso) return NextResponse.json({ error: 'Invalid end date/time' }, { status: 400 });
  }

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, job_number, title, assigned_company_id')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { error } = await supabase.from('cni_jobs').update({
    scheduled_start_at: startIso,
    scheduled_end_at: endIso,
    schedule_decline_note: null,
    schedule_confirmed_at: null,
    status: 'scheduled_pending_confirmation',
    updated_by: auth.user.id,
  }).eq('id', jobId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (job.assigned_company_id) {
    try {
      const installers = await getCompanyInstallerIds(supabase, job.assigned_company_id, auth.user.id);
      if (installers.length > 0) {
        const when = new Date(startIso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
        await notifyMany(installers, {
          type: 'cni_schedule_proposed',
          title: `Schedule proposed: ${job.job_number}`,
          body: `BMG proposed ${when} for "${job.title}". Open the job to accept or decline the time.`,
          url: deepLinks.installerJob(jobId),
          channels: ['in_app', 'push', 'email'],
          forceChannels: true,
        });
      }
    } catch (err) {
      console.error('cni_schedule_proposed notify failed:', err);
    }
  }

  return NextResponse.json({ success: true });
}
