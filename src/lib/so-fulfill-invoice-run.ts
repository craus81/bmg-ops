import type { SupabaseClient } from '@supabase/supabase-js';
import { createInvoiceFromSO, fulfillSalesOrderLines, SO_STATUS } from '@/lib/netsuite';
import { KNOWN_LOCATION_IDS } from '@/lib/invoice-location';
import { planFulfillInvoice } from '@/lib/so-fulfill-invoice';
import { markDropShipLines, readSoBillingLines } from '@/lib/so-fulfill-invoice-read';
import { saveOwnFulfillment } from '@/lib/books/own-fulfillments';
import { saveOwnInvoice } from '@/lib/books/own-invoices';
import { notifyPortalInvoice } from '@/lib/portal-invoice-notify';
import { logAudit } from '@/lib/audit';

/**
 * Server only: ship and bill a sales order from O'Fallon (Fulfill & Invoice).
 * Shared by the estimate's button (/api/estimates/[id]/fulfill-invoice) and
 * the sales order page's (/api/sales-orders/[id]/fulfill-invoice). The
 * caller holds claimSalesOrder around this call; this never emails anyone.
 */

export const OFALLON = KNOWN_LOCATION_IDS.ofallon;

export interface FulfillInvoiceEstimate {
  id: string;
  estimate_number: string | null;
  customer_name: string | null;
  customer_netsuite_id: string | null;
  netsuite_so_number: string | null;
  po_number: string | null;
}

/**
 * Claim the sales order so a double click, or the estimate's button and the
 * sales order page's at once, can't make two fulfillments and two invoices
 * (migration 465). A claim older than 15 minutes is taken over.
 */
export async function claimSalesOrder(supabase: SupabaseClient, soId: string): Promise<
  { ok: true; release: () => Promise<void> } | { ok: false; status: number; error: string }
> {
  const now = new Date().toISOString();
  const staleCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  const { error: insertErr } = await supabase.from('so_invoice_claims').insert({ so_netsuite_id: soId, claimed_at: now });
  if (insertErr) {
    if (insertErr.code !== '23505') return { ok: false, status: 500, error: 'Could not reserve this sales order for invoicing — try again' };
    const { data: rows, error: claimErr } = await supabase
      .from('so_invoice_claims')
      .update({ claimed_at: now })
      .eq('so_netsuite_id', soId)
      .or(`claimed_at.is.null,claimed_at.lt.${staleCutoff}`)
      .select('so_netsuite_id');
    if (claimErr) return { ok: false, status: 500, error: 'Could not reserve this sales order for invoicing — try again' };
    if (!rows || rows.length === 0) {
      return { ok: false, status: 409, error: 'An invoice for this sales order is already being made — wait a moment, then reopen Fulfill & Invoice' };
    }
  }
  return {
    ok: true,
    release: async () => {
      try {
        await supabase.from('so_invoice_claims').update({ claimed_at: null }).eq('so_netsuite_id', soId);
      } catch { /* the 15-minute takeover covers a lost release */ }
    },
  };
}

export async function readFulfillInvoice(supabase: SupabaseClient, soId: string) {
  return markDropShipLines(supabase, soId, await readSoBillingLines(soId, OFALLON));
}

