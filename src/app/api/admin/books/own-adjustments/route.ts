import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { transactionUrl } from '@/lib/netsuite';
import { BOOKS_GL_SYNC } from '@/lib/books/netsuite-gl';
import { BOOKS_LISTS_SYNC } from '@/lib/books/netsuite-lists';
import { BOOKS_STOCK_SYNC } from '@/lib/books/netsuite-stock';
import { BOOKS_DAILY_CHECK } from '@/lib/books/daily-check';
import { checkOwnAdjustments, INVENTORY_ADJUST_ACCOUNT, type AdjustPairsData, type OwnAdjustmentCheck } from '@/lib/books/own-adjustment-check';
import { readOwnBooks } from '@/lib/books/own-invoice-posting';
import { ADJUSTMENT_BOOKS } from '@/lib/books/own-stock-posting';
import { readOwnStockView } from '@/lib/books/own-posting-view';
import { OWN_COMPANY } from '@/lib/books/own-invoices';

export const dynamic = 'force-dynamic';

const MONTH_RE = /^\d{4}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The last day of a 'YYYY-MM' month. */
const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** NetSuite's page for an adjustment; null without NetSuite's id for it or NetSuite's account in the environment. */
const link = (netsuiteId: string | null) => {
  if (!netsuiteId) return null;
  try {
    return transactionUrl('invadjst', netsuiteId);
  } catch {
    return null;
  }
};

/**
 * GET /api/admin/books/own-adjustments?month=YYYY-MM — the Inventory Adjusts
 * made that month (the newest month with any when it's left out), each next
 * to NetSuite's adjustment with what each says the change came to
 * (migration 457, src/lib/books/own-adjustment-check.ts), with every month
 * that has any and how the copies the check reads from last went.
 * GET /api/admin/books/own-adjustments?id=<FleetSuite's id> — one of them,
 * with what NetSuite's adjustment posted. Amounts are whole cents. Each one
 * NetSuite said it made says what the books hold for NetSuite's adjustment
 * and which copy made it, and one on its own how this copy posts: its entry
 * next to NetSuite's, and why NetSuite's posts when it does
 * (src/lib/books/own-posting-view.ts).
 *
 * Super admins, the bookkeeper and the CPA, as the rest of the books
 * (docs/books.md "FleetSuite's own adjustments").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
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
  const withLink = (adjustment: OwnAdjustmentCheck) => ({ ...adjustment, netsuiteUrl: link(adjustment.netsuiteId) });

  const id = params.get('id');
  if (id !== null) {
    if (!UUID_RE.test(id)) return NextResponse.json({ error: "That isn't one of FleetSuite's Inventory Adjusts" }, { status: 400 });
    const res = await service.rpc('gl_own_adjustment_pairs', { p_from: null, p_to: null, p_id: id, p_account: INVENTORY_ADJUST_ACCOUNT });
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
    const [adjustment] = checkOwnAdjustments(res.data as AdjustPairsData, copies).adjustments;
    if (!adjustment) return NextResponse.json({ error: 'FleetSuite has no Inventory Adjust by that id' }, { status: 404 });
    // One NetSuite didn't say it made has nothing to post.
    const netsuiteId = adjustment.netsuiteId;
    if (!netsuiteId) return NextResponse.json({ adjustment: { ...withLink(adjustment), books: null }, posting: null });
    try {
      const posting = await readOwnStockView(service, { kind: 'adjustment', check: { ...adjustment, netsuiteId } });
      return NextResponse.json({ adjustment: { ...withLink(adjustment), books: posting.books }, posting });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  const [months, lists, check] = await Promise.all([
    service.rpc('gl_own_adjustment_months'), read(BOOKS_LISTS_SYNC), read(BOOKS_DAILY_CHECK),
  ]);
  const error = months.error || lists.error || check.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const monthList = ((months.data ?? []) as Array<{ month: string; adjustments: number }>);
  const asked = params.get('month');
  const month = asked && MONTH_RE.test(asked) ? asked : monthList[0]?.month.slice(0, 7) ?? null;

  let checked: ReturnType<typeof checkOwnAdjustments> | null = null;
  if (month) {
    const res = await service.rpc('gl_own_adjustment_pairs', {
      p_from: `${month}-01`, p_to: monthEnd(month), p_id: null, p_account: INVENTORY_ADJUST_ACCOUNT,
    });
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
    checked = checkOwnAdjustments(res.data as AdjustPairsData, copies);
  }
  const adjustments = checked?.adjustments ?? [];
  let books: Awaited<ReturnType<typeof readOwnBooks>>;
  try {
    books = await readOwnBooks(service, ADJUSTMENT_BOOKS, adjustments.flatMap((a) => (a.netsuiteId ? [{ company: OWN_COMPANY, netsuiteId: a.netsuiteId }] : [])));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  const state = (row: typeof stock) =>
    row.data ? { at: row.data.updated_at as string, error: ((row.data.last_result ?? null) as { error?: string } | null)?.error ?? null } : null;

  return NextResponse.json({
    months: monthList,
    month: month ? `${month}-01` : null,
    // The list leaves what's compared and how it was worked out to the adjustment's own page.
    adjustments: adjustments.map(({ fields: _fields, entry: _entry, workedOut: _workedOut, ...row }) => (
      { ...withLink(row as OwnAdjustmentCheck), books: (row.netsuiteId && books.get(row.netsuiteId)) || null })),
    counts: checked?.counts ?? null,
    lastStock: state(stock),
    lastLedger: state(ledger),
    lastLists: state(lists),
    lastCheck: state(check),
  });
}
