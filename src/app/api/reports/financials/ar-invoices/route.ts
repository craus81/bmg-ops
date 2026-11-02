import { NextRequest, NextResponse } from 'next/server';
import { requireFinancials } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { fetchOpenArInvoices } from '@/lib/financials-data';
import { loadBooksArInvoices } from '@/lib/books/money-screens-data';
import { switchIsOn } from '@/lib/books/switches';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/reports/financials/ar-invoices
 *
 * Every open customer invoice behind the A/R tile — the drill-down list for
 * verifying the aging, chasing past dues, and printing statements. Same
 * SuiteQL rows the tile aggregates (src/lib/financials-data.ts), so the sum
 * of `unpaid` here reconciles with the tile exactly.
 *
 * Response: { success, unpaidColumn, invoices: OpenArInvoice[] } sorted most
 * overdue first, then by open balance. `unpaidColumn` is false when NetSuite
 * rejected foreignamountunpaid and amounts fell back to invoice totals.
 *
 * With "Financials on FleetSuite's books" switched on (migration 504), the
 * list is every open invoice and credit memo in BMG's books in FleetSuite
 * (src/lib/books/money-screens.ts), a credit memo's amounts negative, with
 * `notOpen`, what the receivable accounts hold beyond them, so the list and
 * it add up to the tile.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  if (await switchIsOn(service, 'money_screens')) {
    const books = await loadBooksArInvoices(service);
    if ('error' in books) return NextResponse.json({ error: books.error }, { status: 500 });
    return NextResponse.json(books);
  }

  try {
    const { invoices, unpaidColumn } = await fetchOpenArInvoices();
    invoices.sort((a, b) => b.daysPastDue - a.daysPastDue || b.unpaid - a.unpaid);
    return NextResponse.json({ success: true, unpaidColumn, invoices });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
