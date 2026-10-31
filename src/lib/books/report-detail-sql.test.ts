// Migration 400 lists the documents behind one account's line on Reports,
// and 460 lets the Excel download take up to 20,000 of them at once. This
// runs migrations 314 and 359–363 with 396, 400 and 460 in an in-memory
// Postgres (PGlite) as the app's server login, copies a made-up NetSuite
// general ledger for both companies, posts FleetSuite's own entries for it
// (a replaced entry, a typed entry, one reversed in the same month among
// them), and holds what gl_books_account_documents returns.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { toCents } from './netsuite-gl';
import { detailDocuments, type AccountDocumentData, type AccountDocumentsData } from './report-detail';
import type { ReportAmount } from './reports';

const JUL = '2026-07-01';
const AUG = '2026-08-01';
const SEP = '2026-09-01';
const OCT = '2026-10-01';

/** Made-up chart, keyed by NetSuite id; Shop supplies is FleetSuite's own. */
const ACCOUNTS: Array<[string | null, string, string, string]> = [
  ['110', '1100', 'Checking', 'bank'],
  ['120', '1200', 'Receivables', 'accounts_receivable'],
  ['200', '2000', 'Payables', 'accounts_payable'],
  ['400', '4000', 'Sales', 'income'],
  ['600', '6000', 'Rent', 'expense'],
  [null, '6900', 'Shop supplies', 'expense'],
];
const accountId = (number: string) => `a0000000-0000-4000-8000-00000000${number}`;
const NS_ACCOUNT: Record<string, string> = Object.fromEntries(ACCOUNTS.filter(([ns]) => ns).map(([ns, number]) => [ns!, number]));
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
    -- What migration 314 points at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '396-books-reports.sql', '400-books-report-detail.sql',
    '460-books-account-documents-download.sql',
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
  // Names: a vendor from the copy of NetSuite's lists, a customer from the ledger mirror.
  await pg.exec(`
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES ('vendor', '7001', 'Landlord LLC', true);
    INSERT INTO ledger_customers (source, external_id, external_ref, display_name, cleaned_name)
      VALUES ('netsuite', 'customer/9001', '9001', 'Acme Fleet', 'acme fleet');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;

type CopyLine = [line: string, company: string, account: string, cents: number, extra?: { entity?: string; memo?: string }];

/** A NetSuite transaction as the GL copy keeps it; lines are [line id, company, account, cents debit positive, name and memo]. */
async function copyTxn(pg: PGlite, id: string, type: string, number: string, date: string, month: string, lines: CopyLine[]) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [id, type, number, date, month],
  );
  for (const [line, company, account, cents, extra] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, entity_id, memo)
       SELECT $1, $2, id, $3, $4, $5, $6, $7, $8, $9 FROM gl_companies WHERE code = $10`,
      [id, line, account, month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0', extra?.entity ?? null, extra?.memo ?? null, company],
    );
  }
}

/** A FleetSuite entry; lines are [NetSuite account or FleetSuite's own number, cents debit positive]. */
let keys = 0;
const post = (pg: PGlite, p: { company?: string; kind: string; id: string | null; date: string; memo?: string; lines: Array<[string, number]> }) => {
  keys += 1;
  return one<{ id: string }>(pg, 'SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify({
    company: p.company ?? 'BMG',
    entry_date: p.date,
    source_type: p.kind,
    source_id: p.id,
    posting_rule: p.kind === 'manual' ? 'manual' : `${p.kind}@1`,
    idempotency_key: `${p.kind}:${p.id ?? 'typed'}:${keys}`,
    memo: p.memo ?? null,
    lines: p.lines.map(([account, cents]) => ({
      account_id: accountId(NS_ACCOUNT[account] ?? account), [cents > 0 ? 'debit' : 'credit']: money(cents),
    })),
  })]);
};
const reverse = (pg: PGlite, entryId: string, date: string) =>
  pg.query('SELECT gl_reverse_entry($1::uuid, $2::date, NULL, NULL, NULL)', [entryId, date]);

