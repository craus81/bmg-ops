import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { rolesOf } from '@/lib/cni-access';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const QuerySchema = z.object({ profileId: z.string().uuid().optional() });

/**
 * The signed-in user's pay credits, enriched for the My Earnings page:
 * CNI credits carry their job number/title, field credits group by part,
 * and each row knows its payout status. Strictly self-scoped — the only
 * cross-user data returned is crew size, which the user already saw when
 * the vehicle was scanned. Admins may pass ?profileId= to view another
 * worker's earnings (the installer-portal preview).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, QuerySchema);
  if (q.error) return q.error;
  let target = auth.user.id;
  if (q.data.profileId && q.data.profileId !== auth.user.id) {
    if (!rolesOf(auth.profile).includes('admin')) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    target = q.data.profileId;
  }

  // Payout history: every payout ever issued to this worker — "when was I
  // paid, and for which period/job" — independent of the credit list below
  // (which is capped and per-VIN).
  const { data: payoutRows } = await service
    .from('payouts')
    .select('id, kind, cni_job_id, period_start, period_end, total_amount, status, netsuite_bill_id, created_at, approved_at, billed_at, paid_at')
    .eq('profile_id', target)
    .order('created_at', { ascending: false })
    .limit(200);

  const payoutJobIds = [...new Set((payoutRows || []).map(p => p.cni_job_id).filter(Boolean))] as string[];
  const payoutJobLabels = new Map<string, string>();
  if (payoutJobIds.length > 0) {
    const { data: jobs } = await service
      .from('cni_jobs').select('id, job_number, title').in('id', payoutJobIds);
    for (const j of jobs || []) payoutJobLabels.set(j.id, j.title || j.job_number || '');
  }
  const payouts = (payoutRows || []).map(p => ({
    id: p.id,
    kind: p.kind,
    label: p.kind === 'payroll_period'
      ? `Pay period ${p.period_start || '?'} – ${p.period_end || '?'}`
      : (p.cni_job_id && payoutJobLabels.get(p.cni_job_id)) || 'CNI job payout',
    amount: p.total_amount != null ? Number(p.total_amount) : null,
    status: p.status,
    createdAt: p.created_at,
    paidAt: p.paid_at,
    billedAt: p.billed_at,
  }));

  const { data: credits } = await service
    .from('install_credits')
    .select('id, vin, part_number, source, rate_per_vehicle, share_weight, crew_size, total_weight, amount, payout_id, cni_job_vin_id, created_at')
    .eq('profile_id', target)
    .is('voided_at', null)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (!credits || credits.length === 0) return NextResponse.json({ credits: [], payouts });

  // Resolve CNI credits to their job for grouping.
  const vinIds = [...new Set(credits.map(c => c.cni_job_vin_id).filter(Boolean))] as string[];
  const vinToJob = new Map<string, string>();
  const jobLabels = new Map<string, string>();
  if (vinIds.length > 0) {
    const { data: vins } = await service
      .from('cni_job_vins').select('id, job_id').in('id', vinIds);
    const jobIds = [...new Set((vins || []).map(v => v.job_id))];
    const { data: jobs } = jobIds.length
      ? await service.from('cni_jobs').select('id, job_number, title').in('id', jobIds)
      : { data: [] as { id: string; job_number: string; title: string }[] };
    for (const j of jobs || []) jobLabels.set(j.id, `${j.job_number} — ${j.title}`);
    for (const v of vins || []) vinToJob.set(v.id, v.job_id);
  }

  // Payout status per credit (pending until linked to a payout).
  const payoutIds = [...new Set(credits.map(c => c.payout_id).filter(Boolean))] as string[];
  const payoutStatus = new Map<string, string>();
  if (payoutIds.length > 0) {
    const { data: payouts } = await service
      .from('payouts').select('id, status').in('id', payoutIds);
    for (const p of payouts || []) payoutStatus.set(p.id, p.status);
  }

  return NextResponse.json({
    payouts,
    credits: credits.map(c => {
      const jobId = c.cni_job_vin_id ? vinToJob.get(c.cni_job_vin_id) : undefined;
      return {
        id: c.id,
        vin: c.vin,
        source: c.source,
        partNumber: c.part_number,
        crewSize: c.crew_size,
        shareWeight: Number(c.share_weight),
        amount: c.amount != null ? Number(c.amount) : null,
        createdAt: c.created_at,
        group: c.source === 'cni'
          ? (jobId && jobLabels.get(jobId)) || 'CNI job'
          : c.part_number || 'Field installs',
        payoutStatus: c.payout_id ? (payoutStatus.get(c.payout_id) || 'pending') : 'pending',
      };
    }),
  });
}
