import { describe, it, expect } from 'vitest';
import {
  PIPELINES, buildCycles, stageStats, bottleneck, turnaroundByMonth,
  summarizeRework, summarizeArrivals, median, p90,
  MIN_BOTTLENECK_SAMPLES, MIN_P90_SAMPLES,
  type StatusEvent,
} from './throughput';

const veh = PIPELINES.vehicles;
const gfx = PIPELINES.graphics;

const ev = (recordId: string, toStatus: string, day: string): StatusEvent =>
  ({ recordId, toStatus, at: `2026-06-${day}T12:00:00.000Z` });

describe('median / p90', () => {
  it('returns null for no samples rather than 0', () => {
    expect(median([])).toBeNull();
    expect(p90([])).toBeNull();
  });
  it('averages the middle pair on an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('uses nearest-rank for p90', () => {
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    expect(p90([5])).toBe(5);
  });
});

describe('buildCycles', () => {
  it('measures entry to the first terminal event', () => {
    const cycles = buildCycles(veh, [
      ev('v1', 'received', '01'), ev('v1', 'in_progress', '03'), ev('v1', 'complete', '06'),
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].turnaroundDays).toBe(5);
    expect(cycles[0].stageDays.received).toBe(2);
    expect(cycles[0].stageDays.in_progress).toBe(3);
  });

  it('starts a NEW cycle when a vehicle comes back — the old visit never leaks in', () => {
    const cycles = buildCycles(veh, [
      ev('v1', 'received', '01'), ev('v1', 'complete', '02'),
      // Two weeks on the customer's lot, then a re-check-in.
      ev('v1', 'checked_in', '16'), ev('v1', 'in_progress', '17'), ev('v1', 'complete', '18'),
    ]);
    expect(cycles).toHaveLength(2);
    expect(cycles[0].turnaroundDays).toBe(1);
    expect(cycles[1].turnaroundDays).toBe(2);
    // The 14 days sitting at 'complete' between visits are in NEITHER cycle.
    expect(cycles[1].stageDays.received).toBe(1);
  });

  it('counts checked_in as the received stage, not a stage of its own', () => {
    const cycles = buildCycles(veh, [
      ev('v1', 'checked_in', '01'), ev('v1', 'in_progress', '04'), ev('v1', 'shipped', '05'),
    ]);
    expect(cycles[0].stageDays.received).toBe(3);
    expect(cycles[0].stageDays.checked_in).toBeUndefined();
  });

  it('sums a stage re-entered inside one cycle', () => {
    const cycles = buildCycles(veh, [
      ev('v1', 'received', '01'),
      ev('v1', 'in_progress', '02'), ev('v1', 'stuck_parts', '03'),
      ev('v1', 'in_progress', '05'), ev('v1', 'complete', '06'),
    ]);
    expect(cycles[0].stageDays.in_progress).toBe(2);  // 1 day + 1 day
    expect(cycles[0].stageDays.stuck_parts).toBe(2);
  });

  it('abandons a cancelled cycle instead of recording it as done', () => {
    const cycles = buildCycles(gfx, [
      ev('j1', 'received', '01'), ev('j1', 'designing', '02'), ev('j1', 'cancelled', '03'),
    ]);
    expect(cycles).toHaveLength(0);
  });

  it('lets a cancelled record start a fresh cycle afterwards', () => {
    const cycles = buildCycles(gfx, [
      ev('j1', 'received', '01'), ev('j1', 'cancelled', '02'),
      ev('j1', 'received', '03'), ev('j1', 'shipped', '05'),
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].turnaroundDays).toBe(2);
  });

  it('ignores an open cycle with no terminal event', () => {
    expect(buildCycles(veh, [ev('v1', 'received', '01'), ev('v1', 'in_progress', '02')])).toHaveLength(0);
  });

  it('drops a cycle whose history is impossible rather than poisoning the median', () => {
    const cycles = buildCycles(veh, [
      { recordId: 'v1', toStatus: 'received', at: '2026-06-10T00:00:00.000Z' },
      // Terminal three years later — a data error, not a three-year job.
      { recordId: 'v1', toStatus: 'complete', at: '2029-06-10T00:00:00.000Z' },
    ]);
    expect(cycles).toHaveLength(0);
  });

  it('handles events arriving out of order', () => {
    const cycles = buildCycles(veh, [
      ev('v1', 'complete', '06'), ev('v1', 'received', '01'), ev('v1', 'in_progress', '03'),
    ]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].turnaroundDays).toBe(5);
  });
});

