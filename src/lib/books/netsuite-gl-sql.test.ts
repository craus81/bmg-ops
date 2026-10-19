// Migration 361 keeps a copy of NetSuite's general ledger from 2025 beside
// the journal. This runs migrations 359–363 in an in-memory Postgres
// (PGlite) as the app's server login and holds the functions' rules, then
// runs the whole copy job against them with a fake NetSuite that answers
// the job's own SuiteQL, the starting entry by name (migration 406) with it.
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
  recordHeartbeat: vi.fn(async (service: any, syncType: string, lastResult: unknown, opts?: { touchLastSyncedAt?: boolean }) => {
    await service.from('sync_state').upsert({ sync_type: syncType, last_result: lastResult, synced: opts?.touchLastSyncedAt !== false });
    return { ok: true };
  }),
}));

import { BOOKS_GL_SYNC, PERIODS_QUERY, copyNetSuiteGl, monthsThatDiffer, type MonthRow } from './netsuite-gl';
import { monthStatuses, trialBalance, type TbData } from './trial-balance';

// A fresh database with Supabase's API roles and default grants, migrations
// 359–363 and 406 run twice as the owner, 1084 linked to subsidiary 5 (as
// the account sync does), then the app's server login.
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
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql',
    // The stock copy's functions, for the WHERE check below.
    '401-books-stock-by-item.sql', '402-books-stock-values.sql', '403-books-stock-item-setup.sql',
    '404-books-stock-ledger-parts.sql', '405-books-stock-account-items.sql',
    // The starting entry by name, which the copy job stores.
    '406-books-party-balances.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084'`);
  await pg.exec('SET ROLE service_role');
  return pg;
}

/**
 * The DELETE and UPDATE statements in a function body that have no WHERE
 * of their own. Supabase's API connections load the safeupdate extension,
 * which fails those even inside a function called through rpc; PGlite
 * doesn't have it, so the bodies are read for them instead.
 */
function unguardedWrites(body: string): string[] {
  // Comments and quoted text out first, keeping the code's shape.
  let code = '';
  for (let i = 0; i < body.length;) {
    if (body.startsWith('--', i)) {
      const end = body.indexOf('\n', i);
      i = end < 0 ? body.length : end;
    } else if (body.startsWith('/*', i)) {
      const end = body.indexOf('*/', i + 2);
      i = end < 0 ? body.length : end + 2;
    } else if (body[i] === "'") {
      let j = i + 1;
      while (j < body.length && !(body[j] === "'" && body[j + 1] !== "'")) j += body[j] === "'" ? 2 : 1;
      i = j + 1;
      code += "''";
    } else {
      code += body[i++];
    }
  }
  const found: string[] = [];
  const writes = /\b(?:DELETE\s+FROM\s+[\w."]+|UPDATE\s+(?:ONLY\s+)?[\w."]+(?:\s+(?:AS\s+)?(?!SET\b)\w+)?\s+SET)\b/gi;
  for (const m of code.matchAll(writes)) {
    // ON CONFLICT ... DO UPDATE belongs to an INSERT, which safeupdate leaves alone.
    if (/\bDO\s*$/i.test(code.slice(0, m.index))) continue;
    // The statement runs to its ';', or to the ')' that closes it inside a WITH.
    let depth = 0;
    let own = '';
    for (let i = m.index! + m[0].length; i < code.length; i++) {
      const ch = code[i];
      if (ch === '(') depth++;
      else if (ch === ')' && --depth < 0) break;
      else if (ch === ';' && depth === 0) break;
      else if (depth === 0) own += ch;
    }
    if (!/\bWHERE\b/i.test(own)) found.push(m[0].replace(/\s+/g, ' '));
  }
  return found;
}

type Applied = { received: number; replaced: number; unchanged: number; lines: number };

const line = (lineId: string, fields: Record<string, unknown> = {}) => ({
  line_id: lineId, company: 'BMG', netsuite_account_id: '10', debit: '0.00', credit: '0.00',
  memo: null, entity_id: null, location_id: null, department_id: null, class_id: null, ...fields,
});

const txn = (id: string, lines: ReturnType<typeof line>[], fields: Record<string, unknown> = {}) => ({
  netsuite_id: id, tran_type: 'Journal', tranid: `JE-${id}`, trandate: '2025-01-15', posting_month: '2025-01-01',
  posting_period_id: '102', lines, ...fields,
});

const balanced = (id: string, amount: string, fields: Record<string, unknown> = {}) => txn(id, [
  line('0', { debit: amount }),
  line('1', { netsuite_account_id: '40', credit: amount }),
], fields);

describe('the copy\'s functions', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); }, 60_000);
  afterAll(async () => { await db?.close(); });

  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0].r;
  const apply = (sweep: string, transactions: unknown[]) =>
    one<Applied>('SELECT gl_netsuite_apply($1::jsonb) AS r', [JSON.stringify({ sweep, transactions })]);
  const stored = async (id: string) => (await db.query<{ sweep: string; copied_at: string; posting_month: string }>(
    `SELECT sweep, copied_at::text AS copied_at, to_char(posting_month, 'YYYY-MM-DD') AS posting_month
     FROM gl_netsuite_transactions WHERE netsuite_id = $1`, [id],
  )).rows[0];
  const linesOf = async (id: string) => (await db.query<{ line_id: string; company: string; account: string; debit: string; credit: string; memo: string | null; month: string }>(
    `SELECT l.line_id, c.code AS company, l.netsuite_account_id AS account, l.debit::text AS debit, l.credit::text AS credit, l.memo,
            to_char(l.posting_month, 'YYYY-MM-DD') AS month
     FROM gl_netsuite_lines l JOIN gl_companies c ON c.id = l.company_id
     WHERE l.transaction_id = $1 ORDER BY l.line_id::int`, [id],
  )).rows;

  describe('gl_netsuite_apply', () => {
    it('copies a new transaction with its lines', async () => {
      const r = await apply('s1', [balanced('100', '25.00', { lines: [line('0', { debit: '25.00' }), line('1', { netsuite_account_id: '40', credit: '25.00', memo: 'Upfit' })] })]);
      expect(r).toEqual({ received: 1, replaced: 1, unchanged: 0, lines: 2 });
      expect(await linesOf('100')).toEqual([
        { line_id: '0', company: 'BMG', account: '10', debit: '25.00', credit: '0.00', memo: null, month: '2025-01-01' },
        { line_id: '1', company: 'BMG', account: '40', debit: '0.00', credit: '25.00', memo: 'Upfit', month: '2025-01-01' },
      ]);
    });

    it('only marks a transaction seen when nothing about it changed', async () => {
      const before = await stored('100');
      const same = [balanced('100', '25.00', { lines: [line('0', { debit: '25.00' }), line('1', { netsuite_account_id: '40', credit: '25.00', memo: 'Upfit' })] })];
      expect(await apply('s2', same)).toEqual({ received: 1, replaced: 0, unchanged: 1, lines: 0 });
      const after = await stored('100');
      expect(after.sweep).toBe('s2');
      expect(after.copied_at).toBe(before.copied_at);
    });

    it('rewrites a changed transaction whole, dropping lines NetSuite no longer has', async () => {
      const r = await apply('s3', [txn('100', [line('0', { debit: '30.00', company: '1084' }), line('2', { netsuite_account_id: '50', credit: '30.00' })], { posting_month: '2025-02-01' })]);
      expect(r).toEqual({ received: 1, replaced: 1, unchanged: 0, lines: 2 });
      expect(await linesOf('100')).toEqual([
        { line_id: '0', company: '1084', account: '10', debit: '30.00', credit: '0.00', memo: null, month: '2025-02-01' },
        { line_id: '2', company: 'BMG', account: '50', debit: '0.00', credit: '30.00', memo: null, month: '2025-02-01' },
      ]);
      expect((await stored('100')).posting_month).toBe('2025-02-01');
    });

    it('refuses a bad page whole, copying nothing from it', async () => {
      const good = balanced('101', '5.00');
      await expect(apply('s4', [good, txn('102', [line('0', { company: 'ACME' })])])).rejects.toThrow(/unknown company ACME/);
      await expect(apply('s4', [good, txn('102', [line('0', { debit: '1.005' })])])).rejects.toThrow(/more than two decimal places/);
      await expect(apply('s4', [good, txn('102', [])])).rejects.toThrow(/has no lines/);
      await expect(apply('s4', [good, txn('10a', [line('0')])])).rejects.toThrow(/bad NetSuite transaction id/);
      await expect(apply('s4', [good, txn('102', [line('0')], { posting_month: '2025-01-15' })])).rejects.toThrow(/no posting month/);
      await expect(apply('s4', [good, txn('102', [line('0')], { tran_type: ' ' })])).rejects.toThrow(/has no type/);
      await expect(apply(' ', [good])).rejects.toThrow(/sweep is required/);
      expect(await stored('101')).toBeUndefined();
    });
  });

  describe('gl_netsuite_finish_month', () => {
    it('removes the month\'s transactions the pass didn\'t see, and only that month\'s', async () => {
      await apply('a', [balanced('200', '1.00'), balanced('201', '2.00'), balanced('300', '3.00', { posting_month: '2025-02-01' })]);
      await apply('b', [balanced('200', '1.00')]);
      expect(await one<number>(`SELECT gl_netsuite_finish_month('2025-01-01', 'b') AS r`)).toBe(1);
      expect(await stored('201')).toBeUndefined();
      expect(await linesOf('201')).toEqual([]);
      expect(await stored('200')).toMatchObject({ sweep: 'b' });
      expect(await stored('300')).toMatchObject({ sweep: 'a' });
      expect(await one<number>(`SELECT gl_netsuite_finish_month('2025-01-01', 'b') AS r`)).toBe(0);
    });

    it('takes only the first of a month and a sweep', async () => {
      await expect(one(`SELECT gl_netsuite_finish_month('2025-01-15', 'b') AS r`)).rejects.toThrow(/first of a month/);
      await expect(one(`SELECT gl_netsuite_finish_month('2025-01-01', '') AS r`)).rejects.toThrow(/sweep is required/);
    });
  });

  describe('gl_netsuite_store_totals and gl_netsuite_totals', () => {
    const store = (p: unknown) => one<{ opening: number; months: number }>('SELECT gl_netsuite_store_totals($1::jsonb) AS r', [JSON.stringify(p)]);
    const totals = (company: string | null) => one<{ opening: any[]; netsuite: any[]; copied: any[] }>('SELECT gl_netsuite_totals($1) AS r', [company]);
    const OPENING = [
      { company: 'BMG', netsuite_account_id: '10', debit: '1000.00', credit: '0.00', line_count: 3 },
      { company: '1084', netsuite_account_id: '10', debit: '200.00', credit: '0.00', line_count: 1 },
    ];
    const MONTHS = [{ company: 'BMG', netsuite_account_id: '10', month: '2025-01-01', debit: '40.00', credit: '10.00', line_count: 2 }];

    it('stores NetSuite\'s totals, replacing the last ones', async () => {
      expect(await store({ opening: [OPENING[0]], months: [] })).toEqual({ opening: 1, months: 0 });
      expect(await store({ opening: OPENING, months: MONTHS })).toEqual({ opening: 2, months: 1 });
      const bmg = await totals('BMG');
      expect(bmg.opening).toEqual([{ company: 'BMG', netsuite_account_id: '10', debit: '1000.00', credit: '0.00', line_count: 3 }]);
      expect(bmg.netsuite).toEqual(MONTHS);
      expect((await totals(null)).opening).toHaveLength(2);
    });

    it('works out the copy\'s totals per company, account and month', async () => {
      const bmg = await totals('BMG');
      // From the transactions above: 100 (moved to February), 200, 300.
      expect(bmg.copied).toEqual([
        { company: 'BMG', netsuite_account_id: '10', month: '2025-01-01', debit: '1.00', credit: '0.00', line_count: 1 },
        { company: 'BMG', netsuite_account_id: '10', month: '2025-02-01', debit: '3.00', credit: '0.00', line_count: 1 },
        { company: 'BMG', netsuite_account_id: '40', month: '2025-01-01', debit: '0.00', credit: '1.00', line_count: 1 },
        { company: 'BMG', netsuite_account_id: '40', month: '2025-02-01', debit: '0.00', credit: '3.00', line_count: 1 },
        { company: 'BMG', netsuite_account_id: '50', month: '2025-02-01', debit: '0.00', credit: '30.00', line_count: 1 },
      ]);
      expect((await totals('1084')).copied).toEqual([
        { company: '1084', netsuite_account_id: '10', month: '2025-02-01', debit: '30.00', credit: '0.00', line_count: 1 },
      ]);
    });

    it('keeps the stored totals when NetSuite\'s come back empty or name a company that doesn\'t exist', async () => {
      await expect(store({ opening: [], months: [] })).rejects.toThrow(/came back empty/);
      await expect(store({ opening: [{ ...OPENING[0], company: 'ACME' }], months: [] })).rejects.toThrow(/company that doesn't exist/);
      await expect(store({ opening: OPENING })).rejects.toThrow(/must be lists/);
      expect((await totals(null)).opening).toHaveLength(2);
      // With nothing stored, an empty list is just an empty list.
      await db.exec('DELETE FROM gl_netsuite_opening; DELETE FROM gl_netsuite_month_totals;');
      expect(await store({ opening: [], months: [] })).toEqual({ opening: 0, months: 0 });
    });
  });

  describe('gl_netsuite_claim_copy', () => {
    const claim = (holder: string, seconds = 60) => one<boolean>('SELECT gl_netsuite_claim_copy($1, $2) AS r', [holder, seconds]);
    const release = (holder: string) => db.query('SELECT gl_netsuite_release_copy($1)', [holder]);

    it('lets one copy run at a time, until it lets go or its claim runs out', async () => {
      expect(await claim('run-a')).toBe(true);
      expect(await claim('run-b')).toBe(false);
      expect(await claim('run-a')).toBe(true);
      await release('run-b');
      expect(await claim('run-b')).toBe(false);
      await release('run-a');
      expect(await claim('run-b')).toBe(true);
      await db.exec(`UPDATE gl_netsuite_copy_lock SET held_until = now() - interval '1 second'`);
      expect(await claim('run-c')).toBe(true);
      await release('run-c');
    });

    it('takes a holder and a claim of 1 to 900 seconds', async () => {
      await expect(claim(' ')).rejects.toThrow(/holder is required/);
      await expect(claim('run-d', 0)).rejects.toThrow(/1 to 900 seconds/);
      await expect(claim('run-d', 901)).rejects.toThrow(/1 to 900 seconds/);
    });
  });

  it('is open to the service role only', async () => {
    const functions = [
      'gl_netsuite_apply(jsonb)', 'gl_netsuite_finish_month(date, text)', 'gl_netsuite_store_totals(jsonb)',
      'gl_netsuite_totals(text)', 'gl_netsuite_claim_copy(text, integer)', 'gl_netsuite_release_copy(text)',
      'gl_netsuite_store_opening_parties(jsonb)',
    ];
    const tables = [
      'gl_netsuite_transactions', 'gl_netsuite_lines', 'gl_netsuite_opening', 'gl_netsuite_month_totals', 'gl_netsuite_copy_lock',
      'gl_netsuite_opening_parties',
    ];
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const f of functions) {
        expect(await one<boolean>(`SELECT has_function_privilege($1::name, $2::text, 'EXECUTE') AS r`, [role, f]), `${role} ${f}`).toBe(role === 'service_role');
      }
      for (const t of tables) {
        expect(await one<boolean>(`SELECT has_table_privilege($1::name, $2::text, 'SELECT') AS r`, [role, t]), `${role} ${t}`).toBe(role === 'service_role');
      }
    }
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1) ORDER BY relname`, [tables],
    );
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
    expect(rls.rows).toHaveLength(tables.length);
  });

  // The first copy in production stopped at migration 361's
  // gl_netsuite_store_totals: "DELETE requires a WHERE clause".
  it('gives every DELETE and UPDATE in the books functions a WHERE, as Supabase\'s API requires', async () => {
    const functions = (await db.query<{ name: string; body: string }>(
      `SELECT p.proname AS name, p.prosrc AS body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'gl\\_%' ORDER BY p.proname`,
    )).rows;
    expect(functions.map((f) => f.name)).toEqual(expect.arrayContaining([
      'gl_netsuite_store_totals', 'gl_netsuite_lists_finish', 'gl_netsuite_stock_apply', 'gl_netsuite_stock_store_counts',
      'gl_netsuite_store_opening_parties',
    ]));
    expect(functions.flatMap((f) => unguardedWrites(f.body).map((w) => `${f.name}: ${w}`))).toEqual([]);
  });

  it('finds a DELETE or UPDATE with no WHERE of its own', () => {
    const migration361 = readFileSync(path.resolve(__dirname, '../../../migrations/361-books-netsuite-gl.sql'), 'utf8');
    expect(unguardedWrites(migration361)).toEqual(['DELETE FROM public.gl_netsuite_opening', 'DELETE FROM public.gl_netsuite_month_totals']);
    expect(unguardedWrites(`
      DELETE FROM a;
      delete from b where true;
      UPDATE public.c x SET n = (SELECT 1 FROM d WHERE d.id = x.id);
      UPDATE e SET n = 1 WHERE id = 2;
      INSERT INTO f VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 2;
      WITH g AS (DELETE FROM h RETURNING *) SELECT 1 FROM g WHERE true;
      SELECT 1 FROM i WHERE n = 1 FOR UPDATE;
      -- DELETE FROM j;
      RAISE EXCEPTION 'DELETE FROM k; it''s refused';
    `)).toEqual(['DELETE FROM a', 'UPDATE public.c x SET', 'DELETE FROM h']);
  });
});

