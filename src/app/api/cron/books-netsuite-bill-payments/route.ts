import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { copyNetSuiteBillPayments } from '@/lib/books/netsuite-bill-payments';

export const dynamic = 'force-dynamic';
// 300 is the platform backstop; the copy's own budget is 240 s below, so a
// :21 start is done by :25, before the GL copy at :26.
export const maxDuration = 300;

const BUDGET_MS = 240_000;

/**
 * GET /api/cron/books-netsuite-bill-payments — :21 on odd UTC hours.
 *
 * Copies NetSuite's bill payments, with the bills each one paid, into
 * FleetSuite's books for the bill payment rule's check
 * (src/lib/books/netsuite-bill-payments.ts, docs/books.md "Bill payments").
 * Minute 21 is free in vercel.json, and odd hours keep it apart from the
 * even-hour NetSuite jobs (the ledger mirror at :35, netsuite-sync at :52);
 * it runs after the deposits copy (:16, done by :20) and before the GL copy.
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
    const result = await copyNetSuiteBillPayments(createServiceClient(), { deadline: startedAt + BUDGET_MS });
    const booksBillPayments = result.error ? 'failed' : result.partial ? 'partial' : 'ok';
    return NextResponse.json({ booksBillPayments });
  } catch (e: any) {
    // copyNetSuiteBillPayments records its own outcome; this is the last resort for a thrown bug.
    console.error('[books] NetSuite bill payments copy threw:', e?.message || e);
    return NextResponse.json({ booksBillPayments: 'failed' }, { status: 500 });
  }
}
