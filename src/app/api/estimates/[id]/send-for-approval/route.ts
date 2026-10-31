import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature, getProfileRoles } from '@/lib/api-auth';
import { checkDiscountApproval } from '@/lib/discount-approval';
import { generateToken, approvalContentHash } from '@/lib/magic-link-approval';
import { reconcileLinkedWrapQuotes } from '@/lib/wrap-quote-reconcile';
import { sendEmailDetailed, repFromName } from '@/lib/resend';
import { deepLinks } from '@/lib/deep-links';
import { docRef } from '@/lib/document-sends';
import { sendSMS } from '@/lib/sms-provider';
import { renderEstimateDocument, renderEstimateBatchDocument, vehicleDescription, type FleetDocVehicle, type BatchDocEstimate } from '@/lib/estimate-document';
import { getEmailSignature } from '@/lib/email-signature';
import { enrichLinesWithPartAssets } from '@/lib/estimate-line-parts';
import { loadEstimateGraphics, loadEstimateProofs, proofBlocksForEmail, type EstimateProofBlock } from '@/lib/estimate-graphics';
import { r2PublicUrl } from '@/lib/r2';
import { loadEstimateAttachmentRows, recordEstimateFilesSent } from '@/lib/estimate-attachments';
import { approvalDownloadUrls, downloadLinkExpiry } from '@/lib/estimate-approval-downloads';
import { approvalCtaNote, approvalEmailExtras } from '@/lib/estimate-approval-email';
import { resolveEstimateEmail, resolveEstimatePhone } from '@/lib/estimate-recipients';
import { estimatePdfFilename } from '@/lib/estimate-pdf';
import { validateBody, z } from '@/lib/validate';
import { computeQuotedMargin, estimateDiscountRatio, getMarginFloorPct } from '@/lib/quoted-margin';
import { netUnitPrice, normalizeVehicleCount } from '@/lib/estimate-totals';
import { getShopLaborRate } from '@/lib/shop-labor';
import { logAudit } from '@/lib/audit';
import { notify, notifyMany, getSuperAdminIds } from '@/lib/notify';
import { enforceCustomerHold } from '@/lib/customer-hold-server';
import { fleetMembers, compareUnits } from '@/lib/estimate-fleet';
import { estimateIsLocked } from '@/lib/estimate-copy';
import { estimateCustomerKey, MAX_BATCH_ESTIMATES } from '@/lib/estimate-batch';
import { randomUUID } from 'crypto';

// R3-22: proof images are presigned at the 7-day SigV4 maximum. Only the
// compose preview shows those links now — the sent email points its proof
// pictures at our own token-gated route (proofBlocksForEmail), because
// foreign signed storage URLs push the email toward customers' junk folders.
const EMAIL_PRESIGN_SECONDS = 7 * 24 * 3600;

export const dynamic = 'force-dynamic';
// A send renders the document and sends one email per recipient; the
// platform default is tight for a cold start with several recipients.
export const maxDuration = 60;

const supabase = createServiceClient();

