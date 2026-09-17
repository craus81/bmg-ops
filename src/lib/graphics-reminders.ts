/**
 * Graphics job reminders — who needs telling that a job has gone quiet.
 *
 * The board has always SHOWN this (the Overdue / Due in 7 days / Stuck 5+
 * days tiles), but showing only works on someone already looking at the
 * board. A job stalls precisely when nobody is looking. So a daily sweep
 * turns the same three questions, plus "has anyone picked this up at all",
 * into one digest per person.
 *
 * WHY PER-STAGE THRESHOLDS. One flat "stalled after N days" is wrong twice
 * over: outgassing is legitimately an overnight wait, so a 2-day rule nags
 * the print room about physics, while a week in Designing is a genuinely
 * lost job that the same rule would forgive. Every stage gets its own
 * number, admins can tune them without a deploy, and 0 turns a stage off —
 * ready_to_pickup ships that way, because a job waiting on a CUSTOMER to
 * collect it is not the designer's to hurry.
 *
 * ONE LINE PER JOB. A job can be stalled AND overdue AND due tomorrow; a
 * digest listing it three times reads like three problems. `reminderFor`
 * returns only the most urgent reason, so the count in the title is a count
 * of jobs, which is what the reader thinks it is.
 *
 * Pure — no DB, no clock of its own — so the cron, the tests and any future
 * "why did I get this?" screen all reason about reminders the same way.
 */

import { isFinishedStatus } from './graphics-status';
import type { GraphicsJobStatus } from './types';

export type ReminderReason = 'overdue' | 'stalled' | 'due_soon' | 'unassigned';

/** Most urgent first — `reminderFor` reports the first one that fires. */
export const REASON_PRIORITY: ReminderReason[] = ['overdue', 'stalled', 'due_soon', 'unassigned'];

export interface ReminderSettings {
  enabled: boolean;
  /**
   * Days a job may sit in a stage before it counts as stalled, per status.
   * 0 (or a missing entry) turns that stage off.
   */
  stageDays: Partial<Record<GraphicsJobStatus, number>>;
  /** Warn this many days before a due date. */
  dueSoonDays: number;
  /** An active job with nobody on it for this long needs an owner. */
  unassignedDays: number;
  /**
   * Extra days past a reason's own threshold before the person who entered
   * the job and the super admins hear about it too.
   */
  escalateAfterDays: number;
}

/**
 * Defaults chosen from how long each stage actually takes on the floor:
 * machine stages are same-day, design stages are measured in days, and the
 * two "waiting on someone else" stages are slow on purpose.
 */
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: true,
  stageDays: {
    received: 2,          // sitting unstarted
    designing: 3,
    revision: 2,          // a rework everyone thinks is someone else's
    printing: 1,          // a day on the printer is a jam, not a job
    outgassing: 2,        // genuinely an overnight wait
    cutting: 1,
    packing: 1,
    ready: 3,             // finished and not going anywhere
    ready_to_pickup: 0,   // off: waiting on the customer, not on us
  },
  dueSoonDays: 2,
  unassignedDays: 1,
  escalateAfterDays: 3,
};

/** The shape the cron and the settings screen exchange with the database. */
export interface ReminderSettingsRow {
  enabled?: boolean | null;
  stage_days?: Record<string, unknown> | null;
  due_soon_days?: number | null;
  unassigned_days?: number | null;
  escalate_after_days?: number | null;
}

const asDays = (value: unknown, fallback: number): number => {
  // null/undefined/'' mean "not set", NOT zero — Number(null) is 0, and
  // taking that literally turns an unset column into a silently disabled
  // reminder, which is the one failure mode nobody would ever notice.
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
};

/**
 * A stored row over the defaults. Every field is optional and every bad
 * value falls back rather than throwing: a settings row half-written by an
 * older version of the app must not stop the sweep from running at all.
 */
