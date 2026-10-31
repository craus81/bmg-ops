import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { claimSalesOrder, readFulfillInvoice, runFulfillInvoice } from '@/lib/so-fulfill-invoice-run';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Fulfill & Invoice an estimate's sales order — GET reads what's open, POST
 * ships and bills it. Parts-only orders that no vehicle, scan or check-in
 * ever touches (Craig, 2026-10-21): office/admin only, always shipped from
 * BMG O'Fallon, partial shipments allowed. How a request becomes a
 * fulfillment and an invoice is src/lib/so-fulfill-invoice.ts; the NetSuite
 * steps are shared with the sales order page (src/lib/so-fulfill-invoice-run.ts).
 *
 * Nothing is emailed: the window offers the normal invoice email screen and
 * a person presses Send.
 */

async function loadEstimate(id: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('estimates')
    .select('id, estimate_number, customer_name, customer_netsuite_id, netsuite_so_id, netsuite_so_number, po_number')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { supabase, estimate: data as null | {
    id: string; estimate_number: string | null; customer_name: string | null; customer_netsuite_id: string | null;
    netsuite_so_id: string | null; netsuite_so_number: string | null; po_number: string | null;
  } };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  try {
    const { supabase, estimate } = await loadEstimate(params.id);
    if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    if (!estimate.netsuite_so_id) return NextResponse.json({ error: 'This estimate has no sales order yet' }, { status: 409 });
    const so = await readFulfillInvoice(supabase, String(estimate.netsuite_so_id));
    return NextResponse.json({ salesOrderId: String(estimate.netsuite_so_id), ...so });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not read the sales order from NetSuite' }, { status: 502 });
  }
}

const Schema = z.object({
  /** SO line sequence number → quantity to bill now. */
  billNow: z.record(z.string().regex(/^\d{1,6}$/), z.number().min(0).max(100000)),
  memo: z.string().max(300).optional(),
});

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { billNow, memo: memoIn } = parsed.data;

  const { supabase, estimate } = await loadEstimate(params.id);
  if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  if (!estimate.netsuite_so_id) return NextResponse.json({ error: 'This estimate has no sales order yet' }, { status: 409 });
  const soId = String(estimate.netsuite_so_id);

  const claim = await claimSalesOrder(supabase, soId);
  if (!claim.ok) return NextResponse.json({ error: claim.error }, { status: claim.status });

  try {
    const result = await runFulfillInvoice(supabase, { soId, billNow, memo: memoIn, actorId: auth.user.id, estimate });
    return NextResponse.json(result.body, { status: result.status });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Fulfill & Invoice failed' }, { status: 500 });
  } finally {
    await claim.release();
  }
}
