// Migration 382 keeps a copy of NetSuite's customer deposits and deposit
// applications and reads a month of them for the deposit rule's check. This
// runs migrations 359–363 and 382 in an in-memory Postgres (PGlite) as the
// app's server login and holds the functions' rules, then runs the whole
// copy job against them with a fake NetSuite that answers the job's own
// SuiteQL, and checks a month end to end.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({
  isSuiteqlError: (err: unknown) => err instanceof Error && typeof (err as any).status === 'number',
  suiteqlQuery: vi.fn(),
  suiteqlQueryAll: vi.fn(),
}));
vi.mock('@/lib/system-health', () => ({
  recordHeartbeat: vi.fn(async (service: any, syncType: string, lastResult: unknown, opts?: { touchLastSyncedAt?: boolean; lastSyncedAt?: string }) => {
    const row: Record<string, unknown> = { sync_type: syncType, last_result: lastResult };
    if (opts?.lastSyncedAt) row.last_synced_at = opts.lastSyncedAt;
    else if (opts?.touchLastSyncedAt !== false) row.last_synced_at = new Date().toISOString();
    await service.from('sync_state').upsert(row);
    return { ok: true };
  }),
}));

import type { ChartAccount } from './invoice-check';
import { checkDepositMonth, type DepositMonthData } from './deposit-check';
import { BOOKS_DEPOSITS_SYNC, DEPOSIT_IDS_QUERY, copyNetSuiteDeposits } from './netsuite-deposits';

