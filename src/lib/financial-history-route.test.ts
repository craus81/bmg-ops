// Financial History's routes (src/app/api/reports/financial-history and its
// year cross-check) with "Financials on FleetSuite's books" off and on
// (migration 504): off, NetSuite gives the months from the cutover as
// before; on, BMG's books in FleetSuite do, here a made-up chart and
// journal, without touching NetSuite.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/api-auth', () => ({
  requireFinancials: vi.fn(async () => ({ user: { id: 'u1' }, profile: { role: 'super_admin', roles: ['super_admin'] } })),
}));
vi.mock('@/lib/supabase-service', () => ({ createServiceClient: () => service }));
const netsuite = vi.hoisted(() => ({ getIncomeStatementFromRestlet: vi.fn() }));
vi.mock('@/lib/netsuite', () => ({
  ...netsuite, transactionUrl: vi.fn(() => ''), isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn(),
}));

import { GET as historyRoute } from '../app/api/reports/financial-history/route';
import { GET as yearRoute } from '../app/api/reports/financial-history/year/route';

type Row = Record<string, unknown>;

const account = (id: string, ns: string | null, number: string | null, name: string, type: string, company: string | null = null) => ({
  id, netsuite_account_id: ns, number, name, account_type: type, parent_id: null, company_id: company,
  statement: ['bank'].includes(type) ? 'balance_sheet' : 'income_statement',
});
const snapshot = (source: string, kind: 'month' | 'year', start: string, summary: Row, fetched = '2026-01-01T00:00:00Z') => ({
  id: `${source}-${kind}-${start}`, source, report_type: 'ProfitAndLoss', basis: 'accrual', period_kind: kind, status: 'stored',
  period_start: start, summary, payload: null, fetched_at: fetched,
});
const entry = (acct: string, month: string, debit: number, credit: number) => ({ account: acct, month, debit: debit.toFixed(2), credit: credit.toFixed(2) });

/** NetSuite's January 2025 income statement, copied while the switch was off. */
const NS_JANUARY = {
  income: 4321, cogs: 0, expense: 0, payroll: 0, otherIncome: 0, otherExpense: 0,
  grossMargin: 4321, grossMarginPct: 100, netProfit: 4321, netProfitPct: 100, laborPct: 0, accountCount: 1,
};

const TABLES: Record<string, Row[]> = {
  gl_companies: [
    { id: 'co-1084', code: '1084', name: '1084 Cool Springs', legal_name: null, netsuite_subsidiary_id: '2' },
    { id: 'co-bmg', code: 'BMG', name: 'Example Fleet', legal_name: 'Example Fleet Upfitters LLC', netsuite_subsidiary_id: '1' },
  ],
  gl_accounts: [
    account('a10', '10', '1000', 'Checking', 'bank'),
    account('a40', '40', '4000', 'Sales', 'income'),
    account('a41', '41', '4100', 'Discounts', 'income'),
    account('a42', '42', '4200', 'Rent income', 'income', 'co-1084'),
    account('a50', '50', '5000', 'Materials', 'cost_of_goods_sold'),
    account('a61', '61', '6010', 'Wages', 'expense'),
    account('a65', '65', '6500', 'Rent', 'expense'),
    account('afs', null, null, 'Shop supplies', 'expense'),
    account('a70', '70', '7000', 'Interest income', 'other_income'),
    account('a80', '80', '8000', 'Interest expense', 'other_expense'),
  ],
  // QuickBooks' last two months, and NetSuite's January 2025 copied while the switch was off.
  ledger_report_snapshots: [
    snapshot('quickbooks', 'month', '2024-11-01', { 'Total Income': 900, 'Total Expenses': 600, 'Net Income': 300 }),
    snapshot('quickbooks', 'month', '2024-12-01', { 'Total Income': 1100, 'Total Expenses': 700, 'Net Income': 400 }),
    { ...snapshot('netsuite', 'month', '2025-01-01', NS_JANUARY, '2025-04-01T00:00:00Z'), payload: { rows: [] } },
  ],
  ledger_invoices: [{ id: 'i1', source: 'netsuite', doc_type: 'invoice', doc_date: '2026-10-05', total: '1070.00', voided: false, deleted_at: null }],
};

