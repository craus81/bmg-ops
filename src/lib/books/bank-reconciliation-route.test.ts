// Books → 1084's bank reconciliation (src/app/api/admin/books/bank-reconciliation):
// where reconciling 1084 Cool Springs' bank account starts, held against its
// books; each month from then through this one, newest first; each month's
// statement ticked and finished by the bookkeeper and super admins, at what
// the books have for each entry; and the last month done undone, for a reason
// (src/lib/books/bank-reconciliation.ts, migration 493). Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const CRAIG = 'a0000000-0000-4000-8000-000000000001';
const BANK = '910';
const TYPED = 'entry:e0000000-0000-4000-8000-000000000007';

type Row = Record<string, any>;

// The route makes its service client per request, from what the mocks hand it.
const h = vi.hoisted(() => {
  const state = {
    roles: ['super_admin'] as string[],
    tables: {} as Record<string, Row[]>,
    docs: [] as Row[],
    /** How many entries the account has: more than docs when they aren't all read. */
    documents: null as number | null,
    opening: [] as Row[],
    rpcs: [] as Array<[string, Record<string, any>]>,
    /** A table or function that fails, as the database would. */
    failing: null as string | null,
    /** What a function answers instead of working it out, as when someone saved first. */
    answers: {} as Record<string, unknown>,
    /** The tables read a page at a time, and how often each is read. */
    ranged: new Set<string>(),
    reads: {} as Record<string, number>,
    clock: 0,
  };
  const rows = (table: string) => (state.tables[table] ??= []);
  /** Each save's time, a second after the last. */
  const stamp = () => new Date(Date.UTC(2026, 10, 15, 15, 0, 0) + 1000 * ++state.clock).toISOString();
  const shift = (month: string, by: number) => {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 10);
  };

  // An in-memory stand-in for the tables the route reads.
  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const sorts: string[] = [];
    let span: [number, number] | null = null;
    const run = () => {
      if (state.failing === table) return { data: null, error: { message: 'boom' } };
      // A read that pages on and on fails, as no page of the real tables comes back the same twice.
      state.reads[table] = (state.reads[table] ?? 0) + 1;
      if (state.reads[table] > 50) return { data: null, error: { message: `${table} read over and over` } };
      const matched = rows(table).filter((r) => filters.every((f) => f(r)));
      const sorted = [...matched].sort((a, b) => {
        for (const c of sorts) {
          const d = String(a[c]).localeCompare(String(b[c]));
          if (d !== 0) return d;
        }
        return 0;
      });
      const page = span ? sorted.slice(span[0], span[1] + 1) : sorted;
      return { data: page.map((r) => structuredClone(r)), error: null };
    };
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
      order: (c: string) => { sorts.push(c); return builder; },
      range: (from: number, to: number) => { span = [from, to]; state.ranged.add(table); return builder; },
      maybeSingle: async () => {
        const { data, error } = run();
        return { data: data?.[0] ?? null, error };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  // Migration 493's functions as they have it, on the in-memory tables.
  const ok = (data: unknown) => ({ data, error: null });
  const mine = (p: Row) => (r: Row) => r.company === p.company && r.account === p.account;
  const doneMonths = (p: Row) => rows('bank_recs').filter((r) => mine(p)(r) && r.status === 'done').map((r) => r.month).sort();
  const rpcs: Record<string, (args: Record<string, any>) => { data: unknown; error: { message: string } | null }> = {
    gl_books_account_documents: () => ok({
      documents: state.documents ?? state.docs.length, differing: 0, netsuite: '0.00', fleetsuite: '0.00', rows: structuredClone(state.docs),
    }),
    gl_netsuite_totals: ({ p_company }) => ok({ opening: p_company === '1084' ? state.opening : [], netsuite: [], copied: [] }),
    bank_rec_start_save: ({ p }) => {
      const row = rows('bank_rec_starts').find(mine(p));
      const kept = {
        first_month: p.first_month, as_of: p.as_of, balance_cents: p.balance_cents, outstanding: [...p.outstanding], updated_by: p.by,
      };
      if (!row) {
        if (p.seen !== null && p.seen !== undefined) return ok({ state: 'changed' });
        const at = stamp();
        rows('bank_rec_starts').push({ company: p.company, account: p.account, ...kept, updated_at: at });
        return ok({ state: 'saved', updated_at: at, let_go: [] });
      }
      if (row.updated_at !== p.seen) return ok({ state: 'changed' });
      if (doneMonths(p).length) return ok({ state: 'done' });
      let letGo: string[] = [];
      if (p.first_month !== row.first_month) {
        letGo = rows('bank_recs').filter(mine(p)).map((r) => r.month).sort();
        state.tables.bank_rec_ticks = rows('bank_rec_ticks').filter((r) => !mine(p)(r));
        state.tables.bank_recs = rows('bank_recs').filter((r) => !mine(p)(r));
      }
      Object.assign(row, kept, { updated_at: stamp() });
      return ok({ state: 'saved', updated_at: row.updated_at, let_go: letGo });
    },
    bank_rec_save: ({ p }) => {
      const start = rows('bank_rec_starts').find(mine(p));
      if (!start) return ok({ state: 'no_start' });
      const done = doneMonths(p);
      const next = done.length ? shift(done[done.length - 1], 1) : start.first_month;
      if (p.month !== next) return ok({ state: 'not_next', next });
      const row = rows('bank_recs').find((r) => mine(p)(r) && r.month === p.month);
      if (row ? row.updated_at !== p.seen : p.seen !== null && p.seen !== undefined) return ok({ state: 'changed' });
      const ticks = p.ticks as Array<{ doc: string; cents: number }>;
      const taken = ticks.map((t) => t.doc).filter((doc) => rows('bank_rec_ticks').some((t) => mine(p)(t) && t.doc === doc && t.month !== p.month));
      if (taken.length) return ok({ state: 'taken', doc: taken.sort()[0] });
      if (p.finish) {
        if (p.ending_cents === null || p.ending_cents === undefined) return ok({ state: 'no_ending' });
        const before = rows('bank_recs').find((r) => mine(p)(r) && r.month === shift(p.month, -1));
        const starting = Number(p.month === start.first_month ? start.balance_cents : before?.ending_cents);
        const cleared = ticks.reduce((sum, t) => sum + t.cents, 0);
        if (p.ending_cents !== starting + cleared) return ok({ state: 'apart', apart_cents: p.ending_cents - (starting + cleared) });
      }
      const at = stamp();
      const kept = {
        ends_on: p.ends_on, ending_cents: p.ending_cents, status: p.finish ? 'done' : 'open', done_by: p.finish ? p.by : null,
        done_at: p.finish ? at : null, updated_by: p.by, updated_at: at,
      };
      if (row) Object.assign(row, kept);
      else rows('bank_recs').push({ company: p.company, account: p.account, month: p.month, ...kept });
      state.tables.bank_rec_ticks = rows('bank_rec_ticks').filter((t) => !(mine(p)(t) && t.month === p.month));
      rows('bank_rec_ticks').push(...ticks.map((t) => ({ company: p.company, account: p.account, doc: t.doc, month: p.month, cents: t.cents })));
      if (p.finish) {
        rows('bank_rec_events').push({
          id: `e${state.clock}`, company: p.company, account: p.account, month: p.month, action: 'done', reason: null, actor_id: p.by, created_at: at,
        });
      }
      return ok({ state: p.finish ? 'done' : 'saved', updated_at: at });
    },
    bank_rec_undo: ({ p }) => {
      const last = rows('bank_recs').filter((r) => mine(p)(r) && r.status === 'done').sort((a, b) => b.month.localeCompare(a.month))[0];
      if (!last || last.month !== p.month) return ok({ state: 'not_last' });
      if (last.updated_at !== p.seen) return ok({ state: 'changed' });
      if (rows('bank_rec_ticks').some((t) => mine(p)(t) && t.month === shift(p.month, 1))) return ok({ state: 'next_ticked' });
      const at = stamp();
      Object.assign(last, { status: 'open', done_by: null, done_at: null, updated_by: p.by, updated_at: at });
      rows('bank_rec_events').push({
        id: `e${state.clock}`, company: p.company, account: p.account, month: p.month, action: 'undone', reason: p.reason.trim(),
        actor_id: p.by, created_at: at,
      });
      return ok({ state: 'undone', updated_at: at });
    },
  };
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.rpcs.push([fn, structuredClone(args)]);
      if (state.failing === fn) return { data: null, error: { message: 'boom' } };
      if (fn in state.answers) return ok(state.answers[fn]);
      return rpcs[fn] ? rpcs[fn](args) : { data: null, error: { message: `nothing answers ${fn}` } };
    },
  };
  return { state, service };
});

