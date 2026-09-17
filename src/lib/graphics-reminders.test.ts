import { describe, it, expect } from 'vitest';
import {
  reminderFor, resolveReminderSettings, buildDigest, describeFinding,
  DEFAULT_REMINDER_SETTINGS, MAX_DIGEST_LINES,
  type ReminderJob, type ReminderSettings, type ReminderLine, type ReminderContext,
} from './graphics-reminders';
import type { GraphicsJobStatus } from './types';

const TODAY = '2026-09-17';

const job = (over: Partial<ReminderJob> = {}): ReminderJob => ({
  id: 'j1',
  title: 'Unifirst box truck',
  job_number: 'GFX-1001',
  customer: 'Unifirst',
  status: 'designing',
  due_date: null,
  created_at: '2026-09-01T12:00:00Z',
  assigned_to: 'user-1',
  ...over,
});

const settings = (over: Partial<ReminderSettings> = {}): ReminderSettings =>
  ({ ...DEFAULT_REMINDER_SETTINGS, ...over });

// 2026-09-17, 08:20 Central — when the sweep actually runs.
const NOW = Date.parse('2026-09-17T13:20:00Z');

const ctx = (over: Partial<ReminderContext> = {}): ReminderContext =>
  ({ settings: settings(), today: TODAY, now: NOW, ...over });

describe('reminderFor — what fires', () => {
  it('reports a job past its due date as overdue, counting the days', () => {
    const found = reminderFor(job({ due_date: '2026-09-14', status: 'printing' }), ctx({
      stageSince: '2026-09-17T00:00:00Z',
    }));
    expect(found).toEqual({ reason: 'overdue', days: 3, escalate: true });
  });

  it('does not call a job due today overdue', () => {
    const found = reminderFor(job({ due_date: TODAY, status: 'printing' }), ctx({
      stageSince: '2026-09-17T00:00:00Z',
    }));
    expect(found?.reason).toBe('due_soon');
    expect(found?.days).toBe(0);
  });

  it('warns before a due date, inside the window only', () => {
    const inWindow = reminderFor(job({ due_date: '2026-09-19', status: 'printing' }), ctx({
      stageSince: '2026-09-17T00:00:00Z',
    }));
    expect(inWindow).toEqual({ reason: 'due_soon', days: 2, escalate: false });

    const outside = reminderFor(job({ due_date: '2026-09-25', status: 'printing' }), ctx({
      stageSince: '2026-09-17T00:00:00Z',
    }));
    expect(outside).toBeNull();
  });

  it('reports a job sitting too long in its stage', () => {
    const found = reminderFor(job({ status: 'designing' }), ctx({ stageSince: '2026-09-13T09:00:00Z' }));
    expect(found).toEqual({ reason: 'stalled', days: 4, escalate: false });
  });

  it('measures the stage clock from the stage, not from creation', () => {
    // Created three weeks ago, moved into cutting yesterday: not stalled.
    const found = reminderFor(job({ status: 'cutting', created_at: '2026-08-25T12:00:00Z' }), ctx({
      stageSince: '2026-09-16T14:00:00Z',
    }));
    expect(found).toBeNull();
  });

  it('counts elapsed time, not calendar days, so a late move is not instantly stale', () => {
    // Moved into cutting (threshold 1) at 11pm last night. Calendar-day
    // arithmetic would call that "1 day in stage" nine hours later.
    const fresh = reminderFor(job({ status: 'cutting' }), ctx({ stageSince: '2026-09-16T23:00:00Z' }));
    expect(fresh).toBeNull();

    const real = reminderFor(job({ status: 'cutting' }), ctx({ stageSince: '2026-09-16T04:00:00Z' }));
    expect(real).toMatchObject({ reason: 'stalled', days: 1 });
  });

  it('falls back to created_at when a job has no status history', () => {
    const found = reminderFor(job({ status: 'cutting', created_at: '2026-09-10T12:00:00Z' }), ctx({
      stageSince: null,
    }));
    expect(found).toMatchObject({ reason: 'stalled', days: 7 });
  });

  it('holds its tongue on a stage whose threshold is 0', () => {
    // ready_to_pickup ships off — the customer is the one being waited on.
    const found = reminderFor(job({ status: 'ready_to_pickup' }), ctx({ stageSince: '2026-06-01T12:00:00Z' }));
    expect(found).toBeNull();
  });

  it('asks for an owner on a job nobody has taken', () => {
    const found = reminderFor(
      job({ assigned_to: null, status: 'received', created_at: '2026-09-16T04:00:00Z' }),
      ctx({ stageSince: '2026-09-16T04:00:00Z' }),
    );
    expect(found).toEqual({ reason: 'unassigned', days: 1, escalate: false });
  });

  it('counts an assignment through the picker as an owner', () => {
    const found = reminderFor(
      job({ assigned_to: null, status: 'received', created_at: '2026-09-16T04:00:00Z' }),
      ctx({ stageSince: '2026-09-16T04:00:00Z', extraAssignees: ['user-9'] }),
    );
    expect(found).toBeNull();
  });
});