const BMG_JOURNAL = [
  // Dated before the books' first month: December 2024 is QuickBooks'.
  entry('40', '2024-12-01', 0, 777),
  // January 2025: $1,000 of sales less a $50 discount, $400 of materials, wages, rent, shop supplies and interest.
  entry('40', '2025-01-01', 0, 1000), entry('41', '2025-01-01', 50, 0), entry('50', '2025-01-01', 400, 0),
  entry('61', '2025-01-01', 300, 0), entry('65', '2025-01-01', 100, 0), entry('fs:afs', '2025-01-01', 25, 0),
  entry('70', '2025-01-01', 0, 20), entry('80', '2025-01-01', 10, 0), entry('10', '2025-01-01', 135, 0), entry('99', '2025-01-01', 0, 5),
  // October 2026: $2,000 of sales, $800 of materials and $100 of rent; $500 of sales so far in November.
  entry('40', '2026-10-01', 0, 2000), entry('50', '2026-10-01', 800, 0), entry('65', '2026-10-01', 100, 0),
  entry('40', '2026-11-01', 0, 500),
  // A bill dated next month.
  entry('65', '2026-12-01', 100, 0),
];
/** 1084's rent, which NetSuite's income statement read can't keep out of BMG's. */
const JOURNAL_1084 = [entry('42', '2026-10-01', 0, 1500)];

let switchOn = true;
let cutover: string | null = '2025-01-01';
let postingError: string | null = null;
/** A table or function whose read fails. */
let failing: string | null = null;
const queries: Array<{ table: string; filters: Row }> = [];
const upserts: Row[] = [];
const rpcs: Array<[string, Row]> = [];

