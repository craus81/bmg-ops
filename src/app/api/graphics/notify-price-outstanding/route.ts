import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { notifyMany } from '@/lib/notify';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const Schema = z.object({
  jobId: z.string().uuid(),
});

/**
 * POST /api/graphics/notify-price-outstanding
 *
 * Fired (fire-and-forget) by the job page when a graphics job moves into
 * `printing` while its linked estimate is still awaiting customer approval
 * (priceReminderApplies in src/lib/graphics-status.ts — a reminder, never a
 * block). The graphics team already saw the heads-up dialog; this tells the
 * people who can actually resolve the pricing — the estimate's creator, its
 * sender, and the customer's account owner (the same audience the approval
 * routes notify) — that production started without an approved number.
 *
 * The condition is re-verified server-side so a stale client can't spam
 * false alarms. Type 'price_outstanding' deliberately avoids the
 * preference-gated substrings in notify.ts (new/flagged/status/ready/
 * shipped) so it default-allows in-app + push, same as 'proof_sent'.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const actorId = auth.user?.id || null;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { jobId } = parsed.data;

  const { data: job } = await supabase
    .from('graphics_jobs')
    .select('id, job_number, title, customer, status, estimate_id')
    .eq('id', jobId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (!job.estimate_id) return NextResponse.json({ skipped: 'no linked estimate' });

  const { data: estimate } = await supabase
    .from('estimates')
    .select('id, estimate_number, grand_total, customer_approved, sent_for_approval_at, created_by, sent_for_approval_by, customer_id')
    .eq('id', job.estimate_id)
    .maybeSingle();
  if (!estimate) return NextResponse.json({ skipped: 'estimate missing' });
  if (estimate.customer_approved) return NextResponse.json({ skipped: 'estimate approved' });

  // Same audience shape as the approval routes' notifySalesRep.
  const targetIds = new Set<string>();
  if (estimate.created_by) targetIds.add(estimate.created_by);
  if (estimate.sent_for_approval_by) targetIds.add(estimate.sent_for_approval_by);
  if (estimate.customer_id) {
    const { data: cust } = await supabase
      .from('customers')
      .select('account_owner_id')
      .eq('id', estimate.customer_id)
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
  if (actorId) targetIds.delete(actorId);
  if (targetIds.size === 0) return NextResponse.json({ skipped: 'no recipients' });

  const jobLabel = job.title || `Job #${job.job_number}`;
  const total = estimate.grand_total != null ? ` ($${Number(estimate.grand_total).toFixed(2)})` : '';
  const sentState = estimate.sent_for_approval_at
    ? `sent ${new Date(estimate.sent_for_approval_at).toLocaleDateString()} and still awaiting approval`
    : 'never sent for approval';

  await notifyMany(Array.from(targetIds), {
    type: 'price_outstanding',
    title: `Printing started — Estimate #${estimate.estimate_number} not approved`,
    body: `${jobLabel}${job.customer ? ` for ${job.customer}` : ''} moved to printing, but Estimate #${estimate.estimate_number}${total} was ${sentState}. Chase the approval before this becomes a surprise.`,
    url: deepLinks.estimate(estimate.id),
  });

  return NextResponse.json({ notified: targetIds.size });
}
