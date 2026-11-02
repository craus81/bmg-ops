// Two-step sign-in's routes (Books part 87, src/lib/two-step.ts): the code and
// set-up screens' own read, the alert when someone sets an authenticator app
// up, a super admin's Reset on the Users page, and the switch that turns on
// only from a sign-in that gave its own code. Made-up people, apps and tokens;
// nothing is sent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  caller: { id: '', roles: [] as string[], fullName: null as string | null, email: null as string | null, factors: [] as Row[] },
  refusal: null as null | { status: number; body: Row },
  authOpts: [] as unknown[],
  switchRow: { data: { is_on: false } as { is_on: boolean } | null, error: null as { message: string } | null },
  switchThrows: false,
  switchReads: [] as string[],
  upserts: [] as Row[],
  factors: new Map<string, Row[]>(),
  listError: null as null | { message: string },
  deleteFails: new Set<string>(),
  deleted: [] as Array<{ id: string; userId: string }>,
  audit: [] as Row[],
  auditReadError: null as null | { message: string },
  people: new Map<string, Row>(),
  profileError: null as null | { message: string },
  superAdmins: [] as string[],
  watchers: [] as string[],
  sent: [] as Array<{ to: string[]; payload: Row }>,
  notifyThrows: false,
}));

vi.mock('@/lib/api-auth', () => {
  const signedIn = () => ({
    user: { id: h.caller.id, email: h.caller.email, factors: h.caller.factors },
    profile: { id: h.caller.id, roles: h.caller.roles, full_name: h.caller.fullName },
  });
  const refused = () => (h.refusal ? { error: Response.json(h.refusal.body, { status: h.refusal.status }) } : null);
  return {
    requireAuth: vi.fn(async (_req: unknown, opts?: unknown) => { h.authOpts.push(opts); return refused() ?? signedIn(); }),
    requireSuperAdmin: vi.fn(async () => refused()
      ?? (h.caller.roles.includes('super_admin') ? signedIn() : { error: Response.json({ error: 'Forbidden: super admin required' }, { status: 403 }) })),
    requireBooks: vi.fn(async () => ({ error: Response.json({ error: 'not in these tests' }, { status: 500 }) })),
    getAccessToken: (req: Request) => req.headers.get('authorization')?.replace(/^Bearer /, '') ?? null,
    getProfileRoles: (profile: { roles?: string[] } | null) => profile?.roles ?? [],
  };
});

vi.mock('@/lib/supabase-service', () => ({
  createServiceClient: () => ({
    auth: {
      admin: {
        mfa: {
          listFactors: async ({ userId }: { userId: string }) => (h.listError
            ? { data: null, error: h.listError }
            : { data: { factors: h.factors.get(userId) ?? [] }, error: null }),
          deleteFactor: async ({ id, userId }: { id: string; userId: string }) => {
            if (h.deleteFails.has(id)) return { data: null, error: { message: 'factor not removed' } };
            h.deleted.push({ id, userId });
            h.factors.set(userId, (h.factors.get(userId) ?? []).filter((f) => f.id !== id));
            return { data: { id }, error: null };
          },
        },
      },
    },
    from: (table: string) => {
      if (table === 'books_switches') {
        return {
          select: () => ({
            eq: (_column: string, piece: string) => ({
              maybeSingle: async () => {
                h.switchReads.push(piece);
                if (h.switchThrows) throw new Error('fetch failed');
                return h.switchRow;
              },
            }),
          }),
          upsert: async (row: Row) => { h.upserts.push(row); return { error: null }; },
        };
      }
      if (table === 'audit_log') {
        return {
          insert: async (rows: Row[]) => { h.audit.push(...rows); return { error: null }; },
          select: () => {
            const want: Row = {};
            const q: any = {
              eq: (column: string, value: unknown) => { want[column] = value; return q; },
              limit: async (n: number) => (h.auditReadError
                ? { data: null, error: h.auditReadError }
                : { data: h.audit.filter((r) => Object.entries(want).every(([k, v]) => r[k] === v)).slice(0, n).map((_, i) => ({ id: i + 1 })), error: null }),
            };
            return q;
          },
        };
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: (_column: string, id: string) => ({
              maybeSingle: async () => (h.profileError ? { data: null, error: h.profileError } : { data: h.people.get(id) ?? null, error: null }),
            }),
          }),
        };
      }
      throw new Error(`no table ${table} in these tests`);
    },
  }),
}));