export async function runFulfillInvoice(supabase: SupabaseClient, input: {
  soId: string;
  billNow: Record<string, number>;
  memo?: string;
  actorId: string;
  /** The estimate the order came from, when there is one. */
  estimate: FulfillInvoiceEstimate | null;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { soId, billNow, actorId, estimate } = input;

  // Plan against the order as NetSuite has it now, not as the window last saw it.
  const so = await readFulfillInvoice(supabase, soId);
  if (so.status === SO_STATUS.pendingApproval) {
    return { status: 409, body: { error: 'The sales order is Pending Approval in NetSuite — approve it there first, then invoice.' } };
  }
  if (so.status === SO_STATUS.cancelled || so.status === SO_STATUS.closed || so.status === SO_STATUS.billed) {
    return { status: 409, body: { error: 'The sales order is already billed, closed or cancelled in NetSuite.' } };
  }
  const plan = planFulfillInvoice(so.lines, Object.fromEntries(Object.entries(billNow).map(([k, v]) => [Number(k), v])));
  if (!plan.ok) return { status: 400, body: { error: plan.error } };

  const soLabel = so.soNumber || estimate?.netsuite_so_number || soId;
  const memo = input.memo?.trim() || `Invoice from BMG FleetSuite — ${soLabel}${estimate?.estimate_number ? ` (${estimate.estimate_number})` : ''}`;
  const poNumber = so.poNumber || estimate?.po_number || null;
  const customerNetsuiteId = estimate?.customer_netsuite_id || so.customerNetsuiteId || null;
  const madeFromId = estimate?.id ?? null;

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
      return { status: 502, body: { error: `Could not fulfil the sales order, so nothing was invoiced: ${fulfil.error || 'NetSuite item fulfillment failed'}` } };
    }
    fulfillmentNumber = fulfil.fulfillmentNumber || fulfil.fulfillmentId || null;
    if (fulfil.fulfillmentId) {
      await saveOwnFulfillment(supabase, {
        netsuiteId: fulfil.fulfillmentId,
        netsuiteNumber: fulfil.fulfillmentNumber || null,
        madeFrom: 'sales_order',
        madeFromId,
        madeBy: actorId,
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
    return {
      status: 502,
      body: {
        error: `${invoice.error || 'NetSuite did not make the invoice'}${fulfillmentNumber ? ` (the sales order WAS fulfilled: ${fulfillmentNumber} — only the invoice is missing; open Fulfill & Invoice again to bill it)` : ''}`,
        fulfillmentNumber,
      },
    };
  }

  if (invoice.invoiceId) {
    await notifyPortalInvoice(supabase, {
      invoiceId: invoice.invoiceId,
      invoiceNumber: invoice.invoiceNumber || null,
      poNumber,
      source: estimate ? 'an estimate' : 'a sales order',
      detail: `SO ${soLabel}`,
      actorId,
    });
  }
  const books = await saveOwnInvoice(supabase, {
    netsuiteId: invoice.invoiceId,
    netsuiteNumber: invoice.invoiceNumber || null,
    madeFrom: 'sales_order',
    madeFromId,
    madeBy: actorId,
    salesOrderId: soId,
    customerNetsuiteId,
    locationId: OFALLON,
    poNumber,
    memo,
    billed: invoice.billed ?? null,
  });
  const invoiceLabel = invoice.invoiceNumber || invoice.invoiceId || null;
  const detail = {
    salesOrderId: soId,
    salesOrderNumber: soLabel,
    invoiceNumber: invoiceLabel,
    fulfillmentNumber,
    units: plan.units,
    wholeRest: plan.wholeRest,
  };
  await logAudit(supabase, [
    ...(estimate ? [{ actorId, table: 'estimates', recordId: estimate.id, action: 'fulfill_invoice', detail }] : []),
    // Shows under "Changes made in FleetSuite" on the sales order page.
    {
      actorId,
      table: 'netsuite_sales_orders',
      recordId: soId,
      action: 'fulfill_invoice',
      detail: {
        ...detail,
        changes: [`Fulfill & Invoice: ${plan.units} unit${plan.units !== 1 ? 's' : ''} billed${invoiceLabel ? ` on invoice ${invoiceLabel}` : ''}${fulfillmentNumber ? `, shipped on ${fulfillmentNumber}` : ''}`],
      },
    },
  ]);

  return {
    status: 200,
    body: {
      success: true,
      invoiceId: invoice.invoiceId || null,
      invoiceNumber: invoice.invoiceNumber || null,
      fulfillmentNumber,
      units: plan.units,
      customerName: so.customerName || estimate?.customer_name || '',
      customerNetsuiteId,
      poNumber,
      // Without the invoice's id there's no copy, so no certificate warning either.
      ...(!invoice.invoiceId ? { warning: 'NetSuite did not return the invoice id — find the new invoice in NetSuite' }
        : books.taxWarning ? { warning: books.taxWarning } : {}),
    },
  };
}
