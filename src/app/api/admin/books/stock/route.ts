import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { BOOKS_STOCK_SYNC, copyNetSuiteStock, type StockCopyResult } from '@/lib/books/netsuite-stock';
import { compareStock, stockSetup, type StockItemsData, type StockSetupData } from '@/lib/books/stock-items';

export const dynamic = 'force-dynamic';
// "Copy now" runs the same job as the cron, with the same budget.
export const maxDuration = 300;

const COPY_BUDGET_MS = 240_000;

/** What the page says of the last copy: how it went, never the cursor it keeps to carry on. */
const COPY_FIELDS: Array<keyof StockCopyResult> = [
  'read', 'added', 'changed', 'unchanged', 'lines', 'gone', 'opening', 'counts', 'countsBy', 'partial', 'notes', 'error',
];

/**
 * GET /api/admin/books/stock — each item's count and value at each
 * location, FleetSuite's next to NetSuite's own (compareStock in
 * src/lib/books/stock-items.ts, migration 401), with how the last copy of
 * NetSuite's stock moves went, the inventory accounts its ledger tie-out
 * adds up, and the stocked items NetSuite has set up with an asset account
 * that isn't an asset account (stockSetup, migration 403). Values are whole
 * cents.
 *
 * POST — copy NetSuite's stock moves and read its counts now rather than
 * wait for the two-hourly run (/api/cron/books-netsuite-stock). Same job,
 * same record of how it went; the response says only how the run went.
 *
 * Super admin only, as the rest of the books (docs/books.md "Stock by item").
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  const [items, setup, copy] = await Promise.all([
    service.rpc('gl_stock_items'),
    service.rpc('gl_stock_item_setup'),
    service.from('sync_state').select('last_result, updated_at').eq('sync_type', BOOKS_STOCK_SYNC).maybeSingle(),
  ]);
  const error = items.error || setup.error || copy.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const data = (items.data ?? {}) as StockItemsData;
  const accountIds = data.accounts ?? [];
  const named = accountIds.length
    ? await service.from('gl_accounts').select('netsuite_account_id, number, name').in('netsuite_account_id', accountIds)
    : { data: [], error: null };
  if (named.error) return NextResponse.json({ error: named.error.message }, { status: 500 });
  const chart = new Map((named.data ?? []).map((a: { netsuite_account_id: string; number: string | null; name: string }) => [a.netsuite_account_id, a]));

  const last = (copy.data?.last_result ?? null) as Record<string, unknown> | null;
  return NextResponse.json({
    ...compareStock(data),
    accounts: accountIds.map((id) => ({ number: chart.get(id)?.number ?? null, name: chart.get(id)?.name ?? `NetSuite account ${id}` })),
    setup: stockSetup(setup.data as StockSetupData | null),
    lastCopy: copy.data && last
      ? { at: copy.data.updated_at, result: Object.fromEntries(COPY_FIELDS.filter((k) => k in last).map((k) => [k, last[k]])) }
      : null,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const result = await copyNetSuiteStock(createServiceClient(), { deadline: Date.now() + COPY_BUDGET_MS });
  return NextResponse.json({ copy: result.error ? 'failed' : result.partial ? 'partial' : 'ok' });
}
