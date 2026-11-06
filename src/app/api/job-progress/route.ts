import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { JOB_PROGRESS_ESTIMATE_COLUMNS, isApprovedEstimate, loadJobProgress, resolveJobEstimateId } from '@/lib/job-progress-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * GET /api/job-progress?estimate= | so= | graphicsJob= | checkin=
 *
 * The Job progress bar for one order (src/lib/job-progress.ts): which of the
 * eight steps are done, which is in progress, and what's next. Any staff
 * member: the bar carries no prices.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const supabase = createServiceClient();
  const q = req.nextUrl.searchParams;

  try {
    const estimateId = await resolveJobEstimateId(supabase, {
      estimate: q.get('estimate'),
      so: q.get('so'),
      graphicsJob: q.get('graphicsJob'),
      checkin: q.get('checkin'),
    });
    if (!estimateId) return NextResponse.json({ found: false });

    const { data: est } = await supabase.from('estimates').select(JOB_PROGRESS_ESTIMATE_COLUMNS).eq('id', estimateId).maybeSingle();
    if (!est || !isApprovedEstimate(est as any)) return NextResponse.json({ found: false });

    const result = (await loadJobProgress(supabase, [est])).get(estimateId);
    if (!result) return NextResponse.json({ found: false });
    return NextResponse.json({
      found: true,
      estimateId,
      estimateNumber: (est as any).estimate_number || null,
      soNumber: result.soNumber,
      progress: result.view,
    });
  } catch (e: any) {
    return NextResponse.json({ error: `Couldn't load the job progress: ${e?.message || e}` }, { status: 500 });
  }
}
