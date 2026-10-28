import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { generateEstimatePdf } from '@/lib/estimate-pdf-server';
import { sendEmailDetailed, repFromName, buildNotificationEmail } from '@/lib/resend';
import { getEmailSignature } from '@/lib/email-signature';
import { estimatePdfFilename } from '@/lib/estimate-pdf';
import { deepLinks } from '@/lib/deep-links';
import { resolveEstimateEmail } from '@/lib/estimate-recipients';
import {
  ORDER_STATUS_ESTIMATE_COLUMNS, ensureOrderStatusToken, isEstimateApproved, orderStatusUrl,
} from '@/lib/order-status-server';
import { fmtDay } from '@/lib/order-status';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const Schema = z.object({
  emails: z.array(z.string().email()).max(20).optional(),
  bccSelf: z.boolean().optional(),
  cc: z.array(z.string().email().max(254)).max(10).optional(),
  message: z.string().max(4000).optional(),
  preview: z.boolean().optional(),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/estimates/[id]/order-status/confirmation — the "We got your
 * approval" email (Craig, 2026-10-28: the rep sends it with one tap, never
 * automatic). Standard compose contract (docs/customer-email-standard.md):
 * emails[] / cc / bccSelf / message / preview, Reply-To the sender, the
 * estimate PDF attached. Its button opens the customer's live Order status
 * page; no later email goes out, the page moves on its own.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const supabase = createServiceClient();

  const { data: estimate } = await supabase
    .from('estimates')
    .select(`${ORDER_STATUS_ESTIMATE_COLUMNS}, prospect_id, approval_email_to`)
    .eq('id', params.id)
    .maybeSingle();
  if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  const est = estimate as any;
  if (!isEstimateApproved(est)) {
    return NextResponse.json({ error: 'The customer has not approved this estimate yet.' }, { status: 409 });
  }

  // Default To: whoever approved (the per-person link names them), then
  // the addresses the approval went to, then the customer on file.
  const composeEmails = (body.emails || []).map(e => e.trim()).filter(Boolean);
  let emailList = composeEmails;
  if (emailList.length === 0) {
    if (est.customer_responder && EMAIL_RE.test(est.customer_responder)) emailList = [est.customer_responder];
    else if (Array.isArray(est.approval_email_to) && est.approval_email_to.length > 0) emailList = est.approval_email_to.slice(0, 1);
    else {
      const fallback = await resolveEstimateEmail(supabase, est);
      emailList = fallback ? [fallback] : [];
    }
  }

  const token = await ensureOrderStatusToken(supabase, est);
  const url = orderStatusUrl(token);
  const label = `Estimate #${est.estimate_number}${est.title ? ` (${est.title})` : ''}`;
  const approvedOn = fmtDay(est.customer_approved_at);
  const subject = `[BMG Fleet] We got your approval: Estimate #${est.estimate_number}${est.title ? ` — ${est.title}` : ''}`;
  const filename = estimatePdfFilename(est);
  const bodyText = `Thank you. We received your approval of ${label}${approvedOn ? ` on ${approvedOn}` : ''}. `
    + 'Next we order anything we don\'t have on the shelf, then call you to set a date. '
    + 'Track your order any time with the button below. The page updates on its own as the job moves along, and you can forward it to anyone on your team.';
  const signature = await getEmailSignature(supabase, auth.user?.id);
  const html = buildNotificationEmail(
    'We got your approval',
    bodyText,
    url,
    'Track your order',
    {
      note: body.message?.trim() || undefined,
      ctaNote: 'Approved → Parts ordered → All parts in → Scheduled → In the shop → Done → Invoiced',
      attachmentNames: [filename],
      signature,
    },
  );

  if (body.preview) {
    return NextResponse.json({ preview: true, to: emailList.join(', ') || null, subject, html, attachments: [filename] });
  }
  if (emailList.length === 0) {
    return NextResponse.json({ error: 'No email on file for this customer. Add a recipient first.' }, { status: 400 });
  }

  const pdf = await generateEstimatePdf(supabase, est.id);
  if (!pdf.ok) return NextResponse.json({ error: pdf.error }, { status: pdf.status });

  const senderEmail = auth.user?.email || undefined;
  const { ok, id: resendId } = await sendEmailDetailed(
    emailList,
    subject,
    html,
    undefined,
    [{ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' }],
    senderEmail,
    body.bccSelf && senderEmail ? [senderEmail] : undefined,
    {
      kind: 'estimate_approval_confirmation',
      cc: body.cc,
      sentBy: auth.user?.id,
      fromName: repFromName((auth.profile as any)?.full_name),
      contextUrl: deepLinks.estimate(est.id),
      customerId: est.customer_id,
      netsuiteCustomerId: est.customer_netsuite_id,
    },
  );
  if (!ok) {
    return NextResponse.json({ error: 'Email failed to send. Check the Resend setup and try again.' }, { status: 502 });
  }

  const now = new Date().toISOString();
  await supabase.from('estimates')
    .update({ approval_confirmation_sent_at: now, approval_confirmation_sent_by: auth.user.id })
    .eq('id', est.id);

  return NextResponse.json({
    success: true,
    resendId,
    confirmation: { at: now, by: (auth.profile as any)?.full_name || null },
    dispatch: {
      email: { ok: true, target: emailList.join(', '), bcc: body.bccSelf && senderEmail ? senderEmail : null },
    },
  });
}
