import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { copyNetSuiteDeposits } from '@/lib/books/netsuite-deposits';

export const dynamic = 'force-dynamic';
// 300 is the platform backstop; the copy's own budget is 240 s below, so a
// :16 start is done by :20, before the GL copy at :26.
export const maxDuration = 300;

const BUDGET_MS = 240_000;

/**
 * GET /api/cron/books-netsuite-deposits — :16 on odd UTC hours.
 *
 * Copies NetSuite's customer deposits and deposit applications into
 * FleetSuite's books for the deposit rule's check
 * (src/lib/books/netsuite-deposits.ts, docs/books.md "Customer deposits").
 * Minute 16 is free in vercel.json, and odd hours keep it apart from the
 * even-hour NetSuite jobs (the ledger mirror at :35, netsuite-sync at :52).
 *
 * The books are visible only to the owner, so this response says only how
 * the run went; the invoices page shows the rest. Manual triggering is
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
    const result = await copyNetSuiteDeposits(createServiceClient(), { deadline: startedAt + BUDGET_MS });
    const booksDeposits = result.error ? 'failed' : result.partial ? 'partial' : 'ok';
    return NextResponse.json({ booksDeposits });
  } catch (e: any) {
    // copyNetSuiteDeposits records its own outcome; this is the last resort for a thrown bug.
    console.error('[books] NetSuite deposits copy threw:', e?.message || e);
    return NextResponse.json({ booksDeposits: 'failed' }, { status: 500 });
  }
}
