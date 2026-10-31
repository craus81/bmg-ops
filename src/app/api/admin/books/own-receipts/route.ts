import { NextRequest, NextResponse } from 'next/server';
import { requireSuperAdmin } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { transactionUrl } from '@/lib/netsuite';
import { BOOKS_GL_SYNC } from '@/lib/books/netsuite-gl';
import { BOOKS_LISTS_SYNC } from '@/lib/books/netsuite-lists';
import { BOOKS_STOCK_SYNC } from '@/lib/books/netsuite-stock';
import { BOOKS_DAILY_CHECK } from '@/lib/books/daily-check';
import { checkOwnReceipts, type OwnReceiptCheck, type ReceiptPairsData } from '@/lib/books/own-receipt-check';
import { readOwnBooks } from '@/lib/books/own-invoice-posting';
import { RECEIPT_BOOKS } from '@/lib/books/own-stock-posting';
import { readOwnStockView } from '@/lib/books/own-posting-view';

export const dynamic = 'force-dynamic';

const MONTH_RE = /^\d{4}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The last day of a 'YYYY-MM' month. */
const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** NetSuite's page for an item receipt or a purchase order; null without NetSuite's account in the environment. */
const link = (page: 'itemrcpt' | 'purchord', netsuiteId: string | null) => {
  if (!netsuiteId) return null;
  try {
    return transactionUrl(page, netsuiteId);
  } catch {
    return null;
  }
};

/** A checked receipt with NetSuite's pages for it and its purchase order. */
const withLinks = (receipt: OwnReceiptCheck) => ({
  ...receipt, netsuiteUrl: link('itemrcpt', receipt.netsuiteId), poUrl: link('purchord', receipt.poId),
});

/**
 * GET /api/admin/books/own-receipts?month=YYYY-MM — Books' own copies of
 * the Receives on the Receiving page that month (the newest month with any
 * when it's left out), each next to NetSuite's item receipt (migration 435,
 * src/lib/books/own-receipt-check.ts), with every month that has any and how
 * the copies the check reads from last went.
 * GET /api/admin/books/own-receipts?key=<receipt key> — one of them, item by
 * item. Amounts are whole cents. Each one NetSuite took says what the books
 * hold for NetSuite's receipt and which copy made it, and one on its own how
 * this copy posts: its entry next to NetSuite's, and why NetSuite's posts
 * when it does (migration 456, src/lib/books/own-posting-view.ts).
 *
 * Super admin only, as the rest of the books (docs/books.md "FleetSuite's
 * own bills and receipts").
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

  const key = params.get('key');
  if (key !== null) {
    if (!UUID_RE.test(key)) return NextResponse.json({ error: "That isn't one of Books' receipts" }, { status: 400 });
    const res = await service.rpc('gl_own_receipt_pairs', { p_from: null, p_to: null, p_key: key });
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
    const [receipt] = checkOwnReceipts(res.data as ReceiptPairsData, copies).receipts;
    if (!receipt) return NextResponse.json({ error: 'Books has no copy of that receipt' }, { status: 404 });
    // A Receive NetSuite didn't take has nothing to post.
    const netsuiteId = receipt.netsuiteId;
    if (!netsuiteId) return NextResponse.json({ receipt: { ...withLinks(receipt), books: null }, posting: null });
    try {
      const posting = await readOwnStockView(service, { kind: 'receipt', check: { ...receipt, netsuiteId } });
      return NextResponse.json({ receipt: { ...withLinks(receipt), books: posting.books }, posting });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  const [months, lists, check] = await Promise.all([
    service.rpc('gl_own_receipt_months'), read(BOOKS_LISTS_SYNC), read(BOOKS_DAILY_CHECK),
  ]);
  const error = months.error || lists.error || check.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const monthList = ((months.data ?? []) as Array<{ month: string; receipts: number }>);
  const asked = params.get('month');
  const month = asked && MONTH_RE.test(asked) ? asked : monthList[0]?.month.slice(0, 7) ?? null;

  let checked: ReturnType<typeof checkOwnReceipts> | null = null;
  if (month) {
    const res = await service.rpc('gl_own_receipt_pairs', { p_from: `${month}-01`, p_to: monthEnd(month), p_key: null });
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
    checked = checkOwnReceipts(res.data as ReceiptPairsData, copies);
  }
  const receipts = checked?.receipts ?? [];
  let books: Awaited<ReturnType<typeof readOwnBooks>>;
  try {
    books = await readOwnBooks(service, RECEIPT_BOOKS, receipts.flatMap((r) => (r.netsuiteId ? [{ company: r.company, netsuiteId: r.netsuiteId }] : [])));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  const state = (row: typeof stock) =>
    row.data ? { at: row.data.updated_at as string, error: ((row.data.last_result ?? null) as { error?: string } | null)?.error ?? null } : null;

  return NextResponse.json({
    months: monthList,
    month: month ? `${month}-01` : null,
    // The list leaves the item by item check to the receipt's own page.
    receipts: receipts.map(({ fields: _fields, items: _items, workedOut: _workedOut, ...row }) => (
      { ...withLinks(row as OwnReceiptCheck), books: (row.netsuiteId && books.get(row.netsuiteId)) || null })),
    counts: checked?.counts ?? null,
    lastStock: state(stock),
    lastLedger: state(ledger),
    lastLists: state(lists),
    lastCheck: state(check),
  });
}
