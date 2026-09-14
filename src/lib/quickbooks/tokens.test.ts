import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as oauth from './oauth';
import {
  QBO_ENVIRONMENT_MISMATCH,
  QBO_NOT_CONNECTED,
  QBO_REFRESH_BUSY,
  NO_QBO_TOKEN,
  getAccessToken,
  isQboTokenError,
  readConnection,
  storeConnection,
  updateCapabilities,
} from './tokens';
import { makeFakeService, writesTo } from './test-fake-service';

const ORIGINAL = { ...process.env };
beforeEach(() => {
  process.env.QBO_ENVIRONMENT = 'production';
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

const tokenRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  realm_id: '4620816365208163',
  environment: 'production',
  company_name: 'BMG Fleet',
  access_token: 'access-old',
  access_expires_at: iso(3_600_000),
  refresh_token: 'refresh-old',
  refresh_expires_at: iso(100 * 86_400_000),
  minor_version: '73',
  needs_reauth_at: null,
  refresh_lease_until: null,
  capabilities: {},
  ...over,
});

const grant = (over: Partial<oauth.TokenGrant> = {}): oauth.TokenGrant => ({
  access_token: 'access-new',
  refresh_token: 'refresh-ROTATED',
  expires_in: 3600,
  x_refresh_token_expires_in: 8_726_400,
  token_type: 'Bearer',
  ...over,
});

describe('readConnection', () => {
  it('refuses when there is no row at all', async () => {
    const svc = makeFakeService({ quickbooks_tokens: [] });
    await expect(readConnection(svc as any)).rejects.toThrow(NO_QBO_TOKEN);
  });

  it('refuses a connection already marked as needing re-auth', async () => {
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow({ needs_reauth_at: iso(-1000) })] });
    await expect(readConnection(svc as any)).rejects.toThrow(QBO_NOT_CONNECTED);
  });

  it('refuses when the stored environment no longer matches QBO_ENVIRONMENT', async () => {
    // Flipping the env var without reconnecting would point production code
    // at a sandbox company's books.
    process.env.QBO_ENVIRONMENT = 'sandbox';
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow()] });
    await expect(readConnection(svc as any)).rejects.toThrow(QBO_ENVIRONMENT_MISMATCH);
  });

  it('returns the connection with capabilities defaulted to an object', async () => {
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow({ capabilities: null })] });
    const conn = await readConnection(svc as any);
    expect(conn.realmId).toBe('4620816365208163');
    expect(conn.capabilities).toEqual({});
  });
});

