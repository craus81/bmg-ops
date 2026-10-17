// Migration 377 puts FleetSuite's journal next to the copy of NetSuite's
// general ledger for the differences page. This runs migration 314 (with
// stand-ins for the app tables it points at) and migrations 359–364, 367,
// 370, 374, 376, 377, 380, 382–387 and 389–395 (383, 386, 390, 392 and 395
// give gl_books_difference_documents the deposits, the bills, the bill
// payments, the checks and card charges, and the cost of goods on invoices)
// in an in-memory Postgres (PGlite) as the
// app's server login, copies a made-up month of NetSuite documents, posts
// FleetSuite's entries for some of them, and holds what the three functions
// return, and what the page's comparison makes of it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  accountNamer, accountRows, compareMonth, explainDocument, indexMonths, kindRows, NETSUITE_TYPE, postedKinds,
  type DiffData, type DiffDocumentData,
} from './differences';

/**
 * Made-up chart: '120' receivables, '400' sales, '220' sales tax, '500' cost
 * of goods sold, '510' another cost of goods sold account one item sells to,
 * '130' inventory, '110' undeposited funds, '600' rent, '200' payables.
 */
const ACCOUNTS: Array<[string, string, string]> = [
  ['120', 'Receivables', 'accounts_receivable'],
  ['400', 'Sales', 'income'],
  ['220', 'Sales Tax', 'other_current_liability'],
  ['500', 'Cost of Goods Sold', 'cost_of_goods_sold'],
  ['510', 'Odd Sales', 'cost_of_goods_sold'],
  ['130', 'Inventory', 'other_current_asset'],
  ['110', 'Undeposited Funds', 'other_current_asset'],
  ['600', 'Rent', 'expense'],
  ['200', 'Payables', 'accounts_payable'],
];
const accountId = (ns: string) => `a0000000-0000-4000-8000-000000000${ns}`;
const SEP = '2026-09-01';
const OCT = '2026-10-01';

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
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '364-books-invoice-check.sql',
    '367-books-invoice-posting.sql', '370-books-credit-memos.sql', '374-books-payment-check.sql', '376-books-payment-posting.sql',
    '377-books-differences.sql', '380-books-netsuite-month.sql', '382-books-customer-deposits.sql', '383-books-deposit-posting.sql',
    '384-books-vendor-bills.sql', '385-books-bill-item-accounts.sql', '386-books-bill-posting.sql', '387-books-retired-accounts.sql',
    '389-books-bill-payments.sql', '390-books-bill-payment-posting.sql', '391-books-checks-and-cards.sql', '392-books-spending-posting.sql',
    '393-books-journal-entries.sql', '394-books-bank-deposits.sql', '395-books-stock-cost.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084'`);
  for (const [ns, name, type] of ACCOUNTS) {
    await pg.query(
      `INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, active) VALUES ($1, $2, $3, $4, $5, true)`,
      [accountId(ns), `${ns}0`, name, type, ns],
    );
  }
  // Item 501 sells to Sales and keeps its stock in Inventory; item 502 sells to a cost of goods sold account.
  await pg.exec(`
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
      ('item', '501', 'WIDGET', true, '{"income_account": "400", "asset_account": "130"}'),
      ('item', '502', 'ODDITY', true, '{"income_account": "510"}');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);

