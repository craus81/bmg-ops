import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { findPoByNumber, applyEmailToPo } from '@/lib/parts-email-scan';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * 404 for an unmatched PO number — but say *why*. If zero vendor POs are
 * synced, the problem is the NetSuite sync, not the number the user typed;
 * surfacing the synced count turns "no match" into an actionable message.
 */
async function noPoMatch(poNumber: string) {
  const { count } = await service
    .from('netsuite_vendor_pos')
    .select('*', { count: 'exact', head: true });
  const synced = count ?? 0;
  const detail = synced === 0
    ? ' — no vendor POs are synced from NetSuite yet. Check that the vendor-PO sync is running (More → System Health).'
    : ` (searched all ${synced} synced vendor POs). Enter it exactly as it appears in NetSuite.`;
  return NextResponse.json(
    { error: `No synced vendor PO matches "${poNumber}"${detail}`, syncedPoCount: synced },
    { status: 404 },
  );
}

const LinkSchema = z.object({
  emailId: z.string().uuid().optional(),
  // Captured-invoice rows can be linked/dismissed independently of their email.
  invoiceId: z.string().uuid().optional(),
  // Empty poNumber = dismiss (email → 'ignored', invoice → 'dismissed').
  poNumber: z.string().trim().max(60).optional().nullable(),
}).refine(d => !!d.emailId !== !!d.invoiceId, { message: 'Pass exactly one of emailId or invoiceId' });

/**
 * POST /api/parts-mail/link — resolve a review-queue email (link to a
 * vendor PO by PO number, applying its ETA/tracking, or dismiss it) or a
 * captured invoice (set its PO so it becomes billable, or dismiss it).
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, LinkSchema);
  if (parsed.error) return parsed.error;
  const { emailId, invoiceId, poNumber } = parsed.data;

  if (invoiceId) {
    const { data: invoice } = await service
      .from('vendor_parts_invoices').select('id, status').eq('id', invoiceId).maybeSingle();
    if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    if (!poNumber) {
      await service.from('vendor_parts_invoices')
        .update({ status: invoice.status === 'billed' ? invoice.status : 'dismissed' })
        .eq('id', invoiceId);
      return NextResponse.json({ status: 'dismissed' });
    }
    const po = await findPoByNumber(service, poNumber);
    if (!po) return noPoMatch(poNumber);
    await service.from('vendor_parts_invoices').update({ matched_po_id: po.id }).eq('id', invoiceId);
    return NextResponse.json({ status: 'linked', po: { tranid: po.tranid, vendor_name: po.vendor_name } });
  }

  if (!emailId) return NextResponse.json({ error: 'emailId required' }, { status: 400 });
  const { data: email } = await service
    .from('vendor_shipment_emails')
    .select('*')
    .eq('id', emailId)
    .maybeSingle();
  if (!email) return NextResponse.json({ error: 'Email not found' }, { status: 404 });

  if (!poNumber) {
    await service.from('vendor_shipment_emails')
      .update({ classification: 'ignored' })
      .eq('id', emailId);
    return NextResponse.json({ classification: 'ignored' });
  }

  const po = await findPoByNumber(service, poNumber);
  if (!po) return noPoMatch(poNumber);

  const outcome = await applyEmailToPo(
    service,
    {
      vendor_name: email.vendor_name,
      po_number: poNumber,
      ship_date: email.ship_date,
      eta_date: email.eta_date,
      tracking_number: email.tracking_number,
      carrier: email.carrier,
    },
    po,
    email.subject?.slice(0, 120) || 'manually linked email',
  );

  await service.from('vendor_shipment_emails')
    .update({ classification: outcome, matched_po_id: po.id, po_number: poNumber })
    .eq('id', emailId);

  // Captured invoices from this email inherit the match so they become
  // billable without a second linking step.
  await service.from('vendor_parts_invoices')
    .update({ matched_po_id: po.id })
    .eq('email_id', emailId)
    .is('matched_po_id', null);

  return NextResponse.json({ classification: outcome, po: { tranid: po.tranid, vendor_name: po.vendor_name } });
}
