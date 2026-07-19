import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createBillFromPo } from '@/lib/netsuite';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({ invoiceId: z.string().uuid() });

/**
 * POST /api/parts-mail/create-bill — turn a captured vendor parts invoice
 * into a NetSuite vendor bill by transforming its matched purchase order
 * (vendor, items, amounts all carry over; the vendor's invoice number
 * becomes the bill's Reference No.). Posting real financials, so it's an
 * explicit admin/finance click — never automatic.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'finance']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  const { data: invoice } = await service
    .from('vendor_parts_invoices')
    .select('*, netsuite_vendor_pos:matched_po_id (id, netsuite_id, tranid, vendor_name)')
    .eq('id', parsed.data.invoiceId)
    .maybeSingle();
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  if (invoice.status === 'billed') {
    return NextResponse.json({ error: `Already billed (${invoice.netsuite_bill_number || invoice.netsuite_bill_id})` }, { status: 409 });
  }
  const po = (invoice as any).netsuite_vendor_pos;
  if (!po?.netsuite_id) {
    return NextResponse.json({ error: 'Link this invoice to a vendor PO first — the bill is created from the PO.' }, { status: 422 });
  }

  const bill = await createBillFromPo({
    purchaseOrderId: po.netsuite_id,
    referenceNo: invoice.invoice_number || undefined,
    memo: `Parts invoice ${invoice.invoice_number || invoice.file_name} (via FleetSuite parts mail)`,
  });
  if (!bill.success) {
    return NextResponse.json({ error: bill.error || 'NetSuite bill creation failed' }, { status: 502 });
  }

  await service.from('vendor_parts_invoices').update({
    status: 'billed',
    netsuite_bill_id: bill.billId || null,
    netsuite_bill_number: bill.billNumber || null,
    billed_by: auth.user!.id,
    billed_at: new Date().toISOString(),
  }).eq('id', invoice.id);

  return NextResponse.json({ billId: bill.billId, billNumber: bill.billNumber, po: po.tranid });
}
