import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { notify, getSuperAdminIds } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { recordHeartbeat } from '@/lib/system-health';
import { fetchAllRows } from '@/lib/fetch-all';
import { chicagoDate } from '@/lib/cash-outlook';
import { GRAPHICS_FINISHED_STATUSES } from '@/lib/graphics-status';
import {
  reminderFor, resolveReminderSettings, buildDigest,
  type ReminderJob, type ReminderLine,
} from '@/lib/graphics-reminders';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const service = createServiceClient();

/** Re-send an unchanged digest this often, so a standing problem doesn't fade out. */
const REALERT_DAYS = 3;

interface JobRow extends ReminderJob {
  created_by: string | null;
}

/** Paginate: active jobs are bounded in practice, PostgREST's 1000 cap is not. */
async function loadActiveJobs(): Promise<JobRow[]> {
  const rows: JobRow[] = [];
  const page = 500;
  for (let from = 0; ; from += page) {
    const { data, error } = await service
      .from('graphics_jobs')
      .select('id, title, job_number, customer, status, due_date, created_at, assigned_to, created_by')
      .not('status', 'in', `(${GRAPHICS_FINISHED_STATUSES.map(s => `"${s}"`).join(',')})`)
      .order('created_at')
      .order('id')
      .range(from, from + page - 1);
    if (error) throw new Error(`reading graphics jobs: ${error.message}`);
    rows.push(...((data || []) as JobRow[]));
    if (!data || data.length < page) break;
  }
  return rows;
}

/**
 * When each job entered its current stage — the board's own stage clock.
 *
 * Paginated, not `.limit(1000)`: a busy job carries dozens of history rows,
 * so a capped read drops the OLDEST jobs' newest transition. Those jobs then
 * fall back to created_at, which inflates their stage clock and invents a
 * stall reminder for a job that moved yesterday. Deterministic order with a
 * unique tiebreaker keeps pages from skipping rows mid-read.
 */
async function loadStageSince(jobIds: string[]): Promise<Map<string, string>> {
  const since = new Map<string, string>();
  for (let i = 0; i < jobIds.length; i += 200) {
    const chunk = jobIds.slice(i, i + 200);
    const { data, error } = await fetchAllRows<{
      job_id: string; from_status: string | null; to_status: string; created_at: string;
    }>((from, to) => service
      .from('graphics_status_history')
      .select('job_id, from_status, to_status, created_at')
      .in('job_id', chunk)
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, to));
    if (error) throw new Error(`reading graphics status history: ${error.message}`);
    for (const h of data) {
      // A no-op transition doesn't restart the clock (same rule the board uses).
      if (h.from_status === h.to_status) continue;
      if (!since.has(h.job_id)) since.set(h.job_id, h.created_at);
    }
  }
  return since;
}

/**
 * Daily graphics reminder sweep.
 *
 * The board has always SHOWN which jobs are overdue, due soon, stalled in a
 * stage, or sitting unowned — but showing only reaches someone already
 * looking at the board, and a job stalls precisely when nobody is. This
 * turns those four questions into ONE digest per person: a designer with
 * four problem jobs gets one notification listing four lines, not four
 * pings. (With 36 jobs stuck 5+ days on the day this was written, per-job
 * alerts would have been a 36-push morning and everyone would have turned
 * notifications off — which is the real failure mode.)
 *
 * WHO HEARS IT. The assignee first. A job that stays past its threshold by
 * the escalation window also reaches the person who entered it and the
 * super admins, so a job nobody is actually working stops being invisible.
 * An unassigned job has no assignee to tell, so it goes straight to that
 * same group — it is the one reason that starts escalated.
 *
 * QUIET WHEN NOTHING CHANGED. Each person's digest is fingerprinted. An
 * identical list doesn't resend for REALERT_DAYS, so a long-running problem
 * nudges every few days instead of every morning, and a NEW problem still
 * lands the next morning because it changes the fingerprint.
 *
 * Staff-only, by the house rule: this spots things a customer might care
 * about and tells the shop, never the customer.
 */
