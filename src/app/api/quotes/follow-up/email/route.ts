import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { sendEmailDetailed, buildNotificationEmail } from '@/lib/resend';
import { getEmailSignature } from '@/lib/email-signature';
import { deepLinks } from '@/lib/deep-links';
import { loadEstimateAttachmentRows, fetchEstimateAttachments, type EstimateFileRow } from '@/lib/estimate-attachments';
import { resolveEstimateEmail } from '@/lib/estimate-recipients';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  type: z.enum(['estimate', 'wrap']),
  id: z.string().uuid(),
  emails: z.array(z.string().email()).max(20).optional(),
  bccSelf: z.boolean().optional(),
  message: z.string().max(4000).optional(),
  // Estimate files (estimate_files) to attach — pictures, spec sheets the
  // customer asked for since the original send. Estimates only; wrap quotes
  // carry their own stored files on their own send route.
  attachmentFileIds: z.array(z.string().uuid()).max(20).optional(),
  preview: z.boolean().optional(),
});

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/quotes/follow-up/email — send a follow-up email on a sent
 * estimate or wrap quote, through the standard compose contract
 * (docs/customer-email-standard.md): emails[] / bccSelf / message /
 * preview. Preview renders the exact email (sender signature included)
 * with zero side effects.
 *
 * A real send ALSO logs the follow-up — last_followup_at plus a
 * quote_followups history row — so the follow-up queue's quiet-days
 * clock resets exactly as if the rep had pressed "Log Follow-Up".
 *
 * When the quote's magic-link approval token is still valid, the email
 * carries the Review & Accept button so the customer can act from the
 * follow-up itself instead of digging for the original email.
 *
 * Estimate follow-ups can also carry files off the estimate
 * (estimate_files) — the same picker the approval and PDF sends use.
 */
