import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireFeature, getProfileRoles, isAdminRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { discountApprovalStatus, getDiscountApprovalPct, stampDiscountApproval } from '@/lib/discount-approval';

export const dynamic = 'force-dynamic';

const supabase = createServiceClient();

const Schema = z.object({
  action: z.enum(['request', 'approve']),
});

/** Approved admin and super-admin accounts, minus the person acting. */
async function adminIds(excludeUserId: string): Promise<string[]> {
  const { data } = await supabase
    .from('profiles')
    .select('id')
    .or('role.eq.admin,roles.cs.{admin},role.eq.super_admin,roles.cs.{super_admin}')
    .eq('status', 'approved');
  return [...new Set((data || []).map((p: any) => p.id as string))].filter(id => id && id !== excludeUserId);
}

/**
 * POST /api/estimates/[id]/discount-approval
 *
 * Discounts over the admin-approval limit (migration 365,
 * src/lib/discount-approval.ts):
 *  - action "request": a rep asks; every admin is notified.
 *  - action "approve": an admin approves at the estimate's current
 *    discount percent; whoever asked is notified.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { action } = parsed.data;

  const { data: estimate, error: eErr } = await supabase
    .from('estimates')
    .select('id, estimate_number, customer_name, grand_total, labor_total, vehicle_count, discount_type, discount_value, discount_approved_at, discount_approved_pct, discount_approval_requested_by')
    .eq('id', params.id)
    .single();
  if (eErr || !estimate) {
    return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  }
  const { data: lines } = await supabase
    .from('estimate_line_items')
    .select('quantity, unit_price, discount_type, discount_value')
    .eq('estimate_id', estimate.id);

  const status = discountApprovalStatus(estimate, lines || [], await getDiscountApprovalPct(supabase));
  if (!status.overLimit) {
    return NextResponse.json({ error: `This estimate's discounts (${status.pct}% of the job) are within the ${status.limitPct}% limit, so no approval is needed. Save the estimate first if you just changed them.`, discountApproval: status }, { status: 409 });
  }
  const label = `Estimate #${estimate.estimate_number}`;
  const who = estimate.customer_name || 'Customer';

  if (action === 'approve') {
    if (!isAdminRole(getProfileRoles(auth.profile))) {
      return NextResponse.json({ error: 'Only an admin can approve a discount over the limit.' }, { status: 403 });
    }
    const err = await stampDiscountApproval(supabase, estimate, status, auth.user.id, 'approved');
    if (err) return NextResponse.json({ error: err }, { status: 500 });
    const requester = estimate.discount_approval_requested_by;
    if (requester && requester !== auth.user.id) {
      notifyMany([requester], {
        type: 'discount_approved',
        title: `✓ Discount approved on ${label}`,
        body: `${who}: ${status.pct}% off ($${status.amount.toFixed(2)}) is approved. You can send it to the customer or push it to NetSuite.`,
        url: deepLinks.estimate(estimate.id),
        channels: ['in_app', 'push'],
      }).catch(e => console.error('discount-approved notify failed:', e));
    }
    return NextResponse.json({ ok: true, discountApproval: { ...status, approved: true, blocked: false } });
  }

  // action === 'request'
  if (status.approved) {
    return NextResponse.json({ ok: true, alreadyApproved: true, discountApproval: status });
  }
  const { error: updErr } = await supabase
    .from('estimates')
    .update({ discount_approval_requested_at: new Date().toISOString(), discount_approval_requested_by: auth.user.id })
    .eq('id', estimate.id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'estimates',
    recordId: estimate.id,
    action: 'estimate_discount_approval_requested',
    detail: { estimate_number: estimate.estimate_number, pct: status.pct, amount: status.amount, limitPct: status.limitPct },
  });
  const ids = await adminIds(auth.user.id);
  if (ids.length > 0) {
    await notifyMany(ids, {
      type: 'discount_approval_request',
      title: `Discount needs your OK: ${label}`,
      body: `${who}: discounts come to ${status.pct}% of the job ($${status.amount.toFixed(2)}), over the ${status.limitPct}% limit. Open the estimate to approve.`,
      url: deepLinks.estimate(estimate.id),
      channels: ['in_app', 'push', 'email'],
    });
  }
  return NextResponse.json({ ok: true, notified: ids.length, discountApproval: status });
}
