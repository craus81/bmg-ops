// Migration 500 sums FleetSuite's journal per account, month, division and
// location for the report builder. This runs migrations 359–362, 396 and
// 500 in an in-memory Postgres (PGlite) as the app's server login, posts
// made-up invoices, their cost, bills and typed entries with NetSuite's
// copy of the documents behind them, a reversal in a later month among
// them, and holds what gl_books_split_totals returns: each line's division
// and location by the migration's rules, and the same sums as
// gl_books_totals.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { revenueBucket } from '@/lib/division-revenue';
import type { ReportAmount } from './reports';

/** Made-up chart, keyed by NetSuite id; Shop supplies is FleetSuite's own. */
const ACCOUNTS: Array<[string | null, string, string, string]> = [
  ['10', '1000', 'Checking', 'bank'],
  ['12', '1200', 'Receivables', 'accounts_receivable'],
  ['13', '1300', 'Inventory', 'other_current_asset'],
  ['20', '2000', 'Payables', 'accounts_payable'],
  ['40', '4000', 'Sales', 'income'],
  ['42', '4200', 'Freight income', 'income'],
  ['50', '5000', 'Cost of goods sold', 'cost_of_goods_sold'],
  ['65', '6500', 'Rent', 'expense'],
  ['66', '6600', 'Subcontractors', 'expense'],
  [null, '6900', 'Shop supplies', 'expense'],
  ['80', '8000', 'Other income', 'other_income'],
  ['90', '9000', 'Other expense', 'other_expense'],
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
    '362-books-netsuite-gl-store-totals-where.sql', '396-books-reports.sql', '500-books-report-builder.sql',
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
  return pg;
}

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;

interface Line {
  account: string;
  cents: number;
  division?: 'upfit' | 'graphics' | 'shared';
  location?: string;
  item?: string;
  ref?: string;
}

/** A FleetSuite entry for a document (NetSuite's id) or typed; lines' cents are debit positive. */
let entries = 0;
const post = (pg: PGlite, company: string, date: string, doc: { type: string; id?: string }, lines: Line[]) => {
  entries += 1;
  return one<{ id: string }>(pg, 'SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify({
    company,
    entry_date: date,
    source_type: doc.type,
    ...(doc.id ? { source_id: doc.id } : {}),
    posting_rule: doc.type === 'manual' ? 'manual' : `${doc.type}@1`,
    idempotency_key: `${doc.type}:${entries}`,
    lines: lines.map((l) => ({
      account_id: accountId(l.account),
      [l.cents > 0 ? 'debit' : 'credit']: money(l.cents),
      ...(l.division ? { division: l.division } : {}),
      ...(l.location ? { location: l.location } : {}),
      ...(l.item ? { item_number: l.item } : {}),
      ...(l.ref ? { source_line_ref: l.ref } : {}),
    })),
  })]);
};

/** NetSuite's copy of one BMG document: its lines as [line id, NetSuite account, location or null]. */
async function copied(pg: PGlite, id: string, date: string, lines: Array<[string, string, string | null]>) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, 'CustInvc', $1, $2, date_trunc('month', $2::date)::date, 'hash', 'sweep')`,
    [id, date],
  );
  for (const [line, account, location] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, location_id)
       VALUES ($1, $2, (SELECT id FROM gl_companies WHERE code = 'BMG'), $3, date_trunc('month', $4::date)::date, $4, 1, 0, $5)`,
      [id, line, account, date, location],
    );
  }
}

