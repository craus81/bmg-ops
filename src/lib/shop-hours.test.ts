import { describe, it, expect } from 'vitest';
import { shopWorkMs, shopWorkHours, isShopClockRunning, shopClockResumeLabel } from './shop-hours';

const H = 3_600_000;
const t = (iso: string) => Date.parse(iso);

describe('shopWorkHours — weekdays 7:00–3:30 Central less an 11:30–12:00 lunch', () => {
  it('counts a plain morning exactly', () => {
    // Tue 2026-10-06 8:00 → 11:00 AM CDT
    expect(shopWorkHours('2026-10-06T13:00:00Z', '2026-10-06T16:00:00Z')).toBe(3);
  });

  it('takes the lunch half hour out', () => {
    // 11:00 AM → 1:00 PM CDT = 1.5h
    expect(shopWorkHours('2026-10-06T16:00:00Z', '2026-10-06T18:00:00Z')).toBe(1.5);
  });

  it('a full day is 8 hours', () => {
    expect(shopWorkHours('2026-10-06T05:00:00Z', '2026-10-07T04:59:00Z')).toBe(8);
  });

  it('pauses at 3:30 PM and resumes at 7:00 AM', () => {
    // Tue 3:00 PM → Wed 8:00 AM CDT = 0.5 + 1
    expect(shopWorkHours('2026-10-06T20:00:00Z', '2026-10-07T13:00:00Z')).toBe(1.5);
  });

  it('counts nothing on a weekend; Friday afternoon runs to Monday morning', () => {
    // Sat 10 AM → Sun 2 PM
    expect(shopWorkHours('2026-10-10T15:00:00Z', '2026-10-11T19:00:00Z')).toBe(0);
    // Fri 3:00 PM → Mon 7:30 AM CDT = 0.5 + 0.5
    expect(shopWorkHours('2026-10-09T20:00:00Z', '2026-10-12T12:30:00Z')).toBe(1);
  });

  it('follows Central across the DST change (CST after Nov 1)', () => {
    // Mon 2026-11-02 7:00 → 9:00 AM CST = 13:00Z → 15:00Z
    expect(shopWorkHours('2026-11-02T13:00:00Z', '2026-11-02T15:00:00Z')).toBe(2);
    // 6:00–7:00 AM CST is before the shop day
    expect(shopWorkHours('2026-11-02T12:00:00Z', '2026-11-02T13:00:00Z')).toBe(0);
  });

  it('a week of running is 40 hours', () => {
    expect(shopWorkMs(t('2026-10-05T05:00:00Z'), t('2026-10-12T05:00:00Z')) / H).toBe(40);
  });

  it('is zero for an empty, backwards or invalid range', () => {
    expect(shopWorkMs(t('2026-10-06T16:00:00Z'), t('2026-10-06T16:00:00Z'))).toBe(0);
    expect(shopWorkMs(t('2026-10-06T18:00:00Z'), t('2026-10-06T16:00:00Z'))).toBe(0);
    expect(shopWorkMs(NaN, t('2026-10-06T16:00:00Z'))).toBe(0);
  });
});

describe('shop clock state for the timer card', () => {
  it('runs during the shop day and pauses otherwise', () => {
    expect(isShopClockRunning(t('2026-10-06T15:00:00Z'))).toBe(true); // Tue 10 AM
    expect(isShopClockRunning(t('2026-10-06T16:40:00Z'))).toBe(false); // lunch, 11:40
    expect(isShopClockRunning(t('2026-10-06T17:10:00Z'))).toBe(true); // 12:10, back from lunch
    expect(isShopClockRunning(t('2026-10-06T20:31:00Z'))).toBe(false); // 3:31 PM
    expect(isShopClockRunning(t('2026-10-10T15:00:00Z'))).toBe(false); // Saturday
  });

  it('says when a paused timer picks back up', () => {
    expect(shopClockResumeLabel(t('2026-10-06T15:00:00Z'))).toBeNull();
    expect(shopClockResumeLabel(t('2026-10-06T16:40:00Z'))).toBe('12:00 PM');
    expect(shopClockResumeLabel(t('2026-10-06T21:00:00Z'))).toBe('7:00 AM'); // Tue evening
    expect(shopClockResumeLabel(t('2026-10-07T10:00:00Z'))).toBe('7:00 AM'); // Wed 5 AM
    expect(shopClockResumeLabel(t('2026-10-09T21:00:00Z'))).toBe('Mon 7:00 AM'); // Fri evening
    expect(shopClockResumeLabel(t('2026-10-11T15:00:00Z'))).toBe('Mon 7:00 AM'); // Sunday
  });
});