export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
  }

  try {
    const { data: settingsRow } = await service
      .from('graphics_reminder_settings')
      .select('enabled, stage_days, due_soon_days, unassigned_days, escalate_after_days')
      .eq('id', 1)
      .maybeSingle();
    const settings = resolveReminderSettings(settingsRow);

    if (!settings.enabled) {
      await recordHeartbeat(service, 'graphics_reminders', { status: 'ok', disabled: true }, { startedAt });
      return NextResponse.json({ status: 'ok', disabled: true });
    }

    const jobs = await loadActiveJobs();
    const jobIds = jobs.map(j => j.id);

    // Picker assignments, on top of the job's own assigned_to.
    const extraAssignees = new Map<string, string[]>();
    for (let i = 0; i < jobIds.length; i += 200) {
      const { data } = await service
        .from('job_assignments')
        .select('job_id, user_id')
        .eq('job_type', 'graphics_job')
        .in('job_id', jobIds.slice(i, i + 200));
      for (const a of data || []) {
        extraAssignees.set(a.job_id, [...(extraAssignees.get(a.job_id) || []), a.user_id]);
      }
    }

    const stageSince = await loadStageSince(jobIds);
    const now = Date.now();
    // The shop's calendar day, not the container's UTC one: a due date is a
    // date on the floor's calendar, and a manual re-run at 9pm Central would
    // otherwise call everything due today overdue.
    const today = chicagoDate(new Date(now));

    // One pass: every job that has something to say, and who should hear it.
    const perRecipient = new Map<string, ReminderLine[]>();
    const addLine = (userId: string, line: ReminderLine) => {
      perRecipient.set(userId, [...(perRecipient.get(userId) || []), line]);
    };

    let superAdminIds: string[] | null = null;
    const owners = async () => (superAdminIds ??= await getSuperAdminIds());

    // Everyone a line could name or reach, looked up once and chunked —
    // ~180 active jobs is up to 360 ids, and PostgREST reads over GET, so an
    // unchunked .in() builds a URL long enough to be rejected.
    const peopleIds = [...new Set(jobs.flatMap(j => [j.assigned_to, j.created_by]).filter(Boolean) as string[])];
    const people = new Map<string, { name: string; approved: boolean }>();
    for (let i = 0; i < peopleIds.length; i += 200) {
      const { data } = await service
        .from('profiles')
        .select('id, full_name, email, status')
        .in('id', peopleIds.slice(i, i + 200));
      for (const p of data || []) {
        people.set(p.id, {
          name: (p as any).full_name || (p as any).email || 'someone',
          approved: (p as any).status === 'approved',
        });
      }
    }
    // A departed account keeps its jobs. Reminding it forever is a write
    // nobody reads, so escalation skips anyone not currently approved.
    const canBeTold = (userId: string) => people.get(userId)?.approved !== false;

    let flagged = 0;
    for (const job of jobs) {
      const extras = extraAssignees.get(job.id) || [];
      const finding = reminderFor(job, {
        settings, today, now,
        stageSince: stageSince.get(job.id) || null,
        extraAssignees: extras,
      });
      if (!finding) continue;
      flagged++;

      const assignees = [...new Set([job.assigned_to, ...extras].filter(Boolean) as string[])];
      for (const userId of assignees) {
        if (!canBeTold(userId)) continue;
        addLine(userId, { job, finding });
      }

      // Escalation — and an unassigned job has nobody else, so it starts here.
      if (finding.escalate || finding.reason === 'unassigned') {
        const escalateTo = new Set<string>(await owners());
        if (job.created_by) escalateTo.add(job.created_by);
        for (const userId of escalateTo) {
          if (assignees.includes(userId)) continue; // already has it as their own
          if (!canBeTold(userId)) continue;
          addLine(userId, { job, finding, escalated: true });
        }
      }
    }

    // Per-recipient dedupe: an unchanged list waits REALERT_DAYS.
    const { data: state } = await service
      .from('sync_state').select('last_result').eq('sync_type', 'graphics_reminders').maybeSingle();
    const lastSent: Record<string, { hash: string; at: string }> =
      ((state?.last_result as any)?.digests as any) || {};
    const nextSent: Record<string, { hash: string; at: string }> = {};

    let sent = 0;
    let skipped = 0;
    for (const [userId, lines] of perRecipient) {
      const decorated = lines.map(l => ({
        ...l,
        // Name the holder only on lines this person isn't holding. An
        // unassigned job has no name to give, and the line already says so.
        assigneeName: l.escalated && l.job.assigned_to ? people.get(l.job.assigned_to)?.name || null : null,
      }));
      const allEscalated = decorated.every(l => l.escalated);
      const digest = buildDigest(decorated, { escalation: allEscalated });
      if (!digest) continue;

      // Fingerprint the CONTENT, not the wording: same jobs, same reasons,
      // same day counts = the same news, and news doesn't need retelling.
      const hash = decorated
        .map(l => `${l.job.id}:${l.finding.reason}:${l.finding.days}`)
        .sort()
        .join('|');
      const previous = lastSent[userId];
      const staleEnough = !previous
        || previous.hash !== hash
        || now - new Date(previous.at).getTime() >= REALERT_DAYS * 86_400_000;
      if (!staleEnough) {
        nextSent[userId] = previous;
        skipped++;
        continue;
      }

      // Where the click lands: one job → that job. Your own list → the board
      // on My Jobs. A mixed or escalated list → the board, because My Jobs
      // would hide the very rows the digest is about.
      const url = decorated.length === 1
        ? deepLinks.graphicsJob(decorated[0].job.id)
        : decorated.some(l => l.escalated)
          ? deepLinks.graphicsBoard()
          : deepLinks.graphicsBoard({ mine: true });

      await notify({
        userId,
        type: allEscalated ? 'graphics_reminder_escalation' : 'graphics_reminder',
        title: digest.title,
        body: digest.body,
        url,
      });
      nextSent[userId] = { hash, at: new Date(now).toISOString() };
      sent++;
    }

    const result = {
      status: 'ok',
      jobs: jobs.length,
      flagged,
      recipients: perRecipient.size,
      sent,
      skipped,
      digests: nextSent,
    };
    const syncStateWrite = await recordHeartbeat(service, 'graphics_reminders', result, {
      startedAt, records: sent,
    });

    return NextResponse.json({ ...result, digests: undefined, syncStateWrite });
  } catch (e: any) {
    console.error('graphics-reminders failed:', e);
    await recordHeartbeat(service, 'graphics_reminders', { error: e.message || 'graphics reminder sweep failed' }, { startedAt });
    return NextResponse.json({ error: e.message || 'graphics reminder sweep failed' }, { status: 500 });
  }
}
