import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { POSTING_COMPANIES } from '@/lib/books/invoice-posting';
import { COPY_FROM, monthsBetween } from '@/lib/books/netsuite-gl';
import { buildReport } from '@/lib/books/report-builder';
import { builderAsk, loadBuilder } from '@/lib/books/report-data';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/books/reports/builder?company=BMG&by=division&from=2026-01&to=2026-09&division=graphics&location=3
 * — one company's profit and loss from FleetSuite's own books for the
 * months from `from` (January of `to`'s year by default) through `to` (last
 * month by default), a column for each month, quarter, year, division or
 * location (by=month, quarter, year, division or location; by=total for the
 * months altogether; division by default) and a Total, only one division's
 * or one location's lines when asked (src/lib/books/report-builder.ts,
 * migration 500, docs/books.md "Report builder"), with the months there are
 * to pick from.
 *
 * Super admins, the bookkeeper and the CPA (docs/books.md "Who can open the
 * books").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const loaded = await loadBuilder(createServiceClient(), params.get('company'));
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });
  const ask = builderAsk(params, loaded);

  return NextResponse.json({
    companies: loaded.companies,
    company: loaded.company,
    // A company that doesn't post has nothing on FleetSuite's side.
    posts: (POSTING_COMPANIES as readonly string[]).includes(loaded.company),
    months: monthsBetween(COPY_FROM, loaded.through),
    from: ask.from,
    to: ask.to,
    by: ask.by,
    ...buildReport(loaded.data, loaded.split, loaded.locationNames, ask),
    // A location comes from the copy of NetSuite's ledger, read with NetSuite's totals.
    copied: loaded.data.opening.length > 0 || loaded.data.netsuite.length > 0,
    lastPosting: loaded.lastPosting,
    lastCopy: loaded.lastCopy,
  });
}
