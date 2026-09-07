import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { canActOnCniJob, getCniStaffIds } from '@/lib/cni-access';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * The CNI install checklist (migration 265). Coordinators author the
 * tasks on the job page; the installer checks them off; required tasks
 * gate Mark Job Complete. All writes ride the service role per the
 * 226/253 installer lockdown — reads happen browser-side via RLS.
 *
 * POST   — add task(s)                    · cni_admin only
 * PATCH  — toggle a task's completed flag · admin or canActOnCniJob
 * DELETE — remove a task (?id=)           · cni_admin only
 */
const AddSchema = z.object({
  jobId: z.string().uuid(),
  labels: z.array(z.string().trim().min(1).max(300)).min(1).max(50),
  required: z.boolean().optional().default(true),
});

const ToggleSchema = z.object({
  taskId: z.string().uuid(),
  completed: z.boolean(),
});

export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, AddSchema);
  if (parsed.error) return parsed.error;
  const { jobId, labels, required } = parsed.data;

  const { data: job } = await supabase
    .from('cni_jobs').select('id').eq('id', jobId).maybeSingle();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: existing } = await supabase
    .from('cni_job_tasks')
    .select('sort_order')
    .eq('job_id', jobId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const base = (existing?.sort_order ?? -1) + 1;

  const rows = labels.map((label, i) => ({
    job_id: jobId,
    label,
    required,
    sort_order: base + i,
    created_by: auth.user.id,
  }));
  const { data: created, error } = await supabase
    .from('cni_job_tasks').insert(rows).select('*');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, tasks: created || [] });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, ToggleSchema);
  if (parsed.error) return parsed.error;
  const { taskId, completed } = parsed.data;

  const { data: task } = await supabase
    .from('cni_job_tasks').select('id, job_id, label, required, completed').eq('id', taskId).maybeSingle();
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, job_number, title, status, assigned_installer_id, assigned_company_id')
    .eq('id', task.job_id)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const { data: profile } = await supabase
    .from('profiles').select('full_name, role, roles').eq('id', auth.user.id).single();
  const roles: string[] = profile?.roles?.length ? profile.roles : (profile?.role ? [profile.role] : []);
  const isAdmin = roles.includes('admin') || roles.includes('super_admin');
  if (!isAdmin && !(await canActOnCniJob(supabase, auth.user.id, job))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { error } = await supabase
    .from('cni_job_tasks')
    .update(completed
      ? {
        completed: true,
        completed_at: new Date().toISOString(),
        completed_by: auth.user.id,
        completed_by_name: profile?.full_name || null,
      }
      : { completed: false, completed_at: null, completed_by: null, completed_by_name: null })
    .eq('id', taskId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // One ping when the LAST open required task closes (submit-photos'
  // fan-out discipline: never per-item) — and only for installer actors;
  // a coordinator ticking their own list doesn't need a notification.
  let checklistComplete = false;
  if (completed && task.required) {
    const { data: openRequired } = await supabase
      .from('cni_job_tasks')
      .select('id')
      .eq('job_id', task.job_id)
      .eq('required', true)
      .eq('completed', false)
      .limit(1);
    checklistComplete = (openRequired || []).length === 0;
    if (checklistComplete && !isAdmin) {
      try {
        const staff = await getCniStaffIds(supabase, auth.user.id);
        if (staff.length > 0) {
          await notifyMany(staff, {
            type: 'cni_checklist_complete',
            title: `Checklist done: ${job.job_number}`,
            body: `${profile?.full_name || 'An installer'} finished the install checklist on "${job.title}".`,
            url: deepLinks.cniJob(task.job_id),
            channels: ['in_app', 'push'],
          });
        }
      } catch (err) {
        console.error('cni_checklist_complete notify failed:', err);
      }
    }
  }

  return NextResponse.json({ success: true, checklistComplete });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;

  const id = req.nextUrl.searchParams.get('id') || '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const { error } = await supabase.from('cni_job_tasks').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
