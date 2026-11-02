import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { runRestoreDrill } from '@/lib/books/restore-drill';

export const dynamic = 'force-dynamic';
// 300 is the platform backstop; the drill's own budget is 270 s below, so it
// fails saying where it got to rather than being cut off.
export const maxDuration = 300;

const BUDGET_MS = 270_000;

/**
 * GET /api/cron/books-restore-drill — 08:51 UTC every night, 2:51 AM Central
 * (3:51 in summer time), forty minutes after the nightly backup.
 *
 * Restores the newest good backup of FleetSuite's books into a scratch
 * database made from FleetSuite's own migrations, in the server's memory, and
 * checks the books came back whole (src/lib/books/restore-drill.ts,
 * docs/books.md "The restore drill"). A backup that has already passed one is
 * left alone; one that failed is tried again. It reads BMG's file storage and
 * writes only its own record, never the books, so it needs no switch. Minute
 * 51 is free in vercel.json and .github/workflows/cron-fallback.yml, and
 * 08:51 is before the daily check's first look (09:58), which tells the super
 * admins about a drill that failed or a good backup that went without one.
 *
 * The response says only how it went; Books → Backups shows the rest. Manual
 * triggering is super admin only, as Test restore now is.
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
    const result = await runRestoreDrill(createServiceClient(), { how: 'nightly', deadline: Date.now() + BUDGET_MS });
    return NextResponse.json({ booksRestoreDrill: result.state });
  } catch (e: any) {
    // runRestoreDrill records its own outcome; this is the last resort for a thrown bug.
    console.error('[books] restore drill threw:', e?.message || e);
    return NextResponse.json({ booksRestoreDrill: 'failed' }, { status: 500 });
  }
}
