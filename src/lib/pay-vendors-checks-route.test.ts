// /api/pay-vendors/checks (src/lib/check-printing.ts): who can use it while
// paying vendors is switched off and once it's on, where each bank account's
// checks print and how that's set, what an approved run's checks are, and
// how they're numbered: checked against NetSuite first, each number on the
// stock in the printer unused here and in NetSuite, made out to NetSuite's
// Print on Check As, each number set in NetSuite in the run's order and the
// rest let go at the first NetSuite doesn't take, so the checks printed run
// on from the first number; then asking NetSuite about a number it didn't
// answer about, marking checks printed, and spoiling one that didn't print
// right so its payment takes the next number. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const STAFF = 'd0000000-0000-4000-8000-000000000001';
const BOSS = 'd0000000-0000-4000-8000-000000000002';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    userId: '',
    roles: [] as string[],
    hasPayments: true,
    canSeeMoney: true,
    seq: 0,
    tables: {} as Record<string, Record<string, any>[]>,
    rpcs: [] as Array<[string, Record<string, any>]>,
    /** Functions that fail, with why. */
    rpcErrors: {} as Record<string, string>,
    /** Check numbers in NetSuite's copy, by bank account. */
    copied: {} as Record<string, number[]>,
  };
  const netsuite = {
    getChecksNow: vi.fn(),
    getCheckNumbersUsed: vi.fn(),
    getPrintOnCheckAs: vi.fn(),
    getVendorAddresses: vi.fn(),
    setCheckNumber: vi.fn(),
  };
  const id = () => `c0000000-0000-4000-8000-${String(++state.seq).padStart(12, '0')}`;
  const rows = (table: string) => (state.tables[table] ??= []);

  // An in-memory stand-in for the tables the route reads and writes.
  function query(table: string) {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    const sorts: string[] = [];
    let patch: Record<string, any> | null = null;
    let upsert: [Record<string, any>, string] | null = null;
    let limit = Infinity;
    const run = () => {
      if (upsert) {
        const [row, key] = upsert;
        const at = rows(table).find((r) => r[key] === row[key]);
        if (at) Object.assign(at, row);
        else rows(table).push({ ...row });
        return { data: null, error: null };
      }
      const matched = rows(table).filter((r) => filters.every((f) => f(r)));
      if (patch) {
        for (const r of matched) Object.assign(r, patch);
        return { data: null, error: null };
      }
      const sorted = [...matched].sort((a, b) => {
        for (const c of sorts) {
          const d = String(a[c]).localeCompare(String(b[c]), 'en', { numeric: true });
          if (d !== 0) return d;
        }
        return 0;
      });
      return { data: sorted.slice(0, limit).map((r) => structuredClone(r)), error: null };
    };
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
      not: (c: string, op: string, v: unknown) => {
        if (op !== 'is' || v !== null) throw new Error(`the fake has no not(${op}, ${String(v)})`);
        filters.push((r) => (r[c] ?? null) !== null);
        return builder;
      },
      order: (c: string) => { sorts.push(c); return builder; },
      limit: (n: number) => { limit = n; return builder; },
      update: (p: Record<string, any>) => { patch = p; return builder; },
      upsert: (row: Record<string, any>, o: { onConflict: string }) => { upsert = [row, o.onConflict]; return builder; },
      maybeSingle: async () => ({ data: (run().data as any[] | null)?.[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  // Migration 489's functions, as it has them, on the in-memory tables.
  const checks = () => rows('vendor_checks');
  const pays = () => rows('vendor_payment_run_payments');
  const runOf = (runId: string) => rows('vendor_payment_runs').find((r) => r.id === runId && ['approved', 'done'].includes(r.status) && r.bank_account_netsuite_id);
  const madeCheck = (runId: string, paymentId: string) => pays().find((p) => p.id === paymentId && p.run_id === runId && p.method === 'check' && p.status === 'made');
  const live = (paymentId: string) => checks().some((c) => c.payment_id === paymentId && c.status !== 'spoiled');
  const numberUsed = (account: string, n: number) => checks().some((c) => c.bank_account_netsuite_id === account && c.check_number === n);
  const keep = (paymentId: string, n: number) => { const p = pays().find((x) => x.id === paymentId); if (p) p.netsuite_number = String(n); };
  const ok = (data: unknown) => ({ data, error: null });
  const rpcs: Record<string, (p: Record<string, any>) => { data: unknown; error: { message: string } | null }> = {
    vendor_check_last_number: ({ p_account }) => {
      const all = [...checks().filter((c) => c.bank_account_netsuite_id === p_account).map((c) => c.check_number), ...(state.copied[p_account] ?? [])];
      return ok(all.length ? Math.max(...all) : null);
    },
    vendor_check_numbers_used: ({ p_account, p_from, p_to }) => ok([...new Set([
      ...checks().filter((c) => c.bank_account_netsuite_id === p_account).map((c) => c.check_number), ...(state.copied[p_account] ?? []),
    ])].filter((n) => n >= p_from && n <= p_to).sort((a, b) => a - b)),
    vendor_checks_claim: ({ p }) => {
      const run = runOf(p.run_id);
      if (!run) return ok({ state: 'gone' });
      const notMade = p.checks.filter((c: any) => !madeCheck(run.id, c.payment_id)).map((c: any) => c.payment_id);
      if (notMade.length) return ok({ state: 'not_made', payments: notMade });
      const has = p.checks.filter((c: any) => live(c.payment_id)).map((c: any) => c.payment_id);
      if (has.length) return ok({ state: 'has_check', payments: has });
      const taken = p.checks.filter((c: any) => numberUsed(run.bank_account_netsuite_id, c.number)).map((c: any) => c.number).sort((a: number, b: number) => a - b);
      if (taken.length) return ok({ state: 'taken', numbers: taken });
      const made = p.checks.map((c: any) => {
        const row = {
          id: id(), company: run.company, bank_account_netsuite_id: run.bank_account_netsuite_id, check_number: c.number, run_id: run.id,
          payment_id: c.payment_id, netsuite_payment_id: madeCheck(run.id, c.payment_id)!.netsuite_payment_id, status: 'numbering',
          printed_as: structuredClone(c.printed_as), numbered_by: p.by, numbered_at: new Date().toISOString(), error: null, printed_by: null,
          printed_at: null, spoiled_by: null, spoiled_at: null, spoiled_reason: null,
        };
        checks().push(row);
        return { id: row.id, payment_id: row.payment_id, number: row.check_number };
      });
      return ok({ state: 'claimed', checks: made.sort((a: any, b: any) => a.number - b.number) });
    },
    vendor_check_numbered: ({ p }) => {
      const c = checks().find((x) => x.id === p.id && x.status === 'numbering');
      if (!c) return ok({ numbered: false });
      Object.assign(c, { status: 'numbered', error: null });
      keep(c.payment_id, c.check_number);
      return ok({ numbered: true });
    },
    vendor_check_let_go: ({ p }) => {
      const before = checks().length;
      state.tables.vendor_checks = checks().filter((x) => !(x.id === p.id && x.status === 'numbering'));
      return ok({ let_go: checks().length < before });
    },
    vendor_checks_printed: ({ p }) => {
      const hit = checks().filter((x) => p.ids.includes(x.id) && x.status === 'numbered');
      for (const c of hit) Object.assign(c, { status: 'printed', printed_by: p.by, printed_at: new Date().toISOString() });
      return ok({ printed: hit.length });
    },
    vendor_check_spoil: ({ p }) => {
      const c = checks().find((x) => x.id === p.id);
      if (!c) return ok({ state: 'gone' });
      if (!['numbered', 'printed'].includes(c.status)) return ok({ state: c.status === 'spoiled' ? 'already_spoiled' : c.status });
      Object.assign(c, { status: 'spoiled', spoiled_by: p.by, spoiled_at: new Date().toISOString(), spoiled_reason: p.reason.trim() });
      return ok({ state: 'spoiled' });
    },
    vendor_check_printed_in_netsuite: ({ p }) => {
      const run = runOf(p.run_id);
      if (!run) return ok({ state: 'gone' });
      const pay = madeCheck(run.id, p.payment_id);
      if (!pay) return ok({ state: 'not_made' });
      if (live(pay.id)) return ok({ state: 'has_check' });
      if (numberUsed(run.bank_account_netsuite_id, p.number)) return ok({ state: 'taken' });
      checks().push({
        id: id(), company: run.company, bank_account_netsuite_id: run.bank_account_netsuite_id, check_number: p.number, run_id: run.id,
        payment_id: pay.id, netsuite_payment_id: pay.netsuite_payment_id, status: 'printed_in_netsuite', printed_as: null, numbered_by: p.by,
        numbered_at: new Date().toISOString(), error: null, printed_by: null, printed_at: null, spoiled_by: null, spoiled_at: null, spoiled_reason: null,
      });
      keep(pay.id, p.number);
      return ok({ state: 'kept' });
    },
  };
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.rpcs.push([fn, args]);
      if (state.rpcErrors[fn]) return { data: null, error: { message: state.rpcErrors[fn] } };
      return rpcs[fn] ? rpcs[fn](args) : { data: null, error: { message: `nothing answers ${fn}` } };
    },
  };
  return { state, netsuite, service };
});