describe('getAccessToken — the happy path', () => {
  it('returns the stored token while it is still fresh, with no network call', async () => {
    const refresh = vi.spyOn(oauth, 'refreshGrant');
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow()] });
    const { token } = await getAccessToken(svc as any);
    expect(token).toBe('access-old');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('getAccessToken — refresh', () => {
  it('PERSISTS the rotated refresh token and both expiries', async () => {
    // Intuit rotates; the previous value dies the moment it does.
    vi.spyOn(oauth, 'refreshGrant').mockResolvedValue(grant());
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow({ access_expires_at: iso(-1000) })] });
    const { token } = await getAccessToken(svc as any);
    expect(token).toBe('access-new');
    const stored = svc.tables.quickbooks_tokens[0];
    expect(stored.refresh_token).toBe('refresh-ROTATED');
    expect(stored.access_token).toBe('access-new');
    expect(new Date(stored.access_expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(stored.refresh_expires_at).getTime()).toBeGreaterThan(Date.now() + 90 * 86_400_000);
    expect(stored.refreshed_at).toBeTruthy();
    expect(stored.refresh_lease_until).toBeNull();
  });

  it('claims the lease BEFORE the token POST', async () => {
    const order: string[] = [];
    vi.spyOn(oauth, 'refreshGrant').mockImplementation(async () => {
      order.push('POST');
      return grant();
    });
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow({ access_expires_at: iso(-1000) })] });
    const realFrom = svc.from;
    (svc as any).from = (table: string) => {
      const q = realFrom(table);
      const update = q.update;
      q.update = (row: any) => {
        if (row.refresh_lease_until) order.push('LEASE');
        return update(row);
      };
      return q;
    };
    await getAccessToken(svc as any);
    expect(order[0]).toBe('LEASE');
    expect(order).toContain('POST');
  });

  it('ONE refresh across two concurrent callers — the loser waits and re-reads', async () => {
    // Two POSTs would mean one caller persists a token the other has already
    // invalidated, and the connection dies until a human reconnects.
    let posts = 0;
    vi.spyOn(oauth, 'refreshGrant').mockImplementation(async () => {
      posts++;
      await new Promise(r => setTimeout(r, 50));
      return grant();
    });
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow({ access_expires_at: iso(-1000) })] });
    const [a, b] = await Promise.all([
      getAccessToken(svc as any),
      // Start the second caller after the first has claimed the lease.
      new Promise(r => setTimeout(r, 10)).then(() => getAccessToken(svc as any)),
    ]);
    expect(posts).toBe(1);
    expect(a.token).toBe('access-new');
    expect((b as any).token).toBe('access-new');
  });

  /**
   * Interleave A and B for real: A's pre-claim read sees the row as it was,
   * and B's rotation commits before A's claim lands. Mutating the table up
   * front would NOT reproduce it — A's own read would see the new value too,
   * which is why the first cut of this test passed against the bug.
   */
  function rotateAfterFirstRead(svc: any, patch: Record<string, unknown>) {
    const realFrom = svc.from.bind(svc);
    let reads = 0;
    svc.from = (table: string) => {
      const q = realFrom(table);
      if (table !== 'quickbooks_tokens') return q;
      const realMaybeSingle = q.maybeSingle.bind(q);
      q.maybeSingle = async () => {
        const res = await realMaybeSingle();
        if (reads++ === 0 && res?.data) {
          const snapshot = { ...res.data };
          Object.assign(svc.tables.quickbooks_tokens[0], patch); // B commits
          return { ...res, data: snapshot };                     // A still holds the old copy
        }
        return res;
      };
      return q;
    };
  }

  it('a claim that lands AFTER another caller rotated uses the NEW refresh token, not the one it read', async () => {
    // The lost update this guards: A reads (refresh_token R1), B claims,
    // rotates to R2 and releases, A then claims the free lease. POSTing the
    // stale R1 earns invalid_grant for a rotated-past token and takes the
    // whole connection red — on a connection that was perfectly healthy.
    const seen: string[] = [];
    vi.spyOn(oauth, 'refreshGrant').mockImplementation(async (token: string) => {
      seen.push(token);
      return grant();
    });
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow({ access_expires_at: iso(-1000), refresh_token: 'R1' })],
    });
    rotateAfterFirstRead(svc, { refresh_token: 'R2' });

    await getAccessToken(svc as any);
    expect(seen).toEqual(['R2']);
    expect(svc.tables.quickbooks_tokens[0].needs_reauth_at ?? null).toBeNull();
  });

  it('a claim that lands after another caller left a FRESH token returns it instead of rotating again', async () => {
    const posts = vi.spyOn(oauth, 'refreshGrant');
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow({ access_expires_at: iso(-1000) })] });
    rotateAfterFirstRead(svc, {
      access_token: 'access-from-the-other-caller',
      access_expires_at: iso(3_600_000),
    });

    const got = await getAccessToken(svc as any);
    expect(got.token).toBe('access-from-the-other-caller');
    expect(posts).not.toHaveBeenCalled();
    expect(svc.tables.quickbooks_tokens[0].refresh_lease_until).toBeNull();
  });

  it('a loser that never sees a fresh token gives up with QBO_REFRESH_BUSY', async () => {
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow({ access_expires_at: iso(-1000), refresh_lease_until: iso(90_000) })],
    });
    vi.useFakeTimers();
    const promise = getAccessToken(svc as any).catch(e => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await promise;
    vi.useRealTimers();
    expect(String(result?.message)).toBe(QBO_REFRESH_BUSY);
  }, 20_000);

  it('invalid_grant stamps needs_reauth_at, clears the lease and refuses', async () => {
    vi.spyOn(oauth, 'refreshGrant').mockRejectedValue(new oauth.QboAuthError('invalid_grant', 400));
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow({ access_expires_at: iso(-1000) })] });
    await expect(getAccessToken(svc as any)).rejects.toThrow(QBO_NOT_CONNECTED);
    const stored = svc.tables.quickbooks_tokens[0];
    expect(stored.needs_reauth_at).toBeTruthy();
    expect(stored.last_error).toMatch(/invalid_grant/);
    expect(stored.refresh_lease_until).toBeNull();
  });

  it('a TRANSIENT failure clears the lease and does NOT burn the refresh token', async () => {
    vi.spyOn(oauth, 'refreshGrant').mockRejectedValue(new oauth.QboAuthError('refresh_failed', 503));
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow({ access_expires_at: iso(-1000) })] });
    await expect(getAccessToken(svc as any)).rejects.toThrow(/refresh_failed/);
    const stored = svc.tables.quickbooks_tokens[0];
    expect(stored.needs_reauth_at).toBeNull();
    expect(stored.refresh_token).toBe('refresh-old');
    expect(stored.refresh_lease_until).toBeNull();
  });

  it('forceRefresh refreshes even when the stored token is fresh', async () => {
    const refresh = vi.spyOn(oauth, 'refreshGrant').mockResolvedValue(grant());
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow()] });
    await getAccessToken(svc as any, { forceRefresh: true });
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('storeConnection', () => {
  it('reports whether a row existed and clears every broken marker', async () => {
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow({ needs_reauth_at: iso(-1000), last_error: 'old failure' })],
    });
    const { existed } = await storeConnection(svc as any, {
      realmId: '4620816365208163',
      environment: 'production',
      companyName: null,
      grant: grant(),
      connectedBy: 'user-1',
      minorVersion: '73',
    });
    expect(existed).toBe(true);
    const stored = svc.tables.quickbooks_tokens[0];
    expect(stored.needs_reauth_at).toBeNull();
    expect(stored.last_error).toBeNull();
    expect(stored.refresh_token).toBe('refresh-ROTATED');
  });

  it('a first connect reports existed:false', async () => {
    const svc = makeFakeService({ quickbooks_tokens: [] });
    const { existed } = await storeConnection(svc as any, {
      realmId: '1', environment: 'production', companyName: 'X', grant: grant(), connectedBy: 'u', minorVersion: '73',
    });
    expect(existed).toBe(false);
  });
});

