import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { COPY_FROM, monthsBetween } from '@/lib/books/netsuite-gl';
import { loadAccountDetail, loadReports } from '@/lib/books/report-data';
import { detailDocuments } from '@/lib/books/report-detail';

export const dynamic = 'force-dynamic';

/** The most documents the page lists at once. */
const SHOWN = 1000;

/**
 * GET /api/admin/books/reports/detail?company=BMG&account=123&report=balance_sheet&from=2026-09&to=2026-09&only=differs
 * — what one account's line on a report is made of over the months from
 * `from` through `to` (`to` alone by default, last month by default): every
 * document that moved the account, FleetSuite's journal next to the copy of
 * NetSuite's general ledger (migration 400), only those that differ with
 * only=differs, and for a balance sheet account its balance at both ends.
 * Amounts are whole cents as `report` shows the line (lineSpan in
 * src/lib/books/reports.ts, read by loadAccountDetail). `account` is the
 * line's key: the account's NetSuite id, or fs:<id> for one NetSuite doesn't
 * have.
 *
 * Super admins, the bookkeeper and the CPA, as the rest of the books
 * (docs/books.md "Report detail").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  const loaded = await loadReports(service, params.get('company'));
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });
  const { company, through } = loaded;
  const differs = params.get('only') === 'differs';
  const detail = await loadAccountDetail(service, loaded, params, { differs, limit: SHOWN });
  if ('error' in detail) return NextResponse.json({ error: detail.error }, { status: detail.status });
  const { span, found, copied } = detail;

  return NextResponse.json({
    companies: loaded.companies.map((c) => ({ code: c.code, name: c.name })),
    company,
    report: detail.kind,
    account: detail.account,
    from: detail.from,
    to: detail.to,
    months: monthsBetween(COPY_FROM, through),
    ...span,
    documents: found.documents,
    differing: found.differing,
    only: differs ? 'differs' : 'all',
    rows: detailDocuments(found, span.sign),
    copyHolds: copied === span.moved.netsuite,
    copied,
    lastPosting: loaded.lastPosting,
  });
}
