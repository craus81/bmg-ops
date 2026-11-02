// Migration 504 switches Financials on FleetSuite's books off, a twentieth
// books switch, and sums what customers paid in one company's books between
// two days for Home Financials' Collections: the money side of each customer
// payment and customer deposit, by entry date, a reversal counting against
// what it reverses. This runs migrations 359 and 504 in an in-memory
// Postgres (PGlite) as the app's server login, over made-up payments,
// deposits and other entries in both companies, and holds what
// gl_books_collections returns.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { SWITCH_PIECES } from './switches';

const PIECES = [
  'credit_memos', 'vendor_credits', 'card_charges', 'journal_entries', 'inventory_transfers', 'invoice_fixes', 'bill_fixes',
  'customer_vendor_details', 'item_accounts', 'estimates_in_fleetsuite', 'fleetsuite_records', 'customer_payments',
  'customer_deposits', 'bank_deposits', 'vendor_payments', 'adjustment_approvals', 'own_numbers', 'invoice_pdfs', 'stock_counts',
];

/** Made-up chart: [number, account type]. */
const ACCOUNTS: Array<[string, string]> = [
  ['1000', 'bank'],
  ['1100', 'other_current_asset'],
  ['1200', 'accounts_receivable'],
  ['2400', 'other_current_liability'],
  ['4000', 'income'],
  ['4900', 'income'],
];
const accountId = (number: string) => `a0000000-0000-4000-8000-00000000${number}`;

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
    -- What migration 504 points at, as the earlier migrations leave it.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.books_switches (
      piece TEXT PRIMARY KEY CHECK (piece IN (${PIECES.map((p) => `'${p}'`).join(', ')})),
      is_on BOOLEAN NOT NULL DEFAULT false,
      changed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
      changed_at TIMESTAMPTZ
    );
  `);
  await pg.query("INSERT INTO books_switches (piece, is_on) VALUES ('credit_memos', true), ('stock_counts', false)");
  for (const file of ['359-books-ledger-core.sql', '504-books-money-screens.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  for (const [number, type] of ACCOUNTS) {
    await pg.query('INSERT INTO gl_accounts (id, number, name, account_type, active) VALUES ($1, $2, $3, $4, true)',
      [accountId(number), number, `Account ${number}`, type]);
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;

/** A posted entry: lines are [account number, cents debit positive, the line's ref]. */
let posted = 0;
const post = (pg: PGlite, company: string, date: string, sourceType: string, sourceId: string, lines: Array<[string, number, string | null]>) => {
  posted += 1;
  return one<{ id: string }>(pg, 'SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify({
    company,
    entry_date: date,
    source_type: sourceType,
    source_id: sourceId,
    posting_rule: `${sourceType}@1`,
    idempotency_key: `${sourceType}:${sourceId}:${posted}`,
    lines: lines.map(([number, cents, ref]) => ({
      account_id: accountId(number), [cents > 0 ? 'debit' : 'credit']: (Math.abs(cents) / 100).toFixed(2), source_line_ref: ref,
    })),
  })]);
};
const reverse = (pg: PGlite, id: string, date: string) => pg.query('SELECT gl_reverse_entry($1::uuid, $2::date, NULL, NULL, NULL)', [id, date]);

/** A customer payment as payment@1 posts it: the money to `to`, a discount, the receivable for both. */
const payment = (pg: PGlite, company: string, date: string, id: string, cents: number, to = '1100', discount = 0) =>
  post(pg, company, date, 'payment', id, [
    [to, cents, 'deposit'],
    ...(discount ? [['4900', discount, 'discount'] as [string, number, string]] : []),
    ['1200', -(cents + discount), 'receivable'],
  ]);

const collections = (pg: PGlite, company: string, from: string, to: string) =>
  one<{ total: string; count: number }>(pg, 'SELECT gl_books_collections($1, $2::date, $3::date) AS r', [company, from, to]);

describe('migration 504: the switch', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db.close(); });

  it("adds Financials on FleetSuite's books, off, and keeps every earlier piece as it was", async () => {
    expect((await db.query('SELECT piece, is_on FROM books_switches ORDER BY piece')).rows).toEqual([
      { piece: 'credit_memos', is_on: true },
      { piece: 'money_screens', is_on: false },
      { piece: 'stock_counts', is_on: false },
    ]);
    // Every piece the app named then is one the column takes, and nothing else is (505 adds portal billing).
    const then = SWITCH_PIECES.filter((piece) => piece !== 'portal_books');
    expect(then).toEqual([...PIECES, 'money_screens']);
    for (const piece of then) {
      await db.query('INSERT INTO books_switches (piece) VALUES ($1) ON CONFLICT (piece) DO NOTHING', [piece]);
    }
    expect((await db.query('SELECT count(*)::int AS n FROM books_switches')).rows[0]).toEqual({ n: 20 });
    await expect(db.query("INSERT INTO books_switches (piece) VALUES ('money_screen')")).rejects.toThrow('books_switches_piece_check');
  });
});

describe('migration 504: collections', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // October: a payment to Undeposited Funds, one to the bank with a discount taken, a deposit, and the deposit applied.
    await payment(db, 'BMG', '2026-10-03', '501', 30000);
    await payment(db, 'BMG', '2026-10-15', '502', 49000, '1000', 1000);
    await post(db, 'BMG', '2026-10-20', 'customer_deposit', '601', [['1100', 100000, 'money'], ['2400', -100000, 'deposits']]);
    await post(db, 'BMG', '2026-10-25', 'deposit_application', '602', [['2400', 100000, 'deposits'], ['1200', -100000, 'receivable']]);
    // A payment changed in NetSuite: posted at 200, reversed and posted again at 250.
    const changed = await payment(db, 'BMG', '2026-10-28', '503', 20000);
    await reverse(db, changed.id, '2026-10-28');
    await payment(db, 'BMG', '2026-10-28', '503', 25000);
    // One deleted in the month, and one deleted the month after.
    const deleted = await payment(db, 'BMG', '2026-10-10', '504', 8000);
    await reverse(db, deleted.id, '2026-10-12');
    const later = await payment(db, 'BMG', '2026-10-05', '505', 4000);
    await reverse(db, later.id, '2026-11-03');
    // The last day of October and the days either side.
    await payment(db, 'BMG', '2026-10-31', '506', 12000);
    await payment(db, 'BMG', '2026-11-01', '507', 7500);
    await payment(db, 'BMG', '2026-09-30', '508', 6000);
    // A $0 payment that only applied a credit has no money line.
    await post(db, 'BMG', '2026-10-16', 'payment', '509', [['4900', 500, 'discount'], ['1200', -500, 'receivable']]);
    // Money lines on what isn't a payment or a deposit: an invoice, a bank deposit and a journal entry.
    await post(db, 'BMG', '2026-10-04', 'invoice', '701', [['1200', 90000, 'receivable'], ['4000', -90000, 'line-1']]);
    await post(db, 'BMG', '2026-10-21', 'bank_deposit', '801', [['1000', 100000, 'deposit'], ['1100', -100000, 'money']]);
    await post(db, 'BMG', '2026-10-22', 'journal_entry', '901', [['1100', 1500, 'money'], ['4000', -1500, 'deposit']]);
    // 1084's own.
    await payment(db, '1084', '2026-10-07', '511', 150000, '1000');
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  it('sums the money each payment and deposit brought in, by entry date, and counts them', async () => {
    // 300 + 490 + 1,000 + 250 + 40 + 120; the deleted payment and the deposit applied count nothing.
    expect(await collections(db, 'BMG', '2026-10-01', '2026-10-31')).toEqual({ total: '2200.00', count: 6 });
    expect(await collections(db, 'BMG', '2026-10-03', '2026-10-03')).toEqual({ total: '300.00', count: 1 });
    expect(await collections(db, 'BMG', '2026-10-31', '2026-11-01')).toEqual({ total: '195.00', count: 2 });
    expect(await collections(db, 'BMG', '2026-09-30', '2026-09-30')).toEqual({ total: '60.00', count: 1 });
  });

  it("takes a payment reversed later off the month it's reversed in, without counting it", async () => {
    expect(await collections(db, 'BMG', '2026-11-01', '2026-11-30')).toEqual({ total: '35.00', count: 1 });
    expect(await collections(db, 'BMG', '2026-11-02', '2026-11-30')).toEqual({ total: '-40.00', count: 0 });
  });

  it("reads one company's books, and nothing for one that isn't there or days with nothing", async () => {
    expect(await collections(db, '1084', '2026-10-01', '2026-10-31')).toEqual({ total: '1500.00', count: 1 });
    expect(await collections(db, 'NOPE', '2026-10-01', '2026-10-31')).toEqual({ total: '0.00', count: 0 });
    expect(await collections(db, 'BMG', '2026-12-01', '2026-12-31')).toEqual({ total: '0.00', count: 0 });
    expect(await collections(db, 'BMG', '2026-10-31', '2026-10-01')).toEqual({ total: '0.00', count: 0 });
  });

  it('is the server login’s alone', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`RESET ROLE; SET ROLE ${role}`);
      try {
        await expect(collections(db, 'BMG', '2026-10-01', '2026-10-31')).rejects.toThrow('permission denied for function gl_books_collections');
      } finally {
        await db.exec('RESET ROLE; SET ROLE service_role');
      }
    }
  });
});
