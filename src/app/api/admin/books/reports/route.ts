import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { POSTING_COMPANIES } from '@/lib/books/invoice-posting';
import { loadReports, reportRange } from '@/lib/books/report-data';
import { report, reportMonths } from '@/lib/books/reports';

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
 * Super admins, the bookkeeper and the CPA (docs/books.md "Who can open the
 * books").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const loaded = await loadReports(createServiceClient(), params.get('company'));
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });
  const { data, company, through } = loaded;
  const { kind, from, to } = reportRange(params, loaded);

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
