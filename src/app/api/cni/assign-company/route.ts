import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { getCompanyInstallerIds } from '@/lib/cni-access';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { companyCompliance } from '@/lib/cni-compliance';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  jobId: z.string().uuid(),
  companyId: z.string().uuid(),
  /** Acknowledgment that the company is not eligible for work, with the
   *  reason. Required to assign past the compliance gate (R6-8). */
  overrideReason: z.string().trim().min(1).max(500).optional(),
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
  const { jobId, companyId, overrideReason } = parsed.data;

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, job_number, title, status, assigned_company_id')
    .eq('id', jobId)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  // Compliance gate (R6-8). It WARNS rather than hard-blocks: a hard block
  // on a dataset nobody has audited would stop the business on day one, and
  // a workaround nobody can log is worse than an exception everybody can
  // see. So a first call without a reason is refused with the specifics,
  // and a second call carrying one proceeds and is recorded as an override.
  const compliance = await companyCompliance(supabase, companyId);
  if (compliance && !compliance.eligible) {
    if (!overrideReason) {
      return NextResponse.json({
        error: `${compliance.name} is not eligible for work`,
        complianceBlock: {
          name: compliance.name,
          state: compliance.state,
          blocking: compliance.blocking,
          details: compliance.requirements.filter(r => !r.met).map(r => r.detail).filter(Boolean),
        },
      }, { status: 409 });
    }
    await logAudit(supabase, {
      actorId: auth.user.id,
      table: 'cni_jobs',
      recordId: jobId,
      action: 'cni_assign_noncompliant',
      detail: {
        company: compliance.name,
        state: compliance.state,
        blocking: compliance.blocking,
        insuranceExpiry: compliance.insuranceExpiry,
        reason: overrideReason,
      },
    });
  }

  const newStatus = job.status === 'awaiting_assignment' || job.status === 'bidding_open'
    ? 'assigned_awaiting_scheduling'
    : job.status;

  const { error } = await supabase.from('cni_jobs').update({
    assigned_company_id: companyId,
    assigned_at: new Date().toISOString(),
    status: newStatus,
    updated_by: auth.user.id,
    // Clear the invite-SLA alert stamp (m297): this job found someone. If it
    // ever goes back out to bid, the sweep is free to alert on it again —
    // a stale stamp would silence the second search.
    invite_sla_alerted_at: null,
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
