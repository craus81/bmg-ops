// Migration 383 reads what the journal holds for NetSuite's customer
// deposits and deposit applications, gives each its FleetSuite customer, and
// lets the differences page say what the copy of the deposits holds for one;
// the posting job posts them with the deposit rule. This runs migration 314
// (with stand-ins for the app tables it points at) and migrations 359–364,
// 367, 370, 374, 376, 377, 380, 382, 383 and 387, with the ones the job
// reads bills, bill payments, checks, card charges, journal entries, bank
// deposits, transfers, refunds and stock documents through (384–386,
// 389–395, 397 and 399), in an in-memory
// Postgres (PGlite) as the app's server login and holds the functions'
// rules, then runs the posting job against them with deposits only.
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

import { BOOKS_INVOICE_POSTING, postInvoices, type DepositPosting } from './invoice-posting';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { NETSUITE_TYPE } from './differences';
import type { DepositMonthData } from './deposit-check';

const CUSTOMER = '6f1f6a52-8a43-4b8e-9a0e-2d9c1f0b7c11';
const OTHER_CUSTOMER = '0b6a0e1c-7f2d-4a51-9c3e-5d8e2f1a4b22';
/**
 * Made-up chart: '120' BMG's receivable, '121' 1084's, '110' Undeposited
 * Funds, '100' a bank account, '101' a bank account no longer used, '102' a
 * bank account only 1084 may use, '230' customer deposits.
 */
const ACCOUNT: Record<string, string> = {
  120: 'a0000000-0000-4000-8000-000000000120',
  121: 'a0000000-0000-4000-8000-000000000121',
  110: 'a0000000-0000-4000-8000-000000000110',
  100: 'a0000000-0000-4000-8000-000000000100',
  101: 'a0000000-0000-4000-8000-000000000101',
  102: 'a0000000-0000-4000-8000-000000000102',
  230: 'a0000000-0000-4000-8000-000000000230',
};
const JAN = '2025-01-01';
const FEB = '2025-02-01';
const MAR = '2025-03-01';
const DEPOSIT_KINDS = { customer_deposit: NETSUITE_TYPE.customer_deposit, deposit_application: NETSUITE_TYPE.deposit_application };

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
    -- What migrations 314, 407, 416, 435 and 454 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.netsuite_parts (id UUID PRIMARY KEY);
    CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN);
    CREATE TABLE public.netsuite_sales_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), netsuite_id TEXT NOT NULL UNIQUE, tranid TEXT,
      customer_netsuite_id TEXT, customer_name TEXT
    );
    CREATE TABLE public.vendor_invoices (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
    CREATE TABLE public.payouts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
    CREATE TABLE public.po_receipts (id UUID PRIMARY KEY, ns_status TEXT NOT NULL);
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
    '397-books-stock-postings-once.sql', '399-books-customer-refunds.sql',
    // Stock by item, which Books' own fulfillments are costed from.
    '401-books-stock-by-item.sql', '402-books-stock-values.sql', '403-books-stock-item-setup.sql',
    '404-books-stock-ledger-parts.sql', '405-books-stock-account-items.sql',
    // FleetSuite's own invoices, which the job reads with BMG's invoices.
    '407-books-own-invoices.sql', '409-books-own-invoice-posting.sql',
    // Books' own fulfillments, receipts and bills, which the job reads with NetSuite's.
    '416-books-own-fulfillments.sql', '435-books-own-bills.sql', '436-books-snap-a-bill.sql', '454-inventory-adjustments.sql',
    '456-books-own-postings.sql', '457-books-own-adjustments.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`
    UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084';
    INSERT INTO customers (id) VALUES ('${CUSTOMER}'), ('${OTHER_CUSTOMER}');
    INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, company_id, active) VALUES
      ('${ACCOUNT[120]}', '1200', 'Receivables', 'accounts_receivable', '120', (SELECT id FROM gl_companies WHERE code = 'BMG'), true),
      ('${ACCOUNT[121]}', '1210', 'Receivables 1084', 'accounts_receivable', '121', (SELECT id FROM gl_companies WHERE code = '1084'), true),
      ('${ACCOUNT[110]}', '1100', 'Undeposited Funds', 'other_current_asset', '110', NULL, true),
      ('${ACCOUNT[100]}', '1000', 'Checking', 'bank', '100', NULL, true),
      ('${ACCOUNT[101]}', '1010', 'Old Checking', 'bank', '101', NULL, false),
      ('${ACCOUNT[102]}', '1020', 'Checking 1084', 'bank', '102', (SELECT id FROM gl_companies WHERE code = '1084'), true),
      ('${ACCOUNT[230]}', '2300', 'Customer Deposits', 'other_current_liability', '230', NULL, true);
    -- The ledger mirror's customers: NetSuite's 77 matched to a FleetSuite customer, 78 not yet, 79 by hand.
    INSERT INTO ledger_customers (source, external_id, external_ref, display_name, cleaned_name, customer_id, match_status) VALUES
      ('netsuite', 'customer/77', '77', 'A Customer', 'A Customer', '${CUSTOMER}', 'exact'),
      ('netsuite', 'customer/78', '78', 'Another Customer', 'Another Customer', NULL, 'pending'),
      ('netsuite', 'customer/79', '79', 'A Third Customer', 'A Third Customer', '${OTHER_CUSTOMER}', 'manual');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

