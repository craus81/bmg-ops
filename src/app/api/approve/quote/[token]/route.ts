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
import { logQuoteResponse } from '@/lib/quote-response-activity';
import { validateBody, z } from '@/lib/validate';
import { r2PublicUrl } from '@/lib/r2';
import { escHtml, renderQuoteDocument } from '@/lib/quote-document';
import { wrapQuoteDocModel } from '@/lib/wrap-quote-document';

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
  // Server-held for the same reason as the estimate route (Round 3 finding).
  const snapshotHtml = renderSignedSnapshot(quote, metadata, AGREEMENT_TEXT);
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
  // hide_line_items is the persisted presentation choice from the send flow
  // ("picture + total, no itemization"). Line data is stripped HERE, before
  // it crosses the wire — hiding it client-side would still ship the rows
  // to the customer's browser.
  const hideLines = !!q.hide_line_items;
  return {
    id: q.id,
    quote_number: q.quote_number,
    vehicle_description: q.vehicle_description,
    project_type: q.project_type,
    project_notes: q.project_notes,
    hide_line_items: hideLines,
    customer_name: (q.customer as any)?.name || null,
    measurements: (hideLines ? [] : q.measurements || []).map((m: any) => ({
      name: m.name,
      qty: m.qty,
      billed_area_sqft: m.billed_area_sqft,
      substrate_name: m.substrate?.name || null,
      unit_price: m.unit_price,
      line_total: m.line_total,
    })),
    labor: hideLines ? null : q.labor || null,
    package_qty: q.package_qty || 1,
    adjustments: q.adjustments || null,
    nesting: hideLines ? null : q.nesting || null,
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

// Roles that can open /admin/wrap-quote (mirrors the page's hasAccess gate:
// admin/sales/graphics — legacy 'production' maps to graphics_production).
const WRAP_QUOTE_ROLES = ['admin', 'super_admin', 'sales', 'graphics_production', 'production'];

async function notifySalesRep(quote: any, verdict: 'accepted' | 'rejected', reason?: string) {
  // The customer's answer belongs on their account history too. Wrap
  // quotes only carry customers.id — the resolver hops to the CRM record;
  // a quote for a lead with no customer row has no timeline and no-ops.
  await logQuoteResponse(supabase, {
    verdict,
    label: `Wrap quote ${quote.quote_number}`,
    total: quote.total,
    reason,
    url: deepLinks.wrapQuote(quote.id),
    customerId: quote.customer_id,
  });

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

  // An account owner outside the wrap-quote roles would click through to
  // "You don't have access to Wrap Quotes" — a dead notification. Keep only
  // recipients who can actually open the page; if nobody survives the
  // filter, fall through to the admin fallback below.
  if (targetIds.size > 0) {
    const { data: profs } = await supabase
      .from('profiles')
      .select('id, role, roles')
      .in('id', Array.from(targetIds))
      .eq('status', 'approved');
    const allowed = new Set(
      (profs || [])
        .filter((p: any) => {
          const roles: string[] = p.roles?.length > 0 ? p.roles : [p.role];
          return roles.some(r => WRAP_QUOTE_ROLES.includes(r));
        })
        .map((p: any) => p.id)
    );
    for (const tid of Array.from(targetIds)) {
      if (!allowed.has(tid)) targetIds.delete(tid);
    }
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

/**
 * The frozen signed snapshot — the SAME shared quote document the customer
 * was emailed (src/lib/quote-document.ts + the wrap adapter), with the
 * E-SIGN audit block in the signedBlockHtml slot. Totals always render;
 * the line table honors hide_line_items (the presentation persisted by the
 * send flow). Deliberately NO letterhead logo and NO coverage diagram: both
 * live at mutable R2 paths that later saves overwrite, and a frozen legal
 * record must not reference state that can change under it.
 */
function renderSignedSnapshot(quote: any, meta: any, agreement: string): string {
  const approvedAt = new Date().toISOString();
  const auditLine = (label: string, value: string) =>
    `<div style="margin-bottom:2px;">${label}${escHtml(value)}</div>`;
  const signedBlockHtml = `
    <div style="margin-top:20px;padding:14px;border:1px solid #16a34a;background:#dcfce7;border-radius:10px;font-size:12px;">
      <strong style="color:#14532d;">ACCEPTED</strong>
      <div style="margin-top:12px;font-size:11px;color:#475569;">
        <div style="margin-bottom:2px;"><em>${escHtml(agreement)}</em></div>
        ${auditLine('Approved at: ', approvedAt)}
        ${auditLine('IP: ', meta.ip)}
        ${auditLine('User agent: ', meta.userAgent)}
        ${meta.deliveryChannel ? auditLine('Delivered via: ', `${meta.deliveryChannel}${meta.deliveryTarget ? ' to ' + meta.deliveryTarget : ''}`) : ''}
        ${typeof meta.timeOnPageSeconds === 'number' ? auditLine('Time on page: ', `${meta.timeOnPageSeconds}s`) : ''}
      </div>
    </div>`;
  return renderQuoteDocument(
    wrapQuoteDocModel(quote, { pricing: true, lineItems: !quote.hide_line_items }),
    { signedBlockHtml },
  );
}
