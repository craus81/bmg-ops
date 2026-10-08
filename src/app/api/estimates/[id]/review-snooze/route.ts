import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireFeature, getProfileRoles, isAdminRole } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { canDecideReview, reviewStateOf, REVIEW_SNOOZE_DAYS } from '@/lib/estimate-review';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SnoozeSchema = z.object({
  /** 1, 3 or 7 days; null wakes it back up. */
  days: z.union([z.literal(REVIEW_SNOOZE_DAYS[0]), z.literal(REVIEW_SNOOZE_DAYS[1]), z.literal(REVIEW_SNOOZE_DAYS[2])]).nullable(),
});

/**
 * POST /api/estimates/[id]/review-snooze
 *
 * Quiet the overdue-review reminder on one estimate for the whole team
 * (migration 350, owner ask 2026-10-07). When the snooze runs out the
 * reminder goes out once more (estimate-review-reminder cron). Same people
 * who can answer the review can snooze it: the assigned reviewer or any
 * admin. `days: null` ends a snooze early.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'estimates');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, SnoozeSchema);
  if (parsed.error) return parsed.error;
  const { days } = parsed.data;

  const { data: estimate, error: eErr } = await supabase
    .from('estimates')
    .select('id, estimate_number, internal_review_status, internal_reviewer_id, internal_review_requested_by')
    .eq('id', params.id)
    .single();
  if (eErr || !estimate) {
    return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  }

  const state = reviewStateOf(estimate);
  if (state.status !== 'pending') {
    return NextResponse.json({ error: 'This estimate isn\'t waiting on a review, so there is nothing to snooze.' }, { status: 409 });
  }
  const isAdmin = isAdminRole(getProfileRoles(auth.profile));
  if (!canDecideReview(state, auth.user.id, isAdmin)) {
    return NextResponse.json({ error: 'Only the reviewer or an admin can snooze this review.' }, { status: 403 });
  }

  const until = days == null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
  const { data: updated, error: updErr } = await supabase
    .from('estimates')
    .update({
      internal_review_snoozed_until: until,
      internal_review_snoozed_by: until ? auth.user.id : null,
    })
    .eq('id', estimate.id)
    .eq('internal_review_status', 'pending')
    .select('id');
  if (updErr) {
    return NextResponse.json({ error: 'Could not snooze the review: ' + updErr.message }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: 'Someone answered this review a moment ago — reload the estimate.' }, { status: 409 });
  }

  await logAudit(supabase, {
    actorId: auth.user.id,
    table: 'estimates',
    recordId: estimate.id,
    action: until ? 'estimate_internal_review_snoozed' : 'estimate_internal_review_unsnoozed',
    detail: { estimate_number: estimate.estimate_number, days, until },
  });

  return NextResponse.json({ status: 'ok', snoozedUntil: until });
}
