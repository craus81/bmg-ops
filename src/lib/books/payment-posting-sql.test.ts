// Migration 376 reads what the journal holds for NetSuite's customer
// payments, and the posting job posts them with the payment rule. This runs
// migration 314 (with stand-ins for the app tables it points at) and
// migrations 359–364, 367, 370, 374, 376, 380 and 387, with the ones the job
// reads deposits, bills, bill payments, checks, card charges, journal
// entries, bank deposits and transfers through (377, 382–386 and 389–394),
// in an in-memory Postgres (PGlite) as the app's server login and holds the
// function's rules, then runs the posting job against them with payments
// only.
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

import { BOOKS_INVOICE_POSTING, postInvoices, type PaymentPosting } from './invoice-posting';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';

const CUSTOMER = '6f1f6a52-8a43-4b8e-9a0e-2d9c1f0b7c11';
/**
 * Made-up chart: '120' BMG's receivable, '121' 1084's, '110' Undeposited
 * Funds, '100' a bank account, '480' sales discounts, '490' a discount
 * account no longer used, '491' a discount account only 1084 may use.
 */
const ACCOUNT: Record<string, string> = {
  120: 'a0000000-0000-4000-8000-000000000120',
  121: 'a0000000-0000-4000-8000-000000000121',
  110: 'a0000000-0000-4000-8000-000000000110',
  100: 'a0000000-0000-4000-8000-000000000100',
  480: 'a0000000-0000-4000-8000-000000000480',
  490: 'a0000000-0000-4000-8000-000000000490',
  491: 'a0000000-0000-4000-8000-000000000491',
};
const JAN = '2025-01-01';
const FEB = '2025-02-01';
const MAR = '2025-03-01';

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
    '393-books-journal-entries.sql', '394-books-bank-deposits.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`
    UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084';
    INSERT INTO customers (id) VALUES ('${CUSTOMER}');
    INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, company_id, active) VALUES
      ('${ACCOUNT[120]}', '1200', 'Receivables', 'accounts_receivable', '120', (SELECT id FROM gl_companies WHERE code = 'BMG'), true),
      ('${ACCOUNT[121]}', '1210', 'Receivables 1084', 'accounts_receivable', '121', (SELECT id FROM gl_companies WHERE code = '1084'), true),
      ('${ACCOUNT[110]}', '1100', 'Undeposited Funds', 'other_current_asset', '110', NULL, true),
      ('${ACCOUNT[100]}', '1000', 'Checking', 'bank', '100', NULL, true),
      ('${ACCOUNT[480]}', '4800', 'Discounts', 'income', '480', NULL, true),
      ('${ACCOUNT[490]}', '4900', 'Old Discounts', 'income', '490', NULL, false),
      ('${ACCOUNT[491]}', '4910', 'Discounts 1084', 'income', '491', (SELECT id FROM gl_companies WHERE code = '1084'), true);
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

/** A Postgres text[] literal, as PostgREST sends a list. */
const textArray = (items: string[]) => `{${items.map((s) => `"${s.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;

// ── NetSuite's payments, and the copies of them ────────────────────────────

interface NsPayment {
  ref: string;
  number: string;
  date: string;
  /** The company NetSuite posted it to; null when the GL copy has none of it. */
  company: 'BMG' | '1084' | null;
  /** The money that came in. */
  total: string;
  /** What the customer took off, booked to `discountAccount` ('480' unless said). */
  discount?: string;
  discountAccount?: string;
  /** Where the money went: '110' unless said; null leaves NetSuite's main line out and splits the money between two accounts. */
  deposit?: string | null;
  customerId?: string | null;
  voided?: boolean;
  deleted?: boolean;
}

const cents = (amount: string) => Math.round(Number(amount) * 100);
const money = (c: number) => (c / 100).toFixed(2);