describe("migration 500's journal split by division and location", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();

    // NetSuite's copy: invoice 9001 at Wentzville (2) but its first cost line
    // at Kansas City (3); invoice 9002 with no location of its own, its
    // lines at O'Fallon (1) and Kansas City; bill 7001's expense at Social Circle (5).
    await copied(db, '9001', '2025-01-10', [['0', '12', '2'], ['1', '40', '2'], ['2', '42', '2'], ['5', '50', '3']]);
    await copied(db, '9002', '2025-01-15', [['0', '12', null], ['1', '40', '1'], ['2', '40', '3']]);
    await copied(db, '7001', '2025-01-20', [['0', '20', null], ['1', '66', '5']]);
    // Invoice 9004's sale line at Wentzville; line 9 comes before line 10, at Social Circle. Bill 7002 all at Social Circle.
    await copied(db, '9004', '2025-01-28', [['0', '12', null], ['9', '80', '2'], ['10', '80', '5']]);
    await copied(db, '7002', '2025-02-10', [['0', '20', null], ['1', '66', '5'], ['2', '90', '5'], ['3', '66', '5']]);
    await db.exec('SET ROLE service_role');

    // Invoice 9001: all graphics, with freight the invoice rule gives no division.
    await post(db, 'BMG', '2025-01-10', { type: 'invoice', id: '9001' }, [
      { account: '1200', cents: 35000, ref: '0' },
      { account: '4000', cents: -30000, division: 'graphics', item: '06-1234', ref: '1' },
      { account: '4200', cents: -5000, item: 'FREIGHT', ref: '2' },
    ]);
    // Its cost: one line with no item, one for a shipping item.
    await post(db, 'BMG', '2025-01-10', { type: 'invoice_cost', id: '9001' }, [
      { account: '5000', cents: 12000, ref: '5' },
      { account: '5000', cents: 2000, item: 'SHIPPING CHARGE', ref: '6' },
      { account: '1300', cents: -14000, ref: '7' },
    ]);
    // Invoice 9002: upfit and graphics; reversed on February 5.
    const mixed = await post(db, 'BMG', '2025-01-15', { type: 'invoice', id: '9002' }, [
      { account: '1200', cents: 90000, ref: '0' },
      { account: '4000', cents: -60000, division: 'upfit', item: 'HITCH-1', ref: '1' },
      { account: '4000', cents: -30000, division: 'graphics', item: '3M VINYL', ref: '2' },
    ]);
    await post(db, 'BMG', '2025-01-15', { type: 'invoice_cost', id: '9002' }, [
      { account: '5000', cents: 20000, item: 'HITCH-1', ref: '7' },
      { account: '5000', cents: 5000, ref: '8' },
      { account: '1300', cents: -25000, ref: '9' },
    ]);
    await db.query('SELECT gl_reverse_entry($1::uuid, $2::date, NULL, NULL, NULL)', [mixed.id, '2025-02-05']);
    // Invoice 9003, which NetSuite's copy doesn't have yet: a sale line the invoice rule gave no division.
    await post(db, 'BMG', '2025-01-25', { type: 'invoice', id: '9003' }, [
      { account: '1200', cents: 7500, ref: '0' },
      { account: '4000', cents: -7500, item: 'PAYMENT ITEM', ref: '1' },
    ]);
    // Bill 7001 for a subcontractor.
    await post(db, 'BMG', '2025-01-20', { type: 'vendor_bill', id: '7001' }, [
      { account: '6600', cents: 40000, ref: '1' },
      { account: '2000', cents: -40000, ref: '0' },
    ]);
    // Invoice 9004: a graphics sale on another income account, at Kansas City by
    // FleetSuite's own key; its cost, a line NetSuite's copy doesn't have.
    await post(db, 'BMG', '2025-01-28', { type: 'invoice', id: '9004' }, [
      { account: '1200', cents: 4000, ref: '0' },
      { account: '8000', cents: -4000, division: 'graphics', location: 'kansascity', ref: '9' },
    ]);
    await post(db, 'BMG', '2025-01-28', { type: 'invoice_cost', id: '9004' }, [
      { account: '5000', cents: 1500, ref: '20' },
      { account: '1300', cents: -1500, ref: '21' },
    ]);
    // Bill 7002: a subcontractor line FleetSuite files as upfit, one it doesn't, and another expense for an item.
    await post(db, 'BMG', '2025-02-10', { type: 'vendor_bill', id: '7002' }, [
      { account: '6600', cents: 30000, division: 'upfit', ref: '1' },
      { account: '6600', cents: 10000, ref: '3' },
      { account: '9000', cents: 5000, item: 'HITCH-9', ref: '2' },
      { account: '2000', cents: -45000, ref: '0' },
    ]);
    // Typed: the rent, shared and at O'Fallon by its own key; shop supplies, neither.
    await post(db, 'BMG', '2025-02-03', { type: 'manual' }, [
      { account: '6500', cents: 100000, division: 'shared', location: 'ofallon' },
      { account: '1000', cents: -100000 },
    ]);
    await post(db, 'BMG', '2025-02-04', { type: 'manual' }, [{ account: '6900', cents: 2500 }, { account: '1000', cents: -2500 }]);
    // 1084's own.
    await post(db, '1084', '2025-01-08', { type: 'manual' }, [{ account: '1000', cents: 5000 }, { account: '4000', cents: -5000 }]);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const split = (company: string) => one<Array<ReportAmount & { division: string | null; location: string | null; netsuite_location: string | null }>>(
    db, 'SELECT gl_books_split_totals($1) AS r', [company],
  );
  const row = (account: string, month: string, division: string | null, location: string | null, netsuite: string | null, cents: number) => ({
    account, month, division, location, netsuite_location: netsuite,
    debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00',
  });

  it('files each income and expense line under its division and location', async () => {
    expect(await split('BMG')).toEqual([
      // Sale lines keep the invoice rule's division, each at its own NetSuite line's location.
      row('40', '2025-01-01', 'graphics', null, '2', -30000),
      row('40', '2025-01-01', 'graphics', null, '3', -30000),
      row('40', '2025-01-01', 'upfit', null, '1', -60000),
      // A sale line with no division stays without one, item or not; no copy, no location.
      row('40', '2025-01-01', null, null, null, -7500),
      // The reversal follows the invoice it reverses.
      row('40', '2025-02-01', 'graphics', null, '3', 30000),
      row('40', '2025-02-01', 'upfit', null, '1', 60000),
      row('42', '2025-01-01', null, null, '2', -5000),
      // Cost with no item and no line of its own in NetSuite's copy: its invoice's division (the sale on
      // another income account), at the invoice's first line with a location, by number.
      row('50', '2025-01-01', 'graphics', null, '2', 1500),
      // Cost with no item: its invoice's division, at the NetSuite line it copies.
      row('50', '2025-01-01', 'graphics', null, '3', 12000),
      // Cost with an item: the item's division, at the invoice's first line with a location.
      row('50', '2025-01-01', 'upfit', null, '1', 20000),
      // Cost with no item on an invoice of both divisions; a shipping item's on an all-graphics one.
      row('50', '2025-01-01', null, null, '1', 5000),
      row('50', '2025-01-01', null, null, '2', 2000),
      // A typed line's own division and location key.
      row('65', '2025-02-01', 'shared', 'ofallon', null, 100000),
      // A bill's expense has no sale lines to follow: it keeps its own division, or has none.
      row('66', '2025-01-01', null, null, '5', 40000),
      row('66', '2025-02-01', 'upfit', null, '5', 30000),
      row('66', '2025-02-01', null, null, '5', 10000),
      // A line with a location of its own has none of NetSuite's.
      row('80', '2025-01-01', 'graphics', 'kansascity', null, -4000),
      // Another expense takes its item's division.
      row('90', '2025-02-01', 'upfit', null, '5', 5000),
      row(SHOP, '2025-02-01', null, null, null, 2500),
    ]);
    expect(await split('1084')).toEqual([row('40', '2025-01-01', null, null, null, -5000)]);
    expect(await split('NOPE')).toEqual([]);
  });

  it("comes to gl_books_totals' sums on every income and expense account", async () => {
    const statement = new Set(['40', '42', '50', '65', '66', '80', '90', SHOP]);
    for (const company of ['BMG', '1084']) {
      const totals = (await one<ReportAmount[]>(db, 'SELECT gl_books_totals($1) AS r', [company])).filter((t) => statement.has(t.account));
      const sums = new Map<string, number>();
      for (const s of await split(company)) {
        const key = `${s.account}|${s.month}`;
        sums.set(key, (sums.get(key) ?? 0) + Math.round(Number(s.debit) * 100) - Math.round(Number(s.credit) * 100));
      }
      expect(Object.fromEntries(sums)).toEqual(Object.fromEntries(totals.map((t) => [
        `${t.account}|${t.month}`, Math.round(Number(t.debit) * 100) - Math.round(Number(t.credit) * 100),
      ])));
    }
  });

  it("files an item number under the division revenueBucket gives it", async () => {
    const items = [
      '3M VINYL', ' 3m vinyl ', 'Graphics Install Labor', 'graphics removal', '06', '0612-B', 'Masterack : 06-555',
      'PARENT:CHILD-06', 'Parts:Graphics:06-77', 'X06', 'HITCH-1', 'FREIGHT IN', 'UPS Shipping', 'parts:', '', null,
    ];
    for (const item of items) {
      const bucket = revenueBucket(item, null);
      const expected = bucket === 'upfit' || bucket === 'graphics' ? bucket : null;
      expect([item, await one<string | null>(db, 'SELECT gl_item_division($1) AS r', [item])]).toEqual([item, expected]);
    }
  });

  it('is for the server login only', async () => {
    for (const f of ['gl_item_division(text)', 'gl_books_split_totals(text)']) {
      const can = async (role: string) => one<boolean>(db, `SELECT has_function_privilege($1, $2, 'EXECUTE') AS r`, [role, `public.${f}`]);
      expect([f, await can('anon'), await can('authenticated'), await can('service_role')]).toEqual([f, false, false, true]);
    }
  });
});
