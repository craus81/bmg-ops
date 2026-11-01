// Books → Rent and mortgage (src/app/api/admin/books/rent-and-mortgage): 1084
// Cool Springs' months from January 2025 through this month, newest first,
// each checked against BMG's books and the lender's statement; the setup and
// a month's figures typed by the bookkeeper and super admins; and the month's
// two entries made as drafts in the general journal from the figures as
// saved, by someone with Payments while journal entries are on, or a super
// admin until then (src/lib/books/rent-and-mortgage.ts). Made-up data.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const CRAIG = 'a0000000-0000-4000-8000-000000000001';

type Row = Record<string, any>;

// The route makes its service client per request, from what the mocks hand it.
const h = vi.hoisted(() => {
  const state = {
    roles: ['super_admin'] as string[],
    payments: true,
    on: false,
    /** 1084's NetSuite subsidiary in Books. */
    subsidiary: '5' as string | null,
    tables: {} as Record<string, Row[]>,
    rpcs: [] as Array<[string, Record<string, any>]>,
    landlordTotals: [] as Row[],
    tenantTotals: [] as Row[],
    opening: [] as Row[],
    clock: 0,
  };
  const rows = (table: string) => (state.tables[table] ??= []);
  /** Each save's time, a second after the last. */
  const stamp = () => new Date(Date.UTC(2027, 2, 15, 15, 0, 0) + 1000 * ++state.clock).toISOString();

  // An in-memory stand-in for the tables the route reads.
  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const sorts: Array<[string, boolean]> = [];
    const run = () => {
      const matched = rows(table).filter((r) => filters.every((f) => f(r)));
      const sorted = [...matched].sort((a, b) => {
        for (const [c, up] of sorts) {
          const d = String(a[c]).localeCompare(String(b[c]));
          if (d !== 0) return up ? d : -d;
        }
        return 0;
      });
      return { data: sorted.map((r) => structuredClone(r)), error: null };
    };
    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      gte: (c: string, v: string) => { filters.push((r) => String(r[c]) >= v); return builder; },
      lte: (c: string, v: string) => { filters.push((r) => String(r[c]) <= v); return builder; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
      order: (c: string, o?: { ascending?: boolean }) => { sorts.push([c, o?.ascending !== false]); return builder; },
      maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
      upsert: async (row: Row, opts: { onConflict: string }) => {
        const at = rows(table).findIndex((r) => r[opts.onConflict] === row[opts.onConflict]);
        if (at >= 0) rows(table)[at] = structuredClone(row);
        else rows(table).push(structuredClone(row));
        return { data: null, error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
    };
    return builder;
  }

  // Migration 492's functions, and migration 469's save they call, as they have them, on the in-memory tables.
  const ok = (data: unknown) => ({ data, error: null });
  const RENT = ['rent_date', 'rent_cents'];
  const STATEMENT = ['paid_on', 'principal_cents', 'interest_cents', 'escrow_cents', 'balance_after_cents'];
  const months = () => rows('rent_mortgage_months');
  const entries = () => rows('typed_journal_entries');
  const statusOf = (id: string) => entries().find((e) => e.id === id)?.status ?? null;
  const rpcs: Record<string, (args: Record<string, any>) => { data: unknown; error: { message: string } | null }> = {
    gl_books_totals: ({ p_company }) => ok(p_company === '1084' ? state.landlordTotals : p_company === 'BMG' ? state.tenantTotals : []),
    gl_netsuite_totals: ({ p_company }) => ok({ opening: p_company === '1084' ? state.opening : [], netsuite: [], copied: [] }),
    rent_mortgage_month_save: ({ p }) => {
      const figures: Row = {
        rent_date: p.rent?.date ?? null, rent_cents: p.rent?.cents ?? null,
        paid_on: p.statement?.paid_on ?? null, principal_cents: p.statement?.principal_cents ?? null,
        interest_cents: p.statement?.interest_cents ?? null, escrow_cents: p.statement?.escrow_cents ?? null,
        balance_after_cents: p.statement?.balance_after_cents ?? null,
      };
      const row = months().find((r) => r.company === p.company && r.month === p.month);
      if (!row) {
        if (p.seen !== null && p.seen !== undefined) return ok({ state: 'changed' });
        const at = stamp();
        months().push({ company: p.company, month: p.month, ...figures, rent_entry_id: null, mortgage_entry_id: null, updated_by: p.by, updated_at: at });
        return ok({ state: 'saved', updated_at: at });
      }
      if (row.updated_at !== p.seen) return ok({ state: 'changed' });
      const same = (keys: string[]) => keys.every((k) => row[k] === figures[k]);
      if (same(RENT) && same(STATEMENT)) return ok({ state: 'saved', updated_at: row.updated_at, unchanged: true });
      if (row.rent_entry_id && !same(RENT) && statusOf(row.rent_entry_id) !== 'draft') return ok({ state: 'rent_asked', status: statusOf(row.rent_entry_id) });
      if (row.mortgage_entry_id && !same(STATEMENT) && statusOf(row.mortgage_entry_id) !== 'draft') {
        return ok({ state: 'statement_asked', status: statusOf(row.mortgage_entry_id) });
      }
      Object.assign(row, figures, { updated_by: p.by, updated_at: stamp() });
      return ok({ state: 'saved', updated_at: row.updated_at });
    },
    rent_mortgage_entry_save: ({ p }) => {
      const row = months().find((r) => r.company === p.company && r.month === p.month);
      if (!row) return ok({ state: 'gone' });
      if (row.updated_at !== p.seen) return ok({ state: 'changed' });
      const column = p.kind === 'rent' ? 'rent_entry_id' : 'mortgage_entry_id';
      let id = row[column];
      if (!id) {
        id = p.id;
        if (entries().some((e) => e.id === id)) return ok({ state: 'taken' });
      }
      const total = (p.lines as Row[]).reduce((sum, l) => sum + l.debit_cents, 0);
      const entry = entries().find((e) => e.id === id);
      const kept = { tran_date: p.tran_date, memo: p.memo, lines: structuredClone(p.lines), total_cents: total, updated_by: p.by, updated_at: stamp() };
      if (!entry) entries().push({ id, journal: 'general', company: row.company, status: 'draft', netsuite_number: null, error: null, ...kept });
      else if (entry.status !== 'draft') return ok({ state: 'kept', id, status: entry.status });
      else Object.assign(entry, kept);
      row[column] = id;
      return ok({ state: 'saved', id, status: 'draft', updated_at: kept.updated_at });
    },
  };
  const service = {
    from: (table: string) => query(table),
    rpc: async (fn: string, args: Record<string, any>) => {
      state.rpcs.push([fn, structuredClone(args)]);
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
    profileHasFeature: vi.fn(async (_id: string, _profile: unknown, key: string) => key === 'vendor_payments' && h.state.payments),
  };
});
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => h.service }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/books/switches', () => ({
  SWITCH_ON_DATE_TEXT: 'January 1, 2027',
  switchIsOn: vi.fn(async (_service: unknown, piece: string) => piece === 'journal_entries' && h.state.on),
}));
vi.mock('@/lib/books/snap-a-bill', () => {
  // Made-up accounts: 1084's bank, rent income, mortgage, interest and escrow, and BMG's rent and bank. A company with
  // no NetSuite subsidiary can use none of them, as readAccounts has it.
  const ACCOUNTS = [
    { id: '910', number: '10100', name: 'Ozark Federal Checking', type: 'bank', company: '1084' },
    { id: '930', number: '40000', name: 'Rent Income', type: 'income', company: '1084' },
    { id: '920', number: '25000', name: 'Building Mortgage', type: 'long_term_liability', company: '1084' },
    { id: '950', number: '68000', name: 'Mortgage Interest', type: 'expense', company: '1084' },
    { id: '960', number: '13000', name: 'Escrow', type: 'other_current_asset', company: '1084' },
    { id: '640', number: '64000', name: 'Rent', type: 'expense', company: 'BMG' },
    { id: '110', number: '10000', name: 'First Bank Operating', type: 'bank', company: 'BMG' },
  ];
  const companies = () => [
    { id: 'c-bmg', code: 'BMG', name: 'BMG Fleet Installations', subsidiaryId: '2', locations: [] },
    { id: 'c-1084', code: '1084', name: '1084 Cool Springs', subsidiaryId: h.state.subsidiary, locations: [] },
  ];
  return {
    readCompanies: vi.fn(async () => companies()),
    readAccounts: vi.fn(async (_service: unknown, list: Array<{ code: string; subsidiaryId: string | null }>) => new Map(ACCOUNTS.map((a) => [a.id, {
      id: a.id, number: a.number, name: a.name, type: a.type,
      companies: list.some((c) => c.code === a.company && c.subsidiaryId) ? [a.company] : [],
    }]))),
  };
});

