import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';
import { fetchAllRows } from '@/lib/fetch-all';
import { shopWorkMs, isShopClockRunning } from '@/lib/shop-hours';
import { estimateHeadlineNumber } from '@/lib/estimate-number';
import { reviewReminderDue, reviewSnoozedUntil, REVIEW_REMINDER_SHOP_HOURS } from '@/lib/estimate-review';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * Hourly overdue-review sweep (owner ask 2026-10-06): "get customers their
 * quotes quickly but still have oversight". An estimate sent for internal
 * review that is still pending after REVIEW_REMINDER_SHOP_HOURS of shop time
 * pings every admin, plus the assigned reviewer, to open it and approve it
 * (any admin can decide a review — canDecideReview). Once per review round;
 * a fresh Send for Review starts a new round, and so does a snooze running
 * out (migration 347). Reminders only go out while the shop clock runs, so a
 * snooze that ends on a Saturday reminds Monday morning.
 *
 * Runs every hour, every day: the shop-hours clock does the gating (a run at
 * night or on a weekend finds nothing newly due), and an hourly heartbeat
 * keeps System Health honest without a weekday special case. Internal only —
 * nothing here contacts a customer.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    const { data: pending } = await fetchAllRows<any>((from, to) => service
      .from('estimates')
      .select('id, estimate_number, netsuite_estimate_number, customer_name, grand_total, internal_review_status, internal_reviewer_id, internal_review_requested_at, internal_review_reminded_at, internal_review_snoozed_until')
      .eq('internal_review_status', 'pending')
      .order('id')
      .range(from, to));

    const now = Date.now();
    // Outside shop hours nothing goes out; the next in-hours run picks it up.
    const due = isShopClockRunning(now) ? (pending || []).filter(e => reviewReminderDue(e, now, shopWorkMs)) : [];
    if (due.length === 0) {
      const syncStateWrite = await recordHeartbeat(service, 'estimate_review_reminder', { status: 'ok', pending: (pending || []).length, reminded: 0 });
      return NextResponse.json({ status: 'ok', pending: (pending || []).length, reminded: 0, syncStateWrite });
    }

    // "The whole admin staff": every approved admin or super admin.
    const { data: admins } = await service
      .from('profiles')
      .select('id')
      .or('role.in.(admin,super_admin),roles.ov.{admin,super_admin}')
      .eq('status', 'approved');
    const adminIds = (admins || []).map((a: any) => a.id).filter(Boolean);

    const reviewerIds = [...new Set(due.map(e => e.internal_reviewer_id).filter(Boolean))];
    const { data: reviewers } = reviewerIds.length
      ? await service.from('profiles').select('id, full_name, email').in('id', reviewerIds)
      : { data: [] as any[] };
    const reviewerName = new Map((reviewers || []).map((r: any) => [r.id, r.full_name || r.email || 'the reviewer']));

    let reminded = 0;
    for (const est of due) {
      const targets = new Set<string>(adminIds);
      if (est.internal_reviewer_id) targets.add(est.internal_reviewer_id);
      const headline = estimateHeadlineNumber(est);
      const who = est.internal_reviewer_id ? reviewerName.get(est.internal_reviewer_id) || 'the reviewer' : 'a reviewer';
      const afterSnooze = reviewSnoozedUntil(est) != null;
      const waited = Math.floor(shopWorkMs(new Date(est.internal_review_requested_at).getTime(), now) / 3_600_000);

      // Stamp first: if the stamp can't be written, skip rather than risk
      // re-pinging every admin on every hourly run.
      const { error: stampErr } = await service
        .from('estimates')
        .update({ internal_review_reminded_at: new Date(now).toISOString() })
        .eq('id', est.id)
        .eq('internal_review_status', 'pending');
      if (stampErr) {
        console.error(`[estimate-review-reminder] stamp failed for ${est.id}:`, stampErr.message);
        continue;
      }

      if (targets.size > 0) {
        await notifyMany([...targets], {
          type: 'estimate_review_overdue',
          title: `Estimate #${headline} still needs review`,
          body: `${est.customer_name || 'An estimate'}${est.grand_total ? ` — $${Number(est.grand_total).toLocaleString()}` : ''}`
            + ` has waited ${Math.max(waited, REVIEW_REMINDER_SHOP_HOURS)} shop hours for ${who}'s review and the customer hasn't seen it yet.`
            + (afterSnooze ? ' Its snooze just ended.' : '')
            + ' Any admin can open it and approve it, send it back, or snooze it.',
          url: deepLinks.estimate(est.id),
        });
      }
      reminded++;
    }

    const syncStateWrite = await recordHeartbeat(service, 'estimate_review_reminder', { status: 'ok', pending: (pending || []).length, reminded });
    return NextResponse.json({ status: 'ok', pending: (pending || []).length, reminded, syncStateWrite });
  } catch (e: any) {
    console.error('estimate-review-reminder failed:', e);
    await recordHeartbeat(service, 'estimate_review_reminder', { error: e.message || 'estimate review reminder failed' });
    return NextResponse.json({ error: e.message || 'estimate review reminder failed' }, { status: 500 });
  }
}