/** A Postgres text[] literal, as PostgREST sends a list. */
const textArray = (items: string[]) => `{${items.map((s) => `"${s.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;

// ── NetSuite's deposits, and the copies of them ────────────────────────────

interface NsDeposit {
  ref: string;
  type: 'CustDep' | 'DepAppl';
  number: string | null;
  date: string;
  /** The company NetSuite posted it to; null when the GL copy has none of it. */
  company: 'BMG' | '1084' | null;
  /** What was deposited, or applied. */
  total: string;
  /** Where a deposit's money went: '110' unless said; null leaves NetSuite's main line out and splits the money between two accounts. */
  money?: string | null;
  /** NetSuite's customer: '77' unless said. */
  customer?: string;
  /** NetSuite's status for it. */
  status?: string;
  voided?: boolean;
  /** NetSuite no longer has it. */
  gone?: boolean;
  /** The deposit an application applies. */
  applies?: string;
}

const cents = (amount: string) => Math.round(Number(amount) * 100);
const money = (c: number) => (c / 100).toFixed(2);

/** Copies a deposit or application as the deposits copy (migration 382) and the GL copy would. */
async function copy(pg: PGlite, d: NsDeposit) {
  await pg.query('SELECT gl_netsuite_deposits_apply($1::jsonb)', [JSON.stringify({
    rows: [{
      netsuite_id: d.ref, tran_type: d.type, tranid: d.number, trandate: d.date, customer_netsuite_id: d.customer ?? '77',
      customer_name: 'A Customer', total: d.total, status_label: d.voided ? 'Voided' : d.status ?? null, voided: !!d.voided,
      links: d.applies ? [{ netsuite_id: d.applies, type: 'CustDep', number: null, amount: d.total, link_type: null }] : [],
    }],
  })]);
  await pg.query(`UPDATE gl_netsuite_deposits SET gone_at = ${d.gone ? 'now()' : 'NULL'} WHERE netsuite_id = $1`, [d.ref]);
  await pg.query('DELETE FROM gl_netsuite_transactions WHERE netsuite_id = $1', [d.ref]);
  if (!d.company || d.gone) return;
  const month = `${d.date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [d.ref, d.type, d.number, d.date, month],
  );
  const total = cents(d.total);
  const receivable = d.company === 'BMG' ? '120' : '121';
  const posted: Array<[string, string, number]> = d.type === 'DepAppl'
    ? [['0', receivable, -total], ['1', '230', total]]
    : d.money === null
      ? [['1', '230', -total], ['2', '110', total - 100], ['3', '100', 100]]
      : [['0', d.money ?? '110', total], ['1', '230', -total]];
  for (const [line, account, c] of posted) {
    if (c === 0) continue;
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, $4, $5, $6, $7 FROM gl_companies WHERE code = $8`,
      [d.ref, line, account, month, d.date, money(Math.max(c, 0)), money(Math.max(-c, 0)), d.company],
    );
  }
}