/** Just enough of supabase-js for Financial History. */
function query(table: string) {
  const filters: Row = {};
  const where: Array<(r: Row) => boolean> = [];
  let range: [number, number] | null = null;
  const rows = () => {
    const all = table === 'books_switches' ? [{ piece: 'money_screens', is_on: switchOn }]
      : table === 'app_settings' ? [{ key: 'ledger', value: cutover ? { cutover: { date: cutover } } : {} }]
        : table === 'sync_state' ? [{ sync_type: 'books_invoice_posting', last_result: { partial: false, error: postingError }, updated_at: '2026-11-02T17:48:00Z' }]
          : TABLES[table] ?? [];
    const kept = all.filter((r) => where.every((w) => w(r)));
    return range ? kept.slice(range[0], range[1] + 1) : kept;
  };
  const answer = () => (failing === table ? { data: null, error: { message: `Couldn't read ${table}` } } : { data: rows(), error: null });
  const q: any = {
    select: () => { queries.push({ table, filters }); return q; },
    eq: (c: string, v: unknown) => { filters[c] = v; where.push((r) => r[c] === v); return q; },
    in: (c: string, vs: unknown[]) => { where.push((r) => vs.includes(r[c])); return q; },
    is: (c: string, v: unknown) => { where.push((r) => (r[c] ?? null) === v); return q; },
    lt: (c: string, v: string) => { where.push((r) => String(r[c]) < v); return q; },
    lte: (c: string, v: string) => { where.push((r) => String(r[c]) <= v); return q; },
    gte: (c: string, v: string) => { where.push((r) => String(r[c]) >= v); return q; },
    order: () => q,
    range: (from: number, to: number) => { range = [from, to]; return q; },
    maybeSingle: async () => {
      const a = answer();
      return a.error ? a : { data: a.data![0] ?? null, error: null };
    },
    upsert: async (row: Row) => { upserts.push(row); return { error: null }; },
    then: (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(answer()).then(done, failed),
  };
  return q;
}
const service = {
  from: query,
  rpc: async (name: string, args: Row) => {
    rpcs.push([name, args]);
    if (failing === name) return { data: null, error: { message: `${name} failed` } };
    if (name === 'gl_netsuite_totals') return { data: { opening: [], netsuite: [] }, error: null };
    if (name === 'gl_books_totals') return { data: args.p_company === 'BMG' ? BMG_JOURNAL : JOURNAL_1084, error: null };
    return { data: null, error: { message: `No ${name}` } };
  },
};

const get = (path: string) => new NextRequest(`https://go.bmgfleet.com${path}`);
const history = async () => {
  const res = await historyRoute(get('/api/reports/financial-history'));
  return { status: res.status, body: await res.json() };
};
const year = async (y: number) => {
  const res = await yearRoute(get(`/api/reports/financial-history/year?year=${y}`));
  return { status: res.status, body: await res.json() };
};
const netsuiteSnapshotReads = () => queries.filter((q) => q.table === 'ledger_report_snapshots' && q.filters.source === 'netsuite');
const month = (body: { months: Array<{ month: string }> }, m: string) => body.months.find((x) => x.month === m);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-02T18:00:00Z'));
  switchOn = true;
  cutover = '2025-01-01';
  postingError = null;
  failing = null;
  queries.length = 0;
  upserts.length = 0;
  rpcs.length = 0;
  netsuite.getIncomeStatementFromRestlet.mockReset();
  netsuite.getIncomeStatementFromRestlet.mockResolvedValue({
    success: true, rows: [{ accountId: '40', accountName: 'Sales', accountType: 'Income', segment: null, amount: -5000 }],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Financial History on FleetSuite's books, switched on", () => {
  it("takes the months from the cutover from BMG's books, without 1084's, and never NetSuite", async () => {
    const { status, body } = await history();
    expect(status).toBe(200);
    expect(body.months.map((m: { month: string; source: string }) => `${m.month} ${m.source}`).slice(0, 4))
      .toEqual(['2024-11 quickbooks', '2024-12 quickbooks', '2025-01 fleetsuite', '2025-02 fleetsuite']);
    expect(body.months).toHaveLength(25);
    expect(body.months.at(-1)).toEqual({
      month: '2026-11', source: 'fleetsuite', income: 500, cogs: 0, grossProfit: 500, expenses: 0, otherNet: 0, netIncome: 500, directional: true,
    });
    // Payroll in expenses, a FleetSuite-only account counted, the bank and an account outside the chart not.
    expect(month(body, '2025-01')).toEqual({
      month: '2025-01', source: 'fleetsuite', income: 950, cogs: 400, grossProfit: 550, expenses: 425, otherNet: 10, netIncome: 135, directional: false,
    });
    // 1084's $1,500 of rent income isn't BMG's.
    expect(month(body, '2026-10')).toMatchObject({ income: 2000, cogs: 800, expenses: 100, netIncome: 1100 });
    expect(month(body, '2025-06')).toMatchObject({ income: 0, netIncome: 0 });
    expect(month(body, '2024-12')).toMatchObject({ source: 'quickbooks', income: 1100 });
    expect(body.years.map((y: { year: number; income: number; months: number; sources: string[]; directional: boolean }) =>
      [y.year, y.income, y.months, y.sources, y.directional])).toEqual([
      [2024, 2000, 2, ['quickbooks'], false],
      [2025, 950, 12, ['fleetsuite'], false],
      [2026, 2500, 11, ['fleetsuite'], true],
    ]);
    expect(body).toMatchObject({ cutover: '2025-01-01', netsuitePending: 0, errors: [] });
    expect(body.books).toEqual({ company: 'BMG', name: 'Example Fleet', postedAt: '2026-11-02T17:48:00Z', postingError: null, postingPartial: false });
    expect(netsuite.getIncomeStatementFromRestlet).not.toHaveBeenCalled();
    expect(netsuiteSnapshotReads()).toEqual([]);
    expect(upserts).toEqual([]);
    expect(rpcs).toEqual([['gl_netsuite_totals', { p_company: 'BMG' }], ['gl_books_totals', { p_company: 'BMG' }]]);
  });

  it('keeps NetSuite for the months between an earlier cutover and the books’ first month', async () => {
    cutover = '2024-12-01';
    const { body } = await history();
    expect(body.months.slice(0, 3).map((m: { month: string; source: string; income: number }) => [m.month, m.source, m.income])).toEqual([
      ['2024-11', 'quickbooks', 900], ['2024-12', 'netsuite', 5000], ['2025-01', 'fleetsuite', 950],
    ]);
    expect(netsuite.getIncomeStatementFromRestlet.mock.calls).toEqual([['2024-12-01', '2024-12-31']]);
    expect(upserts.map((u) => u.period_start)).toEqual(['2024-12-01']);
  });

  it('starts the books at a later cutover, and at their own first month with none confirmed', async () => {
    cutover = '2025-06-01';
    const later = (await history()).body;
    expect(later.months.filter((m: { source: string }) => m.source === 'fleetsuite')[0].month).toBe('2025-06');
    expect(month(later, '2025-01')).toBeUndefined();
    expect(later.months[0]).toMatchObject({ month: '2024-11', source: 'quickbooks' });

    cutover = null;
    const none = (await history()).body;
    expect(none.months[0]).toMatchObject({ month: '2025-01', source: 'fleetsuite', income: 950 });
    expect(none.months).toHaveLength(23);
    expect(none.cutover).toBeNull();
    expect(netsuite.getIncomeStatementFromRestlet).not.toHaveBeenCalled();
  });

  it('says how the last posting run went', async () => {
    postingError = 'NetSuite timed out';
    expect((await history()).body.books).toMatchObject({ postedAt: '2026-11-02T17:48:00Z', postingError: 'NetSuite timed out' });
  });

  it("says in red when FleetSuite's books can't be read, and doesn't fall back to NetSuite", async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [what, why] of [['gl_books_totals', 'gl_books_totals failed'], ['gl_accounts', "Couldn't read gl_accounts"]]) {
      failing = what;
      expect(await history()).toEqual({ status: 500, body: { error: `Couldn't read FleetSuite's books: ${why}` } });
      expect(await year(2026)).toEqual({ status: 500, body: { error: `Couldn't read FleetSuite's books: ${why}` } });
    }
    expect(netsuite.getIncomeStatementFromRestlet).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("puts FleetSuite's revenue beside each system's, and the year by account from the books", async () => {
    const { status, body } = await year(2026);
    expect(status).toBe(200);
    expect(body.months.map((m: { used: string }) => m.used)).toEqual(Array(12).fill('fleetsuite'));
    expect(body.months.map((m: { fleetsuitePnl: number | null }) => m.fleetsuitePnl)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 2000, 500, null]);
    expect(body.months[9]).toEqual({
      month: '2026-10', used: 'fleetsuite', quickbooksPnl: null, netsuitePnl: null, fleetsuitePnl: 2000, quickbooksInvoiced: 0, netsuiteInvoiced: 1070,
    });
    // December's bill is after this month, so it isn't in the year.
    expect(body.accounts).toEqual([{
      source: 'fleetsuite',
      sections: [
        { section: 'Income', total: 2500, lines: [{ label: '4000 Sales', amount: 2500 }] },
        { section: 'Cost of Goods Sold', total: 800, lines: [{ label: '5000 Materials', amount: 800 }] },
        { section: 'Expenses', total: 100, lines: [{ label: '6500 Rent', amount: 100 }] },
      ],
    }]);
    expect(body.netsuiteMonthsMissing).toEqual([]);
    expect(netsuite.getIncomeStatementFromRestlet).not.toHaveBeenCalled();
  });

  it("shows NetSuite's copy beside the books where there is one, and each account the books have", async () => {
    const { body } = await year(2025);
    expect(body.months[0]).toMatchObject({ used: 'fleetsuite', netsuitePnl: 4321, fleetsuitePnl: 950 });
    expect(body.accounts[0].sections.map((s: { section: string; total: number }) => [s.section, s.total])).toEqual([
      ['Income', 950], ['Cost of Goods Sold', 400], ['Expenses', 425], ['Other Income', 20], ['Other Expenses', 10],
    ]);
    expect(body.accounts[0].sections[2].lines).toEqual([
      { label: '6010 Wages', amount: 300 }, { label: '6500 Rent', amount: 100 }, { label: 'Shop supplies', amount: 25 },
    ]);
  });

  it("reads no books for a year before them, and keeps FleetSuite's revenue beside QuickBooks' after a later cutover", async () => {
    const before = (await year(2024)).body;
    expect(before.months.every((m: { used: string; fleetsuitePnl: number | null }) => m.used === 'quickbooks' && m.fleetsuitePnl === null)).toBe(true);
    expect(rpcs).toEqual([]);

    cutover = '2024-12-01';
    const mixed = (await year(2024)).body;
    expect(mixed.months.map((m: { used: string }) => m.used)).toEqual([...Array(11).fill('quickbooks'), 'netsuite']);
    expect(mixed.netsuiteMonthsMissing).toEqual(['2024-12']);

    cutover = '2025-06-01';
    const later = (await year(2025)).body;
    expect(later.months.map((m: { used: string }) => m.used)).toEqual([...Array(5).fill('quickbooks'), ...Array(7).fill('fleetsuite')]);
    expect(later.months[0]).toMatchObject({ used: 'quickbooks', fleetsuitePnl: 950 });
    // June to December have nothing in the books, so there's nothing to list by account.
    expect(later.accounts).toEqual([]);
  });
});

