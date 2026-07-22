import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { scanPartsEmails } from '@/lib/parts-email-scan';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET /api/cron/parts-email-scan
 *
 * Hourly: read the watched BMG mailboxes for vendor order confirmations /
 * ship notices and turn them into parts ETAs on vendor POs + upfit
 * projects. Manual trigger from /admin/parts-mail needs an admin session.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  const supabase = createServiceClient();

  try {
    const result = await scanPartsEmails(supabase);
    return NextResponse.json({ status: 'ok', ...result });
  } catch (err: any) {
    console.error('[cron] Parts email scan error:', err.message);
    return NextResponse.json({ status: 'error', error: err.message }, { status: 500 });
  }
}