// A fresh database with Supabase's API roles and default grants, migrations
// 359–363 and 382 run twice as the owner, 1084 linked to subsidiary 5 (as
// the account sync does).
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
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '382-books-customer-deposits.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084'`);
  return pg;
}

/** A NetSuite document in the GL copy, with its lines: [line id, account, debit, credit]. */
async function gl(pg: PGlite, id: string, type: string, number: string | null, date: string, company: string, lines: Array<[string, string, string, string]>) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4::date, date_trunc('month', $4::date)::date, 'x', 's')`,
    [id, type, number, date],
  );
  for (const [lineId, account, debit, credit] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, date_trunc('month', $6::date)::date, $6::date, $4, $5 FROM gl_companies WHERE code = $7`,
      [id, lineId, account, debit, credit, date, company],
    );
  }
}

type Link = { netsuite_id: string; type: string | null; number: string | null; amount: string | null; link_type: string | null };
const link = (id: string, type: string, number: string | null, amount: string | null): Link => ({ netsuite_id: id, type, number, amount, link_type: null });
const doc = (id: string, type: 'CustDep' | 'DepAppl', number: string | null, date: string, total: string, fields: Record<string, unknown> = {}) => ({
  netsuite_id: id, tran_type: type, tranid: number, trandate: date, customer_netsuite_id: '77', customer_name: 'A Customer',
  total, status: null, status_label: null, voided: false, memo: null, links: [] as Link[], ...fields,
});

describe('the deposits functions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await db.exec('SET ROLE service_role');
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const apply = async (rows: unknown[]) =>
    (await db.query<{ r: { received: number; added: number; changed: number } }>('SELECT gl_netsuite_deposits_apply($1::jsonb) AS r', [JSON.stringify({ rows })])).rows[0].r;
  const finish = async (ids: string[]) =>
    (await db.query<{ r: { listed: number; here: number; gone: number; cut_short: boolean } }>(
      'SELECT gl_netsuite_deposits_finish($1::jsonb) AS r', [JSON.stringify({ netsuite_ids: ids })],
    )).rows[0].r;
  const stored = async (id: string) => (await db.query<{ total: string; status_label: string | null; links: Link[] | null; gone: boolean; changed_at: string }>(
    `SELECT total::text AS total, status_label, links, gone_at IS NOT NULL AS gone, changed_at::text AS changed_at FROM gl_netsuite_deposits WHERE netsuite_id = $1`,
    [id],
  )).rows[0];

  it('adds what NetSuite has, and changes nothing when it\'s the same again', async () => {
    const rows = [
      doc('301', 'CustDep', 'DEP1', '2026-09-10', '500.00', { status_label: 'Deposited', links: [link('90', 'SalesOrd', 'SO90', '500.00')] }),
      doc('311', 'DepAppl', 'DA11', '2026-09-20', '300.00', { links: [link('301', 'CustDep', 'DEP1', '300.00'), link('501', 'CustInvc', 'INV501', '300.00')] }),
    ];
    expect(await apply(rows)).toEqual({ received: 2, added: 2, changed: 0 });
    const before = await stored('301');
    expect(before).toMatchObject({ total: '500.00', status_label: 'Deposited', links: [link('90', 'SalesOrd', 'SO90', '500.00')], gone: false });
    expect(await apply(rows)).toEqual({ received: 2, added: 0, changed: 0 });
    expect((await stored('301')).changed_at).toBe(before.changed_at);
  });

  it('follows NetSuite\'s changes, and keeps the links when a run couldn\'t read them', async () => {
    expect(await apply([doc('301', 'CustDep', 'DEP1', '2026-09-10', '500.00', { status_label: 'Fully Applied', links: [link('90', 'SalesOrd', 'SO90', '500.00')] })]))
      .toMatchObject({ added: 0, changed: 1 });
    const { links, ...row } = doc('301', 'CustDep', 'DEP1', '2026-09-10', '500.00', { status_label: 'Fully Applied' });
    expect(links).toEqual([]);
    expect(await apply([row])).toMatchObject({ changed: 0 });
    // Something else changed in a run that couldn't read the links: the row follows NetSuite and keeps them.
    expect(await apply([{ ...row, memo: 'Ahead of the job' }])).toMatchObject({ changed: 1 });
    expect(await stored('301')).toMatchObject({ status_label: 'Fully Applied', links: [link('90', 'SalesOrd', 'SO90', '500.00')] });
    // A document copied before its links could ever be read has none yet, which isn't the same as none in NetSuite.
    const { links: _none, ...unlinked } = doc('312', 'DepAppl', null, '2026-10-02', '200.00');
    await apply([unlinked]);
    expect((await stored('312')).links).toBeNull();
  });

  it('marks what NetSuite no longer lists as gone, back when it lists it again, and nothing when the list looks cut short', async () => {
    expect(await finish(['301', '311'])).toEqual({ listed: 2, here: 3, gone: 1, cut_short: false });
    expect(await stored('312')).toMatchObject({ gone: true });
    const { links: _none, ...back } = doc('312', 'DepAppl', null, '2026-10-02', '200.00');
    expect(await apply([back])).toMatchObject({ changed: 1 });
    expect(await stored('312')).toMatchObject({ gone: false });
    expect(await finish([])).toEqual({ listed: 0, here: 3, gone: 0, cut_short: true });
    expect(await finish(['301'])).toEqual({ listed: 1, here: 3, gone: 0, cut_short: true });
    expect((await stored('311')).gone).toBe(false);
  });

  it('refuses a bad page whole, changing nothing', async () => {
    const before = await stored('301');
    const good = doc('301', 'CustDep', 'DEP1', '2026-09-10', '999.00');
    await expect(apply([good, { ...good, tranid: 'Twice' }])).rejects.toThrow(/NetSuite document 301 is in the page twice/);
    await expect(apply([good, { ...good, netsuite_id: 'x7' }])).rejects.toThrow(/NetSuite id "x7" isn't a number/);
    await expect(apply([good, { ...good, netsuite_id: '9', tran_type: 'CustPymt' }])).rejects.toThrow(/document 9 isn't a customer deposit/);
    await expect(apply([good, { ...good, netsuite_id: '9', trandate: null }])).rejects.toThrow(/document 9 isn't a customer deposit/);
    await expect(apply([good, { ...good, netsuite_id: '9', total: '' }])).rejects.toThrow(/document 9 isn't a customer deposit/);
    await expect(apply([good, { ...good, netsuite_id: '9', links: { not: 'a list' } }])).rejects.toThrow(/document 9 isn't a customer deposit/);
    await expect(apply([good, { ...good, netsuite_id: '9', total: '-5.00' }])).rejects.toThrow(/check constraint/);
    await expect(db.query('SELECT gl_netsuite_deposits_apply($1::jsonb)', [JSON.stringify({})])).rejects.toThrow(/rows must be a list/);
    await expect(db.query('SELECT gl_netsuite_deposits_finish($1::jsonb)', [JSON.stringify({})])).rejects.toThrow(/netsuite_ids must be a list/);
    expect(await stored('301')).toEqual(before);
  });

  it('lets only the service role read the copy or run the functions, and the one write that changes rows says which', async () => {
    for (const fn of ['gl_netsuite_deposits_apply(jsonb)', 'gl_netsuite_deposits_finish(jsonb)', 'gl_deposit_month(text, date)']) {
      for (const role of ['anon', 'authenticated']) {
        const r = await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
        expect(r.rows[0].ok, `${role} ${fn}`).toBe(false);
      }
      const s = await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [fn]);
      expect(s.rows[0].ok, fn).toBe(true);
    }
    for (const role of ['anon', 'authenticated']) {
      const t = await db.query<{ ok: boolean }>(`SELECT has_table_privilege($1, 'gl_netsuite_deposits', 'SELECT') AS ok`, [role]);
      expect(t.rows[0].ok, role).toBe(false);
    }
    const rls = await db.query<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'gl_netsuite_deposits'`);
    expect(rls.rows[0].on).toBe(true);

    // Supabase's API connections fail an UPDATE or DELETE with no WHERE, even inside a function (migrations/README.md).
    const body = async (name: string) => (await db.query<{ b: string }>(`SELECT prosrc AS b FROM pg_proc WHERE proname = $1`, [name])).rows[0].b;
    expect(await body('gl_netsuite_deposits_finish')).toMatch(/UPDATE public\.gl_netsuite_deposits d SET gone_at = now\(\)\s+WHERE d\.gone_at IS NULL/);
    expect((await body('gl_netsuite_deposits_finish')).match(/\b(UPDATE|DELETE)\b/g)).toEqual(['UPDATE']);
    // The apply's only write is an INSERT, whose ON CONFLICT ... DO UPDATE safeupdate leaves alone.
    expect((await body('gl_netsuite_deposits_apply')).match(/\b(INSERT|UPDATE|DELETE)\b/g)).toEqual(['INSERT', 'UPDATE']);
    expect(await body('gl_netsuite_deposits_apply')).toMatch(/ON CONFLICT \(netsuite_id\) DO UPDATE SET/);
    expect(await body('gl_deposit_month')).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });
});

