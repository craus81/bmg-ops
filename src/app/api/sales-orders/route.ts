import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff, profileCanSeeMoney } from '@/lib/api-auth';
import { parseSoView, soViewOf, statusText, statusValuesFor } from '@/lib/sales-order-list';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

/**
 * GET /api/sales-orders?view=open|billed|closed|all&q=…&page=0 — the Sales
 * orders list, from FleetSuite's copy of NetSuite's orders (2-hour sync),
 * newest first, 50 a page. Totals are left out for anyone who can't see
 * prices, as on the sales order page.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const sp = req.nextUrl.searchParams;
  const view = parseSoView(sp.get('view'));
  const page = Math.max(0, Math.min(1000, Number.parseInt(sp.get('page') || '0', 10) || 0));
  const q = (sp.get('q') || '').trim().replace(/[%,()"]/g, ' ').slice(0, 60).trim();

  const service = createServiceClient();
  let query = service
    .from('netsuite_sales_orders')
    .select('netsuite_id, tranid, customer_netsuite_id, customer_name, trandate, status, status_label, memo, otherrefnum, vin, total, estimate_id', { count: 'exact' });
  if (view !== 'all') query = query.in('status', statusValuesFor(view));
  if (q.length >= 2) {
    const like = `%${q}%`;
    query = query.or(`tranid.ilike.${like},customer_name.ilike.${like},otherrefnum.ilike.${like},memo.ilike.${like},vin.ilike.${like}`);
  }
  const { data, error, count } = await query
    .order('trandate', { ascending: false, nullsFirst: false })
    .order('netsuite_id', { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data || [];
  const estimateIds = [...new Set(rows.map(r => r.estimate_id).filter((id): id is string => !!id))];
  const estimates = new Map<string, string>();
  if (estimateIds.length > 0) {
    const { data: ests } = await service.from('estimates').select('id, estimate_number').in('id', estimateIds);
    for (const e of ests || []) estimates.set(e.id, e.estimate_number);
  }
  const seeMoney = await profileCanSeeMoney(auth.user.id, auth.profile);

  return NextResponse.json({
    view,
    page,
    pageSize: PAGE_SIZE,
    count: count ?? rows.length,
    seeMoney,
    orders: rows.map(r => ({
      netsuiteId: r.netsuite_id,
      number: r.tranid,
      customerName: r.customer_name,
      date: r.trandate,
      status: statusText(r.status, r.status_label),
      view: soViewOf(r.status),
      poNumber: r.otherrefnum,
      memo: r.memo,
      vin: r.vin,
      total: seeMoney && r.total != null ? Number(r.total) : null,
      estimate: r.estimate_id ? { id: r.estimate_id, number: estimates.get(r.estimate_id) ?? null } : null,
    })),
  });
}
