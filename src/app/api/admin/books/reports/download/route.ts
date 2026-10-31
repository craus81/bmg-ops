import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { attachmentDisposition } from '@/lib/estimate-approval-downloads';
import { POSTING_COMPANIES } from '@/lib/books/invoice-posting';
import { loadReports, reportRange } from '@/lib/books/report-data';
import { report } from '@/lib/books/reports';
import { reportNotes, reportWorkbook } from '@/lib/books/report-workbook';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/books/reports/download?company=BMG&report=profit_and_loss&from=2026-01&to=2026-09
 * — the report /api/admin/books/reports gives for the same company, report
 * and months, as an Excel file: every line, FleetSuite's books next to
 * NetSuite's own totals with the difference, and what the page warns about
 * at the top (src/lib/books/report-workbook.ts, docs/books.md "Excel
 * downloads").
 *
 * Super admin only, as the rest of the books (docs/books.md).
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const loaded = await loadReports(createServiceClient(), params.get('company'));
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });
  const { data } = loaded;
  const { kind, from, to } = reportRange(params, loaded);
  const company = loaded.companies.find((c) => c.code === loaded.company) ?? { code: loaded.company, name: loaded.company, legal_name: null };

  const file = await reportWorkbook({
    company,
    kind,
    from,
    to,
    report: report(data, kind, { from, to }),
    notes: reportNotes({
      companyName: company.name,
      posts: (POSTING_COMPANIES as readonly string[]).includes(loaded.company),
      checked: data.opening.length > 0 || data.netsuite.length > 0,
      lastPosting: loaded.lastPosting,
      lastCopy: loaded.lastCopy,
    }),
    now: new Date(),
  });
  return new NextResponse(file.bytes, {
    headers: {
      'Content-Type': file.type,
      'Content-Length': String(file.bytes.byteLength),
      'Content-Disposition': attachmentDisposition(file.name),
      'Cache-Control': 'private, no-store',
    },
  });
}