// Made-up books: '120' receivables, '110' Undeposited Funds, '230' customer
// deposits and '231' an older deposits account (BMG), '111' and '232' 1084's.
const NAMES: Record<string, [string, string]> = {
  '120': ['1200 Receivables', 'accounts_receivable'], '110': ['1100 Undeposited Funds', 'other_current_asset'],
  '230': ['2300 Customer Deposits', 'other_current_liability'], '231': ['2310 Old Deposits', 'other_current_liability'],
  '111': ['1110 Undeposited Funds', 'other_current_asset'], '232': ['2320 Customer Deposits', 'other_current_liability'],
};
const CHART: ChartAccount[] = Object.entries(NAMES).map(([id, [label, type]]) => ({
  netsuite_account_id: id, number: label.split(' ')[0], name: label.split(' ').slice(1).join(' '), account_type: type,
  company: null, active: true, is_summary: false,
}));

describe('gl_deposit_month (migration 382)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // September 2026: DEP1 (BMG, for SO90, applied by DA11 in September and
    // one with no number in October; DA13, which applied it too, is gone from
    // NetSuite), DA11, DEP3 (1084), DEP4 (in neither company's GL copy), DEP6
    // (gone from NetSuite), and DA20 in BMG's GL copy but not copied yet. A
    // 2025 deposit to the older account, and a customer payment, which isn't
    // a deposit.
    await gl(db, '301', 'CustDep', 'DEP1', '2026-09-10', 'BMG', [['0', '110', '500.00', '0.00'], ['1', '230', '0.00', '500.00']]);
    // Line ids out of text order, to show they come back in NetSuite's order.
    await gl(db, '311', 'DepAppl', 'DA11', '2026-09-20', 'BMG', [['10', '120', '0.00', '300.00'], ['2', '230', '300.00', '0.00']]);
    await gl(db, '312', 'DepAppl', null, '2026-10-02', 'BMG', [['0', '120', '0.00', '200.00'], ['1', '230', '200.00', '0.00']]);
    await gl(db, '303', 'CustDep', 'DEP3', '2026-09-15', '1084', [['0', '111', '80.00', '0.00'], ['1', '232', '0.00', '80.00']]);
    await gl(db, '306', 'CustDep', 'DEP6', '2026-09-27', 'BMG', [['0', '110', '60.00', '0.00'], ['1', '230', '0.00', '60.00']]);
    await gl(db, '320', 'DepAppl', 'DA20', '2026-09-28', 'BMG', [['0', '120', '0.00', '40.00'], ['1', '230', '40.00', '0.00']]);
    await gl(db, '401', 'CustDep', 'DEP401', '2025-03-03', 'BMG', [['0', '110', '90.00', '0.00'], ['1', '231', '0.00', '90.00']]);
    await gl(db, '402', 'CustPymt', 'PMT402', '2026-09-12', 'BMG', [['0', '110', '50.00', '0.00'], ['1', '120', '0.00', '50.00']]);
    await db.exec('SET ROLE service_role');
    const dep1Links = [link('90', 'SalesOrd', 'SO90', '500.00')];
    await db.query('SELECT gl_netsuite_deposits_apply($1::jsonb)', [JSON.stringify({ rows: [
      doc('301', 'CustDep', 'DEP1', '2026-09-10', '500.00', { status_label: 'Fully Applied', links: dep1Links }),
      doc('311', 'DepAppl', 'DA11', '2026-09-20', '300.00', { links: [link('301', 'CustDep', 'DEP1', '300.00'), link('501', 'CustInvc', 'INV501', '300.00')] }),
      doc('312', 'DepAppl', null, '2026-10-02', '200.00', { links: [link('301', 'CustDep', 'DEP1', '200.00'), link('502', 'CustInvc', null, null)] }),
      doc('303', 'CustDep', 'DEP3', '2026-09-15', '80.00'),
      doc('304', 'CustDep', 'DEP4', '2026-09-25', '75.00'),
      doc('306', 'CustDep', 'DEP6', '2026-09-27', '60.00'),
      doc('313', 'DepAppl', 'DA13', '2026-09-22', '100.00', { links: [link('301', 'CustDep', 'DEP1', '100.00'), link('503', 'CustInvc', 'INV503', '100.00')] }),
    ] })]);
    await db.query('SELECT gl_netsuite_deposits_finish($1::jsonb)', [JSON.stringify({ netsuite_ids: ['301', '311', '312', '303', '304'] })]);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const month = async (company: string | null, day: string) =>
    (await db.query<{ r: DepositMonthData }>('SELECT gl_deposit_month($1, $2::date) AS r', [company, day])).rows[0].r;

  it('returns the company\'s deposits and applications dated in the month, and those in neither company\'s GL copy', async () => {
    const bmg = await month('BMG', '2026-09-01');
    expect(bmg.deposits.map((d) => [d.number, d.type, d.companies])).toEqual([
      ['DEP1', 'CustDep', ['BMG']], ['DA11', 'DepAppl', ['BMG']], ['DEP4', 'CustDep', []],
    ]);
    expect((await month('1084', '2026-09-15')).deposits.map((d) => d.number)).toEqual(['DEP3', 'DEP4']);
    expect((await month(null, '2026-09-30')).deposits.map((d) => d.number)).toEqual(['DEP1', 'DEP3', 'DA11', 'DEP4']);
    expect((await month('BMG', '2026-10-01')).deposits.map((d) => d.netsuite_id)).toEqual(['312']);
    expect((await month('BMG', '2026-08-01')).deposits).toEqual([]);
  });

  it('gives each what it applies, what applied it, and NetSuite\'s GL lines in line order', async () => {
    const [dep1, da11] = (await month('BMG', '2026-09-01')).deposits;
    expect(dep1).toMatchObject({
      netsuite_id: '301', date: '2026-09-10', total: '500.00', voided: false, status: 'Fully Applied', customer: 'A Customer',
      links: [link('90', 'SalesOrd', 'SO90', '500.00')],
      applications: [
        { netsuite_id: '311', number: 'DA11', date: '2026-09-20', links: [link('301', 'CustDep', 'DEP1', '300.00'), link('501', 'CustInvc', 'INV501', '300.00')] },
        { netsuite_id: '312', number: null, date: '2026-10-02', links: [link('301', 'CustDep', 'DEP1', '200.00'), link('502', 'CustInvc', null, null)] },
      ],
    });
    expect(da11.applications).toEqual([]);
    expect(da11.netsuite).toEqual([
      { line_id: '2', account: '230', debit: '300.00', credit: '0.00' },
      { line_id: '10', account: '120', debit: '0.00', credit: '300.00' },
    ]);
  });

  it('counts the accounts the company\'s deposits use across the GL copy, and names what isn\'t copied yet', async () => {
    const bmg = await month('BMG', '2026-09-01');
    // 230: DEP1, DA11, the October application, DEP6 and DA20; 231: the 2025 deposit. Not the payment, nor where the money went.
    expect(bmg.accounts).toEqual([{ account: '230', documents: 5 }, { account: '231', documents: 1 }]);
    expect(bmg.not_copied).toEqual([{ netsuite_id: '306', type: 'CustDep', number: 'DEP6' }, { netsuite_id: '320', type: 'DepAppl', number: 'DA20' }]);
    const other = await month('1084', '2026-09-01');
    expect(other.accounts).toEqual([{ account: '232', documents: 1 }]);
    expect(other.not_copied).toEqual([]);
  });

  it('checks a month end to end', async () => {
    const m = checkDepositMonth(await month('BMG', '2026-09-01'), { company: 'BMG', chart: CHART });
    expect(m.summary).toEqual({ invoices: 2, matches: 2, differs: 0, unworkable: 0, waiting: 0, withCost: 0 });
    expect(m.invoices.map((d) => [d.number, d.status, d.order, d.deposit, d.applied])).toEqual([
      ['DEP1', 'matches', 'SO90', undefined, [{ number: 'INV501', cents: 30000, date: '2026-09-20' }, { number: 'NetSuite invoice 502', cents: null, date: '2026-10-02' }]],
      ['DA11', 'matches', undefined, 'DEP1', [{ number: 'INV501', cents: 30000 }]],
    ]);
    expect(m.notes).toEqual([
      "NetSuite's customer deposits for BMG use 2 accounts, so FleetSuite took 2300 Customer Deposits, the one most of them use.",
      "1 more deposit or application dated this month isn't in the copy of NetSuite's GL for either company: DEP4. NetSuite may have "
        + "deleted it, or the copy, which runs every two hours, hasn't reached it yet.",
      "The copy of NetSuite's GL has 2 deposits and applications of this company's dated this month that the copy of the deposits "
        + "doesn't: DEP6, DA20. The deposits copy runs every two hours and may not have reached them yet, or NetSuite deleted them and "
        + "the GL copy hasn't caught up.",
    ]);
    const other = checkDepositMonth(await month('1084', '2026-09-01'), { company: '1084', chart: CHART });
    expect(other.invoices.map((d) => [d.number, d.status, d.rows.map((r) => [r.label, r.fleetsuite?.account, r.same])])).toEqual([
      ['DEP3', 'matches', [['Deposited to', '111', true], ['Customer deposits', '232', true]]],
    ]);
  });
});

