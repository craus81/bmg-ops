// requireAuth's two-step gate (Books part 87, src/lib/two-step.ts): every
// route that takes a session refuses one that still owes its two-step code,
// and says what it owes. A made-up signed-in caller whose token, authenticator
// apps, roles and switch the test picks.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  profile: null as Record<string, unknown> | null,
  switchRow: { data: { is_on: false } as { is_on: boolean } | null, error: null as { message: string } | null },
  switchThrows: false,
  switchReads: 0,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user }, error: h.user ? null : { message: 'no' } }) } }),
}));
vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table === 'books_switches') {
        return {
          select: () => ({
            eq: (_c: string, piece: string) => ({
              maybeSingle: async () => {
                h.switchReads++;
                expect(piece).toBe('two_step_sign_in');
                if (h.switchThrows) throw new Error('fetch failed');
                return h.switchRow;
              },
            }),
          }),
        };
      }
      if (table === 'profiles') return { select: () => ({ eq: () => ({ single: async () => ({ data: h.profile, error: null }) }) }) };
      // user_feature_overrides and role_feature_settings: none.
      const none = { data: [], error: null };
      const chain: any = { select: () => chain, eq: () => chain, then: (ok: (v: unknown) => unknown) => Promise.resolve(none).then(ok) };
      return chain;
    },
  }),
}));

import { requireAuth, requireFeature, requireSuperAdmin } from '@/lib/api-auth';

const PAT = 'a0000000-0000-4000-8000-000000000001';

/** A made-up access token: only its claims matter here, never its signature. */
const token = (aal?: string) =>
  `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: PAT, ...(aal ? { aal } : {}) })).toString('base64url')}.c2ln`;
const req = (aal?: string) => new NextRequest('https://go.bmgfleet.com/api/anything', { headers: { Authorization: `Bearer ${token(aal)}` } });
const app = (status = 'verified') => ({ id: 'f-1', factor_type: 'totp', status, created_at: '2026-11-02T20:00:00Z', updated_at: '2026-11-02T20:01:00Z' });

function as(roles: string[], factors: unknown[] = []) {
  h.user = { id: PAT, email: 'pat@example.com', factors };
  h.profile = { id: PAT, role: roles[0], roles, status: 'approved', deactivated: false, full_name: 'Pat Example' };
}
const switchedOn = (on: boolean) => { h.switchRow = { data: { is_on: on }, error: null }; };
const refusal = async (r: { error?: Response }) => (r.error ? { status: r.error.status, body: await r.error.json() } : null);

const OWES_CODE = { status: 403, body: { error: 'Enter the code from your authenticator app to carry on.', twoStep: 'code' } };
const OWES_SETUP = {
  status: 403,
  body: { error: 'Set up two-step sign-in to carry on: your role needs a code from an authenticator app when you sign in.', twoStep: 'setup' },
};

beforeEach(() => {
  h.user = null;
  h.profile = null;
  h.switchThrows = false;
  h.switchReads = 0;
  switchedOn(false);
});

describe('requireAuth and two-step sign-in', () => {
  it('lets in a sign-in that gave its code, without reading the switch', async () => {
    switchedOn(true);
    as(['super_admin'], [app()]);
    const r = await requireAuth(req('aal2'));
    expect(r.error).toBeUndefined();
    expect(r.user.id).toBe(PAT);
    as(['cpa']);
    expect((await requireAuth(req('aal2'))).error).toBeUndefined();
    expect(h.switchReads).toBe(0);
  });

  it('asks anyone with an authenticator app for its code, whatever their role and the switch', async () => {
    for (const roles of [['sales'], ['installer'], ['super_admin'], ['bookkeeper']]) {
      as(roles, [app()]);
      expect(await refusal(await requireAuth(req('aal1'))), roles.join()).toEqual(OWES_CODE);
      expect(await refusal(await requireAuth(req())), roles.join()).toEqual(OWES_CODE);
    }
    expect(h.switchReads).toBe(0);
  });

  it("doesn't count an authenticator app set up but never finished", async () => {
    as(['sales'], [app('unverified')]);
    expect((await requireAuth(req('aal1'))).error).toBeUndefined();
  });

  it('has every money role set an app up first, once the switch is on', async () => {
    switchedOn(true);
    for (const role of ['super_admin', 'executive', 'finance', 'bookkeeper', 'cpa']) {
      as(['admin', role]);
      expect(await refusal(await requireAuth(req('aal1'))), role).toEqual(OWES_SETUP);
    }
    expect(h.switchReads).toBe(5);
  });

  it('asks a money role nothing while the switch is off, or has no row', async () => {
    as(['super_admin']);
    expect((await requireAuth(req('aal1'))).error).toBeUndefined();
    h.switchRow = { data: null, error: null };
    expect((await requireAuth(req('aal1'))).error).toBeUndefined();
    expect(h.switchReads).toBe(2);
  });

  it("asks the rest of the shop nothing, switch on, and doesn't read it for them", async () => {
    switchedOn(true);
    for (const roles of [['admin'], ['sales'], ['shop_tech'], ['customer'], ['installer']]) {
      as(roles);
      expect((await requireAuth(req('aal1'))).error, roles.join()).toBeUndefined();
    }
    expect(h.switchReads).toBe(0);
  });

  it("refuses a money role without an app when the switch can't be read, and never as signed out", async () => {
    as(['finance']);
    h.switchRow = { data: null, error: { message: 'permission denied' } };
    const unknown = { status: 503, body: { error: "FleetSuite couldn't check two-step sign-in just now. Try again in a moment." } };
    expect(await refusal(await requireAuth(req('aal1')))).toEqual(unknown);
    h.switchThrows = true;
    expect(await refusal(await requireAuth(req('aal1')))).toEqual(unknown);
  });

  it('lets in what the code screen itself asks, and only when told to', async () => {
    switchedOn(true);
    as(['super_admin'], [app()]);
    expect((await requireAuth(req('aal1'), { twoStep: false })).error).toBeUndefined();
    expect((await requireAuth(req('aal1'), { twoStep: true })).error?.status).toBe(403);
    as(['executive']);
    expect((await requireAuth(req('aal1'), { twoStep: false })).error).toBeUndefined();
  });

  it('turns a pending or closed account away before asking for any code', async () => {
    as(['super_admin'], [app()]);
    h.profile = { ...h.profile, status: 'pending' };
    expect(await refusal(await requireAuth(req('aal1')))).toEqual({ status: 403, body: { error: 'Forbidden: account not approved' } });
  });

  it('is asked by the walls built on requireAuth, before their own check', async () => {
    as(['sales'], [app()]);
    // A salesperson with an app is asked for the code, not told they aren't a super admin.
    expect(await refusal(await requireSuperAdmin(req('aal1')))).toEqual(OWES_CODE);
    expect(await refusal(await requireSuperAdmin(req('aal2')))).toEqual({ status: 403, body: { error: 'Forbidden: super admin required' } });
    as(['super_admin'], [app()]);
    expect((await requireSuperAdmin(req('aal2'))).error).toBeUndefined();
  });

  it('carries requireFeature’s choice through, for taking a Siri key away', async () => {
    as(['admin', 'super_admin'], [app()]);
    expect(await refusal(await requireFeature(req('aal1'), 'schedule'))).toEqual(OWES_CODE);
    expect((await requireFeature(req('aal1'), 'schedule', { twoStep: false })).error).toBeUndefined();
  });
});
