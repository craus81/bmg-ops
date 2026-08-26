import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, isInternalStaffRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { canActOnCniJob } from '@/lib/cni-access';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  jobId: z.string().uuid(),
});

/**
 * Mark the other party's unread messages on a job thread as read. Previously a
 * direct browser update to cni_job_messages (the FOR ALL RLS policy also let a
 * participant edit/delete anyone's message on the job); routed here as a scoped
 * read_at stamp on messages NOT sent by the caller.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId } = parsed.data;

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, assigned_installer_id, assigned_company_id')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const staff = isInternalStaffRole(auth.profile);
  if (!staff && !(await canActOnCniJob(supabase, auth.user.id, job))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { error } = await supabase
    .from('cni_job_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('job_id', jobId)
    .neq('sender_id', auth.user.id)
    .is('read_at', null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