// ── The copy job ───────────────────────────────────────────────────────────

interface NsDoc {
  id: number;
  type: 'CustDep' | 'DepAppl';
  tranid: string | null;
  /** As SuiteQL gives it, M/D/YYYY. */
  trandate: string;
  total: number;
  status?: string;
  label?: string;
  customer?: number | null;
  /** lastmodifieddate, YYYY-MM-DD. */
  modified: string;
}

const rejected = (detail: string) => Object.assign(
  new Error(`NetSuite SuiteQL error (400): {"o:errorDetails":[{"detail":"Invalid search query. Detailed unprocessed description follows. ${detail}"}]}`),
  { status: 400 },
);

class FakeNetSuite {
  docs: NsDoc[] = [];
  /** Documents the deposits link to: invoices and sales orders. */
  others: Array<{ id: number; type: string; tranid: string | null }> = [];
  links: Array<{ previousdoc: number; nextdoc: number; foreignamount: number | string | null; linktype: string | null }> = [];
  /** Columns and link tables this account refuses. */
  refuse = new Set<string>();
  /** The ids NetSuite lists when asked for all of them; every document's when null. */
  ids: number[] | null = null;
  down = false;
  /** Called on every header page, so tests can move the clock. */
  onPage = () => {};
  headerPages = 0;

