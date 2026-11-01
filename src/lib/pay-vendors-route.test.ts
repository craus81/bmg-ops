// /api/pay-vendors (src/lib/pay-vendors.ts): who can open it while paying
// vendors is switched off and once it's on, what it lists (the company's bank
// accounts, its open bills in NetSuite, its payment runs, and the bills
// another run holds), and how a run is saved, deleted, asked for approval
// (checked against NetSuite first), taken back, sent back with why, and
// approved by a super admin who didn't ask, which makes one payment per
// vendor; then each payment made once in NetSuite as a bill payment under its
// own External ID however often it's pressed, checked against NetSuite just
// before it's sent, let go when NetSuite refuses, held when NetSuite can't
// say and asked about later, dropped by a super admin with why, and Books'
// own copy kept unless NetSuite's total isn't what was sent; each step
// alerting whoever it's for and anyone copied on new alerts. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const STAFF = 'd0000000-0000-4000-8000-000000000001';
const BOSS = 'd0000000-0000-4000-8000-000000000002';
const WATCHER = 'd0000000-0000-4000-8000-000000000003';
const OTHER = 'd0000000-0000-4000-8000-000000000004';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    userId: '',
    roles: [] as string[],
    hasPayments: true,
    canSeeMoney: true,
    superAdmins: [] as string[],
    watchers: [] as string[],
    clock: 0,
    paymentSeq: 0,
    tables: {} as Record<string, Record<string, any>[]>,
    /** Tables whose reads fail, with why. */
    readErrors: {} as Record<string, string>,
    rpcs: [] as Array<[string, Record<string, any>]>,
    ownSave: null as null | { data: unknown; error: { message: string } | null },
    madeError: null as null | { message: string },
    /** Runs once, just before the named function next answers: someone else getting there first. */
    before: {} as Record<string, (() => void) | undefined>,
    /** Runs once, just before the next delete. */
    beforeDelete: null as (() => void) | null,
  };
  const netsuite = {
    getOpenBills: vi.fn(),
    getBillsNow: vi.fn(),
    findVendorPayment: vi.fn(),
    createVendorPayment: vi.fn(),
  };
  /** A moment that's later than the last, as now() is in Postgres. */
  const stamp = () => new Date(Date.now() + ++state.clock).toISOString();

  // An in-memory stand-in for the tables the route reads and writes.
  function query(table: string) {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    const sorts: Array<[string, boolean]> = [];
    let patch: Record<string, any> | null = null;
    let remove = false;
    let returning = false;
    let limit = Infinity;
    const rows = () => (state.tables[table] ??= []);
    const run = () => {
      if (!patch && !remove && state.readErrors[table]) return { data: null, error: { message: state.readErrors[table] } };
      if (remove && state.beforeDelete) { const first = state.beforeDelete; state.beforeDelete = null; first(); }
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      if (remove) {
        state.tables[table] = rows().filter((r) => !matched.includes(r));
        return { data: returning ? matched.map((r) => ({ id: r.id })) : null, error: null };
      }
      if (patch) {
        for (const r of matched) Object.assign(r, patch);
        return { data: returning ? matched.map((r) => ({ id: r.id })) : null, error: null };
      }
      // As Postgres sorts: nulls last going up, and first going down.
      const sorted = [...matched].sort((a, b) => {
        for (const [c, asc] of sorts) {
          const [an, bn] = [a[c] == null, b[c] == null];
          const d = an || bn ? Number(an) - Number(bn) : String(a[c]).localeCompare(String(b[c]), 'en', { numeric: true });
          if (d !== 0) return asc ? d : -d;
        }
        return 0;
      });
      return { data: sorted.slice(0, limit).map((r) => structuredClone(r)), error: null };
    };
    const builder: any = {
      select: () => { if (patch || remove) returning = true; return builder; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return builder; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
      not: (c: string, op: string, v: unknown) => {
        if (op !== 'is' || v !== null) throw new Error(`the fake has no not(${op}, ${String(v)})`);
        filters.push((r) => (r[c] ?? null) !== null);
        return builder;
      },
      order: (c: string, o?: { ascending?: boolean }) => { sorts.push([c, o?.ascending !== false]); return builder; },
      limit: (n: number) => { limit = n; return builder; },
      update: (p: Record<string, any>) => { patch = p; return builder; },
      delete: () => { remove = true; return builder; },
      maybeSingle: async () => {
        const r = run();
        return r.error ? { data: null, error: r.error } : { data: (r.data as any[] | null)?.[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  // Migration 488's functions, as it has them, on the in-memory tables.
  const runs = () => (state.tables.vendor_payment_runs ??= []);
  const pays = () => (state.tables.vendor_payment_run_payments ??= []);
  const billIds = (payments: any[]) => payments.flatMap((p) => p.bills.map((b: any) => b.bill_netsuite_id as string));
  const heldOf = (ids: string[], except: string | null) => {
    const out = new Set<string>();
    for (const r of runs()) if (r.status === 'waiting' && r.id !== except) for (const id of r.bill_ids) if (ids.includes(id)) out.add(id);
    for (const p of pays()) {
      if (['to_make', 'sending', 'refused'].includes(p.status) && p.run_id !== except) for (const id of p.bill_ids) if (ids.includes(id)) out.add(id);
    }
    return [...out].sort();
  };
  const finish = (runId: string) => {
    const r = runs().find((x) => x.id === runId);
    if (!r || r.status !== 'approved' || pays().some((p) => p.run_id === runId && ['to_make', 'sending', 'refused'].includes(p.status))) return false;
    Object.assign(r, { status: 'done', done_at: stamp() });
    return true;
  };
  const ok = (data: unknown) => ({ data, error: null });
  const rpcs: Record<string, (p: Record<string, any>) => { data: unknown; error: { message: string } | null }> = {
    vendor_payment_run_save: (p) => {
      const content = {
        company: p.company.trim(), bank_account_netsuite_id: p.bank_account_netsuite_id || null,
        bank_account_name: (p.bank_account_name || '').trim() || null, pay_date: p.pay_date, memo: (p.memo || '').trim() || null,
        payments: structuredClone(p.payments), bill_ids: billIds(p.payments),
        total_cents: p.payments.flatMap((x: any) => x.bills).reduce((s: number, b: any) => s + b.cents, 0),
      };
      const r = runs().find((x) => x.id === p.id);
      const now = stamp();
      if (!r) {
        runs().push({
          id: p.id, ...content, status: 'draft', created_by: p.by, created_at: now, updated_by: p.by, updated_at: now, asked_by: null, asked_at: null,
          returned_by: null, returned_at: null, returned_reason: null, approved_by: null, approved_at: null, done_at: null,
        });
        return ok({ saved: true, status: 'draft', updated_at: now });
      }
      if (r.status !== 'draft') return ok({ saved: false, status: r.status, updated_at: r.updated_at });
      Object.assign(r, content, { updated_by: p.by, updated_at: now });
      return ok({ saved: true, status: 'draft', updated_at: now });
    },
    vendor_payment_bills_held: (p) => ok(heldOf(p.p_ids, p.p_except)),
    vendor_payment_run_ask: (p) => {
      const r = runs().find((x) => x.id === p.id);
      if (!r) return ok({ state: 'gone' });
      if (r.status !== 'draft') return ok({ state: r.status });
      if (r.updated_at !== p.updated_at) return ok({ state: 'changed' });
      const held = heldOf(r.bill_ids, r.id);
      if (held.length > 0) return ok({ state: 'held', held });
      Object.assign(r, { status: 'waiting', asked_by: p.by, asked_at: stamp(), returned_by: null, returned_at: null, returned_reason: null });
      return ok({ state: 'asked', asked_at: r.asked_at });
    },
    vendor_payment_run_take_back: (p) => {
      const r = runs().find((x) => x.id === p.id);
      if (!r) return ok({ state: 'gone' });
      if (r.status !== 'waiting') return ok({ state: r.status });
      Object.assign(r, { status: 'draft', asked_by: null, asked_at: null, updated_by: p.by, updated_at: stamp() });
      return ok({ state: 'taken_back' });
    },
    vendor_payment_run_send_back: (p) => {
      const r = runs().find((x) => x.id === p.id);
      if (!r) return ok({ state: 'gone' });
      if (r.status !== 'waiting') return ok({ state: r.status });
      Object.assign(r, { status: 'draft', asked_by: null, asked_at: null, returned_by: p.by, returned_at: stamp(), returned_reason: p.reason, updated_at: stamp() });
      return ok({ state: 'sent_back' });
    },
    vendor_payment_run_approve: (p) => {
      const r = runs().find((x) => x.id === p.id);
      if (!r) return ok({ state: 'gone' });
      if (r.status === 'approved' || r.status === 'done') return ok({ state: r.status, run: { ...r } });
      if (r.status === 'draft') return ok({ state: 'draft' });
      if (r.asked_at !== p.asked_at) return ok({ state: 'changed' });
      if (r.asked_by === p.approver) return ok({ state: 'yours' });
      Object.assign(r, { status: 'approved', approved_by: p.approver, approved_at: stamp() });
      r.payments.forEach((x: any, i: number) => pays().push({
        id: `f0000000-0000-4000-8000-${String(++state.paymentSeq).padStart(12, '0')}`, run_id: r.id, position: i + 1,
        vendor_netsuite_id: x.vendor_netsuite_id, vendor_name: x.vendor_name, method: x.method, bills: structuredClone(x.bills),
        bill_ids: x.bills.map((b: any) => b.bill_netsuite_id), total_cents: x.bills.reduce((s: number, b: any) => s + b.cents, 0),
        status: 'to_make', sent_by: null, sent_at: null, netsuite_payment_id: null, netsuite_number: null, error: null,
        dropped_by: null, dropped_at: null, dropped_reason: null, updated_at: stamp(),
      }));
      return ok({ state: 'claimed', run: { ...r } });
    },
    vendor_payment_claim: (p) => {
      const x = pays().find((y) => y.id === p.id);
      if (!x) return ok({ state: 'gone' });
      if (x.status === 'made') return ok({ state: 'made', netsuite_payment_id: x.netsuite_payment_id, netsuite_number: x.netsuite_number });
      if (x.status === 'sending') return ok({ state: 'sending', payment: structuredClone(x) });
      if (x.status === 'dropped') return ok({ state: 'dropped' });
      Object.assign(x, { status: 'sending', sent_by: p.by, sent_at: stamp(), error: null });
      return ok({ state: 'claimed', payment: structuredClone(x) });
    },
    vendor_payment_let_go: (p) => {
      const x = pays().find((y) => y.id === p.id && y.status === 'sending');
      if (x) Object.assign(x, { status: 'refused', error: (p.error || '').trim() || 'Not made' });
      return ok({ let_go: !!x });
    },
    vendor_payment_made: (p) => {
      if (state.madeError) return { data: null, error: state.madeError };
      const x = pays().find((y) => y.id === p.id && y.status === 'sending');
      if (!x) return ok({ made: false, run_done: false });
      Object.assign(x, { status: 'made', netsuite_payment_id: p.netsuite_payment_id, netsuite_number: (p.netsuite_number || '').trim() || null, error: null });
      return ok({ made: true, run_done: finish(x.run_id) });
    },
    vendor_payment_drop: (p) => {
      const x = pays().find((y) => y.id === p.id);
      if (!x) return ok({ state: 'gone', run_done: false });
      if (!['to_make', 'refused'].includes(x.status)) return ok({ state: x.status === 'dropped' ? 'already_dropped' : x.status, run_done: false });
      Object.assign(x, { status: 'dropped', dropped_by: p.by, dropped_at: stamp(), dropped_reason: (p.reason || '').trim() || null });
      return ok({ state: 'dropped', run_done: finish(x.run_id) });
    },
    gl_own_bill_payment_save: () => state.ownSave ?? ok({ saved: true }),
  };
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.rpcs.push([fn, args]);
      const first = state.before[fn];
      if (first) { delete state.before[fn]; first(); }
      return rpcs[fn] ? rpcs[fn](args.p ?? args) : { data: null, error: { message: `nothing answers ${fn}` } };
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
vi.mock('@/lib/notify', () => ({
  getSuperAdminIds: vi.fn(async (exclude?: string | null) => h.state.superAdmins.filter((id) => id !== exclude)),
  notifyMany: vi.fn(async () => {}),
}));
vi.mock('@/lib/new-alert-watchers', () => ({ newAlertWatcherIds: vi.fn(async () => h.state.watchers) }));

const { state, netsuite } = h;

import { logAudit } from '@/lib/audit';
import { requireFeature } from '@/lib/api-auth';
import { notifyMany } from '@/lib/notify';
import { GET, POST } from '../app/api/pay-vendors/route';
import type { BillNow, OpenBill } from './pay-vendors';

const R = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RUN = R(1);
const NOW = '2026-11-01T17:00:00.000Z';
const later = (minutes: number) => vi.setSystemTime(new Date(Date.parse(NOW) + minutes * 60_000));

const COMPANIES = [
  { id: 'g1', code: 'BMG', name: 'BMG Fleet Installations', netsuite_subsidiary_id: '2', active: true },
  { id: 'g2', code: '1084', name: '1084 Cool Springs', netsuite_subsidiary_id: '3', active: true },
];
const account = (netsuite_account_id: string, number: string | null, name: string, over: Record<string, unknown> = {}) => ({
  netsuite_account_id, number, name, company_id: null, netsuite_subsidiary_ids: null, account_type: 'bank', active: true, is_summary: false, ...over,
});
const ACCOUNTS = [
  account('211', '10100', 'Operating Checking', { company_id: 'g1', netsuite_subsidiary_ids: ['2'] }),
  account('214', null, 'Payroll Checking', { netsuite_subsidiary_ids: ['2', '3'] }),
  account('221', '10300', 'Cool Springs Checking', { company_id: 'g2' }),
  account('250', '12000', 'Undeposited Funds', { company_id: 'g1', netsuite_subsidiary_ids: ['2'], account_type: 'other_current_asset' }),
];
const BMG_ACCOUNTS = [
  { netsuiteId: '211', number: '10100', name: 'Operating Checking' },
  { netsuiteId: '214', number: null, name: 'Payroll Checking' },
];
const PROFILES = [
  { id: STAFF, full_name: 'Pat Clerk' }, { id: BOSS, full_name: 'Lee Owner' }, { id: WATCHER, full_name: 'Sam Watcher' },
  { id: OTHER, full_name: 'Robin Helper' },
];

const OPEN: OpenBill[] = [
  { id: '7001', number: 'B-4410', date: '2026-09-20', dueDate: '2026-10-20', vendorId: '31', vendorName: 'Ozark Hose & Fitting', openCents: 81240 },
  { id: '7002', number: 'B-4471', date: '2026-10-06', dueDate: '2026-11-05', vendorId: '31', vendorName: 'Ozark Hose & Fitting', openCents: 110000 },
  { id: '7003', number: 'GS-209', date: '2026-10-11', dueDate: '2026-11-10', vendorId: '47', vendorName: 'Gateway Steel', openCents: 245000 },
];
const nowOf = (bills: OpenBill[]) => new Map<string, BillNow>(bills.map((b) => [b.id, { open: true, openCents: b.openCents, vendorId: b.vendorId }]));
const tick = (b: OpenBill, cents = b.openCents) => ({ billId: b.id, number: b.number, date: b.date, dueDate: b.dueDate, openCents: b.openCents, cents });
const keptBill = (b: OpenBill, cents = b.openCents) => ({
  bill_netsuite_id: b.id, number: b.number, date: b.date, due_date: b.dueDate, open_cents: b.openCents, cents,
});

/** Ozark's two bills (part of B-4471) by check, and Gateway's by ACH, from Operating Checking on November 6. */
const SAVE = {
  action: 'save', id: RUN, company: 'BMG', accountId: '211', date: '2026-11-06', memo: 'November run',
  payments: [
    { vendorId: '31', vendorName: 'Ozark Hose & Fitting', method: 'check', bills: [tick(OPEN[0]), tick(OPEN[1], 60000)] },
    { vendorId: '47', vendorName: 'Gateway Steel', method: 'ach', bills: [tick(OPEN[2])] },
  ],
};
const DESCRIBED = 'BMG payment run dated 2026-11-06 from 10100 Operating Checking: 2 vendors, 3 bills, $3,862.40 (November run)';

const get = (query: string) => GET(new NextRequest(`https://app.test/api/pay-vendors?${query}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/pay-vendors', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const as = (userId: string, roles: string[]) => { state.userId = userId; state.roles = roles; };
const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'vendor_payments', is_on: on }]; };
const runRow = (id = RUN) => state.tables.vendor_payment_runs?.find((r) => r.id === id);
const paymentRows = (runId = RUN) => (state.tables.vendor_payment_run_payments ?? []).filter((p) => p.run_id === runId);
const rpcNames = () => state.rpcs.map(([fn]) => fn);
const auditActions = () => vi.mocked(logAudit).mock.calls.flatMap(([, entry]) => [entry].flat().map((e) => e.action));

/** Saved as Pat, who has Payments, and asked for. */
async function asked(body: Record<string, unknown> = SAVE) {
  as(STAFF, ['admin']);
  const saved = await (await post(body)).json();
  expect(saved.success).toBe(true);
  const res = await post({ action: 'ask', id: body.id, updatedAt: saved.updatedAt });
  expect(res.status).toBe(200);
  return (await res.json()).askedAt as string;
}

/** Asked for by Pat, and approved by Lee, a super admin. Returns Ozark's payment and Gateway's. */
async function approved(body: Record<string, unknown> = SAVE) {
  const askedAt = await asked(body);
  as(BOSS, ['super_admin']);
  const res = await post({ action: 'approve', id: body.id, askedAt });
  expect(res.status).toBe(200);
  const [ozark, gateway] = paymentRows(body.id as string).map((p) => p.id as string);
  return { ozark, gateway, toMake: (await res.json()).toMake as string[] };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  as(STAFF, ['admin']);
  state.hasPayments = true;
  state.canSeeMoney = true;
  state.superAdmins = [BOSS, WATCHER];
  state.watchers = [WATCHER];
  state.clock = 0;
  state.paymentSeq = 0;
  state.tables = {
    gl_companies: COMPANIES.map((c) => ({ ...c })),
    gl_accounts: ACCOUNTS.map((a) => ({ ...a })),
    profiles: PROFILES.map((p) => ({ ...p })),
    vendor_payment_runs: [],
    vendor_payment_run_payments: [],
  };
  state.readErrors = {};
  state.rpcs.length = 0;
  state.ownSave = null;
  state.madeError = null;
  state.before = {};
  state.beforeDelete = null;
  switchOn(true);
  vi.clearAllMocks();
  // A once-only answer a test left unused goes with it.
  vi.mocked(notifyMany).mockReset();
  vi.mocked(logAudit).mockReset();
  for (const fn of Object.values(netsuite)) fn.mockReset();
  netsuite.getOpenBills.mockResolvedValue(OPEN);
  netsuite.getBillsNow.mockImplementation(async (ids: string[]) => new Map([...nowOf(OPEN)].filter(([id]) => ids.includes(id))));
  netsuite.findVendorPayment.mockResolvedValue(null);
  netsuite.createVendorPayment.mockResolvedValue({ success: true, paymentId: '8302' });
});

afterEach(() => { vi.useRealTimers(); });

describe('while paying vendors is switched off', () => {
  beforeEach(() => switchOn(false));

  it('shows Pay Vendors to super admins only, approving to nobody, and nothing to anyone who cannot see prices', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false, canApprove: false });
    as(BOSS, ['super_admin']);
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true, canApprove: false });
    state.canSeeMoney = false;
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false, canApprove: false });
    state.hasPayments = false;
    expect((await get('status=1')).status).toBe(403);
    expect(requireFeature).toHaveBeenCalledWith(expect.anything(), 'vendor_payments');
  });

  it('lets a super admin see what a run would pay, and nobody else', async () => {
    const refused = await get('company=BMG&bills=1');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Paying vendors is switched off until it moves into FleetSuite during 2027.', switchedOff: true });
    for (const body of [SAVE, { action: 'delete', id: RUN }, { action: 'take_back', id: RUN }]) {
      expect((await post(body)).status).toBe(403);
    }
    expect(netsuite.getOpenBills).not.toHaveBeenCalled();
    expect(state.rpcs).toEqual([]);

    as(BOSS, ['super_admin']);
    const res = await get('company=BMG&bills=1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      today: '2026-11-01',
      companies: [{ code: 'BMG', name: 'BMG Fleet Installations' }, { code: '1084', name: '1084 Cool Springs' }],
      company: 'BMG',
      accounts: BMG_ACCOUNTS,
      bills: OPEN,
      billsError: null,
      held: [],
      runs: [],
      run: null,
      me: BOSS,
      superAdmin: true,
      switchedOn: false,
      offText: "Paying vendors is switched off until it moves into FleetSuite during 2027. You can make and save runs to see what they'd pay; none is asked for approval or sent to NetSuite.",
    });
    expect(netsuite.getOpenBills).toHaveBeenCalledWith('2');
  });

  it('lets a super admin save and delete a draft, and asks for, approves and sends nothing, for them either', async () => {
    as(BOSS, ['super_admin']);
    const saved = await (await post(SAVE)).json();
    expect(saved.success).toBe(true);
    for (const [body, text] of [
      [{ action: 'ask', id: RUN, updatedAt: saved.updatedAt }, 'It was saved, and not asked for approval.'],
      [{ action: 'approve', id: RUN, askedAt: saved.updatedAt }, 'Nothing was sent to NetSuite.'],
      [{ action: 'make', paymentId: 'f0000000-0000-4000-8000-000000000001' }, 'Nothing was sent to NetSuite.'],
    ] as const) {
      const res = await post(body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: `Paying vendors is switched off until it moves into FleetSuite during 2027. ${text}`, switchedOff: true });
    }
    expect(runRow()).toMatchObject({ status: 'draft', asked_at: null });
    expect(netsuite.getBillsNow).not.toHaveBeenCalled();
    expect(netsuite.createVendorPayment).not.toHaveBeenCalled();
    expect(notifyMany).not.toHaveBeenCalled();
    expect(await (await post({ action: 'delete', id: RUN })).json()).toEqual({ success: true });
    expect(runRow()).toBeUndefined();
  });

  it("counts a switch that can't be read as off", async () => {
    state.readErrors.books_switches = 'timeout';
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false, canApprove: false });
    expect((await post(SAVE)).status).toBe(403);
    as(BOSS, ['super_admin']);
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true, canApprove: false });
  });
});

describe('once paying vendors is on', () => {
  it('opens to anyone with Payments who can see prices, and approving to super admins', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true, canApprove: false });
    as(BOSS, ['super_admin']);
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true, canApprove: true });
    as(STAFF, ['admin']);
    expect(await (await get('company=BMG')).json()).toMatchObject({ switchedOn: true, offText: null, superAdmin: false, bills: null });
    expect(netsuite.getOpenBills).not.toHaveBeenCalled();

    state.canSeeMoney = false;
    for (const res of [await get('company=BMG'), await post(SAVE)]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Forbidden: this account cannot see billing' });
    }
    state.canSeeMoney = true;
    state.hasPayments = false;
    expect((await get('company=BMG')).status).toBe(403);
    expect((await post(SAVE)).status).toBe(403);
    expect(state.rpcs).toEqual([]);
    // Payments is paying vendors' own feature, wherever it's asked.
    expect(new Set(vi.mocked(requireFeature).mock.calls.map(([, feature]) => feature))).toEqual(new Set(['vendor_payments']));
  });

  it("lists each company's own bank accounts and open bills, the first company when none is named", async () => {
    for (const q of ['', 'company=', 'company=%20']) {
      expect(await (await get(q)).json()).toMatchObject({ company: 'BMG', accounts: BMG_ACCOUNTS });
    }
    const cool = await (await get('company=1084&bills=1')).json();
    expect(cool).toMatchObject({
      company: '1084', accounts: [{ netsuiteId: '221', number: '10300', name: 'Cool Springs Checking' }, { netsuiteId: '214', number: null, name: 'Payroll Checking' }],
    });
    expect(netsuite.getOpenBills).toHaveBeenLastCalledWith('3');

    const unknown = await get('company=ACME');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Books has no company by that name with a NetSuite subsidiary.' });

    // NetSuite not answering is said where the bills go; Books not answering fails the page.
    netsuite.getOpenBills.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (400): Bad query'));
    expect(await (await get('company=BMG&bills=1')).json()).toMatchObject({
      bills: null, billsError: "Couldn't read the open bills from NetSuite (NetSuite SuiteQL error (400): Bad query).",
    });
    for (const table of ['gl_accounts', 'gl_companies', 'vendor_payment_runs']) {
      state.readErrors = { [table]: `${table} timeout` };
      const res = await get('company=BMG');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: `${table} timeout` });
    }
  });

  it('saves a draft as ticked, and changes it only while it is a draft', async () => {
    const res = await post(SAVE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, updatedAt: expect.any(String) });
    expect(state.rpcs).toEqual([['vendor_payment_run_save', { p: {
      id: RUN, company: 'BMG', bank_account_netsuite_id: '211', bank_account_name: '10100 Operating Checking', pay_date: '2026-11-06',
      memo: 'November run', by: STAFF,
      payments: [
        { vendor_netsuite_id: '31', vendor_name: 'Ozark Hose & Fitting', method: 'check', bills: [keptBill(OPEN[0]), keptBill(OPEN[1], 60000)] },
        { vendor_netsuite_id: '47', vendor_name: 'Gateway Steel', method: 'ach', bills: [keptBill(OPEN[2])] },
      ],
    } }]]);
    expect(runRow()).toMatchObject({ status: 'draft', total_cents: 386240, bill_ids: ['7001', '7002', '7003'], created_by: STAFF });

    // Anyone who can use it changes a draft: here, with no bank account picked yet and no memo.
    as(OTHER, ['admin']);
    expect((await post({ ...SAVE, accountId: null, memo: null, payments: [SAVE.payments[1]] })).status).toBe(200);
    expect(runRow()).toMatchObject({ bank_account_netsuite_id: null, bank_account_name: null, memo: null, updated_by: OTHER, total_cents: 245000 });
    expect(logAudit).not.toHaveBeenCalled();

    for (const [over, error] of [
      [{ company: 'ACME' }, 'Books has no company ACME with a NetSuite subsidiary.'],
      [{ date: '2026-02-30' }, "2026-02-30 isn't a day on the calendar."],
      [{ accountId: '221' }, "That isn't one of the company's bank accounts."],
      [{ accountId: '250' }, "That isn't one of the company's bank accounts."],
    ] as const) {
      const refused = await post({ ...SAVE, ...over });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error });
    }
    for (const over of [
      { id: 'run-1' }, { date: '11/06/2026' }, { accountId: '10100' }, { memo: 'm'.repeat(301) },
      { payments: [{ ...SAVE.payments[0], method: 'wire' }] },
      { payments: [{ ...SAVE.payments[0], bills: [{ ...tick(OPEN[0]), cents: -1 }] }] },
      { payments: [{ ...SAVE.payments[0], bills: [{ ...tick(OPEN[0]), cents: 12.5 }] }] },
      { payments: [{ ...SAVE.payments[0], vendorId: 'V-31' }] },
      { payments: Array.from({ length: 51 }, (_, i) => ({ ...SAVE.payments[1], vendorId: String(100 + i) })) },
    ]) {
      expect((await post({ ...SAVE, ...over })).status).toBe(400);
    }
    expect(state.rpcs).toHaveLength(2);
  });

  it("says a run that's asked for wasn't saved", async () => {
    await asked();
    const res = await post({ ...SAVE, payments: [] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "It wasn't saved. It's asked for approval: take it back to change it.", status: 'waiting' });
    expect(runRow()).toMatchObject({ status: 'waiting', total_cents: 386240 });
  });

  it('deletes a draft for whoever started it or a super admin, and nothing else', async () => {
    await post(SAVE);
    as(OTHER, ['admin']);
    const notYours = await post({ action: 'delete', id: RUN });
    expect(notYours.status).toBe(403);
    expect(await notYours.json()).toEqual({ error: 'Only whoever started a draft, or a super admin, can delete it.' });
    as(STAFF, ['admin']);
    expect(await (await post({ action: 'delete', id: RUN })).json()).toEqual({ success: true });
    expect(runRow()).toBeUndefined();
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: STAFF, table: 'vendor_payment_runs', recordId: RUN, action: 'delete', detail: { company: 'BMG', date: '2026-11-06', total: '$3,862.40' },
    });
    expect(await (await post({ action: 'delete', id: RUN })).json()).toEqual({ success: true, already: true });

    as(STAFF, ['admin']);
    await post(SAVE);
    as(BOSS, ['super_admin']);
    expect((await post({ action: 'delete', id: RUN })).status).toBe(200);

    await asked();
    const waiting = await post({ action: 'delete', id: RUN });
    expect(waiting.status).toBe(409);
    expect(await waiting.json()).toEqual({ error: "Only a draft can be deleted. It's asked for approval: take it back to change it." });

    // Asked for between the read and the delete.
    await post({ ...SAVE, id: R(2) });
    state.beforeDelete = () => { runRow(R(2))!.status = 'waiting'; };
    const raced = await post({ action: 'delete', id: R(2) });
    expect(raced.status).toBe(409);
    expect(await raced.json()).toEqual({ error: "It wasn't deleted: it was asked for approval just now." });
    expect(runRow(R(2))).toBeDefined();
  });

  it("opens a draft with the company's open bills and its own as NetSuite has them now, and what another run holds", async () => {
    await post(SAVE);
    // Another run asked for, holding GS-209.
    await asked({ ...SAVE, id: R(2), payments: [SAVE.payments[1]] });
    vi.clearAllMocks();
    as(OTHER, ['admin']);
    const res = await get(`run=${RUN}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(netsuite.getOpenBills).toHaveBeenCalledWith('2');
    expect(netsuite.getBillsNow).toHaveBeenCalledWith(['7001', '7002', '7003']);
    expect(body).toMatchObject({
      company: 'BMG', bills: OPEN, held: ['7003'], me: OTHER, superAdmin: false,
      run: {
        id: RUN, company: 'BMG', date: '2026-11-06', accountId: '211', accountName: '10100 Operating Checking', memo: 'November run', status: 'draft',
        totalCents: 386240, vendorCount: 2, billCount: 3, createdBy: 'Pat Clerk', createdById: STAFF, askedBy: null,
        payments: SAVE.payments.map((p) => ({ vendorId: p.vendorId, vendorName: p.vendorName, method: p.method, bills: p.bills })),
        billsNow: { '7001': { open: true, openCents: 81240, vendorId: '31' }, '7002': { open: true, openCents: 110000, vendorId: '31' }, '7003': { open: true, openCents: 245000, vendorId: '47' } },
        checkError: null,
        made: [],
      },
    });
    expect(body.runs.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([[R(2), 'waiting'], [RUN, 'draft']]);
    expect(body.runs[0]).toMatchObject({ askedBy: 'Pat Clerk', askedById: STAFF, vendorCount: 1, billCount: 1, totalCents: 245000 });

    // NetSuite not answering about its bills is said on the run.
    netsuite.getBillsNow.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (400): Bad query'));
    expect((await (await get(`run=${RUN}`)).json()).run).toMatchObject({
      billsNow: null, checkError: "Couldn't check its bills against NetSuite (NetSuite SuiteQL error (400): Bad query).",
    });
    // A run that isn't there, or a run id that isn't one, opens the list.
    expect((await (await get(`run=${R(9)}`)).json()).run).toBeNull();
    expect((await (await get('run=7')).json()).run).toBeNull();

    // A run asked for doesn't hold its own bills, and is checked against NetSuite until it's approved.
    expect(await (await get(`run=${R(2)}`)).json()).toMatchObject({
      held: [], run: { id: R(2), status: 'waiting', billsNow: { '7003': { open: true, openCents: 245000, vendorId: '47' } }, checkError: null },
    });
    // A bill of the draft's that NetSuite no longer lists open is still said to be held.
    netsuite.getOpenBills.mockResolvedValueOnce(OPEN.slice(0, 2));
    expect(await (await get(`run=${RUN}`)).json()).toMatchObject({ bills: OPEN.slice(0, 2), held: ['7003'] });
    // A run opens on its own company, whichever is named, with that company's runs.
    await post({ ...SAVE, id: R(4), company: '1084', accountId: '221', payments: [] });
    const cool = await (await get(`run=${R(4)}&company=BMG`)).json();
    expect(cool).toMatchObject({ company: '1084', run: { id: R(4), company: '1084' } });
    expect(cool.runs.map((r: { id: string }) => r.id)).toEqual([R(4)]);
    expect((await (await get('company=BMG')).json()).runs.map((r: { id: string }) => r.id)).toEqual([R(2), RUN]);

    // Whoever isn't in FleetSuite any more is "Someone".
    state.tables.profiles = state.tables.profiles.filter((p) => p.id !== STAFF);
    expect((await (await get(`run=${RUN}`)).json()).run).toMatchObject({ createdBy: 'Someone', createdById: STAFF, askedBy: null });
  });

  it('asks for approval after checking the run against NetSuite, alerting the super admins', async () => {
    const saved = await (await post(SAVE)).json();
    const res = await post({ action: 'ask', id: RUN, updatedAt: saved.updatedAt });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, askedAt: expect.any(String) });
    expect(netsuite.getBillsNow).toHaveBeenCalledWith(['7001', '7002', '7003']);
    expect(rpcNames()).toEqual(['vendor_payment_run_save', 'vendor_payment_bills_held', 'vendor_payment_run_ask']);
    expect(state.rpcs[1][1]).toEqual({ p_ids: ['7001', '7002', '7003'], p_except: RUN });
    expect(state.rpcs[2][1]).toEqual({ p: { id: RUN, by: STAFF, updated_at: saved.updatedAt } });
    expect(runRow()).toMatchObject({ status: 'waiting', asked_by: STAFF });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: STAFF, table: 'vendor_payment_runs', recordId: RUN, action: 'ask_approval',
      detail: { company: 'BMG', date: '2026-11-06', bank_account: '10100 Operating Checking', vendors: 2, bills: 3, total: '$3,862.40' },
    });
    expect(notifyMany).toHaveBeenCalledTimes(1);
    expect(notifyMany).toHaveBeenCalledWith([BOSS, WATCHER], {
      type: 'books_payment_run_waiting',
      title: 'A payment run is waiting for approval',
      body: `${DESCRIBED}. Approve it to make its bill payments in NetSuite, or send it back.`,
      url: `/admin/pay-vendors?run=${RUN}`,
      channels: ['in_app', 'push', 'email'],
    });
  });

  it("says when no one else can approve it yet, never alerts the asker, and asks even when an alert can't go", async () => {
    state.superAdmins = [BOSS];
    state.watchers = [BOSS];
    as(BOSS, ['super_admin']);
    const saved = await (await post(SAVE)).json();
    const res = await post({ action: 'ask', id: RUN, updatedAt: saved.updatedAt });
    expect(await res.json()).toEqual({ success: true, askedAt: expect.any(String), warning: "No one else can approve it yet: it needs a super admin who didn't ask." });
    expect(notifyMany).not.toHaveBeenCalled();

    expect((await post({ action: 'take_back', id: RUN })).status).toBe(200);
    state.superAdmins = [BOSS, WATCHER];
    vi.mocked(notifyMany).mockRejectedValueOnce(new Error('push down'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    as(STAFF, ['admin']);
    const again = await post({ action: 'ask', id: RUN, updatedAt: runRow()!.updated_at });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ success: true, askedAt: expect.any(String) });
    expect(runRow()).toMatchObject({ status: 'waiting', asked_by: STAFF });
    expect(notifyMany).toHaveBeenCalledWith([BOSS, WATCHER], expect.objectContaining({ type: 'books_payment_run_waiting' }));
    expect(log).toHaveBeenCalledWith('[pay-vendors] alert books_payment_run_waiting not sent: push down');
    log.mockRestore();

    // Ozark's B-4410 is in that run, which is waiting: another run can't have it.
    await post({ ...SAVE, id: R(2), payments: [{ ...SAVE.payments[0], bills: [tick(OPEN[0])] }] });
    const held = await post({ action: 'ask', id: R(2), updatedAt: runRow(R(2))!.updated_at });
    expect(held.status).toBe(400);
    expect((await held.json()).error).toBe("Bill B-4410 is in another payment run, waiting for approval or being paid. It wasn't asked for approval.");
    expect(runRow(R(2))).toMatchObject({ status: 'draft' });
  });

  it("turns an ask away when NetSuite has the bills otherwise now, or can't say, or it changed since it was opened", async () => {
    const saved = await (await post(SAVE)).json();
    netsuite.getBillsNow.mockResolvedValueOnce(new Map([
      ['7001', { open: false, openCents: 0, vendorId: '31' }],
      ['7002', { open: true, openCents: 50000, vendorId: '31' }],
    ]));
    const changed = await post({ action: 'ask', id: RUN, updatedAt: saved.updatedAt });
    expect(changed.status).toBe(400);
    expect(await changed.json()).toEqual({
      error: "Bill B-4410 isn't open in NetSuite now: it's paid, or waiting for approval there. It wasn't asked for approval.",
      problems: [
        "Bill B-4410 isn't open in NetSuite now: it's paid, or waiting for approval there.",
        'Bill B-4471 has $500.00 open in NetSuite now, less than the $600.00 this pays on it.',
        "Bill GS-209 isn't in NetSuite any more, so nothing can be paid on it.",
      ],
    });

    netsuite.getBillsNow.mockRejectedValueOnce(new Error('NetSuite SuiteQL error (400): Bad query'));
    const unanswered = await post({ action: 'ask', id: RUN, updatedAt: saved.updatedAt });
    expect(unanswered.status).toBe(502);
    expect(await unanswered.json()).toEqual({ error: "Couldn't check its bills against NetSuite (NetSuite SuiteQL error (400): Bad query). It wasn't asked for approval." });

    // A run with no bank account yet is turned away by the same rules.
    await post({ ...SAVE, accountId: null });
    const noAccount = await post({ action: 'ask', id: RUN, updatedAt: runRow()!.updated_at });
    expect(await noAccount.json()).toMatchObject({ error: "Pick the bank account it pays from. It wasn't asked for approval." });

    await post(SAVE);
    const stale = await post({ action: 'ask', id: RUN, updatedAt: saved.updatedAt });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'It was changed since you opened it. Reload and check it, then ask again.' });
    expect(rpcNames().filter((fn) => fn === 'vendor_payment_run_ask')).toHaveLength(1);

    // What's kept is checked, not what the page last had: a memo longer than a run takes is turned away too.
    runRow()!.memo = 'm'.repeat(301);
    const longMemo = await post({ action: 'ask', id: RUN, updatedAt: runRow()!.updated_at });
    expect(longMemo.status).toBe(400);
    expect(await longMemo.json()).toMatchObject({ error: "The memo is 300 characters at most. It wasn't asked for approval." });
    runRow()!.memo = 'November run';
    // And one for a company Books no longer has.
    state.tables.gl_companies = state.tables.gl_companies.filter((c) => c.code !== 'BMG');
    const noCompany = await post({ action: 'ask', id: RUN, updatedAt: runRow()!.updated_at });
    expect(noCompany.status).toBe(400);
    expect(await noCompany.json()).toEqual({ error: "Books has no company BMG with a NetSuite subsidiary. It wasn't asked for approval." });
    state.tables.gl_companies = COMPANIES.map((c) => ({ ...c }));

    // Asked for by someone else just as it was asked: it says so.
    state.before.vendor_payment_run_ask = () => { Object.assign(runRow()!, { status: 'waiting', asked_by: OTHER, asked_at: new Date().toISOString() }); };
    const raced = await post({ action: 'ask', id: RUN, updatedAt: runRow()!.updated_at });
    expect(raced.status).toBe(409);
    expect(await raced.json()).toEqual({ error: "It's asked for approval: take it back to change it." });
    Object.assign(runRow()!, { status: 'draft', asked_by: null, asked_at: null });

    // Another run asked for in between: the hold is checked again as it's asked.
    state.before.vendor_payment_run_ask = () => {
      state.tables.vendor_payment_runs.push({ ...structuredClone(runRow()), id: R(3), status: 'waiting', bill_ids: ['7001', '7003'], payments: [] });
    };
    const held = await post({ action: 'ask', id: RUN, updatedAt: runRow()!.updated_at });
    expect(held.status).toBe(409);
    expect(await held.json()).toEqual({
      error: "Bill B-4410 and Bill GS-209 are in another payment run, waiting for approval or being paid. It wasn't asked for approval.",
    });
    expect(runRow()).toMatchObject({ status: 'draft' });
    expect(notifyMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();

    for (const [id, status, error] of [
      [R(9), 404, "There's no such payment run: it was deleted."],
      [R(3), 409, "It's asked for approval: take it back to change it."],
    ] as const) {
      const res = await post({ action: 'ask', id, updatedAt: saved.updatedAt });
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
    }
  });

  it('takes an ask back for whoever asked, started it or a super admin', async () => {
    await asked();
    as(OTHER, ['admin']);
    const notYours = await post({ action: 'take_back', id: RUN });
    expect(notYours.status).toBe(403);
    expect(await notYours.json()).toEqual({ error: 'Only whoever started it or asked for it, or a super admin, can take it back.' });
    as(STAFF, ['admin']);
    expect(await (await post({ action: 'take_back', id: RUN })).json()).toEqual({ success: true });
    expect(runRow()).toMatchObject({ status: 'draft', asked_by: null, asked_at: null });
    expect(logAudit).toHaveBeenLastCalledWith(expect.anything(), { actorId: STAFF, table: 'vendor_payment_runs', recordId: RUN, action: 'take_back' });
    // A draft has nothing to take back, whoever asks: the database isn't asked.
    for (const [who, roles] of [[STAFF, ['admin']], [OTHER, ['admin']]] as const) {
      as(who, [...roles]);
      const again = await post({ action: 'take_back', id: RUN });
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: "It's a draft now: it was taken back or sent back." });
    }
    expect(rpcNames().filter((fn) => fn === 'vendor_payment_run_take_back')).toHaveLength(1);

    await asked();
    as(BOSS, ['super_admin']);
    expect((await post({ action: 'take_back', id: RUN })).status).toBe(200);
    expect((await post({ action: 'take_back', id: R(9) })).status).toBe(404);

    // Started by Robin and asked for by Pat: Robin takes it back too, and so does Pat.
    as(OTHER, ['admin']);
    await post({ ...SAVE, id: R(2) });
    await asked({ ...SAVE, id: R(2) });
    as(OTHER, ['admin']);
    expect((await post({ action: 'take_back', id: R(2) })).status).toBe(200);
    await asked({ ...SAVE, id: R(2) });
    expect(runRow(R(2))).toMatchObject({ created_by: OTHER, asked_by: STAFF });
    expect((await post({ action: 'take_back', id: R(2) })).status).toBe(200);

    // Approved just as it was taken back: it says so, and nothing's logged.
    await asked({ ...SAVE, id: R(2) });
    state.before.vendor_payment_run_take_back = () => {
      Object.assign(runRow(R(2))!, { status: 'approved', approved_by: BOSS, approved_at: new Date().toISOString() });
    };
    const takes = auditActions().length;
    const raced = await post({ action: 'take_back', id: R(2) });
    expect(raced.status).toBe(409);
    expect(await raced.json()).toEqual({ error: "It's approved, and its bill payments are being made in NetSuite." });
    expect(auditActions().slice(takes)).toEqual([]);
  });

  it('sends an ask back with why, for super admins, alerting whoever asked and started it', async () => {
    as(OTHER, ['admin']);
    await post(SAVE);
    await asked();
    const staff = await post({ action: 'send_back', id: RUN, reason: 'Pay GS-209 next week' });
    expect(staff.status).toBe(403);
    expect(await staff.json()).toEqual({ error: 'Only a super admin approves payment runs, sends them back, or drops a payment from one.' });

    as(BOSS, ['super_admin']);
    expect((await post({ action: 'send_back', id: RUN, reason: '   ' })).status).toBe(400);
    expect(await (await post({ action: 'send_back', id: RUN, reason: ' Pay GS-209 next week ' })).json()).toEqual({ success: true });
    expect(runRow()).toMatchObject({ status: 'draft', returned_by: BOSS, returned_reason: 'Pay GS-209 next week' });
    expect(logAudit).toHaveBeenLastCalledWith(expect.anything(), {
      actorId: BOSS, table: 'vendor_payment_runs', recordId: RUN, action: 'send_back', detail: { reason: 'Pay GS-209 next week' },
    });
    expect(notifyMany).toHaveBeenLastCalledWith([STAFF, OTHER, WATCHER], {
      type: 'books_payment_run_decided',
      title: 'Your payment run was sent back',
      body: `${DESCRIBED}, sent back to be fixed: Pay GS-209 next week`,
      url: `/admin/pay-vendors?run=${RUN}`,
      channels: ['in_app', 'push', 'email'],
    });
    const again = await post({ action: 'send_back', id: RUN, reason: 'again' });
    expect(again.status).toBe(409);
    expect((await post({ action: 'send_back', id: R(9), reason: 'x' })).status).toBe(404);

    // The page shows why on the draft.
    as(STAFF, ['admin']);
    expect((await (await get(`run=${RUN}`)).json()).run).toMatchObject({ returnedBy: 'Lee Owner', returnedReason: 'Pay GS-209 next week' });
  });

  it("approves the ask the approver saw, by a super admin who didn't ask, making a payment to make for each vendor", async () => {
    as(OTHER, ['admin']);
    await post(SAVE);
    const askedAt = await asked();
    vi.clearAllMocks();
    // Only a super admin approves, even one who didn't ask.
    for (const who of [STAFF, OTHER]) {
      as(who, ['admin']);
      const staff = await post({ action: 'approve', id: RUN, askedAt });
      expect(staff.status).toBe(403);
      expect(await staff.json()).toEqual({ error: 'Only a super admin approves payment runs, sends them back, or drops a payment from one.' });
    }

    as(BOSS, ['super_admin']);
    const stale = await post({ action: 'approve', id: RUN, askedAt: '2026-11-01T16:00:00.000Z' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'It was taken back or asked for again since you opened it. Reload and check it. Nothing was approved.' });

    const res = await post({ action: 'approve', id: RUN, askedAt });
    expect(res.status).toBe(200);
    const [ozark, gateway] = paymentRows();
    expect(await res.json()).toEqual({ success: true, toMake: [ozark.id, gateway.id] });
    expect(netsuite.getBillsNow).toHaveBeenCalledWith(['7001', '7002', '7003']);
    // The stale one was turned away as it was approved.
    expect(state.rpcs.filter(([fn]) => fn === 'vendor_payment_run_approve').map(([, args]) => args)).toEqual([
      { p: { id: RUN, approver: BOSS, asked_at: '2026-11-01T16:00:00.000Z' } },
      { p: { id: RUN, approver: BOSS, asked_at: askedAt } },
    ]);
    expect(runRow()).toMatchObject({ status: 'approved', approved_by: BOSS });
    expect([ozark, gateway]).toMatchObject([
      { position: 1, vendor_netsuite_id: '31', method: 'check', bill_ids: ['7001', '7002'], total_cents: 141240, status: 'to_make' },
      { position: 2, vendor_netsuite_id: '47', method: 'ach', bill_ids: ['7003'], total_cents: 245000, status: 'to_make' },
    ]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: BOSS, table: 'vendor_payment_runs', recordId: RUN, action: 'approve',
      detail: { company: 'BMG', date: '2026-11-06', bank_account: '10100 Operating Checking', vendors: 2, bills: 3, total: '$3,862.40', asked_by: STAFF },
    });
    expect(notifyMany).toHaveBeenCalledWith([STAFF, OTHER, WATCHER], {
      type: 'books_payment_run_decided',
      title: 'Your payment run was approved',
      body: `${DESCRIBED}, approved. FleetSuite is making its bill payments in NetSuite.`,
      url: `/admin/pay-vendors?run=${RUN}`,
      channels: ['in_app', 'push', 'email'],
    });
    // Nothing goes to NetSuite until each payment's made.
    expect(netsuite.createVendorPayment).not.toHaveBeenCalled();

    // Approved again, it hands back what's still to make, and asks NetSuite nothing.
    expect(await (await post({ action: 'approve', id: RUN, askedAt })).json()).toEqual({ success: true, already: true, toMake: [ozark.id, gateway.id] });
    expect(paymentRows()).toHaveLength(2);
    expect(netsuite.getBillsNow).toHaveBeenCalledTimes(2);
  });

  it('says so when it was taken back, or another super admin approved it, just as it was approved', async () => {
    const askedAt = await asked();
    as(BOSS, ['super_admin']);
    state.before.vendor_payment_run_approve = () => { Object.assign(runRow()!, { status: 'draft', asked_by: null, asked_at: null }); };
    const takenBack = await post({ action: 'approve', id: RUN, askedAt });
    expect(takenBack.status).toBe(409);
    expect(await takenBack.json()).toEqual({ error: "It's a draft now: it was taken back or sent back. Nothing was approved." });
    expect(paymentRows()).toEqual([]);

    Object.assign(runRow()!, { status: 'waiting', asked_by: STAFF, asked_at: askedAt });
    state.before.vendor_payment_run_approve = () => {
      Object.assign(runRow()!, { status: 'approved', approved_by: WATCHER, approved_at: new Date().toISOString() });
    };
    expect(await (await post({ action: 'approve', id: RUN, askedAt })).json()).toEqual({ success: true, already: true, toMake: [] });
    expect(auditActions()).toEqual(['ask_approval']);
    expect(notifyMany).toHaveBeenCalledTimes(1);
  });

  it("never lets whoever asked approve it, and approves nothing NetSuite has otherwise now", async () => {
    as(BOSS, ['super_admin']);
    const saved = await (await post(SAVE)).json();
    const askedAt = (await (await post({ action: 'ask', id: RUN, updatedAt: saved.updatedAt })).json()).askedAt;
    const yours = await post({ action: 'approve', id: RUN, askedAt });
    expect(yours.status).toBe(403);
    expect(await yours.json()).toEqual({ error: "You asked for this one, so a super admin who didn't ask approves it. Nothing was approved." });
    // Turned away before NetSuite is asked: the one call is the ask's.
    expect(netsuite.getBillsNow).toHaveBeenCalledTimes(1);
    // Even when the run said otherwise as it was read.
    as(WATCHER, ['super_admin']);
    state.before.vendor_payment_run_approve = () => { runRow()!.asked_by = WATCHER; };
    const raced = await post({ action: 'approve', id: RUN, askedAt });
    expect(raced.status).toBe(403);

    runRow()!.asked_by = BOSS;
    netsuite.getBillsNow.mockResolvedValueOnce(new Map([...nowOf(OPEN)]).set('7003', { open: false, openCents: 0, vendorId: '47' }));
    const paid = await post({ action: 'approve', id: RUN, askedAt });
    expect(paid.status).toBe(400);
    expect(await paid.json()).toEqual({
      error: "Bill GS-209 isn't open in NetSuite now: it's paid, or waiting for approval there. It wasn't approved: send it back to be fixed.",
      problems: ["Bill GS-209 isn't open in NetSuite now: it's paid, or waiting for approval there."],
    });
    netsuite.getBillsNow.mockRejectedValueOnce(new Error('socket hang up'));
    const unanswered = await post({ action: 'approve', id: RUN, askedAt });
    expect(unanswered.status).toBe(502);
    expect(await unanswered.json()).toEqual({ error: "Couldn't check its bills against NetSuite (socket hang up). It wasn't approved. Try again." });
    expect(runRow()).toMatchObject({ status: 'waiting', approved_by: null });
    expect(paymentRows()).toEqual([]);

    await post({ action: 'take_back', id: RUN });
    const draft = await post({ action: 'approve', id: RUN, askedAt });
    expect(draft.status).toBe(409);
    expect(await draft.json()).toEqual({ error: "It's a draft now: it was taken back or sent back. Nothing was approved." });
    expect(netsuite.getBillsNow).toHaveBeenCalledTimes(4);
    expect((await post({ action: 'approve', id: R(9), askedAt })).status).toBe(404);
  });

  it('makes each payment once in NetSuite as a bill payment, keeping Books\' own copy, and the run is paid after the last', async () => {
    const { ozark, gateway } = await approved();
    vi.clearAllMocks();
    state.rpcs.length = 0;
    netsuite.findVendorPayment.mockReset()
      .mockResolvedValueOnce(null).mockResolvedValueOnce({ paymentId: '8302', number: 'CHK-5521', totalCents: 141240 })
      .mockResolvedValueOnce(null).mockResolvedValueOnce({ paymentId: '8303', number: 'ACH-0912', totalCents: 245000 });
    netsuite.createVendorPayment.mockResolvedValueOnce({ success: true, paymentId: '8302' }).mockResolvedValueOnce({ success: true, paymentId: '8303' });

    // Anyone who can use it makes them once it's approved.
    as(OTHER, ['admin']);
    const first = await post({ action: 'make', paymentId: ozark });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ success: true, billPaymentId: '8302', number: 'CHK-5521', totalCents: 141240, runDone: false });
    expect(netsuite.getBillsNow).toHaveBeenCalledWith(['7001', '7002']);
    expect(netsuite.findVendorPayment.mock.calls).toEqual([[`fleetsuite-vp-${ozark}`], [`fleetsuite-vp-${ozark}`]]);
    expect(netsuite.createVendorPayment).toHaveBeenCalledWith({
      externalId: `fleetsuite-vp-${ozark}`, vendorId: '31', subsidiaryId: '2', accountId: '211', tranDate: '2026-11-06', memo: 'November run',
      toBePrinted: true, amount: 1412.4, apply: [{ billId: '7001', amount: 812.4 }, { billId: '7002', amount: 600 }],
    });
    expect(rpcNames()).toEqual(['vendor_payment_claim', 'vendor_payment_made', 'gl_own_bill_payment_save']);
    expect(state.rpcs[0][1]).toEqual({ p: { id: ozark, by: OTHER } });
    expect(state.rpcs[1][1]).toEqual({ p: { id: ozark, netsuite_payment_id: '8302', netsuite_number: 'CHK-5521' } });
    expect(state.rpcs[2][1]).toEqual({ p: {
      netsuite_id: '8302', netsuite_number: 'CHK-5521', company: 'BMG', made_from_run: RUN, made_from_payment: ozark, vendor_netsuite_id: '31',
      vendor_name: 'Ozark Hose & Fitting', bank_account_netsuite_id: '211', payment_date: '2026-11-06', method: 'check', memo: 'November run',
      bills: [{ netsuite_id: '7001', number: 'B-4410', amount: '812.40' }, { netsuite_id: '7002', number: 'B-4471', amount: '600.00' }],
      amount: '1412.40', asked_by: STAFF, approved_by: BOSS,
    } });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: OTHER, table: 'vendor_payment_run_payments', recordId: ozark, action: 'create',
      detail: {
        netsuite_payment_id: '8302', netsuite_number: 'CHK-5521', run: RUN, company: 'BMG', vendor: 'Ozark Hose & Fitting', method: 'check',
        bank_account: '10100 Operating Checking', date: '2026-11-06', bills: ['Bill B-4410', 'Bill B-4471'], total: '$1,412.40', found_in_netsuite: false,
      },
    });
    expect(runRow()).toMatchObject({ status: 'approved' });

    // Approved again, it hands back only what's still to make.
    as(BOSS, ['super_admin']);
    expect(await (await post({ action: 'approve', id: RUN, askedAt: runRow()!.asked_at })).json()).toEqual({ success: true, already: true, toMake: [gateway] });
    as(OTHER, ['admin']);

    const second = await post({ action: 'make', paymentId: gateway });
    expect(await second.json()).toEqual({ success: true, billPaymentId: '8303', number: 'ACH-0912', totalCents: 245000, runDone: true });
    expect(netsuite.createVendorPayment).toHaveBeenLastCalledWith(expect.objectContaining({
      externalId: `fleetsuite-vp-${gateway}`, vendorId: '47', memo: 'ACH: November run', toBePrinted: false, amount: 2450, apply: [{ billId: '7003', amount: 2450 }],
    }));
    expect(runRow()).toMatchObject({ status: 'done' });
    expect(state.rpcs.filter(([fn]) => fn === 'gl_own_bill_payment_save').map(([, args]) => args.p)).toMatchObject([
      { netsuite_id: '8302', method: 'check', memo: 'November run' },
      { netsuite_id: '8303', method: 'ach', memo: 'ACH: November run', amount: '2450.00' },
    ]);
    // No alert for each payment: the approval said they're being made.
    expect(notifyMany).not.toHaveBeenCalled();

    // Pressed again, by anyone: it's made, and nothing goes to NetSuite.
    as(BOSS, ['super_admin']);
    expect(await (await post({ action: 'make', paymentId: ozark })).json()).toEqual({
      success: true, already: true, billPaymentId: '8302', number: 'CHK-5521', totalCents: 141240,
    });
    expect(netsuite.createVendorPayment).toHaveBeenCalledTimes(2);
    expect(netsuite.getBillsNow).toHaveBeenCalledTimes(2);
    expect(rpcNames().filter((fn) => fn === 'vendor_payment_claim')).toHaveLength(2);

    // The paid run shows each payment as made.
    const opened = (await (await get(`run=${RUN}`)).json()).run;
    expect(opened).toMatchObject({ status: 'done', approvedBy: 'Lee Owner', billsNow: null });
    expect(opened.made).toEqual([
      expect.objectContaining({
        id: ozark, position: 1, vendorId: '31', vendorName: 'Ozark Hose & Fitting', method: 'check', totalCents: 141240, status: 'made',
        sentBy: 'Robin Helper', stale: false, billPaymentId: '8302', number: 'CHK-5521', error: null, droppedBy: null,
      }),
      expect.objectContaining({ id: gateway, position: 2, status: 'made', billPaymentId: '8303', number: 'ACH-0912' }),
    ]);
  });

  it('finds one NetSuite made already, before making another', async () => {
    const { ozark } = await approved();
    netsuite.findVendorPayment.mockReset().mockResolvedValue({ paymentId: '8302', number: 'CHK-5521', totalCents: 141240 });
    // Books kept its copy already, the first time: that's no warning.
    state.ownSave = { data: { saved: false }, error: null };
    const res = await post({ action: 'make', paymentId: ozark });
    expect(await res.json()).toEqual({ success: true, already: true, billPaymentId: '8302', number: 'CHK-5521', totalCents: 141240, runDone: false });
    expect(netsuite.createVendorPayment).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ detail: expect.objectContaining({ found_in_netsuite: true }) }));
  });

  it("sends nothing NetSuite has otherwise now, and lets go so it's made again once it's fixed, or dropped", async () => {
    const { ozark } = await approved();
    netsuite.getBillsNow.mockResolvedValueOnce(new Map([['7001', { open: true, openCents: 81240, vendorId: '31' }], ['7002', { open: true, openCents: 40000, vendorId: '31' }]]));
    const res = await post({ action: 'make', paymentId: ozark });
    expect(res.status).toBe(400);
    const why = 'Bill B-4471 has $400.00 open in NetSuite now, less than the $600.00 this pays on it.';
    expect(await res.json()).toEqual({
      error: `${why} Nothing was sent: drop it from the run, or fix it in NetSuite and make it again.`, problems: [why],
    });
    expect(paymentRows()[0]).toMatchObject({ status: 'refused', error: why });
    expect(netsuite.findVendorPayment).not.toHaveBeenCalled();
    expect(netsuite.createVendorPayment).not.toHaveBeenCalled();

    // Fixed in NetSuite, it's made again.
    netsuite.findVendorPayment.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({ paymentId: '8302', number: 'CHK-5521', totalCents: 141240 });
    expect(await (await post({ action: 'make', paymentId: ozark })).json()).toMatchObject({ success: true, billPaymentId: '8302' });
    expect(paymentRows()[0]).toMatchObject({ status: 'made', error: null });
  });

  it("lets go when NetSuite can't be checked or refuses it, and says so in red", async () => {
    const { ozark } = await approved();
    netsuite.getBillsNow.mockRejectedValueOnce(new Error('socket hang up'));
    const unchecked = await post({ action: 'make', paymentId: ozark });
    expect(unchecked.status).toBe(502);
    expect(await unchecked.json()).toEqual({ error: "Couldn't check its bills against NetSuite (socket hang up). Nothing was sent. Make it again." });
    expect(paymentRows()[0]).toMatchObject({ status: 'refused', error: "Couldn't check its bills against NetSuite (socket hang up)." });

    netsuite.findVendorPayment.mockRejectedValueOnce(new Error("FleetSuite can't see NetSuite's bill payments, so it can't tell whether this one was made"));
    const unseen = await post({ action: 'make', paymentId: ozark });
    expect(unseen.status).toBe(502);
    expect(await unseen.json()).toEqual({
      error: "Couldn't check NetSuite for this bill payment (FleetSuite can't see NetSuite's bill payments, so it can't tell whether this one was made). Nothing was sent. Make it again.",
    });
    expect(netsuite.createVendorPayment).not.toHaveBeenCalled();

    netsuite.createVendorPayment.mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): Invalid apply reference key 7002.' });
    const refused = await post({ action: 'make', paymentId: ozark });
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({ error: 'NetSuite error (400): Invalid apply reference key 7002. No bill payment was made.' });
    expect(paymentRows()[0]).toMatchObject({ status: 'refused', error: 'NetSuite error (400): Invalid apply reference key 7002.' });
    netsuite.createVendorPayment.mockResolvedValueOnce({ success: false });
    expect(await (await post({ action: 'make', paymentId: ozark })).json()).toEqual({ error: "NetSuite didn't make the bill payment. No bill payment was made." });
    // Nothing was made: the audit log has only the ask and the approval.
    expect(auditActions()).toEqual(['ask_approval', 'approve']);
  });

  it("holds a payment NetSuite didn't say it made, and asks NetSuite about it from five minutes on", async () => {
    const { ozark, gateway } = await approved();
    // Gateway's is being made by another press just then: only Ozark's is held with why.
    Object.assign(paymentRows()[1], { status: 'sending', sent_by: OTHER, sent_at: new Date().toISOString(), error: null });
    netsuite.createVendorPayment.mockResolvedValueOnce({ success: false, error: "NetSuite didn't answer (socket hang up).", unsure: true });
    const unsure = await post({ action: 'make', paymentId: ozark });
    expect(unsure.status).toBe(502);
    expect(await unsure.json()).toEqual({
      error: "NetSuite didn't answer (socket hang up). FleetSuite can't tell whether NetSuite made it, so it's held. Press Ask NetSuite in a few minutes and FleetSuite will find out.",
      unsure: true,
    });
    expect(paymentRows()[0]).toMatchObject({ status: 'sending', error: "NetSuite didn't answer (socket hang up)." });
    expect(paymentRows()[1]).toMatchObject({ status: 'sending', error: null });
    Object.assign(paymentRows()[1], { status: 'to_make', sent_by: null, sent_at: null });
    // Held: its bills can't go in another run, nor Gateway's, still to make.
    expect(await (await get('company=BMG&bills=1')).json()).toMatchObject({ held: ['7001', '7002', '7003'] });

    // Too soon: it waits, and sends nothing.
    later(4);
    const soon = await post({ action: 'make', paymentId: ozark });
    expect(soon.status).toBe(409);
    expect(await soon.json()).toEqual({
      error: "NetSuite didn't say whether it made this bill payment (NetSuite didn't answer (socket hang up).). Press Ask NetSuite in a few minutes and FleetSuite will find out.",
      unsure: true,
    });
    expect((await (await get(`run=${RUN}`)).json()).run.made[0]).toMatchObject({ status: 'sending', stale: false });

    // From five minutes on: NetSuite has it, so it's made.
    later(6);
    expect((await (await get(`run=${RUN}`)).json()).run.made[0]).toMatchObject({ status: 'sending', stale: true });
    netsuite.findVendorPayment.mockReset().mockRejectedValueOnce(new Error('NetSuite SuiteQL error (503): Unavailable'));
    const unanswered = await post({ action: 'make', paymentId: ozark });
    expect(unanswered.status).toBe(502);
    expect(await unanswered.json()).toEqual({
      error: "Couldn't ask NetSuite what became of this bill payment (NetSuite SuiteQL error (503): Unavailable). Try again.", unsure: true,
    });
    netsuite.findVendorPayment.mockResolvedValueOnce({ paymentId: '8302', number: 'CHK-5521', totalCents: 141240 });
    expect(await (await post({ action: 'make', paymentId: ozark })).json()).toEqual({
      success: true, already: true, billPaymentId: '8302', number: 'CHK-5521', totalCents: 141240, runDone: false,
    });
    expect(netsuite.createVendorPayment).toHaveBeenCalledTimes(1);
    expect((await (await get(`run=${RUN}`)).json()).run.made[0]).toMatchObject({ status: 'made', stale: false });

    // Gateway's: NetSuite has none from that press, so it's let go and none was made.
    netsuite.createVendorPayment.mockResolvedValueOnce({ success: false, error: 'NetSuite error (503): Server busy', unsure: true });
    expect((await post({ action: 'make', paymentId: gateway })).status).toBe(502);
    later(12);
    netsuite.findVendorPayment.mockResolvedValueOnce(null);
    const none = await post({ action: 'make', paymentId: gateway });
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: 'NetSuite has no bill payment from this press, so none was made. Make it again, or drop it from the run.' });
    expect(paymentRows()[1]).toMatchObject({ status: 'refused', error: 'NetSuite has no bill payment from this press, so none was made.' });
  });

  it('turns away a press another one is making now, and says what it is', async () => {
    const { ozark } = await approved();
    state.before.vendor_payment_claim = () => {
      Object.assign(paymentRows()[0], { status: 'sending', sent_by: OTHER, sent_at: new Date().toISOString(), error: null });
    };
    const res = await post({ action: 'make', paymentId: ozark });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "It's being made in NetSuite now. Don't press again: reload in a minute to see it." });
    expect(netsuite.createVendorPayment).not.toHaveBeenCalled();
    expect(netsuite.findVendorPayment).not.toHaveBeenCalled();
  });

  it('says what became of a payment made, dropped or deleted just as it was pressed', async () => {
    const { ozark, gateway } = await approved();
    vi.clearAllMocks();
    state.before.vendor_payment_claim = () => {
      Object.assign(paymentRows()[0], { status: 'made', netsuite_payment_id: '8302', netsuite_number: 'CHK-5521' });
    };
    expect(await (await post({ action: 'make', paymentId: ozark })).json()).toEqual({
      success: true, already: true, billPaymentId: '8302', number: 'CHK-5521', totalCents: 141240,
    });

    state.before.vendor_payment_claim = () => { paymentRows()[1].status = 'dropped'; };
    const dropped = await post({ action: 'make', paymentId: gateway });
    expect(dropped.status).toBe(409);
    expect(await dropped.json()).toEqual({ error: 'It was dropped from the run: its bills are still open in NetSuite.' });

    paymentRows()[1].status = 'to_make';
    state.before.vendor_payment_claim = () => {
      state.tables.vendor_payment_run_payments = state.tables.vendor_payment_run_payments.filter((p) => p.id !== gateway);
    };
    const gone = await post({ action: 'make', paymentId: gateway });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "There's no such payment in a payment run." });
    expect(netsuite.getBillsNow).not.toHaveBeenCalled();
    expect(netsuite.createVendorPayment).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("keeps no copy when NetSuite's total isn't what was sent, and says when Books didn't keep one", async () => {
    const { ozark, gateway } = await approved();
    netsuite.findVendorPayment.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({ paymentId: '8302', number: 'CHK-5521', totalCents: 141200 });
    const differs = await (await post({ action: 'make', paymentId: ozark })).json();
    expect(differs).toEqual({
      success: true, billPaymentId: '8302', number: 'CHK-5521', totalCents: 141240, runDone: false,
      booksWarning: "Books didn't keep its copy (NetSuite's bill payment comes to $1,412.00, not the $1,412.40 FleetSuite sent: look at it in NetSuite). The bill payment is in NetSuite.",
    });
    expect(rpcNames()).not.toContain('gl_own_bill_payment_save');
    expect(logAudit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      detail: expect.objectContaining({ total: '$1,412.40', netsuite_total: '$1,412.00' }),
    }));

    // The copy can't be saved, or NetSuite's number can't be read back: the payment's made either way.
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.ownSave = { data: null, error: { message: "gl: company BMG doesn't exist" } };
    netsuite.findVendorPayment.mockReset().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('socket hang up'));
    netsuite.createVendorPayment.mockResolvedValueOnce({ success: true, paymentId: '8303' });
    expect(await (await post({ action: 'make', paymentId: gateway })).json()).toEqual({
      success: true, billPaymentId: '8303', number: null, totalCents: 245000, runDone: true,
      booksWarning: "Books didn't keep its copy (gl: company BMG doesn't exist). The bill payment is in NetSuite.",
    });
    expect(runRow()).toMatchObject({ status: 'done' });
    log.mockRestore();
  });

  it("says it's made even when FleetSuite can't keep that it was, so Ask NetSuite finds it later", async () => {
    const { ozark } = await approved();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.madeError = { message: 'timeout' };
    netsuite.findVendorPayment.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({ paymentId: '8302', number: 'CHK-5521', totalCents: 141240 });
    expect(await (await post({ action: 'make', paymentId: ozark })).json()).toEqual({
      success: true, billPaymentId: '8302', number: 'CHK-5521', totalCents: 141240, runDone: false,
    });
    expect(log.mock.calls[0][0]).toBe(`[pay-vendors] payment ${ozark} made as NetSuite bill payment 8302 but not kept: timeout`);
    expect(paymentRows()[0]).toMatchObject({ status: 'sending' });
    log.mockRestore();
  });

  it("makes nothing for a payment that's dropped, in a run that isn't approved, or that isn't there", async () => {
    const { ozark } = await approved();
    expect((await post({ action: 'make', paymentId: 'f0000000-0000-4000-8000-000000000099' })).status).toBe(404);
    paymentRows()[0].status = 'dropped';
    const dropped = await post({ action: 'make', paymentId: ozark });
    expect(dropped.status).toBe(409);
    expect(await dropped.json()).toEqual({ error: 'It was dropped from the run: its bills are still open in NetSuite.' });
    paymentRows()[0].status = 'to_make';
    runRow()!.status = 'waiting';
    const notApproved = await post({ action: 'make', paymentId: ozark });
    expect(notApproved.status).toBe(409);
    expect(await notApproved.json()).toEqual({ error: "It's asked for approval: take it back to change it." });
    runRow()!.status = 'approved';
    state.tables.gl_companies = state.tables.gl_companies.filter((c) => c.code !== 'BMG');
    const noCompany = await post({ action: 'make', paymentId: ozark });
    expect(noCompany.status).toBe(400);
    expect(await noCompany.json()).toEqual({ error: 'Books has no company BMG with a NetSuite subsidiary. Nothing was sent.' });
    expect(paymentRows()[0]).toMatchObject({ status: 'to_make' });
    expect(netsuite.createVendorPayment).not.toHaveBeenCalled();
    expect(rpcNames()).not.toContain('vendor_payment_claim');
  });

  it('lets a super admin drop a payment not made yet with why, leaving its bills open, and the run is paid after the last', async () => {
    const { ozark, gateway } = await approved();
    as(STAFF, ['admin']);
    expect((await post({ action: 'drop', paymentId: ozark, reason: 'Ozark is sending a credit' })).status).toBe(403);
    as(BOSS, ['super_admin']);
    expect((await post({ action: 'drop', paymentId: ozark, reason: '  ' })).status).toBe(400);
    expect(await (await post({ action: 'drop', paymentId: ozark, reason: 'Ozark is sending a credit' })).json()).toEqual({ success: true, runDone: false });
    expect(paymentRows()[0]).toMatchObject({ status: 'dropped', dropped_by: BOSS, dropped_reason: 'Ozark is sending a credit' });
    expect(logAudit).toHaveBeenLastCalledWith(expect.anything(), {
      actorId: BOSS, table: 'vendor_payment_run_payments', recordId: ozark, action: 'drop',
      detail: { run: RUN, vendor: 'Ozark Hose & Fitting', bills: ['Bill B-4410', 'Bill B-4471'], reason: 'Ozark is sending a credit' },
    });
    // Its bills are free for another run.
    expect((await (await get('company=BMG&bills=1')).json()).held).toEqual(['7003']);

    // Dropped again, it says so, and keeps the first reason.
    const again = await post({ action: 'drop', paymentId: ozark, reason: 'again' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'It was dropped already.' });
    expect(paymentRows()[0]).toMatchObject({ dropped_reason: 'Ozark is sending a credit' });
    expect(auditActions().filter((a) => a === 'drop')).toHaveLength(1);

    for (const [status, error] of [
      ['sending', "It's being made in NetSuite now, so it can't be dropped."],
      ['made', "It's in NetSuite already, so it can't be dropped."],
    ] as const) {
      paymentRows()[1].status = status;
      const res = await post({ action: 'drop', paymentId: gateway, reason: 'x' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error });
    }
    paymentRows()[1].status = 'refused';
    expect(await (await post({ action: 'drop', paymentId: gateway, reason: 'Paid by wire' })).json()).toEqual({ success: true, runDone: true });
    expect(runRow()).toMatchObject({ status: 'done' });
    expect((await post({ action: 'drop', paymentId: 'f0000000-0000-4000-8000-000000000099', reason: 'x' })).status).toBe(404);
    expect(netsuite.createVendorPayment).not.toHaveBeenCalled();
  });
});
