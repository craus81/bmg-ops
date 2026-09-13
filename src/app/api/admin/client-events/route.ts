import { NextRequest, NextResponse } from 'next/server';
import { z, validateSearchParams } from '@/lib/validate';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { buildUsageReport, type ClientEventRow } from '@/lib/client-events-report';
import { CLIENT_EVENT_KINDS } from '@/lib/usage-telemetry-sanitize';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/admin/client-events — the Usage tab on System Health (R7-4).
 *
 * Same audience as /api/system-health/connections (feature system_health).
 * Reads a BOUNDED window of client_events (default 7 days, max 30) with an
 * explicit .range() loop and a hard row cap; when the cap is hit the
 * response says truncated=true and the panel shows the caveat — totals are
 * then lower bounds, never presented as complete. A failed read is a 500
 * with an error string, and the panel renders "unknown", never zeros.
 */

const MAX_ROWS = 50_000;
const PAGE_SIZE = 1000;
const MAX_DAYS = 30;

const QuerySchema = z.object({
  days: z.string().regex(/^\d{1,2}$/).optional(),
  kind: z.enum(CLIENT_EVENT_KINDS).optional(),
  page: z.string().max(200).optional(),
  form: z.string().max(60).optional(),
});

const service = createServiceClient();

export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'system_health');
  if (auth.error) return auth.error;

  const q = validateSearchParams(req, QuerySchema);
  if (q.error) return q.error;
  const days = Math.min(MAX_DAYS, Math.max(1, Number(q.data.days || 7)));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const rows: ClientEventRow[] = [];
  let truncated = false;
  try {
    // Newest first with a unique tiebreaker (both descending, so the
    // (created_at, id) index is walked backwards without a sort), so a
    // truncated read is "the most recent N" and page boundaries can't skip
    // or duplicate rows. The final page asks for ONE row past the cap:
    // truncated is set only when that row exists, so a window holding
    // exactly MAX_ROWS is reported complete.
    for (let from = 0; ; from += PAGE_SIZE) {
      const want = Math.min(PAGE_SIZE, MAX_ROWS - rows.length + 1);
      let query = service
        .from('client_events')
        .select('id, kind, page, form_id, detail, role, session_id, created_at')
        .gte('created_at', cutoff)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + want - 1);
      if (q.data.kind) query = query.eq('kind', q.data.kind);
      if (q.data.page) query = query.eq('page', q.data.page);
      if (q.data.form) query = query.eq('form_id', q.data.form);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const batch = (data || []) as ClientEventRow[];
      if (rows.length + batch.length > MAX_ROWS) {
        rows.push(...batch.slice(0, MAX_ROWS - rows.length));
        truncated = true;
        break;
      }
      rows.push(...batch);
      if (batch.length < want) break;
    }
  } catch (e: any) {
    return NextResponse.json({ error: `client_events read failed: ${e?.message || 'unknown'}` }, { status: 500 });
  }

  // Last event ever (not just in the window) — the difference between
  // "quiet week" and "beacons never arrive".
  let lastEventAt: string | null = null;
  let lastEventKnown = true;
  try {
    const { data, error } = await service
      .from('client_events')
      .select('created_at')
      .order('created_at', { ascending: false })
      .order('id')
      .limit(1)
      .maybeSingle();
    if (error) lastEventKnown = false;
    else lastEventAt = data?.created_at ?? null;
  } catch {
    lastEventKnown = false;
  }

  const report = buildUsageReport(rows);
  const caveats = [
    'Page timings are sampled (1 in 4 loads; slow loads always) — sample counts are weighted, and percentiles need at least 5 weighted samples.',
    'Beacons can be lost: ad-blockers, offline tablets, a killed app before pagehide, and rate limiting all produce silence. Every count here is a lower bound.',
    'Form counts are three independent tallies of distinct attempts (started / submitted / abandoned) — they are not expected to add up.',
    `Rows older than 30 days are purged nightly; this view covers the last ${days} day${days === 1 ? '' : 's'}.`,
  ];
  if (truncated) caveats.unshift(`Only the most recent ${MAX_ROWS.toLocaleString()} events in the window were read — totals are lower bounds.`);

  return NextResponse.json({
    days,
    filters: { kind: q.data.kind ?? null, page: q.data.page ?? null, form: q.data.form ?? null },
    telemetryEnabled: process.env.NEXT_PUBLIC_TELEMETRY !== 'off',
    lastEventAt,
    lastEventKnown,
    rowsRead: rows.length,
    truncated,
    maxRows: MAX_ROWS,
    caveats,
    ...report,
    generatedAt: new Date().toISOString(),
  });
}