  page = async (q: string, limit: number): Promise<Record<string, unknown>[]> => {
    if (this.down) throw Object.assign(new Error('NetSuite SuiteQL error (503): unavailable'), { status: 503 });
    const withLabel = q.includes('status_label');
    if (withLabel && this.refuse.has('status_label')) throw rejected("Search error occurred: Field 'BUILTIN.DF' is not valid.");
    this.headerPages++;
    this.onPage();
    const [, m, d, y] = /TO_DATE\('(\d+)\/(\d+)\/(\d+)'/.exec(q)!;
    const since = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    const before = Number(/t\.id < (\d+)/.exec(q)?.[1] ?? Infinity);
    return this.docs
      .filter((x) => x.modified >= since && x.id < before)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit)
      .map((x) => ({
        id: x.id, type: x.type, tranid: x.tranid, trandate: x.trandate, status: x.status ?? null, memo: null, total: x.total,
        customer_id: x.customer ?? null, customer_name: x.customer ? `Customer Co ${x.customer}` : null, customer_entity_id: null,
        ...(withLabel ? { status_label: x.label ?? null } : {}),
      }));
  };

  query = async (q: string): Promise<Record<string, unknown>[]> => {
    if (this.down) throw Object.assign(new Error('NetSuite SuiteQL error (503): unavailable'), { status: 503 });
    const ids = (/IN \(([\d, ]+)\)/.exec(q)?.[1] ?? '').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
    const table = /FROM (nexttransactionlinelink|previoustransactionlinelink)/.exec(q)?.[1];
    if (table) {
      if (this.refuse.has(table)) throw rejected(`Search error occurred: Record '${table}' was not found.`);
      return this.links.filter((l) => ids.includes(l.nextdoc)).map((l) => ({ ...l }));
    }
    if (q.includes('SELECT t.id, t.type, t.tranid')) {
      return [...this.docs, ...this.others].filter((x) => ids.includes(x.id)).map((x) => ({ id: x.id, type: x.type, tranid: x.tranid }));
    }
    if (q === DEPOSIT_IDS_QUERY) return (this.ids ?? this.docs.map((x) => x.id)).sort((a, b) => a - b).map((id) => ({ id }));
    throw new Error(`unexpected query: ${q}`);
  };
}

