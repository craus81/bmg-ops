import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { syncPartsIncremental } from '@/lib/parts-sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET /api/cron/parts-sync
 *
 * Hourly incremental parts-catalog sync from NetSuite (K11) — only items
 * whose lastmodifieddate moved since the last successful run. The manual
 * full rebuild stays on POST /api/parts/sync (Parts page button); the
 * 2-hour inventory sweep in /api/cron/netsuite-sync remains the freshness
 * authority for quantities.
 *
 * Also logs to parts_sync_log so the Parts page's "last synced" chip
 * reflects the cron, not just the last time someone clicked the button.
 */
export async function GET(req: NextRequest) {
  // Allow Vercel Cron with the shared secret; anyone else needs an admin
  // session (manual trigger from the app). Fails closed if CRON_SECRET is
  // not configured.
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  const supabase = createServiceClient();

  const { data: logEntry } = await supabase
    .from('parts_sync_log')
    .insert({ triggered_by: null, status: 'running' })
    .select()
    .single();
  const logId = logEntry?.id;

  try {
    const result = await syncPartsIncremental(supabase);

    if (logId) {
      await supabase.from('parts_sync_log').update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        parts_synced: result.upserted,
      }).eq('id', logId);
    }

    return NextResponse.json({ status: 'ok', ...result });
  } catch (err: any) {
    console.error('[cron] Parts sync error:', err.message);
    if (logId) {
      await supabase.from('parts_sync_log').update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: err.message,
      }).eq('id', logId);
    }
    return NextResponse.json({ status: 'error', error: err.message }, { status: 500 });
  }
}
