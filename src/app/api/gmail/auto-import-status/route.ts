import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Reports whether Gmail is connected and the last result of the
// gmail_auto_import cron, so /admin/pos can show why POs aren't (or are)
// landing without making the user dig through Vercel logs.
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  // Field evidence: this route's reads served a sync_state timestamp that
  // stayed frozen for days while writes verifiably landed (the auto-import
  // route's own read-back saw fresh data). Next patches global fetch with
  // its Data Cache, and a cached PostgREST GET makes this status endpoint
  // lie forever — so force every Supabase call from this route to skip
  // caching entirely.
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { global: { fetch: (input: any, init?: any) => fetch(input, { ...init, cache: 'no-store' }) } }
  );

  const [{ data: tokenRow }, { data: stateRow }, { data: errorRows }] = await Promise.all([
    supabase
      .from('google_tokens')
      .select('id, expiry_date, updated_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('sync_state')
      .select('last_synced_at, last_result, updated_at')
      .eq('sync_type', 'gmail_auto_import')
      .maybeSingle(),
    // Surface the most recent per-message failures so the UI can show
    // why imports are erroring, not just the aggregate count.
    supabase
      .from('gmail_po_imports')
      .select('message_id, subject, from_email, received_at, error_message, attachment_filename, created_at')
      .eq('status', 'error')
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  // When the heartbeat looks stale, the runs may actually be executing
  // fine with only the sync_state WRITE failing (observed in the wild:
  // cron 200s on schedule, timestamp frozen). Probe a write with the same
  // shape recordRun uses and report the database's own error verbatim, so
  // the strip can name the real problem instead of blaming the cron.
  let heartbeatWriteError: string | null = null;
  const lastRun = stateRow?.last_synced_at ? new Date(stateRow.last_synced_at).getTime() : null;
  const staleMs = lastRun === null ? Infinity : Date.now() - lastRun;
  if (staleMs > 60 * 60 * 1000) {
    const { error: probeErr } = await supabase.from('sync_state').upsert({
      sync_type: 'gmail_auto_import_probe',
      last_synced_at: new Date().toISOString(),
      last_result: { status: 'probe' },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'sync_type' });
    if (probeErr) heartbeatWriteError = probeErr.message || JSON.stringify(probeErr);
  }

  return NextResponse.json({
    gmailConnected: !!tokenRow,
    tokenUpdatedAt: tokenRow?.updated_at || null,
    lastRunAt: stateRow?.last_synced_at || null,
    lastResult: stateRow?.last_result || null,
    recentErrors: errorRows || [],
    // Without this env var the auto-import route rejects Vercel's cron
    // requests before they can run or record anything — the exact
    // signature of a silent stall, so let the UI name the cause.
    cronSecretConfigured: !!process.env.CRON_SECRET,
    heartbeatWriteError,
  });
}
