import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordHeartbeat, evaluateSystemHealth } from './system-health';

/**
 * Minimal sync_state-shaped stub. `upsertError` simulates a write rejected by
 * the database; `phantom` simulates the nastier failure from the July 2026
 * incident: the upsert reports success but the row never changes (e.g. RLS
 * filtering the conflict-update path), so only a read-back catches it.
 */
const stubClient = (opts: {
  upsertError?: { message: string } | null;
  phantom?: boolean;
  rows?: any[];
}) => {
  const stored: Record<string, any> = Object.fromEntries(
    (opts.rows || []).map(r => [r.sync_type, r]),
  );
  return {
    from: (_table: string) => ({
      upsert: async (row: any) => {
        if (opts.upsertError) return { error: opts.upsertError };
        if (!opts.phantom) stored[row.sync_type] = { ...stored[row.sync_type], ...row };
        return { error: null };
      },
      select: (_cols: string) => {
        const rowsPromise = Promise.resolve({ data: Object.values(stored), error: null });
        return Object.assign(rowsPromise, {
          eq: (_col: string, value: string) => ({
            maybeSingle: async () => ({ data: stored[value] || null, error: null }),
          }),
        });
      },
    }),
  } as unknown as SupabaseClient;
};

describe('recordHeartbeat', () => {
  it('reports ok when the write lands and reads back fresh', async () => {
    const res = await recordHeartbeat(stubClient({}), 'some_job', { n: 1 });
    expect(res).toEqual({ ok: true });
  });

  it('surfaces a rejected upsert instead of swallowing it', async () => {
    const res = await recordHeartbeat(
      stubClient({ upsertError: { message: 'permission denied for table sync_state' } }),
      'some_job',
      {},
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('permission denied');
  });

  it('detects a phantom write via read-back', async () => {
    const staleRow = {
      sync_type: 'some_job',
      updated_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
    };
    const res = await recordHeartbeat(
      stubClient({ phantom: true, rows: [staleRow] }),
      'some_job',
      {},
    );
    expect(res.ok).toBe(false);
    expect(res.error).toContain('read-back shows');
  });

  it('detects a phantom write when the row never existed', async () => {
    const res = await recordHeartbeat(stubClient({ phantom: true }), 'some_job', {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no row at all');
  });
});

describe('evaluateSystemHealth staleness math', () => {
  const ageHours = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  const evaluate = async (rows: any[]) => evaluateSystemHealth(stubClient({ rows }));

  it('marks a 2-hourly job stale at 39h but a daily job ok at 38h (2× interval + 15 min grace)', async () => {
    const checks = await evaluate([
      { sync_type: 'netsuite_customers', updated_at: ageHours(39), last_result: {} },
      { sync_type: 'at_risk_check', updated_at: ageHours(38), last_result: {} },
    ]);
    expect(checks.find(c => c.syncType === 'netsuite_customers')?.status).toBe('stale');
    expect(checks.find(c => c.syncType === 'at_risk_check')?.status).toBe('ok');
  });

  it('flips a daily job to stale past 48h15m', async () => {
    const checks = await evaluate([
      { sync_type: 'at_risk_check', updated_at: ageHours(49), last_result: {} },
    ]);
    expect(checks.find(c => c.syncType === 'at_risk_check')?.status).toBe('stale');
  });

  it('reports never for jobs with no heartbeat row', async () => {
    const checks = await evaluate([]);
    expect(checks.every(c => c.status === 'never')).toBe(true);
  });

  it('reports error when the last run recorded one, even if recent', async () => {
    const checks = await evaluate([
      { sync_type: 'health_check', updated_at: ageHours(0), last_result: { error: 'boom' } },
    ]);
    expect(checks.find(c => c.syncType === 'health_check')?.status).toBe('error');
  });
});