// ── The whole job ──────────────────────────────────────────────────────────

/** One GL line as NetSuite holds it. Amounts and accounts are made up. */
interface NsLine {
  txn: number;
  line: number;
  sub: number | null;
  account: number | null;
  debit?: number;
  credit?: number;
  date: string;
  period?: number | null;
  type?: string;
  memo?: string;
  /** TransactionLine.entity, the line's own name; its transaction's is 300 + txn. */
  entity?: number;
  /** TransactionAccountingLine.posting; false = a non-posting line. */
  posting?: boolean;
  /** Transaction.posting. */
  txnPosting?: boolean;
}

// Subsidiary 2 is BMG, 5 is 1084, 9 is linked to no company. Accounts: 10
// cash, 20 receivables, 25 payables, 30 retained earnings, 40 sales, 50
// expenses, 60 rent income, 70 intercompany.
const BOOKS: NsLine[] = [
  // Before 2025: the starting entry. The first has no period, so it counts by date.
  { txn: 1, line: 0, sub: 2, account: 10, debit: 1000, date: '2024-06-30' },
  { txn: 1, line: 1, sub: 2, account: 30, credit: 1000, date: '2024-06-30' },
  { txn: 2, line: 0, sub: 2, account: 20, debit: 500, date: '2024-12-15', period: 101, type: 'CustInvc', entity: 900 },
  { txn: 2, line: 1, sub: 2, account: 40, credit: 500, date: '2024-12-15', period: 101, type: 'CustInvc' },
  // January 2025, including one dated December but posted to January.
  { txn: 3, line: 0, sub: 2, account: 20, debit: 200, date: '2025-01-10', period: 102, type: 'CustInvc' },
  { txn: 3, line: 1, sub: 2, account: 40, credit: 200, date: '2025-01-10', period: 102, type: 'CustInvc', memo: 'Upfit' },
  // A line that posts nowhere: no account, no amount. Not copied, and no note.
  { txn: 3, line: 2, sub: 2, account: null, date: '2025-01-10', period: 102, type: 'CustInvc' },
  { txn: 4, line: 0, sub: 2, account: 10, debit: 200, date: '2025-01-20', period: 102, type: 'CustPymt' },
  { txn: 4, line: 1, sub: 2, account: 20, credit: 200, date: '2025-01-20', period: 102, type: 'CustPymt' },
  { txn: 5, line: 0, sub: 2, account: 50, debit: 50, date: '2024-12-31', period: 102 },
  { txn: 5, line: 1, sub: 2, account: 10, credit: 50, date: '2024-12-31', period: 102 },
  // February 2025: both companies, and an intercompany entry half in a subsidiary not linked.
  { txn: 6, line: 0, sub: 2, account: 50, debit: 300, date: '2025-02-05', period: 103, type: 'VendBill' },
  { txn: 6, line: 1, sub: 2, account: 25, credit: 300, date: '2025-02-05', period: 103, type: 'VendBill' },
  { txn: 7, line: 0, sub: 5, account: 10, debit: 100, date: '2025-02-01', period: 103 },
  { txn: 7, line: 1, sub: 5, account: 60, credit: 100, date: '2025-02-01', period: 103 },
  { txn: 8, line: 0, sub: 2, account: 10, debit: 10, date: '2025-02-20', period: 103 },
  { txn: 8, line: 1, sub: 2, account: 70, credit: 10, date: '2025-02-20', period: 103 },
  { txn: 8, line: 2, sub: 9, account: 70, debit: 10, date: '2025-02-20', period: 103 },
  { txn: 8, line: 3, sub: 9, account: 10, credit: 10, date: '2025-02-20', period: 103 },
  // March 2025.
  { txn: 9, line: 0, sub: 2, account: 10, debit: 75, date: '2025-03-03', period: 104, type: 'CashSale' },
  { txn: 9, line: 1, sub: 2, account: 40, credit: 75, date: '2025-03-03', period: 104, type: 'CashSale' },
  // Never copied or counted: a non-posting line, and a non-posting
  // transaction whose lines say otherwise.
  { txn: 10, line: 0, sub: 2, account: 20, debit: 999, date: '2025-03-05', period: 104, type: 'Estimate', posting: false },
  { txn: 11, line: 0, sub: 2, account: 10, debit: 5, date: '2025-03-06', period: 104, txnPosting: false },
  { txn: 11, line: 1, sub: 2, account: 40, credit: 5, date: '2025-03-06', period: 104, txnPosting: false },
];