vi.mock('@/lib/api-auth', () => ({
  requireFeature: vi.fn(async () => (h.state.hasPayments
    ? { user: { id: h.state.userId }, profile: { roles: h.state.roles } }
    : { error: new Response('Forbidden', { status: 403 }) })),
  profileCanSeeMoney: vi.fn(async () => h.state.canSeeMoney),
  getProfileRoles: (profile: { roles: string[] }) => profile.roles,
}));
vi.mock('@/lib/netsuite', () => h.netsuite);
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));

const { state, netsuite } = h;

import { logAudit } from '@/lib/audit';
import { requireFeature } from '@/lib/api-auth';
import { GET, POST } from '../app/api/pay-vendors/checks/route';
import type { CheckNow } from './check-printing';

const RUN = 'e0000000-0000-4000-8000-000000000001';
const DRAFT = 'e0000000-0000-4000-8000-000000000002';
const P = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [OZARK, GATEWAY, ACME, DELTA] = [P(1), P(2), P(3), P(4)];
const NOW = '2026-11-01T17:00:00.000Z';

const COMPANIES = [
  { id: 'g1', code: 'BMG', name: 'BMG Fleet Installations', netsuite_subsidiary_id: '2', active: true },
  { id: 'g2', code: '1084', name: '1084 Cool Springs', netsuite_subsidiary_id: '3', active: true },
];
const account = (netsuite_account_id: string, number: string | null, name: string, over: Record<string, unknown> = {}) => ({
  netsuite_account_id, number, name, company_id: null, netsuite_subsidiary_ids: null, account_type: 'bank', active: true, is_summary: false, ...over,
});
const ACCOUNTS = [
  account('211', '10100', 'Operating Checking', { company_id: 'g1', netsuite_subsidiary_ids: ['2'] }),
  account('214', null, 'Payroll Checking', { company_id: 'g1', netsuite_subsidiary_ids: ['2'] }),
  account('221', '10300', 'Cool Springs Checking', { company_id: 'g2' }),
];
const keptBill = (id: string, number: string, date: string, cents: number) => ({
  bill_netsuite_id: id, number, date, due_date: null, open_cents: cents, cents,
});
const payment = (id: string, position: number, vendor: string, name: string, method: string, total: number, over: Record<string, unknown> = {}) => ({
  id, run_id: RUN, position, vendor_netsuite_id: vendor, vendor_name: name, method, total_cents: total, status: 'made',
  netsuite_payment_id: String(8300 + position), netsuite_number: method === 'check' ? 'To Print' : 'ACH',
  bills: [keptBill(`70${position}1`, `B-${position}1`, '2026-10-06', total)], ...over,
});
const OZARK_ADDRESS = { street: '1200 Industrial Dr', city: 'Springfield', state: 'MO', zip: '65802' };
const toPrint = (vendorId: string, totalCents: number, over: Partial<CheckNow> = {}): CheckNow =>
  ({ number: 'To Print', toBePrinted: true, voided: false, vendorId, totalCents, ...over });
