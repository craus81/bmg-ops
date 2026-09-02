import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { syncSalesOrders } from '@/lib/sales-order-sync';
import { isOpenSalesOrderStatus } from '@/lib/parts-demand';
import { fetchAllRows } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';
// A full resync pages through years of sales orders; the run budgets itself
// to stop well inside this and saves a cursor the 2-hour cron continues.
export const maxDuration = 300;

/**
 * POST /api/purchasing/sync-sales-orders — admin-triggered sales-order sync
 * from NetSuite, the same job the netsuite-sync cron runs (step 3b2), as a
 * full resync so an empty or stuck mirror gets repopulated on the spot.
 * Newest orders come first, so the open ones the demand list needs are on
 * file within the first page even when the run ends partial.
 *
 * The response carries the numbers that tell the failure modes apart:
 * `modified` (what NetSuite returned — 0 across a full resync means the
 * integration role can't see Sales Orders), `totalSos`/`openSos` (what's on
 * file now), and `partial` (more history still to backfill).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const service = createServiceClient();
  try {
    const result = await syncSalesOrders(service, {
      fullResync: true,
      deadline: Date.now() + 240_000,
    });

    const { data: sos } = await fetchAllRows<{ status: string | null; status_label: string | null }>((from, to) => service
      .from('netsuite_sales_orders')
      .select('status, status_label')
      .order('id')
      .range(from, to));
    const totalSos = (sos || []).length;
    const openSos = (sos || []).filter(so => isOpenSalesOrderStatus(so.status, so.status_label)).length;

    return NextResponse.json({
      ok: !result.error,
      modified: result.modified,
      synced: result.synced,
      lines: result.lines,
      headerErrors: result.headerErrors,
      droppedColumns: result.droppedColumns,
      partial: result.partial,
      windowProcessed: result.windowProcessed,
      totalSos,
      openSos,
      ...(result.error ? { error: result.error } : {}),
    }, { status: result.error ? 500 : 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err).slice(0, 300) },
      { status: 500 },
    );
  }
}
