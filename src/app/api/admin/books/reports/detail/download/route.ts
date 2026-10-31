import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { attachmentDisposition } from '@/lib/estimate-approval-downloads';
import { loadAccountDetail, loadReports } from '@/lib/books/report-data';
import { detailDocuments, runningBalances } from '@/lib/books/report-detail';
import { yearClosings } from '@/lib/books/reports';
import { accountWorkbook, detailNotes } from '@/lib/books/report-workbook';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** The most documents one file lists (migration 459). */
const LISTED = 20000;

/**
 * GET /api/admin/books/reports/detail/download?company=BMG&account=123&report=balance_sheet&from=2026-01&to=2026-09
 * — one account line's detail, as /api/admin/books/reports/detail gives it
 * for the same company, account, report and months, as an Excel file: every
 * document that moved the account, by date, FleetSuite's journal next to the
 * copy of NetSuite's general ledger with each side's running balance, from
 * the line's balance before the months to the line itself
 * (src/lib/books/report-workbook.ts, docs/books.md "Excel downloads").
 *
 * Super admin only, as the rest of the books (docs/books.md).
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  const loaded = await loadReports(service, params.get('company'));
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });
  // Every document, whichever the page lists: a running balance needs them all.
  const detail = await loadAccountDetail(service, loaded, params, { differs: false, limit: LISTED });
  if ('error' in detail) return NextResponse.json({ error: detail.error }, { status: detail.status });
  const { kind, from, to, span, found } = detail;
  const company = loaded.companies.find((c) => c.code === loaded.company) ?? { code: loaded.company, name: loaded.company, legal_name: null };

  const file = await accountWorkbook({
    company,
    kind,
    from,
    to,
    account: detail.account,
    rows: runningBalances(span, yearClosings(loaded.data, kind, detail.account.key, { from, to }), detailDocuments(found, span.sign)),
    documents: found.documents,
    notes: detailNotes({
      lastPosting: loaded.lastPosting,
      moved: span.moved.netsuite,
      copied: detail.copied,
      listed: found.rows.length,
      documents: found.documents,
      from,
      to,
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
