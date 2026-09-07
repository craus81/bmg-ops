import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { loadOrderBook } from '@/lib/order-book';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/reports/order-book (R4-3)
 *
 * The open order book from the 2-hourly NetSuite SO mirror: every open
 * sales order with sold total, billed progress, and the unbilled remainder,
 * plus aging totals. The same loadOrderBook() feeds the nightly metric
 * snapshots and the CEO Operations band, so this report IS the drill-down
 * behind those numbers. Mirror data — up to ~2h stale, said in meta.
 */
export async function GET(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  try {
    const { rows, totals } = await loadOrderBook(supabase);
    const { data: sync } = await supabase
      .from('sync_state')
      .select('last_synced_at')
      .eq('sync_type', 'netsuite_sales_orders')
      .maybeSingle();
    return NextResponse.json({
      rows,
      totals,
      meta: { mirrorSyncedAt: sync?.last_synced_at || null },
    });
  } catch (err: any) {
    console.error('order-book report failed:', err);
    return NextResponse.json({ error: err?.message || 'Report failed' }, { status: 500 });
  }
}