describe('reminderFor — what stays quiet', () => {
  it('never nudges about a finished job', () => {
    for (const status of ['shipped', 'picked_up', 'installed', 'cancelled'] as GraphicsJobStatus[]) {
      const found = reminderFor(job({ status, due_date: '2026-01-01' }), ctx({ stageSince: '2026-01-01T00:00:00Z' }));
      expect(found, `${status} should be silent`).toBeNull();
    }
  });

  it('leaves flagged jobs alone — they are an admin queue, not work in progress', () => {
    const found = reminderFor(job({ status: 'flagged', due_date: '2026-01-01', assigned_to: null }), ctx({}));
    expect(found).toBeNull();
  });

  it('sends nothing at all when reminders are switched off', () => {
    const found = reminderFor(job({ due_date: '2026-01-01' }), ctx({ settings: settings({ enabled: false }) }));
    expect(found).toBeNull();
  });
});

describe('reminderFor — one reason per job', () => {
  it('prefers overdue over a stalled stage', () => {
    const found = reminderFor(job({ status: 'designing', due_date: '2026-09-10' }), ctx({
      stageSince: '2026-09-01T12:00:00Z',
    }));
    expect(found?.reason).toBe('overdue');
  });

  it('prefers a stalled stage over a due-soon warning', () => {
    const found = reminderFor(job({ status: 'designing', due_date: '2026-09-18' }), ctx({
      stageSince: '2026-09-01T12:00:00Z',
    }));
    expect(found?.reason).toBe('stalled');
  });

  it('prefers a due-soon warning over asking for an owner', () => {
    const found = reminderFor(
      job({ status: 'printing', due_date: '2026-09-18', assigned_to: null, created_at: '2026-09-01T12:00:00Z' }),
      ctx({ stageSince: '2026-09-17T00:00:00Z' }),
    );
    expect(found?.reason).toBe('due_soon');
  });
});

describe('reminderFor — escalation', () => {
  it('escalates once a job is past its threshold by the escalation window', () => {
    // designing threshold 3 + escalateAfterDays 3 = 6 days in stage.
    const almost = reminderFor(job({ status: 'designing' }), ctx({ stageSince: '2026-09-12T04:00:00Z' }));
    expect(almost).toMatchObject({ days: 5, escalate: false });

    const past = reminderFor(job({ status: 'designing' }), ctx({ stageSince: '2026-09-11T04:00:00Z' }));
    expect(past).toMatchObject({ days: 6, escalate: true });
  });

  it('never escalates a due-soon warning — nothing has gone wrong yet', () => {
    const found = reminderFor(job({ status: 'printing', due_date: '2026-09-18' }), ctx({
      stageSince: '2026-09-17T00:00:00Z',
      settings: settings({ escalateAfterDays: 0 }),
    }));
    expect(found).toMatchObject({ reason: 'due_soon', escalate: false });
  });
});

describe('resolveReminderSettings', () => {
  it('uses the defaults when nothing is stored', () => {
    expect(resolveReminderSettings(null)).toEqual(DEFAULT_REMINDER_SETTINGS);
  });

  it('lets a stored stage override just that stage', () => {
    const resolved = resolveReminderSettings({ stage_days: { designing: 7 } });
    expect(resolved.stageDays.designing).toBe(7);
    expect(resolved.stageDays.printing).toBe(DEFAULT_REMINDER_SETTINGS.stageDays.printing);
  });

  it('ignores a stage key it does not recognise', () => {
    const resolved = resolveReminderSettings({ stage_days: { not_a_stage: 4 } as any });
    expect((resolved.stageDays as any).not_a_stage).toBeUndefined();
  });

  it('treats a NULL column as unset, not as zero', () => {
    // Number(null) is 0, so the naive read silently disabled due-soon
    // warnings on any row that had never been saved.
    const resolved = resolveReminderSettings({ due_soon_days: null, unassigned_days: null });
    expect(resolved.dueSoonDays).toBe(DEFAULT_REMINDER_SETTINGS.dueSoonDays);
    expect(resolved.unassignedDays).toBe(DEFAULT_REMINDER_SETTINGS.unassignedDays);
  });

  it('falls back rather than throwing on a half-written row', () => {
    const resolved = resolveReminderSettings({
      due_soon_days: undefined,
      unassigned_days: -5 as any,
      escalate_after_days: 'soon' as any,
      stage_days: { designing: 'later' as any },
    });
    expect(resolved.dueSoonDays).toBe(DEFAULT_REMINDER_SETTINGS.dueSoonDays);
    expect(resolved.unassignedDays).toBe(DEFAULT_REMINDER_SETTINGS.unassignedDays);
    expect(resolved.escalateAfterDays).toBe(DEFAULT_REMINDER_SETTINGS.escalateAfterDays);
    // An unreadable stage value turns that stage off rather than guessing.
    expect(resolved.stageDays.designing).toBe(0);
  });
});

