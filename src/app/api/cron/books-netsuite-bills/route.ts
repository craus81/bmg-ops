import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { copyNetSuiteBills } from '@/lib/books/netsuite-bills';

export const dynamic = 'force-dynamic';
// 300 is the platform backstop; the copy's own budget is 240 s below, so a
// :39 start is done by :43, before the posting run at :48.
export const maxDuration = 300;

const BUDGET_MS = 240_000;

/**
 * GET /api/cron/books-netsuite-bills — :39 on odd UTC hours.
 *
 * Copies NetSuite's vendor bills and bill credits, with their lines, into
 * FleetSuite's books for the bill rule's check
 * (src/lib/books/netsuite-bills.ts, docs/books.md "Vendor bills"). Minute
 * 39 is free in vercel.json, and odd hours keep it apart from the even-hour
 * NetSuite jobs (the ledger mirror at :35, netsuite-sync at :52).
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
    const result = await copyNetSuiteBills(createServiceClient(), { deadline: startedAt + BUDGET_MS });
    const booksBills = result.error ? 'failed' : result.partial ? 'partial' : 'ok';
    return NextResponse.json({ booksBills });
  } catch (e: any) {
    // copyNetSuiteBills records its own outcome; this is the last resort for a thrown bug.
    console.error('[books] NetSuite bills copy threw:', e?.message || e);
    return NextResponse.json({ booksBills: 'failed' }, { status: 500 });
  }
}
