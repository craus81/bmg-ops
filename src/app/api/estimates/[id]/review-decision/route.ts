import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature, getProfileRoles, isAdminRole } from '@/lib/api-auth';
import { deepLinks } from '@/lib/deep-links';
import { estimateHeadlineNumber } from '@/lib/estimate-number';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { notify } from '@/lib/notify';
import { canDecideReview, reviewStateOf, REVIEW_DECISIONS } from '@/lib/estimate-review';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const DecisionSchema = z.object({
  decision: z.enum(REVIEW_DECISIONS),
  /** What the reviewer changed, or wants changed. Required to send it back. */
  note: z.string().trim().max(5000).optional(),
});

/**
 * POST /api/estimates/[id]/review-decision
 *
 * The reviewer's answer on an internal review (migration 316): approve it so
 * the rep can send, or hand it back with notes. Either way the rep hears
 * about it on the bell, in New for you, and by email.
 *
 * This moves NOTHING on the customer side — no token, no status change, no
 * customer email. A reviewer who wants to send it themselves uses the normal
 * customer approval send, which resolves the pending review as approved.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, DecisionSchema);
  if (parsed.error) return parsed.error;
  const { decision } = parsed.data;
  const note = parsed.data.note?.trim() || null;

  const { data: estimate, error: eErr } = await supabase
    .from('estimates')
    .select('id, estimate_number, netsuite_estimate_number, customer_name, grand_total, internal_review_status, internal_reviewer_id, internal_review_requested_by')
    .eq('id', params.id)
    .single();
  if (eErr || !estimate) {
    return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  }

  const state = reviewStateOf(estimate);
  if (state.status !== 'pending') {
    return NextResponse.json({
      error: state.status
        ? 'This review was already answered. Ask for a fresh review if the estimate changed.'
        : 'This estimate isn\'t waiting on a review.',
    }, { status: 409 });
  }

  const isAdmin = isAdminRole(getProfileRoles(auth.profile));
  if (!canDecideReview(state, auth.user.id, isAdmin)) {
    return NextResponse.json({
      error: 'This review is assigned to someone else — only they (or an admin) can answer it.',
    }, { status: 403 });
  }

  // Handing it back without saying why leaves the rep guessing, which is the
  // round trip this step exists to avoid.
  if (decision === 'changes_requested' && !note) {
    return NextResponse.json({ error: 'Say what needs changing — the note is what the rep acts on.' }, { status: 400 });
  }

  const { data: settled, error: updErr } = await supabase
    .from('estimates')
    .update({
      internal_review_status: decision,
      internal_review_decided_by: auth.user.id,
      internal_review_decided_at: new Date().toISOString(),
      internal_review_note: note,
      updated_at: new Date().toISOString(),
    })
    .eq('id', estimate.id)
    // Only settle the review this request read: two reviewers answering at
    // once must not have the second silently overwrite the first.
    .eq('internal_review_status', 'pending')
    .select('id');
  if (updErr) {
    return NextResponse.json({ error: 'Could not record the decision: ' + updErr.message }, { status: 500 });
  }
  // Nothing updated = somebody answered (or the rep re-sent it) between this
  // request's read and its write. Report that instead of announcing a
  // decision that was never stored.
  if (!settled || settled.length === 0) {
    return NextResponse.json({
      error: 'Someone answered this review a moment ago — reload the estimate to see where it stands.',
    }, { status: 409 });
  }

  const headline = estimateHeadlineNumber(estimate);
  const deciderName = (auth.profile as any)?.full_name || auth.user?.email || 'A reviewer';

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'estimates',
    recordId: estimate.id,
    action: decision === 'approved' ? 'estimate_internal_review_approved' : 'estimate_internal_review_changes_requested',
    detail: { estimate_number: estimate.estimate_number, note },
  });

  // Back to whoever asked. The reviewer answering their own request (an
  // admin who sent it to themselves) needs no ping.
  if (state.requestedBy && state.requestedBy !== auth.user.id) {
    await notify({
      userId: state.requestedBy,
      type: 'estimate_review_update',
      title: decision === 'approved'
        ? `Estimate #${headline} approved by ${deciderName}`
        : `Estimate #${headline} — ${deciderName} wants changes`,
      body: decision === 'approved'
        ? `${estimate.customer_name || 'The estimate'} is cleared to send to the customer.${note ? ` Note: ${note}` : ''}`.slice(0, 900)
        : `${deciderName} sent it back: ${note}`.slice(0, 900),
      url: deepLinks.estimate(estimate.id),
      emailReplyTo: auth.user?.email || undefined,
    }).catch(err => console.error('review-decision notify failed:', err));
  }

  return NextResponse.json({
    status: decision,
    decidedBy: { id: auth.user.id, name: deciderName },
    note,
  });
}
