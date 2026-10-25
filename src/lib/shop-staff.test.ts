import { describe, it, expect } from 'vitest';
import { dayCapacity, rosterCovers, normalizeStaff, isoWeekday, type ShopStaff, type StaffTimeOff } from './shop-staff';

const person = (over: Partial<ShopStaff>): ShopStaff => ({
  id: 'x', name: 'X', department: 'upfit', hours_per_day: 8, work_days: [1, 2, 3, 4, 5], active: true, ...over,
});

const roster: ShopStaff[] = [
  person({ id: 'a', name: 'Alex' }),
  person({ id: 'b', name: 'Blake' }),
  person({ id: 'c', name: 'Casey', hours_per_day: 10, work_days: [1, 2, 3, 4] }),
  person({ id: 'g', name: 'Gray', department: 'graphics_install' }),
  person({ id: 'z', name: 'Zed (left)', active: false }),
];

// 2026-10-26 is a Monday, 2026-10-30 a Friday, 2026-10-31 a Saturday.
describe('dayCapacity', () => {
  it('sums normal hours per department for everyone scheduled that weekday', () => {
    expect(isoWeekday('2026-10-26')).toBe(1);
    const mon = dayCapacity(roster, [], '2026-10-26');
    expect(mon.hours).toEqual({ upfit: 26, graphics_install: 8 });
    expect(mon.out).toEqual([]);
  });

  it('drops people not scheduled that weekday, and inactive people entirely', () => {
    expect(dayCapacity(roster, [], '2026-10-30').hours.upfit).toBe(16); // Casey works Mon–Thu
    expect(dayCapacity(roster, [], '2026-10-31').hours).toEqual({ upfit: 0, graphics_install: 0 });
  });

  it('takes whole and partial days off, and lists who is out', () => {
    const off: StaffTimeOff[] = [
      { id: '1', staff_id: 'a', day: '2026-10-26', hours: null, note: 'Vacation' },
      { id: '2', staff_id: 'c', day: '2026-10-26', hours: 4, note: null },
      { id: '3', staff_id: 'g', day: '2026-10-27', hours: null, note: null }, // other day
    ];
    const mon = dayCapacity(roster, off, '2026-10-26');
    expect(mon.hours).toEqual({ upfit: 14, graphics_install: 8 });
    expect(mon.out.map(o => [o.name, o.hours])).toEqual([['Alex', 8], ['Casey', 4]]);
  });

  it('never takes off more than the person works, and ignores time off on a day they are not scheduled', () => {
    const off: StaffTimeOff[] = [
      { id: '1', staff_id: 'b', day: '2026-10-26', hours: 12, note: null },
      { id: '2', staff_id: 'c', day: '2026-10-30', hours: null, note: null }, // Casey is off Fridays anyway
    ];
    expect(dayCapacity(roster, off, '2026-10-26').hours.upfit).toBe(18);
    const fri = dayCapacity(roster, off, '2026-10-30');
    expect(fri.hours.upfit).toBe(16);
    expect(fri.out).toEqual([]);
  });
});

describe('rosterCovers', () => {
  it('needs at least one active person in the department', () => {
    expect(rosterCovers(roster, 'upfit')).toBe(true);
    expect(rosterCovers([person({ active: false })], 'upfit')).toBe(false);
    expect(rosterCovers([person({})], 'graphics_install')).toBe(false);
  });
});

describe('normalizeStaff', () => {
  it('cleans work days and falls back to safe values', () => {
    const s = normalizeStaff({ id: '1', name: ' Pat ', department: 'nonsense', hours_per_day: '7.5', work_days: [5, 1, 1, 9, '3'] });
    expect(s).toEqual({ id: '1', name: 'Pat', department: 'upfit', hours_per_day: 7.5, work_days: [1, 3, 5], active: true });
  });
});