// ── The functions ──────────────────────────────────────────────────────────

describe('migration 383\'s functions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await copy(db, { ref: '401', type: 'CustDep', number: 'DEP401', date: '2025-03-05', company: 'BMG', total: '500.00' });
    await copy(db, { ref: '402', type: 'DepAppl', number: 'DA402', date: '2025-03-10', company: 'BMG', total: '300.00', applies: '401', customer: '79' });
    await copy(db, { ref: '403', type: 'CustDep', number: 'DEP403', date: '2025-03-12', company: 'BMG', total: '20.00', voided: true, customer: '78' });
    await copy(db, { ref: '404', type: 'CustDep', number: 'DEP404', date: '2025-03-14', company: 'BMG', total: '60.00', gone: true });
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0].r;
  const entry = (company: string, key: string, sourceType: string, sourceId: string, amount: string, fields: Record<string, unknown> = {}) => ({
    company,
    entry_date: '2025-03-05',
    source_type: sourceType,
    source_id: sourceId,
    posting_rule: 'deposit@1',
    idempotency_key: key,
    memo: `DEP${sourceId}, A Customer`,
    lines: [
      { account_id: ACCOUNT[110], debit: amount, source_line_ref: 'money' },
      { account_id: ACCOUNT[230], credit: amount, source_line_ref: 'deposits', customer_id: CUSTOMER },
    ],
    ...fields,
  });
  const post = (p: unknown) => one<{ id: string; entry_no: number }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify(p)]);
  const postings = async (company: string, ids: string[] | null, lines: boolean) =>
    (await one<{ deposits: DepositPosting[] }>('SELECT gl_deposit_postings($1, $2::text[], $3) AS r', [company, ids && textArray(ids), lines])).deposits;

  it('gl_deposit_postings says what the journal holds for each deposit and application and what the copy says of it', async () => {
    const first = await post(entry('BMG', 'customer_deposit:401:1', 'customer_deposit', '401', '500.00'));
    const second = (await one<{ entry: { id: string; entry_no: number } }>(
      'SELECT gl_repost_entry($1::uuid, $2, $3::jsonb) AS r',
      [first.id, 'DEP401 changed in NetSuite', JSON.stringify(entry('BMG', 'customer_deposit:401:2', 'customer_deposit', '401', '450.00'))],
    )).entry;
    const applied = await post(entry('BMG', 'deposit_application:402:1', 'deposit_application', '402', '300.00', {
      entry_date: '2025-03-10',
      lines: [
        { account_id: ACCOUNT[230], debit: '300.00', source_line_ref: 'deposits' },
        { account_id: ACCOUNT[120], credit: '300.00', source_line_ref: 'receivable' },
      ],
    }));
    const voided = await post(entry('BMG', 'customer_deposit:403:1', 'customer_deposit', '403', '20.00'));
    const gone = await post(entry('BMG', 'customer_deposit:404:1', 'customer_deposit', '404', '60.00'));
    // Not in the copy of NetSuite's deposits, and 1084's.
    const other = await post(entry('1084', 'customer_deposit:405:1', 'customer_deposit', '405', '5.00'));
    // A payment's entry under a deposit's NetSuite id is another document's.
    await post(entry('BMG', 'payment:401:1', 'payment', '401', '1.00', { posting_rule: 'payment@1' }));

    const held = await postings('BMG', null, false);
    expect(held.map((p) => [p.source_type, p.source_id, p.entries, p.deposit])).toEqual([
      ['customer_deposit', '401', 2, { number: 'DEP401', deleted: false, voided: false }],
      ['deposit_application', '402', 1, { number: 'DA402', deleted: false, voided: false }],
      ['customer_deposit', '403', 1, { number: 'DEP403', deleted: false, voided: true }],
      ['customer_deposit', '404', 1, { number: 'DEP404', deleted: true, voided: false }],
    ]);
    expect(held[0]).toEqual({
      source_type: 'customer_deposit',
      source_id: '401',
      entries: 2,
      unreversed: [second.id],
      history: [
        { entry_no: first.entry_no, entry_date: '2025-03-05', reversed_by: first.entry_no + 1 },
        { entry_no: second.entry_no, entry_date: '2025-03-05', reversed_by: null },
      ],
      current: { id: second.id, entry_no: second.entry_no, entry_date: '2025-03-05', lines: null },
      deposit: { number: 'DEP401', deleted: false, voided: false },
    });
    expect(held.map((p) => p.current?.id)).toEqual([second.id, applied.id, voided.id, gone.id]);

    // Only the ones asked about, with the lines of the entry that stands.
    const [asked] = await postings('BMG', ['402', '999'], true);
    expect(asked.current?.lines).toEqual([
      { account: '230', debit: '300.00', credit: '0.00', division: null, source_line_ref: 'deposits', customer_id: null },
      { account: '120', debit: '0.00', credit: '300.00', division: null, source_line_ref: 'receivable', customer_id: null },
    ]);
    expect((await postings('1084', null, false)).map((p) => [p.source_id, p.current?.id, p.deposit])).toEqual([['405', other.id, null]]);
  });

  it('gl_deposit_month gives each document the FleetSuite customer the ledger mirror matched, and otherwise what it gave', async () => {
    const month = await one<DepositMonthData>('SELECT gl_deposit_month($1, $2::date) AS r', ['BMG', MAR]);
    // 77 is matched; 78 not yet; 79 only by hand, which the mirror doesn't give its invoices and payments either.
    expect(month.deposits.map((d) => [d.number, d.type, d.customer_id, d.companies])).toEqual([
      ['DEP401', 'CustDep', CUSTOMER, ['BMG']],
      ['DA402', 'DepAppl', null, ['BMG']],
      ['DEP403', 'CustDep', null, ['BMG']],
    ]);
    expect(month.deposits[1]).toMatchObject({
      netsuite_id: '402', date: '2025-03-10', total: '300.00', voided: false, customer: 'A Customer',
      links: [{ netsuite_id: '401', type: 'CustDep', number: null, amount: '300.00', link_type: null }],
    });
    expect(month.deposits[0].applications.map((a) => a.number)).toEqual(['DA402']);
    expect(month.accounts).toEqual([{ account: '230', documents: 3 }]);
    expect(month.not_copied).toEqual([]);
  });

  it('gl_books_difference_documents says what the copy of the deposits holds for one that differs', async () => {
    const diff = await one<{ counts: Record<string, number>; documents: any[] }>(
      'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r', ['BMG', MAR, JSON.stringify(DEPOSIT_KINDS), 10],
    );
    // DEP401's entry is $50 short of what NetSuite posted; DEP404's stands though NetSuite no longer has it; the rest match.
    expect(diff.counts).toEqual({ customer_deposit: 2 });
    expect(diff.documents.map((d) => [d.kind, d.netsuite_id, d.copy])).toEqual([
      ['customer_deposit', '404', { number: 'DEP404', customer: 'A Customer', voided: false, deleted: true }],
      ['customer_deposit', '401', { number: 'DEP401', customer: 'A Customer', voided: false, deleted: false }],
    ]);
    expect(diff.documents[1].netsuite).toEqual({ type: 'CustDep', number: 'DEP401', date: '2025-03-05', month: MAR });
    expect(diff.documents[0].netsuite).toBeNull();
  });

  it('is the service role\'s alone, and the new read writes nothing', async () => {
    for (const fn of ['gl_deposit_postings(text, text[], boolean)', 'gl_deposit_month(text, date)', 'gl_books_difference_documents(text, date, jsonb, integer)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>('SELECT has_function_privilege($1::name, $2, \'EXECUTE\') AS r', [role, fn]), `${role} ${fn}`)
          .toBe(role === 'service_role');
      }
    }
    const body = await one<string>(`SELECT prosrc AS r FROM pg_proc WHERE proname = 'gl_deposit_postings'`);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });
});

