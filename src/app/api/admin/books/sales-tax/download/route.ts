import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { attachmentDisposition } from '@/lib/estimate-approval-downloads';
import { loadSalesTax } from '@/lib/books/sales-tax-data';
import { salesTaxNotes, salesTaxWorkbook } from '@/lib/books/report-workbook';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/books/sales-tax/download?month=2026-10 — the page's month
 * of Missouri sales tax as an Excel file: what to file for each location and
 * what to pay, the return as filed held against it, every document and line
 * behind it, exempt customers' sales and the sales tax accounts, with what
 * the page warns about at the top (src/lib/books/report-workbook.ts,
 * docs/books.md "Sales tax"); last month when it's left out.
 *
 * Super admins, the bookkeeper and the CPA, as the rest of the books.
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const loaded = await loadSalesTax(createServiceClient(), new URL(req.url).searchParams);
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });

  const file = await salesTaxWorkbook({
    company: loaded.company,
    month: loaded.month,
    due: loaded.due,
    worksheet: loaded.worksheet,
    filed: loaded.filed,
    held: loaded.held,
    taxAccounts: loaded.taxAccounts,
    notes: salesTaxNotes({ month: loaded.month, through: loaded.through, worksheet: loaded.worksheet }),
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