const NETSUITE_NOW = new Map<string, CheckNow>([['8301', toPrint('31', 141240)], ['8303', toPrint('52', 30000)]]);

const get = (query: string) => GET(new NextRequest(`https://app.test/api/pay-vendors/checks?${query}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/pay-vendors/checks', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const as = (userId: string, roles: string[]) => { state.userId = userId; state.roles = roles; };
const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'vendor_payments', is_on: on }]; };
const checkRows = () => state.tables.vendor_checks ?? [];
const live = (paymentId: string) => checkRows().find((c) => c.payment_id === paymentId && c.status !== 'spoiled');
const rpcNames = () => state.rpcs.map(([fn]) => fn);
const audits = () => vi.mocked(logAudit).mock.calls.map(([, entry]) => entry as any);
const number = (paymentIds: string[], first = 1050) => post({ action: 'number', runId: RUN, first, paymentIds });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  as(STAFF, ['admin']);
  state.hasPayments = true;
  state.canSeeMoney = true;
  state.seq = 0;
  state.rpcs.length = 0;
  state.rpcErrors = {};
  state.copied = { 211: [1041, 1047], 214: [2200] };
  state.tables = {
    gl_companies: COMPANIES.map((c) => ({ ...c })),
    gl_accounts: ACCOUNTS.map((a) => ({ ...a })),
    profiles: [{ id: STAFF, full_name: 'Pat Clerk' }, { id: BOSS, full_name: 'Lee Owner' }],
    vendor_payment_runs: [
      {
        id: RUN, company: 'BMG', bank_account_netsuite_id: '211', bank_account_name: '10100 Operating Checking', pay_date: '2026-11-06',
        memo: 'November run', status: 'approved',
      },
      { id: DRAFT, company: 'BMG', bank_account_netsuite_id: '211', bank_account_name: null, pay_date: '2026-11-06', memo: null, status: 'draft' },
    ],
    vendor_payment_run_payments: [
      payment(OZARK, 1, '31', 'Ozark Hose & Fitting', 'check', 141240, {
        bills: [keptBill('7001', 'B-4410', '2026-10-06', 81240), keptBill('7002', 'B-4471', '2026-10-22', 60000)],
      }),
      payment(GATEWAY, 2, '47', 'Gateway Steel', 'ach', 245000),
      payment(ACME, 3, '52', 'Acme Fasteners', 'check', 30000),
      payment(DELTA, 4, '60', 'Delta Lighting', 'check', 5000, { status: 'to_make', netsuite_payment_id: null, netsuite_number: null }),
    ],
    vendor_checks: [],
    vendor_check_layouts: [],
  };
  switchOn(true);
  vi.clearAllMocks();
  vi.mocked(logAudit).mockReset();
  for (const fn of Object.values(netsuite)) fn.mockReset();
  netsuite.getChecksNow.mockImplementation(async (ids: string[]) => new Map([...NETSUITE_NOW].filter(([id]) => ids.includes(id))));
  netsuite.getCheckNumbersUsed.mockResolvedValue([]);
  netsuite.getPrintOnCheckAs.mockResolvedValue(new Map([['31', 'Ozark Hose and Fitting LLC']]));
  netsuite.getVendorAddresses.mockResolvedValue({ map: { 31: OZARK_ADDRESS }, strategy: 'default_billing', errors: [] });
  netsuite.setCheckNumber.mockResolvedValue({ success: true });
});

afterEach(() => { vi.useRealTimers(); });

const OZARK_CHECK = {
  number: 1050, date: '2026-11-06', payee: 'Ozark Hose and Fitting LLC', address: ['1200 Industrial Dr', 'Springfield, MO 65802'], cents: 141240,
  memo: 'November run', vendorName: 'Ozark Hose & Fitting', accountName: '10100 Operating Checking',
  bills: [{ number: 'B-4410', date: '2026-10-06', cents: 81240 }, { number: 'B-4471', date: '2026-10-22', cents: 60000 }],
};
const ACME_CHECK = {
  number: 1051, date: '2026-11-06', payee: 'Acme Fasteners', address: [], cents: 30000, memo: 'November run', vendorName: 'Acme Fasteners',
  accountName: '10100 Operating Checking', bills: [{ number: 'B-31', date: '2026-10-06', cents: 30000 }],
};

describe('who can use it', () => {
  it("refuses anyone without Payments or who can't see prices", async () => {
    state.hasPayments = false;
    expect((await get('company=BMG')).status).toBe(403);
    expect(requireFeature).toHaveBeenCalledWith(expect.anything(), 'vendor_payments');
    state.hasPayments = true;
    state.canSeeMoney = false;
    expect((await get('company=BMG')).status).toBe(403);
    expect((await post({ action: 'printed', checkIds: [P(9)] })).status).toBe(403);
  });

  it('while switched off, lets a super admin line up the stock, numbers nothing, and lets nobody else in', async () => {
    switchOn(false);
    const refused = await get('company=BMG');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Paying vendors is switched off until it moves into FleetSuite during 2027.', switchedOff: true });
    expect((await post({ action: 'layout', company: 'BMG', accountId: '211', position: 'top', right: 0, down: 0 })).status).toBe(403);

    as(BOSS, ['super_admin']);
    expect(await (await get('company=BMG')).json()).toMatchObject({ company: 'BMG', switchedOn: false });
    expect((await post({ action: 'layout', company: 'BMG', accountId: '211', position: 'middle', right: 2, down: -1 })).status).toBe(200);
    for (const body of [
      { action: 'number', runId: RUN, first: 1050, paymentIds: [OZARK] }, { action: 'ask', checkId: P(9) }, { action: 'printed', checkIds: [P(9)] },
      { action: 'spoiled', checkId: P(9), reason: 'Jammed' },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'Paying vendors is switched off until it moves into FleetSuite during 2027. No check was numbered, and nothing was sent to NetSuite.',
        switchedOff: true,
      });
    }
    expect(netsuite.getChecksNow).not.toHaveBeenCalled();
    expect(netsuite.setCheckNumber).not.toHaveBeenCalled();
    expect(rpcNames()).toEqual([]);
  });
});

describe('where the checks print', () => {
  it("lists the company's bank accounts with where each one's checks print, the top and not moved unless set", async () => {
    state.tables.vendor_check_layouts = [{ bank_account_netsuite_id: '214', company: 'BMG', check_position: 'bottom', right_sixteenths: -3, down_sixteenths: 16 }];
    expect(await (await get('company=BMG')).json()).toEqual({
      company: 'BMG',
      accounts: [
        { netsuiteId: '211', name: '10100 Operating Checking', layout: { position: 'top', right: 0, down: 0 } },
        { netsuiteId: '214', name: 'Payroll Checking', layout: { position: 'bottom', right: -3, down: 16 } },
      ],
      switchedOn: true,
    });
    expect((await get('company=1084')).status).toBe(200);
    expect(await (await get('')).json()).toMatchObject({ company: 'BMG' });
    expect((await get('company=ACME')).status).toBe(404);
  });

  it("sets a bank account's, an inch either way at most, and only the company's own", async () => {
    const res = await post({ action: 'layout', company: 'BMG', accountId: '211', position: 'middle', right: 4, down: -2 });
    expect(await res.json()).toEqual({ success: true, layout: { position: 'middle', right: 4, down: -2 } });
    expect(state.tables.vendor_check_layouts).toEqual([{
      bank_account_netsuite_id: '211', company: 'BMG', check_position: 'middle', right_sixteenths: 4, down_sixteenths: -2, updated_by: STAFF, updated_at: NOW,
    }]);
    await post({ action: 'layout', company: 'BMG', accountId: '211', position: 'top', right: 16, down: -16 });
    expect(state.tables.vendor_check_layouts).toMatchObject([{ check_position: 'top', right_sixteenths: 16, down_sixteenths: -16 }]);
    expect(audits()).toEqual([
      expect.objectContaining({ table: 'vendor_check_layouts', recordId: '211', action: 'update', detail: { company: 'BMG', bank_account: '10100 Operating Checking', position: 'middle', right: 4, down: -2 } }),
      expect.objectContaining({ recordId: '211', detail: expect.objectContaining({ position: 'top' }) }),
    ]);

    const refusals: Array<[Record<string, unknown>, number, string?]> = [
      [{ accountId: '221' }, 400, "That isn't one of the company's bank accounts."],
      [{ company: 'ACME' }, 400, 'Books has no company ACME with a NetSuite subsidiary.'],
      [{ right: 17 }, 400, 'Move it right or left by a whole number of sixteenths of an inch, 16 at most (one inch).'],
      [{ down: -17 }, 400, 'Move it down or up by a whole number of sixteenths of an inch, 16 at most (one inch).'],
      [{ right: 1.5 }, 400, 'Move it right or left by a whole number of sixteenths of an inch, 16 at most (one inch).'],
      [{ position: 'left' }, 400], [{ accountId: 'Operating' }, 400], [{ right: '2' }, 400],
    ];
    for (const [over, status, error] of refusals) {
      const r = await post({ action: 'layout', company: 'BMG', accountId: '211', position: 'top', right: 0, down: 0, ...over });
      expect(r.status).toBe(status);
      if (error) expect((await r.json()).error).toBe(error);
    }
    expect(state.tables.vendor_check_layouts).toHaveLength(1);
  });
});

describe("a run's checks", () => {
  it('lists each vendor paid by check with its check, the ones that did not print right, and the next number to suggest', async () => {
    state.tables.vendor_check_layouts = [{ bank_account_netsuite_id: '211', company: 'BMG', check_position: 'middle', right_sixteenths: 2, down_sixteenths: 0 }];
    state.tables.vendor_checks = [
      {
        id: P(11), bank_account_netsuite_id: '211', check_number: 1048, run_id: RUN, payment_id: OZARK, netsuite_payment_id: '8301', status: 'spoiled',
        printed_as: { date: '2026-11-06', payee: 'x', address: [], cents: 1, bills: [] }, numbered_by: STAFF, numbered_at: '2026-11-01T16:00:00.000Z',
        printed_by: null, printed_at: null, spoiled_by: BOSS, spoiled_at: '2026-11-01T16:10:00.000Z', spoiled_reason: 'Jammed', error: null,
      },
      {
        id: P(12), bank_account_netsuite_id: '211', check_number: 1049, run_id: RUN, payment_id: OZARK, netsuite_payment_id: '8301', status: 'numbered',
        printed_as: { date: '2026-11-06', payee: 'Ozark Hose and Fitting LLC', address: ['1200 Industrial Dr'], cents: 141240, memo: 'November run', vendor_name: 'Ozark Hose & Fitting', account_name: '10100 Operating Checking', bills: [] },
        numbered_by: STAFF, numbered_at: '2026-11-01T16:20:00.000Z', printed_by: null, printed_at: null, spoiled_by: null, spoiled_at: null, spoiled_reason: null, error: null,
      },
      {
        id: P(13), bank_account_netsuite_id: '211', check_number: 1052, run_id: RUN, payment_id: ACME, netsuite_payment_id: '8303', status: 'numbering',
        printed_as: { date: '2026-11-06', payee: 'Acme Fasteners', address: [], cents: 30000, bills: [] }, numbered_by: BOSS, numbered_at: '2026-11-01T16:50:00.000Z',
        printed_by: null, printed_at: null, spoiled_by: null, spoiled_at: null, spoiled_reason: null, error: "NetSuite didn't answer (socket hang up).",
      },
    ];
    const res = await get(`run=${RUN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      run: { id: RUN, company: 'BMG', accountId: '211', accountName: '10100 Operating Checking', status: 'approved' },
      layout: { position: 'middle', right: 2, down: 0 },
      nextNumber: 1053,
      checks: [
        {
          paymentId: OZARK, position: 1, vendorId: '31', vendorName: 'Ozark Hose & Fitting', totalCents: 141240, paymentStatus: 'made', billPaymentId: '8301',
          check: {
            id: P(12), number: 1049, status: 'numbered', error: null, stale: false, numberedBy: 'Pat Clerk', numberedAt: '2026-11-01T16:20:00.000Z',
            printedBy: null, printedAt: null,
            printed: {
              number: 1049, date: '2026-11-06', payee: 'Ozark Hose and Fitting LLC', address: ['1200 Industrial Dr'], cents: 141240, memo: 'November run',
              vendorName: 'Ozark Hose & Fitting', accountName: '10100 Operating Checking', bills: [],
            },
          },
          spoiled: [{ id: P(11), number: 1048, reason: 'Jammed', by: 'Lee Owner', at: '2026-11-01T16:10:00.000Z' }],
        },
        {
          paymentId: ACME, position: 3, vendorId: '52', vendorName: 'Acme Fasteners', totalCents: 30000, paymentStatus: 'made', billPaymentId: '8303',
          check: {
            id: P(13), number: 1052, status: 'numbering', error: "NetSuite didn't answer (socket hang up).", stale: true, numberedBy: 'Lee Owner',
            numberedAt: '2026-11-01T16:50:00.000Z', printedBy: null, printedAt: null, printed: null,
          },
          spoiled: [],
        },
        {
          paymentId: DELTA, position: 4, vendorId: '60', vendorName: 'Delta Lighting', totalCents: 5000, paymentStatus: 'to_make', billPaymentId: null,
          check: null, spoiled: [],
        },
      ],
      switchedOn: true,
    });
    // Numbering just now isn't stale yet.
    vi.setSystemTime(new Date('2026-11-01T16:54:00.000Z'));
    expect((await (await get(`run=${RUN}`)).json()).checks[1].check.stale).toBe(false);
  });

  it("suggests nothing when nothing's used on the bank account, and lists nothing for a run that isn't approved", async () => {
    state.copied = {};
    expect(await (await get(`run=${RUN}`)).json()).toMatchObject({ nextNumber: null, layout: { position: 'top', right: 0, down: 0 } });
    state.copied = { 211: [99_999_999] };
    expect(await (await get(`run=${RUN}`)).json()).toMatchObject({ nextNumber: null });
    state.copied = { 211: [1047] };
    expect(await (await get(`run=${RUN}`)).json()).toMatchObject({ nextNumber: 1048 });
    expect((await get(`run=${DRAFT}`)).status).toBe(409);
    Object.assign(state.tables.vendor_payment_runs.find((r) => r.id === DRAFT)!, { status: 'waiting' });
    expect((await get(`run=${DRAFT}`)).status).toBe(409);
    expect((await get('run=e0000000-0000-4000-8000-000000000099')).status).toBe(404);
    expect((await get('run=not-a-run')).status).toBe(404);
  });
});

