// Migration 501 sums FleetSuite's journal per customer or vendor for the
// report builder's rows by customer and vendor. This runs migrations 314,
// 359–363, 407, 500 and 501 in an in-memory Postgres (PGlite) as the app's
// server login, posts made-up invoices, their cost, bills, journal entries
// and typed entries with NetSuite's copy of the documents behind them and
// NetSuite's customer and vendor lists, a reversal in a later month among
// them, and holds what gl_books_party_totals returns: each line's customer
// or vendor by the migration's rules, the names, and the same sums as
// gl_books_split_totals for the months.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

/** Made-up chart, keyed by NetSuite id; Shop supplies is FleetSuite's own. */
const ACCOUNTS: Array<[string | null, string, string, string]> = [
  ['10', '1000', 'Checking', 'bank'],
  ['12', '1200', 'Receivables', 'accounts_receivable'],
  ['13', '1300', 'Inventory', 'other_current_asset'],
  ['20', '2000', 'Payables', 'accounts_payable'],
  ['40', '4000', 'Sales', 'income'],
  ['50', '5000', 'Cost of goods sold', 'cost_of_goods_sold'],
  ['65', '6500', 'Rent', 'expense'],
  ['66', '6600', 'Subcontractors', 'expense'],
  ['80', '8000', 'Other income', 'other_income'],
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
    -- What migrations 314, 407 and 501 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '407-books-own-invoices.sql',
    '500-books-report-builder.sql', '501-books-saved-reports.sql',
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
  // NetSuite's customers and vendors; 501 is an employee, on neither list.
  for (const [kind, id, name] of [
    ['customer', '301', 'Acme Fleet'], ['customer', '302', 'Bolt Rentals'], ['customer', '303', 'Cobalt Utility'],
    ['vendor', '401', 'Hitch Supply'], ['vendor', '402', 'Stripe Graphics'],
  ]) {
    await pg.query('INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES ($1, $2, $3, true)', [kind, id, name]);
  }
  return pg;
}

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;

interface Line {
  account: string;
  cents: number;
  division?: 'upfit' | 'graphics' | 'shared';
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
      ...(l.ref ? { source_line_ref: l.ref } : {}),
    })),
  })]);
};

/** NetSuite's copy of one document: its lines as [line id, NetSuite account, location or null, name or null]. */
async function copied(pg: PGlite, company: string, id: string, date: string, lines: Array<[string, string, string | null, string | null]>) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, 'CustInvc', $1, $2, date_trunc('month', $2::date)::date, 'hash', 'sweep')`,
    [id, date],
  );
  for (const [line, account, location, entity] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit,
                                      location_id, entity_id)
       VALUES ($1, $2, (SELECT id FROM gl_companies WHERE code = $6), $3, date_trunc('month', $4::date)::date, $4, 1, 0, $5, $7)`,
      [id, line, account, date, location, company, entity],
    );
  }
}

type PartyRow = {
  account: string; month: string; division: string | null; location: string | null; netsuite_location: string | null;
  party: string | null; debit: string; credit: string;
};
type Parties = { rows: PartyRow[]; names: Record<string, string> };

