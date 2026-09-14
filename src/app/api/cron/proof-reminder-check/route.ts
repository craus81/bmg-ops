import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';
import { fetchAllRows } from '@/lib/fetch-all';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const service = createServiceClient();

// Prompt a human after this many quiet days, and again every interval
// while the proof stays unanswered.
const ESCALATE_AFTER_DAYS = 3;

// A proof stuck waiting doesn't matter once the job is effectively done
// or dead — don't nag customers about jobs that already went out the door.
const IGNORE_STATUSES = ['cancelled', 'shipped', 'picked_up', 'installed'];

/**
 * Daily proof-approval sweep: customers who sit on a proof link block
 * production silently. Quiet 3+ days → the sender/assignees are told, and
 * they resend the link themselves from the job page ("Resend approval
 * link"). Re-tells every 3 days while it stays unanswered; a manual resend
 * resets the clock, since that is a fresh touch.
 *
 * THIS CRON DOES NOT EMAIL CUSTOMERS. It used to resend the proof link
 * automatically on day 3/6/9 — the owner's call on 2026-09-14 was that
 * every customer-facing send is a person's decision, not a schedule's
 * (a customer had been chased repeatedly across several open records).
 * Keep it that way: new branches here notify staff.
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
    // Paginated sweep: the bare .limit(500) had no deterministic order, so
    // which 500 awaiting-approval jobs got reminders was arbitrary and the
    // rest were silently skipped (roadmap B9).
    const { data: jobs } = await fetchAllRows<any>((from, to) => service
      .from('graphics_jobs')
      .select('id, job_number, title, customer, status, sent_for_approval_at, sent_for_approval_by, created_by, assigned_to, approval_reminder_sent_at, approval_escalated_at')
      .not('sent_for_approval_at', 'is', null)
      .eq('customer_approved', false)
      .is('customer_rejected_at', null)
      .order('id')
      .range(from, to));

    const now = Date.now();
    const dayMs = 86_400_000;
    const daysSince = (iso: string | null) => iso ? (now - new Date(iso).getTime()) / dayMs : null;

    const waiting = (jobs || []).filter(j => !IGNORE_STATUSES.includes(j.status));
    let escalated = 0;

    for (const job of waiting) {
      const sentDays = daysSince(job.sent_for_approval_at);
      if (sentDays == null) continue;
      const label = job.title || job.job_number || job.id.slice(0, 8);

      // Quiet since the last touch (the original send or a manual resend)
      // for 3+ days → tell the humans, and tell them again every 3 days
      // while it stays unanswered. Measured from the last touch, not from
      // the original send, so a resend buys the customer another 3 days
      // before anyone is nudged about it again.
      const lastTouch = Math.max(
        new Date(job.sent_for_approval_at).getTime(),
        job.approval_reminder_sent_at ? new Date(job.approval_reminder_sent_at).getTime() : 0,
      );
      const quietDays = (now - lastTouch) / dayMs;
      const escalatedDays = daysSince(job.approval_escalated_at);
      if (quietDays >= ESCALATE_AFTER_DAYS && (escalatedDays == null || escalatedDays >= ESCALATE_AFTER_DAYS)) {
        const targets = new Set<string>();
        if (job.sent_for_approval_by) targets.add(job.sent_for_approval_by);
        if (job.created_by) targets.add(job.created_by);
        if (job.assigned_to) targets.add(job.assigned_to);
        if (targets.size === 0) {
          const { data: admins } = await service
            .from('profiles').select('id')
            .or('role.eq.admin,roles.cs.{admin}')
            .eq('status', 'approved');
          for (const a of admins || []) targets.add(a.id);
        }
        if (targets.size > 0) {
          await notifyMany([...targets], {
            type: 'proof_stale',
            title: `Proof stuck ${Math.floor(sentDays)}d — ${label}`,
            body: `${job.customer || 'The customer'} hasn't answered the proof for ${label} in ${Math.floor(sentDays)} days`
              + ` — quiet ${Math.floor(quietDays)} day${Math.floor(quietDays) === 1 ? '' : 's'} since we last sent it. Production is blocked.`
              + ' Nothing has gone to them automatically: open the job and use "Resend approval link", or call.',
            url: deepLinks.graphicsJob(job.id),
            channels: ['in_app', 'push', 'email'],
          });
        }
        await service.from('graphics_jobs')
          .update({ approval_escalated_at: new Date().toISOString() })
          .eq('id', job.id);
        escalated++;
      }
    }

    const syncStateWrite = await recordHeartbeat(
      service, 'proof_reminder_check', { status: 'ok', waiting: waiting.length, escalated },
    );

    return NextResponse.json({ status: 'ok', waiting: waiting.length, escalated, syncStateWrite });
  } catch (e: any) {
    console.error('proof-reminder-check failed:', e);
    await recordHeartbeat(service, 'proof_reminder_check', { error: e.message || 'proof reminder check failed' }); // never throws; failure already logged
    return NextResponse.json({ error: e.message || 'proof reminder check failed' }, { status: 500 });
  }
}
