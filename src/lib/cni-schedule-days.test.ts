import { describe, it, expect } from 'vitest';
import { scheduledDays, dayLabel } from './cni-schedule-days';

describe('scheduledDays', () => {
  it('draws every day of a multi-day job, not just the first', () => {
    const days = scheduledDays('2026-09-03', '2026-09-05', '2026-09-01', '2026-09-07');
    expect(days.map(d => d.date)).toEqual(['2026-09-03', '2026-09-04', '2026-09-05']);
  });

  it('numbers days against the WHOLE range even when the week shows a slice', () => {
    // Week starts mid-job: the visible Monday is day 3 of 4, not day 1 of 2.
    const days = scheduledDays('2026-09-05', '2026-09-08', '2026-09-07', '2026-09-13');
    expect(days).toEqual([
      { date: '2026-09-07', index: 3, total: 4 },
      { date: '2026-09-08', index: 4, total: 4 },
    ]);
  });

  it('treats a missing end as one day', () => {
    expect(scheduledDays('2026-09-03', null, '2026-09-01', '2026-09-07'))
      .toEqual([{ date: '2026-09-03', index: 1, total: 1 }]);
  });

  it('collapses reversed dates instead of hiding the job entirely', () => {
    expect(scheduledDays('2026-09-05', '2026-09-01', '2026-09-01', '2026-09-07'))
      .toEqual([{ date: '2026-09-05', index: 1, total: 1 }]);
  });

  it('is empty when the job falls outside the window', () => {
    expect(scheduledDays('2026-08-01', '2026-08-03', '2026-09-01', '2026-09-07')).toEqual([]);
  });

  it('crosses a month boundary without arithmetic drift', () => {
    const days = scheduledDays('2026-08-30', '2026-09-02', '2026-08-01', '2026-09-30');
    expect(days.map(d => d.date)).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
  });

  it('has nothing to draw without a confirmed start', () => {
    expect(scheduledDays(null, '2026-09-05', '2026-09-01', '2026-09-07')).toEqual([]);
    expect(scheduledDays('nonsense', null, '2026-09-01', '2026-09-07')).toEqual([]);
  });
});

describe('dayLabel', () => {
  it('labels a multi-day job', () => {
    expect(dayLabel({ date: '2026-09-04', index: 2, total: 3 })).toBe('Day 2 of 3');
  });

  it('stays quiet on a one-day job — "Day 1 of 1" is noise', () => {
    expect(dayLabel({ date: '2026-09-04', index: 1, total: 1 })).toBeNull();
  });
});
