import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { attachmentDisposition } from '@/lib/estimate-approval-downloads';
import { POSTING_COMPANIES } from '@/lib/books/invoice-posting';
import { buildReport } from '@/lib/books/report-builder';
import { loadBuilder } from '@/lib/books/report-data';
import { builderNotes, builderWorkbook } from '@/lib/books/report-workbook';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/books/reports/builder/download?company=BMG&rows=customer&by=division&months=picked&from=2026-01&to=2026-09&division=graphics&location=3
 * — the report /api/admin/books/reports/builder gives for the same company,
 * lines, columns, filters and months, as an Excel file: every line with an
 * amount for each column, and what the page warns about at the top
 * (src/lib/books/report-workbook.ts, docs/books.md "Report builder").
 *
 * Super admins, the bookkeeper and the CPA, as the rest of the books
 * (docs/books.md).
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const loaded = await loadBuilder(createServiceClient(), new URL(req.url).searchParams);
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });
  const { ask } = loaded;
  const company = loaded.companies.find((c) => c.code === loaded.company) ?? { code: loaded.company, name: loaded.company, legal_name: null };
  const built = buildReport(loaded.data, loaded.split, loaded.locationNames, ask, loaded.parties);

  const file = await builderWorkbook({
    company,
    ask,
    built,
    notes: builderNotes({
      companyName: company.name,
      posts: (POSTING_COMPANIES as readonly string[]).includes(loaded.company),
      copied: loaded.data.opening.length > 0 || loaded.data.netsuite.length > 0,
      ties: built.ties,
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