const { state } = h;

import { logAudit } from '@/lib/audit';
import { readAccounts } from '@/lib/books/snap-a-bill';
import { JOURNAL_LINE_ACCOUNT_TYPES } from '@/lib/typed-journal-entries';
import { GET, POST } from '../../app/api/admin/books/rent-and-mortgage/route';

const SETUP = {
  company: '1084', bank_account: '910', rent_income_account: '930', tenant_rent_account: '640', mortgage_account: '920',
  interest_account: '950', escrow_account: '960', lender: 'Ozark Federal', updated_by: CRAIG, updated_at: '2027-03-01T12:00:00.000Z',
};
const ACCOUNTS = {
  bankAccount: '910', rentIncomeAccount: '930', tenantRentAccount: '640', mortgageAccount: '920', interestAccount: '950', escrowAccount: '960',
};
const RENT = { date: '2027-03-01', cents: 850000 };
const STATEMENT = { paidOn: '2027-03-05', principalCents: 312040, interestCents: 287960, escrowCents: 41500, balanceAfterCents: 72066160 };
const FEBRUARY = {
  company: '1084', month: '2027-02-01', rent_date: '2027-02-01', rent_cents: 850000, paid_on: '2027-02-05', principal_cents: 310800,
  interest_cents: 289160, escrow_cents: 41500, balance_after_cents: 72689200, rent_entry_id: null, mortgage_entry_id: null,
  updated_by: CRAIG, updated_at: '2027-02-06T15:00:00.000Z',
};

