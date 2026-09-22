import { describe, it, expect } from 'vitest';
import {
  formatAddress, sequenceFor, changedAt, jobEvents, buildDescription, buildFeed, shiftDate,
  type FeedJob,
} from './cni-schedule-feed';

const BASE = 'https://ops.example.com';

const job = (over: Partial<FeedJob> = {}): FeedJob => ({
  id: '11111111-1111-1111-1111-111111111111',
  job_number: 'CNI-1042',
  title: 'Transit graphics — 6 vans',
  customer_name: 'Acme Fleet',
  status: 'scheduled_confirmed',
  deadline: '2026-09-20',
  confirmed_schedule_start: '2026-09-03',
  confirmed_schedule_end: '2026-09-05',
  updated_at: '2026-09-01T12:00:00Z',
  address: { street: '400 Industrial Way', city: 'Springfield', state: 'IL', zip: '62704' },
  site_contact_name: 'Dana Ruiz',
  site_contact_phone: '(555) 010-8842',
  vinCount: 6,
  ...over,
});

describe('formatAddress', () => {
  it('assembles a one-line address', () => {
    expect(formatAddress({ street: '400 Industrial Way', city: 'Springfield', state: 'IL', zip: '62704' }))
      .toBe('400 Industrial Way, Springfield, IL 62704');
  });

  it('drops the pieces that are missing instead of leaving punctuation holes', () => {
    expect(formatAddress({ city: 'Springfield', state: 'IL' })).toBe('Springfield, IL');
    expect(formatAddress({ street: '400 Industrial Way' })).toBe('400 Industrial Way');
  });

  it('is null when there is no address — a LOCATION of ", ," is worse than none', () => {
    expect(formatAddress(null)).toBeNull();
    expect(formatAddress({})).toBeNull();
    expect(formatAddress({ street: '  ', city: '' })).toBeNull();
  });
});

describe('sequenceFor', () => {
  it('rises with updated_at so a client accepts the newer copy', () => {
    const a = sequenceFor('2026-09-01T12:00:00Z');
    const b = sequenceFor('2026-09-01T12:05:00Z');
    expect(b).toBeGreaterThan(a);
  });

  it('stays inside the 32-bit range clients assume', () => {
    expect(sequenceFor('2036-01-01T00:00:00Z')).toBeLessThan(2 ** 31 - 1);
  });

  it('is 0 for an unknown or pre-epoch timestamp rather than NaN', () => {
    expect(sequenceFor(null)).toBe(0);
    expect(sequenceFor('not a date')).toBe(0);
    expect(sequenceFor('1999-01-01T00:00:00Z')).toBe(0);
  });
});

describe('changedAt', () => {
  it('prefers schedule_confirmed_at — updated_at has no trigger behind it and is really the creation time', () => {
    expect(changedAt(job({ updated_at: '2026-09-01T12:00:00Z', schedule_confirmed_at: '2026-09-02T09:00:00Z' })))
      .toBe('2026-09-02T09:00:00.000Z');
  });

  it('takes the later stamp, so it improves on its own if updated_at is ever maintained', () => {
    expect(changedAt(job({ updated_at: '2026-09-04T08:00:00Z', schedule_confirmed_at: '2026-09-02T09:00:00Z' })))
      .toBe('2026-09-04T08:00:00.000Z');
  });

  it('is null rather than "now" when nothing is on record — a made-up LAST-MODIFIED is a claim', () => {
    expect(changedAt(job({ updated_at: null, schedule_confirmed_at: null }))).toBeNull();
    expect(changedAt(job({ updated_at: 'garbage', schedule_confirmed_at: null }))).toBeNull();
  });

  it('leaves the event without a LAST-MODIFIED line when it is unknown', () => {
    const { ics } = buildFeed([job({ updated_at: null, schedule_confirmed_at: null })], { companyName: 'R', base: BASE });
    expect(ics).not.toContain('LAST-MODIFIED');
    expect(ics).toContain('SEQUENCE:0');
  });
});

describe('jobEvents — a confirmed schedule', () => {
  it('books the confirmed range, not the deadline', () => {
    const [e] = jobEvents(job(), BASE);
    expect(e.start).toBe('2026-09-03');
    expect(e.end).toBe('2026-09-05');
    expect(e.status).toBe('CONFIRMED');
    expect(e.transparent).toBeFalsy();
  });

  it('NEVER publishes a proposed date — nobody has agreed to it yet', () => {
    const proposed = job({ confirmed_schedule_start: null, confirmed_schedule_end: null, deadline: null });
    (proposed as any).proposed_schedule_start = '2026-09-03';
    expect(jobEvents(proposed, BASE)).toEqual([]);
  });

  it('treats a missing end as a one-day job', () => {
    const [e] = jobEvents(job({ confirmed_schedule_end: null }), BASE);
    expect(e.start).toBe('2026-09-03');
    expect(e.end).toBe('2026-09-03');
  });

  it('collapses an end BEFORE the start instead of emitting an event clients drop', () => {
    const [e] = jobEvents(job({ confirmed_schedule_end: '2026-09-01' }), BASE);
    expect(e.end).toBe('2026-09-03');
  });

  it('keeps finished work on the calendar — a week that empties itself looks broken', () => {
    expect(jobEvents(job({ status: 'approved_closed' }), BASE)).toHaveLength(1);
  });

  it('carries the site address as LOCATION and the job deep link as URL', () => {
    const [e] = jobEvents(job(), BASE);
    expect(e.location).toBe('400 Industrial Way, Springfield, IL 62704');
    expect(e.url).toBe(`${BASE}/installer/jobs/11111111-1111-1111-1111-111111111111`);
  });
});

