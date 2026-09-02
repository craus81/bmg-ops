import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
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
  companyId: z.string().uuid(),
});

/**
 * Assign an installation company to a CNI job (admin CNI page). Moved server-side
 * so the newly-assigned company's installers get notified — the notification
 * needs the service role, which the browser can't use. The write itself is the
 * same one the admin page performed directly; the RLS lockdown leaves staff
 * writes intact, so this route exists for the notification, not to gate the write.
 */
export async function POST(req: NextRequest) {
  // cni_admin, matching the console pages that call this — a delegated
  // coordinator can assign, not just raw admins.
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, companyId } = parsed.data;

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, job_number, title, status, assigned_company_id')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const newStatus = job.status === 'awaiting_assignment' || job.status === 'bidding_open'
    ? 'assigned_awaiting_scheduling'
    : job.status;

  const { error } = await supabase.from('cni_jobs').update({
    assigned_company_id: companyId,
    assigned_at: new Date().toISOString(),
    status: newStatus,
    updated_by: auth.user.id,
  }).eq('id', jobId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Notify the company's installers — only when the assignment actually changed,
  // so re-saving the same company doesn't re-ping everyone.
  if (companyId !== job.assigned_company_id) {
    try {
      const installers = await getCompanyInstallerIds(supabase, companyId, auth.user.id);
      if (installers.length > 0) {
        await notifyMany(installers, {
          type: 'cni_assigned',
          title: `New job assigned: ${job.job_number}`,
          body: `Your company was assigned "${job.title}". Open the job to schedule and start the work.`,
          url: deepLinks.installerJob(jobId),
          channels: ['in_app', 'push', 'email'],
          // External installer audience — no preference rows; addressed-to-you lifecycle event.
          forceChannels: true,
        });
      }
    } catch (err) {
      console.error('cni_assigned notify failed:', err);
    }
  }

  return NextResponse.json({ success: true, status: newStatus });
}
