import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { copyNetSuiteGl } from '@/lib/books/netsuite-gl';

export const dynamic = 'force-dynamic';
// 300 is the platform backstop; the copy's own budget is 240 s below, so a
// :26 start is done by :30.
export const maxDuration = 300;

const BUDGET_MS = 240_000;

/**
 * GET /api/cron/books-netsuite-gl — :26 on odd UTC hours.
 *
 * Copies NetSuite's general ledger from 2025 into FleetSuite's books and
 * checks it month by month against NetSuite's own totals
 * (src/lib/books/netsuite-gl.ts, docs/books.md). Minute 26 is free in
 * vercel.json, and odd hours keep it apart from the even-hour NetSuite jobs
 * (the ledger mirror at :35, netsuite-sync at :52).
 *
 * The books are visible only to the owner, so this response says only how
 * the run went; the trial balance page shows the rest. Manual triggering is
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
    const result = await copyNetSuiteGl(createServiceClient(), { deadline: startedAt + BUDGET_MS });
    const booksGl = result.error ? 'failed' : result.skipped ? 'skipped' : result.partial ? 'partial' : 'ok';
    return NextResponse.json({ booksGl });
  } catch (e: any) {
    // copyNetSuiteGl records its own outcome; this is the last resort for a thrown bug.
    console.error('[books] NetSuite GL copy threw:', e?.message || e);
    return NextResponse.json({ booksGl: 'failed' }, { status: 500 });
  }
}