/** Copies a payment as the ledger mirror and the GL copy would. */
async function copy(pg: PGlite, p: NsPayment) {
  await pg.query('DELETE FROM ledger_payments WHERE external_ref = $1', [p.ref]);
  await pg.query('DELETE FROM gl_netsuite_transactions WHERE netsuite_id = $1', [p.ref]);
  await pg.query(
    `INSERT INTO ledger_payments (source, external_id, external_ref, direction, party_kind, doc_number, payment_date, total, voided,
                                  deleted_at, party_name, customer_id)
     VALUES ('netsuite', $1, $2, 'in', 'customer', $3, $4, $5, $6, $7, 'A Customer', $8)`,
    [`CustPymt/${p.ref}`, p.ref, p.number, p.date, p.total, !!p.voided, p.deleted ? '2025-03-14T00:00:00Z' : null, p.customerId ?? null],
  );
  if (!p.company || p.deleted) return;
  const month = `${p.date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, 'CustPymt', $2, $3, $4, 'x', 's')`,
    [p.ref, p.number, p.date, month],
  );
  const total = cents(p.total);
  const discount = cents(p.discount ?? '0');
  const receivable = p.company === 'BMG' ? '120' : '121';
  const posted: Array<[string, string, number]> = p.deposit === null
    ? [['1', receivable, -(total + discount)], ['2', '110', total - 100], ['3', '100', 100]]
    : [['0', p.deposit ?? '110', total], ['1', receivable, -(total + discount)]];
  if (discount) posted.push(['4', p.discountAccount ?? '480', discount]);
  for (const [line, account, c] of posted) {
    if (c === 0) continue;
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, $4, $5, $6, $7 FROM gl_companies WHERE code = $8`,
      [p.ref, line, account, month, p.date, money(Math.max(c, 0)), money(Math.max(-c, 0)), p.company],
    );
  }
}

// ── The function ───────────────────────────────────────────────────────────

describe('migration 376\'s function', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await copy(db, { ref: '301', number: 'PMT301', date: '2025-02-05', company: 'BMG', total: '10.00' });
    await copy(db, { ref: '304', number: 'PMT304', date: '2025-02-06', company: 'BMG', total: '10.00' });
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0].r;
  const entry = (company: string, key: string, sourceId: string, amount: string, fields: Record<string, unknown> = {}) => ({
    company,
    entry_date: '2025-02-05',
    source_type: 'payment',
    source_id: sourceId,
    posting_rule: 'payment@1',
    idempotency_key: key,
    memo: `PMT${sourceId}, A Customer`,
    lines: [
      { account_id: ACCOUNT[110], debit: amount, source_line_ref: 'deposit' },
      { account_id: company === 'BMG' ? ACCOUNT[120] : ACCOUNT[121], credit: amount, source_line_ref: 'receivable', customer_id: CUSTOMER },
    ],
    ...fields,
  });
  const post = (p: unknown) => one<{ id: string; entry_no: number }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify(p)]);
  const postings = async (company: string, ids: string[] | null, lines: boolean) =>
    (await one<{ payments: PaymentPosting[] }>('SELECT gl_payment_postings($1, $2::text[], $3) AS r', [company, ids && textArray(ids), lines])).payments;

  it('gl_payment_postings says what the journal holds for each payment and what the copy says of it', async () => {
    const first = await post(entry('BMG', 'payment:301:1', '301', '10.00'));
    const second = (await one<{ entry: { id: string; entry_no: number } }>(
      'SELECT gl_repost_entry($1::uuid, $2, $3::jsonb) AS r',
      [first.id, 'PMT301 changed in NetSuite', JSON.stringify(entry('BMG', 'payment:301:2', '301', '12.00'))],
    )).entry;
    const other = await post(entry('BMG', 'payment:302:1', '302', '7.00'));
    await post(entry('1084', 'payment:303:1', '303', '5.00'));
    // An invoice's entry under a payment's NetSuite id is another document's.
    await post(entry('BMG', 'invoice:301:1', '301', '1.00', { source_type: 'invoice', posting_rule: 'invoice@1' }));

    expect(await postings('BMG', null, false)).toEqual([
      {
        source_type: 'payment',
        source_id: '301',
        entries: 2,
        unreversed: [second.id],
        history: [
          { entry_no: first.entry_no, entry_date: '2025-02-05', reversed_by: first.entry_no + 1 },
          { entry_no: second.entry_no, entry_date: '2025-02-05', reversed_by: null },
        ],
        current: { id: second.id, entry_no: second.entry_no, entry_date: '2025-02-05', lines: null },
        payment: { number: 'PMT301', deleted: false, voided: false },
      },
      {
        // Not in the copy of NetSuite's payments.
        source_type: 'payment',
        source_id: '302',
        entries: 1,
        unreversed: [other.id],
        history: [{ entry_no: other.entry_no, entry_date: '2025-02-05', reversed_by: null }],
        current: { id: other.id, entry_no: other.entry_no, entry_date: '2025-02-05', lines: null },
        payment: null,
      },
    ]);

    // Only the payments asked about, with the lines of the entry that stands.
    const [held] = await postings('BMG', ['301', '999'], true);
    expect(held.current?.lines).toEqual([
      { account: '110', debit: '12.00', credit: '0.00', division: null, source_line_ref: 'deposit', customer_id: null },
      { account: '120', debit: '0.00', credit: '12.00', division: null, source_line_ref: 'receivable', customer_id: CUSTOMER },
    ]);
    expect((await postings('1084', null, false)).map((p) => p.source_id)).toEqual(['303']);

    // A deleted or voided payment says so.
    await db.query(`UPDATE ledger_payments SET deleted_at = now() WHERE external_ref = '301'`);
    await db.query(`UPDATE ledger_payments SET voided = true WHERE external_ref = '304'`);
    await post(entry('BMG', 'payment:304:1', '304', '10.00'));
    const after = await postings('BMG', ['301', '304'], false);
    expect(after.map((p) => [p.source_id, p.payment])).toEqual([
      ['301', { number: 'PMT301', deleted: true, voided: false }],
      ['304', { number: 'PMT304', deleted: false, voided: true }],
    ]);
  });

  it('is the service role\'s alone, and writes nothing itself', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect(await one<boolean>(
        `SELECT has_function_privilege($1::name, 'gl_payment_postings(text, text[], boolean)', 'EXECUTE') AS r`, [role],
      ), role).toBe(role === 'service_role');
    }
    const body = await one<string>(`SELECT prosrc AS r FROM pg_proc WHERE proname = 'gl_payment_postings'`);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });
});

// ── The job ────────────────────────────────────────────────────────────────

// Made-up payments, from January to March 2025.
const PAYMENTS = (): NsPayment[] => [
  { ref: '501', number: 'PMT501', date: '2025-01-10', company: 'BMG', customerId: CUSTOMER, total: '162.00' },
  // $3.24 off for paying early.
  { ref: '502', number: 'PMT502', date: '2025-02-05', company: 'BMG', total: '158.76', discount: '3.24' },
  // NetSuite's posting doesn't say where the money went, so the rule can't work it out.
  { ref: '503', number: 'PMT503', date: '2025-02-20', company: 'BMG', total: '50.00', deposit: null },
  // 1084's payments don't post yet.
  { ref: '504', number: 'PMT504', date: '2025-03-03', company: '1084', total: '40.00' },
  // Not in the GL copy.
  { ref: '505', number: 'PMT505', date: '2025-03-04', company: null, total: '30.00' },
  // Only applies a credit: $0, and nothing on either side.
  { ref: '506', number: 'PMT506', date: '2025-03-05', company: 'BMG', total: '0.00' },
  // Paid straight into the bank.
  { ref: '507', number: 'PMT507', date: '2025-03-06', company: 'BMG', customerId: CUSTOMER, total: '75.00', deposit: '100' },
];

describe('the posting job, for payments', () => {
  let pg: PGlite;
  let clock = 0;
  const store = new Map<string, any>();
  const payments = new Map<string, NsPayment>();

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
    rpc: async (fn: string, args: Record<string, unknown>) => {
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

  // Payments have no lines to ask NetSuite about.
  const query = async () => { throw new Error('NetSuite was asked about lines'); };
  const run = (budgetMs = 240_000) => postInvoices(service(), { deadline: clock + budgetMs, deps: { query, now: () => clock } });

  /** The journal, entry by entry: a payment's entry by its key, a reversal by the entry it reverses. */
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

  /** NetSuite changes a payment, and the copies catch up. */
  const edit = async (ref: string, change: (p: NsPayment) => void) => {
    const p = payments.get(ref)!;
    change(p);
    await copy(pg, p);
  };

  beforeAll(async () => {
    pg = await freshDb();
    store.set(BOOKS_LISTS_SYNC, { last_result: { taxAccounts: [], itemAccounts: [] } });
    clock = Date.parse('2025-03-15T12:00:00Z');
    for (const p of PAYMENTS()) {
      payments.set(p.ref, p);
      await copy(pg, p);
    }
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('posts each BMG payment the rule works out, once: the money, any discount and the receivable', async () => {
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 3, replaced: 0, reversed: 0, unchanged: 0, left: 1, failedCount: 0 });
    expect(r.error).toBeUndefined();
    expect(r.notes).toBeUndefined();

    // Not PMT503 (unworkable), PMT504 (1084's), PMT505 (not in the GL copy) or PMT506 ($0).
    expect(await journal()).toEqual([
      { no: 1, date: '2025-01-10', key: 'payment:501:1', reverses: null, memo: 'PMT501, A Customer' },
      { no: 2, date: '2025-02-05', key: 'payment:502:1', reverses: null, memo: 'PMT502, A Customer' },
      { no: 3, date: '2025-03-06', key: 'payment:507:1', reverses: null, memo: 'PMT507, A Customer' },
    ]);
    expect(await ruleOf(1)).toEqual({ rule: 'payment@1', type: 'payment', source: '501' });
    expect(await linesOf(1)).toEqual([
      { account: '110', debit: '162.00', credit: '0.00', customer_id: null, source_line_ref: 'deposit' },
      { account: '120', debit: '0.00', credit: '162.00', customer_id: CUSTOMER, source_line_ref: 'receivable' },
    ]);
    expect(await linesOf(2)).toEqual([
      { account: '110', debit: '158.76', credit: '0.00', customer_id: null, source_line_ref: 'deposit' },
      { account: '480', debit: '3.24', credit: '0.00', customer_id: null, source_line_ref: 'discount' },
      { account: '120', debit: '0.00', credit: '162.00', customer_id: null, source_line_ref: 'receivable' },
    ]);
    expect((await linesOf(3)).map((l: any) => [l.account, l.debit, l.credit])).toEqual([['100', '75.00', '0.00'], ['120', '0.00', '75.00']]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);
  });

  it('changes nothing on the next run', async () => {
    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 3, left: 1 });
    expect(await journal()).toEqual(before);
  });

  it('replaces a payment\'s entry when NetSuite changes what it posts, and not when it only renames it', async () => {
    await edit('501', (p) => { p.number = 'PMT501-A'; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, unchanged: 3 });

    await edit('502', (p) => { p.total = '160.38'; p.discount = '1.62'; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, unchanged: 2 });
    const tail = (await journal()).slice(-2);
    expect(tail).toEqual([
      { no: 4, date: '2025-02-05', key: null, reverses: 2, memo: 'PMT502 changed in NetSuite' },
      { no: 5, date: '2025-02-05', key: 'payment:502:2', reverses: null, memo: 'PMT502, A Customer' },
    ]);
    expect((await linesOf(5)).map((l: any) => [l.source_line_ref, l.debit, l.credit])).toEqual([
      ['deposit', '160.38', '0.00'], ['discount', '1.62', '0.00'], ['receivable', '0.00', '162.00'],
    ]);
  });

  it('reverses the entry of a payment NetSuite deletes, voids, or that comes to nothing now, once', async () => {
    await edit('501', (p) => { p.deleted = true; });
    await edit('507', (p) => { p.voided = true; });
    // Out of the GL copy with its money unchanged: the copy hasn't caught up, so its entry stays.
    await edit('502', (p) => { p.company = null; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 2, left: 2 });
    expect((await journal()).slice(-2).map((e) => [e.reverses, e.memo])).toEqual([
      [1, 'PMT501-A deleted in NetSuite'],
      [3, 'PMT507 voided in NetSuite'],
    ]);

    // $0 now, and NetSuite posts no lines for $0: nothing to post, so its entry is reversed.
    await edit('502', (p) => { p.total = '0.00'; p.discount = undefined; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 1, left: 1 });
    expect((await journal()).slice(-1).map((e) => [e.reverses, e.memo])).toEqual([[5, 'PMT502 comes to nothing in NetSuite']]);

    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0 });
    expect(await journal()).toEqual(before);
  });

  it('posts a payment once the rule can work it out, and names one the journal refuses, without amounts', async () => {
    await edit('503', (p) => { p.deposit = '110'; });
    // To a discount account NetSuite has made inactive since, and to one only 1084 may use.
    payments.set('508', { ref: '508', number: 'PMT508', date: '2025-03-07', company: 'BMG', total: '9.00', discount: '1.00', discountAccount: '490' });
    payments.set('509', { ref: '509', number: 'PMT509', date: '2025-03-08', company: 'BMG', total: '8.00', discount: '2.00', discountAccount: '491' });
    await copy(pg, payments.get('508')!);
    await copy(pg, payments.get('509')!);

    const r = await run();
    expect(r).toMatchObject({ posted: 2, failedCount: 1, failed: [{ number: 'PMT509', reason: 'Account 4910 (Discounts 1084) belongs to another company' }] });
    const posted = (await journal()).slice(-2);
    expect(posted.map((e) => e.key)).toEqual(['payment:503:1', 'payment:508:1']);
    // The inactive account takes the discount NetSuite posted to it.
    expect((await linesOf(posted[1].no)).filter((l: any) => l.account === '490').map((l: any) => [l.debit, l.credit])).toEqual([['1.00', '0.00']]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);
  });
});
