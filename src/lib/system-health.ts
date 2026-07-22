import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Background-job health, generalized from the gmail auto-import heartbeat
 * pattern: every sync writes a sync_state row; health = how stale that row
 * is versus the job's schedule, plus whether its last result recorded an
 * error. Staleness is the primary signal — it catches dead crons and
 * crashed runs alike, since neither advances last_synced_at.
 */

export interface HealthMonitor {
  syncType: string;
  label: string;
  /** How often the job is scheduled to run. */
  intervalMinutes: number;
}

export type HealthStatus = 'ok' | 'stale' | 'error' | 'never';

export interface HealthCheck extends HealthMonitor {
  status: HealthStatus;
  lastRunAt: string | null;
  ageMinutes: number | null;
  /** Human-readable problem description when status is error/stale/never. */
  problem: string | null;
}

export const HEALTH_MONITORS: HealthMonitor[] = [
  { syncType: 'gmail_auto_import', label: 'Gmail PO auto-import', intervalMinutes: 20 },
  { syncType: 'netsuite_customers', label: 'NetSuite customer sync', intervalMinutes: 120 },
  { syncType: 'netsuite_spend_refresh', label: 'NetSuite spend refresh', intervalMinutes: 120 },
  { syncType: 'netsuite_contacts', label: 'NetSuite contact sync', intervalMinutes: 120 },
  { syncType: 'netsuite_vendor_pos', label: 'NetSuite vendor PO sync', intervalMinutes: 120 },
  { syncType: 'parts_email_scan', label: 'Parts email ETA scan', intervalMinutes: 60 },
  { syncType: 'netsuite_inventory', label: 'NetSuite inventory sweep', intervalMinutes: 120 },
  { syncType: 'health_check', label: 'Health monitor itself', intervalMinutes: 30 },
  { syncType: 'at_risk_check', label: 'At-risk account sweep', intervalMinutes: 1440 },
  { syncType: 'quote_followup_check', label: 'Quote follow-up nudges', intervalMinutes: 1440 },
  { syncType: 'proof_reminder_check', label: 'Proof-approval reminders', intervalMinutes: 1440 },
  { syncType: 'stuck_vehicle_check', label: 'Stuck-vehicle sweep', intervalMinutes: 1440 },
  { syncType: 'weekly_customer_digest', label: 'Weekly customer digest', intervalMinutes: 10080 },
];

/** A run is stale once it's overdue by more than a full interval (2× spacing), plus grace for slow runs. */
const staleThresholdMinutes = (m: HealthMonitor) => m.intervalMinutes * 2 + 15;

export interface HeartbeatResult {
  ok: boolean;
  error?: string;
}

/**
 * Write a job's sync_state heartbeat and VERIFY it landed.
 *
 * supabase-js never throws on a failed write — it returns { error } — and an
 * upsert can even report success while the row stays stale (RLS filtering the
 * conflict-update path writes nothing and raises nothing). The gmail
 * auto-import learned this the hard way and got a read-back check; the July
 * 2026 incident (every job running fine while its heartbeat silently stopped
 * landing, so System Health showed the whole board stale) is the same failure
 * hitting every job that didn't. All heartbeats go through here now: check
 * the write result, read the row back, and hand the caller an outcome it can
 * surface in its response.
 *
 * `touchLastSyncedAt: false` writes only last_result/updated_at — for jobs
 * whose last_synced_at is a data cursor that must not advance on a failed run
 * (e.g. the calendar pull).
 */
export async function recordHeartbeat(
  service: SupabaseClient,
  syncType: string,
  lastResult: unknown,
  opts?: { touchLastSyncedAt?: boolean },
): Promise<HeartbeatResult> {
  const wroteAt = new Date().toISOString();
  try {
    const row: Record<string, unknown> = {
      sync_type: syncType,
      last_result: lastResult,
      updated_at: wroteAt,
    };
    if (opts?.touchLastSyncedAt !== false) row.last_synced_at = wroteAt;
    const { error } = await service
      .from('sync_state')
      .upsert(row, { onConflict: 'sync_type' });
    if (error) {
      console.error(`[heartbeat] ${syncType} upsert error:`, error);
      return { ok: false, error: error.message || JSON.stringify(error) };
    }
    // Trust but verify: read the row back. Compare as epoch times, not
    // strings — Postgres renders the same instant as "…+00:00" while JS
    // wrote "…Z". updated_at moves in every write path (last_synced_at may
    // deliberately stay put), so recency is checked on updated_at.
    const { data: check, error: readErr } = await service
      .from('sync_state')
      .select('updated_at')
      .eq('sync_type', syncType)
      .maybeSingle();
    if (readErr) {
      console.error(`[heartbeat] ${syncType} read-back error:`, readErr);
      return { ok: false, error: `read-back failed: ${readErr.message}` };
    }
    const landedAt = check?.updated_at ? new Date(check.updated_at).getTime() : NaN;
    if (!(landedAt >= new Date(wroteAt).getTime() - 60_000)) {
      const msg = `upsert reported success but read-back shows ${check?.updated_at || 'no row at all'}`;
      console.error(`[heartbeat] ${syncType} phantom write:`, msg);
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (err: any) {
    console.error(`[heartbeat] ${syncType} failed:`, err?.message);
    return { ok: false, error: err?.message || 'unknown sync_state write failure' };
  }
}

const errorOf = (lastResult: any): string | null => {
  if (!lastResult || typeof lastResult !== 'object') return null;
  if (typeof lastResult.error === 'string' && lastResult.error) return lastResult.error;
  if (lastResult.status === 'error') return 'last run recorded an error';
  // Per-phase results (netsuite-sync style): any phase carrying an error.
  for (const [phase, value] of Object.entries(lastResult)) {
    if (value && typeof value === 'object' && typeof (value as any).error === 'string' && (value as any).error) {
      return `${phase}: ${(value as any).error}`;
    }
  }
  return null;
};

export async function evaluateSystemHealth(service: SupabaseClient): Promise<HealthCheck[]> {
  const { data: rows } = await service
    .from('sync_state')
    .select('sync_type, last_synced_at, last_result, updated_at');
  const bySyncType = new Map((rows || []).map(r => [r.sync_type, r]));
  const now = Date.now();

  return HEALTH_MONITORS.map(m => {
    const row = bySyncType.get(m.syncType);
    // updated_at moves on every write; last_synced_at can be a data cursor
    // (e.g. "fetch records modified since"), so recency uses updated_at.
    const lastRunAt = row?.updated_at || row?.last_synced_at || null;
    if (!row || !lastRunAt) {
      return { ...m, status: 'never' as const, lastRunAt: null, ageMinutes: null, problem: 'has never run (or never wrote a heartbeat)' };
    }
    const ageMinutes = Math.round((now - new Date(lastRunAt).getTime()) / 60000);
    const error = errorOf(row.last_result);
    if (error) {
      return { ...m, status: 'error' as const, lastRunAt, ageMinutes, problem: error };
    }
    if (ageMinutes > staleThresholdMinutes(m)) {
      return { ...m, status: 'stale' as const, lastRunAt, ageMinutes, problem: `no run in ${Math.round(ageMinutes / 60)}h — scheduled every ${m.intervalMinutes} min` };
    }
    return { ...m, status: 'ok' as const, lastRunAt, ageMinutes, problem: null };
  });
}
