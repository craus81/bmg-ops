import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  loadEstimateGraphics,
  inlineDiagrams,
  loadEstimateProofs,
  inlineProofImages,
  type EstimateProofBlock,
} from '@/lib/estimate-graphics';
import {
  validateExpiry,
  captureMetadata,
  checkRateLimit,
  uploadSignedDocument,
  getRequestIp,
  AGREEMENT_TEXT,
} from '@/lib/magic-link-approval';
import { COMBINED_AGREEMENT_TEXT } from '@/lib/approval-agreement';
import { approvalContentHash } from '@/lib/magic-link-approval';
import { reconcileLinkedWrapQuotes } from '@/lib/wrap-quote-reconcile';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { validateBody, z } from '@/lib/validate';
import { renderEstimateDocument, escHtml } from '@/lib/estimate-document';
import { publicEstimate, publicLines, publicProofs, loadApprovalLines } from '@/lib/estimate-approval-view';
import { r2GetBytes, r2Upload } from '@/lib/r2';

export const dynamic = 'force-dynamic';

const ApprovalSchema = z.object({
  action: z.enum(['accept', 'reject']),
  reason: z.string().trim().max(1000).optional(),
  agreementText: z.string().max(2000).optional(),
  timeOnPageSeconds: z.number().int().nonnegative().max(86_400).optional().nullable(),
  deliveryChannel: z.enum(['sms_link', 'email_link']).optional().nullable(),
  deliveryTarget: z.string().max(254).optional().nullable(),
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function loadEstimateByToken(token: string) {
  const { data: estimate, error } = await supabase
    .from('estimates')
    .select('*, vehicle_platforms(label)')
    .eq('approval_token', token)
    .maybeSingle();
  if (error || !estimate) return { estimate: null, lines: [] as any[], error: error?.message || 'not_found' };
  // Flatten the platform label for the document's vehicle line.
  (estimate as any).vehicle_platform_label = (estimate as any).vehicle_platforms?.label || null;
  // Enhanced estimate: the lines carry each part's catalog photo + vendor
  // product link, so the approval page and the signed snapshot both show them.
  const lines = await loadApprovalLines(supabase, estimate.id);
  return { estimate, lines };
}

/**
 * GET /api/approve/estimate/[token]
 * Public read — returns the estimate + lines for rendering the approval page,
 * plus a status indicating whether the link is still actionable.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  const allowed = await checkRateLimit(ip, 'approve_estimate_get');
  if (!allowed) {
    return NextResponse.json({ error: 'Too many attempts, please wait and retry.', status: 'error' }, { status: 429 });
  }

  const { estimate, lines } = await loadEstimateByToken(params.token);
  if (!estimate) {
    return NextResponse.json({ status: 'invalid', error: 'not_found' }, { status: 404 });
  }

  const expiry = validateExpiry(estimate.approval_token_expires_at);
  if (!expiry.ok) return NextResponse.json({ status: 'expired' }, { status: 410 });

  if (estimate.customer_approved) {
    return NextResponse.json({ status: 'already_approved', estimate: publicEstimate(estimate) });
  }
  if (estimate.customer_rejected_at) {
    return NextResponse.json({ status: 'already_rejected', estimate: publicEstimate(estimate) });
  }

  // Wrap content from linked wrap quotes (estimate_attach) — the customer
  // must SEE on this page the same vinyl/coverage content they're approving
  // (it's in the emailed PDF and the frozen snapshot). Same for graphic
  // proofs from linked graphics jobs: accepting this page approves them.
  const { summaries: graphics } = await loadEstimateGraphics(supabase, estimate.id);
  const proofs = await loadEstimateProofs(supabase, estimate.id, undefined, { presign: true });

  return NextResponse.json({
    status: 'ready',
    estimate: publicEstimate(estimate),
    graphics,
    proofs: publicProofs(proofs),
    lines: publicLines(lines),
  });
}

/**
 * POST /api/approve/estimate/[token]
 * Body: { action: 'accept' | 'reject', timeOnPageSeconds?, deliveryChannel?,
 *         deliveryTarget?, reason?, agreementText? }
 */
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  const allowed = await checkRateLimit(ip, 'approve_estimate_post');
  if (!allowed) {
    return NextResponse.json({ error: 'Too many attempts, please wait and retry.' }, { status: 429 });
  }

  const parsed = await validateBody(req, ApprovalSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  const action = body.action;

  const { estimate, lines } = await loadEstimateByToken(params.token);
  if (!estimate) return NextResponse.json({ error: 'Invalid token' }, { status: 404 });
  const expiry = validateExpiry(estimate.approval_token_expires_at);
  if (!expiry.ok) return NextResponse.json({ error: 'Expired' }, { status: 410 });
  if (estimate.customer_approved) return NextResponse.json({ error: 'Already approved' }, { status: 409 });
  if (estimate.customer_rejected_at) return NextResponse.json({ error: 'Already rejected' }, { status: 409 });

  const metadata = captureMetadata(req, body);

  // The proof blocks this approval covers (graphics_jobs.estimate_attach —
  // the same loader every other surface uses). Loaded once here: they pick
  // the agreement default, freeze into the snapshot, and decide which
  // linked graphics jobs an acceptance propagates to.
  const proofBlocks = await loadEstimateProofs(supabase, estimate.id, undefined, { presign: true });

  if (action === 'reject') {
    const reason = (body.reason || '').trim();
    if (!reason) return NextResponse.json({ error: 'reason required' }, { status: 400 });

    await supabase
      .from('estimates')
      .update({
        customer_rejected_at: new Date().toISOString(),
        customer_rejection_reason: reason,
        customer_approved_ip: metadata.ip,
        customer_approved_user_agent: metadata.userAgent,
        customer_approved_via: metadata.deliveryChannel,
        customer_approved_delivery_target: metadata.deliveryTarget,
        customer_approved_time_on_page_seconds: metadata.timeOnPageSeconds,
        status: 'rejected',
        updated_at: new Date().toISOString(),
      })
      .eq('id', estimate.id);

    // Leave the change request on each included job's timeline so the
    // graphics team sees it — but do NOT flip the job to revision or stamp
    // a rejection: the customer may be pushing back on price, not design.
    // The sales rep (notified below) routes it.
    await noteRejectionOnLinkedJobs(estimate, proofBlocks, reason);

    // Folded wrap quotes follow the estimate's fate — otherwise they sit
    // 'sent' forever, nudging reps about a decision the customer already
    // made (Stage 3 finding). Quotes separately accepted keep standing.
    await reconcileLinkedWrapQuotes(supabase, estimate.id, 'rejected', new Date().toISOString());

    await notifySalesRep(estimate, 'rejected', reason);
    return NextResponse.json({ status: 'submitted_rejected' });
  }

  // What the customer is accepting must be what was SENT. The send stamped
  // a fingerprint of the items + money (migration 242); if the estimate
  // changed since — a save landing while the link was live — refuse rather
  // than freeze a "signed" record showing prices the customer never saw
  // (Round 3 finding). Estimates sent before the migration have no hash
  // and skip the check.
  if ((estimate as any).approval_sent_hash) {
    const nowHash = approvalContentHash(estimate, lines || []);
    if (nowHash !== (estimate as any).approval_sent_hash) {
      return NextResponse.json({
        error: 'This estimate was changed after the approval link was sent. Please ask BMG Fleet Installations for a fresh link so you can review the current version.',
        step: 'content_changed',
      }, { status: 409 });
    }
  }

  // Accept path — snapshot the signed document first, then record approval.
  // The agreement sentence is SERVER-HELD: the client's copy is ignored,
  // because a link-holder could otherwise freeze any 2000-character text of
  // their choosing into the hash-verified legal record (Round 3 finding —
  // the page displays these exact canonical strings, so nothing changes for
  // real customers).
  const agreement = proofBlocks.length > 0 ? COMBINED_AGREEMENT_TEXT : AGREEMENT_TEXT;
  const snapshotHtml = await renderSignedSnapshot(estimate, lines, metadata, agreement, proofBlocks);
  let signedPath: string | null = null;
  let signedHash: string | null = null;
  try {
    const uploaded = await uploadSignedDocument(
      `estimates/${estimate.id}/signed`,
      snapshotHtml,
      'text/html; charset=utf-8'
    );
    signedPath = uploaded.path;
    signedHash = uploaded.hash;
  } catch (err: any) {
    console.error('Signed document upload failed:', err);
    // Still record approval without blocking on storage failure — approval is
    // what legally matters; snapshot is a best-effort integrity record.
  }

  const approvedAt = new Date().toISOString();
  // Conditional: two rapid Accepts both passed the read-check above — the
  // second overwrote the first's snapshot hash and re-ran the notify fan-out.
  const { data: acceptedRows } = await supabase
    .from('estimates')
    .update({
      customer_approved: true,
      customer_approved_at: approvedAt,
      customer_approved_ip: metadata.ip,
      customer_approved_user_agent: metadata.userAgent,
      customer_approved_via: metadata.deliveryChannel,
      customer_approved_delivery_target: metadata.deliveryTarget,
      customer_approved_time_on_page_seconds: metadata.timeOnPageSeconds,
      signed_document_storage_path: signedPath,
      signed_document_hash: signedHash,
      status: 'accepted',
      updated_at: approvedAt,
    })
    .eq('id', estimate.id)
    .eq('customer_approved', false)
    .select('id');
  if (!acceptedRows || acceptedRows.length === 0) {
    return NextResponse.json({ error: 'Already approved' }, { status: 409 });
  }

  // One click approved design + price: propagate the acceptance onto the
  // graphics jobs whose proofs were part of this document, so the printing
  // proof-gate opens without a second customer round-trip.
  await approveLinkedGraphicsJobs(estimate, proofBlocks, metadata, approvedAt, signedPath, signedHash);

  // Folded wrap quotes ride the same acceptance: the estimate's grand total
  // already carries their money, and leaving them 'sent' kept them in the
  // follow-up queue and the open pipeline forever (Stage 3 finding).
  await reconcileLinkedWrapQuotes(supabase, estimate.id, 'accepted', approvedAt);

  await notifySalesRep(estimate, 'accepted');
  return NextResponse.json({ status: 'submitted_accepted' });
}

/**
 * Propagate an estimate acceptance onto the linked graphics jobs whose
 * proofs rode on the approved document (exactly the loadEstimateProofs
 * blocks the customer saw — never jobs whose proofs weren't included).
 *
 * Mirrors the proof-only approval flow (/api/approve/proof): archive the
 * as-approved proof files to immutable storage, stamp customer_approved +
 * the E-SIGN audit metadata, point the job's signed-document fields at the
 * estimate's combined snapshot, leave a timeline note, and tell the
 * graphics team. Best-effort throughout — the customer's acceptance is
 * already recorded on the estimate and must never fail over propagation.
 */
async function approveLinkedGraphicsJobs(
  estimate: any,
  proofBlocks: EstimateProofBlock[],
  metadata: any,
  approvedAt: string,
  signedPath: string | null,
  signedHash: string | null,
) {
  for (const block of proofBlocks) {
    try {
      const { data: job } = await supabase
        .from('graphics_jobs')
        .select('id, job_number, title, customer, status, created_by, assigned_to, sent_for_approval_by, customer_approved, estimate_id')
        .eq('id', block.jobId)
        .maybeSingle();
      // Re-check the link and skip jobs already approved (an earlier
      // proof-only approval stands — don't overwrite its audit trail).
      if (!job || job.estimate_id !== estimate.id || job.customer_approved) continue;

      // Clone the as-approved proof files to the immutable archive, same
      // destination shape as the proof-only flow.
      const signedProofPaths: string[] = [];
      for (const f of block.files) {
        try {
          const got = await r2GetBytes('graphics-proofs', f.storagePath);
          if (!got) {
            console.error('combined approval: proof file fetch failed:', f.storagePath);
            continue;
          }
          const destPath = `proofs/${job.id}/${Date.now()}-${f.name}`;
          const uploaded = await r2Upload('signed-documents', destPath, got.bytes, got.contentType || 'application/octet-stream');
          if (uploaded.success) signedProofPaths.push(uploaded.key);
          else console.error('combined approval: proof archive upload failed:', destPath, uploaded.error);
        } catch (err) {
          console.error('combined approval: proof clone failed:', err);
        }
      }

      const patch: Record<string, unknown> = {
        customer_approved: true,
        customer_approved_at: approvedAt,
        customer_approved_ip: metadata.ip,
        customer_approved_user_agent: metadata.userAgent,
        customer_approved_via: metadata.deliveryChannel,
        customer_approved_delivery_target: metadata.deliveryTarget,
        customer_approved_time_on_page_seconds: metadata.timeOnPageSeconds,
        // A prior revision request is superseded by this approval.
        customer_rejected_at: null,
        customer_rejection_reason: null,
        updated_at: approvedAt,
      };
      // The estimate's snapshot IS the signed record covering this proof —
      // point the job at it (skip if that upload failed; never null out).
      if (signedPath) {
        patch.signed_document_storage_path = signedPath;
        patch.signed_document_hash = signedHash;
      }
      if (signedProofPaths.length > 0) patch.signed_proof_storage_paths = signedProofPaths;

      const { error: updErr } = await supabase.from('graphics_jobs').update(patch).eq('id', job.id);
      if (updErr) {
        console.error('combined approval: job update failed:', job.id, updErr.message);
        continue;
      }

      await supabase.from('graphics_status_history').insert({
        job_id: job.id,
        from_status: job.status,
        to_status: job.status,
        note: `Customer approved proof together with Estimate #${estimate.estimate_number} via magic link`,
      });

      await notifyGraphicsTeamCombined(job, estimate);
    } catch (err) {
      console.error('graphics-job approval propagation failed:', err);
    }
  }
}

/** Same audience as the proof-only flow's approval notification. */
async function notifyGraphicsTeamCombined(job: any, estimate: any) {
  try {
    const targetIds = new Set<string>();
    if (job.created_by) targetIds.add(job.created_by);
    if (job.assigned_to) targetIds.add(job.assigned_to);
    if (job.sent_for_approval_by) targetIds.add(job.sent_for_approval_by);
    const { data: prod } = await supabase
      .from('profiles')
      .select('id')
      .in('role', ['admin', 'graphics_production', 'production'])
      .eq('status', 'approved');
    for (const p of prod || []) targetIds.add(p.id);
    if (targetIds.size === 0) return;

    await notifyMany(Array.from(targetIds), {
      type: 'proof_approved',
      title: `Proof approved: ${job.title || `Job #${job.job_number}`}`,
      body: `${job.customer || 'Customer'} approved the proof together with Estimate #${estimate.estimate_number}. You can move to production.`,
      url: deepLinks.graphicsJob(job.id),
    });
  } catch (err) {
    console.error('combined approval notification failed:', err);
  }
}

/**
 * A rejection of an estimate that carried proofs lands as a timeline note
 * on each included job (no status change, no rejection stamp — the reason
 * may be price, not design; the sales rep routes it).
 */
async function noteRejectionOnLinkedJobs(estimate: any, proofBlocks: EstimateProofBlock[], reason: string) {
  for (const block of proofBlocks) {
    try {
      const { data: job } = await supabase
        .from('graphics_jobs')
        .select('id, status, estimate_id, customer_approved')
        .eq('id', block.jobId)
        .maybeSingle();
      if (!job || job.estimate_id !== estimate.id || job.customer_approved) continue;
      await supabase.from('graphics_status_history').insert({
        job_id: job.id,
        from_status: job.status,
        to_status: job.status,
        note: `Customer requested changes on Estimate #${estimate.estimate_number} (this job's proof was included): ${reason}`,
      });
    } catch (err) {
      console.error('graphics-job rejection note failed:', err);
    }
  }
}

async function notifySalesRep(estimate: any, verdict: 'accepted' | 'rejected', reason?: string) {
  const targetIds = new Set<string>();
  if (estimate.created_by) targetIds.add(estimate.created_by);
  if (estimate.sent_for_approval_by) targetIds.add(estimate.sent_for_approval_by);
  // Also pull account owner from customers if present
  if (estimate.customer_id) {
    const { data: cust } = await supabase
      .from('customers')
      .select('account_owner_id')
      .eq('id', estimate.customer_id)
      .maybeSingle();
    if (cust?.account_owner_id) targetIds.add(cust.account_owner_id);
  }
  // Fall back to admins if nobody else
  if (targetIds.size === 0) {
    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
      .eq('status', 'approved');
    for (const a of admins || []) targetIds.add(a.id);
  }
  if (targetIds.size === 0) return;

  const title = verdict === 'accepted'
    ? `Estimate #${estimate.estimate_number} accepted`
    : `Estimate #${estimate.estimate_number} rejected`;
  const body = verdict === 'accepted'
    ? `${estimate.customer_name || 'Customer'} approved the estimate. Review before pushing to NetSuite.`
    : `${estimate.customer_name || 'Customer'} requested changes: ${reason || '(no reason provided)'}`;

  await notifyMany(Array.from(targetIds), {
    type: verdict === 'accepted' ? 'estimate_accepted' : 'estimate_rejected',
    title,
    body,
    url: deepLinks.estimate(estimate.id),
  });
}

async function renderSignedSnapshot(est: any, lines: any[], meta: any, agreement: string, proofBlocks: EstimateProofBlock[]): Promise<string> {
  // The snapshot is the shared customer-facing document (the same renderer
  // the approval email uses — if they drift, the legal record stops
  // matching what the customer was sent) plus the E-SIGN audit block.
  // Wrap content rides along with the coverage diagram INLINED as a data
  // URI: the R2 diagram is mutable, and a frozen legal record must never
  // reference state a later quote save can rewrite. Graphic-proof images
  // inline the same way; PDF proofs freeze as named entries (their
  // as-approved bytes live in the acceptance archive on each job).
  const approvedAt = new Date().toISOString();
  const { data: settings } = await supabase
    .from('wrap_quote_settings')
    .select('company')
    .eq('id', 1)
    .maybeSingle();
  const company = settings?.company || {};
  const { summaries } = await loadEstimateGraphics(supabase, est.id);
  const graphics = await inlineDiagrams(summaries);
  const proofs = await inlineProofImages(proofBlocks);
  const signedBlockHtml = `
  <div style="margin-top:20px;padding:14px;border:1px solid #16a34a;background:#dcfce7;border-radius:10px;font-size:12px;">
    <strong style="color:#14532d;">ACCEPTED</strong>
    <div style="margin-top:8px;font-size:11px;color:#374151;">
      <div><em>${escHtml(agreement)}</em></div>
      <div>Approved at: ${escHtml(approvedAt)}</div>
      <div>IP: ${escHtml(meta.ip)}</div>
      <div>User agent: ${escHtml(meta.userAgent)}</div>
      ${meta.deliveryChannel ? `<div>Delivered via: ${escHtml(meta.deliveryChannel)}${meta.deliveryTarget ? ' to ' + escHtml(meta.deliveryTarget) : ''}</div>` : ''}
      ${typeof meta.timeOnPageSeconds === 'number' ? `<div>Time on page: ${meta.timeOnPageSeconds}s</div>` : ''}
    </div>
  </div>`;
  return renderEstimateDocument(est, lines, { company, signedBlockHtml, graphics, proofs });
}
