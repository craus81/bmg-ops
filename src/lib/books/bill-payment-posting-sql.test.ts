// Migration 390 reads what the journal holds for NetSuite's bill payments,
// and lets the differences page say what the copy of the bill payments holds
// for one; the posting job posts them with the bill payment rule. This runs
// migration 314 (with stand-ins for the app tables it points at) and
// migrations 359–364, 367, 370, 374, 376, 377, 380, 382–387, 389 and 390,
// with the ones the job reads checks, card charges, journal entries, bank
// deposits and transfers through (391–394), in an in-memory Postgres
// (PGlite) as the app's server login and holds the functions' rules, then
// runs the posting job against them with bill payments only.
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

import { BOOKS_INVOICE_POSTING, postInvoices, type BillPaymentPosting } from './invoice-posting';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { NETSUITE_TYPE } from './differences';

/**
 * Made-up chart: '200' BMG's payables, '210' 1084's, '100' BMG's checking,
 * '101' checking no longer used, '106' checking only 1084 may use, '220' a
 * company card, '485' purchase discounts.
 */
const ACCOUNTS: Array<[string, string, string, string, 'BMG' | '1084' | null, boolean]> = [
  ['200', '2000', 'Accounts Payable', 'accounts_payable', 'BMG', true],
  ['210', '2100', 'Accounts Payable 1084', 'accounts_payable', '1084', true],
  ['100', '1000', 'Checking', 'bank', 'BMG', true],
  ['101', '1010', 'Old Checking', 'bank', 'BMG', false],
  ['106', '1060', 'Checking 1084', 'bank', '1084', true],
  ['220', '2200', 'Company Card', 'credit_card', 'BMG', true],
  ['485', '4850', 'Purchase Discounts', 'other_income', null, true],
];
const accountId = (ns: string) => `a0000000-0000-4000-8000-000000000${ns}`;
const JAN = '2025-01-01';
const FEB = '2025-02-01';
const MAR = '2025-03-01';
const PAYMENT_KINDS = { bill_payment: NETSUITE_TYPE.bill_payment };

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
  await pg.exec(`UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084'`);
  for (const [ns, number, name, type, company, active] of ACCOUNTS) {
    await pg.query(
      `INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, company_id, active)
       VALUES ($1, $2, $3, $4, $5, (SELECT id FROM gl_companies WHERE code = $6), $7)`,
      [accountId(ns), number, name, type, ns, company, active],
    );
  }
  // NetSuite's vendors, as the lists copy has them.
  for (const [id, name] of [['50', 'Sample Supply Co'], ['51', 'Another Supplier']]) {
    await pg.query(
      `INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES ('vendor', $1, $2, true, '{"payables_account": "200"}'::jsonb)`,
      [id, name],
    );
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

/** A Postgres text[] literal, as PostgREST sends a list. */
const textArray = (items: string[]) => `{${items.map((s) => `"${s.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;

// ── NetSuite's bill payments, and the copies of them ───────────────────────

interface NsPayment {
  ref: string;
  number: string | null;
  date: string;
  /** The month NetSuite booked it into; its own unless said. */
  booked?: string;
  /** The company NetSuite posted it to; null when the GL copy has none of it. */
  company: 'BMG' | '1084' | null;
  /** The money paid. */
  total: string;
  /** Where the money came from, on NetSuite's main line: '100' unless said. */
  from?: string;
  /** What BMG took off for paying early, which NetSuite books to '485'. */
  discount?: string;
  /** NetSuite's GL lines as they are, when they aren't the usual ones: [line id, account, cents debit positive]. */
  gl?: Array<[string, string, number]>;
  /** NetSuite's vendor: '50' unless said. */
  vendor?: string;
  /** NetSuite's status for it. */
  status?: string;
  voided?: boolean;
  /** NetSuite no longer has it. */
  gone?: boolean;
}

const cents = (amount: string) => Math.round(Number(amount) * 100);
const money = (c: number) => (c / 100).toFixed(2);

/** Copies a bill payment as the bill payments copy (migration 389) and the GL copy would. */
async function copy(pg: PGlite, p: NsPayment) {
  await pg.query('SELECT gl_netsuite_bill_payments_apply($1::jsonb)', [JSON.stringify({
    rows: [{
      netsuite_id: p.ref, tran_type: 'VendPymt', tranid: p.number, trandate: p.date, vendor_netsuite_id: p.vendor ?? '50',
      vendor_name: `V-${p.vendor ?? '50'}`, total: p.total, status: null, status_label: p.voided ? 'Voided' : p.status ?? null,
      voided: !!p.voided, memo: null, links: [{ netsuite_id: `7${p.ref}`, type: 'VendBill', number: `B-7${p.ref}`, amount: p.total, link_type: 'Payment' }],
    }],
  })]);
  await pg.query(`UPDATE gl_netsuite_bill_payments SET gone_at = ${p.gone ? 'now()' : 'NULL'} WHERE netsuite_id = $1`, [p.ref]);
  await pg.query('DELETE FROM gl_netsuite_lines WHERE transaction_id = $1', [p.ref]);
  await pg.query('DELETE FROM gl_netsuite_transactions WHERE netsuite_id = $1', [p.ref]);
  if (!p.company || p.gone) return;
  const paid = cents(p.total);
  const off = cents(p.discount ?? '0');
  const posted = (p.gl ?? [
    ['0', p.from ?? '100', -paid],
    ['1', p.company === 'BMG' ? '200' : '210', paid + off],
    ['2', '485', -off],
  ]).filter(([, , c]) => c !== 0);
  // NetSuite posts nothing for $0.
  if (!posted.length) return;
  const month = p.booked ?? `${p.date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, 'VendPymt', $2, $3, $4, 'x', 's')`,
    [p.ref, p.number, p.date, month],
  );
  for (const [line, account, c] of posted) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, $4, $5, $6, $7 FROM gl_companies WHERE code = $8`,
      [p.ref, line, account, month, p.date, money(Math.max(c, 0)), money(Math.max(-c, 0)), p.company],
    );
  }
}

// ── The functions ──────────────────────────────────────────────────────────

describe('migration 390\'s functions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    await copy(db, { ref: '801', number: 'CHK1001', date: '2025-03-05', company: 'BMG', total: '500.00' });
    await copy(db, { ref: '802', number: 'CHK1002', date: '2025-03-10', company: 'BMG', total: '30.00', vendor: '51' });
    await copy(db, { ref: '803', number: 'CHK1003', date: '2025-03-12', company: 'BMG', total: '20.00', voided: true });
    await copy(db, { ref: '804', number: 'CHK1004', date: '2025-03-14', company: 'BMG', total: '60.00', gone: true });
    // A vendor the copy of NetSuite's vendors doesn't have, though an item has the same NetSuite id.
    await copy(db, { ref: '806', number: 'CHK1006', date: '2025-03-16', company: 'BMG', total: '15.00', vendor: '59' });
    await db.query(`INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES ('item', '59', 'SOME-ITEM', true)`);
    await copy(db, { ref: '807', number: 'CHK1007', date: '2025-03-18', company: 'BMG', total: '12.00' });
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0].r;
  const entry = (company: string, key: string, sourceType: string, sourceId: string, amount: string, fields: Record<string, unknown> = {}) => ({
    company,
    entry_date: '2025-03-05',
    source_type: sourceType,
    source_id: sourceId,
    posting_rule: 'bill_payment@1',
    idempotency_key: key,
    memo: `CHK${sourceId}, Sample Supply Co`,
    lines: [
      { account_id: accountId(company === 'BMG' ? '200' : '210'), debit: amount, source_line_ref: 'payables', vendor_ref: '50' },
      { account_id: accountId(company === 'BMG' ? '100' : '106'), credit: amount, source_line_ref: 'paid_from' },
    ],
    ...fields,
  });
  const post = (p: unknown) => one<{ id: string; entry_no: number }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify(p)]);
  const postings = async (company: string, ids: string[] | null, lines: boolean) =>
    (await one<{ payments: BillPaymentPosting[] }>('SELECT gl_bill_payment_postings($1, $2::text[], $3) AS r', [company, ids && textArray(ids), lines])).payments;

  it('gl_bill_payment_postings says what the journal holds for each bill payment and what the copy says of it', async () => {
    const first = await post(entry('BMG', 'bill_payment:801:1', 'bill_payment', '801', '500.00'));
    const second = (await one<{ entry: { id: string; entry_no: number } }>(
      'SELECT gl_repost_entry($1::uuid, $2, $3::jsonb) AS r',
      [first.id, 'CHK1001 changed in NetSuite', JSON.stringify(entry('BMG', 'bill_payment:801:2', 'bill_payment', '801', '450.00'))],
    )).entry;
    const discounted = await post(entry('BMG', 'bill_payment:802:1', 'bill_payment', '802', '30.00', {
      entry_date: '2025-03-10',
      lines: [
        { account_id: accountId('200'), debit: '32.00', source_line_ref: 'payables', vendor_ref: '51' },
        { account_id: accountId('100'), credit: '30.00', source_line_ref: 'paid_from' },
        { account_id: accountId('485'), credit: '2.00', source_line_ref: 'discount' },
      ],
    }));
    const voided = await post(entry('BMG', 'bill_payment:803:1', 'bill_payment', '803', '20.00'));
    const gone = await post(entry('BMG', 'bill_payment:804:1', 'bill_payment', '804', '60.00'));
    // Not in the copy of NetSuite's bill payments, and 1084's.
    const other = await post(entry('1084', 'bill_payment:805:1', 'bill_payment', '805', '5.00'));
    // A bill's entry under a bill payment's NetSuite id is another document's.
    await post(entry('BMG', 'vendor_bill:801:1', 'vendor_bill', '801', '1.00', {
      posting_rule: 'bill@1',
      lines: [
        { account_id: accountId('200'), credit: '1.00', source_line_ref: 'payables', vendor_ref: '50' },
        { account_id: accountId('485'), debit: '1.00', source_line_ref: '1' },
      ],
    }));
    // Two entries standing for one payment, which the posting job reverses down to one: the newer is the one that stands.
    const older = await post(entry('BMG', 'bill_payment:808:1', 'bill_payment', '808', '8.00', { entry_date: '2025-04-10' }));
    const newer = await post(entry('BMG', 'bill_payment:808:2', 'bill_payment', '808', '8.00', { entry_date: '2025-04-11' }));

    const held = await postings('BMG', null, false);
    expect(held.map((p) => [p.source_type, p.source_id, p.entries, p.payment])).toEqual([
      ['bill_payment', '801', 2, { number: 'CHK1001', deleted: false, voided: false }],
      ['bill_payment', '802', 1, { number: 'CHK1002', deleted: false, voided: false }],
      ['bill_payment', '803', 1, { number: 'CHK1003', deleted: false, voided: true }],
      ['bill_payment', '804', 1, { number: 'CHK1004', deleted: true, voided: false }],
      ['bill_payment', '808', 2, null],
    ]);
    expect(held[4]).toMatchObject({
      unreversed: [newer.id, older.id],
      current: { id: newer.id, entry_no: newer.entry_no, entry_date: '2025-04-11', lines: null },
    });
    expect(held[0]).toEqual({
      source_type: 'bill_payment',
      source_id: '801',
      entries: 2,
      unreversed: [second.id],
      history: [
        { entry_no: first.entry_no, entry_date: '2025-03-05', reversed_by: first.entry_no + 1 },
        { entry_no: second.entry_no, entry_date: '2025-03-05', reversed_by: null },
      ],
      current: { id: second.id, entry_no: second.entry_no, entry_date: '2025-03-05', lines: null },
      payment: { number: 'CHK1001', deleted: false, voided: false },
    });
    expect(held.map((p) => p.current?.id)).toEqual([second.id, discounted.id, voided.id, gone.id, newer.id]);

    // Only the ones asked about, with the lines of the entry that stands, the vendor on payables.
    const [asked] = await postings('BMG', ['802', '999'], true);
    expect(asked.current?.lines).toEqual([
      { account: '200', debit: '32.00', credit: '0.00', division: null, source_line_ref: 'payables', customer_id: null, vendor_ref: '51' },
      { account: '100', debit: '0.00', credit: '30.00', division: null, source_line_ref: 'paid_from', customer_id: null, vendor_ref: null },
      { account: '485', debit: '0.00', credit: '2.00', division: null, source_line_ref: 'discount', customer_id: null, vendor_ref: null },
    ]);
    expect((await postings('1084', null, false)).map((p) => [p.source_id, p.current?.id, p.payment])).toEqual([['805', other.id, null]]);
  });

  it('gl_books_difference_documents says what the copy of the bill payments holds for one that differs, the vendor as its party', async () => {
    // CHK1007's entry is $2 short of what NetSuite posted.
    await post(entry('BMG', 'bill_payment:807:1', 'bill_payment', '807', '10.00', { entry_date: '2025-03-18' }));
    // CHK1006 isn't posted.
    const diff = await one<{ counts: Record<string, number>; documents: any[] }>(
      'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r', ['BMG', MAR, JSON.stringify(PAYMENT_KINDS), 10],
    );
    // CHK1004's entry stands though NetSuite no longer has it, CHK1001's is $50 short of what NetSuite posted,
    // CHK1002's takes a discount NetSuite didn't book; the biggest gap first. CHK1003's matches what NetSuite's GL
    // still holds for it, voided or not, and 808's entries are April's.
    expect(diff.counts).toEqual({ bill_payment: 5 });
    expect(diff.documents.map((d) => [d.kind, d.netsuite_id, d.copy])).toEqual([
      ['bill_payment', '804', { number: 'CHK1004', customer: 'Sample Supply Co', voided: false, deleted: true }],
      ['bill_payment', '801', { number: 'CHK1001', customer: 'Sample Supply Co', voided: false, deleted: false }],
      ['bill_payment', '806', { number: 'CHK1006', customer: 'V-59', voided: false, deleted: false }],
      ['bill_payment', '802', { number: 'CHK1002', customer: 'Another Supplier', voided: false, deleted: false }],
      ['bill_payment', '807', { number: 'CHK1007', customer: 'Sample Supply Co', voided: false, deleted: false }],
    ]);
    expect(diff.documents[0].netsuite).toBeNull();
    expect(diff.documents[1].netsuite).toEqual({ type: 'VendPymt', number: 'CHK1001', date: '2025-03-05', month: MAR });

    // The bill's entry under CHK1001's NetSuite id differs too, and the copy of the bill payments says nothing of it.
    const mixed = await one<{ documents: any[] }>(
      'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r',
      ['BMG', MAR, JSON.stringify({ ...PAYMENT_KINDS, vendor_bill: 'VendBill' }), 10],
    );
    expect(mixed.documents.filter((d) => d.kind === 'vendor_bill').map((d) => [d.netsuite_id, d.copy])).toEqual([['801', null]]);
  });

  it('is the service role\'s alone, and the new read writes nothing', async () => {
    for (const fn of ['gl_bill_payment_postings(text, text[], boolean)', 'gl_books_difference_documents(text, date, jsonb, integer)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>('SELECT has_function_privilege($1::name, $2, \'EXECUTE\') AS r', [role, fn]), `${role} ${fn}`)
          .toBe(role === 'service_role');
      }
    }
    const body = await one<string>(`SELECT prosrc AS r FROM pg_proc WHERE proname = 'gl_bill_payment_postings'`);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it('says gl_lines.vendor_ref holds a bill payment\'s vendor too', async () => {
    const comment = await one<string | null>(
      `SELECT col_description(a.attrelid, a.attnum) AS r FROM pg_attribute a
       WHERE a.attrelid = 'public.gl_lines'::regclass AND a.attname = 'vendor_ref'`,
    );
    expect(comment).toMatch(/^The vendor a line is owed to or by: its NetSuite internal id.*of a bill payment \(migration 390\)/);
  });
});

// ── The job ────────────────────────────────────────────────────────────────

// Made-up bill payments, from December 2024 to March 2025.
const PAYMENTS = (): NsPayment[] => [
  { ref: '801', number: 'CHK1001', date: '2025-01-10', company: 'BMG', total: '650.00' },
  // $650.00 of bills paid with $13.00 off.
  { ref: '802', number: 'CHK1002', date: '2025-02-05', company: 'BMG', total: '637.00', discount: '13.00', vendor: '51' },
  // NetSuite's posting doesn't say where the money came from: no main line, and two accounts credited.
  {
    ref: '803', number: 'CHK1003', date: '2025-02-20', company: 'BMG', total: '50.00',
    gl: [['1', '200', 5000], ['2', '100', -3000], ['3', '220', -2000]],
  },
  // 1084's don't post yet.
  { ref: '804', number: 'CHK1004', date: '2025-03-03', company: '1084', total: '80.00', from: '106' },
  // Not in the GL copy.
  { ref: '805', number: 'CHK1005', date: '2025-03-04', company: null, total: '75.00' },
  // Dated before the books start, booked by NetSuite into January 2025.
  { ref: '806', number: 'CHK1006', date: '2024-12-28', booked: JAN, company: 'BMG', total: '40.00' },
  // Paid by card.
  { ref: '807', number: 'CHK1007', date: '2025-03-06', company: 'BMG', total: '92.00', from: '220' },
  // $0: it only applies a bill credit to a bill, and nothing posts on either side.
  { ref: '809', number: 'CHK1009', date: '2025-03-08', company: 'BMG', total: '0.00' },
];

describe('the posting job, for bill payments', () => {
  let pg: PGlite;
  let clock = 0;
  /** How long a function takes, for running out of time. */
  const takes = new Map<string, number>();
  /** When a function fails, by what it was asked. */
  const failing = new Map<string, (args: Record<string, unknown>) => boolean>();
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
      clock += takes.get(fn) ?? 0;
      if (failing.get(fn)?.(args)) return { data: null, error: { message: `${fn} failed` } };
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

  // A bill payment's entry comes from its total and NetSuite's GL, so there's nothing to ask NetSuite.
  const query = async () => { throw new Error('NetSuite was asked about lines'); };
  const run = (budgetMs = 240_000) => postInvoices(service(), { deadline: clock + budgetMs, deps: { query, now: () => clock } });

  /** The journal, entry by entry: a document's entry by its key, a reversal by the entry it reverses. */
  const journal = async () => (await pg.query<{ no: number; date: string; key: string | null; reverses: number | null; memo: string | null }>(
    `SELECT e.entry_no::int AS no, to_char(e.entry_date, 'YYYY-MM-DD') AS date,
            CASE WHEN e.reverses_entry_id IS NULL THEN e.idempotency_key END AS key, r.entry_no::int AS reverses, e.memo
     FROM gl_entries e LEFT JOIN gl_entries r ON r.id = e.reverses_entry_id
     ORDER BY e.entry_no`,
  )).rows;
  const linesOf = async (no: number) => (await pg.query(
    `SELECT a.netsuite_account_id AS account, l.debit::text AS debit, l.credit::text AS credit, l.vendor_ref, l.source_line_ref
     FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id JOIN gl_entries e ON e.id = l.entry_id
     WHERE e.entry_no = $1 ORDER BY l.line_no`,
    [no],
  )).rows;
  const ruleOf = async (no: number) => (await pg.query<{ rule: string; type: string; source: string }>(
    'SELECT posting_rule AS rule, source_type AS type, source_id AS source FROM gl_entries WHERE entry_no = $1', [no],
  )).rows[0];
  const differing = async (month: string) => pg.query<{ r: { counts: Record<string, number>; documents: any[] } }>(
    'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r', ['BMG', month, JSON.stringify(PAYMENT_KINDS), 10],
  ).then((res) => res.rows[0].r);

  /** NetSuite changes a bill payment, and the copies catch up. */
  const edit = async (ref: string, change: (p: NsPayment) => void) => {
    const p = payments.get(ref)!;
    change(p);
    await copy(pg, p);
  };
  const add = async (p: NsPayment) => {
    payments.set(p.ref, p);
    await copy(pg, p);
  };

  beforeAll(async () => {
    pg = await freshDb();
    store.set(BOOKS_LISTS_SYNC, { last_result: { taxAccounts: [], itemAccounts: [] } });
    clock = Date.parse('2025-03-15T12:00:00Z');
    for (const p of PAYMENTS()) await add(p);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('posts each BMG bill payment the rule works out, once, in the month NetSuite booked it into, the vendor on payables', async () => {
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 4, replaced: 0, reversed: 0, unchanged: 0, left: 1, failedCount: 0 });
    expect(r.error).toBeUndefined();
    expect(r.notes).toBeUndefined();

    // Not CHK1003 (unworkable), CHK1004 (1084's), CHK1005 (not in the GL copy) or CHK1009 ($0).
    expect(await journal()).toEqual([
      { no: 1, date: JAN, key: 'bill_payment:806:1', reverses: null, memo: 'CHK1006, Sample Supply Co' },
      { no: 2, date: '2025-01-10', key: 'bill_payment:801:1', reverses: null, memo: 'CHK1001, Sample Supply Co' },
      { no: 3, date: '2025-02-05', key: 'bill_payment:802:1', reverses: null, memo: 'CHK1002, Another Supplier' },
      { no: 4, date: '2025-03-06', key: 'bill_payment:807:1', reverses: null, memo: 'CHK1007, Sample Supply Co' },
    ]);
    expect(await ruleOf(2)).toEqual({ rule: 'bill_payment@1', type: 'bill_payment', source: '801' });
    expect(await linesOf(2)).toEqual([
      { account: '200', debit: '650.00', credit: '0.00', vendor_ref: '50', source_line_ref: 'payables' },
      { account: '100', debit: '0.00', credit: '650.00', vendor_ref: null, source_line_ref: 'paid_from' },
    ]);
    // Payables take off the money and the discount; the discount goes where NetSuite booked it.
    expect(await linesOf(3)).toEqual([
      { account: '200', debit: '650.00', credit: '0.00', vendor_ref: '51', source_line_ref: 'payables' },
      { account: '100', debit: '0.00', credit: '637.00', vendor_ref: null, source_line_ref: 'paid_from' },
      { account: '485', debit: '0.00', credit: '13.00', vendor_ref: null, source_line_ref: 'discount' },
    ]);
    expect((await linesOf(4)).map((l: any) => [l.account, l.debit, l.credit])).toEqual([['200', '92.00', '0.00'], ['220', '0.00', '92.00']]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);

    // Differences: what's posted comes to NetSuite's; CHK1003 is the one bill payment that differs, and why can be told.
    expect((await differing(JAN)).counts).toEqual({});
    expect((await differing(MAR)).counts).toEqual({});
    const feb = await differing(FEB);
    expect(feb.counts).toEqual({ bill_payment: 1 });
    expect(feb.documents[0]).toMatchObject({
      kind: 'bill_payment', netsuite_id: '803', fleetsuite: { entries: 0, standing: null },
      copy: { number: 'CHK1003', customer: 'Sample Supply Co', voided: false, deleted: false },
    });
  });

  it('changes nothing on the next run', async () => {
    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 4, left: 1 });
    expect(await journal()).toEqual(before);
  });

  it('replaces an entry when NetSuite changes what it posts or who it paid, and not for a new number or status', async () => {
    await edit('801', (p) => { p.number = 'CHK1001-A'; p.status = 'Cleared'; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, unchanged: 4 });

    // A bigger discount: less money out, the same off payables.
    await edit('802', (p) => { p.total = '630.00'; p.discount = '20.00'; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, unchanged: 3 });
    expect((await journal()).slice(-2)).toEqual([
      { no: 5, date: '2025-02-05', key: null, reverses: 3, memo: 'CHK1002 changed in NetSuite' },
      { no: 6, date: '2025-02-05', key: 'bill_payment:802:2', reverses: null, memo: 'CHK1002, Another Supplier' },
    ]);
    expect((await linesOf(6)).map((l: any) => [l.source_line_ref, l.debit, l.credit])).toEqual([
      ['payables', '650.00', '0.00'], ['paid_from', '0.00', '630.00'], ['discount', '0.00', '20.00'],
    ]);

    // CHK1006 paid another vendor, and CHK1007 came out of checking, not the card.
    await edit('806', (p) => { p.vendor = '51'; });
    await edit('807', (p) => { p.from = '100'; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 2, unchanged: 2 });
    const [, moved, , paid] = (await journal()).slice(-4);
    expect(moved).toMatchObject({ no: 8, date: JAN, key: 'bill_payment:806:2', memo: 'CHK1006, Another Supplier' });
    expect((await linesOf(8)).map((l: any) => [l.source_line_ref, l.vendor_ref])).toEqual([['payables', '51'], ['paid_from', null]]);
    expect(paid).toMatchObject({ no: 10, date: '2025-03-06', key: 'bill_payment:807:2' });
    expect((await linesOf(10)).map((l: any) => [l.account, l.credit])).toEqual([['200', '0.00'], ['100', '92.00']]);
  });

  it('reverses the entry of a bill payment NetSuite voids, no longer has, or that comes to nothing now, once', async () => {
    await edit('801', (p) => { p.gone = true; });
    await edit('807', (p) => { p.voided = true; });
    // Out of the GL copy with its amount unchanged: the copy hasn't caught up, so its entry stays.
    await edit('802', (p) => { p.company = null; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 2, left: 2 });
    expect((await journal()).slice(-2).map((e) => [e.reverses, e.memo])).toEqual([
      [2, 'CHK1001-A deleted in NetSuite'],
      [10, 'CHK1007 voided in NetSuite'],
    ]);

    // $0 now, and NetSuite posts no lines for $0: nothing to post, so its entry is reversed.
    await edit('802', (p) => { p.total = '0.00'; p.discount = undefined; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 1, left: 1 });
    expect((await journal()).slice(-1).map((e) => [e.reverses, e.memo])).toEqual([[6, 'CHK1002 comes to nothing in NetSuite']]);

    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0 });
    expect(await journal()).toEqual(before);
  });

  it('posts a bill payment once the rule can work it out, and names one the journal refuses, without amounts', async () => {
    // NetSuite's posting of CHK1003 has its main line now.
    await edit('803', (p) => { p.gl = undefined; });
    // Out of a checking account NetSuite has made inactive since, and out of one only 1084 may use.
    await add({ ref: '810', number: 'CHK1010', date: '2025-03-07', company: 'BMG', total: '9.00', from: '101' });
    await add({ ref: '811', number: 'CHK1011', date: '2025-03-09', company: 'BMG', total: '8.00', from: '106' });

    const r = await run();
    expect(r).toMatchObject({ posted: 2, failedCount: 1, failed: [{ number: 'CHK1011', reason: 'Account 1060 (Checking 1084) belongs to another company' }] });
    const posted = (await journal()).slice(-2);
    expect(posted.map((e) => [e.date, e.key])).toEqual([['2025-02-20', 'bill_payment:803:1'], ['2025-03-07', 'bill_payment:810:1']]);
    // The inactive account gives the money NetSuite took out of it.
    expect((await linesOf(posted[1].no)).map((l: any) => [l.account, l.debit, l.credit])).toEqual([
      ['200', '9.00', '0.00'],
      ['101', '0.00', '9.00'],
    ]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);
  });

  it('never starts a bill payment write with under five seconds left, and does that month again next run', async () => {
    await edit('811', (p) => { p.from = '100'; });
    await add({ ref: '812', number: 'CHK1012', date: '2025-01-20', company: 'BMG', total: '40.00' });
    const before = await journal();

    takes.set('gl_bill_payment_month', 26_000);
    expect(await run(30_000)).toMatchObject({ months: [], posted: 0, partial: true });
    expect(store.get(BOOKS_INVOICE_POSTING).last_result.resume).toEqual({ company: 'BMG', month: JAN });
    expect(await journal()).toEqual(before);

    takes.clear();
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 2, failedCount: 0 });
    expect(r.partial).toBeUndefined();
    expect((await journal()).slice(-2).map((e) => e.key)).toEqual(['bill_payment:812:1', 'bill_payment:811:1']);
  });

  it('stops, saying why, and writes nothing when it can\'t read the bill payments or what the journal holds for them', async () => {
    // NetSuite changes CHK1012, so a run that could read everything would replace its entry.
    await edit('812', (p) => { p.total = '41.00'; });
    const before = await journal();
    const reads: Array<[string, (args: Record<string, unknown>) => boolean]> = [
      ['gl_bill_payment_month', () => true],
      // Step 1's read of every entry, then a month's read of its payments' entries.
      ['gl_bill_payment_postings', (args) => args.p_source_ids === null],
      ['gl_bill_payment_postings', (args) => args.p_source_ids !== null],
    ];
    for (const [fn, when] of reads) {
      failing.set(fn, when);
      const r = await run();
      failing.clear();
      expect(r.error, fn).toBe(`${fn} failed`);
      expect(await journal(), fn).toEqual(before);
    }

    // It can read them again: the next run carries on.
    const r = await run();
    expect(r).toMatchObject({ posted: 0, replaced: 1, failedCount: 0 });
    expect(r.error).toBeUndefined();
    expect((await journal()).slice(-1).map((e) => e.key)).toEqual(['bill_payment:812:2']);
  });
});