describe("migration 400's account documents", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();

    // NetSuite. INV1000 in August; in September INV1001 and the payment for
    // it match FleetSuite's, INV1002 FleetSuite replaced with a smaller one,
    // INV1004 FleetSuite hasn't posted, and an expense report is of a kind it
    // doesn't post; INV1003 is dated September 30 but NetSuite posted it to
    // October. 1084 has an invoice of its own.
    const acme = { entity: '9001' };
    await copyTxn(db, '1000', 'CustInvc', 'INV1000', '2026-08-28', AUG, [['0', 'BMG', '120', 10000, acme], ['1', 'BMG', '400', -10000, acme]]);
    await copyTxn(db, '1001', 'CustInvc', 'INV1001', '2026-09-03', SEP, [
      ['0', 'BMG', '120', 50000, acme], ['1', 'BMG', '400', -30000, { ...acme, memo: 'Upfit labor' }], ['2', 'BMG', '400', -20000, { ...acme, memo: 'Shelving' }],
    ]);
    await copyTxn(db, '1002', 'CustInvc', 'INV1002', '2026-09-10', SEP, [['0', 'BMG', '120', 30000, acme], ['1', 'BMG', '400', -30000, acme]]);
    await copyTxn(db, '1003', 'CustInvc', 'INV1003', '2026-09-30', OCT, [['0', 'BMG', '120', 80000, acme], ['1', 'BMG', '400', -80000, acme]]);
    await copyTxn(db, '1004', 'CustInvc', 'INV1004', '2026-09-12', SEP, [['0', 'BMG', '120', 25000, acme], ['1', 'BMG', '400', -25000, acme]]);
    await copyTxn(db, '2001', 'CustPymt', 'PMT2001', '2026-09-18', SEP, [['0', 'BMG', '110', 50000, acme], ['1', 'BMG', '120', -50000, acme]]);
    await copyTxn(db, '3001', 'ExpRept', 'EXP3001', '2026-09-19', SEP, [
      ['0', 'BMG', '200', -50000, { entity: '7001' }], ['1', 'BMG', '600', 50000, { entity: '7001', memo: 'September rent' }],
    ]);
    await copyTxn(db, '1006', 'CustInvc', 'INV1006', '2026-09-14', SEP, [['0', '1084', '120', 60000], ['1', '1084', '400', -60000]]);

    // FleetSuite.
    await post(db, { kind: 'invoice', id: '1000', date: '2026-08-28', lines: [['120', 10000], ['400', -10000]] });
    await post(db, { kind: 'invoice', id: '1001', date: '2026-09-03', memo: 'INV1001', lines: [['120', 50000], ['400', -50000]] });
    const first = await post(db, { kind: 'invoice', id: '1002', date: '2026-09-10', lines: [['120', 30000], ['400', -30000]] });
    await reverse(db, first.id, '2026-09-10');
    await post(db, { kind: 'invoice', id: '1002', date: '2026-09-10', lines: [['120', 25000], ['400', -25000]] });
    await post(db, { kind: 'invoice', id: '1003', date: '2026-09-30', lines: [['120', 80000], ['400', -80000]] });
    await post(db, { kind: 'payment', id: '2001', date: '2026-09-18', lines: [['110', 50000], ['120', -50000]] });
    // A typed entry for shop towels, and one for rent typed by mistake and reversed two days later.
    await post(db, { kind: 'manual', id: null, date: '2026-09-21', memo: 'Shop towels', lines: [['6900', 2500], ['110', -2500]] });
    const typo = await post(db, { kind: 'manual', id: null, date: '2026-09-22', memo: 'Rent', lines: [['600', 10000], ['110', -10000]] });
    await reverse(db, typo.id, '2026-09-24');
    await post(db, { company: '1084', kind: 'invoice', id: '1006', date: '2026-09-14', lines: [['120', 60000], ['400', -60000]] });
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const documents = (account: string, from: string, to: string, opts: { company?: string; differs?: boolean; limit?: number } = {}) =>
    one<AccountDocumentsData>(db, 'SELECT gl_books_account_documents($1, $2, $3::date, $4::date, $5, $6) AS r', [
      opts.company ?? 'BMG', account, from, to, opts.differs ?? false, opts.limit ?? 100,
    ]);
  const brief = (rows: AccountDocumentData[]) => rows.map((r) => [r.number ?? r.doc.slice(0, 6), r.date, r.netsuite, r.fleetsuite]);

  it('lists every document on the account in the month, both sides, by date', async () => {
    const found = await documents('120', SEP, SEP);
    expect(brief(found.rows)).toEqual([
      ['INV1001', '2026-09-03', '500.00', '500.00'],
      // Replaced: the first entry and its reversal net out, the second stands.
      ['INV1002', '2026-09-10', '300.00', '250.00'],
      ['INV1004', '2026-09-12', '250.00', '0'],
      ['PMT2001', '2026-09-18', '-500.00', '-500.00'],
      // FleetSuite's September, NetSuite's October.
      ['INV1003', '2026-09-30', '0', '800.00'],
    ]);
    expect(found).toMatchObject({ documents: 5, differing: 3, netsuite: '550.00', fleetsuite: '1050.00' });
    expect(found.rows.find((r) => r.number === 'INV1002')).toMatchObject({ kind: 'invoice', type: 'CustInvc', month: SEP, entries: 3 });
    expect(found.rows.find((r) => r.number === 'INV1004')).toMatchObject({ kind: null, type: 'CustInvc', entries: 0, entry_no: null });
    // The month NetSuite posted it to, though it's listed in FleetSuite's.
    expect(found.rows.find((r) => r.number === 'INV1003')).toMatchObject({ kind: 'invoice', month: OCT });
  });

  it('covers the months from `from` through `to`, each side in its own month', async () => {
    expect(brief((await documents('120', OCT, OCT)).rows)).toEqual([['INV1003', '2026-09-30', '800.00', '0']]);
    const both = await documents('120', AUG, SEP);
    expect(brief(both.rows)[0]).toEqual(['INV1000', '2026-08-28', '100.00', '100.00']);
    expect(both).toMatchObject({ documents: 6, netsuite: '650.00', fleetsuite: '1150.00' });
    expect(await documents('120', '2026-11-01', '2026-12-01')).toEqual({ documents: 0, differing: 0, netsuite: '0', fleetsuite: '0', rows: [] });
  });

  it('lists only the documents that differ with p_differs, and at most p_limit, the counts still of all', async () => {
    const differing = await documents('120', SEP, SEP, { differs: true });
    expect(differing.rows.map((r) => r.number)).toEqual(['INV1002', 'INV1004', 'INV1003']);
    expect(differing).toMatchObject({ documents: 5, differing: 3 });
    const two = await documents('120', SEP, SEP, { limit: 2 });
    expect(two.rows.map((r) => r.number)).toEqual(['INV1001', 'INV1002']);
    expect(two).toMatchObject({ documents: 5, differing: 3, netsuite: '550.00', fleetsuite: '1050.00' });
  });

  it("names each document from the account's own line, else the document's, with the first memo on the account", async () => {
    const sales = await documents('400', SEP, SEP);
    expect(sales.rows.find((r) => r.number === 'INV1001')).toMatchObject({ name: 'Acme Fleet', memo: 'Upfit labor', netsuite: '-500.00' });
    // A document NetSuite booked to another month still has its name.
    expect(sales.rows.find((r) => r.number === 'INV1003')).toMatchObject({ name: 'Acme Fleet', netsuite: '0' });
    // A vendor, on a kind of document FleetSuite doesn't post.
    expect((await documents('600', SEP, SEP)).rows).toEqual([expect.objectContaining({
      number: 'EXP3001', type: 'ExpRept', kind: null, name: 'Landlord LLC', memo: 'September rent', netsuite: '500.00', fleetsuite: '0',
    })]);
  });

  it("keeps FleetSuite's typed entries as documents of their own, and leaves out one reversed in the range", async () => {
    const checking = await documents('110', SEP, SEP);
    expect(brief(checking.rows)).toEqual([['PMT2001', '2026-09-18', '500.00', '500.00'], [expect.stringMatching(/^entry:/), '2026-09-21', '0', '-25.00']]);
    expect(checking.rows[1]).toMatchObject({ kind: 'manual', type: null, number: null, name: null, memo: 'Shop towels', entries: 1 });
    expect(checking.rows[1].entry_no).toEqual(expect.any(Number));
    // The rent typed by mistake and reversed moves nothing in September.
    expect((await documents('600', SEP, SEP)).rows.map((r) => r.number)).toEqual(['EXP3001']);
    // An account NetSuite doesn't have holds FleetSuite's side alone.
    expect((await documents(SHOP, SEP, SEP)).rows).toEqual([expect.objectContaining({ kind: 'manual', netsuite: '0', fleetsuite: '25.00' })]);
  });

  it("keeps each company's documents its own", async () => {
    expect((await documents('120', SEP, SEP)).rows.some((r) => r.number === 'INV1006')).toBe(false);
    expect(brief((await documents('120', SEP, SEP, { company: '1084' })).rows)).toEqual([['INV1006', '2026-09-14', '600.00', '600.00']]);
    expect((await documents('120', SEP, SEP, { company: 'NOPE' })).rows).toEqual([]);
  });

  it("comes to what gl_books_totals sums for the account, so a line's documents add up to it", async () => {
    const totals = await one<ReportAmount[]>(db, 'SELECT gl_books_totals($1) AS r', ['BMG']);
    for (const account of ['110', '120', '400', '600', SHOP]) {
      const summed = totals.filter((t) => t.account === account && t.month === SEP)
        .reduce((s, t) => s + toCents(t.debit) - toCents(t.credit), 0);
      const found = await documents(account, SEP, SEP);
      expect(toCents(found.fleetsuite), account).toBe(summed);
      expect(found.rows.reduce((s, r) => s + toCents(r.fleetsuite), 0), account).toBe(summed);
    }
  });

  it('gives the detail page what it shows: amounts as the line shows them, each document named and linked to its check', async () => {
    const shown = detailDocuments(await documents('400', SEP, SEP), -1);
    expect(shown.map((d) => [d.type, d.number, d.fleetsuite, d.netsuite, d.only, d.check])).toEqual([
      ['Invoice', 'INV1001', 50000, 50000, null, { kind: 'invoice', month: SEP }],
      ['Invoice', 'INV1002', 25000, 30000, null, { kind: 'invoice', month: SEP }],
      ['Invoice', 'INV1004', 0, 25000, 'netsuite', { kind: 'invoice', month: SEP }],
      // Invoices vs NetSuite lists an invoice under the month NetSuite posted it to.
      ['Invoice', 'INV1003', 80000, 0, 'fleetsuite', { kind: 'invoice', month: OCT }],
    ]);
  });

  it('gives more than 2,000 documents at once for the Excel download (migration 460), by date and number', async () => {
    // 2,050 made-up invoices on an account of their own, in July: past
    // migration 400's 2,000.
    await db.exec(`
      INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
      SELECT (900000 + g)::text, 'CustInvc', 'BULK' || lpad(g::text, 5, '0'), DATE '2026-07-01' + (g % 28), '${JUL}', 'x', 's'
      FROM generate_series(1, 2050) g;
      INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
      SELECT (900000 + g)::text, '0', (SELECT id FROM gl_companies WHERE code = 'BMG'), '650', '${JUL}', DATE '2026-07-01' + (g % 28), 1, 0
      FROM generate_series(1, 2050) g;
    `);
    const all = await documents('650', JUL, JUL, { limit: 20000 });
    expect(all).toMatchObject({ documents: 2050, differing: 2050, netsuite: '2050.00', fleetsuite: '0' });
    expect(all.rows).toHaveLength(2050);
    // Dated the 1st: every 28th invoice, by number.
    expect(all.rows.slice(0, 2).map((r) => [r.date, r.number])).toEqual([['2026-07-01', 'BULK00028'], ['2026-07-01', 'BULK00056']]);
    const dates = all.rows.map((r) => r.date!);
    expect(dates.every((d, i) => i === 0 || dates[i - 1] <= d)).toBe(true);
    // As many as asked for, the first by date.
    expect((await documents('650', JUL, JUL, { limit: 2010 })).rows.map((r) => r.doc)).toEqual(all.rows.slice(0, 2010).map((r) => r.doc));
    // No more than 20,000 however many are asked for (20,000 rows take PGlite minutes, so read the bound).
    const body = await one<string>(db, `SELECT prosrc AS r FROM pg_proc WHERE proname = 'gl_books_account_documents'`);
    expect(body).toContain('LIMIT greatest(1, least(coalesce(p_limit, 1000), 20000))');
  }, 60_000);

  it('is for the server alone', async () => {
    await db.exec('RESET ROLE');
    const can = async (role: string) => one<boolean>(db,
      `SELECT has_function_privilege($1, 'public.gl_books_account_documents(text, text, date, date, boolean, integer)', 'EXECUTE') AS r`, [role]);
    expect(await can('anon')).toBe(false);
    expect(await can('authenticated')).toBe(false);
    expect(await can('service_role')).toBe(true);
    await db.exec('SET ROLE service_role');
  });
});
