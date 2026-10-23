import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { repFromName, sendEmailDetailed } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { getEmailSignature, renderSignatureHtml } from '@/lib/email-signature';
import { getNetSuitePdf, getVendorContact } from '@/lib/netsuite';
import { buildDropShipVendorEmail, EMPTY_SHIP_TO, type ShipTo } from '@/lib/drop-ship';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createServiceClient();

const Schema = z.object({
  dropShipId: z.string().uuid(),
  emails: z.array(z.string().email().max(254)).max(20).default([]),
  bccSelf: z.boolean().optional().default(false),
  cc: z.array(z.string().email().max(254)).max(10).optional(),
  message: z.string().trim().max(10_000).optional().default(''),
  preview: z.boolean().optional().default(false),
});

/**
 * POST /api/estimates/[id]/drop-ship/email — "Email vendor…" after a drop
 * ship PO is made. The standard compose contract (docs/customer-email-
 * standard.md): preview renders with no side effects and prefills To with
 * the vendor's NetSuite email; a real send attaches the PO PDF from NetSuite
 * and fails before sending when the PDF can't be made. Never automatic.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const p = parsed.data;

  const { data: ds } = await supabase
    .from('drop_ship_orders')
    .select('id, estimate_id, sales_order_number, purchase_order_id, purchase_order_number, vendor_netsuite_id, vendor_name, ship_to, lines')
    .eq('id', p.dropShipId)
    .maybeSingle();
  if (!ds || ds.estimate_id !== params.id) return NextResponse.json({ error: 'Drop ship PO not found on this estimate' }, { status: 404 });
  if (!ds.purchase_order_id) return NextResponse.json({ error: 'This drop ship has no NetSuite PO to send' }, { status: 409 });

  const { data: estimate } = await supabase.from('estimates').select('customer_name').eq('id', params.id).maybeSingle();
  const poNumber = String(ds.purchase_order_number || ds.purchase_order_id);
  const shipTo: ShipTo = { ...EMPTY_SHIP_TO, ...((ds.ship_to || {}) as Partial<ShipTo>) };
  const pdfName = deepLinks.poPdfFileName(ds.purchase_order_number, ds.purchase_order_id);
  const signature = await getEmailSignature(supabase, auth.user.id);
  const { subject, html } = buildDropShipVendorEmail({
    poNumber,
    customerName: shipTo.name || estimate?.customer_name || '',
    shipTo,
    lines: ((ds.lines || []) as any[]).map(l => ({ itemNumber: String(l.itemNumber || ''), description: String(l.description || ''), quantity: Number(l.quantity) || 0 })),
    message: p.message,
    signatureHtml: renderSignatureHtml(signature, 'light'),
    pdfName,
  });

  if (p.preview) {
    let to: string | null = null;
    if (ds.vendor_netsuite_id) {
      try { to = (await getVendorContact(String(ds.vendor_netsuite_id))).email || null; } catch { /* typed by hand */ }
    }
    return NextResponse.json({ preview: true, to, subject, html, attachments: [pdfName] });
  }
  if (!p.emails.length) return NextResponse.json({ error: 'Enter at least one recipient email address.' }, { status: 400 });

  // The PO PDF goes first; no PDF, no send.
  const pdf = await getNetSuitePdf('purchaseOrder', String(ds.purchase_order_id), { timeoutMs: 45_000 });
  if (!pdf.success || !pdf.pdfBase64) {
    return NextResponse.json({ error: `Could not get the PO PDF from NetSuite, so nothing was sent: ${pdf.error || 'no PDF came back'}` }, { status: 502 });
  }

  const { data: me } = await supabase.from('profiles').select('full_name').eq('id', auth.user.id).maybeSingle();
  const bcc = p.bccSelf && auth.user.email ? [auth.user.email] : undefined;
  const { ok } = await sendEmailDetailed(
    p.emails, subject, html, undefined,
    [{ filename: pdfName, content: Buffer.from(pdf.pdfBase64, 'base64'), contentType: 'application/pdf' }],
    auth.user.email || undefined, bcc,
    {
      kind: 'drop_ship_po',
      cc: p.cc,
      sentBy: auth.user.id,
      contextUrl: deepLinks.estimate(params.id),
      fromName: repFromName(me?.full_name),
    },
  );
  if (!ok) return NextResponse.json({ error: 'Email send failed (is Resend configured?)' }, { status: 502 });

  await supabase.from('drop_ship_orders').update({ emailed_at: new Date().toISOString(), emailed_to: p.emails }).eq('id', ds.id);
  await logAudit(supabase, { actorId: auth.user.id, table: 'estimates', recordId: params.id, action: 'drop_ship_po_emailed', detail: { purchaseOrder: poNumber, emailed: p.emails } });
  return NextResponse.json({ success: true, to: p.emails, bcc: bcc || [] });
}