describe('numbering checks', () => {
  it("numbers the run's checks from the first in the printer, in the run's order, made out to NetSuite's Print on Check As", async () => {
    const res = await number([ACME, OZARK]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      numbered: [
        { id: live(OZARK)!.id, paymentId: OZARK, number: 1050, check: OZARK_CHECK },
        { id: live(ACME)!.id, paymentId: ACME, number: 1051, check: ACME_CHECK },
      ],
      skipped: [],
      inNetSuite: [],
      stopped: null,
      warnings: ["NetSuite has no address for Acme Fasteners: its check shows only the name in the envelope's window."],
    });
    // Checked against NetSuite and the numbers used on the account first, then each number set in order.
    expect(netsuite.getChecksNow).toHaveBeenCalledWith(['8301', '8303']);
    expect(state.rpcs.find(([fn]) => fn === 'vendor_check_numbers_used')?.[1]).toEqual({ p_account: '211', p_from: 1050, p_to: 1051 });
    expect(netsuite.getCheckNumbersUsed).toHaveBeenCalledWith('211', [1050, 1051]);
    expect(netsuite.getPrintOnCheckAs).toHaveBeenCalledWith(['31', '52']);
    expect(netsuite.getVendorAddresses).toHaveBeenCalledWith(['31', '52']);
    expect(netsuite.setCheckNumber.mock.calls).toEqual([['8301', 1050], ['8303', 1051]]);
    expect(rpcNames()).toEqual(['vendor_check_numbers_used', 'vendor_checks_claim', 'vendor_check_numbered', 'vendor_check_numbered']);
    expect(checkRows().map((c) => [c.check_number, c.status, c.payment_id, c.numbered_by])).toEqual([
      [1050, 'numbered', OZARK, STAFF], [1051, 'numbered', ACME, STAFF],
    ]);
    // What's printed is kept, to print it again.
    expect(live(OZARK)!.printed_as).toEqual({
      date: '2026-11-06', payee: 'Ozark Hose and Fitting LLC', address: ['1200 Industrial Dr', 'Springfield, MO 65802'], cents: 141240,
      memo: 'November run', vendor_name: 'Ozark Hose & Fitting', account_name: '10100 Operating Checking', bills: OZARK_CHECK.bills,
    });
    expect(state.tables.vendor_payment_run_payments.find((p) => p.id === OZARK)!.netsuite_number).toBe('1050');
    // An audit entry on the run, with the numbers and no amounts.
    expect(audits()).toEqual([{
      actorId: STAFF, table: 'vendor_payment_runs', recordId: RUN, action: 'number_checks',
      detail: { company: 'BMG', bank_account: '10100 Operating Checking', numbered: [1050, 1051], printed_in_netsuite: [], skipped: 0 },
    }]);
  });

  it("numbers only the run's checks made in NetSuite that have no check yet", async () => {
    for (const ids of [[GATEWAY], [DELTA], [OZARK, P(99)]]) {
      const res = await number(ids);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Only this run's checks made in NetSuite are numbered and printed. Nothing was numbered.");
    }
    Object.assign(state.tables.vendor_payment_run_payments.find((p) => p.id === DELTA)!, { status: 'sending', netsuite_payment_id: '8304' });
    expect((await number([DELTA])).status).toBe(400);
    expect((await post({ action: 'number', runId: DRAFT, first: 1050, paymentIds: [OZARK] })).status).toBe(409);
    Object.assign(state.tables.vendor_payment_runs.find((r) => r.id === DRAFT)!, { status: 'waiting' });
    expect((await post({ action: 'number', runId: DRAFT, first: 1050, paymentIds: [OZARK] })).status).toBe(409);
    expect((await post({ action: 'number', runId: 'e0000000-0000-4000-8000-000000000099', first: 1050, paymentIds: [OZARK] })).status).toBe(404);
    for (const body of [{ first: 0 }, { first: 100_000_000 }, { first: 1050.5 }, { paymentIds: [] }, { paymentIds: ['ozark'] }]) {
      expect((await post({ action: 'number', runId: RUN, first: 1050, paymentIds: [OZARK], ...body })).status).toBe(400);
    }
    expect(netsuite.getChecksNow).not.toHaveBeenCalled();

    await number([OZARK]);
    const again = await number([ACME, OZARK], 1060);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('This run has check 1050 for some of these already: reload. Nothing was numbered.');
    expect(checkRows()).toHaveLength(1);
  });

  it("numbers nothing when NetSuite can't be read, and skips a check NetSuite voided or changed, numbering the rest from the first", async () => {
    netsuite.getChecksNow.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (503)'));
    const failed = await number([OZARK, ACME]);
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toBe("Couldn't read these checks' bill payments from NetSuite (NetSuite SuiteQL error (503)). Nothing was numbered.");
    expect(checkRows()).toEqual([]);

    netsuite.getChecksNow.mockResolvedValueOnce(new Map([['8301', toPrint('31', 141240, { voided: true })], ['8303', toPrint('52', 30000)]]));
    const res = await (await number([OZARK, ACME])).json();
    expect(res).toMatchObject({
      numbered: [{ paymentId: ACME, number: 1050, check: { ...ACME_CHECK, number: 1050 } }],
      skipped: [{ paymentId: OZARK, vendorName: 'Ozark Hose & Fitting', why: "It's voided in NetSuite." }],
    });
    netsuite.getChecksNow.mockResolvedValueOnce(new Map());
    expect(await (await number([OZARK])).json()).toEqual({
      success: true, numbered: [], skipped: [{ paymentId: OZARK, vendorName: 'Ozark Hose & Fitting', why: "NetSuite doesn't have this bill payment any more." }],
      inNetSuite: [], stopped: null, warnings: [],
    });
    expect(netsuite.setCheckNumber.mock.calls).toEqual([['8303', 1050]]);
  });

  it('keeps a check printed from NetSuite with its number, and says when that number is one FleetSuite gave another check', async () => {
    netsuite.getChecksNow.mockResolvedValueOnce(new Map([['8301', toPrint('31', 141240, { toBePrinted: false, number: '1046' })], ['8303', toPrint('52', 30000)]]));
    const res = await (await number([OZARK, ACME])).json();
    expect(res).toMatchObject({
      numbered: [{ paymentId: ACME, number: 1050 }],
      inNetSuite: [{ paymentId: OZARK, vendorName: 'Ozark Hose & Fitting', number: 1046 }],
      skipped: [],
    });
    expect(live(OZARK)).toMatchObject({ check_number: 1046, status: 'printed_in_netsuite' });
    expect(audits()[0].detail).toMatchObject({ numbered: [1050], printed_in_netsuite: [1046] });

    state.tables.vendor_checks = [];
    state.tables.vendor_checks.push({ id: P(20), bank_account_netsuite_id: '211', check_number: 1046, run_id: RUN, payment_id: DELTA, status: 'spoiled' });
    netsuite.getChecksNow.mockResolvedValueOnce(new Map([['8301', toPrint('31', 141240, { toBePrinted: false, number: '1046' })]]));
    expect((await (await number([OZARK])).json()).skipped).toEqual([{
      paymentId: OZARK, vendorName: 'Ozark Hose & Fitting',
      why: 'NetSuite printed it as check 1046, a number FleetSuite gave another check on this bank account: look at it in NetSuite.',
    }]);
    state.rpcErrors.vendor_check_printed_in_netsuite = 'connection reset';
    netsuite.getChecksNow.mockResolvedValueOnce(new Map([['8301', toPrint('31', 141240, { toBePrinted: false, number: '1045' })]]));
    expect((await (await number([OZARK])).json()).skipped[0].why).toBe("NetSuite printed it as check 1045, and FleetSuite couldn't note that (connection reset).");
  });

  it('refuses numbers used already on the bank account, here or in NetSuite, or past the last a check can have', async () => {
    state.copied = { 211: [1051] };
    const here = await number([OZARK, ACME]);
    expect(here.status).toBe(409);
    expect((await here.json()).error).toBe('Check 1051 was used already on this bank account. Check the number printed on the first check in the printer. Nothing was numbered.');
    expect(netsuite.setCheckNumber).not.toHaveBeenCalled();

    state.copied = {};
    netsuite.getCheckNumbersUsed.mockResolvedValueOnce([1050, 1051]);
    const there = await number([OZARK, ACME]);
    expect((await there.json()).error).toBe('Checks 1050 and 1051 were used already on this bank account. Check the number printed on the first check in the printer. Nothing was numbered.');
    netsuite.getCheckNumbersUsed.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (400)'));
    const unread = await number([OZARK]);
    expect(unread.status).toBe(502);
    expect((await unread.json()).error).toBe("Couldn't check NetSuite for checks with these numbers (NetSuite SuiteQL error (400)). Nothing was numbered.");
    state.rpcErrors.vendor_check_numbers_used = 'statement timeout';
    expect((await number([OZARK])).status).toBe(500);
    delete state.rpcErrors.vendor_check_numbers_used;

    const past = await number([OZARK, ACME], 99_999_999);
    expect(past.status).toBe(400);
    expect((await past.json()).error).toBe('2 checks from 99999999 go past 99,999,999. Nothing was numbered.');
    expect(checkRows()).toEqual([]);
  });

  it("numbers nothing when NetSuite won't say what it prints on the vendors' checks", async () => {
    netsuite.getPrintOnCheckAs.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (400): Unknown identifier printoncheckas'));
    const res = await number([OZARK]);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Couldn't read the names NetSuite prints on these vendors' checks (NetSuite SuiteQL error (400): Unknown identifier printoncheckas). Nothing was numbered.");
    expect(checkRows()).toEqual([]);
  });

  it('says so when the numbers were taken just now', async () => {
    const claim = vi.fn();
    state.rpcErrors = {};
    // Someone else takes 1051 between the check and the claim.
    netsuite.getVendorAddresses.mockImplementationOnce(async () => {
      state.tables.vendor_checks.push({ id: P(21), bank_account_netsuite_id: '211', check_number: 1051, run_id: RUN, payment_id: DELTA, status: 'spoiled' });
      claim();
      return { map: {}, strategy: null, errors: [] };
    });
    const res = await number([OZARK, ACME]);
    expect(claim).toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('check 1051 was used just now on this bank account. Nothing was numbered.');
    expect(netsuite.setCheckNumber).not.toHaveBeenCalled();
  });

  it("stops at the first number NetSuite refuses, letting it and the rest go, so what's printed runs on from the first", async () => {
    netsuite.setCheckNumber.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): This transaction is closed.' });
    netsuite.getChecksNow.mockResolvedValueOnce(new Map([...NETSUITE_NOW, ['8304', toPrint('60', 5000)]]));
    Object.assign(state.tables.vendor_payment_run_payments[3], { status: 'made', netsuite_payment_id: '8304' });
    const res = await (await number([OZARK, ACME, DELTA])).json();
    expect(res.numbered.map((n: any) => n.number)).toEqual([1050]);
    expect(res.stopped).toEqual({ paymentId: ACME, vendorName: 'Acme Fasteners', number: 1051, why: 'NetSuite error (400): This transaction is closed.', unsure: false });
    expect(netsuite.setCheckNumber).toHaveBeenCalledTimes(2);
    expect(checkRows().map((c) => [c.check_number, c.status])).toEqual([[1050, 'numbered']]);
    expect(audits()[0].detail).toMatchObject({ numbered: [1050], stopped_at: 1051, unsure: false });

    // NetSuite refusing the first numbers none.
    state.tables.vendor_checks = [];
    netsuite.setCheckNumber.mockResolvedValueOnce({ success: false, error: 'NetSuite error (403): Forbidden' });
    expect(await (await number([OZARK, ACME])).json()).toMatchObject({ numbered: [], stopped: { paymentId: OZARK, number: 1050, unsure: false } });
    expect(checkRows()).toEqual([]);
  });

  it("holds a number NetSuite didn't answer about until it's asked, letting the rest go", async () => {
    netsuite.setCheckNumber.mockResolvedValueOnce({ success: false, error: "NetSuite didn't answer (it took too long).", unsure: true });
    const res = await (await number([OZARK, ACME])).json();
    expect(res).toMatchObject({ numbered: [], stopped: { paymentId: OZARK, number: 1050, why: "NetSuite didn't answer (it took too long).", unsure: true } });
    expect(checkRows().map((c) => [c.check_number, c.status, c.error])).toEqual([[1050, 'numbering', "NetSuite didn't answer (it took too long)."]]);
    expect(netsuite.setCheckNumber).toHaveBeenCalledTimes(1);

    // NetSuite took one, and FleetSuite's note of the number was gone by then: it stops there, the rest let go.
    state.tables.vendor_checks = [];
    netsuite.setCheckNumber.mockImplementationOnce(async () => {
      state.tables.vendor_checks = [];
      return { success: true };
    });
    expect(await (await number([OZARK, ACME])).json()).toMatchObject({
      numbered: [], stopped: { paymentId: OZARK, number: 1050, why: "NetSuite took it, and FleetSuite couldn't note that.", unsure: true },
    });
    expect(checkRows()).toEqual([]);

    // NetSuite took one, and FleetSuite couldn't note it: held, for Ask NetSuite.
    state.rpcErrors.vendor_check_numbered = 'connection reset';
    const lost = await (await number([OZARK, ACME])).json();
    expect(lost.stopped).toEqual({
      paymentId: OZARK, vendorName: 'Ozark Hose & Fitting', number: 1050, why: "NetSuite took it, and FleetSuite couldn't note that (connection reset).", unsure: true,
    });
    expect(checkRows().map((c) => [c.check_number, c.status])).toEqual([[1050, 'numbering']]);
  });

  it('stops before it runs out of time, leaving the rest to number next', async () => {
    netsuite.setCheckNumber.mockImplementation(async () => {
      vi.setSystemTime(new Date(Date.now() + 151_000));
      return { success: true };
    });
    // A vendor kept without its name goes by NetSuite's id for it.
    Object.assign(state.tables.vendor_payment_run_payments.find((p) => p.id === ACME)!, { vendor_name: null });
    const res = await (await number([OZARK, ACME])).json();
    expect(res.numbered.map((n: any) => n.number)).toEqual([1050]);
    expect(res.stopped).toEqual({
      paymentId: ACME, vendorName: 'Vendor 52', number: 1051, why: 'FleetSuite stopped here to answer in time: number the rest next.', unsure: false,
    });
    expect(checkRows().map((c) => c.check_number)).toEqual([1050]);
  });

  it("numbers a check that didn't print right again, though NetSuite still has the number it was given", async () => {
    state.tables.vendor_checks.push({
      id: P(22), bank_account_netsuite_id: '211', check_number: 1050, run_id: RUN, payment_id: OZARK, netsuite_payment_id: '8301', status: 'spoiled',
    });
    netsuite.getChecksNow.mockResolvedValueOnce(new Map([['8301', toPrint('31', 141240, { toBePrinted: false, number: '1050' })]]));
    expect(await (await number([OZARK], 1051)).json()).toMatchObject({ numbered: [{ paymentId: OZARK, number: 1051 }], inNetSuite: [] });
    expect(netsuite.setCheckNumber).toHaveBeenCalledWith('8301', 1051);
  });
});

