import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { isInstallScheduler } from '@/lib/install-scheduling';
import { newAlertWatcherIds, readyToScheduleRows } from '@/lib/job-schedule-alerts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * GET /api/upfit-projects/ready-to-schedule — Home's "Ready to schedule"
 * list for whoever books installs (Jessie) and anyone copied on new alerts
 * (Craig): jobs whose parts are in stock but not reserved, and jobs with
 * every part reserved and no drop-off date. Everyone else gets an empty
 * list, so Home renders nothing.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const userId = auth.user!.id;
  const allowed = (await isInstallScheduler(service, userId)) || (await newAlertWatcherIds(service)).includes(userId);
  if (!allowed) return NextResponse.json({ scheduler: false, jobs: [], total: 0 });
  try {
    const rows = await readyToScheduleRows(service);
    return NextResponse.json({ scheduler: true, jobs: rows.slice(0, 15), total: rows.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to load' }, { status: 500 });
  }
}
