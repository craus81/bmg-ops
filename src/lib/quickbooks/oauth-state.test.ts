import { describe, it, expect } from 'vitest';
import { consumeState, mintState } from './oauth-state';
import { makeFakeService, writesTo } from './test-fake-service';

const USER = 'user-1';

describe('mintState', () => {
  it('stores a fresh nonce bound to the user and the environment', async () => {
    const svc = makeFakeService();
    const state = await mintState(svc as any, USER, 'production');
    expect(state).toMatch(/^[0-9a-f-]{36}$/);
    const row = svc.tables.quickbooks_oauth_states[0];
    expect(row.state).toBe(state);
    expect(row.user_id).toBe(USER);
    expect(row.environment).toBe('production');
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('purges rows older than an hour — nothing else cleans this table', async () => {
    const svc = makeFakeService({
      quickbooks_oauth_states: [
        { state: 'ancient', user_id: USER, environment: 'production', created_at: '2020-01-01T00:00:00Z', expires_at: '2020-01-01T00:10:00Z' },
      ],
    });
    await mintState(svc as any, USER, 'production');
    expect(svc.tables.quickbooks_oauth_states.map(r => r.state)).not.toContain('ancient');
    expect(writesTo(svc, 'quickbooks_oauth_states').some(w => w.op === 'delete')).toBe(true);
  });
});

describe('consumeState', () => {
  const seed = (over: Record<string, unknown> = {}) => makeFakeService({
    quickbooks_oauth_states: [{
      state: 'nonce-abc',
      user_id: USER,
      environment: 'sandbox',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      ...over,
    }],
  });

  it('returns the environment the connect STARTED in', async () => {
    const svc = seed();
    expect(await consumeState(svc as any, 'nonce-abc', USER)).toEqual({ ok: true, environment: 'sandbox' });
  });

  it('is single use — a replay finds nothing', async () => {
    const svc = seed();
    await consumeState(svc as any, 'nonce-abc', USER);
    expect(svc.tables.quickbooks_oauth_states).toHaveLength(0);
    expect(await consumeState(svc as any, 'nonce-abc', USER)).toEqual({ ok: false, reason: 'missing' });
  });

  it('refuses an expired state — and still burns it', async () => {
    const svc = seed({ expires_at: new Date(Date.now() - 1_000).toISOString() });
    expect(await consumeState(svc as any, 'nonce-abc', USER)).toEqual({ ok: false, reason: 'expired' });
    expect(svc.tables.quickbooks_oauth_states).toHaveLength(0);
  });

  it('refuses a state finished by a different user', async () => {
    const svc = seed();
    expect(await consumeState(svc as any, 'nonce-abc', 'someone-else')).toEqual({ ok: false, reason: 'user_mismatch' });
  });

  it('reports a LENGTH mismatch as malformed instead of throwing', async () => {
    // crypto.timingSafeEqual throws on unequal lengths; a thrown callback
    // would be a 500 where a refusal belongs.
    const svc = seed();
    const shorter = await consumeState(svc as any, 'nonce-ab', USER);
    expect(shorter).toEqual({ ok: false, reason: 'missing' });
    const empty = await consumeState(svc as any, '', USER);
    expect(empty).toEqual({ ok: false, reason: 'malformed' });
  });

  it('a failed read is a refusal, not a crash', async () => {
    const svc = seed();
    svc.failReadsOn.add('quickbooks_oauth_states');
    expect(await consumeState(svc as any, 'nonce-abc', USER)).toEqual({ ok: false, reason: 'missing' });
  });
});
