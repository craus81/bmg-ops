import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createDirectInvoice } from '@/lib/netsuite';
import { KNOWN_LOCATION_IDS } from '@/lib/invoice-location';
import { loadTypedItems, searchTypedItems } from '@/lib/typed-line-items';
import { saveOwnInvoice } from '@/lib/books/own-invoices';
import { getSalesTaxRate } from '@/lib/sales-tax';
import { logAudit } from '@/lib/audit';
import {
  MAX_LINES, booksLines, formatCents, netsuiteLines, workOutNewInvoice,
  type NewInvoiceLineDraft,
} from '@/lib/new-invoice';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * GET /api/invoices/new?q=… — items for a line (any active NetSuite item in the catalog, not layout lines).
 * GET /api/invoices/new?customer=<NetSuite id> — whether that customer is tax exempt.
 */
export async function GET(req: NextRequest) {
  const auth = await requireFeature(req, 'invoicing');
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
  // Made by the page when the form opens: the same form pressed twice is one invoice.
  requestId: z.string().uuid(),
  customerNetsuiteId: z.string().regex(/^\d+$/),
  customerName: z.string().max(200).optional().nullable(),
  poNumber: z.string().max(45).optional().nullable(),
  memo: z.string().max(999).optional().nullable(),
  vin: z.string().max(17).optional().nullable(),
  lines: z.array(z.object({
    itemId: z.string().regex(/^\d+$/),
    quantity: z.number().min(0).max(1_000_000),
    price: z.number().min(0).max(10_000_000),
    description: z.string().max(4000).optional().nullable(),
  })).min(1).max(MAX_LINES),
});

/**
 * POST /api/invoices/new — make a standalone NetSuite invoice from typed lines (no sales order), from O'Fallon, and
 * keep Books' copy. Item types, tax and totals are worked out here from the catalog, never taken from the page.
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'invoicing');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const clean = (s: string | null | undefined) => (s ?? '').trim() || null;
  const poNumber = clean(body.poNumber);
  const memo = clean(body.memo);
  const vin = clean(body.vin)?.toUpperCase() ?? null;

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
  const worked = workOutNewInvoice(drafts, { taxRate: await getSalesTaxRate(service), taxExempt, hasCustomer: true });
  if (worked.problems.length > 0) return NextResponse.json({ error: worked.problems.join(' ') }, { status: 400 });

  // One invoice per form: take the claim, or say what the earlier press did.
  const row = {
    id: body.requestId,
    customer_netsuite_id: body.customerNetsuiteId,
    customer_name: customerName,
    po_number: poNumber,
    memo,
    vin,
    lines: worked.lines.map(l => ({
      itemId: l.itemId, itemNumber: l.itemNumber, description: l.description, quantity: l.quantity,
      price: l.price, discount: l.isDiscount, taxable: l.taxable,
    })),
    total_cents: worked.totalCents,
    created_by: auth.user.id,
    claimed_at: new Date().toISOString(),
  };
  const { error: insertError } = await service.from('typed_invoices').insert(row);
  if (insertError) {
    if (insertError.code !== '23505') return NextResponse.json({ error: insertError.message }, { status: 500 });
    const { data: earlier } = await service.from('typed_invoices')
      .select('netsuite_invoice_id, netsuite_invoice_number').eq('id', body.requestId).maybeSingle();
    if (earlier?.netsuite_invoice_id) {
      return NextResponse.json({
        success: true, already: true, invoiceId: earlier.netsuite_invoice_id, invoiceNumber: earlier.netsuite_invoice_number,
        customerName, customerNetsuiteId: body.customerNetsuiteId, poNumber, totalCents: worked.totalCents,
      });
    }
    const { data: claimed } = await service.from('typed_invoices')
      .update({ ...row, error: null, updated_at: new Date().toISOString() })
      .eq('id', body.requestId).is('claimed_at', null).is('netsuite_invoice_id', null)
      .select('id');
    if (!claimed || claimed.length === 0) {
      return NextResponse.json({
        error: "This invoice is already being made. Don't press again: check Invoicing → Invoiced in a minute before you try another.",
      }, { status: 409 });
    }
  }

  const locationId = KNOWN_LOCATION_IDS.ofallon;
  const result = await createDirectInvoice({
    customerId: body.customerNetsuiteId,
    locationId,
    poNumber: poNumber ?? undefined,
    memo: memo ?? undefined,
    vin,
    lineItems: netsuiteLines(worked.lines, { taxExempt }),
  });

  if (!result.success || !result.invoiceId) {
    const error = result.error || "NetSuite didn't make the invoice.";
    // NetSuite refused, so nothing was made: let go of the claim so the same form can try again.
    await service.from('typed_invoices').update({ error: error.slice(0, 2000), claimed_at: null, updated_at: new Date().toISOString() }).eq('id', body.requestId);
    return NextResponse.json({ error }, { status: 502 });
  }

  await service.from('typed_invoices').update({
    netsuite_invoice_id: result.invoiceId,
    netsuite_invoice_number: result.invoiceNumber || null,
    error: null,
    updated_at: new Date().toISOString(),
  }).eq('id', body.requestId);

  // FleetSuite's own copy of the invoice, for the books (never fails the invoice).
  const books = await saveOwnInvoice(service, {
    netsuiteId: result.invoiceId,
    netsuiteNumber: result.invoiceNumber || null,
    madeFrom: 'typed',
    madeFromId: body.requestId,
    madeBy: auth.user.id,
    customerNetsuiteId: body.customerNetsuiteId,
    locationId: result.locationId ?? locationId,
    poNumber,
    memo,
    vin,
    billed: booksLines(worked.lines),
  });

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'typed_invoices',
    recordId: body.requestId,
    action: 'create',
    detail: {
      netsuite_invoice_id: result.invoiceId,
      netsuite_invoice_number: result.invoiceNumber || null,
      customer: customerName,
      total: formatCents(worked.totalCents),
      lines: worked.lines.length,
    },
  });

  return NextResponse.json({
    success: true,
    invoiceId: result.invoiceId,
    invoiceNumber: result.invoiceNumber || null,
    customerName,
    customerNetsuiteId: body.customerNetsuiteId,
    poNumber,
    totalCents: worked.totalCents,
    ...(books.saved || books.reason === 'already saved' ? {} : { warning: `Books didn't keep its copy (${books.reason}). The invoice is in NetSuite.` }),
    ...(books.taxWarning ? { taxWarning: books.taxWarning } : {}),
  });
}
