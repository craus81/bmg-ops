import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { evaluateSystemHealth } from '@/lib/system-health';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Re-alert cadence while a check stays bad — enough to not be ignorable,
// not enough to train people to ignore it.
const REALERT_HOURS = 6;

/**
 * Watches the other background jobs and pushes an alert to admins when one
 * goes stale or records an error — a dead NetSuite sync used to be able to
 * hide for weeks. Runs every 30 min via Vercel Cron. (If THIS cron dies,
 * its own heartbeat goes stale on the System Health page — but no push
 * fires; truly independent monitoring needs an external pinger.)
 */
export async function GET(req: NextRequest) {
  // Allow Vercel Cron with the shared secret; anyone else needs an admin
  // session (manual trigger). Fails closed if CRON_SECRET is not configured.
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    const checks = await evaluateSystemHealth(service);
    const bad = checks.filter(c => c.syncType !== 'health_check' && c.status !== 'ok' && c.status !== 'never');

    // Dedupe alerts per check via a sync_state row of our own:
    // last_result = { [syncType]: lastAlertIso }.
    const { data: alertState } = await service
      .from('sync_state').select('last_result').eq('sync_type', 'health_alerts').maybeSingle();
    const lastAlerts: Record<string, string> = (alertState?.last_result as Record<string, string>) || {};
    const now = Date.now();
    const toAlert = bad.filter(c => {
      const last = lastAlerts[c.syncType];
      return !last || now - new Date(last).getTime() > REALERT_HOURS * 3600 * 1000;
    });

    let notified = 0;
    if (toAlert.length > 0) {
      const { data: admins } = await service
        .from('profiles')
        .select('id')
        .or('role.eq.admin,roles.cs.{admin}')
        .eq('status', 'approved');
      const adminIds = (admins || []).map(a => a.id);
      if (adminIds.length > 0) {
        const lines = toAlert.map(c => `${c.label}: ${c.problem}`).join(' · ');
        await notifyMany(adminIds, {
          type: 'system_health',
          title: `⚠ ${toAlert.length} background job${toAlert.length !== 1 ? 's' : ''} need attention`,
          body: lines.slice(0, 900),
          url: '/admin/system-health',
          channels: ['in_app', 'push'],
          forceChannels: true,
        });
        notified = adminIds.length;
      }
      for (const c of toAlert) lastAlerts[c.syncType] = new Date().toISOString();
    }

    // Clear the dedupe timer for recovered checks so the NEXT failure
    // alerts immediately, and write our own heartbeat.
    for (const c of checks) {
      if (c.status === 'ok' && lastAlerts[c.syncType]) delete lastAlerts[c.syncType];
    }
    await service.from('sync_state').upsert({
      sync_type: 'health_alerts',
      last_synced_at: new Date().toISOString(),
      last_result: lastAlerts,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'sync_type' });
    await service.from('sync_state').upsert({
      sync_type: 'health_check',
      last_synced_at: new Date().toISOString(),
      last_result: { status: 'ok', bad: bad.length, alerted: toAlert.length },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'sync_type' });

    return NextResponse.json({
      status: 'ok',
      checks: checks.map(c => ({ syncType: c.syncType, status: c.status })),
      alerted: toAlert.map(c => c.syncType),
      notified,
    });
  } catch (e: any) {
    console.error('health-check failed:', e);
    return NextResponse.json({ error: e.message || 'health check failed' }, { status: 500 });
  }
}
