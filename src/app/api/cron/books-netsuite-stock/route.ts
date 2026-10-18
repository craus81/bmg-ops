import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { copyNetSuiteStock } from '@/lib/books/netsuite-stock';

export const dynamic = 'force-dynamic';
// 300 is the platform backstop; the copy's own budget is 240 s below, so a
// :43 start is done by :47, before the posting run at :48.
export const maxDuration = 300;

const BUDGET_MS = 240_000;

/**
 * GET /api/cron/books-netsuite-stock — :43 on odd UTC hours.
 *
 * Copies NetSuite's stock moves, then reads NetSuite's own count of each
 * item, for Stock by item (src/lib/books/netsuite-stock.ts, docs/books.md
 * "Stock by item"). Minute 43 is free in vercel.json, after the bills copy
 * at :39, and the 09:43 and 13:43 runs come just before the daily check's
 * looks at :58.
 *
 * The books are visible only to the owner, so this response says only how
 * the run went; the Stock by item page shows the rest. Manual triggering is
 * super admin only for the same reason.
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

  const startedAt = Date.now();
  try {
    const result = await copyNetSuiteStock(createServiceClient(), { deadline: startedAt + BUDGET_MS });
    const booksStock = result.error ? 'failed' : result.partial ? 'partial' : 'ok';
    return NextResponse.json({ booksStock });
  } catch (e: any) {
    // copyNetSuiteStock records its own outcome; this is the last resort for a thrown bug.
    console.error('[books] NetSuite stock copy threw:', e?.message || e);
    return NextResponse.json({ booksStock: 'failed' }, { status: 500 });
  }
}