function netsuite(): FakeNetSuite {
  const ns = new FakeNetSuite();
  ns.docs = [
    { id: 301, type: 'CustDep', tranid: 'DEP1', trandate: '9/10/2026', total: 500, status: 'C', label: 'Fully Applied', customer: 77, modified: '2026-09-20' },
    { id: 302, type: 'CustDep', tranid: 'DEP2', trandate: '9/11/2026', total: 0, status: 'V', label: 'Voided', customer: 78, modified: '2026-09-12' },
    { id: 303, type: 'CustDep', tranid: 'DEP3', trandate: '9/15/2026', total: 80, status: 'B', label: 'Deposited', customer: 79, modified: '2026-09-15' },
    { id: 311, type: 'DepAppl', tranid: 'DA11', trandate: '9/20/2026', total: -300, customer: 77, modified: '2026-09-20' },
    { id: 312, type: 'DepAppl', tranid: null, trandate: '10/2/2026', total: 200, customer: 77, modified: '2026-10-02' },
  ];
  ns.others = [{ id: 90, type: 'SalesOrd', tranid: 'SO90' }, { id: 501, type: 'CustInvc', tranid: 'INV501' }, { id: 502, type: 'CustInvc', tranid: 'INV502' }];
  ns.links = [
    { previousdoc: 90, nextdoc: 301, foreignamount: 500, linktype: 'Deposit' },
    { previousdoc: 301, nextdoc: 311, foreignamount: 300, linktype: 'Deposit Application' },
    // NetSuite lists the application to INV501 in two parts.
    { previousdoc: 501, nextdoc: 311, foreignamount: '-100.00', linktype: 'Payment' },
    { previousdoc: 501, nextdoc: 311, foreignamount: '-200.00', linktype: 'Payment' },
    { previousdoc: 301, nextdoc: 312, foreignamount: 200, linktype: 'Deposit Application' },
    { previousdoc: 502, nextdoc: 312, foreignamount: 200, linktype: 'Payment' },
  ];
  return ns;
}

