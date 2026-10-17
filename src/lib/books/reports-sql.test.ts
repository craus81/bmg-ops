// Migration 396 sums FleetSuite's journal per account and month for the
// reports page. This runs migrations 359–362 and 396 in an in-memory
// Postgres (PGlite) as the app's server login, stores made-up NetSuite
// totals, posts FleetSuite entries for both companies, a reversal in a later
// month among them, and holds what gl_books_totals returns and what the
// reports make of it next to gl_netsuite_totals.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { report, reportMonths, type ReportAccount, type ReportAmount, type ReportData } from './reports';
import type { TbAmount } from './trial-balance';

/** Made-up chart, keyed by NetSuite id; Shop supplies is FleetSuite's own. */
const ACCOUNTS: Array<[string | null, string, string, string]> = [
  ['10', '1000', 'Checking', 'bank'],
  ['12', '1200', 'Receivables', 'accounts_receivable'],
  ['30', '3000', 'Owner capital', 'equity'],
  ['39', '3900', 'Retained Earnings', 'equity'],
  ['40', '4000', 'Sales', 'income'],
  ['65', '6500', 'Rent', 'expense'],
  [null, '6900', 'Shop supplies', 'expense'],
];
const accountId = (number: string) => `a0000000-0000-4000-8000-00000000${number}`;
const SHOP = `fs:${accountId('6900')}`;

