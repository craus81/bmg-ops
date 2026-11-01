import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { attachmentDisposition } from '@/lib/estimate-approval-downloads';
import { loadInventoryValue } from '@/lib/books/inventory-value-data';
import { inventoryNotes, inventoryWorkbook } from '@/lib/books/report-workbook';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/books/inventory-value/download?month=2026-10&company=BMG —
 * the page's month for one company as an Excel file: each item at the
 * month's end, how the stock comes to each inventory account, and the
 * documents with no stocked item, with what the page warns about at the top
 * (src/lib/books/report-workbook.ts, docs/books.md "Inventory value at a
 * month's end"). BMG, else the first company with stock, when it's left out.
 *
 * Super admins, the bookkeeper and the CPA, as the rest of the books.
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const loaded = await loadInventoryValue(createServiceClient(), params);
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });
  const companies = loaded.value.companies;
  const value = companies.find((c) => c.company === params.get('company')) ?? companies[0];
  if (!value) return NextResponse.json({ error: 'No company has stock or an inventory account that month.' }, { status: 404 });
  const named = loaded.names.find((c) => c.code === value.company);
  const company = { code: value.company, name: named?.name ?? value.company, legal_name: named?.legal_name ?? null };

  const now = new Date();
  const file = await inventoryWorkbook({
    company,
    month: loaded.month,
    value,
    notes: inventoryNotes({
      month: loaded.month, through: loaded.through, company: value, lastCopy: loaded.lastCopy, lastPosting: loaded.lastPosting,
    }),
    now,
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
