import { describe, it, expect } from 'vitest';
import {
  meetDays, openSlots, chicagoInstant, meetButtonsHtml, meetButtonsText, isMeetToken, mintMeetToken, MEET_MINUTES,
} from './outreach-meet';
import { renderOutreachHtml } from './outreach-send';

describe('booking days and times', () => {
  it('starts tomorrow and skips weekends (shop time)', () => {
    // Friday 2026-10-23, 3pm Chicago.
    const days = meetDays(new Date('2026-10-23T20:00:00Z'));
    expect(days[0]).toBe('2026-10-26'); // Monday
    expect(days).not.toContain('2026-10-24');
    expect(days).not.toContain('2026-10-25');
    expect(days.length).toBe(8);
  });

  it('offers 20-minute calls 9:00 to 3:40 and skips the rep\'s busy times', () => {
    const [free] = openSlots(['2026-10-26'], []);
    expect(free.times[0]).toBe('09:00');
    expect(free.times[free.times.length - 1]).toBe('15:40');
    expect(free.times.length).toBe((16 - 9) * 60 / MEET_MINUTES);

    const [busy] = openSlots(['2026-10-26'], [
      { date: '2026-10-26', time: '10:00:00', minutes: 60 },
      { date: '2026-10-26', time: '13:10', minutes: 20 },
      { date: '2026-10-26', time: null, minutes: null }, // all-day: doesn't block
      { date: '2026-10-27', time: '09:00', minutes: 480 }, // other day
    ]);
    expect(busy.times).not.toContain('10:00');
    expect(busy.times).not.toContain('10:40');
    expect(busy.times).toContain('11:00');
    expect(busy.times).toContain('09:40');
    expect(busy.times).not.toContain('13:00');
    expect(busy.times).not.toContain('13:20');
    expect(busy.times).toContain('13:40');
  });

  it('turns shop time into the right instant across daylight time', () => {
    expect(chicagoInstant('2026-10-27', '09:00').toISOString()).toBe('2026-10-27T14:00:00.000Z'); // CDT
    expect(chicagoInstant('2026-11-10', '09:00').toISOString()).toBe('2026-11-10T15:00:00.000Z'); // CST
  });
});

describe('the email buttons', () => {
  const token = 'a'.repeat(40);
  it('has both buttons with the rep\'s first name, in html and text', () => {
    const html = meetButtonsHtml(token, 'Zach Miller');
    expect(html).toContain(`/meet/${token}"`);
    expect(html).toContain(`/meet/${token}?call=1`);
    expect(html).toContain('Have Zach call me');
    const text = meetButtonsText(token, 'Zach Miller');
    expect(text).toContain('Pick a time to talk:');
    expect(text).toContain('Have Zach call me:');
  });

  it('sits between the message and the signature', () => {
    const html = renderOutreachHtml('Hello', '<p>SIG</p>', '<div>FOOT</div>', '<div>BUTTONS</div>');
    expect(html.indexOf('Hello')).toBeLessThan(html.indexOf('BUTTONS'));
    expect(html.indexOf('BUTTONS')).toBeLessThan(html.indexOf('SIG'));
  });

  it('mints tokens the route accepts', () => {
    expect(isMeetToken(mintMeetToken())).toBe(true);
    expect(isMeetToken('xyz')).toBe(false);
  });
});
