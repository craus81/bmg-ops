import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { runInvoicePdfs } from '@/lib/books/invoice-pdfs';

export const dynamic = 'force-dynamic';
// 300 is the platform backstop; the run's own budget is 240 s below, so a
// :56 start is done by :00.
export const maxDuration = 300;

const BUDGET_MS = 240_000;

/**
 * GET /api/cron/books-invoice-pdfs — :56 on odd UTC hours.
 *
 * While Invoice PDFs is switched on, attaches FleetSuite's own PDF of each
 * invoice it made since to NetSuite's invoice once FleetSuite's copy matches
 * it, and holds back the rest saying why (src/lib/books/invoice-pdfs.ts,
 * docs/books.md "Invoice PDFs"). Switched off, it reads the switch and
 * nothing else. Minute 56 is free in vercel.json and
 * .github/workflows/cron-fallback.yml, and odd hours put it after the
 * ledger mirror's invoices (:35 on even hours), the copy of NetSuite's
 * general ledger (:26) and the invoice posting run (:48 on odd hours) the
 * check against NetSuite's invoice reads.
 *
 * The books are visible only to whoever opens them, so this response says
 * only how the run went; each invoice's page in Books → Own invoices shows
 * the rest. Manual triggering is super admin only for the same reason.
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
    const result = await runInvoicePdfs(createServiceClient(), { deadline: Date.now() + BUDGET_MS });
    const booksInvoicePdfs = result.skipped
      ? 'off'
      : result.blocked
        ? 'blocked'
        : result.error
          ? 'failed'
          : result.left || result.more
            ? 'partial'
            : 'ok';
    return NextResponse.json({ booksInvoicePdfs });
  } catch (e: any) {
    // runInvoicePdfs records its own outcome; this is the last resort for a thrown bug.
    console.error('[books] invoice PDFs threw:', e?.message || e);
    return NextResponse.json({ booksInvoicePdfs: 'failed' }, { status: 500 });
  }
}
