import { describe, it, expect } from 'vitest';
import {
  summarizeHours, jobProductivity, perPersonHours, isoWeekStart,
  SHOP_UTILIZATION_WHY, FIELD_SHIFT_MAX_HOURS, FIELD_SHIFT_STALE_HOURS,
  type ShiftInput,
} from './crew-utilization';

const shift = (over: Partial<ShiftInput> = {}): ShiftInput => ({
  id: 's1', context: 'cni', cniJobId: 'j1',
  startedAt: '2026-06-01T08:00:00.000Z',
  endedAt: '2026-06-01T12:00:00.000Z',
  autoClosed: false,
  members: [{ profile_id: 'p1', added_at: null, removed_at: null }],
  ...over,
});

describe('summarizeHours', () => {
  it('multiplies duration by crew size', () => {
    const s = summarizeHours([shift({
      members: [
        { profile_id: 'p1', added_at: null, removed_at: null },
        { profile_id: 'p2', added_at: null, removed_at: null },
      ],
    })]);
    expect(s.measuredHours).toBe(8);   // 4h x 2 crew
    expect(s.shifts).toBe(1);
  });

  it('keeps auto-closed hours in their OWN bucket — they are approximate', () => {
    const s = summarizeHours([
      shift({ id: 'a' }),
      shift({ id: 'b', autoClosed: true }),
    ]);
    expect(s.measuredHours).toBe(4);
    expect(s.autoClosedHours).toBe(4);
    expect(s.totalHours).toBe(8);
    expect(s.autoClosedShifts).toBe(1);
  });

  it('gives an open shift NO hours and counts it separately', () => {
    const s = summarizeHours([shift({ endedAt: null })]);
    expect(s.totalHours).toBe(0);
    expect(s.shifts).toBe(0);
    expect(s.openShifts).toBe(1);
  });

  it('honours a member window that opened late or closed early', () => {
    const s = summarizeHours([shift({
      members: [
        { profile_id: 'p1', added_at: null, removed_at: null },              // 4h
        { profile_id: 'p2', added_at: '2026-06-01T10:00:00.000Z', removed_at: null }, // 2h
      ],
    })]);
    expect(s.measuredHours).toBe(6);
  });
});

describe('jobProductivity', () => {
  const job = (estimatedHours: number | null) =>
    ({ id: 'j1', jobNumber: 'CNI-1', title: 'T', companyName: 'Acme', status: 'in_progress', estimatedHours });

  it('computes variance against the estimate', () => {
    const p = jobProductivity(job(8), [shift()], 3);   // 4 crew-hours vs 8 estimated
    expect(p.totalHours).toBe(4);
    expect(p.variancePct).toBe(-50);
    expect(p.vehiclesCompleted).toBe(3);
    expect(p.vehiclesPerCrewHour).toBe(0.75);
  });

  it('reports variance as NULL with no estimate on file — not as 0% or infinite', () => {
    const p = jobProductivity(job(null), [shift()], 2);
    expect(p.estimatedHours).toBeNull();
    expect(p.variancePct).toBeNull();
  });

  it('treats a zero estimate as no estimate', () => {
    expect(jobProductivity(job(0), [shift()], 1).estimatedHours).toBeNull();
  });

  it('reports variance as NULL when no hours were logged — nothing to compare', () => {
    const p = jobProductivity(job(8), [], 0);
    expect(p.totalHours).toBe(0);
    expect(p.variancePct).toBeNull();
  });

  it('never divides vehicles by zero hours — that would read as an infinitely productive crew', () => {
    expect(jobProductivity(job(8), [shift({ endedAt: null })], 5).vehiclesPerCrewHour).toBeNull();
  });

  it('shows a job that ran over as a positive variance', () => {
    const p = jobProductivity(job(2), [shift()], 1);   // 4h against 2h estimated
    expect(p.variancePct).toBe(100);
  });

  it('deep-links the job rather than the CNI list', () => {
    expect(jobProductivity(job(4), [shift()], 1).url).toBe('/admin/cni/jobs/j1');
  });
});

describe('perPersonHours', () => {
  const names = new Map([['p1', 'Dana'], ['p2', 'Sam']]);

  it('splits hours per member from their own presence windows', () => {
    const rows = perPersonHours([shift({
      members: [
        { profile_id: 'p1', added_at: null, removed_at: null },
        { profile_id: 'p2', added_at: '2026-06-01T11:00:00.000Z', removed_at: null },
      ],
    })], names);
    expect(rows.map(r => [r.name, r.totalHours])).toEqual([['Dana', 4], ['Sam', 1]]);
  });

  it('breaks a person down by context so shop and field are not averaged together', () => {
    const rows = perPersonHours([
      shift({ id: 'a', context: 'field', cniJobId: null }),
      shift({ id: 'b', context: 'shop', cniJobId: null, endedAt: '2026-06-01T10:00:00.000Z' }),
    ], names);
    expect(rows[0].byContext).toEqual({ field: 4, shop: 2 });
    expect(rows[0].totalHours).toBe(6);
  });

  it('keeps a person’s auto-closed hours apart from their measured ones', () => {
    const rows = perPersonHours([
      shift({ id: 'a' }),
      shift({ id: 'b', autoClosed: true }),
    ], names);
    expect(rows[0]).toMatchObject({ measuredHours: 4, autoClosedHours: 4, totalHours: 8 });
  });

  it('names an unknown profile rather than dropping their hours', () => {
    const rows = perPersonHours([shift({ members: [{ profile_id: 'ghost', added_at: null, removed_at: null }] })], names);
    expect(rows[0].name).toBe('Unknown user');
    expect(rows[0].totalHours).toBe(4);
  });

  it('counts an open shift against the person without giving it hours', () => {
    const rows = perPersonHours([shift({ endedAt: null })], names);
    expect(rows[0]).toMatchObject({ totalHours: 0, openShifts: 1 });
  });
});

describe('isoWeekStart', () => {
  it('walks back to Monday', () => {
    expect(isoWeekStart('2026-06-03T12:00:00Z')).toBe('2026-06-01'); // Wed -> Mon
    expect(isoWeekStart('2026-06-01T00:30:00Z')).toBe('2026-06-01'); // Mon -> itself
    expect(isoWeekStart('2026-06-07T23:00:00Z')).toBe('2026-06-01'); // Sun -> that Mon
  });
});

describe('the retired shop-utilization half', () => {
  it('explains why there is no utilization percentage, naming the retirement', () => {
    expect(SHOP_UTILIZATION_WHY).toMatch(/punch clock/i);
    expect(SHOP_UTILIZATION_WHY).toMatch(/#838/);
    // It must not promise a number it cannot produce.
    expect(SHOP_UTILIZATION_WHY).not.toMatch(/\d+%/);
  });

  it('caps a field shift later than a shop one, but still caps it', () => {
    expect(FIELD_SHIFT_MAX_HOURS).toBeGreaterThan(12);
    expect(FIELD_SHIFT_STALE_HOURS).toBeGreaterThan(FIELD_SHIFT_MAX_HOURS);
  });
});