vi.mock('@/lib/notify', () => ({
  getSuperAdminIds: vi.fn(async () => [...h.superAdmins]),
  notifyMany: vi.fn(async (to: string[], payload: Row) => {
    if (h.notifyThrows) throw new Error('push service down');
    h.sent.push({ to: [...to], payload });
  }),
}));
vi.mock('@/lib/new-alert-watchers', () => ({ newAlertWatcherIds: vi.fn(async () => [...h.watchers]) }));

import { GET as statusGET, POST as setUpPOST } from '../app/api/auth/two-step/route';
import { GET as adminGET, POST as resetPOST } from '../app/api/admin/two-step/route';
import { POST as switchPOST } from '../app/api/admin/books/switches/route';
import { personName } from './two-step-tell';

const PAT = 'a0000000-0000-4000-8000-000000000001'; // a super admin
const SAM = 'a0000000-0000-4000-8000-000000000002'; // a CPA
const LEE = 'a0000000-0000-4000-8000-000000000003'; // another super admin
const KIM = 'a0000000-0000-4000-8000-000000000004'; // copied on new alerts
const NOW = new Date('2026-11-02T21:00:00.000Z');

/** A made-up access token: only its claims matter here, never its signature. */
const token = (aal?: string) =>
  `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: h.caller.id, ...(aal ? { aal } : {}) })).toString('base64url')}.c2ln`;
const call = (path: string, aal: string | undefined, body?: unknown) => new NextRequest(`https://go.bmgfleet.com${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Authorization: `Bearer ${token(aal)}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

const app = (id: string, at: { created?: string; updated?: string } = {}, status = 'verified', factor_type = 'totp') => ({
  id, factor_type, status, friendly_name: `FleetSuite ${id}`, created_at: at.created ?? '2026-11-02T20:00:00Z', ...(at.updated ? { updated_at: at.updated } : {}),
});

function signedInAs(id: string, roles: string[], factors: Row[] = [], name: string | null = 'Pat Example', email: string | null = 'pat@example.com') {
  h.caller = { id, roles, fullName: name, email, factors };
  h.factors.set(id, factors);
}
const switchedOn = (on: boolean) => { h.switchRow = { data: { is_on: on }, error: null }; };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  signedInAs(PAT, ['admin', 'super_admin']);
  h.refusal = null;
  h.authOpts = [];
  switchedOn(false);
  h.switchThrows = false;
  h.switchReads = [];
  h.upserts = [];
  h.factors = new Map([[PAT, []]]);
  h.listError = null;
  h.deleteFails = new Set();
  h.deleted = [];
  h.audit = [];
  h.auditReadError = null;
  h.people = new Map<string, Row>([
    [PAT, { id: PAT, full_name: 'Pat Example', email: 'pat@example.com' }],
    [SAM, { id: SAM, full_name: 'Sam Example', email: 'sam@example.com' }],
  ]);
  h.profileError = null;
  h.superAdmins = [PAT, LEE];
  h.watchers = [KIM];
  h.sent = [];
  h.notifyThrows = false;
});
afterEach(() => { vi.useRealTimers(); });

