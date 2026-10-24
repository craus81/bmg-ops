import { describe, it, expect, vi } from 'vitest';

vi.mock('./notify', () => ({ notifyMany: vi.fn() }));
import { isInstalledJob, needsInstallDate, longDate } from './install-scheduling-state';
import { buildInstallConfirmation, installPlace } from './install-scheduling';

describe('which jobs need an install date', () => {
  const base = { customer_approved: true, delivery_method: 'onsite_install', status: 'printing', scheduled_install_date: null };

  it('approved onsite and shop jobs with no date', () => {
    expect(needsInstallDate(base)).toBe(true);
    expect(needsInstallDate({ ...base, delivery_method: 'bmg_shop' })).toBe(true);
  });

  it('skips shipped and picked-up work', () => {
    expect(needsInstallDate({ ...base, delivery_method: 'direct_ship' })).toBe(false);
    expect(needsInstallDate({ ...base, delivery_method: 'customer_pickup' })).toBe(false);
    expect(needsInstallDate({ ...base, delivery_method: null })).toBe(false);
  });

  it('drops off once a date is set, before approval, and when finished', () => {
    expect(needsInstallDate({ ...base, scheduled_install_date: '2026-11-04' })).toBe(false);
    expect(needsInstallDate({ ...base, customer_approved: false })).toBe(false);
    expect(needsInstallDate({ ...base, status: 'installed' })).toBe(false);
    expect(needsInstallDate({ ...base, status: 'cancelled' })).toBe(false);
    expect(isInstalledJob({ ...base, status: 'shipped' })).toBe(false);
  });
});

describe('install confirmation', () => {
  const job = {
    id: 'job-1',
    title: 'Escape Wrap',
    customer: 'St. Charles Regional Chamber',
    delivery_method: 'bmg_shop',
    scheduled_install_date: '2026-11-04',
    install_arrival_time: '8:00 AM',
  };

  it('prints the date without timezone drift', () => {
    expect(longDate('2026-11-04')).toBe('Wednesday, November 4, 2026');
  });

  it('says where: our shop address, or the delivery address on one line', () => {
    expect(installPlace(job)).toMatch(/O'Fallon, MO/);
    expect(installPlace({ ...job, delivery_method: 'onsite_install', ship_to: '12 Main St\nSt. Charles, MO 63301' }))
      .toBe('12 Main St, St. Charles, MO 63301');
    expect(installPlace({ ...job, delivery_method: 'onsite_install', ship_to: null })).toBe('Your site');
  });

  it('builds subject, body, calendar link and file', () => {
    const c = buildInstallConfirmation(job, 'https://go.bmgfleet.com/');
    expect(c.subject).toBe('Install confirmed: Wed, Nov 4 at 8:00 AM, Escape Wrap');
    expect(c.body).toContain('Wednesday, November 4, 2026, drop-off 8:00 AM.');
    expect(c.body).toContain('bring the vehicle to our shop');
    expect(c.googleUrl).toContain('dates=20261104/20261105');
    const ics = c.ics.content.toString('utf-8');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261104');
    expect(ics).toContain('DTEND;VALUE=DATE:20261105');
    expect(c.ics.contentType).toBe('text/calendar');
    expect(c.appLink).toBe('https://go.bmgfleet.com/graphics/job-1');
  });

  it('onsite wording and no time', () => {
    const c = buildInstallConfirmation({ ...job, delivery_method: 'onsite_install', install_arrival_time: null, ship_to: '12 Main St' }, 'https://x');
    expect(c.subject).toBe('Install confirmed: Wed, Nov 4, Escape Wrap');
    expect(c.body).toContain('Our installer will meet you there.');
  });
});
