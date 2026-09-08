import { describe, it, expect, vi } from 'vitest';
import { computeBurn, maybeNotifyLaborBurn, BURN_WARN_PCT, BURN_OVER_PCT } from './labor-burn';

describe('computeBurn', () => {
  it('reads green below the warn threshold', () => {
    const b = computeBurn({ loggedHours: 4, soldHours: 8 });
    expect(b).toMatchObject({ pct: 50, tone: 'ok', label: '4h of 8h sold' });
  });

  it('turns amber exactly at the warn threshold', () => {
    expect(computeBurn({ loggedHours: 7.9, soldHours: 10 }).tone).toBe('ok');
    expect(computeBurn({ loggedHours: 8, soldHours: 10 }).pct).toBe(BURN_WARN_PCT);
    expect(computeBurn({ loggedHours: 8, soldHours: 10 }).tone).toBe('warn');
  });

  it('turns red exactly at 100% and stays red past it', () => {
    expect(computeBurn({ loggedHours: 10, soldHours: 10 }).pct).toBe(BURN_OVER_PCT);
    expect(computeBurn({ loggedHours: 10, soldHours: 10 }).tone).toBe('over');
    expect(computeBurn({ loggedHours: 25, soldHours: 10 })).toMatchObject({ pct: 250, tone: 'over' });
  });

  it('is UNKNOWN with no sold hours — not 0%, and certainly not over', () => {
    const b = computeBurn({ loggedHours: 6, soldHours: null });
    expect(b.tone).toBe('unknown');
    expect(b.pct).toBeNull();
    expect(b.soldHours).toBeNull();
    expect(b.label).toContain('no sold hours on file');
  });

  it('treats zero sold hours as unknown too — a quote with no labor is not a zero budget', () => {
    expect(computeBurn({ loggedHours: 3, soldHours: 0 }).tone).toBe('unknown');
  });

  it('says so plainly when nothing has been logged and nothing was sold', () => {
    expect(computeBurn({ loggedHours: 0, soldHours: null }).label).toBe('No sold hours on file');
  });

  it('is at 0% — green, not unknown — when hours were sold but none logged yet', () => {
    const b = computeBurn({ loggedHours: 0, soldHours: 8 });
    expect(b).toMatchObject({ pct: 0, tone: 'ok', label: '0h of 8h sold' });
  });

  it('never reports negative logged hours', () => {
    expect(computeBurn({ loggedHours: -3, soldHours: 8 }).loggedHours).toBe(0);
  });

  it('carries the source so the sold figure is never anonymous', () => {
    const b = computeBurn({ loggedHours: 1, soldHours: 4, source: 'estimate', sourceLabel: 'EST-1042' });
    expect(b.source).toBe('estimate');
    expect(b.sourceLabel).toBe('EST-1042');
  });

  it('rounds to one decimal rather than printing float noise', () => {
    expect(computeBurn({ loggedHours: 2.34567, soldHours: 8 }).label).toBe('2.3h of 8h sold');
  });
});

/* A hand-rolled Supabase stand-in: enough of the builder chain for the
 * notify path, and nothing more. */
function fakeService(checkin: any, opts: { stampError?: string } = {}) {
  const state = { checkin: { ...checkin }, stamped: false };
  const service: any = {
    from(table: string) {
      const q: any = {
        _table: table,
        select: () => q,
        eq: () => q,
        in: () => q,
        is: () => q,
        order: () => q,
        maybeSingle: async () => ({ data: table === 'fleet_checkins' ? state.checkin : null }),
        then: undefined,
        update: (patch: any) => {
          const u: any = {
            eq: () => u,
            is: async () => {
              if (opts.stampError) return { error: { message: opts.stampError } };
              state.stamped = true;
              Object.assign(state.checkin, patch);
              return { error: null };
            },
          };
          return u;
        },
      };
      // `.select()` on estimates resolves to an empty list.
      if (table === 'estimates') {
        q.eq = () => Promise.resolve({ data: [] });
        q.in = () => ({ order: () => Promise.resolve({ data: [] }) });
      }
      return q;
    },
    _state: state,
  };
  return service;
}

describe('maybeNotifyLaborBurn', () => {
  const deps = () => ({
    notifyMany: vi.fn(async () => {}),
    adminIds: vi.fn(async () => ['admin-1']),
    pickListUrl: (vin: string, id: string) => `/vehicles/${vin}/pick-list?visit=${id}`,
  });

  it('does nothing when the visit has already been pinged', async () => {
    const d = deps();
    const res = await maybeNotifyLaborBurn(
      fakeService({ id: 'c1', vin: 'VIN1', labor_burn_notified_at: '2026-09-01T00:00:00Z' }),
      'c1', d,
    );
    expect(res.notified).toBe(false);
    expect(res.reason).toMatch(/already notified/);
    expect(d.notifyMany).not.toHaveBeenCalled();
  });

  it('does nothing when the vehicle is not over budget', async () => {
    // The fake service returns no estimates, so sold hours are unknown and
    // the tone is 'unknown' — which must NOT ping.
    const d = deps();
    const res = await maybeNotifyLaborBurn(
      fakeService({ id: 'c1', vin: 'VIN1', labor_burn_notified_at: null }),
      'c1', d,
    );
    expect(res.notified).toBe(false);
    expect(d.notifyMany).not.toHaveBeenCalled();
  });

  it('never throws when the check-in is missing', async () => {
    const service: any = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) };
    const res = await maybeNotifyLaborBurn(service, 'nope', deps());
    expect(res).toEqual({ notified: false, reason: 'no check-in' });
  });

  it('never throws when the read blows up — a Stop button must not fail on a notification', async () => {
    const service: any = { from: () => { throw new Error('db is down'); } };
    const res = await maybeNotifyLaborBurn(service, 'c1', deps());
    expect(res.notified).toBe(false);
    expect(res.reason).toContain('db is down');
  });
});
