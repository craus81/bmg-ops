import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { fetchAllRows } from '@/lib/fetch-all';
import { escapeIlike } from '@/lib/customer-dupes';
import { BOOKS_LISTS_SYNC, syncBooksLists } from '@/lib/books/netsuite-lists';

export const dynamic = 'force-dynamic';
// "Sync now" reads every list, items included: many SuiteQL pages.
export const maxDuration = 300;

const SYNC_BUDGET_MS = 240_000;
const ROW_COLUMNS = 'kind, netsuite_id, name, parent_netsuite_id, active, details, gone_at';
/** The lists short enough to send whole; items and vendors are looked up. */
const SHORT_LISTS = ['location', 'department', 'class', 'term', 'tax_code'];
/** The account fields a lookup can filter on, per list. */
const ACCOUNT_FIELDS: Record<string, string[]> = {
  item: ['income_account', 'cogs_account', 'asset_account', 'expense_account'],
  vendor: ['expense_account', 'payables_account'],
};
const LOOKUP_LIMIT = 50;

/**
 * GET /api/admin/books/lists — the NetSuite lists copied for FleetSuite's
 * books (migration 363): the short lists whole, counts, how many copied GL
 * lines carry each location, department and class, which accounts items and
 * vendors post to, and how the last copy went.
 *
 * GET ?kind=item|vendor&q=… — items or vendors whose name contains q (or
 * whose NetSuite id is q). &field=income_account&account=123 (or
 * account=none) instead lists the active ones posting to that account.
 *
 * Super admin only: the books are being built hidden, for the owner, until
 * they're ready (docs/books.md). Read-only — until the changeover these
 * lists are kept in NetSuite and copied here every two hours.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();

  const kind = params.get('kind');
  if (kind) {
    if (!ACCOUNT_FIELDS[kind]) return NextResponse.json({ error: 'Only items and vendors are looked up' }, { status: 400 });
    let lookup = service
      .from('gl_netsuite_lists')
      .select(ROW_COLUMNS, { count: 'exact' })
      .eq('kind', kind);
    const field = params.get('field');
    if (field) {
      const account = params.get('account') || '';
      if (!ACCOUNT_FIELDS[kind].includes(field) || !/^(\d+|none)$/.test(account)) {
        return NextResponse.json({ error: 'Unknown account filter' }, { status: 400 });
      }
      lookup = lookup.eq('active', true).is('gone_at', null);
      lookup = account === 'none' ? lookup.is(`details->>${field}`, null) : lookup.eq(`details->>${field}`, account);
    } else {
      const q = (params.get('q') || '').trim().slice(0, 100);
      if (!q) return NextResponse.json({ rows: [], total: 0 });
      const byName = `%${escapeIlike(q)}%`;
      lookup = /^\d+$/.test(q) ? lookup.or(`name.ilike.${byName},netsuite_id.eq.${q}`) : lookup.ilike('name', byName);
    }
    const { data, count, error } = await lookup
      .order('name', { ascending: true })
      .order('netsuite_id', { ascending: true })
      .limit(LOOKUP_LIMIT);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ rows: data || [], total: count ?? (data || []).length });
  }

  const [lists, accounts, overview, sync] = await Promise.all([
    fetchAllRows((from, to) => service
      .from('gl_netsuite_lists')
      .select(ROW_COLUMNS)
      .in('kind', SHORT_LISTS)
      .order('kind', { ascending: true })
      .order('netsuite_id', { ascending: true })
      .range(from, to)),
    fetchAllRows((from, to) => service
      .from('gl_accounts')
      .select('netsuite_account_id, number, name')
      .not('netsuite_account_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to)),
    service.rpc('gl_netsuite_lists_overview'),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_LISTS_SYNC).maybeSingle(),
  ]);
  const error = lists.error || accounts.error || overview.error || sync.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    lists: lists.data,
    accounts: accounts.data,
    overview: overview.data ?? {},
    lastSync: sync.data ? { at: sync.data.updated_at, result: sync.data.last_result } : null,
  });
}

/**
 * POST /api/admin/books/lists — copy the lists from NetSuite now rather than
 * wait for the two-hourly run. Same job, same record of how it went.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  return NextResponse.json(await syncBooksLists(createServiceClient(), { deadline: Date.now() + SYNC_BUDGET_MS }));
}