export async function POST(req: NextRequest) {
  const auth = await requireRole(req, ['admin', 'sales']);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { type, id, bccSelf, message, preview } = parsed.data;

  const isEstimate = type === 'estimate';
  const table = isEstimate ? 'estimates' : 'wrap_quotes';
  const { data: quoteRow } = await service
    .from(table)
    .select(isEstimate
      ? 'id, estimate_number, title, status, customer_id, prospect_id, customer_name, grand_total, approval_email_to, approval_token, approval_token_expires_at'
      : 'id, quote_number, vehicle_description, status, customer_id, customer, total, sent_to, approval_token, approval_token_expires_at')
    .eq('id', id)
    .maybeSingle();
  if (!quoteRow) return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  // The per-type column sets make Supabase infer a union — the isEstimate
  // branches below only touch the matching side's fields.
  const quote = quoteRow as any;

  // Default recipients: whoever the quote was last sent to, then the
  // customer record's email.
  const composeEmails = (parsed.data.emails || []).map(e => e.trim()).filter(Boolean);
  let defaults: string[] = [];
  if (isEstimate) {
    defaults = (quote.approval_email_to || []).filter(Boolean);
    if (defaults.length === 0) {
      // Customer OR CRM lead — the same resolver the approval and PDF
      // sends use (src/lib/estimate-recipients.ts).
      const resolved = await resolveEstimateEmail(service, quote);
      if (resolved) defaults = [resolved];
    }
  } else {
    if (quote.sent_to) defaults = [quote.sent_to];
    else if (quote.customer?.email) defaults = [quote.customer.email];
  }
  const emailList = composeEmails.length > 0 ? composeEmails : defaults;

  const number = isEstimate ? quote.estimate_number : quote.quote_number;
  const label = isEstimate ? `Estimate #${number}` : `Quote ${number}`;
  const detail = isEstimate ? quote.title : quote.vehicle_description;
  const total = Number(isEstimate ? quote.grand_total : quote.total) || 0;
  const customerName = isEstimate ? quote.customer_name : quote.customer?.name;

  const subject = `[BMG Fleet] Following up — ${label}${detail ? ` (${detail})` : ''}`;
  const bodyText = `Just checking in on ${label}${detail ? ` — ${detail}` : ''}`
    + `${customerName ? ` for ${customerName}` : ''}`
    + `${total > 0 ? `, total $${total.toFixed(2)}` : ''}.`
    + ' If anything needs adjusting, or you have questions, just reply to this email — it comes straight back to us.';

  // Live Review & Accept link, when the magic-link token hasn't expired.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  const tokenValid = quote.approval_token
    && quote.approval_token_expires_at
    && new Date(quote.approval_token_expires_at) > new Date();
  const ctaUrl = tokenValid
    ? `${appUrl}/approve/${isEstimate ? 'estimate' : 'quote'}/${quote.approval_token}`
    : undefined;

  // Picked estimate files. Resolved before the preview so it can name
  // them, and validated against THIS estimate.
  const attachmentFileIds = parsed.data.attachmentFileIds || [];
  if (attachmentFileIds.length > 0 && !isEstimate) {
    return NextResponse.json({ error: 'Attachments are only supported on estimate follow-ups.' }, { status: 400 });
  }
  const picked = isEstimate
    ? await loadEstimateAttachmentRows(service, id, attachmentFileIds)
    : { ok: true as const, rows: [] as EstimateFileRow[] };
  if (!picked.ok) return NextResponse.json({ error: picked.error }, { status: picked.status });

  const signature = await getEmailSignature(service, auth.user?.id);
  const html = buildNotificationEmail(
    `Following up — ${label}`,
    bodyText,
    ctaUrl,
    ctaUrl ? 'Review & Accept' : undefined,
    {
      note: message?.trim() || undefined,
      attachmentNames: picked.rows.map(r => r.file_name),
      signature,
    },
  );

  if (preview) {
    return NextResponse.json({ preview: true, to: emailList.join(', ') || null, subject, html });
  }

  if (emailList.length === 0) {
    return NextResponse.json({ error: 'No email on file for this quote. Add a recipient first.' }, { status: 400 });
  }

  // Pull the bytes before anything is sent or logged — a storage failure
  // fails the send with the file named, never a half-sent follow-up.
  const extras = await fetchEstimateAttachments(picked.rows);
  if (!extras.ok) return NextResponse.json({ error: extras.error }, { status: extras.status });

  const senderEmail = auth.user?.email || undefined;
  const { ok } = await sendEmailDetailed(
    emailList,
    subject,
    html,
    undefined,
    extras.attachments.length > 0 ? extras.attachments : undefined,
    senderEmail,
    bccSelf && senderEmail ? [senderEmail] : undefined,
    {
      kind: 'quote_followup',
      sentBy: auth.user?.id,
      contextUrl: isEstimate ? deepLinks.estimate(id) : deepLinks.wrapQuote(id),
      customerId: quote.customer_id || null,
    },
  );
  if (!ok) {
    return NextResponse.json({ error: 'Email failed to send — check Resend configuration and try again.' }, { status: 502 });
  }

  // The email IS a follow-up touch — reset the quiet-days clock and leave
  // a history row, exactly like Log Follow-Up. Best-effort past the
  // timestamp: the email already went out.
  const now = new Date().toISOString();
  await service.from(table).update({ last_followup_at: now }).eq('id', id);
  const { error: fuError } = await service.from('quote_followups').insert({
    quote_type: type,
    quote_id: id,
    note: `Follow-up email sent to ${emailList.join(', ')}${message?.trim() ? ` — "${message.trim()}"` : ''}`,
    created_by: auth.user!.id,
  });
  if (fuError) console.warn('quote_followups insert failed (migration 212 applied?):', fuError.message);

  return NextResponse.json({
    success: true,
    dispatch: {
      email: {
        ok: true,
        target: emailList.join(', '),
        bcc: bccSelf && senderEmail ? senderEmail : null,
      },
    },
  });
}
