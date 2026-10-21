import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { repFromName, sendEmailDetailed } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { getEmailSignature } from '@/lib/email-signature';
import { logAudit } from '@/lib/audit';
import { qcLinkUrl, qcPublicPhotoUrl } from '@/lib/qc-fixes';
import { buildQcFixedEmail } from '@/lib/qc-fixes-server';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

const Schema = z.object({
  id: z.string().uuid(),
  emails: z.array(z.string().email().max(254)).max(20).default([]),
  bccSelf: z.boolean().optional().default(false),
  cc: z.array(z.string().email().max(254)).max(10).optional(),
  message: z.string().trim().max(10_000).optional().default(''),
  /** Fix photos (qc_fix_photos kind 'fix' on this report) shown in the email. */
  attachmentIds: z.array(z.string().uuid()).max(10).optional().default([]),
  preview: z.boolean().optional().default(false),
});

/**
 * POST /api/qc-fixes/fixed-email — "Mark fixed" on the QC Fixes page. The
 * standard compose contract (docs/customer-email-standard.md): preview
 * renders with no side effects; a real send emails the customer's QC
 * contacts (prefilled from customers.qc_notify_emails, editable) and marks
 * the report fixed. Never automatic (owner, 2026-10-15). Picked fix photos
 * show in the body, served through the customer's QC link.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const p = parsed.data;

  const { data: report } = await supabase
    .from('qc_fix_reports')
    .select('id, customer_id, vin_last6, vin, vehicle_label, reported_by_name, comments, created_at, fix_by, fixed_at, status')
    .eq('id', p.id).maybeSingle();
  if (!report) return NextResponse.json({ error: 'Report not found' }, { status: 404 });
  const { data: customer } = await supabase
    .from('customers').select('id, company_name, qc_token, qc_notify_emails').eq('id', report.customer_id).maybeSingle();
  if (!customer?.qc_token) {
    return NextResponse.json({ error: 'This customer has no QC link any more, so the email has nothing to link to. Create one on the QC Fixes page.' }, { status: 400 });
  }

  let fixPhotoIds: string[] = [];
  if (p.attachmentIds.length) {
    const { data: photos } = await supabase.from('qc_fix_photos').select('id')
      .in('id', p.attachmentIds).eq('report_id', report.id).eq('kind', 'fix');
    fixPhotoIds = (photos || []).map(ph => ph.id);
    if (fixPhotoIds.length !== new Set(p.attachmentIds).size) {
      return NextResponse.json({ error: 'A picked photo is not on this report.' }, { status: 400 });
    }
  }

  const fixedOn = report.fixed_at || new Date().toISOString();
  const signature = await getEmailSignature(supabase, auth.user.id);
  const { subject, html } = buildQcFixedEmail({
    report,
    message: p.message,
    fixedOn,
    fixPhotoUrls: fixPhotoIds.map(id => qcPublicPhotoUrl(customer.qc_token, id)),
    linkUrl: `${qcLinkUrl(customer.qc_token)}?report=${report.id}`,
    signature,
  });

  if (p.preview) {
    return NextResponse.json({ preview: true, to: (customer.qc_notify_emails || []).join(', ') || null, subject, html });
  }
  if (!p.emails.length) return NextResponse.json({ error: 'Enter at least one recipient email address.' }, { status: 400 });

  const { data: me } = await supabase.from('profiles').select('full_name').eq('id', auth.user.id).maybeSingle();
  const bcc = p.bccSelf && auth.user.email ? [auth.user.email] : undefined;
  const { ok } = await sendEmailDetailed(p.emails, subject, html, undefined, undefined, auth.user.email || undefined, bcc, {
    kind: 'qc_fix_fixed',
    cc: p.cc,
    sentBy: auth.user.id,
    contextUrl: deepLinks.qcFix(report.id),
    customerId: customer.id,
    fromName: repFromName(me?.full_name),
  });
  if (!ok) return NextResponse.json({ error: 'Email send failed (is Resend configured?)' }, { status: 502 });

  const now = new Date().toISOString();
  const { error } = await supabase.from('qc_fix_reports').update({
    status: 'fixed',
    fixed_at: report.fixed_at || now,
    fixed_by: auth.user.id,
    fixed_email_sent_at: now,
    updated_at: now,
  }).eq('id', report.id);
  if (error) return NextResponse.json({ error: `The email went out, but the report could not be marked fixed: ${error.message}` }, { status: 500 });
  await logAudit(supabase, { actorId: auth.user.id, table: 'qc_fix_reports', recordId: report.id, action: 'qc_fix_marked_fixed', detail: { emailed: p.emails } });
  return NextResponse.json({ success: true, to: p.emails, bcc: bcc || [] });
}