vi.mock('@/lib/api-auth', async () => {
  // The real levels (src/lib/books/access.ts) for whoever state.roles says is signed in.
  const { booksAccess, booksAllows } = await import('@/lib/books/access');
  return {
    requireBooks: vi.fn(async (_req: unknown, need: 'read' | 'keep' | 'owner') => {
      const access = booksAccess((r) => h.state.roles.includes(r));
      return booksAllows(access, need)
        ? { user: { id: CRAIG, email: 'craig@example.com' }, profile: { full_name: 'Craig', roles: h.state.roles }, access }
        : { error: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }) };
    }),
  };
});
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

const { state } = h;

import { logAudit } from '@/lib/audit';
import { GET, POST } from '../../app/api/admin/books/bank-reconciliation/route';

/** An entry on 1084's bank account as gl_books_account_documents gives it, money in (a debit) positive, in dollars. */
const doc = (id: string, date: string, type: string | null, number: string | null, dollars: string, over: Row = {}) => ({
  doc: id, netsuite: dollars, fleetsuite: dollars, kind: null, type, number, month: `${date.slice(0, 7)}-01`, date, name: null, memo: null,
  entry_no: null, entries: 1, ...over,
});
const DOCS = [
  doc('4999', '2026-09-01', 'Deposit', 'DEP88', '8500.00', { name: 'BMG Fleet Installations', memo: 'September rent' }),
  doc('5001', '2026-09-28', 'Check', '1001', '-450.00', { name: 'Ozark Lawn Care' }),
  doc('5002', '2026-10-01', 'Deposit', 'DEP89', '8500.00', { name: 'BMG Fleet Installations', memo: 'October rent' }),
  doc('5003', '2026-10-05', 'Journal', 'JE310', '-6415.00', { memo: 'Ozark Federal mortgage payment' }),
  doc('5004', '2026-10-31', 'Check', '1002', '-120.00', { name: 'Ozark Lawn Care' }),
  doc('5005', '2026-11-02', 'Deposit', 'DEP90', '8500.00', { name: 'BMG Fleet Installations', memo: 'November rent' }),
  // Only FleetSuite's journal has this one.
  doc(TYPED, '2026-11-05', null, null, '-6415.00', { netsuite: '0.00', entry_no: 12, memo: 'Ozark Federal mortgage payment' }),
  // NetSuite's copy has this one, and FleetSuite's books haven't posted it yet.
  doc('5100', '2026-11-06', 'Check', '1003', '0.00', { netsuite: '-25.00' }),
  // No day to clear on.
  doc('5200', '2026-11-07', 'Journal', 'JE311', '-10.00', { date: null }),
  // Nothing on the account either side: a journal that moves it in and out the same day.
  doc('5300', '2026-11-08', 'Journal', 'JE312', '0.00'),
];

