import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { getCompanyInstallerIds } from '@/lib/cni-access';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  jobId: z.string().uuid(),
  companyId: z.string().uuid(),
});

/**
 * POST /api/cni/invite-company — invite an installer company to bid on a
 * job (audit item 16: the invite was a browser-side upsert with no notify,
 * so "you'll be notified about new jobs" was a promise the portal never
 * kept — invites sat unseen until an installer happened to open the
 * Available list).
 *
 * Server-side so the company roster can be resolved with the service role
 * (the #684 notification_preferences RLS lesson).
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId, companyId } = parsed.data;

  const { data: job } = await supabase
    .from('cni_jobs')
    .select('id, job_number, title')
    .eq('id', jobId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  // Plain insert, not upsert: the only unique index on (job_id, company_id)
  // is PARTIAL (WHERE company_id IS NOT NULL, migration 111), and Postgres
  // refuses to infer a partial index for ON CONFLICT without its predicate —
  // which PostgREST cannot send — so the upsert form 42P10'd on EVERY call
  // (Round 3 finding: the invite button 500'd in production since #715).
  // A duplicate invite trips the index as 23505; treat that as "already
  // invited" and still re-notify — a deliberate re-invite is a re-ping.
  const { error } = await supabase.from('cni_job_invites').insert({
    job_id: jobId,
    company_id: companyId,
    installer_id: null,
    invite_type: 'direct',
    invited_by: auth.user.id,
  });
  if (error && error.code !== '23505') {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // The point of the invite: the company's installers hear about it.
  let notified = 0;
  try {
    const installerIds = await getCompanyInstallerIds(supabase, companyId);
    if (installerIds.length > 0) {
      await notifyMany(installerIds, {
        type: 'cni_job_invite',
        title: `Job available to bid: ${job.job_number}`,
        body: `Your company was invited to bid on "${job.title}". Open it to respond with interest or a pass.`,
        url: deepLinks.installerAvailableJob(jobId),
        channels: ['in_app', 'push'],
        forceChannels: true,
      });
      notified = installerIds.length;
    }
  } catch (err) {
    console.error('cni_job_invite notify failed:', err);
  }

  return NextResponse.json({ success: true, notified });
}
