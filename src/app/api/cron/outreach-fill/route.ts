import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { recordHeartbeat } from '@/lib/system-health';
import { fillWeek } from '@/lib/outreach-batch';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const service = createServiceClient();

/**
 * Monday Outreach batch (migration 438): top every Sales rep up to 25 new
 * companies for the week. Finds and lists only. Nothing is emailed here or
 * anywhere else without a rep pressing Send. An admin can run it by hand
 * from the Outreach page ("Find companies now"); it only fills gaps.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  const startedAt = Date.now();
  try {
    const result = await fillWeek(service);
    const added = result.reps.reduce((n, r) => n + r.added, 0);
    await recordHeartbeat(service, 'outreach_fill', result, { startedAt, records: added });
    return NextResponse.json({ success: true, added, ...result });
  } catch (err: any) {
    await recordHeartbeat(service, 'outreach_fill', { error: err.message }, { startedAt, touchLastSyncedAt: false });
    return NextResponse.json({ error: err.message || 'Finding companies failed' }, { status: 500 });
  }
}
