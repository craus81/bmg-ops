import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { fetchAllRows } from '@/lib/fetch-all';
import { normalizeItemNumber, isOpenPoStatus } from '@/lib/vendor-po-sync';
import { isOpenSalesOrderStatus, isStockableItemType } from '@/lib/parts-demand';
import { computeCatalogHealth, type CatalogPart } from '@/lib/catalog-health';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * GET /api/parts/catalog-health (R6-7) — attribute-by-attribute coverage of
 * the parts catalog, with the in-demand subset called out separately.
 *
 * "In demand" is computed here rather than by calling computePartsDemand:
 * that function does the full rollup (per-job sources, PO coverage, the
 * pending queue) which this page throws away — all it needs is the SET of
 * item numbers in play. Same open-status rules, a fraction of the work.
 *
 * Scope is STOCKABLE parts only, the same item-type filter the demand tab
 * applies. A LABOR service item has no photo and no dimensions and never
 * will; counting it as a gap would put a permanent floor under every bar
 * and train people to ignore the number. The excluded count is returned so
 * the page can say what it left out.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  try {
    // ── Catalog (paginated: netsuite_parts is unbounded) ─────────────────
    const catalogRead = await fetchAllRows<CatalogPart & { item_type: string | null }>((from, to) => supabase
      .from('netsuite_parts')
      .select('id, item_number, display_name, description, netsuite_id, vendor, product_category_id, image_path, labor_hours, width_in, depth_in, height_in, is_taxable, product_url, catalog, item_type, is_active')
      .order('item_number')
      .order('id')
      .range(from, to));
    if (catalogRead.error) throw new Error(`Could not read the catalog: ${catalogRead.error.message}`);
    const all = catalogRead.data;
    const active = all.filter(p => p.is_active !== false);
    const parts = active.filter(p => isStockableItemType(p.item_type));
    const nonStockExcluded = active.length - parts.length;

    // Item numbers whose catalog row is a service/labor item, so a line
    // referencing one is not a gap in the in-play set either. Built from
    // the WHOLE catalog including deactivated rows: a retired LABOR item
    // still sits on old open orders, and calling it "not in the catalog"
    // would be wrong in the one place this page is supposed to be right.
    const nonStockKeys = new Set(
      all.filter(p => !isStockableItemType(p.item_type))
        .map(p => normalizeItemNumber(p.item_number || '').toUpperCase())
        .filter(Boolean),
    );

    // ── What's in play right now ─────────────────────────────────────────
    const hot = new Set<string>();
    const add = (raw: string | null | undefined) => {
      const n = normalizeItemNumber(raw || '').toUpperCase();
      if (n && !nonStockKeys.has(n)) hot.add(n);
    };

    // 1. Lines on open sales orders (the 2-hour mirror).
    const sos = await fetchAllRows<any>((from, to) => supabase
      .from('netsuite_sales_orders')
      .select('id, status, status_label')
      .order('id')
      .range(from, to));
    if (sos.error) throw new Error(`Could not read sales orders: ${sos.error.message}`);
    const openSoIds = sos.data
      .filter(so => isOpenSalesOrderStatus(so.status, so.status_label))
      .map(so => so.id as string);
    for (let i = 0; i < openSoIds.length; i += 100) {
      const chunk = openSoIds.slice(i, i + 100);
      const lines = await fetchAllRows<any>((from, to) => supabase
        .from('netsuite_sales_order_lines')
        .select('item_number')
        .in('so_id', chunk)
        .order('id')
        .range(from, to));
      if (lines.error) throw new Error(`Could not read sales-order lines: ${lines.error.message}`);
      for (const l of lines.data) add(l.item_number);
    }

    // 2. Lines on open vendor POs — a part we're mid-purchase on is in play
    //    whether or not a job claims it yet.
    const pos = await fetchAllRows<any>((from, to) => supabase
      .from('netsuite_vendor_pos')
      .select('id, status')
      .order('id')
      .range(from, to));
    if (pos.error) throw new Error(`Could not read purchase orders: ${pos.error.message}`);
    const openPoIds = pos.data.filter(p => isOpenPoStatus(p.status)).map(p => p.id as string);
    for (let i = 0; i < openPoIds.length; i += 100) {
      const chunk = openPoIds.slice(i, i + 100);
      const lines = await fetchAllRows<any>((from, to) => supabase
        .from('netsuite_vendor_po_lines')
        .select('item_number')
        .in('po_id', chunk)
        .order('id')
        .range(from, to));
      if (lines.error) throw new Error(`Could not read purchase-order lines: ${lines.error.message}`);
      for (const l of lines.data) add(l.item_number);
    }

    // 3. Anything sitting in the pending purchase-request queue.
    const reqs = await fetchAllRows<any>((from, to) => supabase
      .from('purchase_requests')
      .select('item_number')
      .eq('status', 'pending')
      .order('id')
      .range(from, to));
    if (reqs.error) throw new Error(`Could not read purchase requests: ${reqs.error.message}`);
    for (const r of reqs.data) add(r.item_number);

    // An in-play part whose catalog row exists but is DEACTIVATED is a
    // different problem from one with no row at all, so it is not reported
    // as uncatalogued — computeCatalogHealth only sees the active set, so
    // the deactivated numbers are filtered out of the hot set here first.
    const knownKeys = new Set(
      all.map(p => normalizeItemNumber(p.item_number || '').toUpperCase()).filter(Boolean),
    );
    const activeKeys = new Set(
      parts.map(p => normalizeItemNumber(p.item_number || '').toUpperCase()).filter(Boolean),
    );
    const deactivatedInPlay = [...hot].filter(n => knownKeys.has(n) && !activeKeys.has(n)).sort();
    for (const n of deactivatedInPlay) hot.delete(n);

    const health = computeCatalogHealth(parts, hot);
    return NextResponse.json({
      success: true,
      health: { ...health, nonStockExcluded, deactivatedInPlay },
    });
  } catch (e: any) {
    // A short read here would UNDERSTATE a gap — the one failure mode a
    // health dashboard cannot have — so the page fails loudly instead.
    return NextResponse.json({ error: e?.message || 'Could not measure catalog health' }, { status: 500 });
  }
}