const SendForApprovalSchema = z.object({
  email: z.string().email().max(254).optional().nullable(),
  // Standard compose fields (docs/customer-email-standard.md): editable
  // multi-recipient To and bcc-the-sender.
  emails: z.array(z.string().email().max(254)).max(20).optional(),
  bccSelf: z.boolean().optional().default(false),
  cc: z.array(z.string().email().max(254)).max(10).optional(),
  phone: z.string().trim().max(40).optional().nullable(),
  expiryDays: z.number().int().positive().max(365).optional(),
  // Personal note rendered at the top of the estimate email (plain text,
  // newlines preserved). Same note block the wrap-quote email uses.
  message: z.string().trim().max(5000).optional(),
  // Preview: render exactly what would be sent (recipient, subject, HTML
  // body) WITHOUT minting a token, sending, or marking the estimate sent.
  preview: z.boolean().optional().default(false),
  // R5-3: required (typed, non-empty) when the quoted parts margin is
  // below the floor — recorded on the estimate, audit-logged, and the
  // owners are notified. Absent on a below-floor send → 409 with the
  // numbers so the client can prompt.
  floorReason: z.string().trim().max(500).optional(),
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
  // spec sheets. Linked from the email as downloads (nothing is attached).
  attachmentFileIds: z.array(z.string().uuid()).max(20).optional(),
  // A fleet order (migration 410) in ONE email (migration 412, Craig
  // 2026-10-19): this estimate plus every other vehicle of its order that
  // is still open for approval (not approved, not on a sales order). Each
  // keeps its own token and approval; the email lists them all and links
  // the order's approval page. Ignored for an estimate with no order.
  fleet: z.boolean().optional().default(false),
  // Several of the same customer's estimates picked on the Estimates list
  // (Craig, 2026-10-28): these go in the same email as this one, sent the
  // way a fleet order is (one token each, a shared batch id, the
  // approve-all page), but listed as separate estimates, not as the same
  // build on several vehicles. Every one must be for this estimate's
  // customer and still open for approval. Takes the place of `fleet`.
  alsoIds: z.array(z.string().uuid()).max(MAX_BATCH_ESTIMATES - 1).optional(),
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

  // Customer on hold for past-due invoices (migration 366): the real send
  // needs an admin / A/R override with a reason. Previews still render.
  if (!body.preview) {
    const held = await enforceCustomerHold(req, supabase, auth, {
      netsuiteId: estimate.customer_netsuite_id, customerId: estimate.customer_id,
      customerName: estimate.customer_name, action: 'estimate_send', recordId: estimate.id,
    });
    if (held) return held;
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

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://go.bmgfleet.com';
  let subject = `[BMG Fleet] Estimate #${estimate.estimate_number} — Ready for your approval`;
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
      // Its own jobs, and its fleet order's one job (the same set
      // loadEstimateProofs reads).
      const { data: linkedJobs, error: linkErr } = await supabase
        .from('graphics_jobs')
        .select('id')
        .or(estimate.fleet_group_id ? `estimate_id.eq.${estimate.id},fleet_group_id.eq.${estimate.fleet_group_id}` : `estimate_id.eq.${estimate.id}`);
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
        proofBlocks = await loadEstimateProofs(supabase, estimate.id, undefined, { expiresIn: EMAIL_PRESIGN_SECONDS });
      } else {
        proofBlocks = await loadEstimateProofs(supabase, estimate.id, cleaned, { expiresIn: EMAIL_PRESIGN_SECONDS });
      }
    } else {
      // Legacy caller without the picker — the stored selection still rides.
      proofBlocks = await loadEstimateProofs(supabase, estimate.id, undefined, { expiresIn: EMAIL_PRESIGN_SECONDS });
    }
  }

  // Files the rep picked off the estimate. Resolved before the preview so
  // the document lists exactly what the customer will receive, and
  // validated against THIS estimate.
  const picked = await loadEstimateAttachmentRows(supabase, estimate.id, body.attachmentFileIds);
  if (!picked.ok) return NextResponse.json({ error: picked.error }, { status: picked.status });

  // The approval email attaches NOTHING (Craig, 2026-10-21): with the PDF
  // attached, customers opened it and replied "approved" instead of pressing
  // Review & Approve. The estimate PDF — the same bytes as the Estimate PDF
  // / Email PDF buttons, with any linked wrap assets and proofs merged on —
  // is a Download PDF link under the button at the top, and it and the
  // rep's picks are listed as downloads. Those links last a year
  // (estimate_download_tokens, migration 424), so the email stays the
  // customer's copy to save or forward.
  const pdfFilename = estimatePdfFilename(estimate);

  // The other vehicles of a fleet order going in this same email, and every
  // vehicle in unit order. With none open, this is an ordinary single send.
  // Or, picked on the Estimates list, the customer's other estimates in
  // the order picked.
  const alsoIds = [...new Set((body.alsoIds || []).filter(id => id !== estimate.id))];
  let siblings: any[];
  if (alsoIds.length > 0) {
    const picked = await batchSiblings(estimate, alsoIds);
    if ('error' in picked) return NextResponse.json({ error: picked.error }, { status: 400 });
    siblings = picked.rows;
  } else {
    siblings = body.fleet && estimate.fleet_group_id ? await sendableSiblings(estimate) : [];
  }
  const fleetSend = siblings.length > 0;
  const batchSend = fleetSend && alsoIds.length > 0;
  const orderEstimates = batchSend
    ? [estimate, ...siblings]
    : [estimate, ...siblings].sort((a, b) => compareUnits(a.unit_number, b.unit_number));
  if (batchSend) {
    subject = `[BMG Fleet] ${orderEstimates.length} estimates (${orderEstimates.map(e => `#${e.estimate_number}`).join(', ')}) — Ready for your approval`;
  } else if (fleetSend) {
    subject = `[BMG Fleet] Estimates for ${orderEstimates.length} vehicles (${orderEstimates.map(e => `#${e.estimate_number}`).join(', ')}) — Ready for your approval`;
  }
  // Every vehicle's PDF is listed (each is that vehicle's transaction),
  // then the rep's picks.
  const pdfNames = orderEstimates.map(e => estimatePdfFilename(e));
  const attachmentNames = [...(fleetSend ? pdfNames : [pdfFilename]), ...picked.rows.map(r => r.file_name)];
  const fleetVehicles = (urls?: Map<string, { reviewUrl: string; pdfUrl: string }>): { vehicles: FleetDocVehicle[] } | null => (fleetSend
    ? {
      vehicles: orderEstimates.map(e => ({
        estimateNumber: e.estimate_number,
        unitNumber: e.unit_number || null,
        stockNumber: e.stock_number || null,
        vin: e.vin || null,
        grandTotal: e.grand_total,
        reviewUrl: urls?.get(e.id)?.reviewUrl || null,
        pdfUrl: urls?.get(e.id)?.pdfUrl || null,
      })),
    }
    : null);
  // A batch email's rows: each estimate with what it's for.
  const batchRows = (urls?: Map<string, { reviewUrl: string; pdfUrl: string }>): BatchDocEstimate[] => orderEstimates.map(e => ({
    estimateNumber: e.estimate_number,
    title: e.title || null,
    vehicle: [vehicleDescription(e), e.unit_number ? `Unit ${e.unit_number}` : null, e.stock_number ? `Stock ${e.stock_number}` : null].filter(Boolean).join(' · ') || null,
    grandTotal: e.grand_total,
    reviewUrl: urls?.get(e.id)?.reviewUrl || null,
    pdfUrl: urls?.get(e.id)?.pdfUrl || null,
  }));

  // Preview: show exactly what would go out (message, line items, totals,
  // Approve button) without minting a token, sending, or touching status.
  // The CTA points at a placeholder — the real link is minted on send.
  if (body.preview) {
    // The PDF is generated on the real send, not here — the preview only
    // names it so the compose screen can say so.
    const html = batchSend
      ? renderEstimateBatchDocument(batchRows(), estimate.customer_name, {
        company,
        logoUrl,
        message,
        ctaUrl: `${appUrl}/approve/fleet/`,
        ctaLabel: `Review & approve all ${orderEstimates.length}`,
        ctaNote: `A unique, secure link is generated for each person when you send. It expires in ${expiryDays} days.`,
        ...approvalEmailExtras(true, `${appUrl}/approve/estimate/`),
        signature,
        attachmentNames,
      })
      : renderEstimateDocument(estimate, lineItems || [], {
      company,
      logoUrl,
      message,
      ctaUrl: `${appUrl}/approve/${fleetSend ? 'fleet' : 'estimate'}/`,
      ctaLabel: fleetSend ? `Review & approve all ${orderEstimates.length}` : 'Review & Approve',
      ctaNote: `A unique, secure link is generated for each person when you send. It expires in ${expiryDays} days.`,
      ...approvalEmailExtras(fleetSend, `${appUrl}/approve/estimate/`),
      signature,
      graphics: approvalGraphics,
      proofs: proofBlocks,
      attachmentNames,
      fleet: fleetVehicles(),
    });
    return NextResponse.json({
      preview: true, to: emailList.join(', ') || null, subject, html,
      // Nothing is attached; the compose screen names the linked PDF(s).
      attachments: [],
      pdfLinks: fleetSend ? pdfNames : [pdfFilename],
      // The compose screen says which vehicles this one email covers.
      fleet: fleetSend ? orderEstimates.map(e => ({ id: e.id, estimateNumber: e.estimate_number, unitNumber: e.unit_number || null })) : null,
    });
  }

  // Every estimate in the send carries its own lines; a fleet send checks
  // each vehicle the way a single send checks one.
  const rawLinesById = new Map<string, any[]>([[estimate.id, rawLineItems || []]]);
  for (const sib of siblings) {
    const { data } = await supabase.from('estimate_line_items').select('*').eq('estimate_id', sib.id).order('sort_order').order('id');
    rawLinesById.set(sib.id, data || []);
  }

  // Discounts over the admin-approval limit (migration 365) stop here until
  // an admin approves them; an admin sending is their approval.
  for (const e of orderEstimates) {
    const discountBlock = await checkDiscountApproval(supabase, e, rawLinesById.get(e.id) || [], { id: auth.user.id, roles: getProfileRoles(auth.profile) }, 'sent');
    if (discountBlock) {
      const error = batchSend
        ? `Estimate #${e.estimate_number}: ${discountBlock.error}`
        : fleetSend ? `Estimate #${e.estimate_number} (unit ${e.unit_number || '?'}): ${discountBlock.error}` : discountBlock.error;
      return NextResponse.json({ error, step: 'discount_approval', discountApproval: discountBlock.status }, { status: 409 });
    }
  }

  // ── Quoted-margin freeze + floor gate (R5-3, migration 275) ──
  // Frozen here, at the one real send path, BEFORE any attachment/PDF work
  // is spent (see quotedMarginFor). One reason covers a fleet send.
  const margins = new Map<string, Awaited<ReturnType<typeof quotedMarginFor>>>();
  for (const e of orderEstimates) margins.set(e.id, await quotedMarginFor(e, rawLinesById.get(e.id) || []));
  const floorReason = (body.floorReason || '').trim();
  const under = orderEstimates.filter(e => margins.get(e.id)!.belowFloor);
  if (under.length > 0 && !floorReason) {
    const lowest = under.map(e => margins.get(e.id)!).sort((a, b) => (a.quotedMargin.marginPct ?? 0) - (b.quotedMargin.marginPct ?? 0))[0];
    const which = fleetSend
      ? `${under.length} of the ${orderEstimates.length} ${batchSend ? 'estimates' : 'vehicles'} (${under.map(e => `#${e.estimate_number}`).join(', ')}) have a parts margin as low as`
      : 'This quote\'s parts margin is';
    return NextResponse.json({
      error: `${which} ${lowest.quotedMargin.marginPct}%, below the ${lowest.floorPct}% floor. Give a reason to send anyway — it's recorded and the owner is notified.`,
      belowFloor: true,
      marginPct: lowest.quotedMargin.marginPct,
      floorPct: lowest.floorPct,
      canOverride: true,
    }, { status: 409 });
  }

  // Mint a fresh token — rotating on resend invalidates prior links. A
  // fleet send mints one per vehicle, all sharing a batch id the order's
  // approval page finds them by; the other vehicles first, so a failure
  // leaves this estimate's own link as it was.
  const batchId = fleetSend ? randomUUID() : null;
  const tokens = new Map<string, string>();
  let expiresAt = '';
  for (const e of [...siblings, estimate]) {
    const minted = generateToken(expiryDays);
    expiresAt = minted.expiresAt;
    const { error: updErr } = await supabase
      .from('estimates')
      .update(approvalPatch(e, rawLinesById.get(e.id) || [], minted, margins.get(e.id)!, floorReason, e.id === estimate.id ? picked.rows.map(r => r.id) : [], batchId, auth.user.id))
      .eq('id', e.id);
    if (updErr) {
      return NextResponse.json({ error: `Failed to mint token${fleetSend ? ` for estimate #${e.estimate_number}` : ''}: ` + updErr.message }, { status: 500 });
    }
    tokens.set(e.id, minted.token);
  }
  const token = tokens.get(estimate.id)!;

  // Every send's download links last a year, past the approval link's
  // expiry and any later resend (migration 424) — the email attaches
  // nothing, so these links are the customer's copy. Best-effort: a failed
  // record still leaves the links working for the approval link's life.
  {
    const downloadsUntil = downloadLinkExpiry();
    const { error: dlErr } = await supabase.from('estimate_download_tokens').insert(
      [...siblings, estimate].map(e => ({
        token: tokens.get(e.id)!,
        estimate_id: e.id,
        file_ids: e.id === estimate.id ? picked.rows.map(r => r.id) : [],
        expires_at: downloadsUntil,
      })),
    );
    if (dlErr) console.error('[send-for-approval] download token record failed:', dlErr.message);
  }
  // The estimate's Pictures & files tags ("Sent for approval 10/21").
  await recordEstimateFilesSent(supabase, picked.rows.map(r => r.id), 'approval');

  for (const e of orderEstimates) await afterSendCommitted(e, margins.get(e.id)!, floorReason, auth.user.id);

  const dispatch: Record<string, any> = { email: null, sms: null };

  if (emailList.length > 0) {
    // One email per person, each link naming its reader (?to=…&own=1), so
    // the estimate records WHO approved or asked for changes — the way
    // proof emails work since 2026-10-16. One shared link named only the
    // first address, whoever clicked. The compose screen's Cc teammates get
    // their own copies too; each email lists everyone else it went to, and
    // the sender's Bcc rides on the first one only.
    const cc = (body.cc || []).map(e => e.trim()).filter(Boolean);
    const people = [...new Set([...emailList, ...cc].map(e => e.toLowerCase()))]
      .map(lower => [...emailList, ...cc].find(e => e.toLowerCase() === lower)!);
    const bcc = body.bccSelf && auth.user?.email ? [auth.user.email] : undefined;
    const downloadUrls = approvalDownloadUrls(appUrl, token);
    const vehiclePdfUrls = new Map(orderEstimates.map(e => [e.id, approvalDownloadUrls(appUrl, tokens.get(e.id)!).pdf]));
    const sent: string[] = [];
    const failed: string[] = [];
    const resendIds: string[] = [];
    let lastError: string | undefined;
    for (const [i, person] of people.entries()) {
      const via = `?via=email&to=${encodeURIComponent(person)}&own=1`;
      const link = fleetSend ? `${appUrl}/approve/fleet/${token}${via}` : `${appUrl}/approve/estimate/${token}${via}`;
      const vehicleUrls = new Map(orderEstimates.map(e => [e.id, {
        reviewUrl: `${appUrl}/approve/estimate/${tokens.get(e.id)}${via}`,
        pdfUrl: vehiclePdfUrls.get(e.id)!,
      }]));
      // The real estimate document, not a notification card: the old email
      // carried a one-line summary and no quantities, rates, or line totals
      // at all — the fields customers kept asking about.
      const attachmentLinks = [
        ...(fleetSend
          ? orderEstimates.map((e, n) => ({ name: pdfNames[n], url: vehiclePdfUrls.get(e.id)! }))
          : [{ name: pdfFilename, url: downloadUrls.pdf }]),
        ...picked.rows.map(r => ({ name: r.file_name, url: downloadUrls.file(r.id) })),
      ];
      const html = batchSend
        ? renderEstimateBatchDocument(batchRows(vehicleUrls), estimate.customer_name, {
          company,
          logoUrl,
          message,
          ctaUrl: link,
          ctaLabel: `Review & approve all ${orderEstimates.length}`,
          ctaNote: approvalCtaNote(expiryDays, people.filter(p => p !== person)),
          ...approvalEmailExtras(true, downloadUrls.pdf),
          signature,
          attachmentNames: attachmentLinks,
        })
        : renderEstimateDocument(estimate, lineItems || [], {
        company,
        logoUrl,
        message,
        ctaUrl: link,
        ctaLabel: fleetSend ? `Review & approve all ${orderEstimates.length}` : 'Review & Approve',
        ctaNote: approvalCtaNote(expiryDays, people.filter(p => p !== person)),
        ...approvalEmailExtras(fleetSend, downloadUrls.pdf),
        fleet: fleetVehicles(vehicleUrls),
        signature,
        graphics: approvalGraphics,
        proofs: proofBlocksForEmail(proofBlocks, appUrl, token),
        // Download links behind this send's token, for the customer and
        // whoever they forward the email to.
        attachmentNames: attachmentLinks,
      });
      try {
        const { ok, id: resendId } = await sendEmailDetailed(
          person, subject, html, undefined, undefined,
          auth.user?.email || undefined,
          i === 0 ? bcc : undefined,
          { kind: 'estimate_approval', cc: null, sentBy: auth.user?.id, fromName: repFromName((auth.profile as any)?.full_name), contextUrl: deepLinks.estimate(estimate.id), docRefs: [estimate.id, ...siblings.map(x => x.id)].map(id => docRef('estimate', id)), customerId: estimate.customer_id, netsuiteCustomerId: estimate.customer_netsuite_id },
        );
        (ok ? sent : failed).push(person);
        if (ok && resendId) resendIds.push(resendId);
      } catch (err: any) {
        failed.push(person);
        lastError = err?.message;
      }
    }
    const ok = sent.length > 0;
    dispatch.email = {
      target: ok
        ? `${sent.join(', ')}${failed.length > 0 ? ` (not sent to ${failed.join(', ')})` : ''}`
        : people.join(', '),
      ok,
      bcc: bcc ? bcc.join(', ') : undefined,
      ...(!ok && lastError ? { error: lastError } : {}),
    };
    // Delivery tracking (same scheme as invoice emails): store the Resend
    // message ids so the webhook can update this estimate's delivery state
    // — every person's email, since any of them can bounce — and reset the
    // state for this fresh send. A failed hand-off to Resend is recorded as
    // 'failed' immediately — no webhook will ever come. Best-effort: a
    // logging failure never turns a sent email into an error.
    const { error: trackErr } = await supabase
      .from('estimates')
      .update({
        approval_email_id: resendIds[0] || null,
        approval_email_ids: resendIds,
        approval_email_to: emailList,
        // Everyone else on the send (Cc teammates, Bcc) — the bounce alert
        // must know them all.
        approval_email_copies: [...cc, ...(bcc || [])],
        approval_email_status: ok ? 'sent' : 'failed',
        approval_email_detail: ok ? null : 'The email could not be handed to the delivery service',
        approval_email_updated_at: new Date().toISOString(),
      })
      .in('id', orderEstimates.map(e => e.id));
    if (trackErr) console.error('estimate email tracking update failed:', trackErr.message);
  }

  if (phone) {
    const link = `${appUrl}/approve/${fleetSend ? 'fleet' : 'estimate'}/${token}?via=sms&to=${encodeURIComponent(phone)}&own=1`;
    const smsBody = batchSend
      ? `[BMG Fleet] ${orderEstimates.length} estimates ready for approval. ${link}`
      : fleetSend
      ? `[BMG Fleet] Estimates for ${orderEstimates.length} vehicles ready for approval. ${link}`
      : `[BMG Fleet] Estimate #${estimate.estimate_number} ready for approval. ${link}`;
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

  // An internal review still open when the customer send lands is settled by
  // that send (see settleInternalReview).
  if (dispatch.email?.ok || dispatch.sms?.ok) {
    for (const e of orderEstimates) await settleInternalReview(e, auth);
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
    fleet: fleetSend ? { count: orderEstimates.length, batch: batchSend } : null,
  });
}

/**
 * The estimates picked on the Estimates list to go in this one's email
 * (Craig, 2026-10-28): every one must exist, be for this estimate's
 * customer, and still be open for approval. Anything else is refused with
 * its number rather than quietly left out, since the sender picked it.
 */
async function batchSiblings(estimate: any, ids: string[]): Promise<{ rows: any[] } | { error: string }> {
  const { data, error } = await supabase.from('estimates').select('*, vehicle_platforms(label)').in('id', ids);
  if (error) return { error: 'Could not load the other estimates: ' + error.message };
  const byId = new Map((data || []).map(e => [e.id, e]));
  const rows: any[] = [];
  const customer = estimateCustomerKey(estimate);
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) return { error: 'One of the picked estimates no longer exists. Reload the list and try again.' };
    if (estimateCustomerKey(e) !== customer) {
      return { error: `Estimate #${e.estimate_number} is for ${e.customer_name || 'another customer'}, not ${estimate.customer_name || 'this customer'}. Each customer gets their own email.` };
    }
    if (estimateIsLocked(e)) {
      return { error: `Estimate #${e.estimate_number} is already approved or on a sales order, so it can't be sent for approval again.` };
    }
    rows.push({ ...e, vehicle_platform_label: (e as any).vehicle_platforms?.label || null });
  }
  return { rows };
}

