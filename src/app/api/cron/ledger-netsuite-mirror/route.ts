import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { runNetSuiteMirror } from '@/lib/ledger/netsuite-mirror';
import { syncBooksAccounts } from '@/lib/books/netsuite-accounts';

export const dynamic = 'force-dynamic';
// 300 is the platform backstop; the job's OWN deadline is 240 s below, so a
// :35 start finishes by :39 — clear of :42 (health check) and nowhere near
// :00, where a cron pile-up once saturated Supabase into 504s.
export const maxDuration = 300;

/** The run's own budget, inside maxDuration. The phase caps sum to 225 s. */
const MIRROR_BUDGET_MS = 240_000;

/**
 * GET /api/cron/ledger-netsuite-mirror — :35 on even UTC hours.
 *
 * Minute 35 is free in both vercel.json and .github/workflows/cron-fallback.yml
 * (CLAUDE.md: two crons in the same minute is a production incident here, not
 * untidiness), and a 240 s window from :35 never reaches :40.
 *
 * The job mirrors NetSuite invoices and credit memos — plus their lines,
 * their PDFs and, when the integration role permits it, customer payments —
 * into the same `ledger_*` tables the QuickBooks history lands in. It is
 * resumable by design: a partial run saves its cursor and the next run
 * continues, so a first pass over years of history drains across many runs
 * while the newest transactions land in the very first one.
 *
 * Before the mirror, the same run copies NetSuite's chart of accounts into
 * FleetSuite's own books (src/lib/books/netsuite-accounts.ts).
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

  const service = createServiceClient();
  const startedAt = Date.now();

  // FleetSuite's own books follow NetSuite's chart of accounts until the
  // changeover (docs/books.md). It goes first because it takes seconds and
  // the mirror below is the job that stops itself on the deadline and
  // resumes. The books are visible only to the owner, so how it went stays
  // on the Books page; this response says only whether it worked.
  let booksAccounts: 'ok' | 'failed' = 'failed';
  try {
    booksAccounts = (await syncBooksAccounts(service)).error ? 'failed' : 'ok';
  } catch (e: any) {
    console.error('[books] NetSuite account sync threw:', e?.message || e);
  }

  try {
    const result = await runNetSuiteMirror(service, {
      deadline: startedAt + MIRROR_BUDGET_MS,
    });
    return NextResponse.json({ ...result, booksAccounts });
  } catch (e: any) {
    // runNetSuiteMirror writes its own heartbeat for every outcome it can
    // name; this is the last resort for a thrown bug.
    console.error('[ledger] NetSuite mirror threw:', e?.message || e);
    return NextResponse.json({ error: String(e?.message || e).slice(0, 500) }, { status: 500 });
  }
}