// As PostgREST can give a bigint, as text.
const START = {
  company: '1084', account: BANK, first_month: '2026-10-01', as_of: '2026-09-30', balance_cents: '1850000', outstanding: ['5001'],
  updated_by: CRAIG, updated_at: '2026-10-02T15:00:00.000Z',
};
// The bank account picked before: what was reconciled on it stays, and isn't this one's.
const BEFORE = { company: '1084', account: '999', month: '2026-10-01' };
// October, done: from $18,500.00, 1001, DEP89 and JE310 cleared, to $20,135.00.
const OCTOBER = {
  company: '1084', account: BANK, month: '2026-10-01', ends_on: '2026-10-31', ending_cents: '2013500', status: 'done',
  done_by: CRAIG, done_at: '2026-11-03T15:00:00.000Z', updated_by: CRAIG, updated_at: '2026-11-03T15:00:00.000Z',
};
const OCTOBER_TICKS = [['5001', '-45000'], ['5002', '850000'], ['5003', '-641500']]
  .map(([d, c]) => ({ company: '1084', account: BANK, doc: d, month: '2026-10-01', cents: c }));
const OCTOBER_DONE = {
  id: 'e0', company: '1084', account: BANK, month: '2026-10-01', action: 'done', reason: null, actor_id: CRAIG, created_at: OCTOBER.done_at,
};

