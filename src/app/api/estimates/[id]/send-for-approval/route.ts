import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature } from '@/lib/api-auth';
import { generateToken, approvalContentHash } from '@/lib/magic-link-approval';
import { reconcileLinkedWrapQuotes } from '@/lib/wrap-quote-reconcile';
import { sendEmailDetailed } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { sendSMS } from '@/lib/sms-provider';
import { renderEstimateDocument } from '@/lib/estimate-document';
import { getEmailSignature } from '@/lib/email-signature';
import { enrichLinesWithPartAssets } from '@/lib/estimate-line-parts';
import { loadEstimateGraphics, loadEstimateProofs, type EstimateProofBlock } from '@/lib/estimate-graphics';
import { r2PublicUrl } from '@/lib/r2';
import { loadEstimateAttachmentRows, fetchEstimateAttachments } from '@/lib/estimate-attachments';
import { resolveEstimateEmail, resolveEstimatePhone } from '@/lib/estimate-recipients';
import { MAX_ATTACHMENT_BYTES } from '@/lib/email-attachments';
import { generateEstimatePdf } from '@/lib/estimate-pdf-server';
import { estimatePdfFilename } from '@/lib/estimate-pdf';
import { validateBody, z } from '@/lib/validate';

export const dynamic = 'force-dynamic';
// Every send generates the estimate PDF (catalog photo fetches, and R2 +
// pdf-lib when linked wrap quotes / proofs merge on) — same budget as the
// other generateEstimatePdf routes (/pdf, /email-pdf); the platform default
// is too tight for a cold start with several assets.
export const maxDuration = 60;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SendForApprovalSchema = z.object({
  email: z.string().email().max(254).optional().nullable(),
  // Standard compose fields (docs/customer-email-standard.md): editable
  // multi-recipient To and bcc-the-sender.
  emails: z.array(z.string().email().max(254)).max(20).optional(),
  bccSelf: z.boolean().optional().default(false),
  phone: z.string().trim().max(40).optional().nullable(),
  expiryDays: z.number().int().positive().max(365).optional(),
  // Personal note rendered at the top of the estimate email (plain text,
  // newlines preserved). Same note block the wrap-quote email uses.
  message: z.string().trim().max(5000).optional(),
  // Preview: render exactly what would be sent (recipient, subject, HTML
  // body) WITHOUT minting a token, sending, or marking the estimate sent.
  preview: z.boolean().optional().default(false),
  // Per-job proof picks from the compose screen — which graphics_job_files
  // of each LINKED graphics job ride on this estimate's customer surfaces.
  // The full desired state: a linked job absent from the list (or with an
  // empty fileIds) contributes nothing. Persisted to
  // graphics_jobs.estimate_attach on the real send (previews only render
  // it); omit the field entirely to leave the stored selection untouched.
  proofSelections: z.array(z.object({
    jobId: z.string().uuid(),
    fileIds: z.array(z.string().uuid()).max(10),
  })).max(10).optional(),
  // Files the rep picked off the estimate (estimate_files) — pictures,
  // spec sheets. Attached to the email alongside the estimate document.
  attachmentFileIds: z.array(z.string().uuid()).max(20).optional(),
});

