import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature, requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { buildNotificationEmail, repFromName, sendEmailDetailed } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { getEmailSignature } from '@/lib/email-signature';
import { getNetSuitePdf, getVendorContact } from '@/lib/netsuite';
import { docRef } from '@/lib/document-sends';
import { logAudit } from '@/lib/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const supabase = createServiceClient();

const Schema = z.object({
  emails: z.array(z.string().email().max(254)).max(20).default([]),
  bccSelf: z.boolean().optional().default(false),
  cc: z.array(z.string().email().max(254)).max(10).optional(),
  message: z.string().trim().max(10_000).optional().default(''),
  preview: z.boolean().optional().default(false),
});

/**
 * POST /api/purchase-requests/vendor-pos/[id]/email — ✉ Email vendor on
 * Purchasing → Vendor POs (Craig, 2026-10-31). [id] is the netsuite_vendor_pos
 * row. The standard compose contract: preview suggests the vendor's email
 * (the vendor mirror, else NetSuite's vendor record) with no side effects; a
 * real send attaches NetSuite's PO PDF and fails before sending when the PDF
 * can't be made. Never automatic. Logged as vendor_po:<PO number>.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;
  const admin = await requireAdmin(req);
  if (admin.error) return admin.error;
  if (!z.string().uuid().safeParse(params.id).success) return NextResponse.json({ error: 'Invalid PO id' }, { status: 400 });
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const p = parsed.data;

  const { data: po } = await supabase
    .from('netsuite_vendor_pos')
    .select('id, netsuite_id, tranid, vendor_netsuite_id, vendor_name')
    .eq('id', params.id)
    .maybeSingle();
  if (!po) return NextResponse.json({ error: 'Vendor PO not found' }, { status: 404 });
  if (!po.netsuite_id) return NextResponse.json({ error: 'This PO has not reached NetSuite yet, so there is no PDF to send.' }, { status: 409 });

  const poNumber = String(po.tranid || po.netsuite_id);
  const pdfName = deepLinks.poPdfFileName(po.tranid, po.netsuite_id);
  const docName = `Purchase Order #${poNumber}`;
  const subject = `[BMG Fleet] ${docName}`;
  const bodyText = `Attached is ${docName} from BMG Fleet Installations${po.vendor_name ? ` for ${po.vendor_name}` : ''}. Please confirm the order and reply with the ship date and tracking number once it ships.`;
  const signature = await getEmailSignature(supabase, auth.user.id);
  const html = buildNotificationEmail(docName, bodyText, undefined, undefined, {
    note: p.message || undefined,
    attachmentNames: [pdfName],
    signature,
  });

  if (p.preview) {
    let to: string | null = null;
    if (po.vendor_netsuite_id) {
      const { data: v } = await supabase.from('netsuite_vendors').select('email').eq('netsuite_id', String(po.vendor_netsuite_id)).maybeSingle();
      to = (v as any)?.email || null;
      if (!to) {
        try { to = (await getVendorContact(String(po.vendor_netsuite_id))).email || null; } catch { /* typed by hand */ }
      }
    }
    return NextResponse.json({ preview: true, to, subject, html, attachments: [pdfName] });
  }
  if (!p.emails.length) return NextResponse.json({ error: 'Enter at least one recipient email address.' }, { status: 400 });

  // The PO PDF goes first; no PDF, no send.
  const pdf = await getNetSuitePdf('purchaseOrder', String(po.netsuite_id), { timeoutMs: 45_000 });
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
      kind: 'vendor_po',
      cc: p.cc,
      sentBy: auth.user.id,
      contextUrl: deepLinks.vendorPo(poNumber),
      docRefs: [docRef('vendor_po', poNumber)],
      fromName: repFromName(me?.full_name),
    },
  );
  if (!ok) return NextResponse.json({ error: 'Email send failed (is Resend configured?)' }, { status: 502 });

  await logAudit(supabase, { actorId: auth.user.id, table: 'email_log', recordId: po.id, action: 'vendor_po_emailed', detail: { purchaseOrder: poNumber, emailed: p.emails } });
  return NextResponse.json({ success: true, to: p.emails, bcc: bcc || [] });
}
