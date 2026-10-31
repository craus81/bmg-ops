import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { copyNetSuiteOpenItems } from '@/lib/books/netsuite-open-items';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET /api/cron/books-netsuite-open-items — :29 on odd UTC hours.
 *
 * Copies what NetSuite has open on its invoices, credit memos, bills and
 * bill credits into FleetSuite's books for NetSuite's side of the agings
 * (src/lib/books/netsuite-open-items.ts, docs/books.md "AR and AP agings").
 * Minute 29 is free in vercel.json, and comes just after the copy of
 * NetSuite's general ledger at :26, which the agings put it next to.
 *
 * The books are visible only to the owner, so this response says only how
 * the run went; the agings page shows the rest. Manual triggering is super
 * admin only for the same reason.
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
    const result = await copyNetSuiteOpenItems(createServiceClient());
    return NextResponse.json({ booksOpenItems: result.error ? 'failed' : result.kept ? 'kept' : 'ok' });
  } catch (e: any) {
    // copyNetSuiteOpenItems records its own outcome; this is the last resort for a thrown bug.
    console.error('[books] NetSuite open items copy threw:', e?.message || e);
    return NextResponse.json({ booksOpenItems: 'failed' }, { status: 500 });
  }
}
