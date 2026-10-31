import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { profileHasFeature, requireAuth } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createSalesOrder } from '@/lib/netsuite';
import { KNOWN_LOCATION_IDS } from '@/lib/invoice-location';
import { loadTypedItems, searchTypedItems } from '@/lib/typed-line-items';
import { getSalesTaxRate } from '@/lib/sales-tax';
import { enforceCustomerHold } from '@/lib/customer-hold-server';
import { shippingAddressBody } from '@/lib/drop-ship';
import { logAudit } from '@/lib/audit';
import {
  MAX_LINES, formatCents, netsuiteLines, workOutNewInvoice, type NewInvoiceLineDraft,
} from '@/lib/new-invoice';
import {
  NEW_SALES_ORDER_FEATURES, centralToday, mirrorRow, shipToForNetSuite, shipToProblem,
} from '@/lib/new-sales-order';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/** Anyone with the Estimates or the Invoicing permission (Craig 2026-10-31, 1A). */
async function requireSalesOrderMaker(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth;
  for (const key of NEW_SALES_ORDER_FEATURES) {
    if (await profileHasFeature(auth.user.id, auth.profile, key)) return auth;
  }
  return { ...auth, error: NextResponse.json({ error: 'You need the Estimates or Invoicing permission to make sales orders.' }, { status: 403 }) };
}