/** A NetSuite transaction as the GL copy keeps it; lines are [line id, company, account, cents debit positive]. */
async function copyTxn(pg: PGlite, id: string, type: string, date: string, month: string, lines: Array<[string, string, string, number]>) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [id, type, `${type === 'CustInvc' ? 'INV' : type === 'CustPymt' ? 'PMT' : 'DOC'}${id}`, date, month],
  );
  for (const [line, company, account, cents] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, $4, $5, $6, $7 FROM gl_companies WHERE code = $8`,
      [id, line, account, month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0', company],
    );
  }
}

/** An invoice as the ledger mirror keeps it; lines are [line id, item]. */
async function mirrorInvoice(pg: PGlite, id: string, date: string, opts: { voided?: boolean; deleted?: boolean; lines?: Array<[string, string]> } = {}) {
  const res = await pg.query<{ id: string }>(
    `INSERT INTO ledger_invoices (source, external_id, external_ref, doc_type, doc_number, doc_date, total, voided, deleted_at, party_name)
     VALUES ('netsuite', $1, $2, 'invoice', $3, $4, 0, $5, $6, 'A Customer') RETURNING id`,
    [`CustInvc/${id}`, id, `INV${id}`, date, !!opts.voided, opts.deleted ? '2026-09-20T00:00:00Z' : null],
  );
  for (const [line, item] of opts.lines ?? []) {
    await pg.query(
      `INSERT INTO ledger_invoice_lines (document_id, line_external_id, line_kind, item_external_id) VALUES ($1, $2, 'item', $3)`,
      [res.rows[0].id, line, item],
    );
  }
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;

/** A FleetSuite entry; lines are [account, cents debit positive]. */
const entry = (kind: string, id: string, date: string, generation: number, lines: Array<[string, number]>) => ({
  company: 'BMG',
  entry_date: date,
  source_type: kind,
  source_id: id,
  posting_rule: kind === 'manual' ? 'manual' : `${kind}@1`,
  idempotency_key: `${kind}:${id}:${generation}`,
  lines: lines.map(([account, cents]) => ({ account_id: accountId(account), [cents > 0 ? 'debit' : 'credit']: money(cents) })),
});
const post = (pg: PGlite, p: unknown) => one<{ id: string }>(pg, 'SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify(p)]);
const reverse = (pg: PGlite, entryId: string) => pg.query('SELECT gl_reverse_entry($1::uuid, NULL, NULL, NULL, NULL)', [entryId]);

describe("migration 377's functions", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();

    // NetSuite's September for BMG.
    // INV1001 matches, and so do its cost of goods lines (3, 4), which FleetSuite posts apart from it.
    await copyTxn(db, '1001', 'CustInvc', '2026-09-10', SEP, [['0', 'BMG', '120', 10700], ['1', 'BMG', '400', -10000], ['2', 'BMG', '220', -700], ['3', 'BMG', '500', 4000], ['4', 'BMG', '130', -4000]]);
    await mirrorInvoice(db, '1001', '2026-09-10', { lines: [['1', '501'], ['3', '501'], ['4', '501']] });
    // INV1002: FleetSuite's entry was replaced and now says 45.00, NetSuite 50.00.
    await copyTxn(db, '1002', 'CustInvc', '2026-09-11', SEP, [['0', 'BMG', '120', 5000], ['1', 'BMG', '400', -5000]]);
    await mirrorInvoice(db, '1002', '2026-09-11');
    // INV1003 is dated September 30 but NetSuite posted it to October.
    await copyTxn(db, '1003', 'CustInvc', '2026-09-30', OCT, [['0', 'BMG', '120', 8000], ['1', 'BMG', '400', -8000]]);
    await mirrorInvoice(db, '1003', '2026-09-30');
    // INV1004 isn't posted by FleetSuite.
    await copyTxn(db, '1004', 'CustInvc', '2026-09-12', SEP, [['0', 'BMG', '120', 2500], ['1', 'BMG', '400', -2500]]);
    await mirrorInvoice(db, '1004', '2026-09-12');
    // INV1005 sells item 502 to a cost of goods sold account: a sale, not cost.
    await copyTxn(db, '1005', 'CustInvc', '2026-09-13', SEP, [['0', 'BMG', '120', 3000], ['1', 'BMG', '510', -3000]]);
    await mirrorInvoice(db, '1005', '2026-09-13', { lines: [['1', '502']] });
    // INV1006 is 1084's in NetSuite now.
    await copyTxn(db, '1006', 'CustInvc', '2026-09-14', SEP, [['0', '1084', '120', 6000], ['1', '1084', '400', -6000]]);
    await mirrorInvoice(db, '1006', '2026-09-14');
    // INV1007 was deleted in NetSuite.
    await mirrorInvoice(db, '1007', '2026-09-15', { deleted: true });
    // INV1008's entry was reversed; INV1009 was voided and its entry reversed, though NetSuite keeps its lines.
    await copyTxn(db, '1008', 'CustInvc', '2026-09-16', SEP, [['0', 'BMG', '120', 1500], ['1', 'BMG', '400', -1500]]);
    await mirrorInvoice(db, '1008', '2026-09-16');
    await copyTxn(db, '1009', 'CustInvc', '2026-09-17', SEP, [['0', 'BMG', '120', 1200], ['1', 'BMG', '400', -1200]]);
    await mirrorInvoice(db, '1009', '2026-09-17', { voided: true });
    // A payment that matches, an expense report FleetSuite doesn't post, and a journal entry it hasn't posted.
    await copyTxn(db, '2001', 'CustPymt', '2026-09-18', SEP, [['0', 'BMG', '110', 10700], ['1', 'BMG', '120', -10700]]);
    await copyTxn(db, '3001', 'ExpRept', '2026-09-19', SEP, [['0', 'BMG', '200', -50000], ['1', 'BMG', '600', 50000]]);
    await copyTxn(db, '4001', 'Journal', '2026-09-20', SEP, [['1', 'BMG', '600', 2000], ['2', 'BMG', '110', -2000]]);
    // INV1010 is dated before the books start, posted by NetSuite to January 2025.
    await copyTxn(db, '1010', 'CustInvc', '2024-12-31', '2025-01-01', [['0', 'BMG', '120', 900], ['1', 'BMG', '400', -900]]);
    await mirrorInvoice(db, '1010', '2024-12-31');

    // FleetSuite's journal.
    await post(db, entry('invoice', '1001', '2026-09-10', 1, [['120', 10700], ['400', -10000], ['220', -700]]));
    await post(db, entry('invoice_cost', '1001', '2026-09-10', 1, [['500', 4000], ['130', -4000]]));
    const replaced = await post(db, entry('invoice', '1002', '2026-09-11', 1, [['120', 5000], ['400', -5000]]));
    await db.query('SELECT gl_repost_entry($1::uuid, $2, $3::jsonb)', [
      replaced.id, 'INV1002 changed in NetSuite', JSON.stringify(entry('invoice', '1002', '2026-09-11', 2, [['120', 4500], ['400', -4500]])),
    ]);
    await post(db, entry('invoice', '1003', '2026-09-30', 1, [['120', 8000], ['400', -8000]]));
    await post(db, entry('invoice', '1005', '2026-09-13', 1, [['120', 3000], ['510', -3000]]));
    await post(db, entry('invoice', '1006', '2026-09-14', 1, [['120', 6000], ['400', -6000]]));
    await post(db, entry('invoice', '1007', '2026-09-15', 1, [['120', 7000], ['400', -7000]]));
    await reverse(db, (await post(db, entry('invoice', '1008', '2026-09-16', 1, [['120', 1500], ['400', -1500]]))).id);
    await reverse(db, (await post(db, entry('invoice', '1009', '2026-09-17', 1, [['120', 1200], ['400', -1200]]))).id);
    await post(db, entry('payment', '2001', '2026-09-18', 1, [['110', 10700], ['120', -10700]]));
    await post(db, { ...entry('manual', '', '2026-09-21', 1, [['600', 500], ['110', -500]]), source_id: null, idempotency_key: 'manual:1' });
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const KINDS = JSON.stringify(NETSUITE_TYPE);
  const documents = (month: string, limit = 50) => one<{ counts: Record<string, number>; documents: DiffDocumentData[] }>(
    db, 'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r', ['BMG', month, KINDS, limit],
  );

  it('gl_netsuite_cost_lines finds the lines booking the cost of stock, not a sale to a cost of goods account', async () => {
    const rows = (await db.query<{ transaction_id: string; line_id: string }>(
      `SELECT transaction_id, line_id FROM gl_netsuite_cost_lines('BMG', $1::date) ORDER BY 1, 2`, [SEP],
    )).rows;
    expect(rows).toEqual([{ transaction_id: '1001', line_id: '3' }, { transaction_id: '1001', line_id: '4' }]);
    expect((await db.query(`SELECT 1 FROM gl_netsuite_cost_lines('BMG', $1::date)`, [OCT])).rows).toHaveLength(0);
    expect((await db.query(`SELECT 1 FROM gl_netsuite_cost_lines('1084', NULL)`)).rows).toHaveLength(0);
  });

  it('gl_books_differences gives each side by month, account and kind, and what each kind moved', async () => {
    const data = await one<DiffData>(db, `SELECT gl_books_differences('BMG') AS r`);
    const sep = (rows: DiffData['netsuite']) => rows.filter((r) => r.month === SEP).map((r) => `${r.account} ${r.kind} ${r.net}`);
    expect(sep(data.netsuite)).toEqual([
      '110 CustPymt 107.00', '110 Journal -20.00',
      '120 CustInvc 239.00', '120 CustPymt -107.00',
      '130 cost -40.00',
      '200 ExpRept -500.00',
      '220 CustInvc -7.00',
      '400 CustInvc -202.00',
      '500 cost 40.00',
      '510 CustInvc -30.00',
      '600 ExpRept 500.00', '600 Journal 20.00',
    ]);
    // INV1002's three entries come to its new one; INV1008's and INV1009's two come to nothing.
    expect(sep(data.fleetsuite)).toEqual([
      '110 manual -5.00', '110 payment 107.00',
      '120 invoice 392.00', '120 payment -107.00',
      '130 invoice_cost -40.00',
      '220 invoice -7.00',
      '400 invoice -355.00',
      '500 invoice_cost 40.00',
      '510 invoice -30.00',
      '600 manual 5.00',
    ]);
    expect(data.netsuite.filter((r) => r.month !== SEP).map((r) => `${r.month} ${r.account} ${r.kind} ${r.net}`)).toEqual([
      '2025-01-01 120 CustInvc 9.00', '2025-01-01 400 CustInvc -9.00',
      '2026-10-01 120 CustInvc 80.00', '2026-10-01 400 CustInvc -80.00',
    ]);
    expect(data.fleetsuite.filter((r) => r.month !== SEP)).toEqual([]);

    // Sorted here: how the database orders 'cost' against 'CustInvc' depends on its collation.
    const byKind = (a: { kind: string }, b: { kind: string }) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
    expect(data.netsuite_kinds.filter((k) => k.month === SEP).sort(byKind)).toEqual([
      { month: SEP, kind: 'CustInvc', documents: 6, moved: '239.00' },
      { month: SEP, kind: 'CustPymt', documents: 1, moved: '107.00' },
      { month: SEP, kind: 'ExpRept', documents: 1, moved: '500.00' },
      { month: SEP, kind: 'Journal', documents: 1, moved: '20.00' },
      { month: SEP, kind: 'cost', documents: 1, moved: '40.00' },
    ]);
    expect(data.fleetsuite_kinds.filter((k) => k.month === SEP).sort(byKind)).toEqual([
      { month: SEP, kind: 'invoice', documents: 6, moved: '392.00' },
      { month: SEP, kind: 'invoice_cost', documents: 1, moved: '40.00' },
      { month: SEP, kind: 'manual', documents: 1, moved: '5.00' },
      { month: SEP, kind: 'payment', documents: 1, moved: '107.00' },
    ]);
  });

  it('the page compares the month: what FleetSuite posts differs on four accounts, the rest is not posted yet', async () => {
    const data = await one<DiffData>(db, `SELECT gl_books_differences('BMG') AS r`);
    const posted = postedKinds(data, true);
    const cmp = compareMonth(indexMonths(data).get(SEP), SEP, posted);
    const chart = ACCOUNTS.map(([ns, name]) => ({ id: accountId(ns), netsuite_account_id: ns, number: `${ns}0`, name }));
    const rows = accountRows(cmp, accountNamer(chart));
    expect(rows.map((r) => [r.number, r.fleetsuite, r.netsuite, r.notPosted, r.differs])).toEqual([
      ['1100', 10200, 8700, 0, 1500],
      ['1200', 28500, 13200, 0, 15300],
      ['1300', -4000, -4000, 0, 0],
      ['2000', 0, -50000, -50000, 0],
      ['2200', -700, -700, 0, 0],
      ['4000', -35500, -20200, 0, -15300],
      ['5000', 4000, 4000, 0, 0],
      ['5100', -3000, -3000, 0, 0],
      ['6000', 500, 52000, 50000, -1500],
    ]);
    expect(cmp.status).toBe('differs');
    expect(cmp.differing).toBe(4);
    expect(cmp.covered).toBeCloseTo((23900 + 4000 + 10700 + 2000) / (23900 + 4000 + 10700 + 50000 + 2000));

    const docs = await documents(SEP);
    expect(kindRows(cmp, docs.counts).map((k) => [k.name, k.state, k.netsuite?.documents ?? null, k.fleetsuite?.documents ?? null, k.differing])).toEqual([
      ['Invoice', 'posted', 6, 6, 7],
      ['Payment', 'posted', 1, 1, 0],
      ['Journal', 'posted', 1, null, 1],
      ['Cost of goods on invoices', 'posted', 1, 1, 0],
      ['Expense Report', 'not_posted', 1, null, null],
      ['Typed entry (FleetSuite only)', 'fleetsuite_only', null, 1, null],
    ]);
  });

  it('gl_books_difference_documents lists the documents that differ, largest first, and why', async () => {
    const docs = await documents(SEP);
    expect(docs.counts).toEqual({ invoice: 7, journal_entry: 1 });
    const chart = ACCOUNTS.map(([ns, name]) => ({ id: accountId(ns), netsuite_account_id: ns, number: `${ns}0`, name }));
    const ctx = { name: accountNamer(chart) };
    const explained = docs.documents.map((d) => explainDocument(d, ctx));
    expect(explained.map((d) => [d.number, d.reason, d.fleetsuite, d.netsuite])).toEqual([
      ['INV1003', 'month', 8000, 0],
      ['INV1007', 'gone', 7000, 0],
      ['INV1006', 'gone', 6000, 0],
      ['INV1004', 'not_posted', 0, 2500],
      ['DOC4001', 'not_posted', 0, 2000],
      ['INV1008', 'reversed', 0, 1500],
      ['INV1009', 'voided', 0, 1200],
      ['INV1002', 'amounts', 4500, 5000],
    ]);
    const why = Object.fromEntries(explained.map((d) => [d.number, d.why]));
    expect(why.INV1003).toBe('FleetSuite has it in September 2026, dated Sep 30, 2026; NetSuite posted it to October 2026.');
    expect(why.INV1007).toBe("Deleted in NetSuite. The next posting run reverses FleetSuite's entry.");
    expect(why.INV1006).toBe("NetSuite posts it to the other company now, but FleetSuite's entry for this one stands.");
    expect(why.INV1002).toBe('Posted differently on 2 accounts: 1200 Receivables: FleetSuite $45.00, NetSuite $50.00; 4000 Sales: FleetSuite -$45.00, NetSuite -$50.00.');

    const inv1002 = docs.documents.find((d) => d.netsuite_id === '1002')!;
    expect(inv1002).toMatchObject({
      kind: 'invoice',
      netsuite: { type: 'CustInvc', number: 'INV1002', date: '2026-09-11', month: SEP },
      fleetsuite: { entries: 2, standing: { date: '2026-09-11' } },
      copy: { number: 'INV1002', customer: 'A Customer', voided: false, deleted: false },
    });
    expect(inv1002.lines).toEqual([
      { account: '120', netsuite: '50.00', fleetsuite: '45.00' },
      { account: '400', netsuite: '-50.00', fleetsuite: '-45.00' },
    ]);
    expect(docs.documents.find((d) => d.netsuite_id === '1007')).toMatchObject({
      netsuite: null, copy: { deleted: true }, fleetsuite: { entries: 1 },
    });

    // October: the other half of INV1003.
    const oct = await documents(OCT);
    expect(oct.counts).toEqual({ invoice: 1 });
    expect(oct.documents.map((d) => explainDocument(d, ctx)).map((d) => [d.number, d.reason, d.fleetsuite, d.netsuite])).toEqual([
      ['INV1003', 'month', 0, 8000],
    ]);

    // January 2025: dated before the books start, an invoice FleetSuite posts in the month NetSuite booked it to.
    const jan = await documents('2025-01-01');
    expect(jan.documents.map((d) => explainDocument(d, ctx)).map((d) => [d.number, d.reason, d.why, d.listMonth])).toEqual([
      ['INV1010', 'not_posted', "FleetSuite hasn't posted it. Invoices vs NetSuite shows why.", '2025-01-01'],
    ]);
  });

  it('keeps to the limit but counts them all, and compares only the kinds asked for', async () => {
    const two = await documents(SEP, 2);
    expect(two.counts).toEqual({ invoice: 7, journal_entry: 1 });
    expect(two.documents.map((d) => d.netsuite_id)).toEqual(['1003', '1007']);

    const payments = await one<{ counts: Record<string, number>; documents: unknown[] }>(
      db, 'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, 50) AS r', ['BMG', SEP, JSON.stringify({ payment: 'CustPymt' })],
    );
    expect(payments).toEqual({ counts: {}, documents: [] });
    const none = await one<{ counts: Record<string, number>; documents: unknown[] }>(
      db, 'SELECT gl_books_difference_documents($1, $2::date, NULL, 50) AS r', ['BMG', SEP],
    );
    expect(none).toEqual({ counts: {}, documents: [] });
  });

  it('gives 1084 only its own NetSuite lines', async () => {
    const data = await one<DiffData>(db, `SELECT gl_books_differences('1084') AS r`);
    expect(data.netsuite.map((r) => `${r.account} ${r.kind} ${r.net}`)).toEqual(['120 CustInvc 60.00', '400 CustInvc -60.00']);
    expect(data.fleetsuite).toEqual([]);
    const cmp = compareMonth(indexMonths(data).get(SEP), SEP, postedKinds(data, false));
    expect(cmp.status).toBe('none');
    expect(cmp.accounts.every((a) => a.differs === 0)).toBe(true);
  });

  it('is the service role\'s alone', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`RESET ROLE; SET ROLE ${role}`);
      await expect(db.query(`SELECT gl_books_differences('BMG')`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`SELECT gl_books_difference_documents('BMG', '2026-09-01', '{}', 10)`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`SELECT * FROM gl_netsuite_cost_lines('BMG', NULL)`)).rejects.toThrow(/permission denied/);
    }
    await db.exec('RESET ROLE; SET ROLE service_role');
  });

  it('lists cost of goods FleetSuite posted for an invoice NetSuite books no cost on, with the invoice\'s copy', async () => {
    // INV1005 sells item 502 to a cost of goods sold account, which is a sale, not cost.
    await post(db, entry('invoice_cost', '1005', '2026-09-13', 1, [['500', 1200], ['130', -1200]]));
    const docs = await documents(SEP);
    expect(docs.counts).toEqual({ invoice: 7, journal_entry: 1, invoice_cost: 1 });
    const cost = docs.documents.find((d) => d.kind === 'invoice_cost')!;
    expect(cost).toMatchObject({
      netsuite_id: '1005',
      netsuite: { type: 'CustInvc', number: 'INV1005', date: '2026-09-13', month: SEP },
      fleetsuite: { entries: 1, standing: { date: '2026-09-13' } },
      copy: { number: 'INV1005', customer: 'A Customer', voided: false, deleted: false },
    });
    const chart = ACCOUNTS.map(([ns, name]) => ({ id: accountId(ns), netsuite_account_id: ns, number: `${ns}0`, name }));
    expect(explainDocument(cost, { name: accountNamer(chart) })).toMatchObject({
      number: 'INV1005', customer: 'A Customer', reason: 'no_cost', listKind: 'stock', listMonth: SEP, netsuite: 0, fleetsuite: 1200,
      lines: [
        { account: '130', number: '1300', netsuite: 0, fleetsuite: -1200 },
        { account: '500', number: '5000', netsuite: 0, fleetsuite: 1200 },
      ],
    });
  });
});
