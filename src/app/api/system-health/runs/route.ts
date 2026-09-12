import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { loadRunHistory, HEALTH_MONITORS } from '@/lib/system-health';

export const dynamic = 'force-dynamic';

const service = createServiceClient();

/**
 * GET /api/system-health/runs?job=<sync_type> (R6-13) — the last 30 runs of
 * one background job from the flight recorder (migration 308).
 *
 * Staff, same audience as the System Health board this expands. The job
 * name is checked against HEALTH_MONITORS rather than passed through, so
 * the parameter can only name a job the board already lists.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const job = (req.nextUrl.searchParams.get('job') || '').trim();
  if (!HEALTH_MONITORS.some(m => m.syncType === job)) {
    return NextResponse.json({ error: 'Unknown job' }, { status: 404 });
  }

  try {
    const history = await loadRunHistory(service, job, 30);
    return NextResponse.json({
      ...history,
      // Said out loud wherever this renders: only runs that reached
      // recordHeartbeat are here, so a gap is "never finished reporting",
      // not "ran fine". Staleness on the board is the did-it-run signal.
      note: 'Only runs that finished and reported are recorded. A gap means a run never reached the end, not that the job is healthy.',
    });
  } catch (e: any) {
    console.error('run history failed:', e);
    return NextResponse.json({ error: 'Could not load run history.' }, { status: 500 });
  }
}
