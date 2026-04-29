import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  validateExpiry,
  captureMetadata,
  checkRateLimit,
  uploadSignedDocument,
  getRequestIp,
  AGREEMENT_TEXT,
} from '@/lib/magic-link-approval';
import { notifyMany } from '@/lib/notify';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function loadEstimateByToken(token: string) {
  const { data: estimate, error } = await supabase
    .from('estimates')
    .select('*')
    .eq('approval_token', token)
    .maybeSingle();
  if (error || !estimate) return { estimate: null, error: error?.message || 'not_found' };
  const { data: lines } = await supabase
    .from('estimate_line_items')
    .select('*')
    .eq('estimate_id', estimate.id)
    .order('sort_order');
  return { estimate, lines: lines || [] };
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

  return NextResponse.json({
    status: 'ready',
    estimate: publicEstimate(estimate),
    lines: (lines || []).map((l: any) => ({
      id: l.id,
      item_number: l.item_number,
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price,
      line_total: l.line_total,
      notes: l.notes,
    })),
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

  const body = await req.json().catch(() => ({}));
  const action = body.action;
  if (!['accept', 'reject'].includes(action)) {
    return NextResponse.json({ error: 'action must be accept or reject' }, { status: 400 });
  }

  const { estimate, lines } = await loadEstimateByToken(params.token);
  if (!estimate) return NextResponse.json({ error: 'Invalid token' }, { status: 404 });
  const expiry = validateExpiry(estimate.approval_token_expires_at);
  if (!expiry.ok) return NextResponse.json({ error: 'Expired' }, { status: 410 });
  if (estimate.customer_approved) return NextResponse.json({ error: 'Already approved' }, { status: 409 });
  if (estimate.customer_rejected_at) return NextResponse.json({ error: 'Already rejected' }, { status: 409 });

  const metadata = captureMetadata(req, body);

  if (action === 'reject') {
    const reason = (body.reason || '').toString().trim();
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
  const snapshotHtml = renderEstimateHtml(estimate, lines, metadata, body.agreementText || AGREEMENT_TEXT);
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

function publicEstimate(est: any) {
  return {
    id: est.id,
    estimate_number: est.estimate_number,
    title: est.title,
    customer_name: est.customer_name,
    tax_rate: est.tax_rate,
    tax_exempt: est.tax_exempt,
    tax_amount: est.tax_amount,
    labor_rate: est.labor_rate,
    labor_hours: est.labor_hours,
    labor_hours_override: est.labor_hours_override,
    labor_total: est.labor_total,
    subtotal: est.subtotal,
    grand_total: est.grand_total,
    notes: est.notes,
    install_instructions: est.install_instructions,
    on_site_contact_name: est.on_site_contact_name,
    on_site_contact_phone: est.on_site_contact_phone,
    delivery_preferences: est.delivery_preferences,
    customer_approved_at: est.customer_approved_at,
    customer_rejected_at: est.customer_rejected_at,
  };
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
    url: '/estimates',
  });
}

function esc(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderEstimateHtml(est: any, lines: any[], meta: any, agreement: string): string {
  const approvedAt = new Date().toISOString();
  const rows = lines.map((l: any) => {
    const total = Number(l.line_total || l.unit_price * l.quantity || 0).toFixed(2);
    return `<tr>
      <td>${esc(l.item_number || l.description || 'Item')}${l.description && l.description !== l.item_number ? `<div class="sub">${esc(l.description)}</div>` : ''}${l.notes ? `<div class="note">${esc(l.notes)}</div>` : ''}</td>
      <td class="r">${esc(l.quantity)}</td>
      <td class="r">$${Number(l.unit_price).toFixed(2)}</td>
      <td class="r">$${total}</td>
    </tr>`;
  }).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Estimate ${esc(est.estimate_number)} — Signed</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; color:#0f172a; background:#f1f5f9; padding:24px; }
.card { max-width: 720px; margin: 0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:14px; padding:24px; }
h1 { font-size:22px; margin:0 0 4px; }
.meta { color:#64748b; font-size:12px; }
table { width:100%; border-collapse:collapse; margin:18px 0; font-size:13px; }
th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#64748b; padding-bottom:8px; }
td { border-top:1px solid #e2e8f0; padding:8px 0; vertical-align:top; }
.r { text-align:right; }
.sub { font-size:12px; color:#475569; }
.note { font-size:11px; color:#94a3b8; font-style:italic; }
.totals { border-top:2px solid #cbd5e1; padding-top:10px; margin-top:10px; font-size:13px; }
.totals .row { display:flex; justify-content:space-between; padding:2px 0; }
.totals .grand { font-size:15px; font-weight:800; }
.section { background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-top:12px; font-size:13px; white-space:pre-wrap; }
.section h3 { margin:0 0 6px; font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:.5px; }
.signed { margin-top:20px; padding:14px; border:1px solid #16a34a; background:#dcfce7; border-radius:10px; font-size:12px; }
.signed strong { color:#14532d; }
.audit { margin-top:12px; font-size:11px; color:#475569; }
.audit div { margin-bottom:2px; }
</style></head><body>
<div class="card">
  <h1>Estimate #${esc(est.estimate_number)}</h1>
  ${est.title ? `<div class="meta">${esc(est.title)}</div>` : ''}
  <div class="meta">For ${esc(est.customer_name || 'customer')}</div>

  <table>
    <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    <div class="row"><span>Subtotal</span><span>$${Number(est.subtotal || 0).toFixed(2)}</span></div>
    ${est.labor_total > 0 ? `<div class="row"><span>Labor (${esc(est.labor_hours_override ?? est.labor_hours)} hrs @ $${esc(est.labor_rate)}/hr)</span><span>$${Number(est.labor_total).toFixed(2)}</span></div>` : ''}
    ${(!est.tax_exempt && est.tax_amount > 0) ? `<div class="row"><span>Tax (${(Number(est.tax_rate) * 100).toFixed(2)}%)</span><span>$${Number(est.tax_amount).toFixed(2)}</span></div>` : ''}
    <div class="row grand"><span>Total</span><span>$${Number(est.grand_total || 0).toFixed(2)}</span></div>
  </div>

  ${est.install_instructions ? `<div class="section"><h3>Install Instructions</h3>${esc(est.install_instructions)}</div>` : ''}
  ${(est.on_site_contact_name || est.on_site_contact_phone) ? `<div class="section"><h3>On-site Contact</h3>${esc(est.on_site_contact_name || '')}${est.on_site_contact_phone ? ' · ' + esc(est.on_site_contact_phone) : ''}</div>` : ''}
  ${est.delivery_preferences ? `<div class="section"><h3>Delivery</h3>${esc(est.delivery_preferences)}</div>` : ''}
  ${est.notes ? `<div class="section"><h3>Notes</h3>${esc(est.notes)}</div>` : ''}

  <div class="signed">
    <strong>ACCEPTED</strong>
    <div class="audit">
      <div><em>${esc(agreement)}</em></div>
      <div>Approved at: ${esc(approvedAt)}</div>
      <div>IP: ${esc(meta.ip)}</div>
      <div>User agent: ${esc(meta.userAgent)}</div>
      ${meta.deliveryChannel ? `<div>Delivered via: ${esc(meta.deliveryChannel)}${meta.deliveryTarget ? ' to ' + esc(meta.deliveryTarget) : ''}</div>` : ''}
      ${typeof meta.timeOnPageSeconds === 'number' ? `<div>Time on page: ${meta.timeOnPageSeconds}s</div>` : ''}
    </div>
  </div>
</div>
</body></html>`;
}
