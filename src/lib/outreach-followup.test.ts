import { describe, it, expect } from 'vitest';
import {
  followUpSubject, followUpCutoff, parseFollowUpJson, buildFollowUpPrompt, followUpSkipReason, FOLLOWUP_AFTER_DAYS,
} from './outreach-followup';
import { statusMoveAllowed } from './outreach-send';

describe('followUpSubject', () => {
  it('prefixes Re: once', () => {
    expect(followUpSubject('Shelving for your vans')).toBe('Re: Shelving for your vans');
    expect(followUpSubject('RE: Shelving')).toBe('RE: Shelving');
    expect(followUpSubject(null)).toBe('Following up');
  });
});

describe('followUpCutoff', () => {
  it('is a week before now', () => {
    const now = new Date('2026-11-02T15:00:00Z');
    expect(followUpCutoff(now)).toBe(new Date(now.getTime() - FOLLOWUP_AFTER_DAYS * 86_400_000).toISOString());
  });
});

describe('parseFollowUpJson', () => {
  it('reads bare and fenced JSON', () => {
    const body = 'Hi there, one more thought on the vans you run out of Wentzville.';
    expect(parseFollowUpJson(JSON.stringify({ body }))).toBe(body);
    expect(parseFollowUpJson('Here you go:\n```json\n' + JSON.stringify({ body }) + '\n```')).toBe(body);
  });
  it('refuses junk and too-short bodies', () => {
    expect(parseFollowUpJson('no json')).toBeNull();
    expect(parseFollowUpJson('{"body": "Hi"}')).toBeNull();
  });
});

describe('buildFollowUpPrompt', () => {
  it('carries the first email and greets by first name when known', () => {
    const p = buildFollowUpPrompt({
      companyName: 'Acme Plumbing', repName: 'Valarie Fleahman', contactName: 'Dan Smith',
      firstSubject: 'Bins for your vans', firstBody: 'Hi Dan, saw your 12 vans...', sentAt: null,
    });
    expect(p).toContain('Bins for your vans');
    expect(p).toContain('saw your 12 vans');
    expect(p).toContain('Greet Dan by first name');
    expect(p).toContain('Have Valarie call me');
  });
});

/** Just enough of the Supabase client for followUpSkipReason. */
function fakeService(opts: { unsubscribed?: string[]; activities?: number }) {
  const chain = (result: any) => {
    const q: any = {};
    for (const m of ['select', 'eq', 'in', 'gt', 'not', 'limit']) q[m] = () => q;
    q.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej);
    return q;
  };
  return {
    from: (table: string) => table === 'email_unsubscribes'
      ? chain({ data: (opts.unsubscribed || []).map(email => ({ email, unsubscribed_at: '2026-10-30' })), error: null })
      : chain({ data: Array.from({ length: opts.activities || 0 }, (_, i) => ({ id: String(i) })), error: null }),
  } as any;
}

describe('followUpSkipReason', () => {
  const t = { email: 'dan@acme.com', prospect_id: 'p1', sent_at: '2026-10-26T15:00:00Z' };
  it('skips an unsubscribed address', async () => {
    expect(await followUpSkipReason(fakeService({ unsubscribed: ['dan@acme.com'] }), t)).toBe('unsubscribed');
  });
  it('skips when someone already talked to them', async () => {
    expect(await followUpSkipReason(fakeService({ activities: 1 }), t)).toBe('talked');
  });
  it('writes one when nothing was heard', async () => {
    expect(await followUpSkipReason(fakeService({}), t)).toBeNull();
  });
});

describe('statusMoveAllowed', () => {
  it('lets a draft be saved for later (PR 3 refused it)', () => {
    expect(statusMoveAllowed('draft', 'later')).toBe(true);
    expect(statusMoveAllowed('call_first', 'later')).toBe(true);
  });
  it('marks replied only after an email went', () => {
    expect(statusMoveAllowed('sent', 'replied')).toBe(true);
    expect(statusMoveAllowed('follow_up', 'replied')).toBe(true);
    expect(statusMoveAllowed('draft', 'replied')).toBe(false);
  });
  it('never lets a sent row back to new', () => {
    expect(statusMoveAllowed('sent', 'new')).toBe(false);
    expect(statusMoveAllowed('not_fit', 'new')).toBe(true);
  });
});
