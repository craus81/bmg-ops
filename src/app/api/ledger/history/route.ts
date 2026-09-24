import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireMoney } from '@/lib/api-auth';
import { HISTORY_DOC_TYPES, HISTORY_MIN_QUERY, historySearchTerms, listHistory, type HistoryDocType } from '@/lib/ledger/history';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/ledger/history?customerId=&q=&types=invoice,estimate&limit=&offset=
 *
 * QuickBooks sales history from before the cutover, for the lists that merge
 * it in (a customer's Transactions, the Invoices search). The rules for what
 * is returned live in src/lib/ledger/history.ts. Behind the money wall rather
 * than the ledger-reader tier: finding a past build is an estimator's job
 * (owner decision 2026-09-24), while bills, payments and reports stay with
 * the ledger readers.
 *
 * Needs a customer or a search: an unscoped page of 11,000 invoices is
 * nobody's question.
 */
export async function GET(req: NextRequest) {
  const auth = await requireMoney(req);
  if (auth.error) return auth.error;

  const sp = req.nextUrl.searchParams;
  const customerId = (sp.get('customerId') || '').trim() || null;
  if (customerId && !UUID_RE.test(customerId)) return NextResponse.json({ error: 'Bad customerId' }, { status: 400 });

  const q = (sp.get('q') || '').trim();
  const terms = historySearchTerms(q);
  if (!customerId && terms.join(' ').length < HISTORY_MIN_QUERY) {
    return NextResponse.json({ error: `Give a customer or at least ${HISTORY_MIN_QUERY} characters to search` }, { status: 400 });
  }

  const types = (sp.get('types') || '')
    .split(',').map(t => t.trim())
    .filter((t): t is HistoryDocType => (HISTORY_DOC_TYPES as readonly string[]).includes(t));

  try {
    const result = await listHistory(createServiceClient(), {
      customerId,
      q,
      types,
      limit: Number(sp.get('limit')) || 50,
      offset: Number(sp.get('offset')) || 0,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    console.error('ledger history list failed:', err);
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