describe('GET /api/auth/two-step, what the code and set-up screens ask', () => {
  it('answers a sign-in that still owes its code, and is never kept', async () => {
    signedInAs(PAT, ['admin', 'super_admin'], [app('f-1', { updated: '2026-11-02T20:01:00Z' })]);
    const res = await statusGET(call('/api/auth/two-step', 'aal1'));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await answer(res)).toEqual({
      status: 200,
      body: { need: 'code', level: 'aal1', hasAuthenticator: true, setUpAt: '2026-11-02T20:01:00.000Z', moneyRole: true, switchOn: false },
    });
    // The screens ask before the code is given, so this read doesn't wait for it.
    expect(h.authOpts).toEqual([{ twoStep: false }]);
  });

  it('tells a money role without an app to set one up once the switch is on', async () => {
    switchedOn(true);
    signedInAs(SAM, ['cpa'], [], 'Sam Example', 'sam@example.com');
    expect(await answer(await statusGET(call('/api/auth/two-step', 'aal1')))).toEqual({
      status: 200,
      body: { need: 'setup', level: 'aal1', hasAuthenticator: false, setUpAt: null, moneyRole: true, switchOn: true },
    });
    expect(h.switchReads).toEqual(['two_step_sign_in']);
  });

  it('asks nothing more of a sign-in that gave its code, or of the rest of the shop', async () => {
    switchedOn(true);
    signedInAs(PAT, ['super_admin'], [app('f-1')]);
    expect((await answer(await statusGET(call('/api/auth/two-step', 'aal2')))).body).toMatchObject({ need: null, level: 'aal2', hasAuthenticator: true });
    signedInAs(SAM, ['sales']);
    expect((await answer(await statusGET(call('/api/auth/two-step', 'aal1')))).body).toEqual({
      need: null, level: 'aal1', hasAuthenticator: false, setUpAt: null, moneyRole: false, switchOn: true,
    });
    signedInAs(SAM, ['finance']);
    switchedOn(false);
    expect((await answer(await statusGET(call('/api/auth/two-step', undefined)))).body).toMatchObject({ need: null, level: null, moneyRole: true });
  });

  it('dates the newest finished app and leaves out one never finished', async () => {
    signedInAs(PAT, ['super_admin'], [
      app('f-old', { created: '2026-10-01T09:00:00Z' }),
      app('f-new', { created: '2026-10-31T09:00:00Z', updated: '2026-11-01T10:30:00Z' }),
      app('f-half', { created: '2026-11-02T20:00:00Z', updated: '2026-11-02T20:00:00Z' }, 'unverified'),
      app('f-text', { created: '2026-11-02T20:30:00Z' }, 'verified', 'phone'),
    ]);
    expect((await answer(await statusGET(call('/api/auth/two-step', 'aal1')))).body)
      .toMatchObject({ need: 'code', hasAuthenticator: true, setUpAt: '2026-11-01T10:30:00.000Z' });
  });

  it("won't guess when the switch can't be read", async () => {
    signedInAs(SAM, ['bookkeeper']);
    const unknown = { status: 503, body: { error: "FleetSuite couldn't check two-step sign-in just now. Try again in a moment." } };
    h.switchRow = { data: null, error: { message: 'permission denied' } };
    expect(await answer(await statusGET(call('/api/auth/two-step', 'aal1')))).toEqual(unknown);
    h.switchThrows = true;
    expect(await answer(await statusGET(call('/api/auth/two-step', 'aal1')))).toEqual(unknown);
  });

  it('passes a signed-out caller straight back', async () => {
    h.refusal = { status: 401, body: { error: 'Unauthorized' } };
    expect(await answer(await statusGET(call('/api/auth/two-step', undefined)))).toEqual({ status: 401, body: { error: 'Unauthorized' } });
    expect(h.switchReads).toEqual([]);
  });
});