const amount = (account: string, month: string, debit: string, credit = '0.00') => ({ account, month, debit, credit });

const get = async () => {
  const res = await GET(new NextRequest('https://go.bmgfleet.com/api/admin/books/rent-and-mortgage'));
  return { status: res.status, body: await res.json() };
};
const post = async (body: unknown) => {
  const res = await POST(new NextRequest('https://go.bmgfleet.com/api/admin/books/rent-and-mortgage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
};
const march = () => state.tables.rent_mortgage_months.find((r) => r.month === '2027-03-01');
const saveMarch = async (over: Record<string, unknown> = {}) => post({
  action: 'save', month: '2027-03', seen: march()?.updated_at ?? null, rent: RENT, statement: STATEMENT, ...over,
});
const makeMarch = async () => post({ action: 'make', month: '2027-03', seen: march()?.updated_at });
const entry = (id: string) => state.tables.typed_journal_entries.find((e) => e.id === id)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Mid-March in Central time.
  vi.setSystemTime(new Date('2027-03-15T15:00:00Z'));
  vi.mocked(logAudit).mockClear();
  vi.mocked(readAccounts).mockClear();
  Object.assign(state, {
    roles: ['super_admin'], payments: true, on: false, subsidiary: '5', rpcs: [], clock: 0,
    tables: {
      rent_mortgage_setups: [{ ...SETUP }],
      rent_mortgage_months: [{ ...FEBRUARY }],
      typed_journal_entries: [],
      profiles: [{ id: CRAIG, full_name: 'Craig' }],
    },
    // February booked in both companies' books; March's rent in BMG's only so far.
    landlordTotals: [
      amount('910', '2027-02-01', '8500.00'), amount('930', '2027-02-01', '0.00', '8500.00'),
      amount('920', '2027-02-01', '3108.00'), amount('950', '2027-02-01', '2891.60'), amount('960', '2027-02-01', '415.00'),
      amount('910', '2027-02-01', '0.00', '6414.60'),
    ],
    tenantTotals: [amount('640', '2027-02-01', '8500.00'), amount('640', '2027-03-01', '8500.00'), amount('110', '2027-03-01', '0.00', '8500.00')],
    opening: [{ company: '1084', netsuite_account_id: '920', debit: '0.00', credit: '730000.00', line_count: 1 }],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reading the months', () => {
  it('lists every month from January 2025 through this month, newest first, each checked', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.months).toHaveLength(27);
    expect(body.months[0].month).toBe('2027-03-01');
    expect(body.months[26].month).toBe('2025-01-01');
    expect(body).toMatchObject({ thisMonth: '2027-03-01', today: '2027-03-15', firstMonth: '2025-01-01' });
    const [mar, feb, jan] = body.months;
    expect(feb).toMatchObject({
      rent: { date: '2027-02-01', cents: 850000 },
      statement: { paidOn: '2027-02-05', principalCents: 310800, interestCents: 289160, escrowCents: 41500, balanceAfterCents: 72689200 },
      rentCheck: { state: 'matches', tenantCents: 850000, landlordCents: 850000 },
      mortgageCheck: { state: 'matches' },
      updatedBy: 'Craig',
      book: { principalCents: 310800, interestCents: 289160, balanceCents: 72689200 },
    });
    // BMG's books have March's rent and 1084's don't yet, while it's still March.
    expect(mar).toMatchObject({ rent: null, statement: null, rentCheck: { state: 'waiting' }, mortgageCheck: { state: 'no_statement' }, rentDefaultCents: 850000 });
    expect(jan).toMatchObject({ rentCheck: { state: 'none' }, book: { balanceCents: 73000000 } });
    expect(readAccounts).toHaveBeenCalledWith(expect.anything(), expect.anything(), JOURNAL_LINE_ACCOUNT_TYPES);
  });

  it("gives the setup with its accounts' names, and the accounts each part of it can pick", async () => {
    const { body } = await get();
    expect(body.setup).toEqual({ ...ACCOUNTS, lender: 'Ozark Federal' });
    expect(body).toMatchObject({
      landlord: { code: '1084', name: '1084 Cool Springs', subsidiaryId: '5' },
      tenant: { code: 'BMG', name: 'BMG Fleet Installations' },
      setupUpdatedAt: SETUP.updated_at, setupUpdatedBy: 'Craig', setupProblems: [],
    });
    expect(body.setupNames).toMatchObject({ bankAccount: '10100 Ozark Federal Checking', tenantRentAccount: '64000 Rent' });
    const choices = Object.fromEntries(body.choices.map((c: Row) => [c.role, c.accounts.map((a: Row) => a.id)]));
    // 1084's bank only, never BMG's; BMG's rent from BMG's books only.
    expect(choices).toEqual({
      bankAccount: ['910'], rentIncomeAccount: ['930'], tenantRentAccount: ['640'], mortgageAccount: ['920'], interestAccount: ['950'],
      escrowAccount: ['960', '950'],
    });
    expect(body.choices.find((c: Row) => c.role === 'escrowAccount')).toMatchObject({ optional: true, label: 'Escrow', company: '1084' });
  });

  it('says what the setup kept no longer fits, and starts empty with none', async () => {
    state.tables.rent_mortgage_setups[0].bank_account = '110';
    expect((await get()).body.setupProblems).toEqual(["1084's bank account isn't an account that can be picked for it."]);
    state.tables.rent_mortgage_setups[0].bank_account = '999';
    expect((await get()).body).toMatchObject({
      setupProblems: ["1084's bank account isn't an account that can be picked for it."], setupNames: { bankAccount: 'Account 999' },
    });
    state.tables.rent_mortgage_setups = [];
    const { body } = await get();
    expect(body.setup.bankAccount).toBeNull();
    expect(body.setupUpdatedAt).toBeNull();
    expect(body.months[1].rentCheck.state).toBe('not_set_up');
  });

  it('says who can type the figures and make the entries', async () => {
    // A super admin makes them while journal entries are off, to see what they'd make.
    expect((await get()).body).toMatchObject({ can: { keep: true, make: true }, makeRefused: null, switchedOn: false });
    expect((await get()).body.offText).toMatch(/^Journal entries are switched off until January 1, 2027\./);

    state.roles = ['bookkeeper'];
    expect((await get()).body).toMatchObject({ can: { keep: true, make: false } });
    expect((await get()).body.makeRefused).toMatch(/only a super admin makes the month's entries/);
    state.payments = false;
    expect((await get()).body.makeRefused).toBe("Making the month's entries needs the Payments permission, as the general journal does.");
    state.payments = true;
    state.on = true;
    expect((await get()).body).toMatchObject({ can: { keep: true, make: true }, makeRefused: null, offText: null });

    // The CPA reads.
    state.roles = ['cpa'];
    expect((await get()).body).toMatchObject({ can: { keep: false, make: false }, makeRefused: null });
    state.roles = ['admin'];
    expect((await get()).status).toBe(403);
  });
});

describe('the setup', () => {
  it('keeps each account and the lender, trimmed', async () => {
    state.tables.rent_mortgage_setups = [];
    const { status } = await post({ action: 'setup', seen: null, accounts: { ...ACCOUNTS, escrowAccount: null }, lender: '  Ozark Federal Bank ' });
    expect(status).toBe(200);
    expect(state.tables.rent_mortgage_setups).toEqual([expect.objectContaining({
      company: '1084', bank_account: '910', rent_income_account: '930', tenant_rent_account: '640', mortgage_account: '920',
      interest_account: '950', escrow_account: null, lender: 'Ozark Federal Bank', updated_by: CRAIG,
    })]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      table: 'rent_mortgage_setups', recordId: '1084', action: 'setup',
      detail: {
        accounts: {
          bank_account: '910', rent_income_account: '930', tenant_rent_account: '640', mortgage_account: '920', interest_account: '950', escrow_account: null,
        },
        lender: 'Ozark Federal Bank',
      },
    }));
    // An empty name is none.
    const seen = state.tables.rent_mortgage_setups[0].updated_at;
    expect((await post({ action: 'setup', seen, accounts: ACCOUNTS, lender: '  ' })).status).toBe(200);
    expect(state.tables.rent_mortgage_setups[0].lender).toBeNull();
  });

  it("refuses an account its company can't use or of another kind, one picked twice, and a setup changed since", async () => {
    const tried = async (accounts: Record<string, unknown>, seen: string | null = SETUP.updated_at) =>
      post({ action: 'setup', seen, accounts: { ...ACCOUNTS, ...accounts }, lender: 'Ozark Federal' });
    expect(await tried({ bankAccount: '110' })).toEqual({ status: 400, body: expect.objectContaining({ error: "1084's bank account isn't an account that can be picked for it." }) });
    expect((await tried({ interestAccount: '930' })).body.error).toBe("The mortgage's interest isn't an account that can be picked for it.");
    expect((await tried({ escrowAccount: '950' })).body.error).toBe("The mortgage's interest and escrow are the same account: pick each once.");
    expect((await tried({ bankAccount: '999' })).body.error).toBe("1084's bank account isn't an account that can be picked for it.");
    expect(await tried({}, null)).toEqual({ status: 409, body: { error: 'The setup was changed by someone else since you opened it: look at it again.' } });
    expect(await post({ action: 'setup', seen: SETUP.updated_at, accounts: ACCOUNTS, lender: ` ${'x'.repeat(100)} ` })).toMatchObject({ status: 200 });
    state.tables.rent_mortgage_setups = [{ ...SETUP }];
    expect(await post({ action: 'setup', seen: SETUP.updated_at, accounts: ACCOUNTS, lender: 'x'.repeat(101) }))
      .toEqual({ status: 400, body: { error: "The lender's name takes 100 characters at most.", problems: ["The lender's name takes 100 characters at most."] } });
    expect(state.tables.rent_mortgage_setups).toEqual([SETUP]);
  });

  it("is the bookkeeper's and super admins', not the CPA's", async () => {
    state.roles = ['cpa'];
    expect((await post({ action: 'setup', seen: SETUP.updated_at, accounts: ACCOUNTS, lender: null })).status).toBe(403);
    state.roles = ['bookkeeper'];
    expect((await post({ action: 'setup', seen: SETUP.updated_at, accounts: ACCOUNTS, lender: null })).status).toBe(200);
  });
});