describe('stageStats / bottleneck', () => {
  const cyclesWith = (n: number, stage: string, days: number) =>
    Array.from({ length: n }, (_, i) => ({
      recordId: `r${i}`, startedAt: '', endedAt: '', turnaroundDays: days,
      stageDays: { [stage]: days }, closedBy: null,
    }));

  it('never invents a dwell for a stage nothing passed through', () => {
    const stats = stageStats(veh, cyclesWith(4, 'in_progress', 2));
    expect(stats.map(s => s.stage)).toEqual(['in_progress']);
    expect(stats.find(s => s.stage === 'stuck_parts')).toBeUndefined();
  });

  it('withholds p90 below the sample floor rather than printing the max', () => {
    const thin = stageStats(veh, cyclesWith(MIN_P90_SAMPLES - 1, 'in_progress', 2));
    expect(thin[0].p90Days).toBeNull();
    expect(thin[0].samples).toBe(MIN_P90_SAMPLES - 1);
    const thick = stageStats(veh, cyclesWith(MIN_P90_SAMPLES, 'in_progress', 2));
    expect(thick[0].p90Days).not.toBeNull();
  });

  it('refuses to crown a bottleneck on too few cycles', () => {
    const slowButThin = [
      ...cyclesWith(MIN_BOTTLENECK_SAMPLES - 1, 'stuck_parts', 40),
      ...cyclesWith(MIN_BOTTLENECK_SAMPLES + 2, 'in_progress', 3),
    ];
    const stats = stageStats(veh, slowButThin);
    // stuck_parts is slower, but one stuck vehicle must not crown a stage.
    expect(stats[0].stage).toBe('stuck_parts');
    expect(bottleneck(stats)?.stage).toBe('in_progress');
  });

  it('returns no bottleneck at all when nothing clears the floor', () => {
    expect(bottleneck(stageStats(veh, cyclesWith(1, 'in_progress', 9)))).toBeNull();
  });
});

describe('turnaroundByMonth', () => {
  it('buckets by the month the cycle CLOSED, on the shop calendar', () => {
    const points = turnaroundByMonth([
      { recordId: 'a', startedAt: '', endedAt: '2026-06-20T12:00:00Z', turnaroundDays: 4, stageDays: {}, closedBy: null },
      { recordId: 'b', startedAt: '', endedAt: '2026-07-02T12:00:00Z', turnaroundDays: 8, stageDays: {}, closedBy: null },
      { recordId: 'c', startedAt: '', endedAt: '2026-07-20T12:00:00Z', turnaroundDays: 6, stageDays: {}, closedBy: null },
    ]);
    expect(points.map(p => p.month)).toEqual(['2026-06', '2026-07']);
    expect(points[1]).toMatchObject({ medianDays: 7, completions: 2 });
  });

  it('uses Chicago months, not UTC — a late-evening close stays in its own month', () => {
    // 2026-08-01T03:00Z is 10pm July 31 in Chicago.
    const points = turnaroundByMonth([
      { recordId: 'a', startedAt: '', endedAt: '2026-08-01T03:00:00Z', turnaroundDays: 2, stageDays: {}, closedBy: null },
    ]);
    expect(points[0].month).toBe('2026-07');
  });
});

