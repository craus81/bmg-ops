import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createInvoiceFromSO, fulfillSalesOrder } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/vehicle-tracking/invoice — admin-only (field ask, 2026-08-21:
 * "the vehicle completion process should let you turn the sales order or
 * estimate into a NetSuite invoice").
 *
 * Fulfils the sales order first — one Item Fulfillment for every open line
 * (owner rule, 2026-09-05: an invoiced SO must be fulfilled; billing straight
 * off it left orders at Pending Fulfillment with inventory never relieved) —
 * then bills the FULL sales order via NetSuite's SO→invoice transform (memo
 * and location inherited from the SO, so the vehicle context the SO carries
 * survives onto the invoice), then stamps the check-in's invoice fields —
 * the same ones the archived view shows and the unpaid-invoices tile reads.
 * The estimate path is driven client-side: an un-converted estimate goes
 * through /api/estimates/convert-to-so first (with its approval gate), then
 * lands here with the fresh SO id.
 *
 * Body: { checkinId, salesOrderId } — the SO must be linked to the check-in
 * (join table or legacy column). One invoice per check-in: an already-
 * stamped invoice_number returns 409 with the existing number.
 */
const Schema = z.object({
  checkinId: z.string().uuid(),
  salesOrderId: z.string().regex(/^\d{1,15}$/),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { checkinId, salesOrderId } = parsed.data;

  try {
    const { data: checkin, error: cErr } = await supabase
      .from('fleet_checkins')
      .select('id, vin, customer_name, invoice_number, netsuite_sales_order_id')
      .eq('id', checkinId)
      .maybeSingle();
    if (cErr || !checkin) {
      return NextResponse.json({ error: 'Check-in not found' }, { status: 404 });
    }

    if (checkin.invoice_number) {
      return NextResponse.json({
        error: `This vehicle already has invoice #${checkin.invoice_number}. Clear the invoice field on the card first if it needs re-invoicing.`,
        invoiceNumber: checkin.invoice_number,
      }, { status: 409 });
    }

    // The SO must actually belong to this check-in — join table or the
    // legacy primary column (older rows predate the join table).
    const { data: link } = await supabase
      .from('fleet_checkin_sales_orders')
      .select('id')
      .eq('checkin_id', checkinId)
      .eq('netsuite_sales_order_id', salesOrderId)
      .maybeSingle();
    if (!link && String(checkin.netsuite_sales_order_id || '') !== salesOrderId) {
      return NextResponse.json({ error: 'That sales order is not linked to this vehicle.' }, { status: 400 });
    }

    // Fulfil every line first. Fail closed: an invoice without its
    // fulfillment is the exact state this step exists to prevent.
    const fulfil = await fulfillSalesOrder(salesOrderId);
    if (!fulfil.success) {
      return NextResponse.json({
        error: `Could not fulfil the sales order, so it was not invoiced: ${fulfil.error || 'NetSuite item fulfillment failed'}`,
        step: 'fulfillment',
      }, { status: 502 });
    }

    // Full-SO transform: no line overrides, no memo/location overrides —
    // everything the SO carries (vehicle memo, VIN custom field, location)
    // inherits onto the invoice.
    const result = await createInvoiceFromSO({ salesOrderId });
    if (!result.success) {
      // The fulfillment already posted — say so, so nobody fulfils it twice by hand.
      return NextResponse.json({
        error: `${result.error || 'NetSuite invoice create failed'}${fulfil.fulfillmentNumber ? ` (the sales order WAS fulfilled: ${fulfil.fulfillmentNumber} — only the invoice is missing)` : ''}`,
        step: 'invoice',
        fulfillmentNumber: fulfil.fulfillmentNumber || null,
      }, { status: 502 });
    }

    // Stamp the check-in's invoice fields (migration 070). The invoice
    // exists in NetSuite either way, so the stamp must always be truthy —
    // a null here would re-arm the 409 guard above and invite a duplicate.
    // An internal-id fallback is fine: the AR payment sync resolves
    // internal ids to tranids (Round 3 §7.2.8 — it used to match tranid
    // only, so these rows could never be marked paid).
    const stampNumber = result.invoiceNumber
      || (result.invoiceId ? String(result.invoiceId) : 'created-id-unknown');
    const { error: stampErr } = await supabase
      .from('fleet_checkins')
      .update({
        invoice_number: stampNumber,
        date_invoiced: new Date().toISOString().slice(0, 10),
        updated_at: new Date().toISOString(),
      })
      .eq('id', checkinId);
    if (stampErr) console.error('checkin invoice stamp failed:', stampErr.message);

    return NextResponse.json({
      success: true,
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber || result.invoiceId,
      fulfillmentId: fulfil.fulfillmentId || null,
      fulfillmentNumber: fulfil.fulfillmentNumber || null,
      // 'already_fulfilled' = the SO was past fulfillment before this call.
      fulfillmentSkipped: fulfil.skipped || null,
    });
  } catch (err: any) {
    console.error('vehicle invoice error:', err);
    return NextResponse.json({ error: err?.message || 'Failed to create invoice' }, { status: 500 });
  }
}