describe("a month's figures", () => {
  it("saves them as typed, for a month that's shown, and says when someone saved it since", async () => {
    const saved = await saveMarch();
    expect(saved).toEqual({ status: 200, body: { saved: true, updatedAt: march()!.updated_at, unchanged: false } });
    expect(march()).toMatchObject({
      rent_date: '2027-03-01', rent_cents: 850000, paid_on: '2027-03-05', principal_cents: 312040, interest_cents: 287960, escrow_cents: 41500,
      balance_after_cents: 72066160, updated_by: CRAIG,
    });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: CRAIG, table: 'rent_mortgage_months', recordId: '1084 2027-03', action: 'save',
      detail: { month: '2027-03-01', rent: true, statement: true },
    });
    // Saved again as the page saw it before.
    expect(await saveMarch({ seen: null })).toEqual({ status: 409, body: { error: 'March 2027 was saved by someone else since you opened it: look at it again.' } });
    // The same figures again change nothing, and aren't audited.
    vi.mocked(logAudit).mockClear();
    expect((await saveMarch()).body).toMatchObject({ saved: true, unchanged: true });
    expect(logAudit).not.toHaveBeenCalled();
    // A statement taken off.
    expect((await saveMarch({ statement: null })).status).toBe(200);
    expect(march()).toMatchObject({ rent_cents: 850000, paid_on: null, principal_cents: null });
  });

  it("refuses a month that isn't shown, and figures dated outside the month or not to the cent", async () => {
    expect(await saveMarch({ month: '2027-04', seen: null })).toEqual({
      status: 400, body: { error: "April 2027 isn't one of the months here: they run from January 2025 through March 2027." },
    });
    expect((await saveMarch({ month: '2024-12', seen: null })).body)
      .toEqual({ error: "December 2024 isn't one of the months here: they run from January 2025 through March 2027." });
    expect((await saveMarch({ rent: { date: '2027-02-28', cents: 850000 } })).body).toEqual({
      error: "The rent's day isn't in March 2027.", problems: ["The rent's day isn't in March 2027."],
    });
    expect((await saveMarch({ statement: { ...STATEMENT, paidOn: '2027-03-32' } })).body.error).toBe("The day the payment was made isn't in March 2027.");
    expect((await saveMarch({ statement: { ...STATEMENT, principalCents: 0, interestCents: 0, escrowCents: 0 } })).body.error)
      .toBe('The statement needs a payment above $0: its principal, interest and escrow are all $0.');
    expect((await saveMarch({ rent: { date: '2027-03-01', cents: 8500.5 } })).status).toBe(400);
    expect(march()).toBeUndefined();
  });

  it("keeps the rent or the statement as it is while its entry is asked for approval", async () => {
    await saveMarch();
    await makeMarch();
    entry(march()!.rent_entry_id).status = 'waiting';
    expect(await saveMarch({ rent: { ...RENT, cents: 860000 } })).toEqual({
      status: 409,
      body: { error: "The rent's entry is asked for approval, so the rent stays as it is: take the entry back on Journal entries to change it." },
    });
    entry(march()!.mortgage_entry_id).status = 'made';
    expect((await saveMarch({ statement: { ...STATEMENT, interestCents: 287961 } })).body.error)
      .toBe("The mortgage payment's entry is in NetSuite already, so the statement stays as it is.");
    expect(march()).toMatchObject({ rent_cents: 850000, interest_cents: 287960 });
  });

  it("is the bookkeeper's and super admins', not the CPA's", async () => {
    state.roles = ['cpa'];
    expect((await saveMarch()).status).toBe(403);
    expect(march()).toBeUndefined();
  });
});

