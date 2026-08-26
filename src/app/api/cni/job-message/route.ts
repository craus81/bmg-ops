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
  body: z.string().trim().min(1).max(4000),
});

/**
 * Send a message on a CNI job thread. The same CniJobChat component serves both
 * the installer portal and the admin side, so this authorizes EITHER internal
 * staff OR the job's installer/company member. Previously a direct browser
 * insert into cni_job_messages with a client-supplied sender_id (spoofable) —
 * here sender_id is always the authenticated caller.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, body } = parsed.data;

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

  const { data: inserted, error } = await supabase
    .from('cni_job_messages')
    .insert({ job_id: jobId, sender_id: auth.user.id, body })
    .select('id')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true, id: inserted?.id });
}
