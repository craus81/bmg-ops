import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { POSTING_COMPANIES } from '@/lib/books/invoice-posting';
import { loadReports, monthParam } from '@/lib/books/report-data';
import { report, reportMonths, REPORT_KINDS, type ReportKind } from '@/lib/books/reports';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/books/reports?company=BMG&report=profit_and_loss&from=2026-01&to=2026-09
 * — one company's profit and loss for the months from `from` through `to`
 * (`to` alone by default, last month by default), or its balance sheet or
 * trial balance (report=balance_sheet, trial_balance) at the end of `to`,
 * from FleetSuite's own books, next to NetSuite's own totals
 * (src/lib/books/reports.ts, migration 396), with whether the report for
 * each month alone since January 2025 matches.
 *
 * Super admin only: the books are being built hidden, for the owner, until
 * they're ready (docs/books.md).
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const loaded = await loadReports(createServiceClient(), params.get('company'));
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });
  const { data, company, through } = loaded;

  const askedKind = params.get('report');
  const kind: ReportKind = REPORT_KINDS.find((k) => k === askedKind) ?? 'profit_and_loss';

  // The end defaults to last month, the newest one NetSuite may already have
  // closed, as the trial balance does; the start to the end's month alone.
  const to = monthParam(params.get('to'), through) ?? loaded.lastMonth;
  const askedFrom = monthParam(params.get('from'), through);
  const from = askedFrom && askedFrom <= to ? askedFrom : to;

  return NextResponse.json({
    companies: loaded.companies,
    company,
    // A company that doesn't post has only the starting balances on its side.
    posts: (POSTING_COMPANIES as readonly string[]).includes(company),
    report: kind,
    from,
    to,
    months: reportMonths(data, kind, through),
    ...report(data, kind, { from, to }),
    // Nothing to compare until a copy has read NetSuite's totals.
    checked: data.opening.length > 0 || data.netsuite.length > 0,
    lastPosting: loaded.lastPosting,
    lastCopy: loaded.lastCopy,
  });
}