describe("the month's entries", () => {
  it('makes the rent received and the mortgage payment as drafts in the general journal, each on its own day', async () => {
    await saveMarch();
    const { status, body } = await makeMarch();
    expect(status).toBe(200);
    expect(body.made.map((m: Row) => [m.kind, m.status])).toEqual([['rent', 'draft'], ['mortgage', 'draft']]);
    expect(body.kept).toEqual([]);
    const { rent_entry_id: rentId, mortgage_entry_id: mortgageId } = march()!;
    expect(body.made.map((m: Row) => m.id)).toEqual([rentId, mortgageId]);
    expect(entry(rentId)).toMatchObject({
      journal: 'general', company: '1084', status: 'draft', tran_date: '2027-03-01', memo: 'Rent from BMG Fleet Installations for March 2027',
      total_cents: 850000,
      lines: [
        { account_netsuite_id: '910', debit_cents: 850000, credit_cents: 0, memo: null },
        { account_netsuite_id: '930', debit_cents: 0, credit_cents: 850000, memo: null },
      ],
    });
    expect(entry(mortgageId)).toMatchObject({
      journal: 'general', company: '1084', tran_date: '2027-03-05', memo: 'Mortgage payment to Ozark Federal for March 2027', total_cents: 641500,
      lines: [
        { account_netsuite_id: '920', debit_cents: 312040, credit_cents: 0, memo: 'Principal' },
        { account_netsuite_id: '950', debit_cents: 287960, credit_cents: 0, memo: 'Interest' },
        { account_netsuite_id: '960', debit_cents: 41500, credit_cents: 0, memo: 'Escrow' },
        { account_netsuite_id: '910', debit_cents: 0, credit_cents: 641500, memo: null },
      ],
    });
    // Each made from the month as saved: the seen it was worked out from is the month's own.
    const saves = state.rpcs.filter(([fn]) => fn === 'rent_mortgage_entry_save').map(([, a]) => a.p);
    expect(saves.map((p) => [p.kind, p.seen, p.company, p.month])).toEqual([
      ['rent', march()!.updated_at, '1084', '2027-03-01'], ['mortgage', march()!.updated_at, '1084', '2027-03-01'],
    ]);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
      actorId: CRAIG, table: 'rent_mortgage_months', recordId: '1084 2027-03', action: 'make_entries',
      detail: { month: '2027-03-01', made: [{ kind: 'rent', id: rentId }, { kind: 'mortgage', id: mortgageId }], kept: [] },
    });

    // The page shows them, each up to date.
    const view = (await get()).body.months[0];
    expect(view.entries).toMatchObject({
      rent: { id: rentId, status: 'draft', date: '2027-03-01', totalCents: 850000, stale: false, takenOff: false },
      mortgage: { id: mortgageId, status: 'draft', date: '2027-03-05', totalCents: 641500, stale: false, takenOff: false },
    });
  });

  it('brings a draft up to date once the figures or the setup change, keeping its id', async () => {
    await saveMarch();
    await makeMarch();
    const { rent_entry_id: rentId, mortgage_entry_id: mortgageId } = march()!;
    await saveMarch({ statement: { ...STATEMENT, interestCents: 287961 } });
    expect((await get()).body.months[0].entries).toMatchObject({ rent: { stale: false }, mortgage: { stale: true } });
    state.tables.rent_mortgage_setups[0].lender = 'Ozark Federal Bank';
    expect((await get()).body.months[0].entries).toMatchObject({ rent: { stale: false }, mortgage: { stale: true } });

    const { body } = await makeMarch();
    expect(body.made.map((m: Row) => m.id)).toEqual([rentId, mortgageId]);
    expect(entry(mortgageId)).toMatchObject({ memo: 'Mortgage payment to Ozark Federal Bank for March 2027', total_cents: 641501 });
    expect(state.tables.typed_journal_entries).toHaveLength(2);
    expect((await get()).body.months[0].entries).toMatchObject({ rent: { stale: false }, mortgage: { stale: false } });
  });

  it('leaves an entry asked for approval or made as it is, and makes the other', async () => {
    await saveMarch();
    await makeMarch();
    const { rent_entry_id: rentId } = march()!;
    entry(rentId).status = 'waiting';
    state.rpcs = [];
    const { status, body } = await makeMarch();
    expect(status).toBe(200);
    expect(body.made.map((m: Row) => m.kind)).toEqual(['mortgage']);
    expect(state.rpcs.filter(([fn]) => fn === 'rent_mortgage_entry_save').map(([, a]) => a.p.kind)).toEqual(['mortgage']);

    entry(march()!.mortgage_entry_id).status = 'made';
    expect(await makeMarch()).toEqual({
      status: 409, body: { error: "March 2027's entries are each asked for approval or made already, so they stay as they are." },
    });

    // Only the statement typed, and its entry made: there's no rent to make one for.
    state.tables.rent_mortgage_months = [{ ...FEBRUARY }];
    state.tables.typed_journal_entries = [];
    await saveMarch({ rent: null });
    await makeMarch();
    entry(march()!.mortgage_entry_id).status = 'made';
    expect(await makeMarch()).toEqual({
      status: 409, body: { error: "March 2027's entries are each asked for approval or made already, so they stay as they are." },
    });
  });

  it("makes only the kind that's typed, and a new draft once the last was deleted", async () => {
    await saveMarch({ statement: null });
    expect((await makeMarch()).body.made.map((m: Row) => m.kind)).toEqual(['rent']);
    expect(march()!.mortgage_entry_id).toBeNull();
    // Deleting the draft on Journal entries lets go of it (ON DELETE SET NULL).
    const first = march()!.rent_entry_id;
    state.tables.typed_journal_entries = [];
    march()!.rent_entry_id = null;
    const again = await makeMarch();
    expect(again.body.made).toHaveLength(1);
    expect(march()!.rent_entry_id).not.toBe(first);
  });

  it("refuses a month not saved, one saved since, or one with nothing typed", async () => {
    expect(await post({ action: 'make', month: '2027-03', seen: '2027-03-01T00:00:00.000Z' }))
      .toEqual({ status: 409, body: { error: "Save March 2027's figures first." } });
    await saveMarch();
    expect(await post({ action: 'make', month: '2027-03', seen: '2027-03-01T00:00:00.000Z' })).toEqual({
      status: 409, body: { error: 'March 2027 was saved by someone else since you opened it: look at it again, then make the entries.' },
    });
    await saveMarch({ rent: null, statement: null });
    expect((await makeMarch()).body.error).toBe("Type the rent received or the lender's statement first.");
    expect(state.tables.typed_journal_entries).toEqual([]);
  });

  it("says what's missing from the setup, and refuses entries NetSuite couldn't take", async () => {
    await saveMarch();
    state.tables.rent_mortgage_setups = [{ ...SETUP, escrow_account: null }];
    expect((await makeMarch()).body).toEqual({
      error: 'The statement has escrow: pick the escrow account in the setup to book it.',
      problems: ['The statement has escrow: pick the escrow account in the setup to book it.'],
    });
    state.tables.rent_mortgage_setups = [];
    expect((await makeMarch()).body.problems).toEqual([
      "Pick 1084's bank account and rent income in the setup to book the rent.",
      "Pick 1084's bank account, mortgage and the mortgage's interest in the setup to book the payment.",
      'The statement has escrow: pick the escrow account in the setup to book it.',
    ]);
    state.tables.rent_mortgage_setups = [{ ...SETUP }];
    state.subsidiary = null;
    const { status, body } = await makeMarch();
    expect(status).toBe(400);
    expect(body.problems).toContain("The rent's entry: 1084 Cool Springs has no NetSuite subsidiary in Books, so NetSuite can't take its journal entries.");
    expect(body.problems).toContain(
      "The mortgage payment's entry: 1084 Cool Springs has no NetSuite subsidiary in Books, so NetSuite can't take its journal entries.",
    );
    expect(state.tables.typed_journal_entries).toEqual([]);
    expect(state.rpcs.some(([fn]) => fn === 'rent_mortgage_entry_save')).toBe(false);
  });

  it('needs Payments, and journal entries on or a super admin', async () => {
    await saveMarch();
    state.roles = ['bookkeeper'];
    expect(await makeMarch()).toEqual({
      status: 403,
      body: {
        error: "Journal entries are switched off until January 1, 2027. Until then only a super admin makes the month's entries, to see what they'd make.",
        switchedOff: true,
      },
    });
    state.on = true;
    state.payments = false;
    expect((await makeMarch()).body.error).toBe("Making the month's entries needs the Payments permission, as the general journal does.");
    state.roles = ['cpa'];
    state.payments = true;
    expect((await makeMarch()).status).toBe(403);
    expect(state.tables.typed_journal_entries).toEqual([]);
    state.roles = ['bookkeeper'];
    expect((await makeMarch()).status).toBe(200);
  });

  it('leaves an entry asked for approval while the entries are made as it is', async () => {
    await saveMarch();
    await makeMarch();
    const { rent_entry_id: rentId, mortgage_entry_id: mortgageId } = march()!;
    // Someone asks for approval of the rent's draft between the page's read and its save.
    const real = h.service.rpc;
    h.service.rpc = async (fn: string, args: Record<string, any>) => {
      if (fn === 'rent_mortgage_entry_save' && args.p.kind === 'rent') entry(rentId).status = 'waiting';
      return real(fn, args);
    };
    try {
      expect(await makeMarch()).toEqual({
        status: 200,
        body: { made: [{ kind: 'mortgage', id: mortgageId, status: 'draft' }], kept: [{ kind: 'rent', id: rentId, status: 'waiting' }] },
      });
      expect(logAudit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
        table: 'rent_mortgage_months', recordId: '1084 2027-03', action: 'make_entries',
        detail: { month: '2027-03-01', made: [{ kind: 'mortgage', id: mortgageId }], kept: [{ kind: 'rent', id: rentId, status: 'waiting' }] },
      }));
    } finally {
      h.service.rpc = real;
    }
  });

  it('says so when the month is saved again while its entries are made', async () => {
    await saveMarch();
    // Someone saves the month between the rent's entry and the payment's.
    const real = h.service.rpc;
    h.service.rpc = async (fn: string, args: Record<string, any>) => {
      const answer = await real(fn, args);
      if (fn === 'rent_mortgage_entry_save' && args.p.kind === 'rent') march()!.updated_at = '2027-03-15T16:00:00.000Z';
      return answer;
    };
    try {
      const { status, body } = await makeMarch();
      expect(status).toBe(409);
      expect(body).toEqual({
        error: 'March 2027 was saved again while its entries were being made: look at it again, then make them.',
        made: [{ kind: 'rent', id: march()!.rent_entry_id, status: 'draft' }],
      });

      // Or the month is gone by the payment's.
      state.tables.rent_mortgage_months = [{ ...FEBRUARY }];
      state.tables.typed_journal_entries = [];
      await saveMarch();
      h.service.rpc = async (fn: string, args: Record<string, any>) => {
        const answer = await real(fn, args);
        if (fn === 'rent_mortgage_entry_save' && args.p.kind === 'rent') state.tables.rent_mortgage_months = [{ ...FEBRUARY }];
        return answer;
      };
      expect(await makeMarch()).toEqual({
        status: 409,
        body: {
          error: 'March 2027 was saved again while its entries were being made: look at it again, then make them.',
          made: [{ kind: 'rent', id: state.tables.typed_journal_entries[0].id, status: 'draft' }],
        },
      });
    } finally {
      h.service.rpc = real;
    }
  });

  it('keeps every amount out of the audit', async () => {
    await post({ action: 'setup', seen: SETUP.updated_at, accounts: ACCOUNTS, lender: 'Ozark Federal' });
    await saveMarch();
    await makeMarch();
    // The entries' ids are random, and could hold any figure by chance.
    const audits = JSON.stringify(vi.mocked(logAudit).mock.calls.map(([, a]) => a)).replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, '');
    for (const figure of ['850000', '8500', '641500', '312040', '287960', '41500', '72066160']) expect(audits).not.toContain(figure);
  });
});