const URL = 'https://go.bmgfleet.com/api/admin/books/bank-reconciliation';
const get = async () => {
  const res = await GET(new NextRequest(URL));
  return { status: res.status, body: await res.json() };
};
const post = async (body: unknown) => {
  const res = await POST(new NextRequest(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const START_BODY = { action: 'start', seen: null, firstMonth: '2026-10', asOf: '2026-09-30', balanceCents: 1850000, outstanding: ['5001'] };
const saveOctober = (over: Record<string, unknown> = {}) => post({
  action: 'save', month: '2026-10', seen: rec('2026-10-01')?.updated_at ?? null, endsOn: '2026-10-31', endingCents: null,
  ticked: ['5001', '5002'], finish: false, ...over,
});
const rec = (month: string) => state.tables.bank_recs.find((r) => r.account === BANK && r.month === month);
const ticks = () => state.tables.bank_rec_ticks.filter((t) => t.account === BANK).map((t) => [t.doc, t.month, Number(t.cents)]);
const mineOnly = (table: string) => state.tables[table].filter((r) => r.account === BANK);
/** Nowhere reconciling this bank account starts yet. */
const noStart = () => { state.tables.bank_rec_starts = state.tables.bank_rec_starts.filter((r) => r.account !== BANK); };
const called = (fn: string) => state.rpcs.filter(([name]) => name === fn).map(([, args]) => args);
const seedOctober = () => {
  state.tables.bank_recs.push({ ...OCTOBER });
  state.tables.bank_rec_ticks.push(...OCTOBER_TICKS.map((t) => ({ ...t })));
  state.tables.bank_rec_events.push({ ...OCTOBER_DONE });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Mid-November in Central time.
  vi.setSystemTime(new Date('2026-11-15T15:00:00Z'));
  vi.mocked(logAudit).mockClear();
  Object.assign(state, {
    roles: ['super_admin'], rpcs: [], failing: null, answers: {}, ranged: new Set(), reads: {}, clock: 0, documents: null,
    docs: DOCS.map((d) => ({ ...d })),
    opening: [
      { company: '1084', netsuite_account_id: BANK, debit: '10250.00', credit: '250.00', line_count: 2 },
      { company: '1084', netsuite_account_id: '920', debit: '0.00', credit: '730000.00', line_count: 1 },
    ],
    tables: {
      gl_companies: [{ code: 'BMG', name: 'BMG Fleet Installations' }, { code: '1084', name: '1084 Cool Springs' }],
      rent_mortgage_setups: [{ company: '1084', bank_account: BANK }],
      gl_accounts: [
        { netsuite_account_id: '920', number: '25000', name: 'Building Mortgage' },
        { netsuite_account_id: BANK, number: '10100', name: 'Ozark Federal Checking' },
      ],
      profiles: [{ id: CRAIG, full_name: 'Craig' }],
      bank_rec_starts: [
        { ...START, outstanding: [...START.outstanding] },
        { ...START, account: '999', first_month: '2026-09-01', as_of: '2026-08-31', outstanding: [] },
      ],
      bank_recs: [{ ...OCTOBER, ...BEFORE, ending_cents: 1 }],
      bank_rec_ticks: [{ ...BEFORE, doc: '5002', cents: 850000 }],
      bank_rec_events: [{ ...OCTOBER_DONE, ...BEFORE, id: 'e9' }],
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reading the reconciliation', () => {
  it("waits for 1084's bank account to be picked on Rent and mortgage's setup", async () => {
    state.tables.rent_mortgage_setups = [];
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      company: { code: '1084', name: '1084 Cool Springs' }, account: null, start: null, startView: null, next: null, months: [], docs: [],
      capped: false, notPosted: 0, thisMonth: '2026-11-01', today: '2026-11-15', firstMonth: '2025-01-01',
    });
    expect(state.rpcs).toEqual([]);
    state.tables.rent_mortgage_setups = [{ company: '1084', bank_account: null }];
    expect((await get()).body.account).toBeNull();
  });

  it('reads the entries on the bank account, as FleetSuite has them, before where it starts is set', async () => {
    noStart();
    const { body } = await get();
    expect(body).toMatchObject({
      account: { id: BANK, name: '10100 Ozark Federal Checking' }, start: null, startView: null, next: null, months: [], openingCents: 1000000,
      notPosted: 1, capped: false,
    });
    // Each with a day and something in FleetSuite's books, by its kind and number.
    expect(body.docs.map((d: Row) => d.doc)).toEqual(['4999', '5001', '5002', '5003', '5004', '5005', TYPED]);
    expect(body.docs[3]).toEqual({
      doc: '5003', date: '2026-10-05', type: 'Journal', number: 'JE310', name: null, memo: 'Ozark Federal mortgage payment', cents: -641500,
    });
    expect(body.docs[6]).toMatchObject({ doc: TYPED, type: 'Entry', number: 'Entry 12', cents: -641500 });
    expect(called('gl_books_account_documents')).toEqual([{
      p_company: '1084', p_account: BANK, p_from: '2025-01-01', p_to: '2026-11-01', p_differs: false, p_limit: 20000,
    }]);
    expect(called('gl_netsuite_totals')).toEqual([{ p_company: '1084' }]);
  });

  it("names an account the books don't have by its id", async () => {
    state.tables.gl_accounts = [];
    expect((await get()).body.account).toEqual({ id: BANK, name: 'Account 910' });
  });

  it('holds where it starts against the books, and gives each month through this one, newest first', async () => {
    seedOctober();
    const { body } = await get();
    expect(body.start).toEqual({
      firstMonth: '2026-10-01', asOf: '2026-09-30', balanceCents: 1850000, outstanding: ['5001'], updatedAt: START.updated_at, updatedBy: 'Craig',
    });
    // $100.00 to start, the September deposit and 1001 by then: $18,050.00, less 1001 not cleared, is the bank's $18,500.00.
    expect(body.startView).toMatchObject({ booksCents: 1805000, outstandingCents: -45000, apartCents: 0, missing: 0 });
    expect(body.next).toBe('2026-11-01');
    expect(body.months.map((m: Row) => [m.month, m.state])).toEqual([['2026-11-01', 'next'], ['2026-10-01', 'done']]);
    const [november, october] = body.months;
    expect(october).toMatchObject({
      startingCents: 1850000, endingCents: 2013500, inCents: 850000, outCents: 686500, clearedCents: 2013500, differenceCents: 0, tieCents: 0,
      changed: [], events: [{ month: '2026-10-01', action: 'done', reason: null, by: 'Craig', at: OCTOBER.done_at }],
    });
    expect(october.items.map((i: Row) => [i.doc, i.cents])).toEqual([['5001', -45000], ['5002', 850000], ['5003', -641500]]);
    expect(november).toMatchObject({ startingCents: 2013500, endingCents: null, differenceCents: null, saved: null });
    expect(november.items.map((i: Row) => [i.doc, i.ticked])).toEqual([['5004', false], ['5005', false], [TYPED, false]]);
    expect(body.recs).toEqual([expect.objectContaining({ month: '2026-10-01', endingCents: 2013500, status: 'done', doneBy: 'Craig' })]);
    expect(body.ticks).toEqual([
      { doc: '5001', month: '2026-10-01', cents: -45000 }, { doc: '5002', month: '2026-10-01', cents: 850000 },
      { doc: '5003', month: '2026-10-01', cents: -641500 },
    ]);
  });

  it('reads every month, tick and event, a page at a time', async () => {
    state.tables.bank_recs.push({ ...OCTOBER, status: 'open', done_by: null, done_at: null });
    state.tables.bank_rec_ticks.push(...Array.from({ length: 1001 }, (_, i) => ({
      company: '1084', account: BANK, doc: String(8000 + i), month: '2026-10-01', cents: 1,
    })));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.ticks).toHaveLength(1001);
    // None of them is in the books, so none can clear on October's statement now.
    expect(body.months[1]).toMatchObject({ month: '2026-10-01', state: 'next', dropped: 1001 });
    expect([...state.ranged].sort()).toEqual(['bank_rec_events', 'bank_rec_ticks', 'bank_recs']);
  });

  it('says nothing is left once each month through this one is done', async () => {
    seedOctober();
    state.tables.bank_recs.push({ ...OCTOBER, month: '2026-11-01', ends_on: '2026-11-30', ending_cents: 2851500 });
    const { body } = await get();
    expect(body.next).toBeNull();
    expect(body.months.map((m: Row) => m.state)).toEqual(['done', 'done']);
  });

  it('says who reconciles: the bookkeeper and super admins, and the CPA reads', async () => {
    expect((await get()).body.can).toEqual({ keep: true });
    state.roles = ['bookkeeper'];
    expect((await get()).body.can).toEqual({ keep: true });
    state.roles = ['cpa'];
    expect((await get()).body.can).toEqual({ keep: false });
    state.roles = ['admin'];
    expect((await get()).status).toBe(403);
  });

  it('says when the account has more entries than are read at once', async () => {
    state.documents = 20001;
    expect((await get()).body.capped).toBe(true);
  });

  it("says plainly what it couldn't read", async () => {
    state.failing = 'gl_books_account_documents';
    expect(await get()).toEqual({ status: 500, body: { error: "Couldn't read the account's entries: boom" } });
    state.failing = 'bank_recs';
    expect(await get()).toEqual({ status: 500, body: { error: "Couldn't read the months: boom" } });
    state.failing = 'rent_mortgage_setups';
    expect(await get()).toEqual({ status: 500, body: { error: "Couldn't read Rent and mortgage's setup: boom" } });
    state.failing = null;
    state.tables.gl_companies = [];
    expect(await get()).toEqual({ status: 500, body: { error: 'Books has no company 1084.' } });
  });
});

describe('where reconciling starts', () => {
  it('saves it, as the books can keep it, with no amount in the record', async () => {
    noStart();
    const { status, body } = await post(START_BODY);
    expect(status).toBe(200);
    expect(body).toEqual({ saved: true, updatedAt: '2026-11-15T15:00:01.000Z', letGo: [] });
    expect(called('bank_rec_start_save')).toEqual([{
      p: {
        company: '1084', account: BANK, seen: null, first_month: '2026-10-01', as_of: '2026-09-30', balance_cents: 1850000, outstanding: ['5001'],
        by: CRAIG,
      },
    }]);
    expect(mineOnly('bank_rec_starts')).toEqual([expect.objectContaining({ first_month: '2026-10-01', balance_cents: 1850000, updated_by: CRAIG })]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: CRAIG, table: 'bank_rec_starts', recordId: '1084 910', action: 'start',
      detail: { first_month: '2026-10-01', as_of: '2026-09-30', outstanding: 1, let_go: [] },
    });
  });

  it("refuses what the books can't keep, saying why", async () => {
    noStart();
    const refused = async (over: Record<string, unknown>) => {
      const { status, body } = await post({ ...START_BODY, ...over });
      expect(status).toBe(400);
      return body.error;
    };
    expect(await refused({ firstMonth: '2026-12', asOf: '2026-11-30' })).toBe('Reconciling starts with a month from January 2025 through November 2026.');
    expect(await refused({ asOf: '2026-10-31' }))
      .toBe("The starting balance is the bank's on the last day of the statement before October 2026's, a day in September 2026.");
    expect(await refused({ outstanding: ['5002'] })).toBe("An entry picked as not cleared by September 30, 2026 isn't in the books by then.");
    expect(await refused({ outstanding: ['5001', '5001'] })).toBe('An entry is picked twice as not cleared.');
    expect(await refused({ firstMonth: '2025-01', asOf: '2024-12-30', outstanding: [] }))
      .toBe("FleetSuite's books start on January 1, 2025, so reconciling January 2025 starts from December 31, 2024.");
    // Not an entry's name, or not to the cent.
    expect((await post({ ...START_BODY, outstanding: ['DEP89'] })).status).toBe(400);
    expect((await post({ ...START_BODY, balanceCents: 18500.5 })).status).toBe(400);
    expect(called('bank_rec_start_save')).toEqual([]);
  });

  it('moves it to another month while none is done, letting go of what was ticked', async () => {
    state.tables.bank_recs.push({ ...OCTOBER, status: 'open', done_by: null, done_at: null });
    state.tables.bank_rec_ticks.push({ ...OCTOBER_TICKS[0] });
    const { status, body } = await post({ ...START_BODY, seen: START.updated_at, firstMonth: '2026-11', asOf: '2026-10-31', outstanding: ['5004'] });
    expect(status).toBe(200);
    expect(body.letGo).toEqual(['2026-10-01']);
    expect(mineOnly('bank_recs')).toEqual([]);
    expect(mineOnly('bank_rec_ticks')).toEqual([]);
    // What was reconciled on the account picked before stays.
    expect(state.tables.bank_recs).toHaveLength(1);
    expect(state.tables.bank_rec_ticks).toHaveLength(1);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      detail: { first_month: '2026-11-01', as_of: '2026-10-31', outstanding: 1, let_go: ['2026-10-01'] },
    }));
  });

  it('refuses a change someone else saved first, and any change once a month is done', async () => {
    expect(await post({ ...START_BODY, seen: '2026-10-01T15:00:00.000Z' })).toEqual({
      status: 409, body: { error: 'Where reconciling starts was changed by someone else since you opened it: look at it again.' },
    });
    seedOctober();
    expect(await post({ ...START_BODY, seen: START.updated_at, balanceCents: 1850100 })).toEqual({
      status: 409,
      body: { error: 'A month is reconciled already, so where reconciling starts stays as it is: undo the months reconciled first.' },
    });
    expect(mineOnly('bank_rec_starts')[0].balance_cents).toBe('1850000');
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("refuses with no bank account, or more entries than it reads, and to the CPA", async () => {
    state.documents = 20001;
    expect(await post(START_BODY)).toEqual({
      status: 409,
      body: { error: "1084's bank account has more than 20,000 entries, more than FleetSuite reads at once, so it isn't reconciled here." },
    });
    state.tables.rent_mortgage_setups = [];
    expect(await post(START_BODY)).toEqual({ status: 409, body: { error: "Pick 1084's bank account on Rent and mortgage's setup first." } });
    state.roles = ['cpa'];
    expect((await post(START_BODY)).status).toBe(403);
    expect(called('bank_rec_start_save')).toEqual([]);
  });
});