async function freshDb(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  `);
  for (const file of [
    '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '396-books-reports.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  for (const [ns, number, name, type] of ACCOUNTS) {
    await pg.query(
      `INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, active) VALUES ($1, $2, $3, $4, $5, true)`,
      [accountId(number), number, name, type, ns],
    );
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;

/** A FleetSuite entry; lines are [account number, cents debit positive]. */
let entries = 0;
const post = (pg: PGlite, company: string, date: string, lines: Array<[string, number]>) => {
  entries += 1;
  return one<{ id: string }>(pg, 'SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify({
    company,
    entry_date: date,
    source_type: 'manual',
    posting_rule: 'manual',
    idempotency_key: `manual:${entries}`,
    lines: lines.map(([number, cents]) => ({ account_id: accountId(number), [cents > 0 ? 'debit' : 'credit']: money(cents) })),
  })]);
};

/** NetSuite's own totals for one company: [account, month or null for the start, cents debit positive]. */
const totals = (company: string, rows: Array<[string, string | null, number]>) => rows.map(([account, month, cents]) => ({
  company, netsuite_account_id: account, ...(month ? { month } : {}),
  debit: cents > 0 ? money(cents) : '0', credit: cents < 0 ? money(cents) : '0', line_count: 1,
}));

describe("migration 396's journal totals", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();

    // NetSuite: 1,000 in the bank, 600 of capital and 400 of earlier income
    // to start; a 500 sale in January, paid in February, and 100 of rent in March.
    const stored = [
      ...totals('BMG', [['10', null, 100000], ['30', null, -60000], ['40', null, -40000]]),
      ...totals('BMG', [['12', '2025-01-01', 50000], ['40', '2025-01-01', -50000], ['10', '2025-02-01', 50000], ['12', '2025-02-01', -50000],
        ['65', '2025-03-01', 10000], ['10', '2025-03-01', -10000]]),
      ...totals('1084', [['10', '2025-01-01', 5000], ['40', '2025-01-01', -5000]]),
    ];
    await db.query('SELECT gl_netsuite_store_totals($1::jsonb)', [JSON.stringify({
      opening: stored.filter((r) => !('month' in r)), months: stored.filter((r) => 'month' in r),
    })]);

    // FleetSuite: the same sale and payment, and a 200 sale in January it reversed on February 5.
    await post(db, 'BMG', '2025-01-10', [['1200', 50000], ['4000', -50000]]);
    const wrong = await post(db, 'BMG', '2025-01-20', [['1200', 20000], ['4000', -20000]]);
    await db.query('SELECT gl_reverse_entry($1::uuid, $2::date, NULL, NULL, NULL)', [wrong.id, '2025-02-05']);
    await post(db, 'BMG', '2025-02-12', [['1000', 50000], ['1200', -50000]]);
    // March: the rent, and shop supplies NetSuite has no account for.
    await post(db, 'BMG', '2025-03-03', [['6500', 10000], ['1000', -10000]]);
    await post(db, 'BMG', '2025-03-15', [['6900', 2500], ['1000', -2500]]);
    // 1084's own.
    await post(db, '1084', '2025-01-08', [['1000', 5000], ['4000', -5000]]);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const booksTotals = (company: string) => one<ReportAmount[]>(db, 'SELECT gl_books_totals($1) AS r', [company]);

  it("sums one company's journal per account and month, a reversal in the month it's dated", async () => {
    expect(await booksTotals('BMG')).toEqual([
      { account: '10', month: '2025-02-01', debit: '500.00', credit: '0.00' },
      { account: '10', month: '2025-03-01', debit: '0.00', credit: '125.00' },
      { account: '12', month: '2025-01-01', debit: '700.00', credit: '0.00' },
      { account: '12', month: '2025-02-01', debit: '0.00', credit: '700.00' },
      { account: '40', month: '2025-01-01', debit: '0.00', credit: '700.00' },
      { account: '40', month: '2025-02-01', debit: '200.00', credit: '0.00' },
      { account: '65', month: '2025-03-01', debit: '100.00', credit: '0.00' },
      { account: SHOP, month: '2025-03-01', debit: '25.00', credit: '0.00' },
    ]);
    expect(await booksTotals('1084')).toEqual([
      { account: '10', month: '2025-01-01', debit: '50.00', credit: '0.00' },
      { account: '40', month: '2025-01-01', debit: '0.00', credit: '50.00' },
    ]);
    expect(await booksTotals('NOPE')).toEqual([]);
  });

  it("puts FleetSuite's books next to NetSuite's totals in the reports", async () => {
    const nsTotals = await one<{ opening: TbAmount[]; netsuite: TbAmount[] }>(db, `SELECT gl_netsuite_totals('BMG') AS r`);
    const accounts = (await db.query<ReportAccount>(
      'SELECT id, netsuite_account_id, number, name, account_type, statement, parent_id FROM gl_accounts ORDER BY number',
    )).rows;
    const data: ReportData = { company: 'BMG', accounts, opening: nsTotals.opening, netsuite: nsTotals.netsuite, fleetsuite: await booksTotals('BMG') };
    const amount = (kind: 'profit_and_loss' | 'balance_sheet', month: string, label: string) =>
      report(data, kind, { to: month }).lines.filter((l) => l.label === label).map((l) => [l.fleetsuite, l.netsuite])[0];

    // January's sale is 200 more in FleetSuite until February's reversal.
    expect(amount('profit_and_loss', '2025-01-01', 'Sales')).toEqual([70000, 50000]);
    expect(amount('profit_and_loss', '2025-02-01', 'Sales')).toEqual([-20000, 0]);
    expect(report(data, 'profit_and_loss', { from: '2025-01-01', to: '2025-02-01' }).differing).toBe(0);
    // February's balance sheet matches: the start, earlier income in retained earnings, this year's as net income.
    const feb = report(data, 'balance_sheet', { to: '2025-02-01' });
    expect(feb.differing).toBe(0);
    expect(feb.lines.filter((l) => l.kind === 'account').map((l) => [l.label, l.fleetsuite, l.netsuite])).toEqual([
      ['Checking', 150000, 150000],
      ['Owner capital', 60000, 60000],
      ['Retained Earnings', 40000, 40000],
      ['Net income', 50000, 50000],
    ]);
    // March: the shop supplies only FleetSuite has.
    expect(amount('profit_and_loss', '2025-03-01', 'Shop supplies')).toEqual([2500, 0]);
    expect(amount('balance_sheet', '2025-03-01', 'Checking')).toEqual([137500, 140000]);
    expect(reportMonths(data, 'balance_sheet', '2025-03-01').map((m) => [m.month, m.differing])).toEqual([
      ['2025-01-01', 2], ['2025-02-01', 0], ['2025-03-01', 2],
    ]);
  });

  it("is the service role's alone", async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`RESET ROLE; SET ROLE ${role}`);
      await expect(db.query(`SELECT gl_books_totals('BMG')`)).rejects.toThrow(/permission denied for function gl_books_totals/);
    }
    await db.exec('RESET ROLE; SET ROLE service_role');
  });
});