export function resolveReminderSettings(row: ReminderSettingsRow | null | undefined): ReminderSettings {
  const d = DEFAULT_REMINDER_SETTINGS;
  const stageDays: Partial<Record<GraphicsJobStatus, number>> = { ...d.stageDays };
  for (const [status, value] of Object.entries(row?.stage_days || {})) {
    // An unknown status key is ignored, not merged: a renamed stage should
    // fall back to no reminder rather than silently shadow a real one.
    if (status in STAGE_LABELS) {
      stageDays[status as GraphicsJobStatus] = asDays(value, 0);
    }
  }
  return {
    enabled: row?.enabled ?? d.enabled,
    stageDays,
    dueSoonDays: asDays(row?.due_soon_days, d.dueSoonDays),
    unassignedDays: asDays(row?.unassigned_days, d.unassignedDays),
    escalateAfterDays: asDays(row?.escalate_after_days, d.escalateAfterDays),
  };
}

/** Stages a reminder can fire on, in pipeline order, for the settings screen. */
export const STAGE_LABELS: Record<string, string> = {
  received: 'Received',
  designing: 'Designing',
  revision: 'Revision',
  printing: 'Printing',
  outgassing: 'Outgassing',
  cutting: 'Cutting',
  packing: 'Packing',
  ready: 'Ready',
  ready_to_pickup: 'Ready for pickup',
};

export interface ReminderJob {
  id: string;
  title: string | null;
  job_number: string | null;
  customer: string | null;
  status: GraphicsJobStatus;
  due_date: string | null;
  created_at: string;
  assigned_to: string | null;
}

export interface ReminderContext {
  settings: ReminderSettings;
  /**
   * Today as YYYY-MM-DD. Due dates are calendar dates — a job due the 17th
   * is late on the 18th whatever the hour — so they compare as dates.
   */
  today: string;
  /**
   * Now, in ms. Stage and unassigned clocks measure ELAPSED time, not
   * calendar days, so they agree with the board's "Stuck 5+ days" tile and
   * so a job moved at 11pm isn't "1 day in stage" an hour later.
   */
  now: number;
  /** When this job entered its current stage (ISO). Falls back to created_at. */
  stageSince?: string | null;
  /** Anyone assigned through the picker, beyond assigned_to. */
  extraAssignees?: string[];
}

export interface ReminderFinding {
  reason: ReminderReason;
  /**
   * The clock behind the reason: days overdue, days in stage, days until
   * due (0 = today), or days unassigned.
   */
  days: number;
  /** Past the threshold by escalateAfterDays — the creator and owners hear it too. */
  escalate: boolean;
}