describe('a month', () => {
  it('saves what is ticked at what the books have for each entry, never the page', async () => {
    const { status, body } = await saveOctober();
    expect(status).toBe(200);
    expect(body).toEqual({ saved: true, done: false, updatedAt: '2026-11-15T15:00:01.000Z' });
    expect(called('bank_rec_save')[0].p).toEqual({
      company: '1084', account: BANK, month: '2026-10-01', seen: null, ends_on: '2026-10-31', ending_cents: null,
      ticks: [{ doc: '5001', cents: -45000 }, { doc: '5002', cents: 850000 }], finish: false, by: CRAIG,
    });
    expect(rec('2026-10-01')).toMatchObject({ status: 'open', ending_cents: null, done_at: null });
    expect(ticks()).toEqual([['5001', '2026-10-01', -45000], ['5002', '2026-10-01', 850000]]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: CRAIG, table: 'bank_recs', recordId: '1084 910 2026-10', action: 'save',
      detail: { month: '2026-10-01', ends_on: '2026-10-31', ticked: 2 },
    });

    // An entry ticked twice is ticked once.
    expect((await saveOctober({ ticked: ['5001', '5001', '5002'] })).status).toBe(200);
    expect(ticks()).toEqual([['5001', '2026-10-01', -45000], ['5002', '2026-10-01', 850000]]);
    expect(vi.mocked(logAudit).mock.calls[1][1]).toMatchObject({ detail: { ticked: 2 } });

    // Saved again, as the page saw it, with one ticked less.
    expect((await saveOctober({ ticked: ['5002'], endingCents: 2013500 })).status).toBe(200);
    expect(ticks()).toEqual([['5002', '2026-10-01', 850000]]);
    expect(rec('2026-10-01')?.ending_cents).toBe(2013500);
  });

  it('finishes it once what cleared comes to the ending balance, and the next month starts from it', async () => {
    const { status, body } = await saveOctober({ ticked: ['5003', '5001', '5002'], endingCents: 2013500, finish: true });
    expect(status).toBe(200);
    expect(body).toMatchObject({ saved: true, done: true });
    expect(rec('2026-10-01')).toMatchObject({ status: 'done', done_by: CRAIG, ending_cents: 2013500 });
    expect(mineOnly('bank_rec_events')).toEqual([expect.objectContaining({ month: '2026-10-01', action: 'done', actor_id: CRAIG })]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'reconciled', detail: { month: '2026-10-01', ends_on: '2026-10-31', ticked: 3 },
    }));

    const read = (await get()).body;
    expect(read.next).toBe('2026-11-01');
    expect(read.months[0]).toMatchObject({ month: '2026-11-01', state: 'next', startingCents: 2013500 });
    // November's statement: 1002 and the November deposit clear; the typed entry doesn't yet.
    const november = await post({
      action: 'save', month: '2026-11', seen: null, endsOn: '2026-11-30', endingCents: 2851500, ticked: ['5004', '5005'], finish: true,
    });
    expect(november).toMatchObject({ status: 200, body: { done: true } });
    expect(rec('2026-11-01')).toMatchObject({ status: 'done', ends_on: '2026-11-30' });
  });

  it("refuses to finish while what cleared doesn't come to the ending balance", async () => {
    expect(await saveOctober({ ticked: ['5001', '5002', '5003'], endingCents: 2013400, finish: true })).toEqual({
      status: 409,
      body: { error: "The statement's ending balance and what cleared are $1.00 apart, so October 2026 isn't reconciled yet.", differenceCents: -100 },
    });
    expect(await saveOctober({ finish: true })).toEqual({ status: 400, body: { error: "Type the statement's ending balance first." } });
    expect(called('bank_rec_save')).toEqual([]);
    expect(mineOnly('bank_recs')).toEqual([]);
  });

  it('reconciles months in order, through this one', async () => {
    expect(await post({ action: 'save', month: '2026-11', seen: null, endsOn: '2026-11-30', endingCents: null, ticked: [], finish: false }))
      .toEqual({ status: 409, body: { error: 'October 2026 is the month to reconcile now.' } });
    seedOctober();
    expect(await saveOctober({ seen: OCTOBER.updated_at })).toEqual({ status: 409, body: { error: 'November 2026 is the month to reconcile now.' } });
    state.tables.bank_recs = state.tables.bank_recs.filter((r) => r.account !== BANK);
    state.tables.bank_rec_ticks = state.tables.bank_rec_ticks.filter((t) => t.account !== BANK);
    expect(await post({ action: 'save', month: '2026-12', seen: null, endsOn: '2026-12-31', endingCents: null, ticked: [], finish: false }))
      .toEqual({ status: 400, body: { error: "December 2026 hasn't started yet." } });
    seedOctober();
    state.tables.bank_recs.push({ ...OCTOBER, month: '2026-11-01', ends_on: '2026-11-30', ending_cents: 2851500 });
    expect(await post({ action: 'save', month: '2026-11', seen: null, endsOn: '2026-11-30', endingCents: null, ticked: [], finish: false }))
      .toEqual({ status: 409, body: { error: 'Each month is reconciled through November 2026.' } });
    expect(called('bank_rec_save')).toEqual([]);
  });

  it("refuses an entry that can't clear on the statement, and a last day outside the month", async () => {
    // Dated after the statement, cleared before where reconciling starts, and gone from the books.
    for (const [ticked, words] of [[['5005'], 'An entry'], [['4999', '5002'], 'An entry'], [['5001', '6000', '5005'], '2 entries']] as const) {
      const { status, body } = await saveOctober({ ticked });
      expect(status).toBe(409);
      expect(body.error).toBe(`${words} ticked can't clear on October 2026's statement now: gone from the books, dated after it, or cleared `
        + 'on a month before. Look at it again.');
    }
    const outside = "The statement's last day isn't in October 2026.";
    expect(await saveOctober({ endsOn: '2026-11-01' })).toEqual({ status: 400, body: { error: outside, problems: [outside] } });
    expect((await saveOctober({ ticked: ['DEP89'] })).status).toBe(400);
    expect(called('bank_rec_save')).toEqual([]);
  });

  it('passes on what the books answer when someone saved first', async () => {
    expect((await saveOctober()).status).toBe(200);
    expect(await saveOctober({ seen: '2026-11-01T00:00:00.000Z' })).toEqual({
      status: 409, body: { error: 'October 2026 was saved by someone else since you opened it: look at it again.' },
    });
    const answered = async (answer: unknown) => {
      state.answers = { bank_rec_save: answer };
      return saveOctober();
    };
    expect(await answered({ state: 'taken', doc: '5001' }))
      .toEqual({ status: 409, body: { error: 'An entry ticked cleared on a month before already: look at it again.' } });
    expect(await answered({ state: 'not_next', next: '2026-11-01' }))
      .toEqual({ status: 409, body: { error: 'November 2026 is the month to reconcile now: look at it again.' } });
    expect(await answered({ state: 'apart', apart_cents: 100 }))
      .toEqual({ status: 409, body: { error: "October 2026's starting balance changed while it was saved: look at it again." } });
    expect(await answered({ state: 'no_start' }))
      .toEqual({ status: 500, body: { error: 'Couldn\'t save October 2026: the books answered {"state":"no_start"}' } });
    state.answers = {};
    state.failing = 'bank_rec_save';
    expect(await saveOctober()).toEqual({ status: 500, body: { error: "Couldn't save October 2026: boom" } });
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it('needs where reconciling starts first, and is only for those who reconcile', async () => {
    noStart();
    expect(await saveOctober()).toEqual({ status: 409, body: { error: 'Save where reconciling starts first.' } });
    state.roles = ['cpa'];
    expect((await saveOctober()).status).toBe(403);
    expect(called('bank_rec_save')).toEqual([]);
  });
});

