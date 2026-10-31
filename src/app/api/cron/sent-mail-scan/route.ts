import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { scanSentMail } from '@/lib/sent-mail-scan';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET /api/cron/sent-mail-scan
 *
 * Every two hours: read the watched BMG mailboxes' Sent folders for
 * documents emailed by hand and show them on each document's Sent box
 * (src/lib/sent-mail-scan.ts). Read-only; sends nothing, alerts no one.
 * An admin can run it by hand with ?days=N (up to 120) to look further back.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }
  const days = Number(new URL(req.url).searchParams.get('days')) || 2;

  try {
    const result = await scanSentMail(createServiceClient(), { days });
    return NextResponse.json({ status: 'ok', ...result });
  } catch (err: any) {
    console.error('[cron] Sent mail scan error:', err.message);
    return NextResponse.json({ status: 'error', error: err.message }, { status: 500 });
  }
}