describe("migration 501's journal by customer and vendor", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();

    // Invoice 9101 for Acme: line 1 names it, line 2 names no one, and line 1 is at Wentzville (2).
    await copied(db, 'BMG', '9101', '2025-01-10', [['0', '12', null, '301'], ['1', '40', '2', '301'], ['2', '40', null, null]]);
    // Invoice 9102 for Bolt, reversed in February.
    await copied(db, 'BMG', '9102', '2025-01-20', [['0', '12', null, '302'], ['1', '40', null, '302']]);
    // Bill 7101 from Hitch Supply, its expense line naming Cobalt, the customer the job was for.
    await copied(db, 'BMG', '7101', '2025-01-15', [['0', '20', null, '401'], ['1', '66', null, '303']]);
    // Bill 7102 from Stripe Graphics: a line naming it, one naming an employee, one naming no one.
    await copied(db, 'BMG', '7102', '2025-02-12', [['0', '20', null, '402'], ['1', '66', null, '402'], ['2', '65', null, '501'], ['3', '66', null, null]]);
    // Journal entry 5101: an expense naming no one, payables for both vendors, receivables for Bolt.
    await copied(db, 'BMG', '5101', '2025-02-20', [['0', '65', null, null], ['1', '20', null, '401'], ['2', '20', null, '402'], ['3', '12', null, '302']]);
    // Invoice 9103 for Acme in March, on other income.
    await copied(db, 'BMG', '9103', '2025-03-05', [['0', '12', null, '301'], ['1', '80', null, '301']]);
    // 1084's invoice 9201 for Bolt.
    await copied(db, '1084', '9201', '2025-01-30', [['0', '12', null, '302'], ['1', '40', null, '302']]);
    // Journal entry 5102 in April: a line for each of two vendors and each of two customers, and the bank naming no one.
    await copied(db, 'BMG', '5102', '2025-04-10', [['0', '65', null, '401'], ['1', '66', null, '402'], ['2', '40', null, '301'], ['3', '40', null, '303'], ['4', '10', null, null]]);
    await db.exec('SET ROLE service_role');

    await post(db, 'BMG', '2025-01-10', { type: 'invoice', id: '9101' }, [
      { account: '1200', cents: 1500, ref: '0' },
      { account: '4000', cents: -1000, division: 'graphics', ref: '1' },
      { account: '4000', cents: -500, ref: '2' },
    ]);
    // Its cost, on a line NetSuite's copy doesn't have.
    await post(db, 'BMG', '2025-01-10', { type: 'invoice_cost', id: '9101' }, [
      { account: '5000', cents: 400, ref: '5' },
      { account: '1300', cents: -400, ref: '6' },
    ]);
    const bolt = await post(db, 'BMG', '2025-01-20', { type: 'invoice', id: '9102' }, [
      { account: '1200', cents: 2000, ref: '0' },
      { account: '4000', cents: -2000, ref: '1' },
    ]);
    await db.query('SELECT gl_reverse_entry($1::uuid, $2::date, NULL, NULL, NULL)', [bolt.id, '2025-02-03']);
    await post(db, 'BMG', '2025-01-15', { type: 'vendor_bill', id: '7101' }, [
      { account: '6600', cents: 700, ref: '1' },
      { account: '2000', cents: -700, ref: '0' },
    ]);
    await post(db, 'BMG', '2025-02-12', { type: 'vendor_bill', id: '7102' }, [
      { account: '6600', cents: 300, ref: '1' },
      { account: '6500', cents: 200, ref: '2' },
      { account: '6600', cents: 100, ref: '3' },
      { account: '2000', cents: -600, ref: '0' },
    ]);
    await post(db, 'BMG', '2025-02-20', { type: 'journal_entry', id: '5101' }, [
      { account: '6500', cents: 250, ref: '0' },
      { account: '2000', cents: -100, ref: '1' },
      { account: '2000', cents: -100, ref: '2' },
      { account: '1200', cents: -50, ref: '3' },
    ]);
    // Typed: shop supplies, no document.
    await post(db, 'BMG', '2025-02-01', { type: 'manual' }, [{ account: '6900', cents: 900 }, { account: '1000', cents: -900 }]);
    await post(db, 'BMG', '2025-03-05', { type: 'invoice', id: '9103' }, [
      { account: '1200', cents: 60, ref: '0' },
      { account: '8000', cents: -60, ref: '1' },
    ]);
    await post(db, '1084', '2025-01-30', { type: 'invoice', id: '9201' }, [
      { account: '1200', cents: 80, ref: '0' },
      { account: '4000', cents: -80, ref: '1' },
    ]);
    await post(db, 'BMG', '2025-04-10', { type: 'journal_entry', id: '5102' }, [
      { account: '6500', cents: 300, ref: '0' },
      { account: '6600', cents: 200, ref: '1' },
      { account: '4000', cents: -700, ref: '2' },
      { account: '4000', cents: -100, ref: '3' },
      { account: '1000', cents: 300, ref: '4' },
    ]);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const parties = (company: string, kind: string, from: string, to: string) =>
    one<Parties>(db, 'SELECT gl_books_party_totals($1, $2, $3::date, $4::date) AS r', [company, kind, from, to]);
  const row = (
    account: string, month: string, division: string | null, netsuite: string | null, party: string | null, cents: number,
  ): PartyRow => ({
    account, month, division, location: null, netsuite_location: netsuite, party,
    debit: cents > 0 ? money(cents) : '0.00', credit: cents < 0 ? money(cents) : '0.00',
  });

  it('files each line under the customer NetSuite names on it, else the one its document names', async () => {
    expect(await parties('BMG', 'customer', '2025-01-01', '2025-02-01')).toEqual({
      rows: [
        // The line NetSuite names Acme on, with its division and NetSuite's location.
        row('40', '2025-01-01', 'graphics', '2', '301', -1000),
        // A line naming no one, and a cost line NetSuite's copy doesn't have: the invoice's customer.
        row('40', '2025-01-01', null, '2', '301', -500),
        row('40', '2025-01-01', null, null, '302', -2000),
        // The reversal follows the invoice it reverses.
        row('40', '2025-02-01', null, null, '302', 2000),
        row('50', '2025-01-01', 'graphics', '2', '301', 400),
        // A journal entry's line naming no one: the one customer its lines name.
        row('65', '2025-02-01', null, null, '302', 250),
        // A bill names no customer, nor a line naming an employee.
        row('65', '2025-02-01', null, null, null, 200),
        // A bill's expense line naming a customer for the job.
        row('66', '2025-01-01', null, null, '303', 700),
        row('66', '2025-02-01', null, null, null, 400),
        // Typed, no document.
        row(SHOP, '2025-02-01', null, null, null, 900),
      ],
      names: { 301: 'Acme Fleet', 302: 'Bolt Rentals', 303: 'Cobalt Utility' },
    });
  });

  it('files each line under the vendor NetSuite names on it, else the one its document names', async () => {
    expect(await parties('BMG', 'vendor', '2025-01-01', '2025-02-01')).toEqual({
      rows: [
        row('40', '2025-01-01', 'graphics', '2', null, -1000),
        row('40', '2025-01-01', null, '2', null, -500),
        row('40', '2025-01-01', null, null, null, -2000),
        row('40', '2025-02-01', null, null, null, 2000),
        row('50', '2025-01-01', 'graphics', '2', null, 400),
        // A line naming an employee: the bill's vendor.
        row('65', '2025-02-01', null, null, '402', 200),
        // A journal entry naming two vendors: none.
        row('65', '2025-02-01', null, null, null, 250),
        // The expense line naming a customer keeps the bill's vendor.
        row('66', '2025-01-01', null, null, '401', 700),
        // A line naming the vendor and one naming no one.
        row('66', '2025-02-01', null, null, '402', 400),
        row(SHOP, '2025-02-01', null, null, null, 900),
      ],
      names: { 401: 'Hitch Supply', 402: 'Stripe Graphics' },
    });
  });

  it('files a line under the one NetSuite names on it when its document names more than one', async () => {
    expect(await parties('BMG', 'customer', '2025-04-01', '2025-04-01')).toEqual({
      rows: [
        row('40', '2025-04-01', null, null, '301', -700),
        row('40', '2025-04-01', null, null, '303', -100),
        // Lines naming a vendor, in a document naming two customers: none.
        row('65', '2025-04-01', null, null, null, 300),
        row('66', '2025-04-01', null, null, null, 200),
      ],
      names: { 301: 'Acme Fleet', 303: 'Cobalt Utility' },
    });
    expect(await parties('BMG', 'vendor', '2025-04-01', '2025-04-01')).toEqual({
      rows: [
        row('40', '2025-04-01', null, null, null, -800),
        row('65', '2025-04-01', null, null, '401', 300),
        row('66', '2025-04-01', null, null, '402', 200),
      ],
      names: { 401: 'Hitch Supply', 402: 'Stripe Graphics' },
    });
  });

  it('reads only the months asked for, and only the company asked for', async () => {
    const march = await parties('BMG', 'customer', '2025-03-01', '2025-03-01');
    expect(march).toEqual({ rows: [row('80', '2025-03-01', null, null, '301', -60)], names: { 301: 'Acme Fleet' } });
    const february = await parties('BMG', 'customer', '2025-02-01', '2025-02-01');
    expect(february.rows.map((r) => r.month)).toEqual(Array(5).fill('2025-02-01'));
    expect(february.names).toEqual({ 302: 'Bolt Rentals' });
    expect(await parties('1084', 'customer', '2025-01-01', '2025-03-01')).toEqual({
      rows: [row('40', '2025-01-01', null, null, '302', -80)],
      names: { 302: 'Bolt Rentals' },
    });
    expect(await parties('1084', 'vendor', '2025-01-01', '2025-03-01')).toEqual({ rows: [row('40', '2025-01-01', null, null, null, -80)], names: {} });
    expect(await parties('BMG', 'customer', '2024-12-01', '2024-12-01')).toEqual({ rows: [], names: {} });
    expect(await parties('NOPE', 'vendor', '2025-01-01', '2025-03-01')).toEqual({ rows: [], names: {} });
  });

  it("comes to gl_books_split_totals' sums for the months", async () => {
    for (const company of ['BMG', '1084']) {
      for (const kind of ['customer', 'vendor']) {
        for (const [from, to] of [['2025-01-01', '2025-04-01'], ['2025-02-01', '2025-02-01']]) {
          const key = (r: Omit<PartyRow, 'party'>) => [r.account, r.month, r.division, r.location, r.netsuite_location].join('|');
          const sums = new Map<string, number>();
          for (const r of (await parties(company, kind, from, to)).rows) {
            sums.set(key(r), (sums.get(key(r)) ?? 0) + Math.round(Number(r.debit) * 100) - Math.round(Number(r.credit) * 100));
          }
          const split = (await one<Array<Omit<PartyRow, 'party'>>>(db, 'SELECT gl_books_split_totals($1) AS r', [company]))
            .filter((r) => r.month >= from && r.month <= to);
          expect([company, kind, from, Object.fromEntries(sums)]).toEqual([company, kind, from, Object.fromEntries(split.map((r) => [
            key(r), Math.round(Number(r.debit) * 100) - Math.round(Number(r.credit) * 100),
          ]))]);
        }
      }
    }
  });

  it('is for the server login only', async () => {
    for (const f of ['gl_books_split_lines(text)', 'gl_books_split_totals(text)', 'gl_books_party_totals(text, text, date, date)']) {
      const can = async (role: string) => one<boolean>(db, `SELECT has_function_privilege($1, $2, 'EXECUTE') AS r`, [role, `public.${f}`]);
      expect([f, await can('anon'), await can('authenticated'), await can('service_role')]).toEqual([f, false, false, true]);
    }
  });
});