/**
 * The other vehicles of an estimate's fleet order that can go out with it:
 * current members (not superseded by a revision) still open for approval,
 * i.e. not customer-approved and not already on a sales order.
 */
async function sendableSiblings(estimate: any): Promise<any[]> {
  const members = await fleetMembers(supabase, estimate.fleet_group_id);
  const ids = members.map(m => m.id).filter(id => id !== estimate.id);
  if (ids.length === 0) return [];
  const { data } = await supabase.from('estimates').select('*, vehicle_platforms(label)').in('id', ids);
  return (data || [])
    .filter(e => !estimateIsLocked(e))
    .map(e => ({ ...e, vehicle_platform_label: (e as any).vehicle_platforms?.label || null }));
}

/**
 * The quoted parts margin frozen on a send (R5-3, migration 275). The
 * builder computes this live and throws it away; the send freezes it. The
 * formula mirrors the builder's Parts Margin strip exactly (costs from
 * netsuite_parts by part_id; uncosted lines excluded, never 100%); labor is
 * costed separately at the blended shop rate when one is set.
 */
async function quotedMarginFor(estimate: any, rawLineItems: any[]) {
  const partIds = [...new Set(rawLineItems.map((l: any) => l.part_id).filter(Boolean))] as string[];
  const costByPart = new Map<string, { purchase_price: number | null; avg_install_cost: number | null }>();
  for (let i = 0; i < partIds.length; i += 200) {
    const { data: parts } = await supabase
      .from('netsuite_parts')
      .select('id, purchase_price, avg_install_cost')
      .in('id', partIds.slice(i, i + 200));
    for (const p of parts || []) costByPart.set(p.id, { purchase_price: p.purchase_price, avg_install_cost: p.avg_install_cost });
  }
  const effectiveLaborHours = Number(estimate.labor_hours_override ?? estimate.labor_hours) || 0;
  const [laborCostRate, floorPct] = await Promise.all([
    getShopLaborRate(supabase),
    getMarginFloorPct(supabase),
  ]);
  // Fleet multi-unit (R6-9): the frozen margin describes the WHOLE job, like
  // the total the customer signs. The percentage is unchanged either way, so
  // the floor gate behaves identically — but the stored cost and revenue
  // figures feed the Quoted Margin report, and per-vehicle dollars there
  // would be the job's margin divided by the vehicle count.
  const marginUnits = normalizeVehicleCount(estimate.vehicle_count);
  const quotedMargin = computeQuotedMargin(
    rawLineItems.map((l: any) => ({
      item_number: l.item_number ?? null,
      quantity: (Number(l.quantity) || 0) * marginUnits,
      // After the line's own discount (migration 350): that is what it earns.
      unit_price: netUnitPrice(l, marginUnits),
      purchase_price: l.part_id ? (costByPart.get(l.part_id)?.purchase_price ?? null) : null,
      avg_install_cost: l.part_id ? (costByPart.get(l.part_id)?.avg_install_cost ?? null) : null,
    })),
    effectiveLaborHours,
    laborCostRate,
    // A discount (migration 342) lowers what the parts earn; without it a
    // big enough discount would slip a quote under the floor unseen.
    estimateDiscountRatio(estimate),
  );
  const belowFloor = quotedMargin.marginPct != null && quotedMargin.marginPct < floorPct;
  return { quotedMargin, floorPct, belowFloor };
}

