import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { runMistakeChecks } from '@/lib/books/mistake-checks';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * GET /api/cron/books-mistake-checks — 09:46 UTC.
 *
 * Looks through the copies of NetSuite's bills, checks and card charges for
 * likely mistakes and keeps what it finds for Books → Mistake checks
 * (src/lib/books/mistake-checks.ts, docs/books.md "Mistake checks"). Minute
 * 46 is free in vercel.json, and the run comes after the copies of NetSuite's
 * checks and card charges (:33 on odd hours) and bills (:39), and before the
 * daily check (:58), which tells the super admins about new ones.
 *
 * The books are visible only to super admins, so this response says only how
 * the look went, and manual triggering is super admin only too.
 */
export async function GET(req: NextRequest) {
  // Vercel Cron with the shared secret; anyone else must be a super admin.
  // Fails closed if CRON_SECRET is not configured.
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireSuperAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    const result = await runMistakeChecks(createServiceClient());
    return NextResponse.json({ booksMistakeChecks: result.error ? 'failed' : 'ok', found: result.found, added: result.added });
  } catch (e: any) {
    // The look records its own outcome; this is the last resort for a thrown bug.
    console.error('[books] mistake checks threw:', e?.message || e);
    return NextResponse.json({ booksMistakeChecks: 'failed' }, { status: 500 });
  }
}
