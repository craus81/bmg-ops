import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { buildReport, type BuilderAsk, type BuiltReport, type PartyAmount, type SplitAmount } from './report-builder';
import { report, type ReportAccount, type ReportAmount, type ReportData } from './reports';

const INCOME_STATEMENT = new Set(['income', 'other_income', 'cost_of_goods_sold', 'expense', 'other_expense']);
const account = (id: string, ns: string | null, number: string, name: string, type: string, extra: Partial<ReportAccount> = {}): ReportAccount => ({
  id, netsuite_account_id: ns, number, name, account_type: type,
  statement: INCOME_STATEMENT.has(type) ? 'income_statement' : 'balance_sheet', parent_id: null, ...extra,
});

/** Made-up chart: Payroll is a parent of Wages; Shop supplies is FleetSuite's own. */
const ACCOUNTS: ReportAccount[] = [
  account('a12', '12', '1200', 'Receivables', 'accounts_receivable'),
  account('a40', '40', '4000', 'Sales', 'income'),
  account('a42', '42', '4200', 'Freight income', 'income'),
  account('a50', '50', '5000', 'Cost of goods sold', 'cost_of_goods_sold'),
  account('a60', '60', '6000', 'Payroll', 'expense'),
  account('a61', '61', '6010', 'Wages', 'expense', { parent_id: 'a60' }),
  account('a65', '65', '6500', 'Rent', 'expense'),
  account('afs', null, '6900', 'Shop supplies', 'expense'),
  account('a80', '80', '8000', 'Interest income', 'other_income'),
];
const SHOP = 'fs:afs';

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const sides = (cents: number) => ({ debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00' });

/** One line of the split: debit positive; a location is FleetSuite's own key, or 'ns:<id>' for NetSuite's on the document. */
function split(acct: string, month: string, division: string | null, location: string | null, cents: number): SplitAmount {
  const ns = location?.startsWith('ns:') ? location.slice(3) : null;
  return { account: acct, month, division, location: ns ? null : location, netsuite_location: ns, ...sides(cents) };
}

// Made-up journal. January 2026: a graphics sale at O'Fallon and an upfit
// sale with freight at Kansas City, their cost, wages at O'Fallon and rent
// shared by both divisions. February: an upfit sale at Wentzville with its
// cost, shop supplies and bank interest. March: a graphics sale at Social
// Circle, an upfit sale at a location NetSuite's lists don't name, and rent
// at a location FleetSuite has no NetSuite id for. December 2025 and April
// 2026 have a sale each.
const SPLIT: SplitAmount[] = [
  split('40', '2025-12-01', 'upfit', 'ns:1', -70000),
  split('40', '2026-01-01', 'graphics', 'ns:1', -100000),
  split('40', '2026-01-01', 'upfit', 'ns:3', -300000),
  split('42', '2026-01-01', null, 'ns:3', -5000),
  split('50', '2026-01-01', 'graphics', 'ns:1', 40000),
  split('50', '2026-01-01', 'upfit', 'ns:3', 120000),
  split('61', '2026-01-01', null, 'ofallon', 50000),
  split('65', '2026-01-01', 'shared', 'ofallon', 100000),
  split('40', '2026-02-01', 'upfit', 'ns:2', -200000),
  split('50', '2026-02-01', 'upfit', 'ns:2', 80000),
  split(SHOP, '2026-02-01', null, null, 2500),
  split('80', '2026-02-01', null, null, -1000),
  split('40', '2026-03-01', 'graphics', 'ns:5', -50000),
  split('50', '2026-03-01', 'graphics', 'ns:5', 20000),
  split('40', '2026-03-01', 'upfit', 'ns:7', -10000),
  split('65', '2026-03-01', 'shared', 'denver', 30000),
  split('40', '2026-04-01', 'graphics', 'ns:1', -9000),
];

const NAMES = new Map([['1', "O'Fallon"], ['2', 'Wentzville'], ['3', 'Kansas City'], ['5', 'Social Circle']]);

/** FleetSuite's journal per account and month, as gl_books_totals sums it: the split's lines, and the receivables. */
function totalsOf(rows: SplitAmount[]): ReportAmount[] {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.account}|${r.month}`;
    sums.set(key, (sums.get(key) ?? 0) + Math.round(Number(r.debit) * 100) - Math.round(Number(r.credit) * 100));
  }
  return [...sums].map(([key, cents]) => ({ account: key.split('|')[0], month: key.split('|')[1], ...sides(cents) }));
}

function books(rows: SplitAmount[] = SPLIT, extra: ReportAmount[] = []): ReportData {
  const receivables = rows.filter((r) => ['40', '42'].includes(r.account)).map((r) => ({ ...r, account: '12', debit: r.credit, credit: r.debit }));
  return { company: 'BMG', accounts: ACCOUNTS, opening: [], netsuite: [], fleetsuite: [...totalsOf([...rows, ...receivables]), ...extra] };
}

const Q1: BuilderAsk = { rows: 'account', months: 'picked', from: '2026-01-01', to: '2026-03-01', by: 'division', division: null, location: null };
const build = (ask: Partial<BuilderAsk> = {}, rows: SplitAmount[] = SPLIT, data: ReportData = books(rows)) =>
  buildReport(data, rows, NAMES, { ...Q1, ...ask });

/** The split by name: a line of the split for one customer or vendor (NetSuite's id), or none. */
const named = (party: string | null, ...line: Parameters<typeof split>): PartyAmount => ({ ...split(...line), party });

// The split by customer: Kansas City's upfit sale in January was for Acme
// and Bolt, and its cost too; the wages, rent, shop supplies and interest
// name no customer. December and April are outside the first quarter.
const CUSTOMERS: PartyAmount[] = [
  named('301', '40', '2025-12-01', 'upfit', 'ns:1', -70000),
  named('302', '40', '2026-01-01', 'graphics', 'ns:1', -100000),
  named('301', '40', '2026-01-01', 'upfit', 'ns:3', -200000),
  named('302', '40', '2026-01-01', 'upfit', 'ns:3', -100000),
  named('301', '42', '2026-01-01', null, 'ns:3', -5000),
  named('302', '50', '2026-01-01', 'graphics', 'ns:1', 40000),
  named('301', '50', '2026-01-01', 'upfit', 'ns:3', 80000),
  named('302', '50', '2026-01-01', 'upfit', 'ns:3', 40000),
  named(null, '61', '2026-01-01', null, 'ofallon', 50000),
  named(null, '65', '2026-01-01', 'shared', 'ofallon', 100000),
  named('303', '40', '2026-02-01', 'upfit', 'ns:2', -200000),
  named('303', '50', '2026-02-01', 'upfit', 'ns:2', 80000),
  named(null, SHOP, '2026-02-01', null, null, 2500),
  named(null, '80', '2026-02-01', null, null, -1000),
  named('302', '40', '2026-03-01', 'graphics', 'ns:5', -50000),
  named('302', '50', '2026-03-01', 'graphics', 'ns:5', 20000),
  named('301', '40', '2026-03-01', 'upfit', 'ns:7', -10000),
  named(null, '65', '2026-03-01', 'shared', 'denver', 30000),
  named('301', '40', '2026-04-01', 'graphics', 'ns:1', -9000),
];
const CUSTOMER_NAMES = new Map([['301', 'Acme Fleet'], ['302', 'Bolt Rentals'], ['303', 'Cobalt Utility']]);

// The split by vendor: the rent is Oak Properties', the shop supplies and
// some of the cost Hitch Supply's; the sales and wages name no vendor.
const VENDORS: PartyAmount[] = SPLIT.flatMap((r): PartyAmount[] => {
  if (r.account === '65') return [{ ...r, party: '401' }];
  if (r.account === SHOP) return [{ ...r, party: '402' }];
  if (r.account === '50' && r.month === '2026-01-01' && r.division === 'upfit') {
    return [{ ...r, ...sides(30000), party: '402' }, { ...r, ...sides(90000), party: null }];
  }
  if (r.account === '50' && r.month === '2026-03-01') return [{ ...r, party: '402' }];
  return [{ ...r, party: null }];
});
const VENDOR_NAMES = new Map([['401', 'Oak Properties'], ['402', 'Hitch Supply']]);

const byName = (
  rows: 'customer' | 'vendor', ask: Partial<BuilderAsk> = {}, list = rows === 'customer' ? CUSTOMERS : VENDORS,
  names = rows === 'customer' ? CUSTOMER_NAMES : VENDOR_NAMES, data = books(),
) => buildReport(data, SPLIT, NAMES, { ...Q1, rows, ...ask }, { rows: list, names });

const table = (built: BuiltReport) => built.lines.map((l) => [l.kind, l.depth, l.label, l.amounts]);
const amountsOf = (built: BuiltReport, label: string) => built.lines.find((l) => l.label === label)?.amounts;
const labels = (built: BuiltReport) => built.columns.map((c) => c.label);

describe('the report builder', () => {
  it('lays the profit and loss out by division, every column with the same lines and a Total', () => {
    const built = build();
    expect(labels(built)).toEqual(['Upfit', 'Graphics', 'Shared', 'Not split', 'Total']);
    expect(table(built)).toEqual([
      ['section', 0, 'Income', null],
      ['account', 1, 'Sales', [510000, 150000, 0, 0, 660000]],
      ['account', 1, 'Freight income', [0, 0, 0, 5000, 5000]],
      ['total', 0, 'Total income', [510000, 150000, 0, 5000, 665000]],
      ['section', 0, 'Cost of sales', null],
      ['account', 1, 'Cost of goods sold', [200000, 60000, 0, 0, 260000]],
      ['total', 0, 'Total cost of sales', [200000, 60000, 0, 0, 260000]],
      ['total', 0, 'Gross profit', [310000, 90000, 0, 5000, 405000]],
      ['section', 0, 'Expense', null],
      ['heading', 1, 'Payroll', null],
      ['account', 2, 'Wages', [0, 0, 0, 50000, 50000]],
      ['total', 1, 'Total Payroll', [0, 0, 0, 50000, 50000]],
      ['account', 1, 'Rent', [0, 0, 130000, 0, 130000]],
      ['account', 1, 'Shop supplies', [0, 0, 0, 2500, 2500]],
      ['total', 0, 'Total expense', [0, 0, 130000, 52500, 182500]],
      ['total', 0, 'Net ordinary income', [310000, 90000, -130000, -47500, 222500]],
      ['section', 0, 'Other income', null],
      ['account', 1, 'Interest income', [0, 0, 0, 1000, 1000]],
      ['total', 0, 'Total other income', [0, 0, 0, 1000, 1000]],
      ['total', 0, 'Net other income', [0, 0, 0, 1000, 1000]],
      ['total', 0, 'Net income', [310000, 90000, -130000, -46500, 223500]],
    ]);
    expect(built.lines.filter((l) => l.grand).map((l) => l.label)).toEqual(['Gross profit', 'Net ordinary income', 'Net other income', 'Net income']);
    expect(built.lines.find((l) => l.label === 'Shop supplies')).toMatchObject({ number: '6900', account: SHOP });
    expect(built.ties).toBe(true);
  });

  it("has its Total come to the profit and loss on Reports for the same months, line for line", () => {
    for (const ask of [Q1, { ...Q1, by: 'month' as const }, { ...Q1, from: '2025-12-01', to: '2026-04-01', by: 'location' as const }]) {
      const built = build(ask);
      const pl = report(books(), 'profit_and_loss', { from: ask.from, to: ask.to }).lines;
      expect(built.lines.map((l) => [l.kind, l.label, l.amounts?.at(-1) ?? null])).toEqual(pl.map((l) => [l.kind, l.label, l.fleetsuite]));
    }
  });

  it('gives each month a column, one with nothing in it too', () => {
    const built = build({ by: 'month', from: '2026-01-01', to: '2026-04-01' });
    expect(labels(built)).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026', 'Apr 2026', 'Total']);
    expect(built.columns.map((c) => c.key)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', 'total']);
    expect(amountsOf(built, 'Sales')).toEqual([400000, 200000, 60000, 9000, 669000]);
    expect(amountsOf(built, 'Shop supplies')).toEqual([0, 2500, 0, 0, 2500]);
    expect(amountsOf(built, 'Net income')).toEqual([95000, 118500, 10000, 9000, 232500]);
    // A month with nothing in it still has its column.
    expect(labels(build({ by: 'month', from: '2025-10-01', to: '2025-12-01' }))).toEqual(['Oct 2025', 'Nov 2025', 'Dec 2025', 'Total']);
  });

  it('gives each quarter or year a column, one the months cover only part of saying which months it has', () => {
    const quarters = build({ by: 'quarter', from: '2025-11-01', to: '2026-04-01' });
    expect(labels(quarters)).toEqual(['Q4 2025 (Nov–Dec)', 'Q1 2026', 'Q2 2026 (Apr)', 'Total']);
    expect(quarters.columns.map((c) => c.key)).toEqual(['2025-Q4', '2026-Q1', '2026-Q2', 'total']);
    expect(amountsOf(quarters, 'Sales')).toEqual([70000, 660000, 9000, 739000]);
    const years = build({ by: 'year', from: '2025-03-01', to: '2026-04-01' });
    expect(labels(years)).toEqual(['2025 (Mar–Dec)', '2026 (Jan–Apr)', 'Total']);
    expect(amountsOf(years, 'Sales')).toEqual([70000, 669000, 739000]);
    expect(labels(build({ by: 'year', from: '2026-12-01', to: '2026-12-01' }))).toEqual(['2026 (Dec)']);
  });

  it('has no Total when there is only one column, and the months altogether with no columns asked for', () => {
    const year = build({ by: 'year', from: '2025-01-01', to: '2025-12-01' });
    expect(labels(year)).toEqual(['2025']);
    expect(amountsOf(year, 'Sales')).toEqual([70000]);
    expect(labels(build({ by: 'month', from: '2026-02-01', to: '2026-02-01' }))).toEqual(['Feb 2026']);
    const total = build({ by: 'total' });
    expect(total.columns).toEqual([{ key: 'total', label: 'Total' }]);
    expect(amountsOf(total, 'Net income')).toEqual([223500]);
  });

  it("gives each location a column, FleetSuite's own key as NetSuite's location, by NetSuite's id, then any it can't place, then none", () => {
    const built = build({ by: 'location', from: '2025-12-01', to: '2026-04-01' });
    expect(built.locations).toEqual([
      { key: '1', label: "O'Fallon" },
      { key: '2', label: 'Wentzville' },
      { key: '3', label: 'Kansas City' },
      { key: '5', label: 'Social Circle' },
      { key: '7', label: 'Location 7' },
      { key: 'own:denver', label: 'Location denver' },
      { key: 'none', label: 'No location' },
    ]);
    expect(built.columns).toEqual([...built.locations, { key: 'total', label: 'Total' }]);
    // O'Fallon's sales and costs are NetSuite's location on their documents; its wages and rent FleetSuite's own key.
    expect(amountsOf(built, 'Sales')).toEqual([179000, 200000, 300000, 50000, 10000, 0, 0, 739000]);
    expect(amountsOf(built, 'Total expense')).toEqual([150000, 0, 0, 0, 0, 30000, 2500, 182500]);
    expect(amountsOf(built, 'Net income')).toEqual([-11000, 120000, 185000, 30000, 10000, -30000, -1500, 302500]);
    // NetSuite's ids in order as numbers.
    const more = build({ by: 'location' }, [...SPLIT, split('40', '2026-02-01', 'upfit', 'ns:12', -500)]);
    expect(more.locations.map((l) => l.key)).toEqual(['1', '2', '3', '5', '7', '12', 'own:denver', 'none']);
  });

  it('gives a division or location a column only when the report has lines for it, the filters still offering every one', () => {
    const february = build({ by: 'location', from: '2026-02-01', to: '2026-02-01' });
    expect(labels(february)).toEqual(['Wentzville', 'No location', 'Total']);
    expect(february.locations).toHaveLength(7);
    expect(amountsOf(february, 'Net income')).toEqual([120000, -1500, 118500]);
    expect(labels(build({ from: '2026-02-01', to: '2026-02-01' }))).toEqual(['Upfit', 'Not split', 'Total']);
    // One with lines only in other months has none.
    expect(labels(build({ by: 'location', from: '2026-04-01', to: '2026-04-01' }))).toEqual(["O'Fallon"]);
  });

  it('lists the divisions the journal has, in order, and a line with none as Not split', () => {
    expect(build().divisions).toEqual([
      { key: 'upfit', label: 'Upfit' }, { key: 'graphics', label: 'Graphics' }, { key: 'shared', label: 'Shared' }, { key: 'none', label: 'Not split' },
    ]);
    const rows = SPLIT.filter((r) => r.division !== 'shared' && r.division !== 'upfit');
    expect(build({}, rows).divisions).toEqual([{ key: 'graphics', label: 'Graphics' }, { key: 'none', label: 'Not split' }]);
    expect(labels(build({}, rows))).toEqual(['Graphics', 'Not split', 'Total']);
  });

  it("shows only the division's lines it's asked for, across the locations", () => {
    const built = build({ by: 'location', division: 'graphics' });
    expect(built.division).toBe('graphics');
    expect(built.location).toBeNull();
    // The filters still offer every division and location.
    expect(built.divisions).toHaveLength(4);
    expect(built.locations).toHaveLength(7);
    // A column for each location that has its lines.
    expect(labels(built)).toEqual(["O'Fallon", 'Social Circle', 'Total']);
    expect(table(built)).toEqual([
      ['section', 0, 'Income', null],
      ['account', 1, 'Sales', [100000, 50000, 150000]],
      ['total', 0, 'Total income', [100000, 50000, 150000]],
      ['section', 0, 'Cost of sales', null],
      ['account', 1, 'Cost of goods sold', [40000, 20000, 60000]],
      ['total', 0, 'Total cost of sales', [40000, 20000, 60000]],
      ['total', 0, 'Gross profit', [60000, 30000, 90000]],
      ['total', 0, 'Net ordinary income', [60000, 30000, 90000]],
      ['total', 0, 'Net income', [60000, 30000, 90000]],
    ]);
    // Asked for by division too, it's the one column.
    expect(labels(build({ division: 'graphics' }))).toEqual(['Graphics']);
    expect(amountsOf(build({ division: 'none' }), 'Net income')).toEqual([-46500]);
  });

  it("shows only the location's lines it's asked for, FleetSuite's own key and NetSuite's alike", () => {
    const built = build({ location: '1' });
    expect(built.location).toBe('1');
    // O'Fallon has no upfit lines in the months.
    expect(labels(built)).toEqual(['Graphics', 'Shared', 'Not split', 'Total']);
    expect(amountsOf(built, 'Sales')).toEqual([100000, 0, 0, 100000]);
    expect(amountsOf(built, 'Wages')).toEqual([0, 0, 50000, 50000]);
    expect(amountsOf(built, 'Rent')).toEqual([0, 100000, 0, 100000]);
    expect(amountsOf(built, 'Shop supplies')).toBeUndefined();
    expect(labels(build({ location: '1', by: 'location' }))).toEqual(["O'Fallon"]);
    expect(amountsOf(build({ location: 'own:denver', by: 'month' }), 'Rent')).toEqual([0, 0, 30000, 30000]);
    expect(amountsOf(build({ location: 'none', by: 'total' }), 'Net income')).toEqual([-1500]);
    // Both at once.
    expect(amountsOf(build({ location: '3', division: 'upfit', by: 'month' }), 'Gross profit')).toEqual([180000, 0, 0, 180000]);
  });

  it("shows every division and location for one the company's journal doesn't have", () => {
    const built = build({ division: 'nope', location: '99' });
    expect([built.division, built.location]).toEqual([null, null]);
    expect(built).toEqual(build());
  });

  it('shows an account with something in any column in all of them, though it comes to nothing altogether', () => {
    const rows = [split('65', '2026-01-01', 'shared', null, 10000), split('65', '2026-02-01', 'shared', null, -10000), split('40', '2026-01-01', 'upfit', null, -50000)];
    const months = build({ by: 'month' }, rows);
    expect(table(months)).toEqual([
      ['section', 0, 'Income', null],
      ['account', 1, 'Sales', [50000, 0, 0, 50000]],
      ['total', 0, 'Total income', [50000, 0, 0, 50000]],
      ['total', 0, 'Gross profit', [50000, 0, 0, 50000]],
      ['section', 0, 'Expense', null],
      ['account', 1, 'Rent', [10000, -10000, 0, 0]],
      ['total', 0, 'Total expense', [10000, -10000, 0, 0]],
      ['total', 0, 'Net ordinary income', [40000, 10000, 0, 50000]],
      ['total', 0, 'Net income', [40000, 10000, 0, 50000]],
    ]);
    // Altogether, it comes to nothing, so it doesn't show.
    expect(amountsOf(build({ by: 'total' }, rows), 'Rent')).toBeUndefined();
  });

  it("lists an account the chart doesn't have apart, as Reports does", () => {
    const rows = [...SPLIT, split('77', '2026-02-01', 'upfit', null, 700)];
    const built = build({}, rows);
    expect(table(built).slice(-2)).toEqual([
      ['section', 0, 'Not in the chart of accounts yet', null],
      ['account', 1, 'NetSuite account 77', [700, 0, 0, 0, 700]],
    ]);
    expect(built.lines.at(-1)).toMatchObject({ account: '77', inChart: false });
    expect(amountsOf(built, 'Net income')).toEqual(amountsOf(build(), 'Net income'));
  });

  it('lays out a company with nothing in its journal as an empty profit and loss', () => {
    const built = build({}, []);
    expect([built.divisions, built.locations]).toEqual([[], []]);
    expect(built.columns).toEqual([{ key: 'total', label: 'Total' }]);
    expect(table(built)).toEqual([
      ['total', 0, 'Gross profit', [0]],
      ['total', 0, 'Net ordinary income', [0]],
      ['total', 0, 'Net income', [0]],
    ]);
    expect(built.ties).toBe(true);
  });

  it("checks the split, all of it, comes to Reports' profit and loss for the months, account by account", () => {
    // gl_books_totals has one more sale in March than the split: it doesn't tie.
    expect(build({}, SPLIT, books(SPLIT, [{ account: '40', month: '2026-03-01', ...sides(-100) }])).ties).toBe(false);
    // The split has a month of an account gl_books_totals doesn't, an account it doesn't, or not one it has.
    expect(build({}, [...SPLIT, split('42', '2026-02-01', null, null, -100)], books(SPLIT)).ties).toBe(false);
    expect(build({}, [...SPLIT, split('60', '2026-02-01', null, null, 100)], books(SPLIT)).ties).toBe(false);
    expect(build({}, SPLIT, books(SPLIT, [{ account: '60', month: '2026-02-01', ...sides(100) }])).ties).toBe(false);
    // Months outside the ones picked don't count, nor do balance sheet accounts.
    expect(build({}, SPLIT, books(SPLIT, [{ account: '40', month: '2026-04-01', ...sides(-100) }])).ties).toBe(true);
    expect(build({}, SPLIT, books(SPLIT, [{ account: '12', month: '2026-02-01', ...sides(100) }])).ties).toBe(true);
    // Filters don't change it: it's the whole split.
    expect(build({ division: 'graphics', location: '5' }).ties).toBe(true);
  });

  it('lays the profit and loss out by customer, the biggest first in each part, with the same totals as by account', () => {
    const built = byName('customer', { by: 'total' });
    expect(built.rows).toBe('customer');
    expect(table(built)).toEqual([
      ['section', 0, 'Income', null],
      ['account', 1, 'Bolt Rentals', [250000]],
      ['account', 1, 'Acme Fleet', [215000]],
      ['account', 1, 'Cobalt Utility', [200000]],
      ['total', 0, 'Total income', [665000]],
      ['section', 0, 'Cost of sales', null],
      ['account', 1, 'Bolt Rentals', [100000]],
      // The same amount: by name.
      ['account', 1, 'Acme Fleet', [80000]],
      ['account', 1, 'Cobalt Utility', [80000]],
      ['total', 0, 'Total cost of sales', [260000]],
      ['total', 0, 'Gross profit', [405000]],
      ['section', 0, 'Expense', null],
      ['account', 1, 'No customer', [182500]],
      ['total', 0, 'Total expense', [182500]],
      ['total', 0, 'Net ordinary income', [222500]],
      ['section', 0, 'Other income', null],
      ['account', 1, 'No customer', [1000]],
      ['total', 0, 'Total other income', [1000]],
      ['total', 0, 'Net other income', [1000]],
      ['total', 0, 'Net income', [223500]],
    ]);
    expect(built.lines[1]).toEqual({ kind: 'account', depth: 1, label: 'Bolt Rentals', party: '302', amounts: [250000] });
    expect(built.lines.filter((l) => l.label === 'No customer').map((l) => l.party)).toEqual(['none', 'none']);
    expect(built.lines.filter((l) => l.grand).map((l) => l.label)).toEqual(['Gross profit', 'Net ordinary income', 'Net other income', 'Net income']);
    expect(built.ties).toBe(true);
  });

  it('lays the profit and loss out by vendor, the line with none last however big', () => {
    expect(table(byName('vendor', { by: 'total' }))).toEqual([
      ['section', 0, 'Income', null],
      ['account', 1, 'No vendor', [665000]],
      ['total', 0, 'Total income', [665000]],
      ['section', 0, 'Cost of sales', null],
      ['account', 1, 'Hitch Supply', [50000]],
      ['account', 1, 'No vendor', [210000]],
      ['total', 0, 'Total cost of sales', [260000]],
      ['total', 0, 'Gross profit', [405000]],
      ['section', 0, 'Expense', null],
      ['account', 1, 'Oak Properties', [130000]],
      ['account', 1, 'Hitch Supply', [2500]],
      ['account', 1, 'No vendor', [50000]],
      ['total', 0, 'Total expense', [182500]],
      ['total', 0, 'Net ordinary income', [222500]],
      ['section', 0, 'Other income', null],
      ['account', 1, 'No vendor', [1000]],
      ['total', 0, 'Total other income', [1000]],
      ['total', 0, 'Net other income', [1000]],
      ['total', 0, 'Net income', [223500]],
    ]);
  });

  it('comes to the same columns and totals by customer or vendor as by account', () => {
    const totals = (built: BuiltReport) => built.lines.filter((l) => l.kind === 'total' && l.depth === 0).map((l) => [l.label, l.amounts]);
    const asks: Array<Partial<BuilderAsk>> = [
      {}, { by: 'month' }, { by: 'location', from: '2025-12-01', to: '2026-04-01' }, { by: 'quarter', division: 'upfit' }, { location: '3' },
    ];
    for (const ask of asks) {
      for (const rows of ['customer', 'vendor'] as const) {
        const built = byName(rows, ask);
        expect(built.columns).toEqual(build(ask).columns);
        expect(totals(built)).toEqual(totals(build(ask)));
        expect([built.divisions, built.locations, built.division, built.location]).toEqual(
          [build(ask).divisions, build(ask).locations, build(ask).division, build(ask).location],
        );
      }
    }
  });

  it('gives a name a line in every column when any column has something for it', () => {
    // Customer 304 isn't on NetSuite's list: a sale in January taken back in March.
    const rows = [...CUSTOMERS, named('304', '40', '2026-01-01', 'upfit', 'ns:2', -500), named('304', '40', '2026-03-01', 'upfit', 'ns:2', 500)];
    const built = byName('customer', { by: 'month' }, rows);
    expect(labels(built)).toEqual(['Jan 2026', 'Feb 2026', 'Mar 2026', 'Total']);
    expect(table(built).slice(0, 6)).toEqual([
      ['section', 0, 'Income', null],
      ['account', 1, 'Bolt Rentals', [200000, 0, 50000, 250000]],
      ['account', 1, 'Acme Fleet', [205000, 0, 10000, 215000]],
      ['account', 1, 'Cobalt Utility', [0, 200000, 0, 200000]],
      ['account', 1, 'Customer 304', [500, 0, -500, 0]],
      ['total', 0, 'Total income', [405500, 200000, 59500, 665000]],
    ]);
    // Altogether, it comes to nothing, so it doesn't show.
    expect(amountsOf(byName('customer', { by: 'total' }, rows), 'Customer 304')).toBeUndefined();
  });

  it("shows only the division's or location's lines by name it's asked for", () => {
    const built = byName('customer', { by: 'location', division: 'graphics' });
    expect(labels(built)).toEqual(["O'Fallon", 'Social Circle', 'Total']);
    expect(table(built)).toEqual([
      ['section', 0, 'Income', null],
      ['account', 1, 'Bolt Rentals', [100000, 50000, 150000]],
      ['total', 0, 'Total income', [100000, 50000, 150000]],
      ['section', 0, 'Cost of sales', null],
      ['account', 1, 'Bolt Rentals', [40000, 20000, 60000]],
      ['total', 0, 'Total cost of sales', [40000, 20000, 60000]],
      ['total', 0, 'Gross profit', [60000, 30000, 90000]],
      ['total', 0, 'Net ordinary income', [60000, 30000, 90000]],
      ['total', 0, 'Net income', [60000, 30000, 90000]],
    ]);
    expect(amountsOf(byName('vendor', { location: 'own:denver', by: 'total' }), 'Oak Properties')).toEqual([30000]);
  });

  it("names a customer or vendor NetSuite's lists don't by its id, and lists one on an account the chart doesn't have apart", () => {
    const customers = byName('customer', { by: 'total' }, [...CUSTOMERS, named('309', '77', '2026-02-01', 'upfit', null, 700)]);
    expect(table(customers).slice(-2)).toEqual([
      ['section', 0, 'Not in the chart of accounts yet', null],
      ['account', 1, 'Customer 309', [700]],
    ]);
    expect(customers.lines.at(-1)).toMatchObject({ party: '309', inChart: false });
    expect(amountsOf(customers, 'Net income')).toEqual([223500]);
    const vendors = byName('vendor', { by: 'total' }, [...VENDORS, named('409', '77', '2026-02-01', null, null, 300), named(null, '77', '2026-02-01', null, null, 900)]);
    expect(table(vendors).slice(-3)).toEqual([
      ['section', 0, 'Not in the chart of accounts yet', null],
      ['account', 1, 'Vendor 409', [300]],
      ['account', 1, 'No vendor', [900]],
    ]);
  });

  it('puts names with the same amount in name order, and lists the biggest apart first', () => {
    // Zephyr Towing's id comes before Able Auto's, and so does its sale.
    const rows = [
      ...CUSTOMERS,
      named('310', '40', '2026-02-01', 'upfit', 'ns:2', -500), named('311', '40', '2026-03-01', 'upfit', 'ns:2', -500),
      named('312', '77', '2026-02-01', 'upfit', null, 300), named('313', '77', '2026-02-01', 'upfit', null, 900),
    ];
    const names = new Map<string, string>([
      ...CUSTOMER_NAMES, ['310', 'Zephyr Towing'], ['311', 'Able Auto'], ['312', 'Small Fleet'], ['313', 'Big Fleet'],
    ]);
    const built = byName('customer', { by: 'total' }, rows, names);
    expect(table(built).slice(0, 7)).toEqual([
      ['section', 0, 'Income', null],
      ['account', 1, 'Bolt Rentals', [250000]],
      ['account', 1, 'Acme Fleet', [215000]],
      ['account', 1, 'Cobalt Utility', [200000]],
      ['account', 1, 'Able Auto', [500]],
      ['account', 1, 'Zephyr Towing', [500]],
      ['total', 0, 'Total income', [666000]],
    ]);
    expect(table(built).slice(-3)).toEqual([
      ['section', 0, 'Not in the chart of accounts yet', null],
      ['account', 1, 'Big Fleet', [900]],
      ['account', 1, 'Small Fleet', [300]],
    ]);
  });

  it('has a line for each account when the split by name is not read', () => {
    const built = buildReport(books(), SPLIT, NAMES, { ...Q1, rows: 'customer' });
    expect(built.rows).toBe('account');
    expect(built).toEqual(build());
  });

  it("checks the split by name, as well as the split, comes to Reports' profit and loss for the months", () => {
    expect(byName('customer').ties).toBe(true);
    expect(byName('vendor').ties).toBe(true);
    // One more sale by name than Reports has, in the months, doesn't tie; outside them, it does.
    expect(byName('customer', {}, [...CUSTOMERS, named('301', '40', '2026-02-01', 'upfit', null, -100)]).ties).toBe(false);
    expect(byName('customer', {}, [...CUSTOMERS, named('301', '40', '2026-04-01', 'upfit', null, -100)]).ties).toBe(true);
    // The split itself still counts.
    const extra = [...SPLIT, split('42', '2026-02-01', null, null, -100)];
    expect(buildReport(books(), extra, NAMES, { ...Q1, rows: 'customer' }, { rows: CUSTOMERS, names: CUSTOMER_NAMES }).ties).toBe(false);
  });
});
