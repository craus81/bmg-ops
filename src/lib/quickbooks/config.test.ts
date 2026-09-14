import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PRODUCTION_SUPABASE_REF,
  QBO_DEFAULT_MINOR_VERSION,
  assertEnvironmentPairing,
  maskRealm,
  qboApiBase,
  qboConfig,
  qboConfigured,
  supabaseRef,
} from './config';

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('PRODUCTION_SUPABASE_REF', () => {
  it('is the same literal scripts/seed-sandbox.mjs refuses to seed', () => {
    // Two copies of this constant is how the sandbox wall quietly stops
    // meaning anything: the seed script would refuse production while the
    // QuickBooks pairing check let a sandbox realm onto it.
    const seed = readFileSync(join(process.cwd(), 'scripts/seed-sandbox.mjs'), 'utf8');
    const match = /const PRODUCTION_REF = '([a-z0-9-]+)'/.exec(seed);
    expect(match?.[1]).toBe(PRODUCTION_SUPABASE_REF);
  });
});

describe('qboConfig', () => {
  it('defaults the environment to production', () => {
    delete process.env.QBO_ENVIRONMENT;
    expect(qboConfig().environment).toBe('production');
  });

  it('throws on an environment that is neither value rather than falling back', () => {
    // A typo silently becoming 'production' would point a sandbox connect at
    // the real Intuit host.
    process.env.QBO_ENVIRONMENT = 'staging';
    expect(() => qboConfig()).toThrow('QBO_ENVIRONMENT must be production or sandbox');
  });

  it('defaults the minor version and honours an override', () => {
    delete process.env.QBO_MINOR_VERSION;
    expect(qboConfig().minorVersion).toBe(QBO_DEFAULT_MINOR_VERSION);
    process.env.QBO_MINOR_VERSION = '75';
    expect(qboConfig().minorVersion).toBe('75');
  });
});

describe('qboConfigured', () => {
  it('needs all three keys', () => {
    process.env.QBO_CLIENT_ID = 'id';
    process.env.QBO_CLIENT_SECRET = 'secret';
    delete process.env.QBO_REDIRECT_URI;
    expect(qboConfigured()).toBe(false);
    process.env.QBO_REDIRECT_URI = 'https://ops.example.com/api/auth/quickbooks/callback';
    expect(qboConfigured()).toBe(true);
  });

  it('treats blank as absent', () => {
    process.env.QBO_CLIENT_ID = '   ';
    process.env.QBO_CLIENT_SECRET = 'secret';
    process.env.QBO_REDIRECT_URI = 'https://x/cb';
    expect(qboConfigured()).toBe(false);
  });
});

describe('qboApiBase', () => {
  it('routes sandbox and production at different hosts', () => {
    expect(qboApiBase('production', '4620816365')).toBe('https://quickbooks.api.intuit.com/v3/company/4620816365');
    expect(qboApiBase('sandbox', '4620816365')).toBe('https://sandbox-quickbooks.api.intuit.com/v3/company/4620816365');
  });
});

describe('supabaseRef', () => {
  it('pulls the project ref out of a Supabase URL', () => {
    expect(supabaseRef('https://abcdef123.supabase.co')).toBe('abcdef123');
    expect(supabaseRef('https://ABCDEF123.supabase.co/rest/v1')).toBe('abcdef123');
  });
  it('is null for anything that is not one', () => {
    expect(supabaseRef('http://localhost:54321')).toBeNull();
    expect(supabaseRef(undefined)).toBeNull();
    expect(supabaseRef('')).toBeNull();
  });
});

describe('assertEnvironmentPairing — owner item 22', () => {
  const sandboxOk = { vercelEnv: undefined, netsuiteConfigured: false, ref: 'sandboxref' };

  it('allows a sandbox realm on a genuine sandbox', () => {
    expect(() => assertEnvironmentPairing('sandbox', sandboxOk)).not.toThrow();
  });

  it('refuses a sandbox realm when VERCEL_ENV is production', () => {
    expect(() => assertEnvironmentPairing('sandbox', { ...sandboxOk, vercelEnv: 'production' }))
      .toThrow('sandbox_on_production');
  });

  it('refuses a sandbox realm on a deployment carrying a NetSuite credential', () => {
    expect(() => assertEnvironmentPairing('sandbox', { ...sandboxOk, netsuiteConfigured: true }))
      .toThrow('sandbox_on_production');
  });

  it('refuses a sandbox realm pointed at the production database', () => {
    expect(() => assertEnvironmentPairing('sandbox', { ...sandboxOk, ref: PRODUCTION_SUPABASE_REF }))
      .toThrow('sandbox_on_production');
  });

  it('allows a production realm only on the production ref', () => {
    expect(() => assertEnvironmentPairing('production', {
      vercelEnv: 'production', netsuiteConfigured: true, ref: PRODUCTION_SUPABASE_REF,
    })).not.toThrow();
  });

  it('refuses a production realm anywhere else — real books must not land in a scratch database', () => {
    expect(() => assertEnvironmentPairing('production', {
      vercelEnv: 'preview', netsuiteConfigured: true, ref: 'sandboxref',
    })).toThrow('production_off_production');
    expect(() => assertEnvironmentPairing('production', {
      vercelEnv: undefined, netsuiteConfigured: false, ref: null,
    })).toThrow('production_off_production');
  });
});

describe('maskRealm', () => {
  it('keeps only the last four digits — the ONLY form that leaves tokens.ts', () => {
    expect(maskRealm('4620816365208163')).toBe('…8163');
  });
  it('is empty for nothing rather than "…"', () => {
    expect(maskRealm(null)).toBe('');
    expect(maskRealm(undefined)).toBe('');
    expect(maskRealm('')).toBe('');
  });
});
