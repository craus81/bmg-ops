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
import { deepLinks } from '@/lib/deep-links';
import { validateBody, z } from '@/lib/validate';
import { r2PublicUrl } from '@/lib/r2';

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

async function loadQuoteByToken(token: string) {
  const { data: quote, error } = await supabase
    .from('wrap_quotes')
    .select('*')
    .eq('approval_token', token)
    .maybeSingle();
  return { quote: error ? null : quote, error: error?.message };
}

/**
 * GET /api/approve/quote/[token]
 * Public read — the wrap quote for the acceptance page. Same shape and
 * rules as the estimate flow: rate-limited, expiring token, and terminal
 * states reported so the page can render the right screen.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  const allowed = await checkRateLimit(ip, 'approve_quote_get');
  if (!allowed) {
    return NextResponse.json({ error: 'Too many attempts, please wait and retry.', status: 'error' }, { status: 429 });
  }

  const { quote } = await loadQuoteByToken(params.token);
  if (!quote) return NextResponse.json({ status: 'invalid', error: 'not_found' }, { status: 404 });

  const expiry = validateExpiry(quote.approval_token_expires_at);
  if (!expiry.ok) return NextResponse.json({ status: 'expired' }, { status: 410 });

  if (quote.status === 'accepted') {
    return NextResponse.json({ status: 'already_approved', quote: publicQuote(quote) });
  }
  if (quote.status === 'rejected') {
    return NextResponse.json({ status: 'already_rejected', quote: publicQuote(quote) });
  }

  return NextResponse.json({ status: 'ready', quote: publicQuote(quote) });
}

/**
 * POST /api/approve/quote/[token]
 * accept → freeze a signed snapshot of the quote, stamp E-SIGN audit
 * metadata, mark accepted, tell the rep. reject → record the requested
 * changes and bounce it back to the rep.
 */
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  const allowed = await checkRateLimit(ip, 'approve_quote_post');
  if (!allowed) {
    return NextResponse.json({ error: 'Too many attempts, please wait and retry.' }, { status: 429 });
  }

  const parsed = await validateBody(req, ApprovalSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const { quote } = await loadQuoteByToken(params.token);
  if (!quote) return NextResponse.json({ error: 'Invalid token' }, { status: 404 });
  const expiry = validateExpiry(quote.approval_token_expires_at);
  if (!expiry.ok) return NextResponse.json({ error: 'Expired' }, { status: 410 });
  if (quote.status === 'accepted') return NextResponse.json({ error: 'Already approved' }, { status: 409 });
  if (quote.status === 'rejected') return NextResponse.json({ error: 'Already rejected' }, { status: 409 });

  const metadata = captureMetadata(req, body);
  const now = new Date().toISOString();

  if (body.action === 'reject') {
    const reason = (body.reason || '').trim();
    if (!reason) return NextResponse.json({ error: 'reason required' }, { status: 400 });

    await supabase
      .from('wrap_quotes')
      .update({
        status: 'rejected',
        rejected_at: now,
        customer_rejection_reason: reason,
        customer_approved_ip: metadata.ip,
        customer_approved_user_agent: metadata.userAgent,
        customer_approved_via: metadata.deliveryChannel,
        customer_approved_delivery_target: metadata.deliveryTarget,
        customer_approved_time_on_page_seconds: metadata.timeOnPageSeconds,
        updated_at: now,
      })
      .eq('id', quote.id);

    await notifySalesRep(quote, 'rejected', reason);
    return NextResponse.json({ status: 'submitted_rejected' });
  }

  // Accept path — snapshot the signed document first, then record approval.
  const snapshotHtml = renderQuoteHtml(quote, metadata, body.agreementText || AGREEMENT_TEXT);
  let signedPath: string | null = null;
  let signedHash: string | null = null;
  try {
    const uploaded = await uploadSignedDocument(
      `wrap-quotes/${quote.id}/signed`,
      snapshotHtml,
      'text/html; charset=utf-8'
    );
    signedPath = uploaded.path;
    signedHash = uploaded.hash;
  } catch (err: any) {
    console.error('Signed wrap-quote document upload failed:', err);
    // Approval is what legally matters; the snapshot is a best-effort
    // integrity record — never block acceptance on storage.
  }

  await supabase
    .from('wrap_quotes')
    .update({
      status: 'accepted',
      accepted_at: now,
      customer_approved_ip: metadata.ip,
      customer_approved_user_agent: metadata.userAgent,
      customer_approved_via: metadata.deliveryChannel,
      customer_approved_delivery_target: metadata.deliveryTarget,
      customer_approved_time_on_page_seconds: metadata.timeOnPageSeconds,
      signed_document_storage_path: signedPath,
      signed_document_hash: signedHash,
      updated_at: now,
    })
    .eq('id', quote.id);

  await notifySalesRep(quote, 'accepted');
  return NextResponse.json({ status: 'submitted_accepted' });
}