const NS_PERIODS = [
  { id: 101, startdate: '12/1/2024', enddate: '12/31/2024', isquarter: 'F', isyear: 'F' },
  { id: 102, startdate: '1/1/2025', enddate: '1/31/2025', isquarter: 'F', isyear: 'F' },
  { id: 103, startdate: '2/1/2025', enddate: '2/28/2025', isquarter: 'F', isyear: 'F' },
  { id: 104, startdate: '3/1/2025', enddate: '3/31/2025', isquarter: 'F', isyear: 'F' },
  { id: 110, startdate: '1/1/2025', enddate: '3/31/2025', isquarter: 'T', isyear: 'F' },
];

const CHART: TbData['accounts'] = [
  { netsuite_account_id: '10', number: '1000', name: 'Cash', account_type: 'bank', statement: 'balance_sheet' },
  { netsuite_account_id: '20', number: '1200', name: 'Receivables', account_type: 'accounts_receivable', statement: 'balance_sheet' },
  { netsuite_account_id: '25', number: '2000', name: 'Payables', account_type: 'accounts_payable', statement: 'balance_sheet' },
  { netsuite_account_id: '30', number: '3900', name: 'Retained Earnings', account_type: 'equity', statement: 'balance_sheet' },
  { netsuite_account_id: '40', number: '4000', name: 'Sales', account_type: 'income', statement: 'income_statement' },
  { netsuite_account_id: '50', number: '6000', name: 'Expenses', account_type: 'expense', statement: 'income_statement' },
  { netsuite_account_id: '70', number: '1900', name: 'Intercompany', account_type: 'other_current_asset', statement: 'balance_sheet' },
];

