import { describe, it, expect } from 'vitest';
import {
  ageInvite, jobSla, SLA_HOURS, STATE_LABEL, JOB_STATE_LABEL, NEEDS_ACTION, OPEN_STATUSES,
  type InviteInput, type InviteAging,
} from './invite-sla';

const NOW = '2026-06-10T12:00:00.000Z';
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

const invite = (over: Partial<InviteInput> = {}): InviteInput => ({
  id: 'i1', jobId: 'j1', companyId: 'c1', companyName: 'Acme',
  sentAt: hoursAgo(10), seenAt: null, repingedAt: null,
  response: null, declineReason: null, respondedAt: null,
  ...over,
});

const job = (over: Partial<Parameters<typeof jobSla>[0]> = {}) => ({
  id: 'j1', jobNumber: 'CNI-1', title: 'Wrap 12 vans', status: 'bidding_open',
  deadline: '2026-07-01', alertedAt: null, ...over,
});

describe('ageInvite', () => {
  it('calls an invite with no recorded view "unseen", and says only that', () => {
    const a = ageInvite(invite(), NOW);
    expect(a.state).toBe('unseen');
    // The label is about OUR record, not their behaviour: they may have the
    // email, or have called.
    expect(STATE_LABEL.unseen).toBe('No view recorded');
  });

  it('separates opened-but-unanswered from never-opened', () => {
    expect(ageInvite(invite({ seenAt: hoursAgo(5) }), NOW).state).toBe('seen_unanswered');
  });

  it('reads the answer off the bid, whether or not the invite was ever seen', () => {
    expect(ageInvite(invite({ response: 'interested', respondedAt: hoursAgo(2) }), NOW).state).toBe('interested');
    expect(ageInvite(invite({ response: 'declined', respondedAt: hoursAgo(2) }), NOW).state).toBe('declined');
  });

  it('breaches only once past the SLA, and only while unanswered', () => {
    expect(ageInvite(invite({ sentAt: hoursAgo(SLA_HOURS - 1) }), NOW).breached).toBe(false);
    expect(ageInvite(invite({ sentAt: hoursAgo(SLA_HOURS + 1) }), NOW).breached).toBe(true);
  });

  it('never breaches an answered invite, however slow the answer was', () => {
    // The clock is for chasing, not for scoring people after the fact.
    const a = ageInvite(invite({ sentAt: hoursAgo(200), response: 'declined', respondedAt: hoursAgo(1) }), NOW);
    expect(a.breached).toBe(false);
    expect(a.hoursToRespond).toBe(199);
  });

  it('leaves time-to-respond null while unanswered', () => {
    expect(ageInvite(invite(), NOW).hoursToRespond).toBeNull();
  });

  it('never reports a negative age from a clock skew', () => {
    expect(ageInvite(invite({ sentAt: '2026-06-10T13:00:00.000Z' }), NOW).hoursOut).toBe(0);
  });

  it('survives an unparseable sent_at rather than producing NaN', () => {
    const a = ageInvite(invite({ sentAt: 'not a date' }), NOW);
    expect(a.hoursOut).toBe(0);
    expect(Number.isNaN(a.hoursOut)).toBe(false);
  });
});

describe('jobSla', () => {
  const aged = (...invites: InviteInput[]): InviteAging[] => invites.map(i => ageInvite(i, NOW));

  it('is OK the moment one company is interested, however many others are silent', () => {
    const s = jobSla(job(), aged(
      invite({ id: 'a', companyId: 'c1', response: 'interested', respondedAt: hoursAgo(1) }),
      invite({ id: 'b', companyId: 'c2', sentAt: hoursAgo(200) }),
    ));
    expect(s.state).toBe('ok');
    expect(s.interested).toBe(1);
  });

  it('is "waiting" inside the SLA', () => {
    expect(jobSla(job(), aged(invite({ sentAt: hoursAgo(5) }))).state).toBe('waiting');
  });

  it('is "late" once an unanswered invite passes the SLA', () => {
    expect(jobSla(job(), aged(invite({ sentAt: hoursAgo(SLA_HOURS + 5) }))).state).toBe('late');
  });

  it('ranks ALL DECLINED above late — knowing nobody is coming is worse than not knowing', () => {
    const s = jobSla(job(), aged(
      invite({ id: 'a', companyId: 'c1', sentAt: hoursAgo(100), response: 'declined', respondedAt: hoursAgo(90) }),
      invite({ id: 'b', companyId: 'c2', sentAt: hoursAgo(100), response: 'declined', respondedAt: hoursAgo(80) }),
    ));
    expect(s.state).toBe('all_declined');
    expect(s.declined).toBe(2);
    expect(s.unanswered).toBe(0);
  });

  it('does not call a job all-declined while anyone is still silent', () => {
    const s = jobSla(job(), aged(
      invite({ id: 'a', companyId: 'c1', response: 'declined', respondedAt: hoursAgo(1) }),
      invite({ id: 'b', companyId: 'c2', sentAt: hoursAgo(SLA_HOURS + 5) }),
    ));
    expect(s.state).toBe('late');
  });

  it('flags a job nobody was invited to at all', () => {
    const s = jobSla(job(), []);
    expect(s.state).toBe('no_invites');
    expect(s.oldestHoursOut).toBeNull();
  });

  it('reports the oldest invite age, not the newest', () => {
    const s = jobSla(job(), aged(
      invite({ id: 'a', sentAt: hoursAgo(5) }),
      invite({ id: 'b', companyId: 'c2', sentAt: hoursAgo(90) }),
    ));
    expect(s.oldestHoursOut).toBe(90);
  });

  it('counts breached invites separately from unanswered ones', () => {
    const s = jobSla(job(), aged(
      invite({ id: 'a', sentAt: hoursAgo(5) }),                 // unanswered, in SLA
      invite({ id: 'b', companyId: 'c2', sentAt: hoursAgo(90) }), // unanswered, breached
    ));
    expect(s.unanswered).toBe(2);
    expect(s.breachedInvites).toBe(1);
  });
});

describe('the states worth acting on', () => {
  it('includes the three that need a coordinator and excludes the two that do not', () => {
    expect(NEEDS_ACTION).toEqual(['late', 'all_declined', 'no_invites']);
    expect(NEEDS_ACTION).not.toContain('waiting');
    expect(NEEDS_ACTION).not.toContain('ok');
  });

  it('labels every state', () => {
    for (const v of Object.values(JOB_STATE_LABEL)) expect(v.length).toBeGreaterThan(0);
    for (const v of Object.values(STATE_LABEL)) expect(v.length).toBeGreaterThan(0);
  });

  it('only clocks jobs still looking for an installer', () => {
    // Once a company is assigned the invite clock is irrelevant.
    expect(OPEN_STATUSES).toEqual(['awaiting_assignment', 'bidding_open']);
  });
});
