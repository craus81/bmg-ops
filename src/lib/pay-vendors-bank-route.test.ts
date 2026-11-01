// /api/pay-vendors/bank (src/lib/vendor-bank.ts, src/lib/vendor-bank-lock.ts):
// super admins only; nothing kept until VENDOR_BANK_KEY is there; a vendor's
// numbers entered locked, once a press, one set waiting a vendor; confirmed
// only by a super admin who didn't enter them, on a call-back that reads what
// was entered, with a try counted for each that doesn't and the third
// refusing them; refused and removed with why; sets changed outside
// FleetSuite called out and not confirmed; every alert to the other super
// admins and whoever's copied on new alerts, never to whoever did it; and the
// account number itself never back in an answer, an audit or an alert, only
// the four digits it ends with. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const ENTERER = 'd0000000-0000-4000-8000-000000000001';
const CALLER = 'd0000000-0000-4000-8000-000000000002';
const WATCHER = 'd0000000-0000-4000-8000-000000000003';
const STAFF = 'd0000000-0000-4000-8000-000000000004';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    userId: '',
    roles: [] as string[],
    superAdmins: [] as string[],
    watchers: [] as string[],
    tables: {} as Record<string, Record<string, any>[]>,
    rpcs: [] as Array<[string, Record<string, any>]>,
    /** Functions that fail, with why. */
    rpcErrors: {} as Record<string, string>,
    /** Functions that answer this instead: what another press made of the set in between. */
    rpcAnswers: {} as Record<string, unknown>,
  };
  const rows = (table: string) => (state.tables[table] ??= []);

  /** An ilike pattern as a test: % for anything, any case. */
  const ilike = (pattern: string) => new RegExp(`^${pattern.split('%').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');

  // An in-memory stand-in for the tables the route reads.
  function query(table: string) {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    const sorts: Array<[string, boolean]> = [];
    let limit = Infinity;
    const run = () => {
      const matched = rows(table).filter((r) => filters.every((f) => f(r)));
      const sorted = [...matched].sort((a, b) => {
        for (const [c, up] of sorts) {
          const d = String(a[c]).localeCompare(String(b[c]), 'en', { numeric: true });
          if (d !== 0) return up ? d : -d;
        }
        return 0;
      });
      return { data: sorted.slice(0, limit).map((r) => structuredClone(r)), error: null };
    };
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
      gte: (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return builder; },
      or: (spec: string) => {
        const tests = spec.split(',').map((part) => {
          const [c, op, ...rest] = part.split('.');
          if (op !== 'ilike') throw new Error(`the fake has no or(${op})`);
          const re = ilike(rest.join('.'));
          return (r: Record<string, any>) => re.test(String(r[c] ?? ''));
        });
        filters.push((r) => tests.some((t) => t(r)));
        return builder;
      },
      order: (c: string, o?: { ascending?: boolean }) => { sorts.push([c, o?.ascending !== false]); return builder; },
      limit: (n: number) => { limit = n; return builder; },
      maybeSingle: async () => ({ data: (run().data as any[])[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  // Migration 490's functions, as it has them, on the in-memory table.
  const banks = () => rows('vendor_bank_accounts');
  const now = () => new Date().toISOString();
  const ok = (data: unknown) => ({ data, error: null });
  const rpcs: Record<string, (p: Record<string, any>) => { data: unknown; error: { message: string } | null }> = {
    vendor_bank_enter: ({ p }) => {
      const had = banks().find((r) => r.id === p.id);
      if (had) return ok(had.vendor_netsuite_id === p.vendor_netsuite_id ? { state: 'entered', fresh: false } : { state: 'taken' });
      if (banks().some((r) => r.vendor_netsuite_id === p.vendor_netsuite_id && r.status === 'pending')) return ok({ state: 'waiting' });
      banks().push({
        id: p.id, vendor_netsuite_id: p.vendor_netsuite_id, vendor_name: p.vendor_name || null, routing_number: p.routing_number,
        account_last4: p.account_last4, account_type: p.account_type, name_on_account: p.name_on_account.trim(), source: p.source.trim(),
        account_locked: p.account_locked, status: 'pending', tries: 0, entered_by: p.by || null, entered_at: now(), confirmed_by: null,
        confirmed_at: null, called_phone: null, spoke_with: null, confirm_seal: null, ended_by: null, ended_at: null, ended_why: null,
      });
      return ok({ state: 'entered', fresh: true });
    },
    vendor_bank_mismatch: ({ p }) => {
      const r = banks().find((x) => x.id === p.id);
      if (!r) return ok({ state: 'gone' });
      if (r.status !== 'pending') return ok({ state: r.status });
      if (!p.by || p.by === r.entered_by) return ok({ state: 'same_person' });
      if (r.tries >= 2) {
        Object.assign(r, {
          tries: 3, status: 'refused', account_locked: null, ended_by: p.by, ended_at: now(),
          ended_why: "The numbers read on three call-backs didn't match what was entered.",
        });
        return ok({ state: 'refused', tries: 3 });
      }
      r.tries += 1;
      return ok({ state: 'tried', tries: r.tries });
    },
    vendor_bank_confirm: ({ p }) => {
      const r = banks().find((x) => x.id === p.id);
      if (!r) return ok({ state: 'gone' });
      if (r.status !== 'pending') return ok({ state: r.status });
      if (!p.by || p.by === r.entered_by) return ok({ state: 'same_person' });
      const before = banks().find((x) => x.vendor_netsuite_id === r.vendor_netsuite_id && x.status === 'confirmed');
      if (before) Object.assign(before, { status: 'replaced', account_locked: null, confirm_seal: null, ended_by: p.by, ended_at: now() });
      Object.assign(r, {
        status: 'confirmed', confirmed_by: p.by, confirmed_at: now(), called_phone: p.called_phone.trim(), spoke_with: p.spoke_with.trim(),
        confirm_seal: p.confirm_seal,
      });
      return ok({ state: 'confirmed', replaced: before?.id ?? null });
    },
    vendor_bank_end: ({ p }) => {
      if (!['refused', 'removed'].includes(p.status)) return { data: null, error: { message: `vendor_bank_end refuses or removes, not ${p.status}` } };
      const r = banks().find((x) => x.id === p.id);
      if (!r) return ok({ state: 'gone' });
      if (r.status !== (p.status === 'refused' ? 'pending' : 'confirmed')) return ok({ state: r.status });
      Object.assign(r, { status: p.status, account_locked: null, confirm_seal: null, ended_by: p.by || null, ended_at: now(), ended_why: p.why.trim() });
      return ok({ state: p.status });
    },
  };
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.rpcs.push([fn, structuredClone(args)]);
      if (state.rpcErrors[fn]) return { data: null, error: { message: state.rpcErrors[fn] } };
      if (fn in state.rpcAnswers) return { data: state.rpcAnswers[fn], error: null };
      return rpcs[fn] ? rpcs[fn](args) : { data: null, error: { message: `nothing answers ${fn}` } };
    },
  };
  return { state, service };
});

vi.mock('@/lib/api-auth', () => ({
  requireSuperAdmin: vi.fn(async () => (h.state.roles.includes('super_admin')
    ? { user: { id: h.state.userId }, profile: { roles: h.state.roles } }
    : { error: new Response('Forbidden', { status: 403 }) })),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/notify', () => ({
  getSuperAdminIds: vi.fn(async (exclude?: string | null) => h.state.superAdmins.filter((id) => id !== exclude)),
  notifyMany: vi.fn(async () => {}),
}));
vi.mock('@/lib/new-alert-watchers', () => ({ newAlertWatcherIds: vi.fn(async () => h.state.watchers) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));

const { state } = h;

import { logAudit } from '@/lib/audit';
import { notifyMany } from '@/lib/notify';
import { GET, POST } from '../app/api/pay-vendors/bank/route';
import { KEY_BAD, KEY_MISSING, bankKey, confirmSeal, confirmSealHolds, lockNumbers, openNumbers, type BankKey } from './vendor-bank-lock';
import type { BankNumbers } from './vendor-bank';

const RAW = Buffer.alloc(32, 7).toString('base64');
const OTHER_RAW = Buffer.alloc(32, 9).toString('base64');
const keyOf = (raw: string) => (bankKey(raw) as { key: BankKey }).key;
const KEY = keyOf(RAW);

const ROW = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OZARK = '31';
const GATEWAY = '52';
const ACCOUNT = '123456789012';
const OZARK_NUMBERS: BankNumbers = { routing: '123456780', account: ACCOUNT, type: 'checking' };
const NOW = '2026-11-01T17:00:00.000Z';

const ENTRY = {
  action: 'enter', id: ROW(1), vendorId: OZARK, routing: '123 456 780', account: '1234 5678-9012', accountAgain: '123456789012',
  type: 'checking', name: 'OZARK HOSE & FITTING', source: 'ACH form emailed by Dana at Ozark, 10/30',
};
const CALL = { phone: '(636) 555-0142', spokeWith: 'Dana in accounts', routing: '123456780', account: '1234-5678-9012', type: 'checking' };

/** A set as migration 490 keeps it, locked with `key` for its vendor and row. */
function bankRow(id: string, vendorId: string, status: string, over: Record<string, unknown> = {}, numbers = OZARK_NUMBERS, key = KEY) {
  const live = status === 'pending' || status === 'confirmed';
  return {
    id, vendor_netsuite_id: vendorId, vendor_name: vendorId === OZARK ? 'Ozark Hose & Fitting' : 'Gateway Truck Parts', routing_number: numbers.routing,
    account_last4: numbers.account.slice(-4), account_type: numbers.type, name_on_account: 'OZARK HOSE & FITTING', source: 'ACH form from Dana',
    account_locked: live ? lockNumbers(key, numbers, vendorId, id) : null, status, tries: 0, entered_by: ENTERER, entered_at: '2026-10-30T15:00:00.000Z',
    confirmed_by: status === 'pending' || status === 'refused' ? null : CALLER, confirmed_at: status === 'pending' || status === 'refused' ? null : '2026-10-30T16:00:00.000Z',
    called_phone: status === 'pending' || status === 'refused' ? null : '636-555-0142', spoke_with: status === 'pending' || status === 'refused' ? null : 'Dana',
    confirm_seal: status === 'confirmed' ? confirmSeal(key, vendorId, id) : null,
    ended_by: live ? null : CALLER, ended_at: live ? null : '2026-10-31T10:00:00.000Z',
    ended_why: status === 'refused' || status === 'removed' ? 'Ozark never changed banks' : null,
    ...over,
  };
}

const get = (query = '') => GET(new NextRequest(`https://app.test/api/pay-vendors/bank${query ? `?${query}` : ''}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/pay-vendors/bank', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const as = (userId: string, roles: string[] = ['super_admin']) => { state.userId = userId; state.roles = roles; };
const banks = () => state.tables.vendor_bank_accounts ?? [];
const bank = (id: string) => banks().find((r) => r.id === id)!;
const rpcNames = () => state.rpcs.map(([fn]) => fn);
const audits = () => vi.mocked(logAudit).mock.calls.map(([, entry]) => entry as any);
const alerts = () => vi.mocked(notifyMany).mock.calls.map(([to, alert]) => ({ to, ...(alert as any) }));
const confirm = (id: string, over: Record<string, unknown> = {}) => post({ action: 'confirm', id, ...CALL, ...over });

/** Everything an answer, the audits and the alerts said, to look through for the account number. */
const said = (answer: unknown) => [JSON.stringify(answer), JSON.stringify(audits()), JSON.stringify(alerts())].join('\n');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.mocked(logAudit).mockClear();
  vi.mocked(notifyMany).mockReset().mockResolvedValue(undefined);
  vi.stubEnv('VENDOR_BANK_KEY', RAW);
  as(ENTERER);
  state.superAdmins = [ENTERER, CALLER];
  state.watchers = [WATCHER, CALLER];
  state.rpcs.length = 0;
  state.rpcErrors = {};
  state.rpcAnswers = {};
  state.tables = {
    profiles: [
      { id: ENTERER, full_name: 'Pat Admin' }, { id: CALLER, full_name: 'Lee Owner' }, { id: WATCHER, full_name: 'Sam Watcher' },
    ],
    netsuite_vendors: [
      { netsuite_id: OZARK, company_name: 'Ozark Hose & Fitting', entity_id: 'V-OZARK', phone: '636-555-0142', is_inactive: false },
      { netsuite_id: GATEWAY, company_name: 'Gateway Truck Parts', entity_id: 'V-GATE', phone: null, is_inactive: false },
      { netsuite_id: '77', company_name: 'Ozark Old Supply', entity_id: 'V-OZ-OLD', phone: '417-555-0100', is_inactive: true },
    ],
    detail_changes: [],
    vendor_bank_accounts: [],
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('who can use it', () => {
  it('is super admins only, to read and to change', async () => {
    as(STAFF, ['admin']);
    expect((await get()).status).toBe(403);
    expect((await get('find=ozark')).status).toBe(403);
    expect((await post(ENTRY)).status).toBe(403);
    expect(state.rpcs).toEqual([]);
  });
});

describe('the key', () => {
  it('says what VENDOR_BANK_KEY needs, and keeps nothing without it', async () => {
    vi.stubEnv('VENDOR_BANK_KEY', '');
    expect((await (await get()).json()).keyProblem).toBe(KEY_MISSING);
    const res = await post(ENTRY);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(KEY_MISSING);

    vi.stubEnv('VENDOR_BANK_KEY', 'not a key');
    expect((await (await get()).json()).keyProblem).toBe(KEY_BAD);
    expect((await post(ENTRY)).status).toBe(503);
    as(CALLER);
    state.tables.vendor_bank_accounts = [bankRow(ROW(2), OZARK, 'pending')];
    expect((await confirm(ROW(2))).status).toBe(503);
    expect(rpcNames()).toEqual([]);
    expect(banks()).toHaveLength(1);
  });

  it('reads none of it once the key is there', async () => {
    expect((await (await get()).json()).keyProblem).toBeNull();
  });
});

describe('entering numbers', () => {
  it('keeps them locked, waiting for a call-back, and tells the other super admins and whoever is copied', async () => {
    const res = await post(ENTRY);
    expect(res.status).toBe(200);
    const answer = await res.json();
    expect(answer).toEqual({ success: true });

    const row = bank(ROW(1));
    expect(row).toMatchObject({
      vendor_netsuite_id: OZARK, vendor_name: 'Ozark Hose & Fitting', routing_number: '123456780', account_last4: '9012', account_type: 'checking',
      name_on_account: 'OZARK HOSE & FITTING', source: 'ACH form emailed by Dana at Ozark, 10/30', status: 'pending', tries: 0, entered_by: ENTERER,
    });
    // What's locked is what was typed, spaces and dashes left out, and it opens only for this vendor and row.
    expect(openNumbers(KEY, row.account_locked, OZARK, ROW(1))).toEqual({ numbers: OZARK_NUMBERS });
    expect(openNumbers(KEY, row.account_locked, GATEWAY, ROW(1))).toEqual({ problem: 'broken' });
    expect(openNumbers(KEY, row.account_locked, OZARK, ROW(9))).toEqual({ problem: 'broken' });
    expect(row.account_locked).not.toContain(ACCOUNT);

    expect(audits()).toEqual([{
      actorId: ENTERER, table: 'vendor_bank_accounts', recordId: ROW(1), action: 'enter',
      detail: { vendor_id: OZARK, vendor: 'Ozark Hose & Fitting', routing: '123456780', account_ending: '9012', type: 'checking' },
    }]);
    expect(alerts()).toEqual([{
      to: [CALLER, WATCHER],
      type: 'books_vendor_bank_waiting',
      title: 'Bank numbers entered for Ozark Hose & Fitting',
      body: 'Pat Admin entered new bank numbers for Ozark Hose & Fitting (ACH form emailed by Dana at Ozark, 10/30). Before anything is paid to them, '
        + 'another super admin calls Ozark Hose & Fitting on a number BMG already had and confirms them.',
      url: '/admin/pay-vendors?bank=31',
      channels: ['in_app', 'push', 'email'],
    }]);
    // The account's last five digits, which anything showing more of it than the four it ends with shows.
    expect(said(answer)).not.toContain('89012');
  });

  it('keeps the same press once, and a press used for another vendor not at all', async () => {
    await post(ENTRY);
    const again = await post(ENTRY);
    expect(again.status).toBe(200);
    expect(banks()).toHaveLength(1);
    expect(audits()).toHaveLength(1);
    expect(alerts()).toHaveLength(1);

    const taken = await post({ ...ENTRY, vendorId: GATEWAY });
    expect(taken.status).toBe(409);
    expect((await taken.json()).error).toBe('That form was used for another vendor: close it and enter them again.');
    expect(banks()).toHaveLength(1);
  });

  it("doesn't take a second set while one waits for the vendor", async () => {
    await post(ENTRY);
    const res = await post({ ...ENTRY, id: ROW(2), account: '99887766', accountAgain: '99887766' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Ozark Hose & Fitting has bank numbers waiting for a call-back already: confirm or refuse those first.');
    expect(banks().map((r) => r.id)).toEqual([ROW(1)]);
    expect(audits()).toHaveLength(1);
  });

  it('says every problem with what was typed, and keeps nothing', async () => {
    const res = await post({ ...ENTRY, routing: '123456789', accountAgain: '123456789013', type: '', source: 'Read to me as 1234 5678 9012' });
    expect(res.status).toBe(400);
    const answer = await res.json();
    expect(answer.problems).toEqual([
      "123456789 isn't a routing number: its last digit doesn't check, so a digit is likely wrong.",
      "The account number typed again doesn't match.",
      'Pick checking or savings.',
      "Leave account numbers out of where the numbers came from: they're only ever kept locked. A phone can go in as 636-555-0142.",
    ]);
    expect(answer.error).toBe(answer.problems[0]);
    expect(state.rpcs).toEqual([]);
    expect(said(answer)).not.toContain('89012');
  });

  it("needs a vendor in FleetSuite's copy of NetSuite's vendors", async () => {
    const res = await post({ ...ENTRY, vendorId: '404' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("FleetSuite's copy of NetSuite's vendors has no vendor 404.");
    expect(state.rpcs).toEqual([]);
  });

  it("says when the table won't keep them, and tells nobody", async () => {
    state.rpcErrors.vendor_bank_enter = 'connection reset';
    const res = await post(ENTRY);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Couldn't keep them (connection reset).");
    expect(audits()).toEqual([]);
    expect(alerts()).toEqual([]);
  });

  it('keeps them when an alert fails to go', async () => {
    vi.mocked(notifyMany).mockRejectedValueOnce(new Error('push is down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(ENTRY);
    expect(res.status).toBe(200);
    expect(bank(ROW(1)).status).toBe('pending');
    expect(logged).toHaveBeenCalledWith('[vendor-bank] alert books_vendor_bank_waiting not sent: push is down');
    logged.mockRestore();
  });

  it('tells nobody when no one else is a super admin or copied', async () => {
    state.superAdmins = [ENTERER];
    state.watchers = [ENTERER];
    await post(ENTRY);
    expect(alerts()).toEqual([]);
  });
});

describe('confirming on a call-back', () => {
  beforeEach(() => {
    state.tables.vendor_bank_accounts = [bankRow(ROW(1), OZARK, 'pending')];
    as(CALLER);
  });

  it('confirms what the vendor read when it matches, sealed, and tells the others', async () => {
    const res = await confirm(ROW(1), { phone: ' (636) 555-0142 ', spokeWith: ' Dana in accounts ' });
    expect(res.status).toBe(200);
    const answer = await res.json();
    expect(answer).toEqual({ success: true, replaced: null });
    const row = bank(ROW(1));
    expect(row).toMatchObject({ status: 'confirmed', confirmed_by: CALLER, called_phone: '(636) 555-0142', spoke_with: 'Dana in accounts' });
    expect(confirmSealHolds(KEY, row.confirm_seal, OZARK, ROW(1))).toBe(true);
    expect(state.rpcs.find(([fn]) => fn === 'vendor_bank_confirm')?.[1].p).toMatchObject({ called_phone: '(636) 555-0142', spoke_with: 'Dana in accounts' });
    expect(audits()).toEqual([{
      actorId: CALLER, table: 'vendor_bank_accounts', recordId: ROW(1), action: 'confirm',
      detail: {
        vendor_id: OZARK, vendor: 'Ozark Hose & Fitting', routing: '123456780', account_ending: '9012', type: 'checking',
        called: '(636) 555-0142', spoke_with: 'Dana in accounts', replaced: null,
      },
    }]);
    expect(alerts()).toEqual([{
      to: [ENTERER, WATCHER],
      type: 'books_vendor_bank_decided',
      title: 'Bank numbers confirmed for Ozark Hose & Fitting',
      body: 'Lee Owner called Ozark Hose & Fitting on (636) 555-0142, and Dana in accounts read out the bank numbers Pat Admin entered.',
      url: '/admin/pay-vendors?bank=31',
      channels: ['in_app', 'push', 'email'],
    }]);
    expect(said(answer)).not.toContain('89012');
  });

  it('replaces the numbers the vendor had confirmed before', async () => {
    state.tables.vendor_bank_accounts.push(bankRow(ROW(5), OZARK, 'confirmed', {}, { routing: '123456780', account: '55554444', type: 'savings' }));
    const res = await confirm(ROW(1));
    expect(await res.json()).toEqual({ success: true, replaced: ROW(5) });
    expect(bank(ROW(5))).toMatchObject({ status: 'replaced', account_locked: null, confirm_seal: null, ended_by: CALLER });
    expect(audits()[0].detail.replaced).toBe(ROW(5));
    expect(alerts()[0].body).toMatch(/entered\. They replace the ones confirmed before\.$/);
  });

  it('is never confirmed by whoever entered them', async () => {
    as(ENTERER);
    const res = await confirm(ROW(1));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Someone other than whoever entered them confirms them on a call-back.');
    expect(rpcNames()).toEqual([]);
    expect(bank(ROW(1)).status).toBe('pending');
  });

  it("counts a call-back that didn't match, says which part, and refuses them on the third", async () => {
    const first = await confirm(ROW(1), { account: '123456789013' });
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual({
      error: "The account number they read doesn't match what was entered, so nothing changed: 2 more tries before they're refused.", tries: 1,
    });
    const second = await confirm(ROW(1), { routing: '021000021', type: 'savings' });
    expect((await second.json()).error)
      .toBe("The routing number and checking or savings they read don't match what was entered, so nothing changed: one more try before they're refused.");
    expect(bank(ROW(1))).toMatchObject({ status: 'pending', tries: 2 });
    expect(audits().map((a) => [a.action, a.detail.differs, a.detail.tries])).toEqual([
      ['call_back_mismatch', ['account number'], 1], ['call_back_mismatch', ['routing number', 'checking or savings'], 2],
    ]);
    expect(alerts()).toEqual([]);

    const third = await confirm(ROW(1), { account: '1234' });
    expect(third.status).toBe(409);
    const answer = await third.json();
    expect(answer).toEqual({
      error: "That's three call-backs that didn't match, so these numbers are refused and nothing will be paid to them. Enter them again from Ozark Hose & Fitting's form.",
      refused: true,
    });
    expect(bank(ROW(1))).toMatchObject({ status: 'refused', tries: 3, account_locked: null });
    expect(audits()[2]).toMatchObject({ action: 'refuse', detail: { differs: ['account number'], why: 'three call-backs', account_ending: '9012' } });
    expect(alerts()).toEqual([expect.objectContaining({
      to: [ENTERER, WATCHER],
      type: 'books_vendor_bank_decided',
      title: 'Bank numbers refused for Ozark Hose & Fitting',
      body: "The numbers read on three call-backs to Ozark Hose & Fitting didn't match the ones Pat Admin entered, so they're refused and nothing will "
        + "be paid to them. If Ozark Hose & Fitting didn't send new numbers, someone may be trying to have BMG pay them instead.",
    })]);
    expect(rpcNames()).not.toContain('vendor_bank_confirm');
    expect(said(answer)).not.toContain('89012');
  });

  it("doesn't count a call-back typed wrong as one that didn't match", async () => {
    const res = await confirm(ROW(1), { phone: '555-0142', spokeWith: '', account: '12' });
    expect(res.status).toBe(400);
    expect((await res.json()).problems).toEqual([
      '555-0142 is too short to be a phone number: type it with its area code.', 'Say who read them out.', 'An account number has 4 to 17 digits; that has 2.',
    ]);
    expect(rpcNames()).toEqual([]);
    expect(bank(ROW(1)).tries).toBe(0);
  });

  it('only confirms numbers waiting', async () => {
    state.tables.vendor_bank_accounts = [bankRow(ROW(1), OZARK, 'confirmed'), bankRow(ROW(2), GATEWAY, 'refused')];
    expect(await (await confirm(ROW(1))).json()).toEqual({ error: "They're confirmed already." });
    expect(await (await confirm(ROW(2))).json()).toEqual({ error: 'They were refused.' });
    const gone = await confirm(ROW(3));
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toBe('FleetSuite has no such bank numbers: reload.');
    expect(rpcNames()).toEqual([]);
  });

  it("doesn't confirm a set changed outside FleetSuite", async () => {
    // What it shows moved off what's locked.
    state.tables.vendor_bank_accounts = [bankRow(ROW(1), OZARK, 'pending', { account_last4: '4471' })];
    const shown = await confirm(ROW(1));
    expect(shown.status).toBe(409);
    expect((await shown.json()).error).toBe("What these show isn't what's locked, so they were changed outside FleetSuite: enter them again.");

    // Locked numbers moved over from another set.
    state.tables.vendor_bank_accounts = [bankRow(ROW(1), OZARK, 'pending', { account_locked: lockNumbers(KEY, OZARK_NUMBERS, OZARK, ROW(8)) })];
    expect((await (await confirm(ROW(1))).json()).error).toBe("These don't open as they were locked, so they were changed outside FleetSuite: enter them again.");

    // Locked with another key.
    state.tables.vendor_bank_accounts = [bankRow(ROW(1), OZARK, 'pending', {}, OZARK_NUMBERS, keyOf(OTHER_RAW))];
    expect((await (await confirm(ROW(1))).json()).error)
      .toBe('These were locked with another key than VENDOR_BANK_KEY holds now: put that key back, or enter them again.');
    expect(rpcNames()).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it('says when the table won\'t take the confirmation, and tells nobody', async () => {
    state.rpcErrors.vendor_bank_confirm = 'deadlock';
    const res = await confirm(ROW(1));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Couldn't confirm them (deadlock).");
    expect(audits()).toEqual([]);
    expect(alerts()).toEqual([]);
  });
});

describe('refusing and removing', () => {
  beforeEach(() => {
    state.tables.vendor_bank_accounts = [bankRow(ROW(1), OZARK, 'pending'), bankRow(ROW(2), GATEWAY, 'confirmed')];
    as(CALLER);
  });

  it('refuses numbers waiting, with why, and tells the others', async () => {
    const res = await post({ action: 'refuse', id: ROW(1), reason: ' Ozark says they never changed banks ' });
    expect(res.status).toBe(200);
    expect(bank(ROW(1))).toMatchObject({ status: 'refused', account_locked: null, ended_by: CALLER, ended_why: 'Ozark says they never changed banks' });
    expect(audits()).toEqual([expect.objectContaining({ action: 'refuse', detail: expect.objectContaining({ why: 'Ozark says they never changed banks' }) })]);
    expect(alerts()).toEqual([expect.objectContaining({
      to: [ENTERER, WATCHER],
      title: 'Bank numbers refused for Ozark Hose & Fitting',
      body: 'Lee Owner refused the bank numbers Pat Admin entered for Ozark Hose & Fitting: Ozark says they never changed banks. Nothing will be paid to them.',
    })]);
  });

  it('says "they" when whoever entered them refuses them', async () => {
    as(ENTERER);
    await post({ action: 'refuse', id: ROW(1), reason: 'Typed the wrong form.' });
    expect(alerts()[0]).toMatchObject({
      to: [CALLER, WATCHER],
      body: 'Pat Admin refused the bank numbers they entered for Ozark Hose & Fitting: Typed the wrong form. Nothing will be paid to them.',
    });
  });

  it('removes confirmed numbers, with why', async () => {
    const res = await post({ action: 'remove', id: ROW(2), reason: 'They want checks again' });
    expect(res.status).toBe(200);
    expect(bank(ROW(2))).toMatchObject({ status: 'removed', account_locked: null, confirm_seal: null, ended_why: 'They want checks again' });
    expect(alerts()[0]).toMatchObject({
      title: 'Bank numbers removed for Gateway Truck Parts',
      body: "Lee Owner removed Gateway Truck Parts's confirmed bank numbers: They want checks again. Nothing is paid to Gateway Truck Parts by ACH until "
        + 'new ones are entered and confirmed.',
      url: '/admin/pay-vendors?bank=52',
    });
  });

  it('refuses only numbers waiting, and removes only confirmed ones', async () => {
    const refuse = await post({ action: 'refuse', id: ROW(2), reason: 'No' });
    expect(refuse.status).toBe(409);
    expect((await refuse.json()).error).toBe("They're confirmed already.");
    expect((await (await post({ action: 'remove', id: ROW(1), reason: 'No' })).json()).error).toBe("They're waiting for a call-back.");
    expect(rpcNames()).toEqual([]);
  });

  it('says where they are when another press got there first, and tells nobody', async () => {
    state.rpcAnswers.vendor_bank_end = { state: 'confirmed' };
    const res = await post({ action: 'refuse', id: ROW(1), reason: 'Ozark says they never changed banks' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("They're confirmed already.");

    state.rpcAnswers.vendor_bank_confirm = { state: 'refused' };
    const late = await confirm(ROW(1));
    expect(late.status).toBe(409);
    expect((await late.json()).error).toBe('They were refused.');
    expect(audits()).toEqual([]);
    expect(alerts()).toEqual([]);
  });

  it('keeps the account number out of why, however short it is', async () => {
    state.tables.vendor_bank_accounts = [bankRow(ROW(1), OZARK, 'pending', {}, { routing: '123456780', account: '40712', type: 'checking' })];
    const res = await post({ action: 'refuse', id: ROW(1), reason: 'Dana says 407-12 is closed' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Leave account numbers out of why/);
    const blank = await post({ action: 'refuse', id: ROW(1), reason: '  ' });
    expect((await blank.json()).error).toBe('Say why.');
    expect(rpcNames()).toEqual([]);
  });
});

describe('reading them', () => {
  it('shows each set with only the four digits its account ends with, and the phone to call for those waiting', async () => {
    state.tables.vendor_bank_accounts = [
      bankRow(ROW(1), OZARK, 'pending'),
      bankRow(ROW(2), GATEWAY, 'confirmed'),
      bankRow(ROW(3), OZARK, 'refused'),
      bankRow(ROW(4), GATEWAY, 'replaced', { ended_at: '2026-10-31T12:00:00.000Z' }),
      bankRow(ROW(6), OZARK, 'removed', { ended_at: '2026-10-30T12:00:00.000Z' }),
    ];
    as(CALLER);
    const res = await get();
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.me).toBe(CALLER);
    expect(body.accounts.map((b: any) => [b.vendorName, b.status])).toEqual([['Gateway Truck Parts', 'confirmed'], ['Ozark Hose & Fitting', 'pending']]);
    expect(body.past.map((b: any) => [b.id, b.status])).toEqual([[ROW(4), 'replaced'], [ROW(3), 'refused'], [ROW(6), 'removed']]);
    const ozark = body.accounts[1];
    expect(ozark).toEqual({
      id: ROW(1), vendorId: OZARK, vendorName: 'Ozark Hose & Fitting', routing: '123456780', last4: '9012', type: 'checking',
      nameOnAccount: 'OZARK HOSE & FITTING', source: 'ACH form from Dana', status: 'pending', tries: 0, enteredBy: 'Pat Admin', enteredById: ENTERER,
      enteredAt: '2026-10-30T15:00:00.000Z', confirmedBy: null, confirmedAt: null, calledPhone: null, spokeWith: null, endedBy: null, endedAt: null,
      endedWhy: null, problem: null, phone: '636-555-0142', phoneChanged: null,
    });
    // A confirmed set doesn't carry the phone to call.
    expect(body.accounts[0]).toMatchObject({ phone: null, phoneChanged: null, confirmedBy: 'Lee Owner', problem: null });
    expect(body.past[1]).toMatchObject({ endedBy: 'Lee Owner', endedWhy: 'Ozark never changed banks' });
    const text = JSON.stringify(body);
    expect(text).not.toContain('123456789012');
    expect(text).not.toContain('v1.');
    expect(text).not.toMatch(/locked|seal/i);
  });

  it("calls out a phone changed in FleetSuite in the last 90 days, the latest", async () => {
    state.tables.vendor_bank_accounts = [bankRow(ROW(1), OZARK, 'pending')];
    state.tables.detail_changes = [
      { id: 1, record_type: 'vendor', status: 'changed', netsuite_id: OZARK, patch: { phone: '636-555-0199' }, created_by: ENTERER, created_at: '2026-10-29T09:00:00.000Z' },
      { id: 2, record_type: 'vendor', status: 'changed', netsuite_id: OZARK, patch: { phone: '636-555-0142' }, created_by: CALLER, created_at: '2026-10-12T09:00:00.000Z' },
      { id: 3, record_type: 'vendor', status: 'changed', netsuite_id: OZARK, patch: { email: 'ap@ozark.example' }, created_by: CALLER, created_at: '2026-10-31T09:00:00.000Z' },
    ];
    const ozark = (await (await get()).json()).accounts[0];
    expect(ozark.phoneChanged).toEqual({ at: '2026-10-29T09:00:00.000Z', by: 'Pat Admin' });
  });

  it("doesn't call out an older phone change, one refused, or one for another record", async () => {
    state.tables.vendor_bank_accounts = [bankRow(ROW(1), OZARK, 'pending')];
    state.tables.detail_changes = [
      { id: 1, record_type: 'vendor', status: 'changed', netsuite_id: OZARK, patch: { phone: '1' }, created_by: ENTERER, created_at: '2026-08-03T16:59:00.000Z' },
      { id: 2, record_type: 'vendor', status: 'refused', netsuite_id: OZARK, patch: { phone: '2' }, created_by: ENTERER, created_at: '2026-10-29T09:00:00.000Z' },
      { id: 3, record_type: 'customer', status: 'changed', netsuite_id: OZARK, patch: { phone: '3' }, created_by: ENTERER, created_at: '2026-10-29T09:00:00.000Z' },
    ];
    expect((await (await get()).json()).accounts[0].phoneChanged).toBeNull();
    // Ninety days back to the minute.
    state.tables.detail_changes[0].created_at = '2026-08-03T17:01:00.000Z';
    expect((await (await get()).json()).accounts[0].phoneChanged).toEqual({ at: '2026-08-03T17:01:00.000Z', by: 'Pat Admin' });
  });

  it('says in red what was changed outside FleetSuite', async () => {
    state.tables.vendor_bank_accounts = [
      bankRow(ROW(1), OZARK, 'confirmed', { confirm_seal: `${KEY.id}.${'A'.repeat(43)}` }),
      bankRow(ROW(2), GATEWAY, 'pending', { routing_number: '021000021' }),
      bankRow(ROW(3), '77', 'pending', { vendor_name: 'Ozark Old Supply', account_type: 'savings' }),
    ];
    const [gateway, ozark, old] = (await (await get()).json()).accounts;
    expect(ozark.problem).toBe("FleetSuite didn't confirm these, so they were changed outside it: enter them again and confirm them on a call-back.");
    expect(gateway.problem).toBe("What these show isn't what's locked, so they were changed outside FleetSuite: enter them again.");
    expect(old.problem).toBe(gateway.problem);
  });

  it('opens nothing without the key, and says only that', async () => {
    vi.stubEnv('VENDOR_BANK_KEY', '');
    state.tables.vendor_bank_accounts = [bankRow(ROW(1), OZARK, 'pending', { routing_number: '021000021' })];
    const body = await (await get()).json();
    expect(body.keyProblem).toBe(KEY_MISSING);
    expect(body.accounts[0].problem).toBeNull();
  });

  it('finds vendors by every word typed, active ones first', async () => {
    const found = await (await get('find=ozark')).json();
    expect(found.vendors).toEqual([
      { id: OZARK, name: 'Ozark Hose & Fitting', phone: '636-555-0142', active: true },
      { id: '77', name: 'Ozark Old Supply', phone: '417-555-0100', active: false },
    ]);
    expect((await (await get('find=ozark%20hose')).json()).vendors.map((v: any) => v.id)).toEqual([OZARK]);
    expect((await (await get('find=v-gate')).json()).vendors.map((v: any) => v.id)).toEqual([GATEWAY]);
  });
});
