import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { postInvoices } from '@/lib/books/invoice-posting';

export const dynamic = 'force-dynamic';
// 300 is the platform backstop; the run's own budget is 240 s below, so a
// :48 start is done by :52.
export const maxDuration = 300;

const BUDGET_MS = 240_000;

/**
 * GET /api/cron/books-invoice-posting — :48 on odd UTC hours.
 *
 * Posts NetSuite's invoices, credit memos, customer payments and customer
 * deposits with their applications to FleetSuite's own books with their
 * rules, replacing an entry when NetSuite changes the document and reversing
 * it when NetSuite voids or deletes it (src/lib/books/invoice-posting.ts,
 * docs/books.md). Minute 48 is free in vercel.json and
 * .github/workflows/cron-fallback.yml, and odd hours put it after the
 * NetSuite GL copy (:26, done by :30), the deposits copy (:16 on odd hours)
 * and the ledger mirror's invoices and payments (:35 on even hours) it
 * reads, apart from netsuite-sync (:52 on even hours).
 *
 * The books are visible only to the owner, so this response says only how
 * the run went; Invoices vs NetSuite shows the rest. Manual triggering is
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

  try {
    const result = await postInvoices(createServiceClient(), { deadline: Date.now() + BUDGET_MS });
    const booksInvoices = result.error ? 'failed' : result.skipped ? 'skipped' : result.partial ? 'partial' : 'ok';
    return NextResponse.json({ booksInvoices });
  } catch (e: any) {
    // postInvoices records its own outcome; this is the last resort for a thrown bug.
    console.error('[books] invoice posting threw:', e?.message || e);
    return NextResponse.json({ booksInvoices: 'failed' }, { status: 500 });
  }
}
