import { describe, it, expect } from 'vitest';
import { generateSlots, sanitizeBookingSettings, DEFAULT_BOOKING_SETTINGS } from './booking';

// 2026-09-07 is a Monday.
const settings = { ...DEFAULT_BOOKING_SETTINGS, leadDays: 1, horizonDays: 7, startHour: 8, endHour: 10, slotMinutes: 60, maxPerDay: 2 };

describe('generateSlots', () => {
  it('starts at today+leadDays, skips weekends, and steps business hours', () => {
    const slots = generateSlots(settings, '2026-09-11', []); // Friday
    // Lead 1 → Saturday 9/12 skipped, Sunday skipped; first day is Monday 9/14.
    expect(slots[0].day).toBe('2026-09-14');
    expect(slots[0].times).toEqual(['08:00', '09:00']);
  });

  it('removes taken slots and drops full days entirely (maxPerDay)', () => {
    const taken = [
      { slot_date: '2026-09-08', slot_time: '08:00:00' },
      { slot_date: '2026-09-09', slot_time: '08:00:00' },
      { slot_date: '2026-09-09', slot_time: '09:00:00' },
    ];
    const slots = generateSlots(settings, '2026-09-07', taken);
    const byDay = Object.fromEntries(slots.map(s => [s.day, s.times]));
    expect(byDay['2026-09-08']).toEqual(['09:00']); // one slot gone
    expect(byDay['2026-09-09']).toBeUndefined(); // day at maxPerDay
  });

  it('honors blocked dates and lets a reschedule keep its own slot', () => {
    const blocked = { ...settings, blockedDates: ['2026-09-08'] };
    const taken = [{ slot_date: '2026-09-09', slot_time: '08:00:00' }];
    const withIgnore = generateSlots(blocked, '2026-09-07', taken, { slot_date: '2026-09-09', slot_time: '08:00:00' });
    const byDay = Object.fromEntries(withIgnore.map(s => [s.day, s.times]));
    expect(byDay['2026-09-08']).toBeUndefined(); // blocked
    expect(byDay['2026-09-09']).toContain('08:00'); // own slot stays offered
  });
});

describe('sanitizeBookingSettings', () => {
  it('falls back to defaults on garbage and clamps bounds', () => {
    expect(sanitizeBookingSettings(null)).toEqual(DEFAULT_BOOKING_SETTINGS);
    const s = sanitizeBookingSettings({ startHour: 22, endHour: 5, slotMinutes: 7, maxPerDay: 9999, businessDays: [0, 8, 3], blockedDates: ['nope', '2026-12-25'] });
    expect(s.endHour).toBeGreaterThan(s.startHour); // end forced past start
    expect(s.slotMinutes).toBe(60); // unknown length → default
    expect(s.maxPerDay).toBe(50);
    expect(s.businessDays).toEqual([3]); // only the valid ISO weekday survives
    expect(s.blockedDates).toEqual(['2026-12-25']);
  });
});