// ── The job ────────────────────────────────────────────────────────────────

// Made-up deposits and applications, from December 2024 to March 2025.
const DEPOSITS = (): NsDeposit[] => [
  { ref: '601', type: 'CustDep', number: 'DEP601', date: '2025-01-10', company: 'BMG', total: '500.00' },
  { ref: '602', type: 'DepAppl', number: 'DA602', date: '2025-02-05', company: 'BMG', total: '300.00', applies: '601' },
  // NetSuite's posting doesn't say where the money went, so the rule can't work it out.
  { ref: '603', type: 'CustDep', number: 'DEP603', date: '2025-02-20', company: 'BMG', total: '50.00', money: null },
  // 1084's, which a run for BMG leaves alone.
  { ref: '604', type: 'CustDep', number: 'DEP604', date: '2025-03-03', company: '1084', total: '40.00' },
  // Not in the GL copy.
  { ref: '605', type: 'CustDep', number: 'DEP605', date: '2025-03-04', company: null, total: '30.00' },
  // $0, and nothing on either side.
  { ref: '606', type: 'CustDep', number: 'DEP606', date: '2025-03-05', company: 'BMG', total: '0.00' },
  // Paid straight into the bank, by a customer the ledger mirror hasn't matched yet.
  { ref: '607', type: 'CustDep', number: 'DEP607', date: '2025-03-06', company: 'BMG', total: '75.00', money: '100', customer: '78' },
  // Dated before the books start.
  { ref: '608', type: 'DepAppl', number: 'DA608', date: '2024-12-20', company: 'BMG', total: '100.00', applies: '601' },
];

