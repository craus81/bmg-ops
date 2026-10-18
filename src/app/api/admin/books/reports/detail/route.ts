import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { COPY_FROM, monthsBetween, toCents } from '@/lib/books/netsuite-gl';
import { loadReports, monthParam } from '@/lib/books/report-data';
import { detailDocuments, type AccountDocumentsData } from '@/lib/books/report-detail';
import { lineSpan, REPORT_KINDS, type ReportKind } from '@/lib/books/reports';

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
 * src/lib/books/reports.ts). `account` is the line's key: the account's
 * NetSuite id, or fs:<id> for one NetSuite doesn't have.
 *
 * Super admin only, as the rest of the books (docs/books.md "Report detail").
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  const loaded = await loadReports(service, params.get('company'));
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });
  const { data, company, through } = loaded;

  // A line's account is in the chart, or is a NetSuite account either side has amounts on.
  const key = params.get('account') ?? '';
  const account = data.accounts.find((a) => (a.netsuite_account_id ?? `fs:${a.id}`) === key) ?? null;
  const known = !!account
    || [...data.opening, ...data.netsuite].some((r) => r.netsuite_account_id === key)
    || data.fleetsuite.some((r) => r.account === key);
  if (!known) return NextResponse.json({ error: 'That account has nothing in these books' }, { status: 404 });

  const askedKind = params.get('report');
  const kind: ReportKind = REPORT_KINDS.find((k) => k === askedKind) ?? 'profit_and_loss';
  const to = monthParam(params.get('to'), through) ?? loaded.lastMonth;
  const askedFrom = monthParam(params.get('from'), through);
  const from = askedFrom && askedFrom <= to ? askedFrom : to;
  const differs = params.get('only') === 'differs';

  const span = lineSpan(data, kind, key, { from, to });
  const docs = await service.rpc('gl_books_account_documents', {
    p_company: company, p_account: key, p_from: from, p_to: to, p_differs: differs, p_limit: SHOWN,
  });
  if (docs.error) return NextResponse.json({ error: docs.error.message }, { status: 500 });
  const found = docs.data as AccountDocumentsData;
  // What the copy of NetSuite's ledger holds of the account, against what NetSuite's own totals say moved.
  const copied = span.sign * toCents(found.netsuite) || 0;

  return NextResponse.json({
    companies: loaded.companies.map((c) => ({ code: c.code, name: c.name })),
    company,
    report: kind,
    account: { key, number: account?.number ?? null, name: account?.name ?? `NetSuite account ${key}`, inChart: !!account },
    from,
    to,
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
