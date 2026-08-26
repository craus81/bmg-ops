import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { canActOnCniJob, getCniStaffIds } from '@/lib/cni-access';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  jobId: z.string().uuid(),
  action: z.enum(['accept', 'decline']),
  note: z.string().trim().max(1000).optional().nullable(),
});

/**
 * Installer responds to a proposed schedule: accept (→ scheduled_confirmed) or
 * decline (→ back to assigned_awaiting_scheduling, clearing the proposed time so
 * the coordinator picks a new one). Previously a direct browser write to
 * cni_jobs under RLS; routed here so the caller can only flip these few columns
 * on a job they're authorized for, and so a decline can notify the coordinator.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, action, note } = parsed.data;

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, job_number, title, status, assigned_installer_id, assigned_company_id')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: profile } = await supabase
    .from('profiles').select('full_name, role, roles').eq('id', auth.user.id).single();
  const roles: string[] = profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
  const isAdmin = roles.includes('admin');
  if (!isAdmin && !(await canActOnCniJob(supabase, auth.user.id, job))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (action === 'accept') {
    const { error } = await supabase.from('cni_jobs').update({
      schedule_confirmed_at: new Date().toISOString(),
      status: 'scheduled_confirmed',
      updated_by: auth.user.id,
    }).eq('id', jobId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, status: 'scheduled_confirmed' });
  }

  // decline
  const { error } = await supabase.from('cni_jobs').update({
    status: 'assigned_awaiting_scheduling',
    schedule_decline_note: note || null,
    scheduled_start_at: null,
    scheduled_end_at: null,
    updated_by: auth.user.id,
  }).eq('id', jobId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Tell the coordinators to propose a new time.
  try {
    const staff = await getCniStaffIds(supabase, auth.user.id);
    if (staff.length > 0) {
      const who = profile?.full_name || 'The installer';
      await notifyMany(staff, {
        type: 'cni_schedule_declined',
        title: `Schedule declined: ${job.job_number}`,
        body: `${who} declined the proposed time for "${job.title}".${note ? ` Reason: ${note}` : ''} Propose a new time.`,
        url: deepLinks.cniJob(jobId),
        channels: ['in_app', 'push', 'email'],
        forceChannels: true,
      });
    }
  } catch (err) {
    console.error('cni_schedule_declined notify failed:', err);
  }

  return NextResponse.json({ success: true, status: 'assigned_awaiting_scheduling' });
}