/** The estimate row a send stamps: the new link, the fingerprint, status and the frozen margin. */
function approvalPatch(
  estimate: any,
  rawLineItems: any[],
  minted: { token: string; expiresAt: string },
  margin: Awaited<ReturnType<typeof quotedMarginFor>>,
  floorReason: string,
  fileIds: string[],
  batchId: string | null,
  userId: string,
) {
  const { quotedMargin, floorPct, belowFloor } = margin;
  return {
    approval_token: minted.token,
    approval_token_expires_at: minted.expiresAt,
    // Fingerprint of what this send actually contains (items + money).
    // The accept route refuses when the estimate no longer matches it —
    // an edit landing while the link is live can't become a "signed"
    // record the customer never saw (migration 242, Round 3 finding).
    approval_sent_hash: approvalContentHash(estimate, rawLineItems),
    // The fleet order email this link went out in (migration 412); a
    // single send clears it so the order page drops this vehicle's old link.
    approval_batch_id: batchId,
    sent_for_approval_at: new Date().toISOString(),
    sent_for_approval_by: userId,
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
    // Who answered the last link (migration 424) — this send asks again.
    customer_responder: null,
    // Frozen quoted-margin snapshot (R5-3): header-level so the line
    // save path's delete+reinsert can't wipe it; a re-send overwrites —
    // the snapshot always describes the version the customer last got.
    quoted_cost_total: quotedMargin.costTotal,
    quoted_margin_pct: quotedMargin.marginPct,
    quoted_below_floor: belowFloor,
    quoted_floor_pct: floorPct,
    quoted_labor_cost: quotedMargin.laborCost,
    quoted_margin_at: new Date().toISOString(),
    below_floor_reason: belowFloor ? floorReason : null,
    quoted_margin_detail: quotedMargin.lines,
    // The files this send carries (migration 368): the download links in
    // the email and on the approval page serve exactly these, whatever is
    // added to the estimate later.
    approval_file_ids: fileIds,
    updated_at: new Date().toISOString(),
  };
}