describe('updateCapabilities', () => {
  it('MERGES rather than replaces — probes settle at different times', async () => {
    const svc = makeFakeService({
      quickbooks_tokens: [tokenRow({ capabilities: { orderById: true, pdf: { Invoice: true } } })],
    });
    await updateCapabilities(svc as any, { pdf: { Bill: false } });
    const caps = svc.tables.quickbooks_tokens[0].capabilities;
    expect(caps.orderById).toBe(true);
    // Recording Bill=false must not erase Invoice=true.
    expect(caps.pdf).toEqual({ Invoice: true, Bill: false });
    expect(caps.probedAt).toBeTruthy();
  });
});

describe('isQboTokenError', () => {
  it('recognises the five named refusals, including the prefixed read failure', () => {
    expect(isQboTokenError(new Error(NO_QBO_TOKEN))).toBe(true);
    expect(isQboTokenError(new Error(QBO_NOT_CONNECTED))).toBe(true);
    expect(isQboTokenError(new Error(QBO_REFRESH_BUSY))).toBe(true);
    expect(isQboTokenError(new Error(QBO_ENVIRONMENT_MISMATCH))).toBe(true);
    expect(isQboTokenError(new Error('QBO_TOKEN_READ_FAILED: connection reset'))).toBe(true);
    expect(isQboTokenError(new Error('something else entirely'))).toBe(false);
  });
});

describe('no token value ever leaves through a write we did not intend', () => {
  it('the capabilities merge writes only capabilities and updated_at', async () => {
    const svc = makeFakeService({ quickbooks_tokens: [tokenRow()] });
    await updateCapabilities(svc as any, { cdc: true });
    const update = writesTo(svc, 'quickbooks_tokens').find(w => w.op === 'update');
    expect(Object.keys(update!.rows[0]).sort()).toEqual(['capabilities', 'updated_at']);
  });
});
