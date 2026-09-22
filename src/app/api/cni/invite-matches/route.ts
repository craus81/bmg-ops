import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { validateSearchParams, z } from '@/lib/validate';
import { rankForJob } from '@/lib/cni-match-inputs';
import { loadComplianceOverview } from '@/lib/cni-compliance';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Ranked invite picker (R6-5). The aggregation lives in cni-match-inputs so
 * the SLA alert's "next best company" suggestion (R6-8) ranks through the
 * SAME code — two copies would drift and then the picker and the alert
 * would disagree about who to try next.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'cni_admin');
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, z.object({ jobId: z.string().uuid() }));
  if (q.error) return q.error;

  try {
    const [ranked, compliance] = await Promise.all([
      rankForJob(service, q.data.jobId),
      // Compliance (R6-8) — surfaced on the picker so a coordinator sees the
      // paperwork problem BEFORE inviting, not at assignment time.
      loadComplianceOverview(service).catch(() => null),
    ]);
    if (!ranked) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    // Eligibility rides ALONGSIDE the ranking, never inside it: a
    // non-compliant company can still be the closest and most capable, and
    // burying that in a score would hide both facts. The picker shows the
    // rank AND the paperwork flag; the gate lives on assignment.
    const complianceByCompany: Record<string, { eligible: boolean; state: string; blocking: string[] }> = {};
    for (const c of compliance?.companies || []) {
      complianceByCompany[c.subjectId] = { eligible: c.eligible, state: c.state, blocking: c.blocking };
    }

    return NextResponse.json({
      matches: ranked.matches,
      invitedIds: ranked.inputs.invitedIds,
      compliance: complianceByCompany,
      complianceAvailable: compliance != null,
      job: {
        zip: ranked.inputs.job.zip,
        state: ranked.inputs.job.state,
        serviceType: ranked.inputs.job.serviceType,
      },
      // So the UI can say WHY there is no mileage rather than looking broken.
      distanceAvailable: ranked.inputs.coords.job != null
        && Object.keys(ranked.inputs.coords.byCompanyId).length > 0,
      centroidsLoaded: ranked.inputs.centroidsLoaded,
    });
  } catch (e: any) {
    console.error('invite matches failed:', e);
    return NextResponse.json({ error: e?.message || 'Ranking failed' }, { status: 500 });
  }
}