/** What follows a committed send: below-floor governance and reopening rejected wrap quotes. */
async function afterSendCommitted(estimate: any, margin: Awaited<ReturnType<typeof quotedMarginFor>>, floorReason: string, userId: string) {
  const { quotedMargin, floorPct, belowFloor } = margin;
  // Below-floor governance (R5-3): the send is now committed — record who
  // sent under the floor and tell the owners. Reads land in the weekly
  // exceptions digest via the audit action.
  if (belowFloor) {
    await logAudit(supabase, {
      actorId: userId,
      table: 'estimates',
      recordId: estimate.id,
      action: 'estimate_below_floor_sent',
      detail: {
        estimate_number: estimate.estimate_number,
        marginPct: quotedMargin.marginPct,
        floorPct,
        grandTotal: estimate.grand_total,
        reason: floorReason,
        uncostedLines: quotedMargin.uncostedCount,
      },
    });
    getSuperAdminIds(userId).then(async ids => {
      if (ids.length === 0) return;
      await notifyMany(ids, {
        type: 'below_floor_send',
        title: `⚠ Estimate #${estimate.estimate_number} sent at ${quotedMargin.marginPct}% margin (floor ${floorPct}%)`,
        body: `${estimate.customer_name || 'Customer'} — $${Number(estimate.grand_total || 0).toLocaleString()} quote sent below the margin floor. Reason: ${floorReason}`.slice(0, 900),
        url: deepLinks.estimate(estimate.id),
        channels: ['in_app', 'push'],
      });
    }).catch(err => console.error('below-floor notify failed:', err));
  }

  // A resend-after-rejection reopens the estimate (status back to 'sent'
  // in approvalPatch) — folded wrap quotes that were auto-rejected with it
  // come back too, so the whole document is live again, not just the
  // upfit half.
  if (estimate.customer_rejected_at) {
    await reconcileLinkedWrapQuotes(supabase, estimate.id, 'reopened', new Date().toISOString());
  }
}

