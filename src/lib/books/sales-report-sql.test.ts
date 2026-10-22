// Migration 426 sums NetSuite's ledger lines on income accounts for Books →
// Sales by location. This runs migrations 359–363 and 426 in an in-memory
// Postgres (PGlite) as the app's server login, copies made-up NetSuite lines
// for both companies, and holds what gl_sales_lines returns for a range of
// months and what the report makes of it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { salesReport, type SalesLine } from './sales-report';

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
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '426-books-sales-report.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`
    INSERT INTO gl_accounts (number, name, account_type, netsuite_account_id, active) VALUES
      ('1200', 'Receivables', 'accounts_receivable', '12', true),
      ('4000', 'Installation Income', 'income', '40', true),
      ('4900', 'Freight Income', 'income', '49', true),
      ('7000', 'Interest Income', 'other_income', '70', true);
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES
      ('location', '1', 'O''Fallon', true), ('location', '5', 'Social Circle', true),
      ('class', '7', 'Upfit', true);
  `);
  return pg;
}

let tx = 0;
/** One NetSuite transaction; lines are [account, cents debit positive, location, class]. */
async function copy(pg: PGlite, company: string, type: string, date: string, lines: Array<[string, number, string | null, string | null]>) {
  tx += 1;
  const id = String(1000 + tx);
  const month = `${date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 'test')`,
    [id, type, `${type}${tx}`, date, month],
  );
  let n = 0;
  for (const [account, cents, location, klass] of lines) {
    n += 1;
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, location_id, class_id)
       VALUES ($1, $2, (SELECT id FROM gl_companies WHERE code = $3), $4, $5, $6, $7, $8, $9, $10)`,
      [id, String(n), company, account, month, date, cents > 0 ? cents / 100 : 0, cents < 0 ? -cents / 100 : 0, location, klass],
    );
  }
}

describe("migration 426's sales lines", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // In range: an O'Fallon invoice with freight and a discount line, a Social Circle invoice, a credit memo.
    await copy(db, 'BMG', 'CustInvc', '2025-09-10', [['12', 104000, null, null], ['40', -100000, '1', '7'], ['40', 2000, '1', '7'], ['49', -6000, '1', null]]);
    await copy(db, 'BMG', 'CustInvc', '2026-08-31', [['12', 30000, null, null], ['40', -30000, '5', '7']]);
    await copy(db, 'BMG', 'CustCred', '2026-01-15', [['40', 10000, '1', '7'], ['12', -10000, null, null]]);
    // Interest isn't sales; 1084's lines and lines outside the months aren't counted.
    await copy(db, 'BMG', 'Deposit', '2026-02-01', [['70', -500, null, null], ['12', 500, null, null]]);
    await copy(db, '1084', 'CustInvc', '2026-03-01', [['40', -99900, '1', '7'], ['12', 99900, null, null]]);
    await copy(db, 'BMG', 'CustInvc', '2025-08-31', [['40', -77700, '1', '7'], ['12', 77700, null, null]]);
    await copy(db, 'BMG', 'CustInvc', '2026-09-01', [['40', -88800, '1', '7'], ['12', 88800, null, null]]);
    await db.exec('SET ROLE service_role');
  });
  afterAll(async () => { await db?.close(); });

  const read = async (company: string, from: string, to: string) => (await db.query<{ r: SalesLine[] }>(
    'SELECT gl_sales_lines($1, $2::date, $3::date) AS r', [company, from, to],
  )).rows[0].r;

  it("sums the company's income lines for the months, with names", async () => {
    const lines = await read('BMG', '2025-09-01', '2026-08-01');
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.account === '40' || l.account === '49')).toBe(true);
    expect(lines.find((l) => l.tran_type === 'CustInvc' && l.location === 'Social Circle')).toMatchObject({ class: 'Upfit', credit: '300.00', lines: 1 });
    expect(lines.find((l) => l.account === '40' && l.location === "O'Fallon" && l.tran_type === 'CustInvc'))
      .toMatchObject({ account_name: 'Installation Income', debit: '20.00', credit: '1000.00', lines: 2 });
  });

  it('makes a report whose net is the income for the months', async () => {
    const report = salesReport(await read('BMG', '2025-09-01', '2026-08-01'));
    expect(report.total).toEqual({ gross: 130000, returns: -10000, discounts: -2000, transportation: 6000, other: 0, net: 124000 });
    expect(report.states.map((s) => [s.state, s.net])).toEqual([['GA', 30000], ['MO', 94000]]);
  });

  it('is refused to the browser logins', async () => {
    await db.exec('RESET ROLE; SET ROLE authenticated');
    await expect(read('BMG', '2025-09-01', '2026-08-01')).rejects.toThrow(/permission denied/);
    await db.exec('RESET ROLE; SET ROLE service_role');
  });
});
