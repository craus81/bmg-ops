import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createInvoiceFromSO, fulfillSalesOrderLines, SO_STATUS } from '@/lib/netsuite';
import { KNOWN_LOCATION_IDS } from '@/lib/invoice-location';
import { planFulfillInvoice } from '@/lib/so-fulfill-invoice';
import { readSoBillingLines } from '@/lib/so-fulfill-invoice-read';
import { saveOwnFulfillment } from '@/lib/books/own-fulfillments';
import { saveOwnInvoice } from '@/lib/books/own-invoices';
import { notifyPortalInvoice } from '@/lib/portal-invoice-notify';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Fulfill & Invoice an estimate's sales order — GET reads what's open, POST
 * ships and bills it. Parts-only orders that no vehicle, scan or check-in
 * ever touches (Craig, 2026-10-21): office/admin only, always shipped from
 * BMG O'Fallon, partial shipments allowed. How a request becomes a
 * fulfillment and an invoice is src/lib/so-fulfill-invoice.ts.
 *
 * Nothing is emailed: the window offers the normal invoice email screen and
 * a person presses Send.
 */

const OFALLON = KNOWN_LOCATION_IDS.ofallon;

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
    const { estimate } = await loadEstimate(params.id);
    if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
    if (!estimate.netsuite_so_id) return NextResponse.json({ error: 'This estimate has no sales order yet' }, { status: 409 });
    const so = await readSoBillingLines(String(estimate.netsuite_so_id), OFALLON);
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

  // Claim the estimate so a double click can't make two invoices (migration 422).
  const staleCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: claimRows, error: claimErr } = await supabase
    .from('estimates')
    .update({ fulfill_invoice_claimed_at: new Date().toISOString() })
    .eq('id', estimate.id)
    .or(`fulfill_invoice_claimed_at.is.null,fulfill_invoice_claimed_at.lt.${staleCutoff}`)
    .select('id');
  if (claimErr) return NextResponse.json({ error: 'Could not reserve this estimate for invoicing — try again' }, { status: 500 });
  if (!claimRows || claimRows.length === 0) {
    return NextResponse.json({ error: 'An invoice for this sales order is already being made — wait a moment, then reopen Fulfill & Invoice' }, { status: 409 });
  }
  const release = async () => {
    try {
      await supabase.from('estimates').update({ fulfill_invoice_claimed_at: null }).eq('id', estimate.id);
    } catch { /* the 15-minute takeover covers a lost release */ }
  };

  try {
    // Plan against the order as NetSuite has it now, not as the window last saw it.
    const so = await readSoBillingLines(soId, OFALLON);
    if (so.status === SO_STATUS.pendingApproval) {
      await release();
      return NextResponse.json({ error: 'The sales order is Pending Approval in NetSuite — approve it there first, then invoice.' }, { status: 409 });
    }
    if (so.status === SO_STATUS.cancelled || so.status === SO_STATUS.closed || so.status === SO_STATUS.billed) {
      await release();
      return NextResponse.json({ error: 'The sales order is already billed, closed or cancelled in NetSuite.' }, { status: 409 });
    }
    const plan = planFulfillInvoice(so.lines, Object.fromEntries(Object.entries(billNow).map(([k, v]) => [Number(k), v])));
    if (!plan.ok) {
      await release();
      return NextResponse.json({ error: plan.error }, { status: 400 });
    }

    const soLabel = so.soNumber || estimate.netsuite_so_number || soId;
    const memo = memoIn?.trim() || `Invoice from BMG FleetSuite — ${soLabel}${estimate.estimate_number ? ` (${estimate.estimate_number})` : ''}`;

    // Ship first; no invoice without its fulfillment (owner rule, 2026-09-05).
    let fulfillmentNumber: string | null = null;
    if (plan.shipLines.length > 0) {
      const fulfil = await fulfillSalesOrderLines({
        salesOrderId: soId,
        shipLines: plan.shipLines,
        excludeOrderLines: plan.excludeOrderLines,
        locationId: OFALLON,
      });
      if (!fulfil.success) {
        await release();
        return NextResponse.json({ error: `Could not fulfil the sales order, so nothing was invoiced: ${fulfil.error || 'NetSuite item fulfillment failed'}` }, { status: 502 });
      }
      fulfillmentNumber = fulfil.fulfillmentNumber || fulfil.fulfillmentId || null;
      if (fulfil.fulfillmentId) {
        await saveOwnFulfillment(supabase, {
          netsuiteId: fulfil.fulfillmentId,
          netsuiteNumber: fulfil.fulfillmentNumber || null,
          madeFrom: 'sales_order',
          madeFromId: estimate.id,
          madeBy: auth.user.id,
          salesOrderId: soId,
          locationId: OFALLON,
          shipped: plan.wholeRest ? null : plan.shipped,
        });
      }
    }

    const invoice = await createInvoiceFromSO({
      salesOrderId: soId,
      ...(plan.wholeRest ? {} : { installedQuantities: plan.billLines }),
      locationId: OFALLON,
      memo,
    });
    if (!invoice.success) {
      await release();
      return NextResponse.json({
        error: `${invoice.error || 'NetSuite did not make the invoice'}${fulfillmentNumber ? ` (the sales order WAS fulfilled: ${fulfillmentNumber} — only the invoice is missing; open Fulfill & Invoice again to bill it)` : ''}`,
        fulfillmentNumber,
      }, { status: 502 });
    }

    if (invoice.invoiceId) {
      await notifyPortalInvoice(supabase, {
        invoiceId: invoice.invoiceId,
        invoiceNumber: invoice.invoiceNumber || null,
        poNumber: so.poNumber || estimate.po_number || null,
        source: 'an estimate',
        detail: `SO ${soLabel}`,
        actorId: auth.user.id,
      });
    }
    await saveOwnInvoice(supabase, {
      netsuiteId: invoice.invoiceId,
      netsuiteNumber: invoice.invoiceNumber || null,
      madeFrom: 'sales_order',
      madeFromId: estimate.id,
      madeBy: auth.user.id,
      salesOrderId: soId,
      customerNetsuiteId: estimate.customer_netsuite_id || null,
      locationId: OFALLON,
      poNumber: so.poNumber || estimate.po_number || null,
      memo,
      billed: invoice.billed ?? null,
    });
    await logAudit(supabase, [{
      actorId: auth.user.id,
      table: 'estimates',
      recordId: estimate.id,
      action: 'fulfill_invoice',
      detail: {
        salesOrderId: soId,
        salesOrderNumber: soLabel,
        invoiceNumber: invoice.invoiceNumber || invoice.invoiceId || null,
        fulfillmentNumber,
        units: plan.units,
        wholeRest: plan.wholeRest,
      },
    }]);
    await release();

    return NextResponse.json({
      success: true,
      invoiceId: invoice.invoiceId || null,
      invoiceNumber: invoice.invoiceNumber || null,
      fulfillmentNumber,
      units: plan.units,
      customerName: so.customerName || estimate.customer_name || '',
      poNumber: so.poNumber || estimate.po_number || null,
      ...(invoice.invoiceId ? {} : { warning: 'NetSuite did not return the invoice id — find the new invoice in NetSuite' }),
    });
  } catch (e: any) {
    await release();
    return NextResponse.json({ error: e?.message || 'Fulfill & Invoice failed' }, { status: 500 });
  }
}
