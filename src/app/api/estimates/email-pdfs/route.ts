import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature, getProfileRoles } from '@/lib/api-auth';
import { checkDiscountApproval } from '@/lib/discount-approval';
import { validateBody, z } from '@/lib/validate';
import { generateEstimatePdf } from '@/lib/estimate-pdf-server';
import { sendEmailDetailed, repFromName, buildNotificationEmail } from '@/lib/resend';
import { getEmailSignature } from '@/lib/email-signature';
import { estimatePdfFilename } from '@/lib/estimate-pdf';
import { deepLinks } from '@/lib/deep-links';
import { resolveEstimateEmail } from '@/lib/estimate-recipients';
import { MAX_ATTACHMENT_BYTES } from '@/lib/email-attachments';
import { estimateCustomerKey, MAX_BATCH_ESTIMATES } from '@/lib/estimate-batch';

export const dynamic = 'force-dynamic';
// One PDF render per estimate before the send.
export const maxDuration = 120;

const Schema = z.object({
  estimateIds: z.array(z.string().uuid()).min(1).max(MAX_BATCH_ESTIMATES),
  emails: z.array(z.string().email()).max(20).optional(),
  bccSelf: z.boolean().optional(),
  cc: z.array(z.string().email().max(254)).max(10).optional(),
  message: z.string().max(4000).optional(),
  preview: z.boolean().optional(),
});

const money = (n: any) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * POST /api/estimates/email-pdfs — several of one customer's estimates
 * picked on the Estimates list, emailed as PDFs in ONE email (Craig,
 * 2026-10-28, thread "Bulk email estimates to customers"). The Email PDF
 * button's email for many estimates: each estimate's PDF attached, no
 * approval link, nothing marked sent. Standard compose contract
 * (docs/customer-email-standard.md): emails[] / cc / bccSelf / message /
 * preview. Approved estimates can go too (copies of what was agreed).
 */
export async function POST(req: NextRequest) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const ids = [...new Set(body.estimateIds)];

  const supabase = createServiceClient();
  const { data: rows, error: estErr } = await supabase
    .from('estimates')
    .select('id, estimate_number, title, customer_id, prospect_id, customer_name, customer_netsuite_id, grand_total, labor_total, vehicle_count, discount_type, discount_value, discount_approved_at, discount_approved_pct')
    .in('id', ids);
  if (estErr) return NextResponse.json({ error: 'Could not load the estimates: ' + estErr.message }, { status: 500 });
  const byId = new Map((rows || []).map(r => [r.id, r]));
  const estimates = ids.map(id => byId.get(id)).filter(Boolean) as NonNullable<typeof rows>;
  if (estimates.length !== ids.length) {
    return NextResponse.json({ error: 'One of the picked estimates no longer exists. Reload the list and try again.' }, { status: 404 });
  }
  const first = estimates[0];
  const other = estimates.find(e => estimateCustomerKey(e) !== estimateCustomerKey(first));
  if (other) {
    return NextResponse.json({ error: `Estimate #${other.estimate_number} is for ${other.customer_name || 'another customer'}, not ${first.customer_name || 'this customer'}. Each customer gets their own email.` }, { status: 400 });
  }

  const composeEmails = (body.emails || []).map(e => e.trim()).filter(Boolean);
  const defaultEmail = composeEmails.length === 0 ? await resolveEstimateEmail(supabase, first) : null;
  const emailList = composeEmails.length > 0 ? composeEmails : (defaultEmail ? [defaultEmail] : []);

  const { data: settings } = await supabase.from('wrap_quote_settings').select('company').eq('id', 1).maybeSingle();
  const companyName = settings?.company?.name || 'BMG Fleet';

  const count = estimates.length;
  const total = estimates.reduce((sum, e) => sum + (Number(e.grand_total) || 0), 0);
  const subject = `[BMG Fleet] ${count === 1 ? `Estimate #${first.estimate_number}` : `${count} estimates`}${first.customer_name ? ` for ${first.customer_name}` : ''}`;
  const listText = estimates
    .map(e => `#${e.estimate_number}${e.title ? ` (${e.title})` : ''} ${money(e.grand_total)}`)
    .join('; ');
  const bodyText = `Attached ${count === 1 ? 'is 1 estimate' : `are ${count} estimates`} from ${companyName}`
    + `${first.customer_name ? ` for ${first.customer_name}` : ''}: ${listText}.`
    + `${count > 1 ? ` Total ${money(total)}.` : ''}`;
  const signature = await getEmailSignature(supabase, auth.user?.id);
  const html = buildNotificationEmail(
    count === 1 ? `Estimate #${first.estimate_number}` : `${count} estimates`,
    bodyText,
    undefined,
    undefined,
    {
      note: body.message?.trim() || undefined,
      attachmentNames: estimates.map(e => estimatePdfFilename(e)),
      signature,
    },
  );

  if (body.preview) {
    return NextResponse.json({ preview: true, to: emailList.join(', ') || null, subject, html });
  }

  // Discounts over the admin-approval limit (migration 365): the PDF is the
  // quote too, so each waits for the admin the way Email PDF does.
  for (const e of estimates) {
    const { data: discountLines } = await supabase
      .from('estimate_line_items')
      .select('quantity, unit_price, discount_type, discount_value')
      .eq('estimate_id', e.id);
    const discountBlock = await checkDiscountApproval(supabase, e, discountLines || [], { id: auth.user.id, roles: getProfileRoles(auth.profile) }, 'sent');
    if (discountBlock) {
      return NextResponse.json({ error: `Estimate #${e.estimate_number}: ${discountBlock.error}`, step: 'discount_approval', discountApproval: discountBlock.status }, { status: 409 });
    }
  }

  if (emailList.length === 0) {
    return NextResponse.json({ error: 'No email on file for this customer. Add a recipient first.' }, { status: 400 });
  }

  // Every PDF, all inside the email size budget. A PDF that can't be made
  // stops the send with its number rather than going out quietly missing.
  const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
  let bytes = 0;
  for (const e of estimates) {
    const pdf = await generateEstimatePdf(supabase, e.id);
    if (!pdf.ok) return NextResponse.json({ error: `Estimate #${e.estimate_number}: ${pdf.error}` }, { status: pdf.status });
    bytes += pdf.buffer.byteLength;
    if (bytes > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json({ error: `The PDFs are too big for one email (over ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB by #${e.estimate_number}). Send fewer estimates at a time.` }, { status: 413 });
    }
    attachments.push({ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' });
  }

  const senderEmail = auth.user?.email || undefined;
  const { ok, id: resendId } = await sendEmailDetailed(
    emailList,
    subject,
    html,
    undefined,
    attachments,
    senderEmail,
    body.bccSelf && senderEmail ? [senderEmail] : undefined,
    {
      kind: 'estimate_pdf',
      cc: body.cc,
      sentBy: auth.user?.id,
      fromName: repFromName((auth.profile as any)?.full_name),
      contextUrl: deepLinks.estimate(first.id),
      customerId: first.customer_id,
      netsuiteCustomerId: first.customer_netsuite_id,
    },
  );
  if (!ok) {
    return NextResponse.json({ error: 'Email failed to send. Check the Resend setup and try again.' }, { status: 502 });
  }

  return NextResponse.json({
    success: true,
    resendId,
    count,
    dispatch: {
      email: {
        ok: true,
        target: emailList.join(', '),
        bcc: body.bccSelf && senderEmail ? senderEmail : null,
      },
    },
  });
}