describe('jobEvents — assigned work with no agreed date', () => {
  const unscheduled = job({
    status: 'assigned_awaiting_scheduling',
    confirmed_schedule_start: null,
    confirmed_schedule_end: null,
  });

  it('marks the deadline so the job that quietly slides is visible', () => {
    const [e] = jobEvents(unscheduled, BASE);
    expect(e.start).toBe('2026-09-20');
    expect(e.end).toBe('2026-09-20');
  });

  it('cannot be mistaken for a booked day: tentative, free, and it says so', () => {
    const [e] = jobEvents(unscheduled, BASE);
    expect(e.status).toBe('TENTATIVE');
    expect(e.transparent).toBe(true);
    expect(e.summary).toContain('no install date set');
  });

  it('uses a DIFFERENT uid, so confirming dates retires the marker instead of renaming it', () => {
    const [marker] = jobEvents(unscheduled, BASE);
    const [real] = jobEvents(job(), BASE);
    expect(marker.uid).not.toBe(real.uid);
    expect(real.uid).toBe('cni-11111111-1111-1111-1111-111111111111@bmgfleet.com');
  });

  it('carries no LOCATION — nobody drives to the site on its deadline', () => {
    const [e] = jobEvents(unscheduled, BASE);
    expect(e.location).toBeUndefined();
    // …but the address is still readable in the body.
    expect(e.description).toContain('400 Industrial Way');
  });

  it('says nothing at all when there is no deadline either — a made-up date is worse than a gap', () => {
    expect(jobEvents(job({ confirmed_schedule_start: null, deadline: null }), BASE)).toEqual([]);
  });

  it('drops the marker once the work is done', () => {
    expect(jobEvents({ ...unscheduled, status: 'completed_pending_review' }, BASE)).toEqual([]);
    expect(jobEvents({ ...unscheduled, status: 'approved_closed' }, BASE)).toEqual([]);
  });
});

describe('buildDescription', () => {
  it('carries what a crew needs before they can open a laptop', () => {
    const d = buildDescription(job(), BASE);
    expect(d).toContain('Job CNI-1042');
    expect(d).toContain('Customer: Acme Fleet');
    expect(d).toContain('6 vehicles');
    expect(d).toContain('Site: 400 Industrial Way, Springfield, IL 62704');
    expect(d).toContain('Site contact: Dana Ruiz — (555) 010-8842');
    expect(d).toContain('Customer deadline: 2026-09-20');
    expect(d).toContain(`${BASE}/installer/jobs/`);
  });

  it('never publishes the site contact’s email to an unauthenticated feed', () => {
    const d = buildDescription({ ...job(), site_contact_email: 'dana@acme.example' } as FeedJob, BASE);
    expect(d).not.toContain('dana@acme.example');
  });

  it('omits the vehicle count when it is unknown rather than printing 0 vehicles', () => {
    const d = buildDescription(job({ vinCount: null }), BASE);
    expect(d).not.toMatch(/vehicles?/);
  });

  it('says 1 vehicle, not 1 vehicles', () => {
    expect(buildDescription(job({ vinCount: 1 }), BASE)).toContain('1 vehicle\n');
  });
});

describe('buildFeed', () => {
  it('produces a calendar a client will accept', () => {
    const { ics } = buildFeed([job()], { companyName: 'Ridgeline Installs', base: BASE, now: '2026-09-02T00:00:00Z' });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('X-WR-CALNAME:BMG installs — Ridgeline Installs');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260903');
    // The 5th inclusive is the 6th exclusive — off by one and every job in
    // the crew's calendar is a day short.
    expect(ics).toContain('DTEND;VALUE=DATE:20260906');
  });

  it('counts booked days and unscheduled markers apart', () => {
    const { counts } = buildFeed(
      [job(), job({ id: '22222222-2222-2222-2222-222222222222', status: 'assigned_awaiting_scheduling', confirmed_schedule_start: null, confirmed_schedule_end: null })],
      { companyName: 'Ridgeline', base: BASE },
    );
    expect(counts).toEqual({ scheduled: 1, unscheduled: 1, jobs: 2 });
  });

  it('escapes a comma in a job title instead of splitting the SUMMARY', () => {
    const { ics } = buildFeed([job({ title: 'Vans, trucks, one box' })], { companyName: 'Ridgeline', base: BASE });
    expect(ics).toContain('Vans\\, trucks\\, one box');
  });

  it('is still a valid empty calendar when the company has no work', () => {
    const { ics } = buildFeed([], { companyName: 'Ridgeline', base: BASE });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});

describe('shiftDate', () => {
  it('walks the window bounds in whole days', () => {
    const now = new Date('2026-09-10T18:30:00Z');
    expect(shiftDate(now, -90)).toBe('2026-06-12');
    expect(shiftDate(now, 365)).toBe('2027-09-10');
  });
});