describe('summarizeRework', () => {
  it('counts a backward transition and groups its typed reason', () => {
    const s = summarizeRework(veh, [
      { recordId: 'v1', fromStatus: 'received', toStatus: 'in_progress' },
      { recordId: 'v1', fromStatus: 'complete', toStatus: 'in_progress', note: 'Customer found a defect' },
      { recordId: 'v2', fromStatus: 'complete', toStatus: 'in_progress', note: 'customer found a defect' },
    ]);
    expect(s.events).toBe(2);
    expect(s.affectedRecords).toBe(2);
    expect(s.totalRecords).toBe(2);
    expect(s.rows[0].label).toBe('Complete → In progress');
    // Case-insensitive grouping — the same reason typed twice is one reason.
    expect(s.rows[0].reasons).toEqual([{ reason: 'Customer found a defect', count: 2 }]);
  });

  it('does not treat a move between peer stages as going backwards', () => {
    const s = summarizeRework(veh, [
      { recordId: 'v1', fromStatus: 'in_progress', toStatus: 'stuck_parts' },
      { recordId: 'v1', fromStatus: 'stuck_parts', toStatus: 'in_progress' },
    ]);
    expect(s.events).toBe(0);
  });

  it('counts a graphics revision as rework even though it ties with designing on rank', () => {
    const s = summarizeRework(gfx, [
      { recordId: 'j1', fromStatus: 'designing', toStatus: 'revision', note: 'wrong phone number' },
      { recordId: 'j2', fromStatus: 'printing', toStatus: 'revision' },
    ]);
    expect(s.events).toBe(2);
    expect(s.rows.find(r => r.from === 'designing')?.reasons[0].reason).toBe('wrong phone number');
    expect(s.rows.find(r => r.from === 'printing')?.withoutReason).toBe(1);
  });

  it('reports how many rework events carried no reason instead of implying all were typed', () => {
    const s = summarizeRework(veh, [
      { recordId: 'v1', fromStatus: 'complete', toStatus: 'in_progress' },
      { recordId: 'v2', fromStatus: 'complete', toStatus: 'in_progress', note: '  ' },
      { recordId: 'v3', fromStatus: 'complete', toStatus: 'in_progress', note: 'redo' },
    ]);
    expect(s.rows[0].withoutReason).toBe(2);
    expect(s.rows[0].count).toBe(3);
  });

  it('ignores a transition into a status the pipeline does not know', () => {
    const s = summarizeRework(veh, [{ recordId: 'v1', fromStatus: 'complete', toStatus: 'mystery' }]);
    expect(s.events).toBe(0);
  });

  it('never counts a cancel as rework', () => {
    const s = summarizeRework(gfx, [{ recordId: 'j1', fromStatus: 'printing', toStatus: 'cancelled' }]);
    expect(s.events).toBe(0);
  });
});

describe('summarizeArrivals', () => {
  it('splits early / on-day / late and reports the median slip', () => {
    const a = summarizeArrivals([
      { expectedDate: '2026-06-10', arrivedDay: '2026-06-10' },
      { expectedDate: '2026-06-10', arrivedDay: '2026-06-12' },
      { expectedDate: '2026-06-10', arrivedDay: '2026-06-09' },
      { expectedDate: '2026-06-10', arrivedDay: '2026-06-14' },
    ]);
    expect(a).toMatchObject({ samples: 4, onDay: 1, early: 1, late: 2 });
    expect(a.medianDaysLate).toBe(1);   // median of [-1, 0, 2, 4]
  });

  it('counts an arrival with no forecast separately — it is not "on time"', () => {
    const a = summarizeArrivals([
      { expectedDate: null, arrivedDay: '2026-06-10' },
      { expectedDate: '2026-06-10', arrivedDay: '2026-06-10' },
    ]);
    expect(a.samples).toBe(1);
    expect(a.onDay).toBe(1);
    expect(a.noForecast).toBe(1);
  });

  it('counts an arrival with no trustworthy arrival stamp separately, never as on-time', () => {
    const a = summarizeArrivals([
      { expectedDate: '2026-06-10', arrivedDay: null },
      { expectedDate: '2026-06-10', arrivedDay: '2026-06-10' },
    ]);
    expect(a.samples).toBe(1);
    expect(a.onDay).toBe(1);
    expect(a.noArrivalStamp).toBe(1);
    // The unstamped row must not have been folded into any timing bucket.
    expect(a.early + a.onDay + a.late).toBe(a.samples);
  });

  it('returns a null median rather than 0 when there is nothing to measure', () => {
    expect(summarizeArrivals([]).medianDaysLate).toBeNull();
  });
});

describe('the pipeline registry', () => {
  it('ranks every stage, entry and terminal status it declares', () => {
    for (const def of Object.values(PIPELINES)) {
      for (const s of [...def.stages, ...def.entry, ...def.terminal, ...def.reworkStates]) {
        expect(def.rank[s], `${def.key}: ${s} has no rank`).toBeDefined();
      }
    }
  });

  it('never lists a terminal status as a measurable stage', () => {
    for (const def of Object.values(PIPELINES)) {
      for (const t of def.terminal) expect(def.stages).not.toContain(t);
    }
  });

  it('ranks terminal statuses above every stage', () => {
    for (const def of Object.values(PIPELINES)) {
      const maxStage = Math.max(...def.stages.map(s => def.rank[s]));
      for (const t of def.terminal) expect(def.rank[t]).toBeGreaterThan(maxStage - 1);
    }
  });
});
