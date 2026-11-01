// /api/invoices/bank-deposit (src/lib/bank-deposit.ts): who can open it while
// bank deposits are switched off and once they're on, what it lists (the
// company's bank accounts, what NetSuite has waiting in Undeposited Funds, and
// what another press is depositing now), and what one press of Make deposit
// does: the bank deposit worked out again from what NetSuite has waiting now,
// no payment in two bank deposits, made once in NetSuite under the press's
// own External ID however often it's pressed, let go when NetSuite refuses,
// held when NetSuite can't say and asked about later, and Books' own copy
// kept unless NetSuite's total isn't what was sent. Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const STAFF = 'd0000000-0000-4000-8000-000000000001';
const OTHER = 'd0000000-0000-4000-8000-000000000002';

// The route makes its service client when it loads, so what the mocks hand it is made first.
const h = vi.hoisted(() => {
  const state = {
    userId: '',
    roles: [] as string[],
    hasInvoicing: true,
    canSeeMoney: true,
    tables: {} as Record<string, Record<string, any>[]>,
    /** Tables whose reads fail, with why. */
    readErrors: {} as Record<string, string>,
    rpcs: [] as Array<[string, Record<string, any>]>,
    ownSave: null as null | { data: unknown; error: { message: string } | null },
    madeError: null as null | { message: string },
    /** Runs once, just before the next claim: another press getting there first. */
    beforeClaim: null as (() => void) | null,
    /** Runs once, just before a table is next read. */
    beforeRead: {} as Record<string, (() => void) | undefined>,
  };
  const netsuite = {
    getUndepositedFunds: vi.fn(),
    findBankDeposit: vi.fn(),
    createBankDeposit: vi.fn(),
  };

  // An in-memory stand-in for the tables the route reads and writes.
  function query(table: string) {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    const sorts: Array<[string, boolean]> = [];
    let patch: Record<string, any> | null = null;
    let limit = Infinity;
    const rows = () => (state.tables[table] ??= []);
    const run = () => {
      const first = state.beforeRead[table];
      if (!patch && first) { delete state.beforeRead[table]; first(); }
      if (!patch && state.readErrors[table]) return { data: null, error: { message: state.readErrors[table] } };
      const matched = rows().filter((r) => filters.every((f) => f(r)));
      if (patch) {
        for (const r of matched) Object.assign(r, patch);
        return { data: null, error: null };
      }
      const sorted = [...matched].sort((a, b) => {
        for (const [c, asc] of sorts) {
          const d = String(a[c]).localeCompare(String(b[c]));
          if (d !== 0) return asc ? d : -d;
        }
        return 0;
      });
      return { data: sorted.slice(0, limit).map((r) => ({ ...r })), error: null };
    };
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return builder; },
      not: (c: string, op: string, v: unknown) => {
        if (op !== 'is' || v !== null) throw new Error(`the fake has no not(${op}, ${String(v)})`);
        filters.push((r) => (r[c] ?? null) !== null);
        return builder;
      },
      order: (c: string, o?: { ascending?: boolean }) => { sorts.push([c, o?.ascending !== false]); return builder; },
      limit: (n: number) => { limit = n; return builder; },
      update: (p: Record<string, any>) => { patch = p; return builder; },
      maybeSingle: async () => {
        const r = run();
        return r.error ? { data: null, error: r.error } : { data: r.data?.[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  // made_bank_deposit_claim, _let_go and _made as migration 487 has them, on the in-memory table.
  const presses = () => (state.tables.made_bank_deposits ??= []);
  const content = (p: Record<string, any>) => ({
    company: p.company, subsidiary_netsuite_id: p.subsidiary_netsuite_id, bank_account_netsuite_id: p.bank_account_netsuite_id,
    bank_account_name: p.bank_account_name || null, deposit_date: p.deposit_date, memo: p.memo || null, lines: p.lines,
    line_ids: p.lines.map((l: { netsuite_id: string }) => l.netsuite_id),
    total_cents: p.lines.reduce((s: number, l: { cents: number }) => s + l.cents, 0),
  });
  const rpcs: Record<string, (p: Record<string, any>) => { data: unknown; error: { message: string } | null }> = {
    made_bank_deposit_claim: (p) => {
      if (state.beforeClaim) { const first = state.beforeClaim; state.beforeClaim = null; first(); }
      const now = new Date().toISOString();
      const r = presses().find((x) => x.id === p.id);
      if (r?.status === 'made') return { data: { state: 'made', netsuite_deposit_id: r.netsuite_deposit_id, netsuite_number: r.netsuite_number }, error: null };
      if (r?.status === 'sending') return { data: { state: 'sending', deposit: { ...r } }, error: null };
      const ids: string[] = content(p).line_ids;
      const held = [...new Set(presses().filter((x) => x.status === 'sending' && x.id !== p.id)
        .flatMap((x) => x.line_ids as string[]).filter((id) => ids.includes(id)))].sort();
      if (held.length > 0) return { data: { state: 'held', held }, error: null };
      if (!r) {
        const row = {
          id: p.id, ...content(p), status: 'sending', sent_by: p.by, sent_at: now, netsuite_deposit_id: null, netsuite_number: null,
          error: null, created_by: p.by, created_at: now, updated_at: now,
        };
        presses().push(row);
        return { data: { state: 'claimed', deposit: { ...row } }, error: null };
      }
      Object.assign(r, content(p), { status: 'sending', sent_by: p.by, sent_at: now, error: null, updated_at: now });
      return { data: { state: 'claimed', deposit: { ...r } }, error: null };
    },
    made_bank_deposit_let_go: (p) => {
      const r = presses().find((x) => x.id === p.id && x.status === 'sending');
      if (r) Object.assign(r, { status: 'open', sent_by: null, sent_at: null, error: p.error });
      return { data: { let_go: !!r }, error: null };
    },
    made_bank_deposit_made: (p) => {
      if (state.madeError) return { data: null, error: state.madeError };
      const r = presses().find((x) => x.id === p.id && x.status === 'sending');
      if (r) Object.assign(r, { status: 'made', netsuite_deposit_id: p.netsuite_deposit_id, netsuite_number: p.netsuite_number, error: null });
      return { data: { made: !!r }, error: null };
    },
    gl_own_bank_deposit_save: () => state.ownSave ?? { data: { saved: true }, error: null },
  };
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.rpcs.push([fn, args]);
      return rpcs[fn] ? rpcs[fn](args.p) : { data: null, error: { message: `nothing answers ${fn}` } };
    },
  };
  return { state, netsuite, service };
});

vi.mock('@/lib/api-auth', () => ({
  requireFeature: vi.fn(async () => (h.state.hasInvoicing
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
import { GET, POST } from '../app/api/invoices/bank-deposit/route';
import type { WaitingItem } from './bank-deposit';

const P = (n: number) => `e0000000-0000-4000-8000-00000000000${n}`;
const REQUEST = P(1);
const NOW = '2026-10-31T17:00:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

const COMPANIES = [
  { id: 'g1', code: 'BMG', name: 'BMG Fleet Installations', netsuite_subsidiary_id: '2', active: true },
  { id: 'g2', code: '1084', name: '1084 Cool Springs', netsuite_subsidiary_id: '3', active: true },
];
const account = (netsuite_account_id: string | null, number: string | null, name: string, over: Record<string, unknown> = {}) => ({
  netsuite_account_id, number, name, company_id: null, netsuite_subsidiary_ids: null, account_type: 'bank', active: true, is_summary: false, ...over,
});
const ACCOUNTS = [
  account('211', '10100', 'Operating Checking', { company_id: 'g1', netsuite_subsidiary_ids: ['2'] }),
  account('214', null, 'Payroll Checking', { netsuite_subsidiary_ids: ['2', '3'] }),
  // NetSuite didn't say whose: the company it's in Books under.
  account('221', '10300', 'Cool Springs Checking', { company_id: 'g2' }),
  account('230', '10900', 'Old Savings', { company_id: 'g1', netsuite_subsidiary_ids: ['2'], active: false }),
  account('240', '10000', 'Cash Accounts', { company_id: 'g1', netsuite_subsidiary_ids: ['2'], is_summary: true }),
  account('250', '12000', 'Undeposited Funds', { company_id: 'g1', netsuite_subsidiary_ids: ['2'], account_type: 'other_current_asset' }),
  account('260', '10200', 'Payroll Clearing', { company_id: 'g1', netsuite_subsidiary_ids: ['3'] }),
  account(null, '10050', 'Petty Cash', { company_id: 'g1' }),
  account('ACCT-9', '10060', 'Old Import', { company_id: 'g1', netsuite_subsidiary_ids: ['2'] }),
];
const BMG_ACCOUNTS = [
  { netsuiteId: '211', number: '10100', name: 'Operating Checking' },
  { netsuiteId: '214', number: null, name: 'Payroll Checking' },
];

const WAITING: WaitingItem[] = [
  { netsuiteId: '9001', kind: 'payment', number: 'PYMT-9001', date: '2026-10-28', customerName: 'Rivera Plumbing', reference: '10442', cents: 125000 },
  { netsuiteId: '9002', kind: 'payment', number: 'PYMT-9002', date: '2026-10-29', customerName: 'Gateway Electric', reference: null, cents: 48050 },
  { netsuiteId: '9003', kind: 'deposit', number: 'DEP-77', date: '2026-10-30', customerName: 'Ozark Fleet Co', reference: '2210', cents: 250000 },
];
const pressLine = (w: WaitingItem) => ({
  netsuite_id: w.netsuiteId, kind: w.kind, number: w.number, date: w.date, customer_name: w.customerName, reference: w.reference, cents: w.cents,
});

/** PYMT-9001 and DEP-77 into Operating Checking on October 30. */
const BODY = {
  requestId: REQUEST, company: 'BMG', accountId: '211', date: '2026-10-30', memo: ' Slip 14 ', lineIds: ['9001', '9003'], expectedCents: 375000,
};
const EXTERNAL = `fleetsuite-bd-${REQUEST}`;
const FOUND = { depositId: '8301', number: 'DEP-1207', totalCents: 375000 };

const get = (query: string) => GET(new NextRequest(`https://app.test/api/invoices/bank-deposit?${query}`));
const post = (body: Record<string, unknown>) => POST(new NextRequest('https://app.test/api/invoices/bank-deposit', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
const switchOn = (on: boolean) => { state.tables.books_switches = [{ piece: 'bank_deposits', is_on: on }]; };
const press = (id: string) => state.tables.made_bank_deposits?.find((r) => r.id === id);
const rpcNames = () => state.rpcs.map(([fn]) => fn);
/** Another press of Make deposit, being made now: PYMT-9002 into Operating Checking. */
const another = (over: Record<string, any> = {}) => ({
  id: P(9), company: 'BMG', subsidiary_netsuite_id: '2', bank_account_netsuite_id: '211', bank_account_name: '10100 Operating Checking',
  deposit_date: '2026-10-29', memo: null, lines: [pressLine(WAITING[1])], line_ids: ['9002'], total_cents: 48050, status: 'sending',
  sent_by: OTHER, sent_at: ago(1), netsuite_deposit_id: null, netsuite_number: null, error: null, created_at: ago(1), ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  state.userId = STAFF;
  state.roles = ['admin'];
  state.hasInvoicing = true;
  state.canSeeMoney = true;
  state.tables = {
    gl_companies: COMPANIES.map((c) => ({ ...c })),
    gl_accounts: ACCOUNTS.map((a) => ({ ...a })),
    made_bank_deposits: [],
  };
  state.readErrors = {};
  state.beforeRead = {};
  state.rpcs.length = 0;
  state.ownSave = null;
  state.madeError = null;
  state.beforeClaim = null;
  switchOn(true);
  vi.clearAllMocks();
  for (const fn of Object.values(netsuite)) fn.mockReset();
  netsuite.getUndepositedFunds.mockResolvedValue(WAITING);
  netsuite.findBankDeposit.mockResolvedValueOnce(null).mockResolvedValue(FOUND);
  netsuite.createBankDeposit.mockResolvedValue({ success: true, depositId: '8301' });
});

afterEach(() => { vi.useRealTimers(); });

describe('while bank deposits are switched off', () => {
  beforeEach(() => switchOn(false));

  it("shows the Bank deposit button to super admins only, and to nobody who can't see prices", async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    state.roles = ['super_admin'];
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: true });
    state.canSeeMoney = false;
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    state.hasInvoicing = false;
    expect((await get('status=1')).status).toBe(403);
    expect(requireFeature).toHaveBeenCalledWith(expect.anything(), 'invoicing');
  });

  it('lets a super admin see what it would send, and nobody else', async () => {
    const refused = await get('company=BMG');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Bank deposits are switched off until they move into FleetSuite during 2027.', switchedOff: true });
    expect(netsuite.getUndepositedFunds).not.toHaveBeenCalled();

    state.roles = ['super_admin'];
    const res = await get('company=BMG');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      today: '2026-10-31',
      companies: [{ code: 'BMG', name: 'BMG Fleet Installations' }, { code: '1084', name: '1084 Cool Springs' }],
      company: 'BMG',
      accounts: BMG_ACCOUNTS,
      waiting: WAITING,
      held: [],
      switchedOn: false,
      offText: 'Bank deposits are switched off until they move into FleetSuite during 2027. You can see what it would send; nothing goes to NetSuite.',
    });
    // A year back, as far back as a bank deposit goes.
    expect(netsuite.getUndepositedFunds).toHaveBeenCalledWith('2', { since: '2025-10-30' });
  });

  it('sends nothing, for a super admin either', async () => {
    state.roles = ['super_admin'];
    const res = await post(BODY);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Bank deposits are switched off until they move into FleetSuite during 2027. Nothing was sent to NetSuite.', switchedOff: true,
    });
    expect(netsuite.getUndepositedFunds).not.toHaveBeenCalled();
    expect(netsuite.createBankDeposit).not.toHaveBeenCalled();
    expect(state.rpcs).toEqual([]);
  });

  it("counts a switch that can't be read as off", async () => {
    state.readErrors.books_switches = 'timeout';
    expect(await (await get('status=1')).json()).toEqual({ on: false, canUse: false });
    expect((await post(BODY)).status).toBe(403);
    expect(netsuite.createBankDeposit).not.toHaveBeenCalled();
  });
});

describe('once bank deposits are on', () => {
  it('opens to anyone with Invoicing who can see prices', async () => {
    expect(await (await get('status=1')).json()).toEqual({ on: true, canUse: true });
    const res = await get('company=BMG');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ switchedOn: true, offText: null, company: 'BMG' });

    state.canSeeMoney = false;
    for (const res2 of [await get('company=BMG'), await post(BODY)]) {
      expect(res2.status).toBe(403);
      expect(await res2.json()).toEqual({ error: 'Forbidden: this account cannot see billing' });
    }
    state.canSeeMoney = true;
    state.hasInvoicing = false;
    expect((await get('company=BMG')).status).toBe(403);
    expect((await post(BODY)).status).toBe(403);
    expect(netsuite.createBankDeposit).not.toHaveBeenCalled();
  });

  it("lists each company's own bank accounts, the first company when none is named", async () => {
    for (const q of ['', 'company=', 'company=%20']) {
      expect(await (await get(q)).json()).toMatchObject({ company: 'BMG', accounts: BMG_ACCOUNTS });
    }
    const cool = await (await get('company=1084')).json();
    expect(cool).toMatchObject({
      company: '1084',
      accounts: [{ netsuiteId: '260', number: '10200', name: 'Payroll Clearing' }, { netsuiteId: '221', number: '10300', name: 'Cool Springs Checking' }, { netsuiteId: '214', number: null, name: 'Payroll Checking' }],
    });
    expect(netsuite.getUndepositedFunds).toHaveBeenLastCalledWith('3', { since: '2025-10-30' });

    const unknown = await get('company=ACME');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Books has no company by that name with a NetSuite subsidiary.' });
    // A company with no NetSuite subsidiary, or one that isn't active, isn't one.
    state.tables.gl_companies[1].netsuite_subsidiary_id = null;
    expect((await get('company=1084')).status).toBe(404);
    expect((await (await get('')).json()).companies).toEqual([{ code: 'BMG', name: 'BMG Fleet Installations' }]);
    state.tables.gl_companies[0].active = false;
    expect((await get('')).status).toBe(404);
  });

  it('marks what another press is depositing now', async () => {
    state.tables.made_bank_deposits = [
      another(),
      another({ id: P(8), status: 'made', netsuite_deposit_id: '8200', netsuite_number: 'DEP-1200', lines: [pressLine(WAITING[0])], line_ids: ['9001'] }),
      another({ id: P(7), status: 'open', lines: [pressLine(WAITING[2])], line_ids: ['9003'] }),
      another({ id: P(6), company: '1084', lines: [pressLine(WAITING[2])], line_ids: ['9003'] }),
    ];
    expect((await (await get('company=BMG')).json()).held).toEqual(['9002']);
  });

  it("says when what's waiting, the accounts or the companies can't be read", async () => {
    netsuite.getUndepositedFunds.mockRejectedValueOnce(new Error("FleetSuite can't see NetSuite's customer payments, so it can't tell what's waiting in Undeposited Funds"));
    const failed = await get('company=BMG');
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      error: "Couldn't read what's waiting in Undeposited Funds from NetSuite (FleetSuite can't see NetSuite's customer payments, so it can't tell what's waiting in Undeposited Funds).",
    });
    for (const table of ['gl_accounts', 'gl_companies', 'made_bank_deposits']) {
      state.readErrors = { [table]: `${table} timeout` };
      const res = await get('company=BMG');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: `${table} timeout` });
    }
  });

  it("makes the bank deposit once in NetSuite and keeps Books' own copy", async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, depositId: '8301', number: 'DEP-1207', totalCents: 375000 });

    expect(netsuite.getUndepositedFunds).toHaveBeenCalledWith('2', { since: '2025-10-30' });
    expect(netsuite.findBankDeposit.mock.calls).toEqual([[EXTERNAL], [EXTERNAL]]);
    expect(netsuite.createBankDeposit).toHaveBeenCalledTimes(1);
    expect(netsuite.createBankDeposit).toHaveBeenCalledWith({
      externalId: EXTERNAL, subsidiaryId: '2', accountId: '211', tranDate: '2026-10-30', memo: 'Slip 14', paymentIds: ['9001', '9003'],
    });

    expect(rpcNames()).toEqual(['made_bank_deposit_claim', 'made_bank_deposit_made', 'gl_own_bank_deposit_save']);
    expect(state.rpcs[0][1].p).toEqual({
      id: REQUEST, by: STAFF, company: 'BMG', subsidiary_netsuite_id: '2', bank_account_netsuite_id: '211',
      bank_account_name: '10100 Operating Checking', deposit_date: '2026-10-30', memo: 'Slip 14',
      lines: [pressLine(WAITING[0]), pressLine(WAITING[2])],
    });
    expect(state.rpcs[1][1].p).toEqual({ id: REQUEST, netsuite_deposit_id: '8301', netsuite_number: 'DEP-1207' });
    expect(press(REQUEST)).toMatchObject({ status: 'made', netsuite_deposit_id: '8301', netsuite_number: 'DEP-1207', total_cents: 375000 });
    expect(state.rpcs[2][1].p).toEqual({
      netsuite_id: '8301', netsuite_number: 'DEP-1207', company: 'BMG', made_from_id: REQUEST, bank_account_netsuite_id: '211',
      deposit_date: '2026-10-30', memo: 'Slip 14',
      lines: [
        { netsuite_id: '9001', kind: 'payment', number: 'PYMT-9001', customer_name: 'Rivera Plumbing', amount: '1250.00' },
        { netsuite_id: '9003', kind: 'deposit', number: 'DEP-77', customer_name: 'Ozark Fleet Co', amount: '2500.00' },
      ],
      amount: '3750.00', made_by: STAFF,
    });
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: STAFF, table: 'made_bank_deposits', recordId: REQUEST, action: 'create',
      detail: {
        netsuite_deposit_id: '8301', netsuite_number: 'DEP-1207', company: 'BMG', bank_account: '10100 Operating Checking',
        date: '2026-10-30', payments: ['PYMT-9001', 'DEP-77'], total: '$3,750.00', found_in_netsuite: false,
      },
    });

    // Pressed again, by anyone: it's made, and nothing goes to NetSuite.
    state.userId = OTHER;
    const again = await post({ ...BODY, lineIds: ['9002'], expectedCents: 1 });
    expect(await again.json()).toEqual({ success: true, already: true, depositId: '8301', number: 'DEP-1207', totalCents: 375000 });
    expect(netsuite.createBankDeposit).toHaveBeenCalledTimes(1);
    expect(netsuite.getUndepositedFunds).toHaveBeenCalledTimes(1);
    // Invoicing is what opens it, every time.
    expect(vi.mocked(requireFeature).mock.calls.map(([, feature]) => feature)).toEqual(['invoicing', 'invoicing']);
  });

  it("makes 1084's into an account it shares, with no memo and no number on NetSuite's side", async () => {
    netsuite.findBankDeposit.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({ depositId: '8302', number: '', totalCents: 48050 });
    netsuite.createBankDeposit.mockResolvedValueOnce({ success: true, depositId: '8302' });
    const res = await post({ ...BODY, company: '1084', accountId: '214', memo: '', lineIds: ['9002'], expectedCents: 48050 });
    expect(await res.json()).toEqual({ success: true, depositId: '8302', number: null, totalCents: 48050 });
    expect(netsuite.getUndepositedFunds).toHaveBeenCalledWith('3', { since: '2025-10-30' });
    expect(netsuite.createBankDeposit.mock.calls[0][0]).toEqual({
      externalId: EXTERNAL, subsidiaryId: '3', accountId: '214', tranDate: '2026-10-30', memo: null, paymentIds: ['9002'],
    });
    expect(press(REQUEST)).toMatchObject({
      status: 'made', company: '1084', subsidiary_netsuite_id: '3', bank_account_name: 'Payroll Checking', memo: null, netsuite_number: null,
    });
    expect(state.rpcs[2][1].p).toMatchObject({ company: '1084', netsuite_number: null, memo: null, amount: '480.50' });
  });

  it("works it out again from what NetSuite has waiting now, and sends nothing that doesn't fit", async () => {
    netsuite.getUndepositedFunds.mockResolvedValueOnce([WAITING[0], WAITING[1]]);
    const gone = await post(BODY);
    expect(gone.status).toBe(400);
    expect(await gone.json()).toEqual({
      error: "One of the ones ticked isn't waiting in Undeposited Funds any more: reload to see what is. Nothing was sent.",
      problems: ["One of the ones ticked isn't waiting in Undeposited Funds any more: reload to see what is."],
    });

    netsuite.getUndepositedFunds.mockResolvedValueOnce([WAITING[0], WAITING[1], { ...WAITING[2], cents: 240000 }]);
    expect((await (await post(BODY)).json()).problems).toEqual([
      "What's waiting changed since the page opened: the ones ticked come to $3,650.00 now. Check them and press again.",
    ]);
    expect((await (await post({ ...BODY, date: '2026-11-01' })).json()).problems).toEqual(["A bank deposit can't be dated after today."]);
    expect((await (await post({ ...BODY, date: '2026-10-29' })).json()).problems)
      .toEqual(["A bank deposit can't be dated before the payments and deposits in it."]);
    // An account that's 1084's alone, or isn't a bank account, isn't one BMG's goes into.
    for (const accountId of ['221', '250', '230', '999']) {
      expect((await (await post({ ...BODY, accountId })).json()).problems).toEqual(["That isn't one of the company's bank accounts."]);
    }
    for (const company of ['ACME', '', 'bmg']) {
      const res = await post({ ...BODY, company });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Books has no company by that name with a NetSuite subsidiary. Nothing was sent.' });
    }
    for (const bad of [
      { requestId: 'not-a-uuid' }, { accountId: 'Operating' }, { lineIds: [] }, { lineIds: ['PYMT-9001'] }, { expectedCents: -1 },
      { expectedCents: undefined }, { lineIds: Array.from({ length: 201 }, (_, i) => String(10000 + i)) },
    ]) {
      expect((await post({ ...BODY, ...bad })).status).toBe(400);
    }
    expect(state.rpcs).toEqual([]);
    expect(netsuite.createBankDeposit).not.toHaveBeenCalled();
  });

  it("sends nothing when what's waiting can't be read from NetSuite", async () => {
    netsuite.getUndepositedFunds.mockRejectedValueOnce(new Error('socket hang up'));
    const res = await post(BODY);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Couldn't read what's waiting in Undeposited Funds from NetSuite (socket hang up). Nothing was sent." });
    state.readErrors.gl_accounts = 'timeout';
    expect((await post(BODY)).status).toBe(500);
    expect(state.rpcs).toEqual([]);
    expect(netsuite.createBankDeposit).not.toHaveBeenCalled();
  });

  it('turns away a payment another press is depositing now, before the claim or at it', async () => {
    state.tables.made_bank_deposits = [another()];
    const before = await post({ ...BODY, lineIds: ['9001', '9002'], expectedCents: 173050 });
    expect(before.status).toBe(400);
    expect(await before.json()).toEqual({
      error: 'PYMT-9002 is in a bank deposit being made now. Nothing was sent.', problems: ['PYMT-9002 is in a bank deposit being made now.'],
    });
    expect(state.rpcs).toEqual([]);

    // Another press takes them while NetSuite's being read.
    state.beforeClaim = () => {
      state.tables.made_bank_deposits.push(another({ id: P(8), lines: [pressLine(WAITING[2]), pressLine(WAITING[0])], line_ids: ['9003', '9001'] }));
    };
    const at = await post(BODY);
    expect(at.status).toBe(409);
    expect(await at.json()).toEqual({ error: 'PYMT-9001, DEP-77 are in a bank deposit being made now. Nothing was sent.' });
    state.tables.made_bank_deposits = [another()];
    state.beforeClaim = () => { state.tables.made_bank_deposits.push(another({ id: P(8), lines: [pressLine(WAITING[2])], line_ids: ['9003'] })); };
    expect(await (await post({ ...BODY, requestId: P(2) })).json()).toEqual({ error: 'DEP-77 is in a bank deposit being made now. Nothing was sent.' });
    expect(netsuite.findBankDeposit).not.toHaveBeenCalled();
    expect(netsuite.createBankDeposit).not.toHaveBeenCalled();

    // Once it's made, or let go, they're free: what's made isn't waiting any more, and what's let go is.
    state.tables.made_bank_deposits = [another({ status: 'open', sent_at: null })];
    netsuite.findBankDeposit.mockReset().mockResolvedValueOnce(null).mockResolvedValue({ depositId: '8303', number: 'DEP-1208', totalCents: 48050 });
    netsuite.createBankDeposit.mockResolvedValueOnce({ success: true, depositId: '8303' });
    expect(await (await post({ ...BODY, requestId: P(3), lineIds: ['9002'], expectedCents: 48050 })).json())
      .toEqual({ success: true, depositId: '8303', number: 'DEP-1208', totalCents: 48050 });
  });

  it("doesn't count a press of the same form that got to the claim while the company was being read", async () => {
    state.beforeRead.gl_companies = () => {
      state.tables.made_bank_deposits.push(another({
        id: REQUEST, lines: [pressLine(WAITING[0]), pressLine(WAITING[2])], line_ids: ['9001', '9003'], total_cents: 375000, sent_at: NOW, created_at: NOW,
      }));
    };
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "It's being made in NetSuite now. Don't press again: reload in a minute to see it." });
    expect(netsuite.createBankDeposit).not.toHaveBeenCalled();
  });

  it("finishes a bank deposit NetSuite has already under the press's name, without making another", async () => {
    netsuite.findBankDeposit.mockReset().mockResolvedValue(FOUND);
    const res = await post(BODY);
    expect(await res.json()).toEqual({ success: true, already: true, depositId: '8301', number: 'DEP-1207', totalCents: 375000 });
    expect(netsuite.createBankDeposit).not.toHaveBeenCalled();
    expect(press(REQUEST)).toMatchObject({ status: 'made', netsuite_deposit_id: '8301' });
    expect(rpcNames()).toEqual(['made_bank_deposit_claim', 'made_bank_deposit_made', 'gl_own_bank_deposit_save']);
    expect((logAudit as any).mock.calls[0][1].detail).toMatchObject({ found_in_netsuite: true });
  });

  it("lets go and sends nothing when it can't ask NetSuite first, so the same form can be sent again", async () => {
    netsuite.findBankDeposit.mockReset().mockRejectedValueOnce(new Error("FleetSuite can't see NetSuite's bank deposits, so it can't tell whether this one was made"));
    const res = await post(BODY);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Couldn't check NetSuite for this bank deposit (FleetSuite can't see NetSuite's bank deposits, so it can't tell whether this one was made). Nothing was sent. Try again.",
    });
    expect(netsuite.createBankDeposit).not.toHaveBeenCalled();
    expect(press(REQUEST)).toMatchObject({ status: 'open', sent_at: null });

    netsuite.findBankDeposit.mockResolvedValueOnce(null).mockResolvedValue(FOUND);
    expect(await (await post(BODY)).json()).toMatchObject({ success: true, depositId: '8301' });
    expect(netsuite.createBankDeposit).toHaveBeenCalledTimes(1);
  });

  it('lets go when NetSuite refuses it, with why, and takes the same form again', async () => {
    netsuite.createBankDeposit.mockResolvedValueOnce({ success: false, error: 'NetSuite error (400): The period is closed.' });
    const res = await post(BODY);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'NetSuite error (400): The period is closed. No bank deposit was made.' });
    expect(press(REQUEST)).toMatchObject({ status: 'open', error: 'NetSuite error (400): The period is closed.' });
    expect(rpcNames()).toEqual(['made_bank_deposit_claim', 'made_bank_deposit_let_go']);

    netsuite.findBankDeposit.mockResolvedValueOnce(null).mockResolvedValue(FOUND);
    const again = await post({ ...BODY, date: '2026-10-31', accountId: '214' });
    expect(await again.json()).toMatchObject({ success: true, depositId: '8301' });
    expect(netsuite.createBankDeposit.mock.calls[1][0]).toMatchObject({ tranDate: '2026-10-31', accountId: '214' });
    expect(press(REQUEST)).toMatchObject({ status: 'made', deposit_date: '2026-10-31', bank_account_netsuite_id: '214', error: null });
  });

  it('lets go when NetSuite answers with no bank deposit and says nothing more', async () => {
    netsuite.createBankDeposit.mockResolvedValueOnce({ success: true });
    const res = await post(BODY);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "NetSuite didn't make the bank deposit. No bank deposit was made." });
    expect(press(REQUEST)).toMatchObject({ status: 'open', error: "NetSuite didn't make the bank deposit." });
  });

  it("holds a bank deposit NetSuite may have made, and asks NetSuite about it once it's been a while", async () => {
    netsuite.createBankDeposit.mockResolvedValueOnce({ success: false, error: "NetSuite didn't answer (socket hang up).", unsure: true });
    const res = await post(BODY);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "NetSuite didn't answer (socket hang up). FleetSuite can't tell whether NetSuite made it, so it's held. Press Ask NetSuite in a few minutes and FleetSuite will find out.",
      unsure: true,
    });
    expect(press(REQUEST)).toMatchObject({ status: 'sending', error: "NetSuite didn't answer (socket hang up)." });
    expect(rpcNames()).toEqual(['made_bank_deposit_claim']);
    // What's in it stays held for any other press.
    netsuite.findBankDeposit.mockClear();
    expect(await (await post({ ...BODY, requestId: P(2) })).json()).toMatchObject({ problems: ['PYMT-9001 is in a bank deposit being made now.', 'DEP-77 is in a bank deposit being made now.'] });

    // Asked again straight away, or at five minutes: nothing is asked or sent.
    for (const minutes of [0, 5]) {
      vi.clearAllMocks();
      vi.setSystemTime(new Date(Date.parse(NOW) + minutes * 60_000));
      const soon = await post(BODY);
      expect(soon.status).toBe(409);
      expect(await soon.json()).toEqual({
        error: "NetSuite didn't say whether it made this bank deposit (NetSuite didn't answer (socket hang up).). Press Ask NetSuite in a few minutes and FleetSuite will find out.",
        unsure: true,
      });
      expect(netsuite.findBankDeposit).not.toHaveBeenCalled();
      expect(netsuite.getUndepositedFunds).not.toHaveBeenCalled();
    }

    // Six minutes on, someone else asks and NetSuite has it: it's made, and Books' copy says who sent it.
    vi.setSystemTime(new Date(Date.parse(NOW) + 6 * 60_000));
    state.userId = OTHER;
    netsuite.findBankDeposit.mockReset().mockResolvedValue({ depositId: '8305', number: 'DEP-1209', totalCents: 375000 });
    const asked = await post(BODY);
    expect(await asked.json()).toEqual({ success: true, already: true, depositId: '8305', number: 'DEP-1209', totalCents: 375000 });
    expect(netsuite.findBankDeposit).toHaveBeenCalledWith(EXTERNAL);
    expect(netsuite.createBankDeposit).not.toHaveBeenCalled();
    expect(press(REQUEST)).toMatchObject({ status: 'made', netsuite_deposit_id: '8305', error: null });
    const copy = state.rpcs.at(-1);
    expect(copy?.[0]).toBe('gl_own_bank_deposit_save');
    expect(copy?.[1].p).toMatchObject({ netsuite_id: '8305', made_from_id: REQUEST, made_by: STAFF });
    expect((logAudit as any).mock.calls[0][1]).toMatchObject({ actorId: OTHER, detail: { found_in_netsuite: true } });
  });

  it("lets go of a held bank deposit NetSuite doesn't have, and keeps holding it when NetSuite can't say", async () => {
    state.tables.made_bank_deposits = [another({
      id: REQUEST, lines: [pressLine(WAITING[0]), pressLine(WAITING[2])], line_ids: ['9001', '9003'], total_cents: 375000, sent_by: STAFF,
      sent_at: ago(10), error: 'NetSuite error (503): busy',
    })];
    netsuite.findBankDeposit.mockReset().mockRejectedValueOnce(new Error('NetSuite SuiteQL error (503): busy'));
    const cant = await post(BODY);
    expect(cant.status).toBe(502);
    expect(await cant.json()).toEqual({ error: "Couldn't ask NetSuite what became of this bank deposit (NetSuite SuiteQL error (503): busy). Try again.", unsure: true });
    expect(press(REQUEST)).toMatchObject({ status: 'sending' });

    netsuite.findBankDeposit.mockResolvedValueOnce(null);
    const none = await post(BODY);
    expect(none.status).toBe(409);
    expect(await none.json()).toEqual({ error: "NetSuite has no bank deposit from this press, so none was made. Check what's waiting and press Make deposit again." });
    expect(press(REQUEST)).toMatchObject({ status: 'open', error: 'NetSuite has no bank deposit from this press, so none was made.' });
    expect(netsuite.createBankDeposit).not.toHaveBeenCalled();
    expect(netsuite.getUndepositedFunds).not.toHaveBeenCalled();
  });

  it("says it's being made when pressed again while it is", async () => {
    state.tables.made_bank_deposits = [another({ id: REQUEST, sent_at: ago(1) })];
    const res = await post(BODY);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "It's being made in NetSuite now. Don't press again: reload in a minute to see it." });
    expect(netsuite.findBankDeposit).not.toHaveBeenCalled();
    expect(netsuite.getUndepositedFunds).not.toHaveBeenCalled();
  });

  it('says what became of the form when another press of it got to the claim first', async () => {
    const theirs = (over: Record<string, any>) => () => {
      state.tables.made_bank_deposits.push(another({ id: REQUEST, sent_at: NOW, created_at: NOW, ...over }));
    };
    state.beforeClaim = theirs({});
    const making = await post(BODY);
    expect(making.status).toBe(409);
    expect(await making.json()).toEqual({ error: "It's being made in NetSuite now. Don't press again: reload in a minute to see it." });

    state.tables.made_bank_deposits = [];
    state.beforeClaim = theirs({ status: 'made', netsuite_deposit_id: '8300', netsuite_number: 'DEP-1206' });
    expect(await (await post(BODY)).json()).toEqual({ success: true, already: true, depositId: '8300', number: 'DEP-1206', totalCents: 48050 });
    expect(netsuite.findBankDeposit).not.toHaveBeenCalled();
    expect(netsuite.createBankDeposit).not.toHaveBeenCalled();
  });

  it("keeps no copy when NetSuite's total isn't what was sent, and says to look at it", async () => {
    netsuite.findBankDeposit.mockReset().mockResolvedValueOnce(null).mockResolvedValueOnce({ ...FOUND, totalCents: 250000 });
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true, depositId: '8301', number: 'DEP-1207', totalCents: 375000,
      booksWarning: "Books didn't keep its copy (NetSuite's bank deposit comes to $2,500.00, not the $3,750.00 FleetSuite sent: look at it in NetSuite). The bank deposit is in NetSuite.",
    });
    expect(rpcNames()).toEqual(['made_bank_deposit_claim', 'made_bank_deposit_made']);
    expect(press(REQUEST)).toMatchObject({ status: 'made', netsuite_deposit_id: '8301' });
    expect((logAudit as any).mock.calls[0][1].detail).toMatchObject({ total: '$3,750.00', netsuite_total: '$2,500.00' });

    // Found already under the press's name with another total: the same.
    netsuite.findBankDeposit.mockReset().mockResolvedValue({ depositId: '8306', number: 'DEP-1210', totalCents: 0 });
    expect(await (await post({ ...BODY, requestId: P(2) })).json()).toMatchObject({ already: true, booksWarning: expect.stringContaining('comes to $0.00') });
  });

  it("says so when it can't keep Books' copy, and the bank deposit stands", async () => {
    state.ownSave = { data: null, error: { message: "gl: company BMG doesn't exist" } };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true, depositId: '8301', number: 'DEP-1207', totalCents: 375000,
      booksWarning: "Books didn't keep its copy (gl: company BMG doesn't exist). The bank deposit is in NetSuite.",
    });
    expect(press(REQUEST)).toMatchObject({ status: 'made' });

    // A copy that's there already is kept.
    state.ownSave = { data: { saved: false }, error: null };
    netsuite.findBankDeposit.mockReset().mockResolvedValue({ depositId: '8306', number: 'DEP-1210', totalCents: 375000 });
    expect(await (await post({ ...BODY, requestId: P(2) })).json()).toEqual({
      success: true, already: true, depositId: '8306', number: 'DEP-1210', totalCents: 375000,
    });
  });

  it("shows the bank deposit made when NetSuite's number can't be read after, or keeping it on the press fails", async () => {
    netsuite.findBankDeposit.mockReset().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('busy'));
    state.madeError = { message: 'connection reset' };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await (await post(BODY)).json()).toEqual({ success: true, depositId: '8301', number: null, totalCents: 375000 });
    expect(rpcNames()).toEqual(['made_bank_deposit_claim', 'made_bank_deposit_made', 'gl_own_bank_deposit_save']);
    expect(state.rpcs[2][1].p).toMatchObject({ netsuite_id: '8301', netsuite_number: null, amount: '3750.00' });
    expect(log).toHaveBeenCalledWith(`[bank deposits] press ${REQUEST} made as NetSuite deposit 8301 but not kept: connection reset`);
  });
});
