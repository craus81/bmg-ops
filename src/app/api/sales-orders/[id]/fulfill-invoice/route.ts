import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { claimSalesOrder, readFulfillInvoice, runFulfillInvoice, type FulfillInvoiceEstimate } from '@/lib/so-fulfill-invoice-run';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Fulfill & Invoice from the sales order page (Craig, 2026-10-31): the same
 * window as the estimate's button, for any sales order, including ones typed
 * straight into NetSuite. GET reads what's open, POST ships and bills it
 * (src/lib/so-fulfill-invoice-run.ts). Admins only; always ships from BMG
 * O'Fallon; nothing is emailed.
 */

const isNsId = (s: string) => /^\d{1,15}$/.test(s);

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  if (!isNsId(params.id)) return NextResponse.json({ error: 'Not a NetSuite sales order id' }, { status: 400 });
  try {
    const so = await readFulfillInvoice(createServiceClient(), params.id);
    return NextResponse.json({ salesOrderId: params.id, ...so });
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
  if (!isNsId(params.id)) return NextResponse.json({ error: 'Not a NetSuite sales order id' }, { status: 400 });
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { billNow, memo } = parsed.data;
  const soId = params.id;

  const supabase = createServiceClient();
  const { data: estimate } = await supabase
    .from('estimates')
    .select('id, estimate_number, customer_name, customer_netsuite_id, netsuite_so_number, po_number')
    .eq('netsuite_so_id', soId)
    .limit(1)
    .maybeSingle();

  const claim = await claimSalesOrder(supabase, soId);
  if (!claim.ok) return NextResponse.json({ error: claim.error }, { status: claim.status });

  try {
    const result = await runFulfillInvoice(supabase, {
      soId, billNow, memo, actorId: auth.user.id, estimate: (estimate as FulfillInvoiceEstimate | null) ?? null,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Fulfill & Invoice failed' }, { status: 500 });
  } finally {
    await claim.release();
  }
}
