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
  { syncType: 'health_check', label: 'Health monitor itself', intervalMinutes: 30 },
  { syncType: 'at_risk_check', label: 'At-risk account sweep', intervalMinutes: 1440 },
  { syncType: 'quote_followup_check', label: 'Quote follow-up nudges', intervalMinutes: 1440 },
];

/** A run is stale once it's overdue by more than a full interval (2× spacing), plus grace for slow runs. */
const staleThresholdMinutes = (m: HealthMonitor) => m.intervalMinutes * 2 + 15;

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
