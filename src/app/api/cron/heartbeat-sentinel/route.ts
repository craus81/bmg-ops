import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { recordHeartbeat } from '@/lib/system-health';
import { computeBusinessPulse } from '@/lib/business-pulse';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * Business Heartbeat (R6-13) — the daily record of the five pulse checks,
 * kept on System Health so a run that never happens still shows as stale.
 *
 * It notifies nobody. Owner decision 2026-10-22: the pulse lives on the
 * super-admin Dashboard card (/api/admin/business-pulse), worked out when
 * the page opens; see src/lib/business-pulse.ts for how each check judges.
 */
export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    const report = await computeBusinessPulse(service);
    const payload = {
      day: report.day,
      tripped: report.tripped.map(c => ({ key: c.key, detail: c.detail })),
      unknown: report.unknown.map(c => ({ key: c.key, detail: c.detail })),
      ok: report.checks.filter(c => c.status === 'ok').length,
      records: report.checks.length,
    };
    await recordHeartbeat(service, 'heartbeat_sentinel', payload, { startedAt, records: report.checks.length });
    return NextResponse.json({ success: true, ...payload, checks: report.checks });
  } catch (e: any) {
    console.error('heartbeat sentinel failed:', e);
    await recordHeartbeat(service, 'heartbeat_sentinel', { error: e?.message || 'unknown' }, { startedAt });
    return NextResponse.json({ error: 'Heartbeat sentinel failed' }, { status: 500 });
  }
}