describe('the copy job against the real functions', () => {
  let pg: PGlite;
  let clock = Date.parse('2026-10-15T13:16:00Z');
  const store = new Map<string, any>();

  beforeAll(async () => {
    pg = await freshDb();
    await pg.exec('SET ROLE service_role');
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  // sync_state in memory; every function the real one, called the way
  // supabase-js calls them: by name, with named arguments.
  const service = () => ({
    from: (table: string) => {
      if (table !== 'sync_state') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (_col: string, key: string) => ({
            maybeSingle: async () => ({
              data: store.has(key) ? { last_result: store.get(key).last_result, last_synced_at: store.get(key).last_synced_at ?? null } : null,
              error: null,
            }),
          }),
        }),
        upsert: async (row: Record<string, unknown>) => {
          store.set(row.sync_type as string, JSON.parse(JSON.stringify({ ...store.get(row.sync_type as string), ...row })));
          return { error: null };
        },
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const names = Object.keys(args);
      try {
        const r = await pg.query<{ r: unknown }>(
          `SELECT ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) AS r`,
          names.map((n) => JSON.stringify(args[n])),
        );
        return { data: r.rows[0].r, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    },
  }) as any;

  const run = (ns: FakeNetSuite, opts: { pageSize?: number; budgetMs?: number } = {}) => copyNetSuiteDeposits(service(), {
    deadline: clock + (opts.budgetMs ?? 240_000),
    deps: { query: ns.query, page: ns.page, pageSize: opts.pageSize ?? 2, now: () => clock },
  });
  const copied = async () => (await pg.query<{ id: string; type: string; number: string | null; date: string; total: string; voided: boolean; label: string | null; customer: string | null; links: Link[] | null; gone: boolean }>(
    `SELECT netsuite_id AS id, tran_type AS type, tranid AS number, to_char(trandate, 'YYYY-MM-DD') AS date, total::text AS total, voided,
            status_label AS label, customer_name AS customer, links, gone_at IS NOT NULL AS gone
     FROM gl_netsuite_deposits ORDER BY netsuite_id::int`,
  )).rows;
  const recorded = () => store.get(BOOKS_DEPOSITS_SYNC);

  it('copies every deposit and application, newest first a page at a time, with what each applies', async () => {
    const ns = netsuite();
    const r = await run(ns);
    expect(r).toMatchObject({ read: 5, added: 5, changed: 0, gone: 0, linkTable: 'nexttransactionlinelink' });
    expect(r.error).toBeUndefined();
    expect(r.partial).toBeUndefined();
    expect(ns.headerPages).toBe(3);
    expect(await copied()).toEqual([
      { id: '301', type: 'CustDep', number: 'DEP1', date: '2026-09-10', total: '500.00', voided: false, label: 'Fully Applied', customer: 'Customer Co 77', gone: false,
        links: [{ netsuite_id: '90', type: 'SalesOrd', number: 'SO90', amount: '500.00', link_type: 'Deposit' }] },
      { id: '302', type: 'CustDep', number: 'DEP2', date: '2026-09-11', total: '0.00', voided: true, label: 'Voided', customer: 'Customer Co 78', gone: false, links: [] },
      { id: '303', type: 'CustDep', number: 'DEP3', date: '2026-09-15', total: '80.00', voided: false, label: 'Deposited', customer: 'Customer Co 79', gone: false, links: [] },
      { id: '311', type: 'DepAppl', number: 'DA11', date: '2026-09-20', total: '300.00', voided: false, label: null, customer: 'Customer Co 77', gone: false,
        links: [
          { netsuite_id: '301', type: 'CustDep', number: 'DEP1', amount: '300.00', link_type: 'Deposit Application' },
          { netsuite_id: '501', type: 'CustInvc', number: 'INV501', amount: '300.00', link_type: 'Payment' },
        ] },
      { id: '312', type: 'DepAppl', number: null, date: '2026-10-02', total: '200.00', voided: false, label: null, customer: 'Customer Co 77', gone: false,
        links: [
          { netsuite_id: '301', type: 'CustDep', number: 'DEP1', amount: '200.00', link_type: 'Deposit Application' },
          { netsuite_id: '502', type: 'CustInvc', number: 'INV502', amount: '200.00', link_type: 'Payment' },
        ] },
    ]);
    // The window closed at the time it was opened, and the record holds counts and words, never an amount.
    const record = recorded();
    expect(record.last_synced_at).toBe(new Date(clock).toISOString());
    expect(record.last_result).toEqual({ read: 5, added: 5, changed: 0, gone: 0, linkTable: 'nexttransactionlinelink' });
  });

  it('reads only what NetSuite changed since the last run, a day\'s overlap included', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs[2] = { ...ns.docs[2], total: 85, modified: '2026-10-15' };
    const r = await run(ns);
    expect(r).toMatchObject({ read: 1, added: 0, changed: 1, gone: 0 });
    expect((await copied()).find((d) => d.id === '303')?.total).toBe('85.00');
  });

  it('carries on where a run cut short by time stopped, and closes the window only when it drains', async () => {
    store.delete(BOOKS_DEPOSITS_SYNC);
    const ns = netsuite();
    // Each page takes 25 s: with 50 s, the first run reads two pages.
    const saved: Array<string | null> = [];
    ns.onPage = () => {
      clock += 25_000;
      saved.push(recorded()?.last_result?.resume?.beforeId ?? null);
    };
    const opened = clock;
    const first = await run(ns, { budgetMs: 50_000 });
    expect(first).toMatchObject({ read: 4, partial: true });
    // Its place was saved after the first page, before the second was read, should the run be killed.
    expect(saved).toEqual([null, '311']);
    expect(recorded().last_result.resume).toEqual({ windowStartedAt: new Date(opened).toISOString(), since: '1999-12-31T00:00:00.000Z', beforeId: '302', processed: 4 });
    expect(recorded().last_synced_at).toBeUndefined();

    const second = await run(ns, { budgetMs: 240_000 });
    expect(second).toMatchObject({ read: 1, gone: 0 });
    expect(second.partial).toBeUndefined();
    expect(recorded().last_result.resume).toBeUndefined();
    expect(recorded().last_synced_at).toBe(new Date(opened).toISOString());
  });

  it('marks what NetSuite deleted as gone, and nothing when its list of ids looks cut short', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs = ns.docs.filter((d) => d.id !== 302);
    expect(await run(ns)).toMatchObject({ gone: 1 });
    expect((await copied()).find((d) => d.id === '302')?.gone).toBe(true);

    clock += 2 * 3600_000;
    ns.ids = [301];
    const r = await run(ns);
    expect(r).toMatchObject({ gone: 0 });
    expect(r.notes).toEqual(['NetSuite listed 1 deposits and applications and FleetSuite has 4, so none were marked gone.']);
    expect((await copied()).filter((d) => !d.gone).map((d) => d.id)).toEqual(['301', '303', '311', '312']);
  });

  it('reads the links from the other table when NetSuite refuses one, and keeps them when it refuses both', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    // NetSuite deleted DEP2 in the test before; it stays deleted.
    ns.docs = ns.docs.filter((d) => d.id !== 302);
    for (const d of ns.docs) d.modified = '2026-10-15';
    ns.refuse.add('nexttransactionlinelink');
    const r = await run(ns);
    expect(r).toMatchObject({ read: 4, linkTable: 'previoustransactionlinelink', changed: 0 });

    clock += 2 * 3600_000;
    ns.refuse.add('previoustransactionlinelink');
    ns.links = [];
    // DA11 changed in NetSuite too, so its row is rewritten in a run that can't read links.
    ns.docs = ns.docs.map((d) => (d.id === 311 ? { ...d, total: -310 } : d));
    const both = await run(ns);
    expect(both).toMatchObject({ read: 4, linkTable: null, changed: 1 });
    expect(both.notes).toEqual([
      "NetSuite wouldn't list what the documents are linked to (NetSuite SuiteQL error (400): Invalid search query. Detailed unprocessed "
        + "description follows. Search error occurred: Record 'previoustransactionlinelink' was not found.), so what each deposit "
        + "application applies isn't copied this time.",
    ]);
    expect((await copied()).find((d) => d.id === '311')).toMatchObject({ total: '310.00' });
    expect((await copied()).find((d) => d.id === '311')?.links).toHaveLength(2);
  });

  it('copies without the status in words when NetSuite won\'t give it, and says so', async () => {
    clock += 2 * 3600_000;
    const ns = netsuite();
    ns.docs = ns.docs.filter((d) => d.id !== 302).map((d) => ({ ...d, modified: '2026-10-15' }));
    ns.refuse.add('status_label');
    const r = await run(ns);
    expect(r.notes).toEqual(["NetSuite wouldn't give the documents' status in words, so voided ones aren't marked as voided."]);
    expect((await copied()).find((d) => d.id === '301')).toMatchObject({ label: null, voided: false });
  });

  it('records what failed, and keeps its place, when NetSuite stops answering', async () => {
    clock += 2 * 3600_000;
    store.delete(BOOKS_DEPOSITS_SYNC);
    const ns = netsuite();
    let pages = 0;
    ns.onPage = () => {
      if (++pages === 2) ns.down = true;
    };
    const r = await run(ns);
    // The second page was read, then NetSuite stopped answering: the copy picks up below the first page next time.
    expect(r.error).toBe('what deposits below NetSuite id 311 apply: NetSuite SuiteQL error (503): unavailable');
    expect(recorded().last_result).toMatchObject({ read: 4, error: r.error, resume: { beforeId: '311', processed: 2 } });
    expect(recorded().last_synced_at).toBeUndefined();
  });
});
