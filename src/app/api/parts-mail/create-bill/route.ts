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

  // Atomic claim (migration 251): the status check above is check-then-act,
  // so two concurrent clicks could both pass it and post two real vendor
  // bills (Round 3 §7.2.4). Degrades gracefully while the schema cache
  // lags (#741).
  let claimActive = false;
  const staleCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data: claimRows, error: claimErr } = await service
    .from('vendor_parts_invoices')
    .update({ bill_claimed_at: new Date().toISOString() })
    .eq('id', invoice.id)
    .or(`bill_claimed_at.is.null,bill_claimed_at.lt.${staleCutoff}`)
    .select('id');
  if (claimErr) {
    if ((claimErr as any).code === 'PGRST204' || /bill_claimed_at/i.test(claimErr.message || '')) {
      console.warn('create-bill: claim column not in schema cache yet — proceeding unclaimed');
    } else {
      return NextResponse.json({ error: 'Could not reserve this invoice for billing — try again' }, { status: 503 });
    }
  } else if (!claimRows || claimRows.length === 0) {
    return NextResponse.json({ error: 'A bill for this invoice is already being created — wait a moment and refresh.' }, { status: 409 });
  } else {
    claimActive = true;
  }

  const bill = await createBillFromPo({
    purchaseOrderId: po.netsuite_id,
    referenceNo: invoice.invoice_number || undefined,
    memo: `Parts invoice ${invoice.invoice_number || invoice.file_name} (via FleetSuite parts mail)`,
  });
  if (!bill.success) {
    if (claimActive) {
      try {
        await service.from('vendor_parts_invoices').update({ bill_claimed_at: null }).eq('id', invoice.id);
      } catch { /* stale takeover covers a lost release */ }
    }
    return NextResponse.json({ error: bill.error || 'NetSuite bill creation failed' }, { status: 502 });
  }

  // The bill EXISTS from here on — never report failure, never stamp falsy
  // (R3-8): this stamp used to be unchecked, so a failed write left the
  // invoice re-billable with a real bill already posted.
  const { error: stampErr } = await service.from('vendor_parts_invoices').update({
    status: 'billed',
    netsuite_bill_id: bill.billId || 'created-id-unknown',
    netsuite_bill_number: bill.billNumber || null,
    billed_by: auth.user!.id,
    billed_at: new Date().toISOString(),
    ...(claimActive ? { bill_claimed_at: null } : {}),
  }).eq('id', invoice.id);
  if (stampErr) {
    // Keep the claim held so a retry can't double-bill while the stamp is
    // missing; the stale takeover reopens it after 15 minutes.
    console.error('create-bill: billed stamp failed after NetSuite create:', stampErr.message);
    return NextResponse.json({
      billId: bill.billId,
      billNumber: bill.billNumber,
      po: po.tranid,
      warning: `The bill was created in NetSuite but the billed stamp failed (${stampErr.message}) — mark this invoice billed by hand before retrying anything.`,
    });
  }

  return NextResponse.json({ billId: bill.billId, billNumber: bill.billNumber, po: po.tranid });
}
