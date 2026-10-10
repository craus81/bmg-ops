import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { fetchAllRows } from '@/lib/fetch-all';
import { BOOKS_ACCOUNTS_SYNC, syncBooksAccounts } from '@/lib/books/netsuite-accounts';

export const dynamic = 'force-dynamic';
// "Sync now" reads NetSuite's whole account list: a few SuiteQL pages.
export const maxDuration = 60;

/**
 * GET /api/admin/books/accounts — FleetSuite's chart of accounts (migrations
 * 359/360) and how the last NetSuite account sync went.
 *
 * Super admin only: the books are being built hidden, for the owner, until
 * they're ready (docs/books.md). Read-only — until the changeover, accounts
 * are added and changed in NetSuite and copied here every two hours.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  const [accounts, companies, sync] = await Promise.all([
    fetchAllRows((from, to) => service
      .from('gl_accounts')
      .select('id, number, name, account_type, statement, parent_id, company_id, is_control, is_summary, active, description, netsuite_account_id, sync_issue')
      .order('number', { ascending: true, nullsFirst: false })
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)),
    service.from('gl_companies').select('id, code, name, netsuite_subsidiary_id, books_live_from').order('code'),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_ACCOUNTS_SYNC).maybeSingle(),
  ]);
  const error = accounts.error || companies.error || sync.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    accounts: accounts.data,
    companies: companies.data || [],
    lastSync: sync.data ? { at: sync.data.updated_at, result: sync.data.last_result } : null,
  });
}

/**
 * POST /api/admin/books/accounts — sync from NetSuite now rather than wait
 * for the next two-hourly run. Same job, same record of how it went: a
 * refused NetSuite read comes back as the result's error, like the cron's.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  return NextResponse.json(await syncBooksAccounts(createServiceClient()));
}