/**
 * An internal review still open when the customer send lands is settled by
 * that send (migration 316): whoever sent it to the customer has, by
 * definition, cleared it — a reviewer sending it on themselves is one of
 * the paths the step is for. Without this the estimate would read "in
 * review" forever while the customer already had it.
 */
async function settleInternalReview(estimate: any, auth: { user: { id: string; email?: string | null }; profile?: unknown }) {
  if (estimate.internal_review_status !== 'pending') return;
  const { error: reviewErr } = await supabase
    .from('estimates')
    .update({
      internal_review_status: 'approved',
      internal_review_decided_by: auth.user.id,
      internal_review_decided_at: new Date().toISOString(),
    })
    .eq('id', estimate.id)
    .eq('internal_review_status', 'pending');
  if (reviewErr) {
    console.error('resolving internal review on customer send failed:', reviewErr.message);
  } else if (estimate.internal_review_requested_by && estimate.internal_review_requested_by !== auth.user.id) {
    const senderName = (auth.profile as any)?.full_name || auth.user?.email || 'A teammate';
    await notify({
      userId: estimate.internal_review_requested_by,
      type: 'estimate_review_update',
      title: `Estimate #${estimate.estimate_number} reviewed and sent to the customer`,
      body: `${senderName} reviewed your estimate and sent it on to ${estimate.customer_name || 'the customer'} — the approval link is live.`,
      url: deepLinks.estimate(estimate.id),
    }).catch(err => console.error('review-sent notify failed:', err));
  }
}

