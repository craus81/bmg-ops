import { NextRequest, NextResponse } from 'next/server';
import { requireBooks } from '@/lib/api-auth';
import { createServiceClient } from '@/lib/supabase-service';
import { itemMoves, stockSetup, type StockItemMovesData, type StockSetupData } from '@/lib/books/stock-items';

export const dynamic = 'force-dynamic';

/** The most moves the page lists at once, the newest. */
const SHOWN = 1000;

/**
 * GET /api/admin/books/stock/item?item=9001 — one item's moves since its
 * starting count on December 31, 2024, oldest first, each with what it left
 * at its location, and the item at each location next to NetSuite's own
 * count (itemMoves in src/lib/books/stock-items.ts, migration 401), and,
 * when NetSuite has the item set up with an asset account that isn't an
 * asset account, that account (stockSetup, migration 403). `item` is
 * NetSuite's id for it. Values are whole cents.
 *
 * Super admins, the bookkeeper and the CPA, as the rest of the books
 * (docs/books.md "Stock by item").
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const item = new URL(req.url).searchParams.get('item') ?? '';
  if (!/^\d+$/.test(item)) return NextResponse.json({ error: 'Pick an item on Stock by item' }, { status: 400 });

  const service = createServiceClient();
  const [res, setupRes] = await Promise.all([
    service.rpc('gl_stock_item_moves', { p_item: item, p_limit: SHOWN }),
    service.rpc('gl_stock_item_setup'),
  ]);
  const failed = res.error || setupRes.error;
  if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });
  const data = res.data as StockItemMovesData;
  const held = data.item || data.moves?.length || data.opening?.length || data.netsuite?.length;
  if (!held) return NextResponse.json({ error: 'FleetSuite holds nothing of that item' }, { status: 404 });
  const setup = stockSetup(setupRes.data as StockSetupData | null);
  const wrong = setup.items.find((i) => i.itemId === item);

  return NextResponse.json({
    item: {
      id: item,
      name: data.item?.name ?? `Item ${item}`,
      description: data.item?.display_name && data.item.display_name !== data.item.name ? data.item.display_name : null,
      active: data.item?.active ?? true,
    },
    readAt: data.netsuite_read_at,
    ...itemMoves(data),
    setup: wrong ? { account: wrong.account, accountKind: wrong.accountKind, usual: setup.usual } : null,
  });
}