describe('after numbering', () => {
  const held = (over: Record<string, unknown> = {}) => {
    state.tables.vendor_checks.push({
      id: P(30), company: 'BMG', bank_account_netsuite_id: '211', check_number: 1050, run_id: RUN, payment_id: OZARK, netsuite_payment_id: '8301',
      status: 'numbering', printed_as: { date: '2026-11-06', payee: 'Ozark Hose and Fitting LLC', address: [], cents: 141240, bills: [] },
      numbered_by: STAFF, numbered_at: '2026-11-01T16:50:00.000Z', error: "NetSuite didn't answer (socket hang up).", ...over,
    });
  };

  it('asks NetSuite about a held number once it has had a while, numbering it when NetSuite has it and letting it go when not', async () => {
    held();
    vi.setSystemTime(new Date('2026-11-01T16:53:00.000Z'));
    const early = await post({ action: 'ask', checkId: P(30) });
    expect(early.status).toBe(409);
    expect((await early.json()).error).toBe("NetSuite didn't say whether it took check 1050 (NetSuite didn't answer (socket hang up).). Ask again in a few minutes.");
    expect(netsuite.getChecksNow).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(NOW));
    netsuite.getChecksNow.mockRejectedValueOnce(new Error('timeout'));
    expect((await post({ action: 'ask', checkId: P(30) })).status).toBe(502);
    netsuite.getChecksNow.mockResolvedValueOnce(new Map([['8301', toPrint('31', 141240, { toBePrinted: false, number: '1050' })]]));
    expect(await (await post({ action: 'ask', checkId: P(30) })).json()).toEqual({
      success: true, numbered: true, number: 1050,
      check: { number: 1050, date: '2026-11-06', payee: 'Ozark Hose and Fitting LLC', address: [], cents: 141240, memo: '', vendorName: 'Ozark Hose and Fitting LLC', accountName: '', bills: [] },
    });
    expect(live(OZARK)).toMatchObject({ status: 'numbered' });
    expect(audits()[0]).toMatchObject({ action: 'number_checks', detail: { numbered: [1050], found_in_netsuite: true } });
    expect(await (await post({ action: 'ask', checkId: P(30) })).json()).toEqual({ success: true, already: true, status: 'numbered', number: 1050 });

    state.tables.vendor_checks = [];
    held({ error: null });
    vi.setSystemTime(new Date('2026-11-01T16:52:00.000Z'));
    expect((await (await post({ action: 'ask', checkId: P(30) })).json()).error).toBe('FleetSuite is setting check 1050 in NetSuite now. Reload in a minute.');
    vi.setSystemTime(new Date(NOW));
    const gone = await post({ action: 'ask', checkId: P(30) });
    expect(gone.status).toBe(409);
    expect((await gone.json()).error).toBe("NetSuite doesn't have check 1050 on this bill payment, so FleetSuite let the number go. Number it again.");
    expect(checkRows()).toEqual([]);
    expect(audits().at(-1)).toMatchObject({ action: 'let_go_check', detail: { number: 1050 } });
    expect((await post({ action: 'ask', checkId: P(30) })).status).toBe(404);
  });

  it('marks numbered checks printed, and spoils one that did not print right, with why', async () => {
    await number([OZARK, ACME]);
    const [ozarkCheck, acmeCheck] = [live(OZARK)!.id, live(ACME)!.id];
    expect((await post({ action: 'printed', checkIds: [ozarkCheck, P(98)] })).status).toBe(404);
    expect(await (await post({ action: 'printed', checkIds: [ozarkCheck] })).json()).toEqual({ success: true, printed: 1 });
    expect(live(OZARK)).toMatchObject({ status: 'printed', printed_by: STAFF });
    expect(audits().at(-1)).toMatchObject({ action: 'print_checks', detail: { printed: [1050] } });
    expect(await (await post({ action: 'printed', checkIds: [ozarkCheck] })).json()).toEqual({ success: true, printed: 0 });

    expect((await post({ action: 'spoiled', checkId: acmeCheck, reason: '  ' })).status).toBe(400);
    expect(await (await post({ action: 'spoiled', checkId: acmeCheck, reason: 'Jammed in the printer' })).json()).toEqual({ success: true });
    expect(checkRows().find((c) => c.id === acmeCheck)).toMatchObject({ status: 'spoiled', spoiled_reason: 'Jammed in the printer', spoiled_by: STAFF });
    expect(audits().at(-1)).toMatchObject({ action: 'spoil_check', detail: { number: 1051, reason: 'Jammed in the printer' } });
    const again = await post({ action: 'spoiled', checkId: acmeCheck, reason: 'x' });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("It's marked as not printed right already.");
    expect((await post({ action: 'spoiled', checkId: P(97), reason: 'x' })).status).toBe(404);

    // Its payment takes the next number, and 1051 is never given again.
    netsuite.getChecksNow.mockResolvedValueOnce(new Map([['8303', toPrint('52', 30000, { toBePrinted: false, number: '1051' })]]));
    expect(await (await number([ACME], 1051)).json()).toMatchObject({ error: expect.stringContaining('Check 1051 was used already') });
    netsuite.getChecksNow.mockResolvedValueOnce(new Map([['8303', toPrint('52', 30000, { toBePrinted: false, number: '1051' })]]));
    expect(await (await number([ACME], 1052)).json()).toMatchObject({ numbered: [{ paymentId: ACME, number: 1052 }] });

    // Printed with one printed already, the run's audit names only the one printed now.
    expect(await (await post({ action: 'printed', checkIds: [ozarkCheck, live(ACME)!.id] })).json()).toEqual({ success: true, printed: 1 });
    expect(audits().at(-1)).toMatchObject({ action: 'print_checks', detail: { printed: [1052] } });
  });

  it("won't spoil a check whose number isn't set yet, or one NetSuite printed", async () => {
    held();
    const numbering = await post({ action: 'spoiled', checkId: P(30), reason: 'x' });
    expect((await numbering.json()).error).toBe("Its number isn't set in NetSuite yet: ask NetSuite first.");
    Object.assign(checkRows()[0], { status: 'printed_in_netsuite' });
    expect((await (await post({ action: 'spoiled', checkId: P(30), reason: 'x' })).json()).error).toBe('It was printed from NetSuite: void or print it again there.');
  });
});
