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
  invoiceFilePath: z.string().trim().min(1).max(500),
});

/**
 * Installer submits the per-job company invoice (attaches the file and flips
 * invoice_status to 'submitted'). Previously a direct browser write to cni_jobs;
 * routed here so the caller can only set these two fields on an authorized job
 * and only to 'submitted' — never self-approve to 'approved'/'billed_in_netsuite'.
 * The file itself still uploads via /api/storage; this records it and notifies
 * the coordinators to review.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, invoiceFilePath } = parsed.data;

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, job_number, title, status, invoice_status, assigned_installer_id, assigned_company_id')
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

  // Can't (re)submit once a coordinator has approved or billed it — mirrors the
  // page's own upload gate, enforced here so the status can only advance to
  // 'submitted'.
  if (!['none', 'submitted'].includes(job.invoice_status)) {
    return NextResponse.json({ error: 'Invoice already approved; it can no longer be changed.' }, { status: 409 });
  }

  const wasSubmitted = job.invoice_status === 'submitted';

  const { error } = await supabase.from('cni_jobs').update({
    invoice_file_path: invoiceFilePath,
    invoice_status: 'submitted',
    // Attribute the audit-diff row to the caller (the trigger falls back to a
    // NULL 'system' actor otherwise, since the service role has no auth.uid()).
    updated_by: auth.user.id,
  }).eq('id', jobId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Notify coordinators there's an invoice to review — only on the first submit
  // (a replace while already 'submitted' doesn't re-ping).
  if (!wasSubmitted) {
    try {
      const staff = await getCniStaffIds(supabase, auth.user.id);
      if (staff.length > 0) {
        const who = profile?.full_name || 'An installer';
        await notifyMany(staff, {
          type: 'cni_invoice_submitted',
          title: `Invoice submitted: ${job.job_number}`,
          body: `${who} submitted an invoice for "${job.title}". Review and approve it.`,
          url: deepLinks.cniJob(jobId),
          channels: ['in_app', 'push', 'email'],
          forceChannels: true,
        });
      }
    } catch (err) {
      console.error('cni_invoice_submitted notify failed:', err);
    }
  }

  return NextResponse.json({ success: true });
}
