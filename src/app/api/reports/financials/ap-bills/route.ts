import { NextRequest, NextResponse } from 'next/server';
import { requireFinancials } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { fetchOpenVendorBills } from '@/lib/financials-data';
import { loadBooksApBills } from '@/lib/books/money-screens-data';
import { switchIsOn } from '@/lib/books/switches';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/reports/financials/ap-bills
 *
 * Open vendor bills (headers) — the drill-down detail under the A/P tile.
 * The tile itself is the NetSuite A/P account balance from the financials
 * RESTlet; this list is what the integration role can see via SuiteQL. The
 * two can differ legitimately (vendor credits and unapplied payments are
 * invisible to the role), which the UI explains rather than hides.
 *
 * Response: { success, unpaidColumn, bills: OpenVendorBill[] } sorted most
 * overdue first, then by open balance.
 *
 * With "Financials on FleetSuite's books" switched on (migration 504), the
 * list is every open bill and bill credit in BMG's books in FleetSuite
 * (src/lib/books/money-screens.ts), a bill credit's amounts negative, with
 * `notOpen`, what the payable accounts hold beyond them; the tile is then
 * the payable accounts' balance in the same books, so the two add up.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  if (await switchIsOn(service, 'money_screens')) {
    const books = await loadBooksApBills(service);
    if ('error' in books) return NextResponse.json({ error: books.error }, { status: 500 });
    return NextResponse.json(books);
  }

  try {
    const { bills, unpaidColumn } = await fetchOpenVendorBills();
    bills.sort((a, b) => b.daysPastDue - a.daysPastDue || b.unpaid - a.unpaid);
    return NextResponse.json({ success: true, unpaidColumn, bills });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
