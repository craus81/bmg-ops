import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { recordHeartbeat } from '@/lib/system-health';
import { collectExecMetrics, chicagoDay } from '@/lib/exec-metrics';
import { writeArSnapshots } from '@/lib/ar-snapshots';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Nightly executive metric snapshots (R4-1, migration 270). Runs at
 * 04:30 UTC — 23:30 CDT / 22:30 CST, the end of the same Chicago business
 * day the row is stamped with — and upserts one row per metric per day, so
 * a manual re-run (or the GitHub fallback scheduler double-firing) simply
 * overwrites that day's numbers. Metrics whose source errored are recorded
 * as value NULL with the error in meta — never 0 — so trend charts can
 * skip bad days instead of charting them as crashes.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  if (!secret || authHeader !== `Bearer ${secret}`) {
    const admin = await requireAdmin(req);
    if (admin.error) return admin.error;
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  try {
    const day = chicagoDay();
    const metrics = await collectExecMetrics(supabase);
    const rows = metrics.map(m => ({
      metric: m.metric,
      day,
      value: m.value,
      meta: m.meta ?? null,
    }));
    const { error } = await supabase
      .from('metric_snapshots')
      .upsert(rows, { onConflict: 'metric,day' });
    if (error) throw new Error(error.message);

    // A/R snapshots ride the same nightly slot (R5-1): open total, aging
    // buckets, top open customers — its own try/catch so an AR read failure
    // never costs the exec metrics above (and vice versa: they upserted first).
    let arSnapshot: { rows: number; total: number } | { error: string };
    try {
      arSnapshot = await writeArSnapshots(supabase, day);
    } catch (e: any) {
      arSnapshot = { error: String(e?.message || e).slice(0, 300) };
      console.error('ar_snapshots write failed:', e);
    }

    const nulls = metrics.filter(m => m.value === null).map(m => m.metric);
    const syncStateWrite = await recordHeartbeat(supabase, 'metric_snapshots', {
      day,
      wrote: rows.length,
      nullMetrics: nulls,
      arSnapshot,
    });
    return NextResponse.json({ success: true, day, wrote: rows.length, nullMetrics: nulls, arSnapshot, syncStateWrite });
  } catch (err: any) {
    console.error('metric-snapshots failed:', err);
    await recordHeartbeat(supabase, 'metric_snapshots', { error: String(err?.message || err).slice(0, 300) }).catch(() => {});
    return NextResponse.json({ error: err?.message || 'Snapshot failed' }, { status: 500 });
  }
}
