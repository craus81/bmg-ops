import { describe, it, expect } from 'vitest';
import {
  tokenLive,
  sortActions,
  withinWindow,
  buildEstimateAction,
  buildQuoteAction,
  buildProofAction,
  EXPIRED_WINDOW_DAYS,
  type PortalAction,
} from './portal-actions';

const NOW = Date.parse('2026-09-11T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

describe('tokenLive', () => {
  it('is live with a token and a future expiry', () => {
    expect(tokenLive('tok', daysAhead(5), NOW)).toBe(true);
  });
  it('is dead once the expiry has passed', () => {
    expect(tokenLive('tok', daysAgo(1), NOW)).toBe(false);
  });
  it('treats a missing token as dead even with no expiry', () => {
    expect(tokenLive(null, null, NOW)).toBe(false);
    expect(tokenLive('', daysAhead(5), NOW)).toBe(false);
  });
  it('treats a token with no expiry as live — nothing has lapsed', () => {
    expect(tokenLive('tok', null, NOW)).toBe(true);
  });
  it('does not go dead on an unparseable expiry', () => {
    // Garbage in the column is not evidence the link lapsed; the approve
    // route is the authority and will refuse if it truly has.
    expect(tokenLive('tok', 'not-a-date', NOW)).toBe(true);
  });
});

describe('buildEstimateAction', () => {
  const row = {
    id: 'e1',
    estimate_number: 'EST-2609-014',
    title: 'Ladder racks',
    grand_total: '4850.00',
    sent_for_approval_at: daysAgo(4),
    approval_reminder_sent_at: daysAgo(1),
    approval_token: 'tok-1',
    approval_token_expires_at: daysAhead(26),
  };

  it('awaits with a clickable link while the token is live', () => {
    const a = buildEstimateAction(row, NOW);
    expect(a.state).toBe('awaiting');
    expect(a.approveUrl).toBe('/approve/estimate/tok-1');
    expect(a.total).toBe(4850);
    expect(a.ref).toBe('Estimate #EST-2609-014');
    expect(a.remindedAt).toBe(row.approval_reminder_sent_at);
  });

  it('NEVER carries a URL once the link is dead', () => {
    // The whole contract of approveUrl: a URL here promises the click works.
    const a = buildEstimateAction({ ...row, approval_token_expires_at: daysAgo(2) }, NOW);
    expect(a.state).toBe('expired');
    expect(a.approveUrl).toBeNull();
  });

  it('reports an absent total as unknown, not as zero', () => {
    const a = buildEstimateAction({ ...row, grand_total: null }, NOW);
    expect(a.total).toBeNull();
  });

  it('keeps a real zero total', () => {
    const a = buildEstimateAction({ ...row, grand_total: 0 }, NOW);
    expect(a.total).toBe(0);
  });
});

describe('buildQuoteAction', () => {
  it('reads the wrap-quote column names, not the estimate ones', () => {
    const a = buildQuoteAction({
      id: 'q1',
      quote_number: 'WQ-118',
      vehicle_description: '2024 Transit 250',
      total: 7200,
      sent_at: daysAgo(9),
      last_followup_at: daysAgo(2),
      approval_token: 'tok-q',
      approval_token_expires_at: daysAhead(21),
    }, NOW);
    expect(a.kind).toBe('quote');
    expect(a.ref).toBe('Wrap quote WQ-118');
    expect(a.title).toBe('2024 Transit 250');
    expect(a.sentAt).toBe(daysAgo(9));
    expect(a.remindedAt).toBe(daysAgo(2));
    expect(a.approveUrl).toBe('/approve/quote/tok-q');
  });
});

describe('buildProofAction', () => {
  const row = {
    id: 'j1',
    job_number: '4471',
    title: 'Box truck wrap',
    sent_for_approval_at: daysAgo(6),
    approval_reminder_sent_at: null,
    approval_token: 'tok-p',
    approval_token_expires_at: daysAhead(24),
  };

  it('carries no price at all — a proof has none of its own', () => {
    const a = buildProofAction(row, NOW);
    // Not 0: zero would render as "free" beside two priced rows.
    expect(a.total).toBeNull();
    expect(a.approveUrl).toBe('/approve/proof/tok-p');
    expect(a.ref).toBe('Job 4471');
  });

  it('falls back to a generic ref when the job has no number', () => {
    expect(buildProofAction({ ...row, job_number: null }, NOW).ref).toBe('Artwork proof');
  });
});

describe('withinWindow', () => {
  const mk = (state: PortalAction['state'], sentAt: string | null): PortalAction => ({
    kind: 'estimate', id: 'x', ref: 'r', title: null, sentAt, remindedAt: null,
    expiresAt: null, total: null, state, approveUrl: null, kindLabel: 'Estimate', actionLabel: 'Review',
  });

  it('never drops a live approval, however old the send', () => {
    expect(withinWindow(mk('awaiting', daysAgo(400)), NOW)).toBe(true);
  });
  it('keeps a recently dead link — that is what the fresh-link button is for', () => {
    expect(withinWindow(mk('expired', daysAgo(EXPIRED_WINDOW_DAYS - 1)), NOW)).toBe(true);
  });
  it('drops a dead link older than the window', () => {
    expect(withinWindow(mk('expired', daysAgo(EXPIRED_WINDOW_DAYS + 1)), NOW)).toBe(false);
  });
  it('drops an expired entry with no send date rather than guessing it is recent', () => {
    expect(withinWindow(mk('expired', null), NOW)).toBe(false);
  });
});

describe('sortActions', () => {
  const mk = (id: string, state: PortalAction['state'], sentAt: string): PortalAction => ({
    kind: 'estimate', id, ref: id, title: null, sentAt, remindedAt: null,
    expiresAt: null, total: null, state, approveUrl: null, kindLabel: 'Estimate', actionLabel: 'Review',
  });

  it('puts every actionable row above every dead one', () => {
    const out = sortActions([
      mk('dead-old', 'expired', daysAgo(50)),
      mk('live-new', 'awaiting', daysAgo(1)),
      mk('dead-new', 'expired', daysAgo(5)),
      mk('live-old', 'awaiting', daysAgo(20)),
    ]);
    expect(out.map(a => a.id)).toEqual(['live-old', 'live-new', 'dead-old', 'dead-new']);
  });

  it('does not mutate the input', () => {
    const input = [mk('b', 'awaiting', daysAgo(1)), mk('a', 'awaiting', daysAgo(9))];
    sortActions(input);
    expect(input.map(a => a.id)).toEqual(['b', 'a']);
  });
});
