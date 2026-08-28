import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { loadEstimateGraphics, inlineDiagrams } from '@/lib/estimate-graphics';
import {
  validateExpiry,
  captureMetadata,
  checkRateLimit,
  uploadSignedDocument,
  getRequestIp,
  AGREEMENT_TEXT,
} from '@/lib/magic-link-approval';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { validateBody, z } from '@/lib/validate';
import { renderEstimateDocument, escHtml } from '@/lib/estimate-document';
import { publicEstimate, publicLines, loadApprovalLines } from '@/lib/estimate-approval-view';

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
  // (it's in the emailed PDF and the frozen snapshot).
  const { summaries: graphics } = await loadEstimateGraphics(supabase, estimate.id);

  return NextResponse.json({
    status: 'ready',
    estimate: publicEstimate(estimate),
    graphics,
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

    await notifySalesRep(estimate, 'rejected', reason);
    return NextResponse.json({ status: 'submitted_rejected' });
  }

  // Accept path — snapshot the signed document first, then record approval
  const snapshotHtml = await renderSignedSnapshot(estimate, lines, metadata, body.agreementText || AGREEMENT_TEXT);
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
  await supabase
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
    .eq('id', estimate.id);

  await notifySalesRep(estimate, 'accepted');
  return NextResponse.json({ status: 'submitted_accepted' });
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

async function renderSignedSnapshot(est: any, lines: any[], meta: any, agreement: string): Promise<string> {
  // The snapshot is the shared customer-facing document (the same renderer
  // the approval email uses — if they drift, the legal record stops
  // matching what the customer was sent) plus the E-SIGN audit block.
  // Wrap content rides along with the coverage diagram INLINED as a data
  // URI: the R2 diagram is mutable, and a frozen legal record must never
  // reference state a later quote save can rewrite.
  const approvedAt = new Date().toISOString();
  const { data: settings } = await supabase
    .from('wrap_quote_settings')
    .select('company')
    .eq('id', 1)
    .maybeSingle();
  const company = settings?.company || {};
  const { summaries } = await loadEstimateGraphics(supabase, est.id);
  const graphics = await inlineDiagrams(summaries);
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
  return renderEstimateDocument(est, lines, { company, signedBlockHtml, graphics });
}
