import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

// Reports whether Gmail is connected and the last result of the
// gmail_auto_import cron, so /admin/pos can show why POs aren't (or are)
// landing without making the user dig through Vercel logs.
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
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
  });
}