/**
 * POST /api/estimates/[id]/send-for-approval
 *
 * Mints (or rotates) an approval token on the estimate and dispatches an
 * email + (flag-gated) SMS to the customer's primary contact. Email works
 * today; SMS lands once SMS_PROVIDER_ENABLED flips on.
 *
 * Body: { email?, phone?, expiryDays? } — optional overrides. When absent,
 * falls back to the customer's primary external contact, then the
 * synced customer.email / customer.phone.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, SendForApprovalSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const expiryDays = body.expiryDays ?? 30;

  const { data: estimate, error: eErr } = await supabase
    .from('estimates')
    .select('*, vehicle_platforms(label)')
    .eq('id', params.id)
    .single();
  if (eErr || !estimate) {
    return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  }
  // Flatten the platform label for the document's vehicle line.
  (estimate as any).vehicle_platform_label = (estimate as any).vehicle_platforms?.label || null;
  if (estimate.customer_approved) {
    return NextResponse.json({ error: 'Already approved' }, { status: 409 });
  }

  // Resolve delivery targets. Explicit compose recipients win; otherwise
  // fall back to the customer's primary contact / synced profile.
  let email: string | null = body.email || null;
  let phone: string | null = body.phone || null;
  const composeEmails = (body.emails || []).map(e => e.trim()).filter(Boolean);

  // The estimate's customer OR its CRM lead (migration 251) — an estimate
  // quoted for a brand-new customer has no customers row yet, and resolving
  // through customer_id alone left it with nobody to send to.
  if (!email) email = await resolveEstimateEmail(supabase, estimate);
  if (!phone) phone = await resolveEstimatePhone(supabase, estimate);

  const emailList: string[] = composeEmails.length > 0 ? composeEmails : (email ? [email] : []);

  if (emailList.length === 0 && !phone && !body.preview) {
    return NextResponse.json({ error: 'No email or phone on file for this customer. Add a contact first.' }, { status: 400 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://bmg-ops.vercel.app';
  const subject = `[BMG Fleet] Estimate #${estimate.estimate_number} — Ready for your approval`;
  const message = body.message?.trim() || undefined;

  // The customer-facing document — line items, quantities, rates, totals —
  // loaded once for both the preview and the real send.
  const { data: rawLineItems } = await supabase
    .from('estimate_line_items')
    .select('*')
    .eq('estimate_id', estimate.id)
    .order('sort_order')
    .order('id');
  // Enhanced estimate: product photos + vendor links per line (same
  // enrichment the approval page and signed snapshot use).
  const lineItems = await enrichLinesWithPartAssets(supabase, rawLineItems || []);
  const { data: settings } = await supabase
    .from('wrap_quote_settings')
    .select('company')
    .eq('id', 1)
    .maybeSingle();
  const company = settings?.company || {};
  const logoUrl = company?.logo_path ? r2PublicUrl('vehicle-templates', company.logo_path) : null;
  // Sender's signature — in the preview too, so what she sees is what goes.
  const signature = await getEmailSignature(supabase, auth.user?.id);
  // Wrap content from linked wrap quotes (estimate_attach): the email BODY
  // must show the same vinyl/coverage content the attached merged PDF and
  // the frozen snapshot carry — one story on every surface.
  const { summaries: approvalGraphics } = await loadEstimateGraphics(supabase, estimate.id);

  // ── Graphic proofs from linked graphics jobs ──────────────────────────
  // The compose screen's per-job proof picker arrives as proofSelections —
  // the full desired state. Validate it against the actual link graph
  // (jobs linked to THIS estimate, files belonging to THAT job), persist
  // it to graphics_jobs.estimate_attach on the real send, and render the
  // same blocks into the email body the approval page / PDF / snapshot
  // will load. Approving this send later approves exactly these jobs.
  let proofBlocks: EstimateProofBlock[] = [];
  {
    const selections = body.proofSelections;
    if (selections !== undefined) {
      const { data: linkedJobs, error: linkErr } = await supabase
        .from('graphics_jobs')
        .select('id')
        .eq('estimate_id', estimate.id);
      if (linkErr) {
        return NextResponse.json({ error: 'Could not load linked graphics jobs: ' + linkErr.message }, { status: 500 });
      }
      const linkedIds = new Set((linkedJobs || []).map(j => j.id));
      const cleaned = selections
        .map(s => ({ jobId: s.jobId, fileIds: [...new Set(s.fileIds)] }))
        .filter(s => s.fileIds.length > 0);
      for (const s of cleaned) {
        if (!linkedIds.has(s.jobId)) {
          return NextResponse.json({ error: 'A selected graphics job is not linked to this estimate. Reload and try again.' }, { status: 400 });
        }
      }
      const allFileIds = [...new Set(cleaned.flatMap(s => s.fileIds))];
      if (allFileIds.length > 0) {
        const { data: fileRows } = await supabase
          .from('graphics_job_files')
          .select('id, job_id')
          .in('id', allFileIds);
        const fileJob = new Map((fileRows || []).map(f => [f.id, f.job_id]));
        for (const s of cleaned) {
          if (s.fileIds.some(id => fileJob.get(id) !== s.jobId)) {
            return NextResponse.json({ error: 'Some selected proof files do not belong to their graphics job. Reload and try again.' }, { status: 400 });
          }
        }
      }
      if (!body.preview) {
        // Persist the full desired state on every linked job — selected
        // jobs get their file list, the rest are cleared.
        const byJob = new Map(cleaned.map(s => [s.jobId, s.fileIds]));
        for (const jobId of linkedIds) {
          const fileIds = byJob.get(jobId);
          const { error: attachErr } = await supabase
            .from('graphics_jobs')
            .update({ estimate_attach: fileIds ? { file_ids: fileIds } : null, updated_at: new Date().toISOString() })
            .eq('id', jobId);
          if (attachErr) {
            return NextResponse.json({ error: 'Could not save the proof selection: ' + attachErr.message }, { status: 500 });
          }
        }
        proofBlocks = await loadEstimateProofs(supabase, estimate.id);
      } else {
        proofBlocks = await loadEstimateProofs(supabase, estimate.id, cleaned);
      }
    } else {
      // Legacy caller without the picker — the stored selection still rides.
      proofBlocks = await loadEstimateProofs(supabase, estimate.id);
    }
  }

  // Files the rep picked off the estimate. Resolved before the preview so
  // the document lists exactly what the customer will receive, and
  // validated against THIS estimate.
  const picked = await loadEstimateAttachmentRows(supabase, estimate.id, body.attachmentFileIds);
  if (!picked.ok) return NextResponse.json({ error: picked.error }, { status: picked.status });

  // Every transaction email carries a PDF copy of the transaction (CLAUDE.md
  // domain note): the estimate PDF — the same bytes as the Estimate PDF /
  // Email PDF buttons, with any linked wrap assets and proofs merged on —
  // rides first on every approval send, so the customer can save or
  // forward the estimate without digging through the original email. It is
  // named in the document's Attached section alongside the rep's picks.
  const pdfFilename = estimatePdfFilename(estimate);
  const attachmentNames = [pdfFilename, ...picked.rows.map(r => r.file_name)];

  // Preview: show exactly what would go out (message, line items, totals,
  // Approve button) without minting a token, sending, or touching status.
  // The CTA points at a placeholder — the real link is minted on send.
  if (body.preview) {
    // The PDF is generated on the real send, not here — the preview only
    // names it so the compose screen can say so.
    const html = renderEstimateDocument(estimate, lineItems || [], {
      company,
      logoUrl,
      message,
      ctaUrl: `${appUrl}/approve/estimate/`,
      ctaLabel: 'Review & Approve',
      ctaNote: `A unique, secure link is generated when you send. It expires in ${expiryDays} days.`,
      signature,
      graphics: approvalGraphics,
      proofs: proofBlocks,
      attachmentNames,
    });
    return NextResponse.json({ preview: true, to: emailList.join(', ') || null, subject, html, attachments: [pdfFilename] });
  }

  // Attachments are assembled BEFORE the token is minted or the estimate is
  // stamped sent (docs/customer-email-standard.md): a storage failure must
  // fail the whole send, not leave a rotated link on a record that already
  // claims it went out.
  //
  // The estimate PDF rides first and takes its share of the budget; the
  // rep's picked files get what's left. Both are hard errors when they
  // can't be produced: the document's Attached section names them, so an
  // email that promises a PDF and arrives without one is worse than asking
  // the sender to try again.
  const approvalAttachments: { filename: string; content: Buffer; contentType: string }[] = [];
  if (emailList.length > 0) {
    // The PDF copy of the estimate — with any linked wrap-quote assets
    // (estimate_attach: coverage diagram, attachments, vinyl details) and
    // graphics-job proofs merged on, so the customer approves ONE document
    // carrying all of it.
    let pdf: Awaited<ReturnType<typeof generateEstimatePdf>>;
    try {
      pdf = await generateEstimatePdf(supabase, estimate.id);
    } catch (err: any) {
      console.error('[send-for-approval] estimate PDF failed:', err?.message || err);
      pdf = { ok: false, status: 500, error: err?.message || 'PDF render failed' };
    }
    if (!pdf.ok) {
      return NextResponse.json({ error: `Could not generate the estimate PDF (${pdf.error}). Nothing was sent — try again.` }, { status: pdf.status === 404 ? 404 : 502 });
    }
    approvalAttachments.push({ filename: pdf.filename, content: pdf.buffer, contentType: 'application/pdf' });

    const usedBytes = approvalAttachments.reduce((sum, a) => sum + a.content.byteLength, 0);
    const extras = await fetchEstimateAttachments(picked.rows, Math.max(0, MAX_ATTACHMENT_BYTES - usedBytes));
    if (!extras.ok) return NextResponse.json({ error: extras.error }, { status: extras.status });
    for (const a of extras.attachments) {
      approvalAttachments.push({ filename: a.filename, content: a.content, contentType: a.contentType || 'application/octet-stream' });
    }
  }

  // Mint a fresh token — rotating on resend invalidates prior links.
  const { token, expiresAt } = generateToken(expiryDays);
  const { error: updErr } = await supabase
    .from('estimates')
    .update({
      approval_token: token,
      approval_token_expires_at: expiresAt,
      // Fingerprint of what this send actually contains (items + money).
      // The accept route refuses when the estimate no longer matches it —
      // an edit landing while the link is live can't become a "signed"
      // record the customer never saw (migration 242, Round 3 finding).
      approval_sent_hash: approvalContentHash(estimate, rawLineItems || []),
      sent_for_approval_at: new Date().toISOString(),
      sent_for_approval_by: auth.user.id,
      // 'rejected' also flips back to 'sent': a resent-after-rejection
      // estimate previously KEPT status 'rejected', dropping out of the
      // follow-up cron and the open-quotes math while its link was live
      // (Round 3 finding).
      status: ['draft', 'rejected'].includes(estimate.status) ? 'sent' : estimate.status,
      // Clear any prior rejection so the resent link is actionable — but
      // keep the objection: it was the only record of WHY the customer
      // said no, and nulling it erased that silently.
      ...(estimate.customer_rejected_at ? {
        internal_notes: `${estimate.internal_notes ? `${estimate.internal_notes}\n` : ''}[${new Date().toISOString().slice(0, 10)}] Resent after rejection (${String(estimate.customer_rejected_at).slice(0, 10)}): ${estimate.customer_rejection_reason || 'no reason given'}`.slice(0, 5000),
      } : {}),
      customer_rejected_at: null,
      customer_rejection_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', estimate.id);
  if (updErr) {
    return NextResponse.json({ error: 'Failed to mint token: ' + updErr.message }, { status: 500 });
  }

  // A resend-after-rejection reopens the estimate (status back to 'sent'
  // above) — folded wrap quotes that were auto-rejected with it come back
  // too, so the whole document is live again, not just the upfit half.
  if (estimate.customer_rejected_at) {
    await reconcileLinkedWrapQuotes(supabase, estimate.id, 'reopened', new Date().toISOString());
  }

  const dispatch: Record<string, any> = { email: null, sms: null };

  if (emailList.length > 0) {
    const link = `${appUrl}/approve/estimate/${token}?via=email&to=${encodeURIComponent(emailList[0])}`;
    // The real estimate document, not a notification card: the old email
    // carried a one-line summary and no quantities, rates, or line totals
    // at all — the fields customers kept asking about.
    const html = renderEstimateDocument(estimate, lineItems || [], {
      company,
      logoUrl,
      message,
      ctaUrl: link,
      ctaLabel: 'Review & Approve',
      ctaNote: `This link expires in ${expiryDays} days.`,
      signature,
      graphics: approvalGraphics,
      proofs: proofBlocks,
      attachmentNames,
    });
    const bcc = body.bccSelf && auth.user?.email ? [auth.user.email] : undefined;

    try {
      const { ok, id: resendId } = await sendEmailDetailed(
        emailList, subject, html, undefined,
        approvalAttachments.length > 0 ? approvalAttachments : undefined,
        auth.user?.email || undefined, bcc,
        { kind: 'estimate_approval', sentBy: auth.user?.id, contextUrl: deepLinks.estimate(estimate.id), customerId: estimate.customer_id, netsuiteCustomerId: estimate.customer_netsuite_id },
      );
      dispatch.email = { target: emailList.join(', '), ok, bcc: bcc ? bcc.join(', ') : undefined };
      // Delivery tracking (same scheme as invoice emails): store the Resend
      // message id so the webhook can update this estimate's delivery state,
      // and reset the state for this fresh send. A failed hand-off to Resend
      // is recorded as 'failed' immediately — no webhook will ever come.
      // Best-effort: a logging failure never turns a sent email into an error.
      const { error: trackErr } = await supabase
        .from('estimates')
        .update({
          approval_email_id: ok ? resendId : null,
          approval_email_to: emailList,
          approval_email_status: ok ? 'sent' : 'failed',
          approval_email_detail: ok ? null : 'The email could not be handed to the delivery service',
          approval_email_updated_at: new Date().toISOString(),
        })
        .eq('id', estimate.id);
      if (trackErr) console.error('estimate email tracking update failed:', trackErr.message);
    } catch (err: any) {
      dispatch.email = { target: emailList.join(', '), ok: false, error: err?.message };
    }
  }

  if (phone) {
    const link = `${appUrl}/approve/estimate/${token}?via=sms${phone ? `&to=${encodeURIComponent(phone)}` : ''}`;
    const smsBody = `[BMG Fleet] Estimate #${estimate.estimate_number} ready for approval. ${link}`;
    try {
      const result = await sendSMS(phone, smsBody);
      dispatch.sms = {
        target: phone,
        ok: result.ok,
        skipped: result.skipped || false,
        providerName: result.providerName,
        error: result.error || null,
      };
    } catch (err: any) {
      dispatch.sms = { target: phone, ok: false, error: err?.message };
    }
  }

  // The live token/URL is deliberately NOT echoed back: any estimates user
  // could copy it out of the response, open the customer's page, and click
  // Accept — a forged E-SIGN acceptance the convert gate trusts, which is
  // exactly the threat stripApprovalSecrets closed on the list API
  // (Round 3 finding). Delivery always goes through email/SMS (the route
  // rejects a send with no target), so staff never need the raw link.
  return NextResponse.json({
    status: 'sent',
    expiresAt,
    dispatch,
  });
}
