import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { runLedgerQboSync, SYNC_SOFT_BUDGET_MS } from '@/lib/quickbooks/sync';

export const dynamic = 'force-dynamic';
// 300 is the platform backstop; the job's OWN soft deadline is 150 s
// (SYNC_SOFT_BUDGET_MS), so a 09:57 start finishes by 09:59:30 — clear of
// 10:00 and of calendar-pull at 10:02. A CDC day is small; anything left
// over answers partial and drains on the next run.
export const maxDuration = 300;

/**
 * GET /api/cron/ledger-qbo-sync — 09:57 UTC daily.
 *
 * Minute 57 is free in both vercel.json and cron-fallback.yml, and nothing
 * else uses the 09:00 hour. Two crons in the same minute is a real
 * production incident here (CLAUDE.md), not tidiness.
 *
 * The job does two things, and the FIRST one matters from day one: it
 * renews the QuickBooks refresh token every day, so the 100-day idle expiry
 * never approaches even while the bulk import is still being planned. Only
 * then does it sweep changes — and only once a bulk import has completed.
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

  const startedAt = Date.now();
  try {
    const result = await runLedgerQboSync(createServiceClient(), {
      startedAt,
      deadline: startedAt + SYNC_SOFT_BUDGET_MS,
    });
    return NextResponse.json({ ...result.payload, status: result.status });
  } catch (e: any) {
    // The heartbeat is written inside runLedgerQboSync for every outcome it
    // can name; this is the last resort for a thrown bug.
    console.error('[ledger] QuickBooks daily sync threw:', e?.message || e);
    return NextResponse.json({ error: String(e?.message || e).slice(0, 500) }, { status: 500 });
  }
}