describe('buildDigest', () => {
  const line = (over: Partial<ReminderLine> & { finding: ReminderLine['finding'] }): ReminderLine => ({
    job: job(),
    ...over,
  });

  it('says nothing when there is nothing to say', () => {
    expect(buildDigest([])).toBeNull();
  });

  it('counts jobs and names each reason in the title', () => {
    const digest = buildDigest([
      line({ finding: { reason: 'overdue', days: 2, escalate: false } }),
      line({ job: job({ id: 'j2', title: 'B' }), finding: { reason: 'stalled', days: 4, escalate: false } }),
      line({ job: job({ id: 'j3', title: 'C' }), finding: { reason: 'stalled', days: 9, escalate: true } }),
    ]);
    expect(digest?.title).toBe('🔔 3 graphics jobs need attention — 1 overdue, 2 stalled');
  });

  it('uses the singular for one job', () => {
    const digest = buildDigest([line({ finding: { reason: 'overdue', days: 1, escalate: false } })]);
    expect(digest?.title).toContain('1 graphics job needs attention');
  });

  it('puts the most urgent line first, longest-running within a reason', () => {
    const digest = buildDigest([
      line({ job: job({ id: 'a', title: 'Due soon job' }), finding: { reason: 'due_soon', days: 1, escalate: false } }),
      line({ job: job({ id: 'b', title: 'Short stall' }), finding: { reason: 'stalled', days: 4, escalate: false } }),
      line({ job: job({ id: 'c', title: 'Long stall' }), finding: { reason: 'stalled', days: 11, escalate: true } }),
      line({ job: job({ id: 'd', title: 'Late one' }), finding: { reason: 'overdue', days: 2, escalate: false } }),
    ]);
    const order = digest!.body.split('\n').map(l => l.split('— ')[1]);
    expect(order[0]).toContain('Late one');
    expect(order[1]).toContain('Long stall');
    expect(order[2]).toContain('Short stall');
    expect(order[3]).toContain('Due soon job');
  });

  it('stops listing after the cap and counts the rest', () => {
    const lines = Array.from({ length: MAX_DIGEST_LINES + 4 }, (_, i) =>
      line({ job: job({ id: `j${i}`, title: `Job ${i}` }), finding: { reason: 'stalled', days: 4, escalate: false } }));
    const digest = buildDigest(lines);
    const body = digest!.body.split('\n');
    expect(body).toHaveLength(MAX_DIGEST_LINES + 1);
    expect(body[body.length - 1]).toBe('…and 4 more');
  });

  it('names who is holding a job the recipient is not holding', () => {
    const escalated = [line({ finding: { reason: 'stalled', days: 9, escalate: true }, assigneeName: 'Dana' })];
    expect(buildDigest(escalated, { escalation: true })!.body).toContain('· Dana');
    expect(buildDigest(escalated, { escalation: true })!.title).toContain('still needs attention');
  });

  it('leaves your own name off your own list', () => {
    const mine = [line({ finding: { reason: 'stalled', days: 9, escalate: true } })];
    expect(buildDigest(mine)!.body).not.toContain('·');
  });
});

describe('describeFinding', () => {
  it('reads the way someone would say it out loud', () => {
    expect(describeFinding({ reason: 'overdue', days: 3, escalate: true }, job())).toBe('Overdue 3d');
    expect(describeFinding({ reason: 'stalled', days: 4, escalate: false }, job({ status: 'designing' }))).toBe('4d in Designing');
    expect(describeFinding({ reason: 'due_soon', days: 0, escalate: false }, job())).toBe('Due today');
    expect(describeFinding({ reason: 'due_soon', days: 1, escalate: false }, job())).toBe('Due tomorrow');
    expect(describeFinding({ reason: 'due_soon', days: 2, escalate: false }, job())).toBe('Due in 2d');
    expect(describeFinding({ reason: 'unassigned', days: 2, escalate: false }, job())).toBe('Unassigned 2d');
  });
});
