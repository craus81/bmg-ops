import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { sendProofApproval } from '@/lib/proof-approval-send';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Auto-resend the proof link after this many quiet days (and again every
// interval), up to the cap; escalate internally at the threshold.
const REMIND_AFTER_DAYS = 3;
const MAX_REMINDERS = 3;
const ESCALATE_AFTER_DAYS = 7;

// A proof stuck waiting doesn't matter once the job is effectively done
// or dead — don't nag customers about jobs that already went out the door.
const IGNORE_STATUSES = ['cancelled', 'shipped', 'picked_up', 'installed'];

/**
 * Daily proof-approval sweep: customers who sit on a proof link block
 * production silently. Quiet 3+ days → automatic reminder email with a
 * fresh link (capped at 3). Quiet 7+ days → internal escalation to the
 * sender/assignees so a human picks up the phone. A manual resend resets
 * the whole cycle.
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
    const { data: jobs } = await service
      .from('graphics_jobs')
      .select('id, job_number, title, customer, status, sent_for_approval_at, sent_for_approval_by, created_by, assigned_to, approval_reminder_sent_at, approval_reminder_count, approval_escalated_at')
      .not('sent_for_approval_at', 'is', null)
      .eq('customer_approved', false)
      .is('customer_rejected_at', null)
      .limit(500);

    const now = Date.now();
    const dayMs = 86_400_000;
    const daysSince = (iso: string | null) => iso ? (now - new Date(iso).getTime()) / dayMs : null;

    const waiting = (jobs || []).filter(j => !IGNORE_STATUSES.includes(j.status));
    let reminded = 0;
    let escalated = 0;
    const failures: string[] = [];

    for (const job of waiting) {
      const sentDays = daysSince(job.sent_for_approval_at);
      if (sentDays == null) continue;
      const label = job.title || job.job_number || job.id.slice(0, 8);

      // Reminder: quiet since the last touch (send or reminder) for 3+ days.
      const lastTouch = Math.max(
        new Date(job.sent_for_approval_at).getTime(),
        job.approval_reminder_sent_at ? new Date(job.approval_reminder_sent_at).getTime() : 0,
      );
      const quietDays = (now - lastTouch) / dayMs;
      if (quietDays >= REMIND_AFTER_DAYS && (job.approval_reminder_count || 0) < MAX_REMINDERS) {
        const result = await sendProofApproval(service, job.id, { reminder: true });
        if (result.ok) reminded++;
        else if (!result.skipped) failures.push(`${label}: ${result.error}`);
      }

      // Escalation: waiting 7+ days total → tell the humans, re-escalate
      // at most weekly while it stays stuck.
      const escalatedDays = daysSince(job.approval_escalated_at);
      if (sentDays >= ESCALATE_AFTER_DAYS && (escalatedDays == null || escalatedDays >= ESCALATE_AFTER_DAYS)) {
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
            body: `${job.customer || 'The customer'} hasn't answered the proof for ${label} in ${Math.floor(sentDays)} days (${job.approval_reminder_count || 0} automatic reminder${(job.approval_reminder_count || 0) !== 1 ? 's' : ''} sent). Production is blocked — worth a call.`,
            url: '/graphics',
            channels: ['in_app', 'push'],
            forceChannels: true,
          });
        }
        await service.from('graphics_jobs')
          .update({ approval_escalated_at: new Date().toISOString() })
          .eq('id', job.id);
        escalated++;
      }
    }

    await service.from('sync_state').upsert({
      sync_type: 'proof_reminder_check',
      last_synced_at: new Date().toISOString(),
      last_result: { status: 'ok', waiting: waiting.length, reminded, escalated, failures: failures.slice(0, 10) },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'sync_type' });

    return NextResponse.json({ status: 'ok', waiting: waiting.length, reminded, escalated, failures });
  } catch (e: any) {
    console.error('proof-reminder-check failed:', e);
    await service.from('sync_state').upsert({
      sync_type: 'proof_reminder_check',
      last_synced_at: new Date().toISOString(),
      last_result: { error: e.message || 'proof reminder check failed' },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'sync_type' }).then(() => {}, () => {});
    return NextResponse.json({ error: e.message || 'proof reminder check failed' }, { status: 500 });
  }
}
