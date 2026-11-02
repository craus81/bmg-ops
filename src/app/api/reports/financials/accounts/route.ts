import { NextRequest, NextResponse } from 'next/server';
import { requireFinancials } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { fetchAccountGroups } from '@/lib/financials-data';
import { loadBooksAccounts } from '@/lib/books/money-screens-data';
import { switchIsOn } from '@/lib/books/switches';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/reports/financials/accounts
 *
 * Per-account GL balances behind the Cash and Credit-card tiles (and the A/P
 * control account), from the financials RESTlet — account name, type, and
 * current balance for every env-configured account id. This is the "which
 * accounts make up that number" drill-down.
 *
 * Response: { success, error?, bank: AccountBalance[], card: AccountBalance[],
 * ap: AccountBalance[], salesTax: AccountBalance[] }. success=false (with the
 * RESTlet's error) when the RESTlet isn't deployed/reachable — the UI shows
 * the hint instead of numbers.
 *
 * With "Financials on FleetSuite's books" switched on (migration 504), the
 * accounts are each bank, credit card and payable account BMG's books in
 * FleetSuite use and the accounts NetSuite posts sales tax to, with their
 * balance there (src/lib/books/money-screens.ts); one with nothing on it
 * isn't listed.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFinancials(req);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  if (await switchIsOn(service, 'money_screens')) {
    const books = await loadBooksAccounts(service);
    if ('error' in books) return NextResponse.json({ error: books.error }, { status: 500 });
    return NextResponse.json(books);
  }

  try {
    const groups = await fetchAccountGroups();
    return NextResponse.json(groups);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'NetSuite query failed' }, { status: 500 });
  }
}
