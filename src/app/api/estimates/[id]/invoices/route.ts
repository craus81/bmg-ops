import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature, profileCanSeeMoney } from '@/lib/api-auth';
import { refreshEstimateInvoices } from '@/lib/estimate-invoices';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** A check younger than this is answered from the saved copy. */
const FRESH_MS = 10 * 60 * 1000;

/**
 * GET /api/estimates/[id]/invoices — the invoices billed from the estimate's
 * sales order (migration 461), for the estimate's SO bar.
 *
 * Answers from the saved copy, checking NetSuite first when the copy is more
 * than ten minutes old (or `?refresh=1`), so an invoice made a minute ago
 * shows when the estimate opens. A failed check falls back to the saved copy
 * with `checkError` set, never to "nothing billed". Amounts are left out for
 * anyone without See prices.
 *
 * Returns { linked, billing, checkedAt, checkError, soTotal, invoices: [{ id,
 * number, date, total, status }] }.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  const supabase = createServiceClient();

  const { data: est, error } = await supabase
    .from('estimates')
    .select('id, netsuite_so_id, netsuite_so_number, fleet_checkin_id, so_billing, invoices_checked_at')
    .eq('id', params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!est) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  if (!est.netsuite_so_id) return NextResponse.json({ linked: false, invoices: [] });

  const checkedAt = est.invoices_checked_at ? Date.parse(est.invoices_checked_at) : NaN;
  const stale = Number.isNaN(checkedAt) || Date.now() - checkedAt > FRESH_MS;
  let checkError: string | null = null;
  if (stale || req.nextUrl.searchParams.get('refresh') === '1') {
    try {
      await refreshEstimateInvoices(supabase, est);
    } catch (err: any) {
      checkError = err?.message || 'NetSuite check failed';
    }
  }

  const [seeMoney, { data: fresh }, { data: rows }, { data: so }] = await Promise.all([
    profileCanSeeMoney(auth.user.id, auth.profile),
    supabase.from('estimates').select('so_billing, invoices_checked_at').eq('id', params.id).maybeSingle(),
    supabase.from('estimate_invoices')
      .select('netsuite_invoice_id, invoice_number, invoice_date, total, status')
      .eq('estimate_id', params.id)
      .order('invoice_date', { ascending: true, nullsFirst: false })
      .order('invoice_number'),
    supabase.from('netsuite_sales_orders').select('total').eq('netsuite_id', String(est.netsuite_so_id)).maybeSingle(),
  ]);

  return NextResponse.json({
    linked: true,
    billing: fresh?.so_billing || null,
    checkedAt: fresh?.invoices_checked_at || null,
    checkError,
    soTotal: seeMoney && so?.total != null ? Number(so.total) : null,
    invoices: (rows || []).map((r: any) => ({
      id: String(r.netsuite_invoice_id),
      number: r.invoice_number,
      date: r.invoice_date,
      total: seeMoney && r.total != null ? Number(r.total) : null,
      status: r.status,
    })),
  });
}