/**
 * GET /api/sales-orders/new?q=… — items for a line (any active NetSuite item in the catalog, not layout lines).
 * GET /api/sales-orders/new?customer=<NetSuite id> — whether that customer is tax exempt, and the tax rate.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSalesOrderMaker(req);
  if (auth.error) return auth.error;

  const customer = (req.nextUrl.searchParams.get('customer') || '').trim();
  if (customer) {
    if (!/^\d+$/.test(customer)) return NextResponse.json({ error: 'Bad customer id' }, { status: 400 });
    const { data } = await service.from('customers').select('company_name, tax_exempt').eq('netsuite_id', customer).limit(1).maybeSingle();
    return NextResponse.json({ name: data?.company_name ?? null, taxExempt: !!data?.tax_exempt, taxRate: await getSalesTaxRate(service) });
  }

  const { items, error } = await searchTypedItems(service, req.nextUrl.searchParams.get('q') || '');
  if (error) return NextResponse.json({ error }, { status: 500 });
  return NextResponse.json({ items });
}

const Schema = z.object({
  // Made by the page when the form opens: the same form pressed twice is one order.
  requestId: z.string().uuid(),
  customerNetsuiteId: z.string().regex(/^\d+$/),
  customerName: z.string().max(200).optional().nullable(),
  poNumber: z.string().max(45).optional().nullable(),
  memo: z.string().max(999).optional().nullable(),
  vin: z.string().max(17).optional().nullable(),
  shipTo: z.object({
    name: z.string().max(150),
    address: z.string().max(150),
    city: z.string().max(50),
    state: z.string().max(30),
    zip: z.string().max(20),
  }).optional().nullable(),
  lines: z.array(z.object({
    itemId: z.string().regex(/^\d+$/),
    quantity: z.number().min(0).max(1_000_000),
    price: z.number().min(0).max(10_000_000),
    description: z.string().max(4000).optional().nullable(),
  })).min(1).max(MAX_LINES),
});

/**
 * POST /api/sales-orders/new — make a NetSuite sales order from typed lines, from O'Fallon, dated today. Item types,
 * tax and totals are worked out here from the catalog, never taken from the page. Nothing is billed and no FleetSuite
 * job is made; the order goes on the Sales orders list straight away.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSalesOrderMaker(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const clean = (s: string | null | undefined) => (s ?? '').trim() || null;
  const poNumber = clean(body.poNumber);
  const memo = clean(body.memo);
  const vin = clean(body.vin)?.toUpperCase() ?? null;

  const shipProblem = body.shipTo ? shipToProblem(body.shipTo) : null;
  if (shipProblem) return NextResponse.json({ error: shipProblem }, { status: 400 });
  const shipTo = body.shipTo ? shipToForNetSuite(body.shipTo) : null;

  // The items as the catalog has them.
  const { byId, missing, error: partsError } = await loadTypedItems(service, body.lines.map(l => l.itemId));
  if (partsError) return NextResponse.json({ error: partsError }, { status: 500 });
  if (missing.length > 0) {
    return NextResponse.json({ error: `These items aren't in the parts catalog: ${missing.join(', ')}. Remove them and pick them again.` }, { status: 400 });
  }

  const { data: cust } = await service.from('customers').select('company_name, tax_exempt').eq('netsuite_id', body.customerNetsuiteId).limit(1).maybeSingle();
  const taxExempt = !!cust?.tax_exempt;
  const customerName = cust?.company_name ?? clean(body.customerName);

  const drafts: NewInvoiceLineDraft[] = body.lines.map(l => {
    const item = byId.get(l.itemId)!;
    return {
      itemId: item.itemId, itemNumber: item.itemNumber, itemType: item.itemType, taxableOverride: item.taxableOverride,
      description: (l.description ?? '').trim() || item.description, quantity: l.quantity, price: l.price,
    };
  });
  const worked = workOutNewInvoice(drafts, { taxRate: await getSalesTaxRate(service), taxExempt, hasCustomer: true, noun: 'sales order' });
  if (worked.problems.length > 0) return NextResponse.json({ error: worked.problems.join(' ') }, { status: 400 });

  // Customer on hold for past-due invoices (migration 366): needs an admin / A/R override with a reason.
  const held = await enforceCustomerHold(req, service, auth, {
    netsuiteId: body.customerNetsuiteId, customerName, action: 'sales_order', recordId: body.requestId,
  });
  if (held) return held;

  // One order per form: take the claim, or say what the earlier press did.
  const row = {
    id: body.requestId,
    customer_netsuite_id: body.customerNetsuiteId,
    customer_name: customerName,
    po_number: poNumber,
    memo,
    vin,
    ship_to: shipTo ? { name: shipTo.name, address: shipTo.address, city: shipTo.city, state: shipTo.state, zip: shipTo.zip } : null,
    lines: worked.lines.map(l => ({
      itemId: l.itemId, itemNumber: l.itemNumber, description: l.description, quantity: l.quantity,
      price: l.price, discount: l.isDiscount, taxable: l.taxable,
    })),
    total_cents: worked.totalCents,
    created_by: auth.user.id,
    claimed_at: new Date().toISOString(),
  };
  const { error: insertError } = await service.from('typed_sales_orders').insert(row);
  if (insertError) {
    if (insertError.code !== '23505') return NextResponse.json({ error: insertError.message }, { status: 500 });
    const { data: earlier } = await service.from('typed_sales_orders')
      .select('netsuite_so_id, netsuite_so_number').eq('id', body.requestId).maybeSingle();
    if (earlier?.netsuite_so_id) {
      return NextResponse.json({
        success: true, already: true, salesOrderId: earlier.netsuite_so_id, salesOrderNumber: earlier.netsuite_so_number,
        customerName, totalCents: worked.totalCents,
      });
    }
    const { data: claimed } = await service.from('typed_sales_orders')
      .update({ ...row, error: null, updated_at: new Date().toISOString() })
      .eq('id', body.requestId).is('claimed_at', null).is('netsuite_so_id', null)
      .select('id');
    if (!claimed || claimed.length === 0) {
      return NextResponse.json({
        error: "This sales order is already being made. Don't press again: check Sales orders in a minute before you try another.",
      }, { status: 409 });
    }
  }

  const orderDate = centralToday();
  const result = await createSalesOrder({
    customerId: body.customerNetsuiteId,
    poNumber: poNumber ?? undefined,
    locationId: KNOWN_LOCATION_IDS.ofallon,
    orderDate,
    memo: memo ?? undefined,
    vin,
    ...(shipTo ? { shippingAddress: shippingAddressBody(shipTo) } : {}),
    lineItems: netsuiteLines(worked.lines, { taxExempt }),
  });

  if (!result.success || !result.salesOrderId) {
    const error = result.error || "NetSuite didn't make the sales order.";
    // NetSuite refused, so nothing was made: let go of the claim so the same form can try again.
    await service.from('typed_sales_orders').update({ error: error.slice(0, 2000), claimed_at: null, updated_at: new Date().toISOString() }).eq('id', body.requestId);
    return NextResponse.json({ error }, { status: 502 });
  }

  await service.from('typed_sales_orders').update({
    netsuite_so_id: result.salesOrderId,
    netsuite_so_number: result.salesOrderNumber || null,
    error: null,
    updated_at: new Date().toISOString(),
  }).eq('id', body.requestId);

  // On the Sales orders list now rather than after the next sync (which overwrites it with NetSuite's own row).
  await service.from('netsuite_sales_orders').upsert(mirrorRow({
    netsuiteId: result.salesOrderId,
    number: result.salesOrderNumber || null,
    customerNetsuiteId: body.customerNetsuiteId,
    customerName,
    date: orderDate,
    poNumber,
    memo,
    vin,
    totalCents: worked.totalCents,
  }), { onConflict: 'netsuite_id', ignoreDuplicates: true });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'typed_sales_orders',
    recordId: body.requestId,
    action: 'create',
    detail: {
      netsuite_so_id: result.salesOrderId,
      netsuite_so_number: result.salesOrderNumber || null,
      customer: customerName,
      total: formatCents(worked.totalCents),
      lines: worked.lines.length,
      ship_to: shipTo ? 'typed' : 'customer default',
    },
  });

  return NextResponse.json({
    success: true,
    salesOrderId: result.salesOrderId,
    salesOrderNumber: result.salesOrderNumber || null,
    customerName,
    totalCents: worked.totalCents,
  });
}