describe('undoing a month', () => {
  const undo = (over: Record<string, unknown> = {}) => post({
    action: 'undo', month: '2026-10', seen: rec('2026-10-01')?.updated_at, reason: '  The bank fee was missed  ', ...over,
  });

  it('opens the last month done again, with what was ticked on it, and says why', async () => {
    seedOctober();
    const { status, body } = await undo();
    expect(status).toBe(200);
    expect(body).toEqual({ undone: true, updatedAt: '2026-11-15T15:00:01.000Z' });
    expect(called('bank_rec_undo')).toEqual([{
      p: { company: '1084', account: BANK, month: '2026-10-01', seen: OCTOBER.updated_at, reason: 'The bank fee was missed', by: CRAIG },
    }]);
    expect(rec('2026-10-01')).toMatchObject({ status: 'open', done_by: null, done_at: null });
    expect(ticks()).toHaveLength(3);
    expect(mineOnly('bank_rec_events')[1]).toMatchObject({ action: 'undone', reason: 'The bank fee was missed' });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: CRAIG, table: 'bank_recs', recordId: '1084 910 2026-10', action: 'undo',
      detail: { month: '2026-10-01', reason: 'The bank fee was missed' },
    });
    const reopened = (await get()).body.months[1];
    expect(reopened).toMatchObject({ month: '2026-10-01', state: 'next' });
    expect(reopened.events.map((e: Row) => [e.action, e.reason])).toEqual([['done', null], ['undone', 'The bank fee was missed']]);
  });

  it('needs a reason, 300 characters at most', async () => {
    seedOctober();
    expect(await undo({ reason: '   ' })).toEqual({ status: 400, body: { error: 'Say why the month is undone.' } });
    expect(await undo({ reason: 'x'.repeat(301) })).toEqual({ status: 400, body: { error: 'Say why in 300 characters at most.' } });
    expect((await undo({ reason: 'x'.repeat(300) })).status).toBe(200);
  });

  it("refuses a month that isn't the last done, one the next month's ticks follow, or one changed since", async () => {
    seedOctober();
    state.tables.bank_recs.push({ ...OCTOBER, month: '2026-11-01', ends_on: '2026-11-30', ending_cents: 2851500 });
    expect(await undo()).toEqual({ status: 409, body: { error: "October 2026 isn't the last month reconciled, so it stays as it is." } });

    Object.assign(rec('2026-11-01')!, { status: 'open', done_at: null, done_by: null });
    state.tables.bank_rec_ticks.push({ company: '1084', account: BANK, doc: '5005', month: '2026-11-01', cents: 850000 });
    expect(await undo()).toEqual({
      status: 409, body: { error: 'November 2026 has entries ticked: untick them there first, then undo October 2026.' },
    });
    expect(await undo({ seen: '2026-11-01T00:00:00.000Z' })).toEqual({
      status: 409, body: { error: 'October 2026 was changed by someone else since you opened it: look at it again.' },
    });
    expect(rec('2026-10-01')?.status).toBe('done');
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('needs the bank account, and is only for those who reconcile', async () => {
    seedOctober();
    state.roles = ['cpa'];
    expect((await undo()).status).toBe(403);
    state.roles = ['bookkeeper'];
    state.tables.rent_mortgage_setups = [];
    expect(await undo()).toEqual({ status: 409, body: { error: "Pick 1084's bank account on Rent and mortgage's setup first." } });
    expect(called('bank_rec_undo')).toEqual([]);
  });
});
