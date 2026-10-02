import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { evaluateSystemHealth, recordHeartbeat } from '@/lib/system-health';
import { systemHealthAudience } from '@/lib/system-health-audience';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

// Re-alert cadence while a check stays bad — enough to not be ignorable,
// not enough to train people to ignore it.
const REALERT_HOURS = 6;

/**
 * Watches the other background jobs and pushes an alert to admins when one
 * goes stale or records an error — a dead NetSuite sync used to be able to
 * hide for weeks. Runs every 30 min via Vercel Cron.
 *
 * Two external checks, healthchecks.io-style (<url> = success,
 * <url>/fail = failure; the body shows up in the check's event log):
 *
 * - HEALTH_PING_URL is the dead-man's switch for the app itself. It goes
 *   red only when the watcher stops running (the Vercel cron scheduler or
 *   the app is down), crashes, or can't write to the database. A single
 *   background job erroring no longer turns it red: in September 2026 that
 *   mirroring made it read as 20 "outages" totalling 3.5 days when the app
 *   was up the whole time, mostly daily jobs holding it red until their
 *   next run.
 * - HEALTH_JOBS_PING_URL (optional) mirrors job-level problems: /fail
 *   whenever any monitored job is stale or last recorded an error.
 */
const pingExternalMonitor = async (envVar: 'HEALTH_PING_URL' | 'HEALTH_JOBS_PING_URL', ok: boolean, summary: string) => {
  const base = process.env[envVar];
  if (!base) return;
  try {
    await fetch(ok ? base : `${base.replace(/\/$/, '')}/fail`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: summary.slice(0, 1000),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // Never let the dead-man's switch break the watcher itself.
    console.error(`${envVar} ping failed:`, err);
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
      // System Health is a super-admin page — alert the people who can open
      // it (plus anyone granted the feature individually).
      // The selection this route used to own inline now lives in
      // src/lib/system-health-audience.ts — same rule, one implementation,
      // shared with the ledger importer's finished/failed notifications.
      const adminIds = await systemHealthAudience(service);
      if (adminIds.length > 0) {
        const lines = toAlert.map(c => `${c.label}: ${c.problem}`).join(' · ');
        await notifyMany(adminIds, {
          type: 'system_health',
          title: `⚠ ${toAlert.length} background job${toAlert.length !== 1 ? 's' : ''} need attention`,
          body: lines.slice(0, 900),
          url: deepLinks.systemHealth(),
          channels: ['in_app', 'push'],
          // System-failure alarm to an opted admin audience — never silenceable.
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
    const alertsWrite = await recordHeartbeat(service, 'health_alerts', lastAlerts);
    const selfWrite = await recordHeartbeat(service, 'health_check', { status: 'ok', bad: bad.length, alerted: toAlert.length });

    // A watcher that can't persist its own heartbeat is itself broken — the
    // dashboard freezes at the last landed write while everything keeps
    // returning 200. Treat it as a failure and put the actual DB error in
    // the ping body so the external monitor's event log names the cause.
    const writeErrors = [
      ...(alertsWrite.ok ? [] : [`health_alerts heartbeat write failed: ${alertsWrite.error}`]),
      ...(selfWrite.ok ? [] : [`health_check heartbeat write failed: ${selfWrite.error}`]),
    ];
    const jobsSummary = bad.length === 0 ? `all ${checks.length} jobs ok` : bad.map(c => `${c.label}: ${c.problem}`).join(' · ');
    const appSummary = writeErrors.length > 0
      ? writeErrors.join(' · ')
      : `watcher ran · ${bad.length === 0 ? `all ${checks.length} jobs ok` : `${bad.length} job${bad.length !== 1 ? 's' : ''} need attention (see System Health)`}`;
    await Promise.all([
      pingExternalMonitor('HEALTH_PING_URL', writeErrors.length === 0, appSummary),
      pingExternalMonitor('HEALTH_JOBS_PING_URL', bad.length === 0, jobsSummary),
    ]);

    return NextResponse.json({
      status: 'ok',
      checks: checks.map(c => ({ syncType: c.syncType, status: c.status })),
      alerted: toAlert.map(c => c.syncType),
      notified,
      syncStateWrites: { health_alerts: alertsWrite, health_check: selfWrite },
    });
  } catch (e: any) {
    console.error('health-check failed:', e);
    // The watcher ran but crashed — still a failure signal worth surfacing
    // externally (a success ping here would mask the crash).
    const crashed = `health-check crashed: ${e.message || 'unknown error'}`;
    await Promise.all([
      pingExternalMonitor('HEALTH_PING_URL', false, crashed),
      pingExternalMonitor('HEALTH_JOBS_PING_URL', false, crashed),
    ]);
    return NextResponse.json({ error: e.message || 'health check failed' }, { status: 500 });
  }
}
