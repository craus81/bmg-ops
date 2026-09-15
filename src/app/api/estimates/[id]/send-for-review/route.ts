import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { INTERNAL_STAFF_ROLES } from '@/lib/features';
import { sendEmailDetailed } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { renderEstimateDocument } from '@/lib/estimate-document';
import { getEmailSignature } from '@/lib/email-signature';
import { enrichLinesWithPartAssets } from '@/lib/estimate-line-parts';
import { loadEstimateGraphics, loadEstimateProofs } from '@/lib/estimate-graphics';
import { r2PublicUrl } from '@/lib/r2';
import { loadEstimateAttachmentRows, fetchEstimateAttachments } from '@/lib/estimate-attachments';
import { MAX_ATTACHMENT_BYTES } from '@/lib/email-attachments';
import { generateEstimatePdf } from '@/lib/estimate-pdf-server';
import { estimatePdfFilename } from '@/lib/estimate-pdf';
import { estimateHeadlineNumber } from '@/lib/estimate-number';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { notify } from '@/lib/notify';
import { pickReviewer, type StaffOption } from '@/lib/estimate-review';

// Proof images inline in the review email are presigned for the same window
// the customer's approval email uses — the reviewer is checking the exact
// artwork the customer would get.
const EMAIL_PRESIGN_SECONDS = 7 * 24 * 3600;

export const dynamic = 'force-dynamic';
// The review email carries the same estimate PDF the customer send does, so
// it needs the same budget for a cold start with several assets.
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SendForReviewSchema = z.object({
  // Standard compose fields (docs/customer-email-standard.md) — the same
  // screen the customer send uses, pointed at our own people.
  emails: z.array(z.string().email().max(254)).max(20).optional(),
  bccSelf: z.boolean().optional().default(false),
  cc: z.array(z.string().email().max(254)).max(10).optional(),
  message: z.string().trim().max(5000).optional(),
  preview: z.boolean().optional().default(false),
  attachmentFileIds: z.array(z.string().uuid()).max(20).optional(),
});

/** Approved internal-staff profiles with a login email — the reviewer pool. */
async function loadStaffDirectory(): Promise<StaffOption[]> {
  const { data } = await supabase
    .from('profiles')
    .select('id, full_name, email, role, roles')
    .eq('status', 'approved');
  return (data || [])
    .filter((p: any) => {
      const roles: string[] = p.roles?.length ? p.roles : [p.role];
      return p.email && roles.some((r: string) => INTERNAL_STAFF_ROLES.includes(r));
    })
    .map((p: any) => ({ id: p.id, name: p.full_name || p.email, email: String(p.email) }));
}