describe("Financial History with FleetSuite's books switched off", () => {
  it('reads NetSuite from the cutover as before, and nothing from the books', async () => {
    switchOn = false;
    const { status, body } = await history();
    expect(status).toBe(200);
    expect(body.months.slice(1, 4).map((m: { month: string; source: string; income: number }) => [m.month, m.source, m.income])).toEqual([
      ['2024-12', 'quickbooks', 1100], ['2025-01', 'netsuite', 4321], ['2025-02', 'netsuite', 5000],
    ]);
    expect(body.months.at(-1)).toMatchObject({ month: '2026-11', source: 'netsuite', directional: true });
    expect(body.books).toBeNull();
    // Every month but the copied January, this month to today and not kept.
    expect(netsuite.getIncomeStatementFromRestlet).toHaveBeenCalledTimes(22);
    expect(netsuite.getIncomeStatementFromRestlet).toHaveBeenLastCalledWith('2026-11-01', '2026-11-02');
    expect(upserts).toHaveLength(21);
    expect(rpcs).toEqual([]);
    expect(queries.some((q) => q.table === 'gl_accounts')).toBe(false);
  });

  it("leaves the year's cross-check as it was", async () => {
    switchOn = false;
    const { body } = await year(2026);
    expect(body.months.map((m: { used: string }) => m.used)).toEqual(Array(12).fill('netsuite'));
    expect(body.months.every((m: { fleetsuitePnl: number | null }) => m.fleetsuitePnl === null)).toBe(true);
    expect(body.netsuiteMonthsMissing).toHaveLength(12);
    expect(body.accounts).toEqual([]);
    expect(rpcs).toEqual([]);
  });

  it("counts a switch that can't be read as off", async () => {
    failing = 'books_switches';
    expect((await history()).body.books).toBeNull();
    expect((await year(2026)).body.months[0].used).toBe('netsuite');
    expect(rpcs).toEqual([]);
    expect(netsuite.getIncomeStatementFromRestlet).toHaveBeenCalled();
  });
});
