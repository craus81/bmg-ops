import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { getCniCompanyId, getCniStaffIds } from '@/lib/cni-access';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  jobId: z.string().uuid(),
  response: z.enum(['interested', 'declined']),
  proposedStart: z.string().max(20).optional().nullable(),
  proposedEnd: z.string().max(20).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  declineReason: z.string().max(2000).optional().nullable(),
  /** Admin preview only — bid on behalf of an installer. Ignored (the
   *  caller bids as themselves) unless the caller is an admin. */
  installerId: z.string().uuid().optional().nullable(),
});

/**
 * POST /api/cni/bid — an installer responds to a job (audit item 16: bids
 * were browser-side upserts nobody heard about — coordinators only saw
 * them by re-opening the job page on a hunch).
 *
 * Access mirrors what the Available board shows an installer: the job is
 * published, or their company holds an invite. Writes the bid, keeps
 * bid_count fresh, and notifies the coordinators (admins) with the
 * response — an interested bid is the signal to go assign the company.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, full_name, role, roles, company_id')
    .eq('id', auth.user.id)
    .maybeSingle();
  const roles: string[] = profile?.roles?.length ? profile.roles : [profile?.role].filter(Boolean);
  const isAdmin = roles.includes('admin') || roles.includes('super_admin');

  const bidderId = isAdmin && body.installerId ? body.installerId : auth.user.id;

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, job_number, title, distribution_type')
    .eq('id', body.jobId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  const companyId = await getCniCompanyId(supabase, bidderId);

  // Visibility check — same rule as the Available board: published to all,
  // or this bidder's company was invited.
  if (!isAdmin) {
    let visible = job.distribution_type === 'published';
    if (!visible && companyId) {
      const { data: invite } = await supabase
        .from('cni_job_invites')
        .select('id')
        .eq('job_id', job.id)
        .eq('company_id', companyId)
        .limit(1);
      visible = !!(invite && invite.length > 0);
    }
    if (!visible) {
      return NextResponse.json({ error: 'This job is not open to your company.' }, { status: 403 });
    }
  }

  const bidData: Record<string, unknown> = {
    job_id: job.id,
    installer_id: bidderId,
    company_id: companyId,
    response: body.response,
    responded_at: new Date().toISOString(),
  };
  if (body.response === 'interested') {
    bidData.proposed_start = body.proposedStart || null;
    bidData.proposed_end = body.proposedEnd || null;
    bidData.notes = body.notes || null;
  } else {
    bidData.decline_reason = body.declineReason || null;
  }

  const { error } = await supabase.from('cni_job_bids').upsert(bidData, {
    onConflict: 'job_id,installer_id',
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { count } = await supabase
    .from('cni_job_bids')
    .select('*', { count: 'exact', head: true })
    .eq('job_id', job.id);
  await supabase.from('cni_jobs').update({ bid_count: count || 0 }).eq('id', job.id);

  // Coordinators hear the response — an interested bid is actionable NOW.
  try {
    const staff = await getCniStaffIds(supabase, auth.user.id);
    if (staff.length > 0) {
      const who = profile?.full_name || 'An installer';
      await notifyMany(staff, {
        type: 'cni_job_bid',
        title: body.response === 'interested'
          ? `💪 Bid on ${job.job_number}: ${who} is interested`
          : `Bid declined on ${job.job_number}`,
        body: body.response === 'interested'
          ? `${who} is interested in "${job.title}"${body.proposedStart ? ` — proposed start ${body.proposedStart}` : ''}. Review the bids and assign.`
          : `${who} passed on "${job.title}".${body.declineReason ? ` Reason: ${body.declineReason}` : ''}`,
        url: deepLinks.cniJob(job.id),
        channels: ['in_app', 'push'],
      });
    }
  } catch (err) {
    console.error('cni_job_bid notify failed:', err);
  }

  return NextResponse.json({ success: true, bidCount: count || 0 });
}