/**
 * POST /api/estimates/[id]/send-for-review
 *
 * The internal review step (migration 316): email a BMG teammate the SAME
 * estimate document the customer would get, with a CTA that opens the
 * estimate in FleetView instead of a customer approval link, and put the
 * review on their plate (bell + New for you).
 *
 * Nothing about the customer side moves: no approval token is minted, the
 * estimate's status is untouched, and the customer is not contacted. Sending
 * again to a different teammate reassigns the review.
 *
 * Body: the standard compose fields. The reviewer of record is the first To
 * address belonging to a BMG login (src/lib/estimate-review.ts) — a send
 * with no teammate in To is rejected rather than delivered as decoration.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, SendForReviewSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const { data: estimate, error: eErr } = await supabase
    .from('estimates')
    .select('*, vehicle_platforms(label)')
    .eq('id', params.id)
    .single();
  if (eErr || !estimate) {
    return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  }
  (estimate as any).vehicle_platform_label = (estimate as any).vehicle_platforms?.label || null;

  const emailList = (body.emails || []).map(e => e.trim()).filter(Boolean);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  const reviewUrl = `${appUrl}${deepLinks.estimate(estimate.id)}`;
  const headline = estimateHeadlineNumber(estimate);
  const senderName = (auth.profile as any)?.full_name || auth.user?.email || 'A teammate';
  const subject = `[BMG] Estimate #${headline} — ${senderName} asked you to review`;
  const message = body.message?.trim() || undefined;

  // Same document the customer would receive: line items, quantities, rates,
  // totals, wrap coverage and proofs. Reviewing a summary card would mean
  // approving something other than what goes out.
  const { data: rawLineItems } = await supabase
    .from('estimate_line_items')
    .select('*')
    .eq('estimate_id', estimate.id)
    .order('sort_order')
    .order('id');
  const lineItems = await enrichLinesWithPartAssets(supabase, rawLineItems || []);
  const { data: settings } = await supabase
    .from('wrap_quote_settings')
    .select('company')
    .eq('id', 1)
    .maybeSingle();
  const company = settings?.company || {};
  const logoUrl = company?.logo_path ? r2PublicUrl('vehicle-templates', company.logo_path) : null;
  const signature = await getEmailSignature(supabase, auth.user?.id);
  const { summaries: graphics } = await loadEstimateGraphics(supabase, estimate.id);
  // The stored proof selection rides as-is: the review is of what the
  // customer send would carry, and picking proofs is that send's decision.
  const proofs = await loadEstimateProofs(supabase, estimate.id, undefined, { expiresIn: EMAIL_PRESIGN_SECONDS });

  const picked = await loadEstimateAttachmentRows(supabase, estimate.id, body.attachmentFileIds);
  if (!picked.ok) return NextResponse.json({ error: picked.error }, { status: picked.status });

  const pdfFilename = estimatePdfFilename(estimate);
  const attachmentNames = [pdfFilename, ...picked.rows.map(r => r.file_name)];

  const ctaNote = 'Internal review — the customer has not been sent anything. Opening this in FleetView lets you edit the estimate, approve it, or send it back with notes.';

  if (body.preview) {
    const html = renderEstimateDocument(estimate, lineItems || [], {
      company,
      logoUrl,
      message,
      ctaUrl: reviewUrl,
      ctaLabel: 'Open in FleetView to Review',
      ctaNote,
      signature,
      graphics,
      proofs,
      attachmentNames,
    });
    return NextResponse.json({ preview: true, to: emailList.join(', ') || null, subject, html, attachments: [pdfFilename] });
  }

  if (emailList.length === 0) {
    return NextResponse.json({ error: 'Add the teammate you want to review this.' }, { status: 400 });
  }

  // The reviewer of record — the person the task lands on. Resolved BEFORE
  // any attachment work so a send to nobody fails cheaply and clearly.
  const staff = await loadStaffDirectory();
  const reviewer = pickReviewer(staff, emailList);
  if (!reviewer) {
    return NextResponse.json({
      error: 'None of those addresses is a BMG teammate with a FleetView login. Pick the reviewer from the teammate dropdown — they need an account to open and change the estimate.',
    }, { status: 400 });
  }

  // Attachments are assembled before anything is recorded: a storage failure
  // must fail the whole send, not leave an estimate marked "in review" for a
  // reviewer who never got the email (docs/customer-email-standard.md).
  const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
  let pdf: Awaited<ReturnType<typeof generateEstimatePdf>>;
  try {
    pdf = await generateEstimatePdf(supabase, estimate.id);
  } catch (err: any) {
    console.error('[send-for-review] estimate PDF failed:', err?.message || err);
    pdf = { ok: false, status: 500, error: err?.message || 'PDF render failed' };
  }
  if (!pdf.ok) {
    return NextResponse.json({ error: `Could not generate the estimate PDF (${pdf.error}). Nothing was sent — try again.` }, { status: pdf.status === 404 ? 404 : 502 });
  }
  attachments.push({ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' });

  const usedBytes = attachments.reduce((sum, a) => sum + a.content.byteLength, 0);
  const extras = await fetchEstimateAttachments(picked.rows, Math.max(0, MAX_ATTACHMENT_BYTES - usedBytes));
  if (!extras.ok) return NextResponse.json({ error: extras.error }, { status: extras.status });
  for (const a of extras.attachments) {
    attachments.push({ filename: a.filename, content: a.content, contentType: a.contentType || 'application/octet-stream' });
  }

  const html = renderEstimateDocument(estimate, lineItems || [], {
    company,
    logoUrl,
    message,
    ctaUrl: reviewUrl,
    ctaLabel: 'Open in FleetView to Review',
    ctaNote,
    signature,
    graphics,
    proofs,
    attachmentNames,
  });
  const bcc = body.bccSelf && auth.user?.email ? [auth.user.email] : undefined;

  const dispatch: Record<string, any> = { email: null };
  try {
    const { ok } = await sendEmailDetailed(
      emailList, subject, html, undefined,
      attachments,
      auth.user?.email || undefined, bcc,
      {
        kind: 'estimate_internal_review',
        cc: body.cc,
        sentBy: auth.user?.id,
        contextUrl: deepLinks.estimate(estimate.id),
        customerId: estimate.customer_id,
        netsuiteCustomerId: estimate.customer_netsuite_id,
      },
    );
    dispatch.email = { target: emailList.join(', '), ok, bcc: bcc ? bcc.join(', ') : undefined };
  } catch (err: any) {
    dispatch.email = { target: emailList.join(', '), ok: false, error: err?.message };
  }

  // Who held it before this send — a reviewer handing it on, or the rep
  // re-requesting. Read before the update so the hand-off can be announced.
  const priorReviewerId: string | null = estimate.internal_reviewer_id || null;
  const priorRequesterId: string | null = estimate.internal_review_requested_by || null;
  const wasPending = estimate.internal_review_status === 'pending';

  const { error: updErr } = await supabase
    .from('estimates')
    .update({
      internal_review_status: 'pending',
      internal_reviewer_id: reviewer.id,
      internal_review_requested_by: auth.user.id,
      internal_review_requested_at: new Date().toISOString(),
      internal_review_decided_by: null,
      internal_review_decided_at: null,
      // A fresh round starts clean — last round's note described an estimate
      // that has since been edited.
      internal_review_note: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', estimate.id);
  if (updErr) {
    return NextResponse.json({ error: 'The email went out but the review could not be recorded: ' + updErr.message }, { status: 500 });
  }

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'estimates',
    recordId: estimate.id,
    action: 'estimate_internal_review_requested',
    detail: {
      estimate_number: estimate.estimate_number,
      reviewer: reviewer.name,
      reviewer_id: reviewer.id,
      recipients: emailList,
      reassigned_from: wasPending && priorReviewerId && priorReviewerId !== reviewer.id ? priorReviewerId : undefined,
    },
  });

  // The reviewer's task. Deep-linked to the estimate itself — a bare list
  // page here would be a dead click (CLAUDE.md deep-link rule).
  await notify({
    userId: reviewer.id,
    type: 'estimate_review_requested',
    title: `Estimate #${headline} needs your review`,
    body: `${senderName} sent you ${estimate.customer_name || 'an estimate'}${estimate.grand_total ? ` — $${Number(estimate.grand_total).toLocaleString()}` : ''} to check before it goes to the customer.${message ? ` Note: ${message}` : ''}`.slice(0, 900),
    url: deepLinks.estimate(estimate.id),
    emailReplyTo: auth.user?.email || undefined,
  }).catch(err => console.error('review-request notify failed:', err));

  // A reviewer handing the review to someone else tells the rep who has it
  // now, so the estimate never goes quiet on the person waiting for it.
  const handedOn = wasPending && priorRequesterId && priorRequesterId !== auth.user.id;
  if (handedOn) {
    await notify({
      userId: priorRequesterId!,
      type: 'estimate_review_update',
      title: `Estimate #${headline} review passed to ${reviewer.name}`,
      body: `${senderName} handed your estimate's review to ${reviewer.name}.`,
      url: deepLinks.estimate(estimate.id),
    }).catch(err => console.error('review-handoff notify failed:', err));
  }

  return NextResponse.json({
    status: 'sent',
    reviewer: { id: reviewer.id, name: reviewer.name, email: reviewer.email },
    reassigned: !!(wasPending && priorReviewerId && priorReviewerId !== reviewer.id),
    dispatch,
  });
}
