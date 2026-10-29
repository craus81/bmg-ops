import { describe, it, expect, vi, beforeEach } from 'vitest';

const notifyMany = vi.fn(async (..._args: any[]) => {});
vi.mock('./notify', () => ({ notifyMany: (...args: any[]) => notifyMany(...args) }));

import { recordQuoteView, viewerFromUrl, openedBy } from './quote-view-recorder';

const CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const HOUR = 3_600_000;

/** quote_views rows in memory, plus Craig ticked "Copy me on new alerts". */
function fakeService(rows: any[] = []) {
  return {
    rows,
    from: (table: string) => {
      if (table === 'notification_preferences') {
        return { select: () => ({ eq: async () => ({ data: [{ user_id: 'craig' }] }) }) };
      }
      const q: any = {
        select: () => q, eq: () => q, order: () => q,
        limit: async () => ({ data: [...rows].sort((a, b) => b.viewed_at.localeCompare(a.viewed_at)) }),
        insert: async (row: any) => { rows.push(row); return { error: null }; },
      };
      return q;
    },
  } as any;
}

const req = (ip = '1.2.3.4') => new Request('https://go.bmgfleet.com/api/approve/estimate/t', {
  headers: { 'user-agent': CHROME, 'x-forwarded-for': ip },
});

const args = (viewer: string | null, ip?: string) => ({
  type: 'estimate' as const, id: 'est-1', req: req(ip),
  sentAt: new Date(Date.now() - 2 * HOUR).toISOString(),
  repIds: ['valarie', null], label: 'Estimate #EST-2610-082 — Jerry Kelly Mid Roof HVAC',
  customerName: 'Clement Ford', viewer,
});

beforeEach(() => notifyMany.mockClear());

describe('viewerFromUrl', () => {
  it('reads the person off a per-person link only', () => {
    expect(viewerFromUrl('https://x/api/approve/estimate/t?to=jerry%40clementford.com&own=1')).toBe('jerry@clementford.com');
    expect(viewerFromUrl('https://x/api/approve/estimate/t?to=jerry%40clementford.com')).toBeNull();
    expect(viewerFromUrl('https://x/api/approve/estimate/t')).toBeNull();
    expect(viewerFromUrl('https://x/a?own=1&to=' + 'a'.repeat(300))).toHaveLength(200);
  });
});

describe('openedBy', () => {
  it('names the person and the customer', () => {
    expect(openedBy('jerry@clementford.com', 'Clement Ford')).toBe('jerry@clementford.com (Clement Ford)');
    expect(openedBy(null, 'Clement Ford')).toBe('Clement Ford');
    expect(openedBy(null, null)).toBe('The customer');
  });
});

describe('recordQuoteView', () => {
  it('names who opened it, links to the estimate, and copies Craig', async () => {
    const svc = fakeService();
    await recordQuoteView(svc, args('jerry@clementford.com'));
    expect(notifyMany).toHaveBeenCalledTimes(1);
    const [ids, payload] = notifyMany.mock.calls[0] as any[];
    expect(ids.sort()).toEqual(['craig', 'valarie']);
    expect(payload.title).toBe('👀 Opened — Estimate #EST-2610-082 — Jerry Kelly Mid Roof HVAC');
    expect(payload.body).toBe('jerry@clementford.com (Clement Ford) just opened Estimate #EST-2610-082 — Jerry Kelly Mid Roof HVAC for the first time.');
    expect(payload.url).toBe('/estimates?id=est-1&from=quotes');
    expect(svc.rows[0].viewer).toBe('jerry@clementford.com');
  });

  it("alerts again on a second person's first look, listing who already opened it", async () => {
    const svc = fakeService([{ viewed_at: new Date(Date.now() - 5 * 60_000).toISOString(), viewer_kind: 'human', ip_address: '1.2.3.4', user_agent: CHROME, viewer: 'jerry@clementford.com' }]);
    // Same office address and browser, a few minutes apart: still a new person.
    await recordQuoteView(svc, args('pat@clementford.com'));
    expect(notifyMany).toHaveBeenCalledTimes(1);
    expect((notifyMany.mock.calls[0] as any[])[1].body).toBe(
      'pat@clementford.com (Clement Ford) just opened Estimate #EST-2610-082 — Jerry Kelly Mid Roof HVAC for the first time. Already opened by jerry@clementford.com.');
  });

  it('stays quiet when the same person opens it again', async () => {
    const svc = fakeService([{ viewed_at: new Date(Date.now() - 2 * HOUR).toISOString(), viewer_kind: 'human', ip_address: '9.9.9.9', user_agent: CHROME, viewer: 'jerry@clementford.com' }]);
    await recordQuoteView(svc, args('jerry@clementford.com'));
    expect(notifyMany).not.toHaveBeenCalled();
    expect(svc.rows).toHaveLength(2);
  });

  it('keeps the old single first-look alert on links that name nobody', async () => {
    const svc = fakeService();
    await recordQuoteView(svc, args(null));
    expect((notifyMany.mock.calls[0] as any[])[1].body).toBe('Clement Ford just opened Estimate #EST-2610-082 — Jerry Kelly Mid Roof HVAC for the first time.');
    notifyMany.mockClear();
    await recordQuoteView(svc, args(null, '5.6.7.8'));
    expect(notifyMany).not.toHaveBeenCalled();
  });
});
