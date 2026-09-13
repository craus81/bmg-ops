import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { recordHeartbeat } from '@/lib/system-health';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Nightly client_events retention (R7-4): delete usage-telemetry rows older
 * than 30 days, plus the rate-limit rows the beacon route writes to
 * approval_rate_limits (action 'client_events…', kept 2 days — that table
 * had no purge at all). Scheduled 04:41 UTC (vercel.json; minute 41 is
 * unused, never :00).
 *
 * Deletes in bounded chunks — up to CHUNK ids per statement, at most
 * MAX_LOOPS statements per table — so one backlog can't blow the 60 s
 * budget; whatever is left is picked up the next night. Heartbeats on both
 * paths so a silent failure goes stale on System Health.
 */

const RETENTION_DAYS = 30;
const RATE_LIMIT_RETENTION_DAYS = 2;
const CHUNK = 5_000;
const MAX_LOOPS = 20;

const service = createServiceClient();

/**
 * Delete rows matching `filter` in id chunks. Returns how many went and
 * whether the loop cap was hit (a partial purge is reported, not hidden).
 */
async function purgeChunked(
  table: string,
  select: (q: any) => any,
): Promise<{ deleted: number; capped: boolean }> {
  let deleted = 0;
  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    const { data: ids, error: selErr } = await select(service.from(table).select('id')).limit(CHUNK);
    if (selErr) throw new Error(`${table} select: ${selErr.message}`);
    const list = (ids || []).map((r: { id: string }) => r.id);
    if (list.length === 0) return { deleted, capped: false };
    const { error: delErr } = await service.from(table).delete().in('id', list);
    if (delErr) throw new Error(`${table} delete: ${delErr.message}`);
    deleted += list.length;
    if (list.length < CHUNK) return { deleted, capped: false };
  }
  return { deleted, capped: true };
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  const startedAt = Date.now();
  const cutoff = new Date(startedAt - RETENTION_DAYS * 86_400_000).toISOString();
  const rateCutoff = new Date(startedAt - RATE_LIMIT_RETENTION_DAYS * 86_400_000).toISOString();

  try {
    const events = await purgeChunked('client_events', q =>
      q.lt('created_at', cutoff).order('created_at').order('id'));
    const rateRows = await purgeChunked('approval_rate_limits', q =>
      q.like('action', 'client_events%').lt('attempted_at', rateCutoff).order('attempted_at').order('id'));

    const result = {
      deleted: events.deleted,
      rateLimitRowsDeleted: rateRows.deleted,
      capped: events.capped || rateRows.capped,
      cutoff,
      rateCutoff,
    };
    await recordHeartbeat(service, 'client_events_purge', result, { startedAt, records: events.deleted });
    return NextResponse.json({ success: true, ...result });
  } catch (e: any) {
    const message = e?.message || 'unknown';
    console.error('[client-events-purge] failed:', message);
    await recordHeartbeat(service, 'client_events_purge', { error: message }, { startedAt });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