describe('POST /api/auth/two-step, telling the super admins someone set an app up', () => {
  const setUp = (body: unknown = { action: 'set_up' }) => setUpPOST(call('/api/auth/two-step', 'aal2', body));

  it('tells the other super admins and anyone copied on new alerts, once for each app', async () => {
    signedInAs(PAT, ['admin', 'super_admin'], [app('f-1', { created: '2026-11-02T20:29:00Z', updated: '2026-11-02T20:30:00Z' })]);
    h.watchers = [KIM, LEE];
    expect(await answer(await setUp())).toEqual({ status: 200, body: { told: true } });
    expect(h.authOpts).toEqual([undefined]);
    expect(h.audit).toEqual([{
      actor_id: PAT, table_name: 'auth.mfa_factors', record_id: 'f-1', action: 'two_step_set_up', detail: { authenticators: 1 },
    }]);
    expect(h.sent).toEqual([{
      to: [LEE, KIM],
      payload: {
        type: 'two_step_changed',
        title: 'Two-step sign-in set up',
        body: "Pat Example set up two-step sign-in with an authenticator app. If it wasn't them, reset it on their user.",
        url: `/admin/users?user=${PAT}`,
        channels: ['in_app', 'push', 'email'],
      },
    }]);

    // The same app again (the screen asked twice): nothing more.
    expect(await answer(await setUp())).toEqual({ status: 200, body: { told: false } });
    expect(h.audit).toHaveLength(1);
    expect(h.sent).toHaveLength(1);

    // A new phone: told again, about the new app.
    h.factors.set(PAT, [...(h.factors.get(PAT) ?? []), app('f-2', { created: '2026-11-02T20:55:00Z', updated: '2026-11-02T20:56:00Z' })]);
    expect(await answer(await setUp())).toEqual({ status: 200, body: { told: true } });
    expect(h.audit.map((r) => [r.record_id, r.detail])).toEqual([['f-1', { authenticators: 1 }], ['f-2', { authenticators: 2 }]]);
    expect(h.sent).toHaveLength(2);
  });

  it('reads the apps from Supabase, not from the sign-in', async () => {
    h.caller.factors = [app('f-1', { updated: '2026-11-02T20:30:00Z' })];
    h.factors.set(PAT, []);
    expect(await answer(await setUp())).toEqual({
      status: 400, body: { error: "Two-step sign-in isn't set up yet: enter the code from your authenticator app first." },
    });
    h.factors.set(PAT, [app('f-1', { updated: '2026-11-02T20:30:00Z' }, 'unverified')]);
    expect((await setUp()).status).toBe(400);
    expect(h.audit).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('tells nobody about an app set up more than an hour ago', async () => {
    signedInAs(PAT, ['super_admin'], [app('f-1', { created: '2026-11-02T19:00:00Z', updated: '2026-11-02T19:59:59.999Z' })]);
    expect(await answer(await setUp())).toEqual({ status: 200, body: { told: false } });
    expect(h.audit).toEqual([]);
    expect(h.sent).toEqual([]);
    signedInAs(PAT, ['super_admin'], [app('f-2', { created: '2026-11-02T20:00:00Z' })]);
    expect(await answer(await setUp())).toEqual({ status: 200, body: { told: true } });
  });

  it('dates the newest app by when its first code was taken', async () => {
    signedInAs(PAT, ['super_admin'], [
      app('f-new', { created: '2026-11-02T20:40:00Z', updated: '2026-11-02T20:41:00Z' }),
      app('f-old', { created: '2026-09-01T10:00:00Z', updated: '2026-09-01T10:01:00Z' }),
    ]);
    expect(await answer(await setUp())).toEqual({ status: 200, body: { told: true } });
    expect(h.audit.map((r) => r.record_id)).toEqual(['f-new']);
  });

  it('leaves out whoever set it up, and names them by email when there is no name', async () => {
    signedInAs(SAM, ['cpa'], [app('f-1', { updated: '2026-11-02T20:50:00Z' })], null, 'sam@example.com');
    h.superAdmins = [PAT];
    h.watchers = [SAM, KIM];
    await setUp();
    expect(h.sent).toEqual([expect.objectContaining({ to: [PAT, KIM] })]);
    expect(h.sent[0].payload.body).toBe("sam@example.com set up two-step sign-in with an authenticator app. If it wasn't them, reset it on their user.");
  });

  it('sends nothing when there is nobody else to tell', async () => {
    signedInAs(PAT, ['super_admin'], [app('f-1', { updated: '2026-11-02T20:30:00Z' })]);
    h.superAdmins = [PAT];
    h.watchers = [PAT];
    expect(await answer(await setUp())).toEqual({ status: 200, body: { told: true } });
    expect(h.sent).toEqual([]);
  });

  it("is still set up when the alert can't be sent", async () => {
    signedInAs(PAT, ['super_admin'], [app('f-1', { updated: '2026-11-02T20:30:00Z' })]);
    h.notifyThrows = true;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await answer(await setUp())).toEqual({ status: 200, body: { told: true } });
    expect(h.audit).toHaveLength(1);
    expect(quiet).toHaveBeenCalledWith('[two-step] alert not sent: push service down');
    quiet.mockRestore();
  });

  it("stops when Supabase or the audit log can't be read, and tells nobody", async () => {
    signedInAs(PAT, ['super_admin'], [app('f-1', { updated: '2026-11-02T20:30:00Z' })]);
    h.listError = { message: 'auth admin down' };
    expect(await answer(await setUp())).toEqual({ status: 500, body: { error: 'auth admin down' } });
    h.listError = null;
    h.auditReadError = { message: 'audit read failed' };
    expect(await answer(await setUp())).toEqual({ status: 500, body: { error: 'audit read failed' } });
    expect(h.audit).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('needs a sign-in that gave its code, and only the one action', async () => {
    signedInAs(PAT, ['super_admin'], [app('f-1', { updated: '2026-11-02T20:30:00Z' })]);
    h.refusal = { status: 403, body: { error: 'Enter the code from your authenticator app to carry on.', twoStep: 'code' } };
    expect((await setUp()).status).toBe(403);
    h.refusal = null;
    expect((await answer(await setUp({ action: 'reset' }))).status).toBe(400);
    expect(h.audit).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});

describe('GET /api/admin/two-step, the Users page row', () => {
  it("shows a super admin whether someone set an app up, and since when", async () => {
    h.factors.set(SAM, [app('f-1', { created: '2026-10-20T15:00:00Z', updated: '2026-10-20T15:02:00Z' }), app('f-2', {}, 'unverified')]);
    const res = await adminGET(call(`/api/admin/two-step?userId=${SAM}`, 'aal2'));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await answer(res)).toEqual({ status: 200, body: { hasAuthenticator: true, setUpAt: '2026-10-20T15:02:00.000Z' } });
    h.factors.set(SAM, [app('f-2', {}, 'unverified')]);
    expect((await answer(await adminGET(call(`/api/admin/two-step?userId=${SAM}`, 'aal2')))).body).toEqual({ hasAuthenticator: false, setUpAt: null });
  });

  it('is for super admins, about one real user', async () => {
    expect(await answer(await adminGET(call('/api/admin/two-step?userId=sam', 'aal2')))).toEqual({ status: 400, body: { error: 'Which user?' } });
    expect((await adminGET(call('/api/admin/two-step', 'aal2'))).status).toBe(400);
    h.listError = { message: 'auth admin down' };
    expect(await answer(await adminGET(call(`/api/admin/two-step?userId=${SAM}`, 'aal2')))).toEqual({ status: 500, body: { error: 'auth admin down' } });
    signedInAs(SAM, ['admin', 'finance']);
    expect((await adminGET(call(`/api/admin/two-step?userId=${PAT}`, 'aal2'))).status).toBe(403);
  });
});

describe('POST /api/admin/two-step, Reset', () => {
  const reset = (userId: string) => resetPOST(call('/api/admin/two-step', 'aal2', { userId }));

  it("takes every app away from someone else, audits it, and tells the others and the person", async () => {
    h.factors.set(SAM, [app('f-1'), app('f-2', {}, 'unverified')]);
    h.watchers = [KIM, SAM];
    expect(await answer(await reset(SAM))).toEqual({ status: 200, body: { reset: true, removed: 2 } });
    expect(h.deleted).toEqual([{ id: 'f-1', userId: SAM }, { id: 'f-2', userId: SAM }]);
    expect(h.audit).toEqual([{
      actor_id: PAT, table_name: 'auth.mfa_factors', record_id: SAM, action: 'two_step_reset',
      detail: { person: 'Sam Example', authenticators: 1, removed: 2, of: 2 },
    }]);
    expect(h.sent).toEqual([
      {
        to: [LEE, KIM],
        payload: {
          type: 'two_step_changed',
          title: 'Two-step sign-in reset',
          body: "Pat Example reset Sam Example's two-step sign-in, so Sam Example was signed out everywhere and signs in again with their password.",
          url: `/admin/users?user=${SAM}`,
          channels: ['in_app', 'push', 'email'],
        },
      },
      {
        to: [SAM],
        payload: {
          type: 'two_step_changed',
          title: 'Your two-step sign-in was reset',
          body: 'Pat Example reset your two-step sign-in, so you were signed out everywhere. Sign in with your password, and set it up again in Settings → Two-step sign-in, or when FleetSuite asks.',
          url: '/settings#two-step',
          channels: ['in_app', 'push', 'email'],
        },
      },
    ]);
  });

  it('resets your own and tells the others, not you twice', async () => {
    h.factors.set(PAT, [app('f-9')]);
    h.watchers = [KIM, PAT];
    expect(await answer(await reset(PAT))).toEqual({ status: 200, body: { reset: true, removed: 1 } });
    expect(h.sent).toEqual([{
      to: [LEE, KIM],
      payload: expect.objectContaining({ title: 'Two-step sign-in reset', body: 'Pat Example reset their own two-step sign-in, so they were signed out everywhere.', url: `/admin/users?user=${PAT}` }),
    }]);
  });

  it('says so when one app is left, keeping the record of the one that went', async () => {
    h.factors.set(SAM, [app('f-1'), app('f-2'), app('f-3')]);
    h.deleteFails = new Set(['f-2']);
    expect(await answer(await reset(SAM))).toEqual({
      status: 500, body: { error: "Couldn't reset Sam Example's two-step sign-in: factor not removed. Try again." },
    });
    expect(h.deleted).toEqual([{ id: 'f-1', userId: SAM }]);
    expect(h.audit).toEqual([expect.objectContaining({ action: 'two_step_reset', detail: { person: 'Sam Example', authenticators: 3, removed: 1, of: 3 } })]);
    expect(h.sent).toEqual([]);

    // Try again: the two left go.
    h.deleteFails = new Set();
    expect(await answer(await reset(SAM))).toEqual({ status: 200, body: { reset: true, removed: 2 } });
  });

  it("writes nothing when the first app won't go", async () => {
    h.factors.set(SAM, [app('f-1')]);
    h.deleteFails = new Set(['f-1']);
    expect((await reset(SAM)).status).toBe(500);
    expect(h.audit).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("refuses someone with nothing to reset, someone who isn't there, and a made-up id", async () => {
    expect(await answer(await reset(SAM))).toEqual({ status: 409, body: { error: "Sam Example hasn't set up two-step sign-in." } });
    h.people.set(SAM, { id: SAM, full_name: null, email: null });
    expect((await answer(await reset(SAM))).body).toEqual({ error: "Someone hasn't set up two-step sign-in." });
    expect(await answer(await reset(LEE))).toEqual({ status: 404, body: { error: "There's no such user." } });
    expect((await reset('not-a-user')).status).toBe(400);
    h.profileError = { message: 'profiles read failed' };
    expect(await answer(await reset(SAM))).toEqual({ status: 500, body: { error: 'profiles read failed' } });
    h.profileError = null;
    h.factors.set(SAM, [app('f-1')]);
    h.listError = { message: 'auth admin down' };
    expect(await answer(await reset(SAM))).toEqual({ status: 500, body: { error: 'auth admin down' } });
    expect(h.deleted).toEqual([]);
    expect(h.audit).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('is for super admins only', async () => {
    signedInAs(SAM, ['admin', 'executive']);
    h.factors.set(PAT, [app('f-1')]);
    expect(await answer(await reset(PAT))).toEqual({ status: 403, body: { error: 'Forbidden: super admin required' } });
    expect(h.deleted).toEqual([]);
  });

  it("still resets when the alerts can't be sent", async () => {
    h.factors.set(SAM, [app('f-1')]);
    h.notifyThrows = true;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await answer(await reset(SAM))).toEqual({ status: 200, body: { reset: true, removed: 1 } });
    expect(quiet).toHaveBeenCalledWith('[two-step] alert not sent: push service down');
    expect(quiet).toHaveBeenCalledWith('[two-step] reset notice not sent: push service down');
    quiet.mockRestore();
  });
});

describe('Books → Switches and Two-step sign-in for money roles', () => {
  const flip = (piece: string, on: boolean, aal?: string) => switchPOST(call('/api/admin/books/switches', aal, { piece, on }));
  const NEEDS_CODE = {
    status: 409,
    body: { error: 'Set up two-step sign-in for yourself first (Settings → Two-step sign-in), then switch it on: it switches on only from a sign-in that gave its own code.' },
  };

  it('switches on only from a sign-in that gave its own code', async () => {
    expect(await answer(await flip('two_step_sign_in', true, 'aal1'))).toEqual(NEEDS_CODE);
    expect(await answer(await flip('two_step_sign_in', true))).toEqual(NEEDS_CODE);
    expect(h.upserts).toEqual([]);
    expect(h.audit).toEqual([]);

    expect(await answer(await flip('two_step_sign_in', true, 'aal2'))).toEqual({ status: 200, body: { piece: 'two_step_sign_in', on: true } });
    expect(h.upserts).toEqual([expect.objectContaining({ piece: 'two_step_sign_in', is_on: true, changed_by: PAT })]);
    expect(h.audit).toEqual([expect.objectContaining({ actor_id: PAT, table_name: 'books_switches', record_id: 'two_step_sign_in', action: 'switch_on' })]);
  });

  it('switches off from any sign-in, and leaves the other switches as they were', async () => {
    expect((await flip('two_step_sign_in', false, 'aal1')).status).toBe(200);
    expect((await flip('money_screens', true, 'aal1')).status).toBe(200);
    expect(h.upserts.map((r) => [r.piece, r.is_on])).toEqual([['two_step_sign_in', false], ['money_screens', true]]);
  });
});

describe('personName', () => {
  it("is someone's name, else their email, else Someone", () => {
    expect(personName({ full_name: ' Pat Example ', email: 'pat@example.com' })).toBe('Pat Example');
    expect(personName({ full_name: '  ', email: ' pat@example.com ' })).toBe('pat@example.com');
    expect(personName({ full_name: null, email: null })).toBe('Someone');
    expect(personName(null)).toBe('Someone');
  });
});