/** Whole calendar days between two YYYY-MM-DD dates (for due dates). */
const calendarDays = (fromDate: string, toDate: string): number => {
  const from = Date.parse(`${fromDate.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toDate.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / 86_400_000);
};

/** Whole days elapsed since a timestamp — the board's own stage clock. */
const elapsedDays = (sinceIso: string, now: number): number => {
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(since)) return 0;
  return Math.floor((now - since) / 86_400_000);
};

/**
 * The one reason this job should nudge someone today, or null.
 *
 * Finished jobs never nudge — that is the whole point of finishing one —
 * and neither do flagged jobs: those are waiting on an admin to confirm
 * they are real work, which is a different queue with a different owner.
 */
export function reminderFor(job: ReminderJob, ctx: ReminderContext): ReminderFinding | null {
  const { settings, today } = ctx;
  if (!settings.enabled) return null;
  if (isFinishedStatus(job.status) || job.status === 'flagged') return null;

  const escalated = (days: number, threshold: number) => days >= threshold + settings.escalateAfterDays;

  // Overdue beats everything: the date has already been missed.
  if (job.due_date) {
    const daysOverdue = calendarDays(job.due_date, today);
    if (daysOverdue > 0) {
      return { reason: 'overdue', days: daysOverdue, escalate: escalated(daysOverdue, 0) };
    }
  }

  const stageThreshold = settings.stageDays[job.status] ?? 0;
  if (stageThreshold > 0) {
    const stageDays = elapsedDays(ctx.stageSince || job.created_at, ctx.now);
    if (stageDays >= stageThreshold) {
      return { reason: 'stalled', days: stageDays, escalate: escalated(stageDays, stageThreshold) };
    }
  }

  if (job.due_date && settings.dueSoonDays > 0) {
    const daysUntilDue = calendarDays(today, job.due_date);
    if (daysUntilDue >= 0 && daysUntilDue <= settings.dueSoonDays) {
      // Never escalated: nothing has gone wrong yet.
      return { reason: 'due_soon', days: daysUntilDue, escalate: false };
    }
  }

  const hasOwner = !!job.assigned_to || (ctx.extraAssignees?.length ?? 0) > 0;
  if (!hasOwner && settings.unassignedDays > 0) {
    const age = elapsedDays(job.created_at, ctx.now);
    if (age >= settings.unassignedDays) {
      return { reason: 'unassigned', days: age, escalate: escalated(age, settings.unassignedDays) };
    }
  }

  return null;
}

// ═══════════ Digest wording ═══════════

export interface ReminderLine {
  job: ReminderJob;
  finding: ReminderFinding;
  /**
   * Who is holding the job — set only when the RECIPIENT isn't that person.
   * Your own list doesn't need your own name on every line; a list you're
   * seeing because it escalated to you is useless without it.
   */
  assigneeName?: string | null;
  /** This line reached the recipient because it escalated, not because it's theirs. */
  escalated?: boolean;
}

const jobLabel = (job: ReminderJob) =>
  job.title || job.customer || job.job_number || 'Untitled job';

export function describeFinding(finding: ReminderFinding, job: ReminderJob): string {
  const { reason, days } = finding;
  if (reason === 'overdue') return `Overdue ${days}d`;
  if (reason === 'stalled') return `${days}d in ${STAGE_LABELS[job.status] || job.status}`;
  if (reason === 'due_soon') return days === 0 ? 'Due today' : days === 1 ? 'Due tomorrow' : `Due in ${days}d`;
  return `Unassigned ${days}d`;
}

/** How many lines a digest body prints before it stops listing and counts. */
export const MAX_DIGEST_LINES = 8;

/**
 * The digest one person gets. Sorted by urgency so the top line is the one
 * to act on, and truncated — a notification nobody scrolls is a
 * notification nobody reads.
 */
export function buildDigest(lines: ReminderLine[], opts?: { escalation?: boolean }): { title: string; body: string } | null {
  if (lines.length === 0) return null;

  const ordered = [...lines].sort((a, b) => {
    const byReason = REASON_PRIORITY.indexOf(a.finding.reason) - REASON_PRIORITY.indexOf(b.finding.reason);
    if (byReason !== 0) return byReason;
    // Within a reason, the longest-running first.
    if (b.finding.days !== a.finding.days) return b.finding.days - a.finding.days;
    return jobLabel(a.job).localeCompare(jobLabel(b.job));
  });

  const counts = new Map<ReminderReason, number>();
  for (const l of ordered) counts.set(l.finding.reason, (counts.get(l.finding.reason) || 0) + 1);
  const summary = REASON_PRIORITY
    .filter(r => counts.has(r))
    .map(r => {
      const n = counts.get(r)!;
      if (r === 'overdue') return `${n} overdue`;
      if (r === 'stalled') return `${n} stalled`;
      if (r === 'due_soon') return `${n} due soon`;
      return `${n} unassigned`;
    })
    .join(', ');

  const one = ordered.length === 1;
  const subject = `${ordered.length} graphics ${one ? 'job' : 'jobs'}`;
  const verb = one ? 'needs' : 'need';
  const title = opts?.escalation
    ? `⚠ ${subject} still ${one ? 'needs' : 'need'} attention — ${summary}`
    : `🔔 ${subject} ${verb} attention — ${summary}`;

  const shown = ordered.slice(0, MAX_DIGEST_LINES);
  const bodyLines = shown.map(l => {
    const who = l.assigneeName ? ` · ${l.assigneeName}` : '';
    const customer = l.job.customer && l.job.customer !== l.job.title ? ` (${l.job.customer})` : '';
    return `• ${describeFinding(l.finding, l.job)} — ${jobLabel(l.job)}${customer}${who}`;
  });
  const remaining = ordered.length - shown.length;
  if (remaining > 0) bodyLines.push(`…and ${remaining} more`);

  return { title, body: bodyLines.join('\n') };
}
