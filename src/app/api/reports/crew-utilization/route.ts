import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { loadCrewUtilization, loadJobProductivity } from '@/lib/crew-utilization';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/reports/crew-utilization?days=N (R6-12)
 * GET /api/reports/crew-utilization?jobId=… → the one job's actual-vs-estimate
 *
 * Crew hours from work_shifts against what was planned: per CNI job, per
 * company by week, and per person by context. Auto-closed hours are always
 * a separate figure, never blended into a measured total.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin']);
  if (auth.error) return auth.error;

  const params = req.nextUrl.searchParams;
  const jobId = params.get('jobId');
  try {
    if (jobId) {
      const job = await loadJobProductivity(supabase, jobId);
      if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
      return NextResponse.json({ job });
    }
    const rawDays = Number(params.get('days'));
    const days = Number.isFinite(rawDays) && rawDays >= 7 && rawDays <= 730 ? Math.floor(rawDays) : 90;
    const report = await loadCrewUtilization(supabase, new Date(Date.now() - days * 86_400_000).toISOString());
    return NextResponse.json({ ...report, days });
  } catch (err: any) {
    console.error('crew-utilization report failed:', err);
    return NextResponse.json({ error: err?.message || 'Report failed' }, { status: 500 });
  }
}
