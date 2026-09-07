import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, isAdminRole } from '@/lib/api-auth';
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
});

/**
 * Installer marks a job complete (→ completed_pending_review), the explicit
 * "I'm done, send it for review" action. Previously a direct browser write to
 * cni_jobs; routed here so it's a whitelisted status flip on an authorized job,
 * and so the coordinators get notified there's work to review. Idempotent — a
 * second call on an already-submitted job is a no-op and doesn't re-notify.
 * (The client still ends any open crew shift via /api/shifts/end first.)
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId } = parsed.data;

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, job_number, title, status, assigned_installer_id, assigned_company_id')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: profile } = await supabase
    .from('profiles').select('full_name, role, roles').eq('id', auth.user.id).single();
  const roles: string[] = profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
  const isAdmin = isAdminRole(roles);
  if (!isAdmin && !(await canActOnCniJob(supabase, auth.user.id, job))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Idempotent: already submitted for review → succeed without re-notifying.
  if (job.status === 'completed_pending_review') {
    return NextResponse.json({ success: true, status: job.status, alreadyComplete: true });
  }

  // Only an in-progress job can be marked complete — the same gate the installer
  // UI enforces (the button shows only on 'in_progress'). Enforced server-side so
  // a direct POST can't reopen a coordinator-closed job (resetting completed_at
  // and re-notifying) or jump the lifecycle from an earlier state.
  if (job.status !== 'in_progress') {
    return NextResponse.json({ error: 'Only an in-progress job can be marked complete.' }, { status: 409 });
  }

  // Install checklist gate (migration 265): required tasks must be checked
  // off before the job can go to review — the procedural steps photos can't
  // show. Admin bypass mirrors the photo gate; a job with no tasks passes.
  if (!isAdmin) {
    const { data: openTasks } = await supabase
      .from('cni_job_tasks')
      .select('label')
      .eq('job_id', jobId)
      .eq('required', true)
      .eq('completed', false)
      .order('sort_order')
      .limit(20);
    if ((openTasks || []).length > 0) {
      return NextResponse.json({
        error: 'Finish the install checklist before marking the job complete.',
        step: 'tasks_required',
        missing: (openTasks || []).map(t => t.label),
      }, { status: 409 });
    }
  }

  const { error } = await supabase.from('cni_jobs').update({
    status: 'completed_pending_review',
    completed_at: new Date().toISOString(),
    updated_by: auth.user.id,
  }).eq('id', jobId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Notify the coordinators there's a job awaiting review.
  try {
    const staff = await getCniStaffIds(supabase, auth.user.id);
    if (staff.length > 0) {
      const who = profile?.full_name || 'An installer';
      await notifyMany(staff, {
        type: 'cni_job_complete',
        title: `Job ready for review: ${job.job_number}`,
        body: `${who} marked "${job.title}" complete. Review the work and photos, then approve and close.`,
        url: deepLinks.cniJob(jobId),
        channels: ['in_app', 'push', 'email'],
      });
    }
  } catch (err) {
    console.error('cni_job_complete notify failed:', err);
  }

  return NextResponse.json({ success: true, status: 'completed_pending_review' });
}