function publicQuote(q: any) {
  return {
    id: q.id,
    quote_number: q.quote_number,
    vehicle_description: q.vehicle_description,
    project_type: q.project_type,
    project_notes: q.project_notes,
    customer_name: (q.customer as any)?.name || null,
    measurements: (q.measurements || []).map((m: any) => ({
      name: m.name,
      qty: m.qty,
      billed_area_sqft: m.billed_area_sqft,
      substrate_name: m.substrate?.name || null,
      unit_price: m.unit_price,
      line_total: m.line_total,
    })),
    labor: q.labor || null,
    package_qty: q.package_qty || 1,
    adjustments: q.adjustments || null,
    nesting: q.nesting || null,
    subtotal: q.subtotal,
    tax_rate: q.tax_rate,
    tax_amount: q.tax_amount,
    total: q.total,
    diagram_url: q.diagram_path ? r2PublicUrl('vehicle-templates', q.diagram_path) : null,
    created_at: q.created_at,
    accepted_at: q.accepted_at,
    rejected_at: q.rejected_at,
  };
}

async function notifySalesRep(quote: any, verdict: 'accepted' | 'rejected', reason?: string) {
  const targetIds = new Set<string>();
  if (quote.created_by) targetIds.add(quote.created_by);
  if (quote.customer_id) {
    const { data: cust } = await supabase
      .from('customers')
      .select('account_owner_id')
      .eq('id', quote.customer_id)
      .maybeSingle();
    if (cust?.account_owner_id) targetIds.add(cust.account_owner_id);
  }
  if (targetIds.size === 0) {
    const { data: admins } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
      .eq('status', 'approved');
    for (const a of admins || []) targetIds.add(a.id);
  }
  if (targetIds.size === 0) return;

  const customerName = (quote.customer as any)?.name || 'Customer';
  await notifyMany(Array.from(targetIds), {
    type: verdict === 'accepted' ? 'quote_accepted' : 'quote_rejected',
    title: verdict === 'accepted'
      ? `Wrap quote ${quote.quote_number} accepted 🎉`
      : `Wrap quote ${quote.quote_number} — changes requested`,
    body: verdict === 'accepted'
      ? `${customerName} accepted the $${Number(quote.total || 0).toFixed(2)} wrap quote.`
      : `${customerName} requested changes: ${reason || '(no reason provided)'}`,
    url: deepLinks.wrapQuote(quote.id),
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

const money = (n: any) => (parseFloat(n) || 0).toFixed(2);

function renderQuoteHtml(q: any, meta: any, agreement: string): string {
  const approvedAt = new Date().toISOString();
  const cust = (q.customer as any) || {};
  const rows: string[] = [];
  // Kit-quantity jobs: measurement lines price ONE kit; the rollup row and
  // the adjustment lines in the totals show how the final number was built.
  // Roll-nested quotes price materials as vinyl cut off each film's roll:
  // shape lines carry null prices (sizes only) and per-film Material rows
  // carry the roll totals.
  const adj = q.adjustments || null;
  const kits = Math.max(1, parseInt(q.package_qty, 10) || 1);
  const nest = q.nesting?.enabled ? q.nesting : null;
  for (const m of q.measurements || []) {
    rows.push(`<tr>
      <td>${esc(m.name)}<div class="sub">${money(m.billed_area_sqft)} ft²${m.substrate?.name ? ` · ${esc(m.substrate.name)}` : ''}${kits > 1 ? ' · per kit' : ''}</div></td>
      <td class="r">${esc(m.qty || 1)}</td>
      <td class="r">${m.unit_price == null ? '—' : `$${money(m.unit_price)}`}</td>
      <td class="r">${m.line_total == null ? '—' : `$${money(m.line_total)}`}</td>
    </tr>`);
  }
  if (nest) {
    for (const f of nest.films || []) {
      if (!((parseFloat(f.material_total) || 0) > 0.005)) continue;
      const usedIn = (f.rolls || []).reduce((s: number, r: any) => s + (parseFloat(r.used_length_in) || 0), 0);
      const extra = parseFloat(f.extra_area_sqft) || 0;
      const detail = [
        (parseFloat(f.roll_sqft) || 0) > 0.005 ? `${money(f.roll_sqft)} ft² · ${(usedIn / 12).toFixed(1)} ft of ${money(nest.roll_width_in)}" roll` : '',
        extra > 0.005 ? `${money(extra)} ft² billed by area` : '',
      ].filter(Boolean).join(' + ') + ((nest.sets || 1) > 1 ? ` · ${nest.sets} sets` : '');
      rows.push(`<tr><td><b>Material — ${esc(f.label)}</b><div class="sub">${detail}</div></td><td class="r">1</td><td class="r">$${money(f.material_total)}</td><td class="r"><b>$${money(f.material_total)}</b></td></tr>`);
    }
  }
  if (kits > 1 && adj && !nest) {
    rows.push(`<tr><td><b>Materials — ${kits} kits</b><div class="sub">${money(adj.kit_area_sqft)} ft² per kit</div></td><td class="r"><b>${kits}</b></td><td class="r">$${money(adj.kit_materials)}</td><td class="r"><b>$${money(adj.pre_materials)}</b></td></tr>`);
  }
  for (const f of q.labor?.films || []) {
    if (!(parseFloat(f.total) || 0)) continue;
    rows.push(`<tr><td>Install — ${esc(f.label)}<div class="sub">${money(f.sqft)} ft² @ $${money(f.rate)}/ft²</div></td><td class="r">1</td><td class="r">$${money(f.total)}</td><td class="r">$${money(f.total)}</td></tr>`);
  }
  const laborLabels: Record<string, string> = { design: 'Design', preparation: 'Preparation', installation: 'Installation' };
  for (const key of Object.keys(laborLabels)) {
    const sec = q.labor?.[key];
    if (!sec || !(parseFloat(sec.total) || 0)) continue;
    rows.push(`<tr><td>${laborLabels[key]}</td><td class="r">1</td><td class="r">$${money(sec.total)}</td><td class="r">$${money(sec.total)}</td></tr>`);
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Wrap Quote ${esc(q.quote_number)} — Signed</title>
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
.totals { border-top:2px solid #cbd5e1; padding-top:10px; margin-top:10px; font-size:13px; }
.totals .row { display:flex; justify-content:space-between; padding:2px 0; }
.totals .grand { font-size:15px; font-weight:800; }
.section { background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-top:12px; font-size:13px; white-space:pre-wrap; }
.signed { margin-top:20px; padding:14px; border:1px solid #16a34a; background:#dcfce7; border-radius:10px; font-size:12px; }
.signed strong { color:#14532d; }
.audit { margin-top:12px; font-size:11px; color:#475569; }
.audit div { margin-bottom:2px; }
</style></head><body>
<div class="card">
  <h1>Wrap Quote ${esc(q.quote_number)}</h1>
  ${q.vehicle_description ? `<div class="meta">${esc(q.vehicle_description)}</div>` : ''}
  <div class="meta">For ${esc(cust.name || 'customer')}</div>

  <table>
    <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Total</th></tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table>

  <div class="totals">
    ${adj && ((parseFloat(adj.discount_amount) || 0) > 0.005 || (parseFloat(adj.min_bump) || 0) > 0.005) ? `<div class="row" style="color:#64748b;"><span>Subtotal before adjustments</span><span>$${money(adj.pre_subtotal)}</span></div>` : ''}
    ${adj && (parseFloat(adj.discount_amount) || 0) > 0.005 ? `<div class="row" style="color:#7c3aed;"><span>Quantity discount (${money(adj.discount_pct)}%)</span><span>−$${money(adj.discount_amount)}</span></div>` : ''}
    ${adj && (parseFloat(adj.min_bump) || 0) > 0.005 ? `<div class="row" style="color:#b45309;"><span>Shop minimum</span><span>+$${money(adj.min_bump)}</span></div>` : ''}
    <div class="row"><span>Subtotal</span><span>$${money(q.subtotal)}</span></div>
    <div class="row"><span>Tax (${money(q.tax_rate)}%)</span><span>$${money(q.tax_amount)}</span></div>
    <div class="row grand"><span>Total</span><span>$${money(q.total)}</span></div>
  </div>

  ${q.project_notes ? `<div class="section"><b>Project Notes:</b> ${esc(q.project_notes)}</div>` : ''}

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
