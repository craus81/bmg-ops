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
 * hide for weeks. Runs every 30 min via Vercel Cron.
 *
 * Dead-man's switch: every run also pings HEALTH_PING_URL (a
 * healthchecks.io-style check URL). If the Vercel cron scheduler itself
 * dies — the one failure this route can't alert on, since it stops running
 * too — the pings stop arriving and the external service emails/pages the
 * admins. Bad checks ping the /fail variant so the external service also
 * mirrors job-level problems.
 */
const pingExternalMonitor = async (ok: boolean, summary: string) => {
  const base = process.env.HEALTH_PING_URL;
  if (!base) return;
  try {
    // healthchecks.io convention: <url> = success, <url>/fail = failure.
    // The body shows up in the check's event log for context.
    await fetch(ok ? base : `${base.replace(/\/$/, '')}/fail`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: summary.slice(0, 1000),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Never let the dead-man's switch break the watcher itself.
    console.error('HEALTH_PING_URL ping failed:', err);
  }
};

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

    await pingExternalMonitor(
      bad.length === 0,
      bad.length === 0
        ? `all ${checks.length} jobs ok`
        : bad.map(c => `${c.label}: ${c.problem}`).join(' · '),
    );

    return NextResponse.json({
      status: 'ok',
      checks: checks.map(c => ({ syncType: c.syncType, status: c.status })),
      alerted: toAlert.map(c => c.syncType),
      notified,
    });
  } catch (e: any) {
    console.error('health-check failed:', e);
    // The watcher ran but crashed — still a failure signal worth surfacing
    // externally (a success ping here would mask the crash).
    await pingExternalMonitor(false, `health-check crashed: ${e.message || 'unknown error'}`);
    return NextResponse.json({ error: e.message || 'health check failed' }, { status: 500 });
  }
}