describe('the posting job, for deposits', () => {
  let pg: PGlite;
  let clock = 0;
  /** How long a function takes, for running out of time. */
  const takes = new Map<string, number>();
  const store = new Map<string, any>();
  const deposits = new Map<string, NsDeposit>();

  // sync_state in memory; gl_accounts, gl_companies and every function the
  // real ones, called the way supabase-js calls them.
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
      if (table === 'gl_accounts') {
        return {
          select: (cols: string) => ({
            order: (col: string) => ({
              range: async (from: number, to: number) => ({
                data: (await pg.query(`SELECT ${cols} FROM gl_accounts ORDER BY ${col} LIMIT ${to - from + 1} OFFSET ${from}`)).rows,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'gl_companies') {
        return { select: async (cols: string) => ({ data: (await pg.query(`SELECT ${cols} FROM gl_companies ORDER BY code`)).rows, error: null }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      clock += takes.get(fn) ?? 0;
      const names = Object.keys(args);
      const value = (v: unknown) => (Array.isArray(v) ? textArray(v.map(String)) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
      try {
        const r = await pg.query<{ r: unknown }>(
          `SELECT ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) AS r`,
          names.map((n) => value(args[n])),
        );
        return { data: r.rows[0].r, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    },
  }) as any;

  // Deposits have no lines to ask NetSuite about.
  const query = async () => { throw new Error('NetSuite was asked about lines'); };
  // A run for BMG's books alone (deps.companies): 1084's documents here are another company's, which it leaves alone.
  const run = (budgetMs = 240_000) => postInvoices(service(), { deadline: clock + budgetMs, deps: { query, now: () => clock, companies: ['BMG'] } });

  /** The journal, entry by entry: a document's entry by its key, a reversal by the entry it reverses. */
  const journal = async () => (await pg.query<{ no: number; date: string; key: string | null; reverses: number | null; memo: string | null }>(
    `SELECT e.entry_no::int AS no, to_char(e.entry_date, 'YYYY-MM-DD') AS date,
            CASE WHEN e.reverses_entry_id IS NULL THEN e.idempotency_key END AS key, r.entry_no::int AS reverses, e.memo
     FROM gl_entries e LEFT JOIN gl_entries r ON r.id = e.reverses_entry_id
     ORDER BY e.entry_no`,
  )).rows;
  const linesOf = async (no: number) => (await pg.query(
    `SELECT a.netsuite_account_id AS account, l.debit::text AS debit, l.credit::text AS credit, l.customer_id, l.source_line_ref
     FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id JOIN gl_entries e ON e.id = l.entry_id
     WHERE e.entry_no = $1 ORDER BY l.line_no`,
    [no],
  )).rows;
  const ruleOf = async (no: number) => (await pg.query<{ rule: string; type: string; source: string }>(
    'SELECT posting_rule AS rule, source_type AS type, source_id AS source FROM gl_entries WHERE entry_no = $1', [no],
  )).rows[0];
  const differing = async (month: string) => pg.query<{ r: { counts: Record<string, number>; documents: any[] } }>(
    'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r', ['BMG', month, JSON.stringify(DEPOSIT_KINDS), 10],
  ).then((res) => res.rows[0].r);

  /** NetSuite changes a deposit or application, and the copies catch up. */
  const edit = async (ref: string, change: (d: NsDeposit) => void) => {
    const d = deposits.get(ref)!;
    change(d);
    await copy(pg, d);
  };

  beforeAll(async () => {
    pg = await freshDb();
    store.set(BOOKS_LISTS_SYNC, { last_result: { taxAccounts: [], itemAccounts: [] } });
    clock = Date.parse('2025-03-15T12:00:00Z');
    for (const d of DEPOSITS()) {
      deposits.set(d.ref, d);
      await copy(pg, d);
    }
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('posts each BMG deposit and application the rule works out, once, the customer on the customer deposits and receivable lines', async () => {
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 3, replaced: 0, reversed: 0, unchanged: 0, left: 1, failedCount: 0 });
    expect(r.error).toBeUndefined();
    expect(r.notes).toBeUndefined();

    // Not DEP603 (unworkable), DEP604 (1084's), DEP605 (not in the GL copy), DEP606 ($0) or DA608 (before the books start).
    expect(await journal()).toEqual([
      { no: 1, date: '2025-01-10', key: 'customer_deposit:601:1', reverses: null, memo: 'DEP601, A Customer' },
      { no: 2, date: '2025-02-05', key: 'deposit_application:602:1', reverses: null, memo: 'DA602, A Customer' },
      { no: 3, date: '2025-03-06', key: 'customer_deposit:607:1', reverses: null, memo: 'DEP607, A Customer' },
    ]);
    expect(await ruleOf(1)).toEqual({ rule: 'deposit@1', type: 'customer_deposit', source: '601' });
    expect(await ruleOf(2)).toEqual({ rule: 'deposit@1', type: 'deposit_application', source: '602' });
    expect(await linesOf(1)).toEqual([
      { account: '110', debit: '500.00', credit: '0.00', customer_id: null, source_line_ref: 'money' },
      { account: '230', debit: '0.00', credit: '500.00', customer_id: CUSTOMER, source_line_ref: 'deposits' },
    ]);
    expect(await linesOf(2)).toEqual([
      { account: '230', debit: '300.00', credit: '0.00', customer_id: CUSTOMER, source_line_ref: 'deposits' },
      { account: '120', debit: '0.00', credit: '300.00', customer_id: CUSTOMER, source_line_ref: 'receivable' },
    ]);
    // Its customer isn't matched to one in FleetSuite yet.
    expect((await linesOf(3)).map((l: any) => [l.account, l.debit, l.credit, l.customer_id])).toEqual([['100', '75.00', '0.00', null], ['230', '0.00', '75.00', null]]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);

    // Differences: what's posted comes to NetSuite's; DEP603 is the one document of the kinds that differs, and why can be told.
    expect((await differing(JAN)).counts).toEqual({});
    const feb = await differing(FEB);
    expect(feb.counts).toEqual({ customer_deposit: 1 });
    expect(feb.documents[0]).toMatchObject({
      kind: 'customer_deposit', netsuite_id: '603', fleetsuite: { entries: 0, standing: null },
      copy: { number: 'DEP603', customer: 'A Customer', voided: false, deleted: false },
    });
  });

  it('changes nothing on the next run', async () => {
    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 3, left: 1 });
    expect(await journal()).toEqual(before);
  });

  it('replaces an entry when NetSuite changes what it posts or FleetSuite matches its customer, and not for a new number or status', async () => {
    await edit('601', (d) => { d.number = 'DEP601-A'; d.status = 'Fully Applied'; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, unchanged: 3 });

    await edit('602', (d) => { d.total = '250.00'; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, unchanged: 2 });
    expect((await journal()).slice(-2)).toEqual([
      { no: 4, date: '2025-02-05', key: null, reverses: 2, memo: 'DA602 changed in NetSuite' },
      { no: 5, date: '2025-02-05', key: 'deposit_application:602:2', reverses: null, memo: 'DA602, A Customer' },
    ]);
    expect((await linesOf(5)).map((l: any) => [l.source_line_ref, l.debit, l.credit])).toEqual([['deposits', '250.00', '0.00'], ['receivable', '0.00', '250.00']]);

    // The ledger mirror matches DEP607's customer: its entry now carries it.
    await pg.query(`UPDATE ledger_customers SET customer_id = $1, match_status = 'exact' WHERE external_id = 'customer/78'`, [OTHER_CUSTOMER]);
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, unchanged: 2 });
    expect((await journal()).slice(-1)[0]).toMatchObject({ no: 7, key: 'customer_deposit:607:2' });
    expect((await linesOf(7)).map((l: any) => [l.source_line_ref, l.customer_id])).toEqual([['money', null], ['deposits', OTHER_CUSTOMER]]);
  });

  it('reverses the entry of a deposit NetSuite voids, no longer has, or that comes to nothing now, once', async () => {
    await edit('601', (d) => { d.gone = true; });
    await edit('607', (d) => { d.voided = true; });
    // Out of the GL copy with its amount unchanged: the copy hasn't caught up, so its entry stays.
    await edit('602', (d) => { d.company = null; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 2, left: 2 });
    expect((await journal()).slice(-2).map((e) => [e.reverses, e.memo])).toEqual([
      [1, 'DEP601-A deleted in NetSuite'],
      [7, 'DEP607 voided in NetSuite'],
    ]);

    // $0 now, and NetSuite posts no lines for $0: nothing to post, so its entry is reversed.
    await edit('602', (d) => { d.total = '0.00'; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 1, left: 1 });
    expect((await journal()).slice(-1).map((e) => [e.reverses, e.memo])).toEqual([[5, 'DA602 comes to nothing in NetSuite']]);

    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0 });
    expect(await journal()).toEqual(before);
  });

  it('posts a deposit once the rule can work it out, and names one the journal refuses, without amounts', async () => {
    await edit('603', (d) => { d.money = '110'; });
    // Into a bank account NetSuite has made inactive since, and into one only 1084 may use.
    deposits.set('609', { ref: '609', type: 'CustDep', number: 'DEP609', date: '2025-03-07', company: 'BMG', total: '9.00', money: '101' });
    deposits.set('611', { ref: '611', type: 'CustDep', number: 'DEP611', date: '2025-03-08', company: 'BMG', total: '8.00', money: '102' });
    await copy(pg, deposits.get('609')!);
    await copy(pg, deposits.get('611')!);

    const r = await run();
    expect(r).toMatchObject({ posted: 2, failedCount: 1, failed: [{ number: 'DEP611', reason: 'Account 1020 (Checking 1084) belongs to another company' }] });
    const posted = (await journal()).slice(-2);
    expect(posted.map((e) => e.key)).toEqual(['customer_deposit:603:1', 'customer_deposit:609:1']);
    // The inactive account takes the deposit NetSuite put into it.
    expect((await linesOf(posted[1].no)).filter((l: any) => l.account === '101').map((l: any) => [l.debit, l.credit])).toEqual([['9.00', '0.00']]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);
  });

  it('never starts a deposit write with under five seconds left, and does that month again next run', async () => {
    deposits.set('610', { ref: '610', type: 'CustDep', number: 'DEP610', date: '2025-01-20', company: 'BMG', total: '40.00' });
    await copy(pg, deposits.get('610')!);
    const before = await journal();

    takes.set('gl_deposit_month', 26_000);
    expect(await run(30_000)).toMatchObject({ months: [], posted: 0, partial: true });
    expect(store.get(BOOKS_INVOICE_POSTING).last_result.resume).toEqual({ company: 'BMG', month: JAN });
    expect(await journal()).toEqual(before);

    takes.clear();
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 1 });
    expect(r.partial).toBeUndefined();
    expect((await journal()).slice(-1)[0].key).toBe('customer_deposit:610:1');
  });
});
