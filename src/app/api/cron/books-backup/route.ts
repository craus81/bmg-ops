import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { runBackup } from '@/lib/books/backups';

export const dynamic = 'force-dynamic';
// 300 is the platform backstop; the run's own budget is 270 s below, so it
// fails saying how far it got rather than being cut off.
export const maxDuration = 300;

const BUDGET_MS = 270_000;

/**
 * GET /api/cron/books-backup — 08:11 UTC every night, 2:11 AM Central
 * (3:11 in summer time).
 *
 * Backs up FleetSuite's books: every table of them as CSV files, the
 * journal as a workbook to read, and a manifest, in one zip under
 * books-backups/ in BMG's private file storage, checked against the books
 * before it's kept (src/lib/books/backups.ts, docs/books.md "Backups").
 * It only reads the books, so it needs no switch. Minute 11 is free in
 * vercel.json and .github/workflows/cron-fallback.yml, 08:11 is after the
 * night's posting runs and before the daily check's first look (09:58),
 * which tells the super admins about a backup that failed or none made in
 * 26 hours.
 *
 * The response says only how the run went; Books → Backups shows the rest.
 * Manual triggering is super admin only, as Back up now is.
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
    const result = await runBackup(createServiceClient(), { how: 'nightly', deadline: Date.now() + BUDGET_MS });
    return NextResponse.json({ booksBackup: result.state });
  } catch (e: any) {
    // runBackup records its own outcome; this is the last resort for a thrown bug.
    console.error('[books] backup threw:', e?.message || e);
    return NextResponse.json({ booksBackup: 'failed' }, { status: 500 });
  }
}
