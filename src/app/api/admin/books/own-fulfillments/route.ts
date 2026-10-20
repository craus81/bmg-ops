import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { BOOKS_GL_SYNC } from '@/lib/books/netsuite-gl';
import { BOOKS_LISTS_SYNC } from '@/lib/books/netsuite-lists';
import { BOOKS_STOCK_SYNC } from '@/lib/books/netsuite-stock';
import { BOOKS_DAILY_CHECK } from '@/lib/books/daily-check';
import { checkOwnFulfillments, type FulfilPairsData } from '@/lib/books/own-fulfillment-check';

export const dynamic = 'force-dynamic';

const MONTH_RE = /^\d{4}-\d{2}$/;

/** The last day of a 'YYYY-MM' month. */
const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * GET /api/admin/books/own-fulfillments?month=YYYY-MM — FleetSuite's own
 * fulfillments made that month (the newest month with any when it's left
 * out), each next to NetSuite's fulfillment with what each says it cost
 * (migration 418, src/lib/books/own-fulfillment-check.ts), with every month
 * that has any and how the copies the check reads from last went.
 * GET /api/admin/books/own-fulfillments?id=<NetSuite id> — one of them, item
 * by item, with what NetSuite's fulfillment posted. Amounts are whole cents.
 *
 * Super admin only, as the rest of the books (docs/books.md "FleetSuite's
 * own fulfillments").
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (auth.error) return auth.error;

  const params = new URL(req.url).searchParams;
  const service = createServiceClient();
  const read = (syncType: string) =>
    service.from('sync_state').select('last_synced_at, last_result, updated_at').eq('sync_type', syncType).maybeSingle();

  // How far the copies of NetSuite's stock moves and ledger had come, which says whether NetSuite's side is still to come.
  const [stock, ledger] = await Promise.all([read(BOOKS_STOCK_SYNC), read(BOOKS_GL_SYNC)]);
  const copyError = stock.error || ledger.error;
  if (copyError) return NextResponse.json({ error: copyError.message }, { status: 500 });
  const copies = {
    stock: (stock.data?.last_synced_at as string | null | undefined) ?? null,
    ledger: (ledger.data?.last_synced_at as string | null | undefined) ?? null,
  };

  const id = params.get('id');
  if (id !== null) {
    if (!/^\d+$/.test(id)) return NextResponse.json({ error: "That isn't a NetSuite fulfillment id" }, { status: 400 });
    const res = await service.rpc('gl_own_fulfillment_pairs', { p_from: null, p_to: null, p_netsuite_id: id });
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
    const [fulfillment] = checkOwnFulfillments(res.data as FulfilPairsData, copies).fulfillments;
    if (!fulfillment) return NextResponse.json({ error: 'FleetSuite has no copy of that fulfillment' }, { status: 404 });
    return NextResponse.json({ fulfillment });
  }

  const [months, lists, check] = await Promise.all([
    service.rpc('gl_own_fulfillment_months'), read(BOOKS_LISTS_SYNC), read(BOOKS_DAILY_CHECK),
  ]);
  const error = months.error || lists.error || check.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const monthList = ((months.data ?? []) as Array<{ month: string; fulfillments: number }>);
  const asked = params.get('month');
  const month = asked && MONTH_RE.test(asked) ? asked : monthList[0]?.month.slice(0, 7) ?? null;

  let checked: ReturnType<typeof checkOwnFulfillments> | null = null;
  if (month) {
    const res = await service.rpc('gl_own_fulfillment_pairs', { p_from: `${month}-01`, p_to: monthEnd(month), p_netsuite_id: null });
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
    checked = checkOwnFulfillments(res.data as FulfilPairsData, copies);
  }

  const state = (row: typeof stock) =>
    row.data ? { at: row.data.updated_at as string, error: ((row.data.last_result ?? null) as { error?: string } | null)?.error ?? null } : null;

  return NextResponse.json({
    months: monthList,
    month: month ? `${month}-01` : null,
    // The list leaves the item by item check to the fulfillment's own page.
    fulfillments: (checked?.fulfillments ?? []).map(({ fields: _fields, items: _items, entry: _entry, workedOut: _workedOut, ...row }) => row),
    counts: checked?.counts ?? null,
    lastStock: state(stock),
    lastLedger: state(ledger),
    lastLists: state(lists),
    lastCheck: state(check),
  });
}