type Row = Record<string, unknown>;

const usDate = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}/${iso.slice(0, 4)}`;
const rejected = (what: string) => Object.assign(new Error(`NetSuite SuiteQL error (400): ${what}`), { status: 400 });
// NetSuite leaves empty fields out of its JSON.
const compact = (r: Row): Row => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== undefined));
const byTxnLine = (a: NsLine, b: NsLine) => a.txn - b.txn || a.line - b.line;
/** The read of the starting entry by name: the only grouped read that names the lines' customers and vendors. */
const isNamesRead = (q: string) => q.includes('GROUP BY') && q.includes('tl.entity');
/** The ids in a query's `<column> IN (...)`, or null when it has none. */
const listed = (q: string, re: RegExp) => q.match(re)?.[1].split(',').map((s) => Number(s.trim())) ?? null;

/**
 * Answers the job's SuiteQL from a list of lines: the periods, the totals,
 * and month and transaction line reads, evaluating the WHERE clauses the
 * job actually builds (posting flags, period lists, date bounds, keyset).
 */
class FakeNetSuite {
  lines: NsLine[];
  refuse = { periods: false, txnPosting: false, extraColumns: false, noAccountTypes: false, partyOpening: false };
  /** Transactions the line reads miss though the totals count them. */
  unreadable = new Set<number>();
  /** A line the line reads return twice, as with a second accounting book. */
  twice: { txn: number; line: number } | null = null;
  /** Runs on every page read, so a test can spend the run's time. */
  onPage = () => {};
  queries: string[] = [];

  constructor(lines: NsLine[]) {
    this.lines = lines.map((l) => ({ ...l }));
  }

  private posted(q: string): NsLine[] {
    const both = q.includes("t.posting = 'T' AND tal.posting = 'T'");
    if (both && this.refuse.txnPosting) throw rejected("Search error occurred: Field 'posting' for record 'transaction' was not found.");
    if (q.includes('tl.memo') && this.refuse.extraColumns) throw rejected("Search error occurred: Field 'memo' was not found.");
    if (!q.includes("tal.posting = 'T'")) throw new Error('every GL read filters on the line\'s posting flag');
    const withAccount = q.includes('tal.account IS NOT NULL');
    return this.lines.filter((l) => l.posting !== false && (!both || l.txnPosting !== false) && (!withAccount || l.account !== null));
  }

  private row(l: NsLine, q: string): Row {
    const r: Row = {
      txn_id: l.txn, line_id: l.line, account_id: l.account, debit: l.debit, credit: l.credit, subsidiary_id: l.sub,
      tran_type: l.type ?? 'Journal', tranid: `T-${l.txn}`, trandate: usDate(l.date), period_id: l.period,
    };
    if (q.includes('tl.memo')) Object.assign(r, { memo: l.memo, line_entity_id: l.entity, txn_entity_id: 300 + l.txn, location_id: 1 });
    return compact(r);
  }

  query = async (q: string): Promise<Row[]> => {
    this.queries.push(q);
    if (q === PERIODS_QUERY) {
      if (this.refuse.periods) throw rejected("Record 'accountingperiod' was not found.");
      return NS_PERIODS;
    }
    if (q.includes('tal.account IS NULL')) {
      if (this.refuse.noAccountTypes) throw rejected('Search error occurred: Invalid or unsupported search.');
      const subs = q.match(/tl\.subsidiary IN \(([\d, ]+)\)/)?.[1].split(',').map((s) => Number(s.trim())) ?? [];
      const counts = new Map<string, number>();
      for (const l of this.posted(q)) {
        if (l.account !== null || !(l.debit || l.credit) || !subs.includes(l.sub ?? -1)) continue;
        counts.set(l.type ?? 'Journal', (counts.get(l.type ?? 'Journal') ?? 0) + 1);
      }
      return [...counts].map(([tran_type, line_count]) => ({ tran_type, line_count }));
    }
    if (isNamesRead(q)) {
      // The starting entry by name: the accounts listed, before the date or in the periods listed.
      if (this.refuse.partyOpening) throw rejected("Search error occurred: Field 'entity' was not found.");
      const accounts = listed(q, /tal\.account IN \(([\d, ]+)\)/) ?? [];
      const early = listed(q, /t\.postingperiod IN \(([\d, ]+)\)/) ?? [];
      const m = q.match(/t\.trandate < TO_DATE\('(\d{2})\/01\/(\d{4})', 'MM\/DD\/YYYY'\)/);
      if (!m) throw new Error(`no date bound in ${q}`);
      const before = `${m[2]}-${m[1]}-01`;
      const groups = new Map<string, Row & { debit: number; credit: number; line_count: number }>();
      for (const l of this.posted(q)) {
        if (!accounts.includes(l.account ?? -1) || !(l.date < before || early.includes(l.period ?? -1))) continue;
        const key = [l.sub, l.account, l.entity, l.txn, l.period, l.date.slice(0, 7)].join('|');
        const g = groups.get(key) ?? {
          subsidiary_id: l.sub, account_id: l.account, line_entity_id: l.entity, txn_entity_id: 300 + l.txn,
          period_id: l.period, date_month: l.date.slice(0, 7), debit: 0, credit: 0, line_count: 0,
        };
        g.debit += l.debit ?? 0;
        g.credit += l.credit ?? 0;
        g.line_count += 1;
        groups.set(key, g);
      }
      return [...groups.values()].map(compact);
    }
    if (q.includes('GROUP BY')) {
      const groups = new Map<string, Row & { debit: number; credit: number; line_count: number }>();
      for (const l of this.posted(q)) {
        const key = [l.sub, l.account, l.period, l.date.slice(0, 7)].join('|');
        const g = groups.get(key) ?? { subsidiary_id: l.sub, account_id: l.account, period_id: l.period, date_month: l.date.slice(0, 7), debit: 0, credit: 0, line_count: 0 };
        g.debit += l.debit ?? 0;
        g.credit += l.credit ?? 0;
        g.line_count += 1;
        groups.set(key, g);
      }
      return [...groups.values()].map(compact);
    }
    const one = q.match(/tal\.transaction = (\d+)/);
    if (one) return this.posted(q).filter((l) => l.txn === Number(one[1])).sort(byTxnLine).map((l) => this.row(l, q));
    throw new Error(`unexpected query ${q}`);
  };

  page = async (q: string, limit: number): Promise<Row[]> => {
    this.queries.push(q);
    this.onPage();
    const inPeriods = listed(q, /t\.postingperiod IN \(([\d, ]+)\)/);
    const notInPeriods = listed(q, /t\.postingperiod NOT IN \(([\d, ]+)\)/);
    const bound = (op: string) => {
      const m = q.match(new RegExp(`t\\.trandate ${op} TO_DATE\\('(\\d{2})/01/(\\d{4})', 'MM/DD/YYYY'\\)`));
      if (!m) throw new Error(`no ${op} date bound in ${q}`);
      return `${m[2]}-${m[1]}-01`;
    };
    const from = bound('>=');
    const to = bound('<');
    const after = Number(q.match(/tal\.transaction > (\d+)/)?.[1] ?? -1);
    const inMonth = (l: NsLine) => (inPeriods ?? []).includes(l.period ?? -1)
      || ((!notInPeriods || l.period == null || !notInPeriods.includes(l.period)) && l.date >= from && l.date < to);
    const rows = this.posted(q).filter((l) => !this.unreadable.has(l.txn) && inMonth(l) && l.txn > after);
    const twice = this.twice && rows.find((l) => l.txn === this.twice!.txn && l.line === this.twice!.line);
    if (twice) rows.push(twice);
    return rows.sort(byTxnLine).slice(0, limit).map((l) => this.row(l, q));
  };

  edit(txn: number, change: (l: NsLine) => void) {
    for (const l of this.lines) if (l.txn === txn) change(l);
  }
}

const JAN = '2025-01-01';
const FEB = '2025-02-01';
const MAR = '2025-03-01';
const HOUR = 3_600_000;

describe('the copy job against the real functions', () => {
  let pg: PGlite;
  let clock = Date.parse('2025-03-15T12:00:00Z');
  const store = new Map<string, any>();

  beforeAll(async () => {
    pg = await freshDb();
    // The chart's receivable and payable accounts, for the starting entry by name.
    await pg.exec(`
      INSERT INTO gl_accounts (number, name, account_type, netsuite_account_id) VALUES
        ('1200', 'Receivables', 'accounts_receivable', '20'), ('2000', 'Payables', 'accounts_payable', '25');
    `);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  // sync_state in memory; gl_companies and every function the real ones,
  // called the way supabase-js calls them: by name, with named arguments.
  const service = () => ({
    from: (table: string) => {
      if (table === 'sync_state') {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: async () => ({ data: store.has(key) ? { last_result: store.get(key).last_result } : null, error: null }),
            }),
          }),
          upsert: async (row: Record<string, unknown>) => {
            store.set(row.sync_type as string, JSON.parse(JSON.stringify({ ...store.get(row.sync_type as string), ...row })));
            return { error: null };
          },
        };
      }
      if (table === 'gl_companies') {
        return { select: async (cols: string) => ({ data: (await pg.query(`SELECT ${cols} FROM gl_companies ORDER BY code`)).rows, error: null }) };
      }
      if (table === 'gl_accounts') {
        return {
          select: (cols: string) => ({
            in: (col: string, values: string[]) => ({
              not: async (notCol: string, op: string, value: null) => {
                if (op !== 'is' || value !== null) throw new Error(`unexpected filter ${notCol} ${op} ${value}`);
                const r = await pg.query(`SELECT ${cols} FROM gl_accounts WHERE ${col} = ANY($1) AND ${notCol} IS NOT NULL ORDER BY number`, [values]);
                return { data: r.rows, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const names = Object.keys(args);
      try {
        const r = await pg.query<{ r: unknown }>(
          `SELECT ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) AS r`,
          names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n])),
        );
        return { data: r.rows[0].r, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    },
  }) as any;

  const run = (ns: FakeNetSuite, opts: { pageSize?: number; budgetMs?: number } = {}) => copyNetSuiteGl(service(), {
    deadline: clock + (opts.budgetMs ?? 240_000),
    deps: { query: ns.query, page: ns.page, pageSize: opts.pageSize, now: () => clock },
  });

  const totals = async (company: string | null) =>
    (await pg.query<{ r: { opening: MonthRow[]; netsuite: MonthRow[]; copied: MonthRow[] } }>('SELECT gl_netsuite_totals($1) AS r', [company])).rows[0].r;
  /** Months where the copy and NetSuite's totals still differ. */
  const outOfStep = async () => {
    const t = await totals(null);
    return monthsThatDiffer(t.netsuite, t.copied);
  };
  const copied = async () => (await pg.query<{ txn: string; line: string; company: string; month: string; debit: string; credit: string; memo: string | null }>(
    `SELECT l.transaction_id AS txn, l.line_id AS line, c.code AS company, to_char(l.posting_month, 'YYYY-MM-DD') AS month,
            l.debit::text AS debit, l.credit::text AS credit, l.memo
     FROM gl_netsuite_lines l JOIN gl_companies c ON c.id = l.company_id
     ORDER BY l.transaction_id::int, l.line_id::int`,
  )).rows;
  const copiedAt = async () => (await pg.query<{ id: string; at: string }>(
    'SELECT netsuite_id AS id, copied_at::text AS at FROM gl_netsuite_transactions ORDER BY netsuite_id',
  )).rows;
  const record = () => store.get(BOOKS_GL_SYNC);
  const openingNames = async () => (await pg.query<{ company: string; account: string; entity: string; debit: string; credit: string; lines: number }>(
    `SELECT c.code AS company, o.netsuite_account_id AS account, o.entity_id AS entity, o.debit::text AS debit, o.credit::text AS credit,
            o.line_count AS lines
     FROM gl_netsuite_opening_parties o JOIN gl_companies c ON c.id = o.company_id
     ORDER BY c.code, o.netsuite_account_id, o.entity_id`,
  )).rows;
  const startOver = async () => {
    await pg.exec(`
      DELETE FROM gl_netsuite_transactions; DELETE FROM gl_netsuite_opening; DELETE FROM gl_netsuite_month_totals;
      DELETE FROM gl_netsuite_opening_parties;
    `);
    store.clear();
    clock = Date.parse('2025-03-15T12:00:00Z');
  };

  describe('kept in step with NetSuite', () => {
    const ns = new FakeNetSuite(BOOKS);

    it('copies every month from 2025 and ends up matching NetSuite', async () => {
      const r = await run(ns);
      expect(r.error).toBeUndefined();
      expect(r).toMatchObject({
        monthsBy: 'posting_period',
        monthsChecked: 3,
        monthsDiffering: [JAN, FEB, MAR],
        swept: [JAN, FEB, MAR],
        transactionsCopied: 7,
        transactionsUnchanged: 0,
        transactionsRemoved: 0,
        linesCopied: 14,
      });
      expect(r.partial).toBeUndefined();
      expect(r.notes).toEqual(["NetSuite subsidiary 9 has 2 GL lines that aren't copied, because no company here is linked to it."]);
      expect(await outOfStep()).toEqual([]);
      expect(record()).toMatchObject({ synced: true, last_result: { resume: null, swept: [JAN, FEB, MAR] } });

      const rows = await copied();
      expect(rows.filter((r) => r.txn === '5').map((r) => r.month)).toEqual([JAN, JAN]);
      expect(rows.some((r) => ['1', '2', '10', '11'].includes(r.txn))).toBe(false);
      expect(rows.filter((r) => r.txn === '8')).toEqual([
        { txn: '8', line: '0', company: 'BMG', month: FEB, debit: '10.00', credit: '0.00', memo: null },
        { txn: '8', line: '1', company: 'BMG', month: FEB, debit: '0.00', credit: '10.00', memo: null },
      ]);
      expect(rows.filter((r) => r.company === '1084').map((r) => r.txn)).toEqual(['7', '7']);
    });

    it('starts each company from NetSuite\'s balances before 2025', async () => {
      expect((await totals(null)).opening).toEqual([
        { company: 'BMG', netsuite_account_id: '10', debit: '1000.00', credit: '0.00', line_count: 1 },
        { company: 'BMG', netsuite_account_id: '20', debit: '500.00', credit: '0.00', line_count: 1 },
        { company: 'BMG', netsuite_account_id: '30', debit: '0.00', credit: '1000.00', line_count: 1 },
        { company: 'BMG', netsuite_account_id: '40', debit: '0.00', credit: '500.00', line_count: 1 },
      ]);
    });

    it('keeps, by name, the part of it on the receivable and payable accounts', async () => {
      // The December invoice's line names its customer, which stands before its transaction's.
      expect(await openingNames()).toEqual([{ company: 'BMG', account: '20', entity: '900', debit: '500.00', credit: '0.00', lines: 1 }]);
      expect(record().last_result).toMatchObject({ openingNames: 1 });
      // Read only for the accounts with lines before 2025, those before the date or in a period before 2025.
      const read = ns.queries.find(isNamesRead)!;
      expect(read).toContain('tal.account IN (20)');
      expect(read).toContain("t.trandate < TO_DATE('01/01/2025', 'MM/DD/YYYY') OR t.postingperiod IN (101)");
    });

    it('shows a trial balance that matches NetSuite\'s every month, and balances', async () => {
      const t = await totals('BMG');
      const data: TbData = { company: 'BMG', accounts: CHART, opening: t.opening, netsuite: t.netsuite, copied: t.copied };
      expect(monthStatuses(data, MAR)).toEqual([
        { month: JAN, matches: true, differing: 0 },
        { month: FEB, matches: true, differing: 0 },
        { month: MAR, matches: true, differing: 0 },
      ]);
      const march = trialBalance(data, MAR);
      expect(march.totals.copied).toEqual(march.totals.netsuite);
      expect(march.totals.copied.debit).toBe(march.totals.copied.credit);
      // Last year's sales sit in retained earnings; this year's are year to date.
      expect(march.rows.find((r) => r.netsuiteAccountId === '30')).toMatchObject({ copied: -150000 });
      expect(march.rows.find((r) => r.netsuiteAccountId === '40')).toMatchObject({ copied: -27500 });
    });

    it('rewrites nothing on the next run, and refreshes the month copied longest ago', async () => {
      const before = await copiedAt();
      clock += 2 * HOUR;
      const r = await run(ns);
      expect(r).toMatchObject({ monthsDiffering: [], swept: [JAN], transactionsCopied: 0, transactionsUnchanged: 3, transactionsRemoved: 0, linesCopied: 0 });
      expect(await copiedAt()).toEqual(before);
      clock += 2 * HOUR;
      expect((await run(ns)).swept).toEqual([FEB]);
      clock += 2 * HOUR;
      expect((await run(ns)).swept).toEqual([MAR]);
    });

    it('follows edits, deletes and new transactions', async () => {
      ns.lines = ns.lines.filter((l) => l.txn !== 4);
      ns.edit(6, (l) => { if (l.debit) l.debit = 350; else l.credit = 350; });
      ns.lines.push(
        { txn: 12, line: 0, sub: 2, account: 50, debit: 25, date: '2025-03-20', period: 104 },
        { txn: 12, line: 1, sub: 2, account: 10, credit: 25, date: '2025-03-20', period: 104 },
      );
      clock += 2 * HOUR;
      const r = await run(ns);
      expect(r).toMatchObject({
        monthsDiffering: [JAN, FEB, MAR],
        swept: [JAN, FEB, MAR],
        transactionsCopied: 2,
        transactionsUnchanged: 5,
        transactionsRemoved: 1,
        linesCopied: 4,
      });
      expect(await outOfStep()).toEqual([]);
      const rows = await copied();
      expect(rows.some((r) => r.txn === '4')).toBe(false);
      expect(rows.filter((r) => r.txn === '6').map((r) => [r.debit, r.credit])).toEqual([['350.00', '0.00'], ['0.00', '350.00']]);
      expect(rows.filter((r) => r.txn === '12')).toHaveLength(2);
    });

    it('brings across an edit that moves no money when it refreshes that month', async () => {
      ns.edit(3, (l) => { if (l.line === 1) l.memo = 'Upfit, second unit'; });
      clock += 2 * HOUR;
      const r = await run(ns);
      expect(r).toMatchObject({ monthsDiffering: [], swept: [JAN], transactionsCopied: 1, transactionsUnchanged: 1 });
      expect((await copied()).find((r) => r.txn === '3' && r.line === '1')?.memo).toBe('Upfit, second unit');
    });

    it('moves a transaction NetSuite moved to another month', async () => {
      ns.edit(9, (l) => { l.date = '2025-02-27'; l.period = 103; });
      clock += 2 * HOUR;
      const r = await run(ns);
      expect(r).toMatchObject({ monthsDiffering: [FEB, MAR], transactionsCopied: 1, transactionsRemoved: 0 });
      expect(r.swept?.slice(0, 2)).toEqual([FEB, MAR]);
      expect(await outOfStep()).toEqual([]);
      expect((await copied()).filter((r) => r.txn === '9').map((r) => r.month)).toEqual([FEB, FEB]);
    });
  });

  describe('runs that need care', () => {
    // A transaction too big for a page of three lines.
    const BIG: NsLine[] = [
      { txn: 13, line: 0, sub: 2, account: 50, debit: 10, date: '2025-03-10', period: 104 },
      { txn: 13, line: 1, sub: 2, account: 50, debit: 10, date: '2025-03-10', period: 104 },
      { txn: 13, line: 2, sub: 2, account: 50, debit: 10, date: '2025-03-10', period: 104 },
      { txn: 13, line: 3, sub: 2, account: 10, credit: 30, date: '2025-03-10', period: 104 },
    ];

    it('reads in pages without losing or repeating a line', async () => {
      await startOver();
      const ns = new FakeNetSuite([...BOOKS, ...BIG]);
      const r = await run(ns, { pageSize: 3 });
      expect(r.error).toBeUndefined();
      expect(r).toMatchObject({ swept: [JAN, FEB, MAR], transactionsCopied: 8, linesCopied: 18 });
      expect(await outOfStep()).toEqual([]);
      expect(await copied()).toHaveLength(18);
      // Transactions that fill a page are read whole.
      expect(ns.queries.filter((q) => /tal\.transaction = \d+/.test(q)).map((q) => q.match(/tal\.transaction = (\d+)/)![1])).toEqual(['8', '13']);
    });

    it('stops for time partway through a month and carries on from there', async () => {
      await startOver();
      const ns = new FakeNetSuite(BOOKS);
      ns.onPage = () => { clock += 15_000; };
      const first = await run(ns, { pageSize: 3, budgetMs: 40_000 });
      expect(first).toMatchObject({ partial: true, swept: [], transactionsCopied: 2 });
      expect(first.error).toBeUndefined();
      expect(record()).toMatchObject({ synced: false, last_result: { resume: { month: JAN, afterTxn: '4', lines: 4 } } });
      const sweep = record().last_result.resume.sweep;
      expect((await copied()).map((r) => r.txn)).toEqual(['3', '3', '4', '4']);

      ns.onPage = () => {};
      const second = await run(ns, { pageSize: 3 });
      expect(second).toMatchObject({ monthsDiffering: [JAN, FEB, MAR], swept: [JAN, FEB, MAR], transactionsCopied: 5, transactionsRemoved: 0 });
      expect(second.partial).toBeUndefined();
      expect(ns.queries.find((q) => q.includes('tal.transaction > 4'))).toBeDefined();
      expect(record()).toMatchObject({ synced: true, last_result: { resume: null } });
      expect(await outOfStep()).toEqual([]);
      // The months's first part, copied by the first run, belongs to the same pass.
      const sweeps = await pg.query<{ sweep: string }>(`SELECT DISTINCT sweep FROM gl_netsuite_transactions WHERE posting_month = '2025-01-01'`);
      expect(sweeps.rows).toEqual([{ sweep }]);
    });

    it('never runs while another copy holds the lock', async () => {
      await startOver();
      const ns = new FakeNetSuite(BOOKS);
      await pg.query(`SELECT gl_netsuite_claim_copy('someone-else', 300)`);
      expect(await run(ns)).toEqual({ skipped: 'Another books job is running.' });
      expect(ns.queries).toEqual([]);
      expect(record()).toBeUndefined();
      await pg.query(`SELECT gl_netsuite_release_copy('someone-else')`);
      expect((await run(ns)).swept).toEqual([JAN, FEB, MAR]);
      // Each run lets go when it's done.
      expect((await run(ns)).skipped).toBeUndefined();
    });

    it('places months by date when NetSuite won\'t list its periods', async () => {
      await startOver();
      const ns = new FakeNetSuite(BOOKS);
      ns.refuse.periods = true;
      const r = await run(ns);
      expect(r).toMatchObject({ monthsBy: 'transaction_date', swept: [JAN, FEB, MAR] });
      // SuiteQL's answer when the role lacks the permission, so the note says which one.
      expect(r.notes?.[0]).toBe(
        "NetSuite's integration role can't see accounting periods, so each transaction counts in the month of its date rather than "
        + 'the month it was posted to. Giving the role Manage Accounting Periods (View) on its Setup tab fixes that.',
      );
      expect(await outOfStep()).toEqual([]);
      // Dated December, so it's in the starting entry now.
      expect((await copied()).some((row) => row.txn === '5')).toBe(false);
      expect((await totals('BMG')).opening.find((o) => o.netsuite_account_id === '50')).toMatchObject({ debit: '50.00' });
      expect(ns.queries.some((q) => q.includes('postingperiod IN'))).toBe(false);

      // Once the role can see them, the next run puts it back in January.
      ns.refuse.periods = false;
      clock += 2 * HOUR;
      const next = await run(ns);
      expect(next).toMatchObject({ monthsBy: 'posting_period', monthsDiffering: [JAN] });
      expect((next.notes ?? []).some((n) => /accounting periods/.test(n))).toBe(false);
      expect(await outOfStep()).toEqual([]);
      expect((await copied()).filter((row) => row.txn === '5').map((row) => row.month)).toEqual([JAN, JAN]);
    });

    it('says what went wrong when the periods fail for another reason', async () => {
      await startOver();
      const ns = new FakeNetSuite(BOOKS);
      const query = ns.query;
      ns.query = async (q) => {
        if (q === PERIODS_QUERY) throw Object.assign(new Error('NetSuite SuiteQL error (500): UNEXPECTED_ERROR'), { status: 500 });
        return query(q);
      };
      const r = await run(ns);
      expect(r).toMatchObject({ monthsBy: 'transaction_date', swept: [JAN, FEB, MAR] });
      expect(r.notes?.[0]).toBe(
        "NetSuite wouldn't list its accounting periods (NetSuite SuiteQL error (500): UNEXPECTED_ERROR), so each transaction counts "
        + 'in the month of its date rather than the month it was posted to.',
      );
    });

    it('skips lines with no account, noting the ones that carry an amount', async () => {
      await startOver();
      const ns = new FakeNetSuite([
        ...BOOKS,
        { txn: 15, line: 0, sub: 2, account: 50, debit: 5, date: '2025-03-07', period: 104, type: 'ItemShip' },
        { txn: 15, line: 1, sub: 2, account: 10, credit: 5, date: '2025-03-07', period: 104, type: 'ItemShip' },
        { txn: 15, line: 2, sub: 2, account: null, debit: 5, date: '2025-03-07', period: 104, type: 'ItemShip' },
        // In a subsidiary no company is linked to: counted with that subsidiary's lines instead.
        { txn: 16, line: 0, sub: 9, account: null, debit: 5, date: '2025-03-08', period: 104 },
      ]);
      const r = await run(ns);
      expect(r.error).toBeUndefined();
      expect(r.notes).toContain("1 GL line in NetSuite carries an amount but no account, so it isn't copied. By transaction type: Item Fulfillment 1.");
      expect(await outOfStep()).toEqual([]);
      expect((await copied()).filter((row) => row.txn === '15').map((row) => row.line)).toEqual(['0', '1']);
      // Without the filter, NetSuite would send them and the copy would stop on the first.
      const reads = ns.queries.filter((q) => q !== PERIODS_QUERY && !q.includes('GROUP BY'));
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every((q) => q.includes('tal.account IS NOT NULL'))).toBe(true);

      // When NetSuite won't count them by type, the note gives the count alone.
      ns.refuse.noAccountTypes = true;
      clock += 2 * HOUR;
      const next = await run(ns);
      expect(next.error).toBeUndefined();
      expect(next.notes).toContain("1 GL line in NetSuite with no account or month isn't copied, though it carries an amount.");
    });

    it('filters on the line\'s posting flag alone when NetSuite won\'t take the transaction\'s', async () => {
      await startOver();
      const ns = new FakeNetSuite(BOOKS);
      ns.refuse.txnPosting = true;
      const r = await run(ns);
      expect(r.error).toBeUndefined();
      expect(r.notes).toContain("NetSuite wouldn't filter on the transaction's posting flag, so only each line's is used.");
      expect(await outOfStep()).toEqual([]);
      expect((await copied()).filter((row) => row.txn === '11')).toHaveLength(2);
    });

    it('copies accounts and amounts only when NetSuite won\'t give the other columns', async () => {
      await startOver();
      const ns = new FakeNetSuite(BOOKS);
      ns.refuse.extraColumns = true;
      const r = await run(ns);
      expect(r.error).toBeUndefined();
      expect(r.notes?.some((n) => /memo, name, location, department and class/.test(n))).toBe(true);
      expect(await outOfStep()).toEqual([]);
      expect((await copied()).every((row) => row.memo === null)).toBe(true);
    });

    it('keeps the starting entry by name when NetSuite won\'t give the names, and empties it when there\'s none', async () => {
      await startOver();
      const ns = new FakeNetSuite(BOOKS);
      await run(ns);
      expect(await openingNames()).toHaveLength(1);
      ns.refuse.partyOpening = true;
      clock += 2 * HOUR;
      const r = await run(ns);
      expect(r.error).toBeUndefined();
      expect(r.notes).toContain(
        "NetSuite wouldn't give the names on its receivable and payable accounts before 2025 (NetSuite SuiteQL error (400): Search error "
        + "occurred: Field 'entity' was not found.), so Customer and vendor balances keeps the split by name it had.",
      );
      expect(r.swept).toEqual([JAN]);
      expect(await openingNames()).toHaveLength(1);

      // Nothing on the receivable account before 2025: nothing to read, and nothing kept.
      const none = new FakeNetSuite(BOOKS.filter((l) => l.txn !== 2));
      clock += 2 * HOUR;
      const next = await run(none);
      expect(next.error).toBeUndefined();
      expect(next).toMatchObject({ openingNames: 0 });
      expect(await openingNames()).toEqual([]);
      expect(none.queries.some(isNamesRead)).toBe(false);
    });

    it('changes nothing when NetSuite returns no lines at all', async () => {
      await startOver();
      const ns = new FakeNetSuite(BOOKS);
      await run(ns);
      const before = await copied();
      ns.lines = [];
      const r = await run(ns);
      expect(r.error).toMatch(/returned no GL lines/);
      expect(await copied()).toEqual(before);
      expect((await totals(null)).opening).toHaveLength(4);
      expect(record()).toMatchObject({ synced: false });
    });

    it('stops at a second accounting book, copying nothing from that page', async () => {
      await startOver();
      const ns = new FakeNetSuite(BOOKS);
      ns.twice = { txn: 6, line: 0 };
      const r = await run(ns);
      expect(r.error).toMatch(/more than one accounting book/);
      expect(r.swept).toEqual([JAN]);
      expect((await copied()).some((row) => row.month === FEB)).toBe(false);
    });

    it('removes nothing from a month whose read came up far short of NetSuite\'s totals', async () => {
      await startOver();
      const ns = new FakeNetSuite(BOOKS);
      await run(ns);
      ns.lines.push(
        { txn: 14, line: 0, sub: 2, account: 50, debit: 20, date: '2025-01-25', period: 102 },
        { txn: 14, line: 1, sub: 2, account: 10, credit: 20, date: '2025-01-25', period: 102 },
      );
      ns.unreadable = new Set([3, 4, 5]);
      clock += 2 * HOUR;
      const r = await run(ns);
      // January differed; February is the refresh.
      expect(r).toMatchObject({ swept: [JAN, FEB], transactionsRemoved: 0 });
      expect(r.notes).toContain("The copy of January 2025 read 2 of NetSuite's 8 GL lines, so nothing was removed from it this time.");
      expect(new Set((await copied()).filter((row) => row.month === JAN).map((row) => row.txn))).toEqual(new Set(['3', '4', '5', '14']));
    });
  });
});
