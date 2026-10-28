import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { recordHeartbeat } from '@/lib/system-health';
import { runJobScheduleSweep } from '@/lib/job-schedule-alerts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * Hourly on weekdays, shop hours (migration 450): every open job whose
 * parts are all in stock but not reserved gets "Reserve parts", and every
 * job with all parts reserved and no drop-off date gets "Ready to
 * schedule", each once, to whoever schedules installs plus Craig. Runs
 * from synced data after the hourly parts sync. Reserving on the job page
 * sends "Ready to schedule" straight away; this catches the rest.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    const result = await runJobScheduleSweep(service);
    await recordHeartbeat(service, 'job_schedule_alerts', { status: 'ok', ...result });
    return NextResponse.json({ status: 'ok', ...result });
  } catch (e: any) {
    console.error('job-schedule-alerts failed:', e);
    await recordHeartbeat(service, 'job_schedule_alerts', { error: e.message || 'job schedule alerts failed' });
    return NextResponse.json({ error: e.message || 'job schedule alerts failed' }, { status: 500 });
  }
}
