import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { buildNotificationEmail, repFromName, sendEmailDetailed } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { getEmailSignature } from '@/lib/email-signature';
import { getNetSuitePdf, getSalesOrderRecord } from '@/lib/netsuite';
import { parseSalesOrderRecord } from '@/lib/sales-order-edit';
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
 * POST /api/sales-orders/[id]/email — ✉ Email on the sales order page
 * (Craig, 2026-10-31). The standard compose contract (docs/customer-email-
 * standard.md): preview renders with no side effects and suggests To (whoever
 * approved the estimate, else the customer's billing email); a real send
 * attaches NetSuite's sales order PDF and fails before sending when the PDF
 * can't be made. Never automatic. The send is logged against
 * sales_order:<SO number> so the page's Sent box shows it.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;
  if (!/^\d{1,15}$/.test(params.id)) return NextResponse.json({ error: 'Not a NetSuite sales order id' }, { status: 400 });
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const p = parsed.data;

  const rec = await getSalesOrderRecord(params.id);
  if (!rec.success) return NextResponse.json({ error: `Couldn't read the sales order from NetSuite: ${rec.error}` }, { status: 502 });
  const h = parseSalesOrderRecord(rec.record).header;
  const soNumber = h.tranId || params.id;
  const pdfName = `${String(soNumber).replace(/[^\w-]+/g, '_')}.pdf`;

  const [{ data: estimate }, { data: customer }, { data: settings }] = await Promise.all([
    supabase.from('estimates').select('id, approval_email_to').eq('netsuite_so_id', params.id).limit(1).maybeSingle(),
    h.customerId
      ? supabase.from('customers').select('ap_email, billing_contact_email').eq('netsuite_id', String(h.customerId)).limit(1).maybeSingle()
      : Promise.resolve({ data: null as any }),
    supabase.from('wrap_quote_settings').select('company').eq('id', 1).maybeSingle(),
  ]);
  const companyName = (settings as any)?.company?.name || 'BMG Fleet';

  const docName = `Sales Order #${soNumber}`;
  const subject = `[BMG Fleet] ${docName}${h.poNumber ? ` (PO ${h.poNumber})` : ''}`;
  const bodyText = `Attached is ${docName} from ${companyName}`
    + `${h.customerName ? ` for ${h.customerName}` : ''}`
    + `${h.poNumber ? `, your PO ${h.poNumber}` : ''}.`;
  const signature = await getEmailSignature(supabase, auth.user.id);
  const html = buildNotificationEmail(docName, bodyText, undefined, undefined, {
    note: p.message || undefined,
    attachmentNames: [pdfName],
    signature,
  });

  if (p.preview) {
    const approvedBy = ((estimate as any)?.approval_email_to || []) as string[];
    const billing = [(customer as any)?.billing_contact_email, (customer as any)?.ap_email].filter(Boolean) as string[];
    const to = approvedBy.length ? approvedBy : billing.slice(0, 1);
    return NextResponse.json({ preview: true, to: to.join(', ') || null, subject, html, attachments: [pdfName] });
  }
  if (!p.emails.length) return NextResponse.json({ error: 'Enter at least one recipient email address.' }, { status: 400 });

  // The sales order PDF goes first; no PDF, no send.
  const pdf = await getNetSuitePdf('salesOrder', params.id, { timeoutMs: 45_000 });
  if (!pdf.success || !pdf.pdfBase64) {
    return NextResponse.json({ error: `Could not get the sales order PDF from NetSuite, so nothing was sent: ${pdf.error || 'no PDF came back'}` }, { status: 502 });
  }

  const { data: me } = await supabase.from('profiles').select('full_name').eq('id', auth.user.id).maybeSingle();
  const bcc = p.bccSelf && auth.user.email ? [auth.user.email] : undefined;
  const { ok } = await sendEmailDetailed(
    p.emails, subject, html, undefined,
    [{ filename: pdfName, content: Buffer.from(pdf.pdfBase64, 'base64'), contentType: 'application/pdf' }],
    auth.user.email || undefined, bcc,
    {
      kind: 'sales_order',
      cc: p.cc,
      sentBy: auth.user.id,
      contextUrl: deepLinks.salesOrder(params.id),
      docRefs: [docRef('sales_order', soNumber)],
      netsuiteCustomerId: h.customerId ? String(h.customerId) : null,
      fromName: repFromName(me?.full_name),
    },
  );
  if (!ok) return NextResponse.json({ error: 'Email send failed (is Resend configured?)' }, { status: 502 });

  await logAudit(supabase, { actorId: auth.user.id, table: 'email_log', recordId: params.id, action: 'sales_order_emailed', detail: { salesOrder: soNumber, emailed: p.emails } });
  return NextResponse.json({ success: true, to: p.emails, bcc: bcc || [] });
}
