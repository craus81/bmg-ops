import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as oauth from './oauth';
import { completeConnection } from './connect';
import { makeFakeService, writesTo, type FakeService } from './test-fake-service';

const ORIGINAL = { ...process.env };
beforeEach(() => {
  process.env.QBO_ENVIRONMENT = 'production';
  process.env.QBO_CLIENT_ID = 'id';
  process.env.QBO_CLIENT_SECRET = 'secret';
  process.env.QBO_REDIRECT_URI = 'https://ops.example.com/api/auth/quickbooks/callback';
  // assertEnvironmentPairing('production') needs the production ref.
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://jdwoceryzhbimjmtwrpr.supabase.co';
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

const REALM = '4620816365208163';
const USER = 'user-1';

const grant: oauth.TokenGrant = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  expires_in: 3600,
  x_refresh_token_expires_in: 8_726_400,
  token_type: 'Bearer',
};

function svcWithState(over: Record<string, unknown> = {}, tokens: any[] = []): FakeService {
  return makeFakeService({
    quickbooks_oauth_states: [{
      state: 'nonce-1',
      user_id: USER,
      environment: 'production',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      ...over,
    }],
    quickbooks_tokens: tokens,
  });
}

const input = { code: 'auth-code', realmId: REALM, state: 'nonce-1', userId: USER };

describe('completeConnection — ordering', () => {
  it('stores the connection BEFORE probing CompanyInfo', async () => {
    // Intuit has already issued (and rotated) tokens by the time the callback
    // lands. Probing first and treating a failure as a failed connect would
    // throw away live credentials.
    const order: string[] = [];
    vi.spyOn(oauth, 'exchangeCode').mockResolvedValue(grant);
    vi.spyOn(oauth, 'fetchCompanyInfo').mockImplementation(async () => {
      order.push('PROBE');
      return { ok: true, companyName: 'BMG Fleet', via: 'query' };
    });
    const svc = svcWithState();
    const realFrom = svc.from;
    (svc as any).from = (table: string) => {
      const q = realFrom(table);
      const upsert = q.upsert;
      q.upsert = (rows: any) => {
        if (table === 'quickbooks_tokens') order.push('STORE');
        return upsert(rows);
      };
      return q;
    };

    const result = await completeConnection(svc as any, input);
    expect(result).toMatchObject({ ok: true, existed: false, companyName: 'BMG Fleet', companyInfoProbe: 'ok' });
    expect(order).toEqual(['STORE', 'PROBE']);
  });

  it('a FAILING CompanyInfo probe still yields ok:true, a NULL name and companyInfo=false', async () => {
    vi.spyOn(oauth, 'exchangeCode').mockResolvedValue(grant);
    vi.spyOn(oauth, 'fetchCompanyInfo').mockResolvedValue({ ok: false, reason: 'query returned HTTP 500', status: 500 });
    const svc = svcWithState();

    const result = await completeConnection(svc as any, input);
    expect(result).toEqual({ ok: true, existed: false, companyName: null, companyInfoProbe: 'failed' });
    const stored = svc.tables.quickbooks_tokens[0];
    expect(stored.company_name).toBeNull();
    expect(stored.access_token).toBe('access-1');
    expect(stored.capabilities.companyInfo).toBe(false);
  });
});

describe('completeConnection — the audit row', () => {
  it('records the MASKED realm and never the full id or a token', async () => {
    vi.spyOn(oauth, 'exchangeCode').mockResolvedValue(grant);
    vi.spyOn(oauth, 'fetchCompanyInfo').mockResolvedValue({ ok: true, companyName: 'BMG Fleet', via: 'query' });
    const svc = svcWithState();
    await completeConnection(svc as any, input);

    const [audit] = writesTo(svc, 'audit_log');
    expect(audit.rows[0].action).toBe('qbo_connected');
    expect(audit.rows[0].detail.realmMasked).toBe('…8163');
    const serialized = JSON.stringify(audit.rows[0]);
    expect(serialized).not.toContain(REALM);
    expect(serialized).not.toContain('access-1');
    expect(serialized).not.toContain('refresh-1');
  });

  it('a reconnect is audited as qbo_reconnected', async () => {
    vi.spyOn(oauth, 'exchangeCode').mockResolvedValue(grant);
    vi.spyOn(oauth, 'fetchCompanyInfo').mockResolvedValue({ ok: true, companyName: 'BMG Fleet', via: 'query' });
    const svc = svcWithState({}, [{ id: 1, realm_id: REALM, environment: 'production' }]);
    const result = await completeConnection(svc as any, input);
    expect(result).toMatchObject({ ok: true, existed: true });
    expect(writesTo(svc, 'audit_log')[0].rows[0].action).toBe('qbo_reconnected');
  });
});

describe('completeConnection — every ConnectFailure', () => {
  it('missing_realm before anything else happens', async () => {
    const exchange = vi.spyOn(oauth, 'exchangeCode');
    const svc = svcWithState();
    expect(await completeConnection(svc as any, { ...input, realmId: '' })).toEqual({ ok: false, reason: 'missing_realm' });
    expect(exchange).not.toHaveBeenCalled();
    // The state is not burned either — the admin can retry.
    expect(svc.tables.quickbooks_oauth_states).toHaveLength(1);
  });

  it('state_mismatch when the nonce is unknown', async () => {
    const svc = svcWithState();
    expect(await completeConnection(svc as any, { ...input, state: 'nonce-other' }))
      .toEqual({ ok: false, reason: 'state_mismatch' });
  });

  it('expired when the consent screen sat too long', async () => {
    const svc = svcWithState({ expires_at: new Date(Date.now() - 1).toISOString() });
    expect(await completeConnection(svc as any, input)).toEqual({ ok: false, reason: 'expired' });
  });

  it('user_mismatch when a different account finished the flow', async () => {
    const svc = svcWithState();
    expect(await completeConnection(svc as any, { ...input, userId: 'someone-else' }))
      .toEqual({ ok: false, reason: 'user_mismatch' });
  });

  it('sandbox_on_production when a sandbox connect lands on production', async () => {
    const svc = svcWithState({ environment: 'sandbox' });
    expect(await completeConnection(svc as any, input)).toEqual({ ok: false, reason: 'sandbox_on_production' });
    expect(svc.tables.quickbooks_tokens).toHaveLength(0);
  });

  it('production_off_production when the deployment is not the production database', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://scratchref.supabase.co';
    const svc = svcWithState();
    expect(await completeConnection(svc as any, input)).toEqual({ ok: false, reason: 'production_off_production' });
  });

  it('another_realm_connected rather than silently swapping companies', async () => {
    // Swapping would orphan every imported ledger_* row against a realm the
    // connection no longer matches.
    const exchange = vi.spyOn(oauth, 'exchangeCode');
    const svc = svcWithState({}, [{ id: 1, realm_id: '9999999999', environment: 'production' }]);
    expect(await completeConnection(svc as any, input)).toEqual({ ok: false, reason: 'another_realm_connected' });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('exchange_failed when Intuit refuses the code', async () => {
    vi.spyOn(oauth, 'exchangeCode').mockRejectedValue(new oauth.QboAuthError('invalid_grant', 400));
    const svc = svcWithState();
    expect(await completeConnection(svc as any, input)).toEqual({ ok: false, reason: 'exchange_failed' });
    expect(svc.tables.quickbooks_tokens).toHaveLength(0);
  });
});
