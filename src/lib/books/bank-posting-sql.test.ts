// Migration 394 reads one company's NetSuite bank deposits and transfers for
// a month from the copy of NetSuite's GL, and what the journal holds for
// them; the posting job posts them with the bank rule. This runs migration
// 314 (with stand-ins for the app tables it points at) and migrations
// 359–364, 367, 370, 374, 376, 377, 380, 382–387 and 389–394, with the one
// the job reads stock documents through (395 and 397), in an in-memory Postgres
// (PGlite) as the app's server login and holds the
// functions' rules, then runs the posting job against them with bank
// deposits and transfers only.
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

import { BOOKS_INVOICE_POSTING, postInvoices, type BankPosting } from './invoice-posting';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { NETSUITE_TYPE } from './differences';
import type { BankMonthData } from './bank-check';

/**
 * Made-up chart: '100' BMG's checking, '105' Undeposited Funds, '106'
 * checking only 1084 may use, '107' 1084's savings, '110' BMG's savings,
 * '111' a savings account no longer used, '120' receivables, '200'
 * payables, '230' customer deposits, '480' other income.
 */
const ACCOUNTS: Array<[string, string, string, string, 'BMG' | '1084' | null, boolean]> = [
  ['100', '1000', 'Checking', 'bank', 'BMG', true],
  ['105', '1050', 'Undeposited Funds', 'other_current_asset', 'BMG', true],
  ['106', '1060', 'Checking 1084', 'bank', '1084', true],
  ['107', '1070', 'Savings 1084', 'bank', '1084', true],
  ['110', '1100', 'Savings', 'bank', 'BMG', true],
  ['111', '1110', 'Old Savings', 'bank', 'BMG', false],
  ['120', '1200', 'Receivables', 'accounts_receivable', 'BMG', true],
  ['200', '2000', 'Payables', 'accounts_payable', 'BMG', true],
  ['230', '2300', 'Customer Deposits', 'other_current_liability', 'BMG', true],
  ['480', '4800', 'Other Income', 'other_income', null, true],
];
const accountId = (ns: string) => `a0000000-0000-4000-8000-000000000${ns}`;
const CUSTOMER = '6f1f6a52-8a43-4b8e-9a0e-2d9c1f0b7c11';
const OTHER_CUSTOMER = '7a2b8c63-9b5c-4c9f-8b1e-3e0d2a1c8d22';
const JAN = '2025-01-01';
const FEB = '2025-02-01';
const MAR = '2025-03-01';
const BANK_KINDS = { bank_deposit: NETSUITE_TYPE.bank_deposit, bank_transfer: NETSUITE_TYPE.bank_transfer };

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
    '397-books-stock-postings-once.sql',
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
  // NetSuite's vendors, as the lists copy has them, and an item with NetSuite id 59.
  for (const [id, name] of [['50', 'Sample Supply Co'], ['51', 'Another Supplier']]) {
    await pg.query(`INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES ('vendor', $1, $2, true)`, [id, name]);
  }
  await pg.query(`INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES ('item', '59', 'SOME-ITEM', true)`);
  // The ledger mirror's customers: NetSuite's 310 and 312 matched to FleetSuite customers by their NetSuite ids, as
  // invoices are, and 311 only by hand, which invoices don't go by either.
  await pg.exec(`
    INSERT INTO public.customers (id) VALUES ('${CUSTOMER}'), ('${OTHER_CUSTOMER}');
    INSERT INTO ledger_customers (source, external_id, external_ref, display_name, cleaned_name, customer_id, match_status) VALUES
      ('netsuite', 'customer/310', '310', 'A Customer', 'A Customer', '${CUSTOMER}', 'exact'),
      ('netsuite', 'customer/311', '311', 'Hand-matched Customer', 'Hand-matched Customer', '${OTHER_CUSTOMER}', 'manual'),
      ('netsuite', 'customer/312', '312', 'Another Customer', 'Another Customer', '${OTHER_CUSTOMER}', 'exact');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

/** A Postgres text[] literal, as PostgREST sends a list. */
const textArray = (items: string[]) => `{${items.map((s) => `"${s.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;

// ── NetSuite's bank deposits and transfers, as the copy of its GL has them ─

type Company = 'BMG' | '1084';
/** A line in the copy of NetSuite's GL: [line id, company, account, cents debit positive, memo, NetSuite id of its name]. */
type NsLine = [string, Company, string, number, (string | null)?, (string | null)?];

interface NsDocument {
  ref: string;
  /** NetSuite's transaction type: 'Deposit' or 'Transfer', or another to show it isn't read. */
  type: string;
  number: string | null;
  date: string;
  /** The month NetSuite booked it into; its own unless said. */
  booked?: string;
  lines: NsLine[];
  /** NetSuite no longer has it. */
  gone?: boolean;
}

const money = (c: number) => (c / 100).toFixed(2);

/** Copies a document as the copy of NetSuite's GL (migration 361) would, its lines replaced whole. */
async function copy(pg: PGlite, d: NsDocument) {
  await pg.query('DELETE FROM gl_netsuite_lines WHERE transaction_id = $1', [d.ref]);
  await pg.query('DELETE FROM gl_netsuite_transactions WHERE netsuite_id = $1', [d.ref]);
  if (d.gone) return;
  const month = d.booked ?? `${d.date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [d.ref, d.type, d.number, d.date, month],
  );
  for (const [line, company, account, c, memo, entity] of d.lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, memo, entity_id)
       SELECT $1, $2, id, $3, $4, $5, $6, $7, $8, $9 FROM gl_companies WHERE code = $10`,
      [d.ref, line, account, month, d.date, money(Math.max(c, 0)), money(Math.max(-c, 0)), memo ?? null, entity ?? null, company],
    );
  }
}

// ── The functions ──────────────────────────────────────────────────────────

describe('migration 394\'s functions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // Two customer payments taken out of Undeposited Funds and put in the bank, its lines out of order in the copy:
    // one customer matched to a FleetSuite customer, one only by hand.
    await copy(db, {
      ref: '8001', type: 'Deposit', number: 'DEP0412', date: '2025-03-15',
      lines: [['10', 'BMG', '105', -50000, 'PMT1977', '311'], ['2', 'BMG', '105', -100000, null, '310'], ['1', 'BMG', '100', 150000, 'Deposit 3/15']],
    });
    // A vendor's refund put in the bank, and a name the vendors copy doesn't have, though an item has the same NetSuite id.
    await copy(db, {
      ref: '8003', type: 'Deposit', number: 'DEP0413', date: '2025-03-15',
      lines: [['0', 'BMG', '100', 3200], ['1', 'BMG', '200', -2500, 'Refund', '50'], ['2', 'BMG', '480', -700, null, '59']],
    });
    // Money moved to savings.
    await copy(db, {
      ref: '8002', type: 'Transfer', number: 'TRN0031', date: '2025-03-20',
      lines: [['1', 'BMG', '110', 500000, 'To savings'], ['2', 'BMG', '100', -500000, 'To savings']],
    });
    // One with lines for both companies.
    await copy(db, {
      ref: '8004', type: 'Transfer', number: 'TRN0032', date: '2025-03-20',
      lines: [['1', 'BMG', '110', 3000], ['2', 'BMG', '100', -3000], ['3', '1084', '107', 2000], ['4', '1084', '106', -2000]],
    });
    // 1084's alone; dated in February and booked into March, with no number; April's; and a journal entry and a customer
    // deposit, which are neither.
    await copy(db, { ref: '8005', type: 'Deposit', number: 'DEP0414', date: '2025-03-05', lines: [['0', '1084', '106', 8000], ['1', '1084', '480', -8000]] });
    await copy(db, { ref: '8006', type: 'Deposit', number: null, date: '2025-02-28', booked: MAR, lines: [['0', 'BMG', '100', 1000], ['1', 'BMG', '105', -1000]] });
    await copy(db, { ref: '8007', type: 'Transfer', number: 'TRN0037', date: '2025-04-02', lines: [['1', 'BMG', '110', 1000], ['2', 'BMG', '100', -1000]] });
    await copy(db, { ref: '9001', type: 'Journal', number: 'JE1201', date: '2025-03-05', lines: [['1', 'BMG', '100', 2000], ['2', 'BMG', '480', -2000]] });
    await copy(db, { ref: '7001', type: 'CustDep', number: 'CD101', date: '2025-03-06', lines: [['1', 'BMG', '105', 2000], ['2', 'BMG', '230', -2000]] });
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0].r;
  const month = (company: string, m: string) => one<BankMonthData>('SELECT gl_bank_month($1, $2::date) AS r', [company, m]);

  it('gl_bank_month gives the company\'s bank deposits and transfers NetSuite booked into the month, each with its lines for the company', async () => {
    const mar = await month('BMG', MAR);
    // By date, then number; not 1084's, April's, the journal entry or the customer deposit.
    expect(mar.documents.map((d) => [d.netsuite_id, d.type, d.number, d.date, d.posting_month, d.companies])).toEqual([
      ['8006', 'Deposit', null, '2025-02-28', MAR, ['BMG']],
      ['8001', 'Deposit', 'DEP0412', '2025-03-15', MAR, ['BMG']],
      ['8003', 'Deposit', 'DEP0413', '2025-03-15', MAR, ['BMG']],
      ['8002', 'Transfer', 'TRN0031', '2025-03-20', MAR, ['BMG']],
      ['8004', 'Transfer', 'TRN0032', '2025-03-20', MAR, ['1084', 'BMG']],
    ]);
    const [, deposited, refunded, , shared] = mar.documents;
    // In NetSuite's order, 2 before 10, with a customer's name from the ledger mirror, and the FleetSuite customer only when
    // the mirror matched it by its NetSuite id.
    expect(deposited.lines).toEqual([
      { line_id: '1', account: '100', debit: '1500.00', credit: '0.00', memo: 'Deposit 3/15', entity_id: null, name: null, customer_id: null },
      { line_id: '2', account: '105', debit: '0.00', credit: '1000.00', memo: null, entity_id: '310', name: 'A Customer', customer_id: CUSTOMER },
      {
        line_id: '10', account: '105', debit: '0.00', credit: '500.00', memo: 'PMT1977', entity_id: '311', name: 'Hand-matched Customer',
        customer_id: null,
      },
    ]);
    // A vendor's name from the vendors copy, never an item's.
    expect(refunded.lines.map((l) => [l.entity_id, l.name, l.customer_id])).toEqual([[null, null, null], ['50', 'Sample Supply Co', null], ['59', null, null]]);
    // Only this company's lines of one with lines for both.
    expect(shared.lines.map((l) => [l.line_id, l.account])).toEqual([['1', '110'], ['2', '100']]);

    const other = await month('1084', MAR);
    expect(other.documents.map((d) => [d.netsuite_id, d.type, d.companies, d.lines.map((l) => l.line_id)])).toEqual([
      ['8005', 'Deposit', ['1084'], ['0', '1']], ['8004', 'Transfer', ['1084', 'BMG'], ['3', '4']],
    ]);
    // Any day of the month reads the month; a month with none reads none.
    expect((await month('BMG', '2025-04-15')).documents.map((d) => d.netsuite_id)).toEqual(['8007']);
    expect(await month('BMG', FEB)).toEqual({ documents: [] });
  });

  /** A bank deposit's entry, money put in checking from Undeposited Funds; `fields` change it. */
  const entry = (company: string, key: string, sourceId: string, amount: string, fields: Record<string, unknown> = {}) => ({
    company,
    entry_date: '2025-03-15',
    source_type: 'bank_deposit',
    source_id: sourceId,
    posting_rule: 'bank@1',
    idempotency_key: key,
    memo: `Deposit ${sourceId}`,
    lines: [
      { account_id: accountId(company === 'BMG' ? '100' : '106'), debit: amount, source_line_ref: '1' },
      { account_id: accountId(company === 'BMG' ? '105' : '480'), credit: amount, source_line_ref: '2' },
    ],
    ...fields,
  });
  const post = (p: unknown) => one<{ id: string; entry_no: number }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify(p)]);
  const postings = async (company: string, ids: string[] | null, lines: boolean) =>
    (await one<{ documents: BankPosting[] }>('SELECT gl_bank_postings($1, $2::text[], $3) AS r', [company, ids && textArray(ids), lines])).documents;

  it('gl_bank_postings says what the journal holds for each and what the copy of NetSuite\'s GL says of it now', async () => {
    const first = await post(entry('BMG', 'bank_deposit:8001:1', '8001', '1500.00', { memo: 'DEP0412' }));
    const second = (await one<{ entry: { id: string; entry_no: number } }>(
      'SELECT gl_repost_entry($1::uuid, $2, $3::jsonb) AS r',
      [first.id, 'DEP0412 changed in NetSuite', JSON.stringify(entry('BMG', 'bank_deposit:8001:2', '8001', '1600.00', { memo: 'DEP0412' }))],
    )).entry;
    await post(entry('BMG', 'bank_deposit:8003:1', '8003', '32.00', {
      memo: 'DEP0413',
      lines: [
        { account_id: accountId('100'), debit: '32.00', source_line_ref: '0' },
        { account_id: accountId('200'), credit: '25.00', source_line_ref: '1', vendor_ref: '50', memo: 'Sample Supply Co · Refund' },
        { account_id: accountId('120'), credit: '7.00', source_line_ref: '2', customer_id: CUSTOMER, memo: 'A Customer' },
      ],
    }));
    await post(entry('BMG', 'bank_transfer:8002:1', '8002', '5000.00', {
      source_type: 'bank_transfer', entry_date: '2025-03-20', memo: 'TRN0031',
      lines: [
        { account_id: accountId('110'), debit: '5000.00', source_line_ref: '1' },
        { account_id: accountId('100'), credit: '5000.00', source_line_ref: '2' },
      ],
    }));
    // NetSuite moved it to 1084 or deleted it, or the NetSuite id is another kind's: the copy has none of it for BMG.
    await post(entry('BMG', 'bank_deposit:8005:1', '8005', '80.00', { memo: 'DEP0414' }));
    await post(entry('BMG', 'bank_deposit:8008:1', '8008', '12.00', { memo: 'DEP0418' }));
    await post(entry('BMG', 'bank_deposit:8002:1', '8002', '1.00', { memo: 'TRN0031' }));
    await post(entry('BMG', 'bank_transfer:9001:1', '9001', '20.00', { source_type: 'bank_transfer', memo: 'JE1201' }));
    // 1084's.
    const other = await post(entry('1084', 'bank_deposit:8005:1-1084', '8005', '80.00', { memo: 'DEP0414' }));
    // A journal entry's entry under a bank deposit's NetSuite id is another document's, and one filed as a bank deposit
    // with no NetSuite id is no document's.
    await post(entry('BMG', 'journal_entry:8001:1', '8001', '1.00', { source_type: 'journal_entry', posting_rule: 'journal_entry@1' }));
    await post(entry('BMG', 'bank_deposit:none:1', '', '2.00'));
    // Two entries standing for one transfer, which the posting job reverses down to one: the newer is the one that stands.
    const older = await post(entry('BMG', 'bank_transfer:8010:1', '8010', '8.00', { source_type: 'bank_transfer', entry_date: '2025-04-10', memo: 'TRN0040' }));
    const newer = await post(entry('BMG', 'bank_transfer:8010:2', '8010', '8.00', { source_type: 'bank_transfer', entry_date: '2025-04-11', memo: 'TRN0040-A' }));

    const held = await postings('BMG', null, false);
    // Once the copy no longer has one, the newest entry's memo gives its number.
    expect(held.map((p) => [p.source_type, p.source_id, p.entries, p.document])).toEqual([
      ['bank_deposit', '8001', 2, { number: 'DEP0412', deleted: false }],
      ['bank_deposit', '8002', 1, { number: 'TRN0031', deleted: true }],
      ['bank_transfer', '8002', 1, { number: 'TRN0031', deleted: false }],
      ['bank_deposit', '8003', 1, { number: 'DEP0413', deleted: false }],
      ['bank_deposit', '8005', 1, { number: 'DEP0414', deleted: true }],
      ['bank_deposit', '8008', 1, { number: 'DEP0418', deleted: true }],
      ['bank_transfer', '8010', 2, { number: 'TRN0040-A', deleted: true }],
      ['bank_transfer', '9001', 1, { number: 'JE1201', deleted: true }],
    ]);
    expect(held[6]).toMatchObject({
      unreversed: [newer.id, older.id],
      current: { id: newer.id, entry_no: newer.entry_no, entry_date: '2025-04-11', lines: null },
    });
    expect(held[0]).toEqual({
      source_type: 'bank_deposit',
      source_id: '8001',
      entries: 2,
      unreversed: [second.id],
      history: [
        { entry_no: first.entry_no, entry_date: '2025-03-15', reversed_by: first.entry_no + 1 },
        { entry_no: second.entry_no, entry_date: '2025-03-15', reversed_by: null },
      ],
      current: { id: second.id, entry_no: second.entry_no, entry_date: '2025-03-15', lines: null },
      document: { number: 'DEP0412', deleted: false },
    });

    // Only the ones asked about, with the lines of the entry that stands: the customer on receivables, the vendor on payables.
    const asked = await postings('BMG', ['8003', '8002', '9999'], true);
    expect(asked.map((p) => [p.source_type, p.source_id, p.current?.lines])).toEqual([
      ['bank_deposit', '8002', [
        { account: '100', debit: '1.00', credit: '0.00', division: null, source_line_ref: '1', customer_id: null, vendor_ref: null },
        { account: '105', debit: '0.00', credit: '1.00', division: null, source_line_ref: '2', customer_id: null, vendor_ref: null },
      ]],
      ['bank_transfer', '8002', [
        { account: '110', debit: '5000.00', credit: '0.00', division: null, source_line_ref: '1', customer_id: null, vendor_ref: null },
        { account: '100', debit: '0.00', credit: '5000.00', division: null, source_line_ref: '2', customer_id: null, vendor_ref: null },
      ]],
      ['bank_deposit', '8003', [
        { account: '100', debit: '32.00', credit: '0.00', division: null, source_line_ref: '0', customer_id: null, vendor_ref: null },
        { account: '200', debit: '0.00', credit: '25.00', division: null, source_line_ref: '1', customer_id: null, vendor_ref: '50' },
        { account: '120', debit: '0.00', credit: '7.00', division: null, source_line_ref: '2', customer_id: CUSTOMER, vendor_ref: null },
      ]],
    ]);
    expect((await postings('1084', null, false)).map((p) => [p.source_id, p.current?.id, p.document])).toEqual([
      ['8005', other.id, { number: 'DEP0414', deleted: false }],
    ]);
  });

  it('is the service role\'s alone, and neither read writes anything', async () => {
    for (const fn of ['gl_bank_month(text, date)', 'gl_bank_postings(text, text[], boolean)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>('SELECT has_function_privilege($1::name, $2, \'EXECUTE\') AS r', [role, fn]), `${role} ${fn}`)
          .toBe(role === 'service_role');
      }
    }
    for (const name of ['gl_bank_month', 'gl_bank_postings']) {
      const body = await one<string>('SELECT prosrc AS r FROM pg_proc WHERE proname = $1', [name]);
      expect(body, name).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    }
  });
});

// ── The job ────────────────────────────────────────────────────────────────

// Made-up bank deposits and transfers, from December 2024 to March 2025.
const DOCS = (): NsDocument[] => [
  // Two customer payments taken out of Undeposited Funds and put in the bank.
  {
    ref: '8001', type: 'Deposit', number: 'DEP0101', date: '2025-01-15',
    lines: [['0', 'BMG', '100', 150000, 'Deposit 1/15'], ['1', 'BMG', '105', -100000, null, '310'], ['2', 'BMG', '105', -50000, 'PMT1977', '311']],
  },
  // Money moved to savings.
  { ref: '8002', type: 'Transfer', number: 'TRN0011', date: '2025-02-03', lines: [['1', 'BMG', '110', 500000, 'To savings'], ['2', 'BMG', '100', -500000, 'To savings']] },
  // A vendor's refund and a customer paying at the counter, put in the bank together.
  {
    ref: '8003', type: 'Deposit', number: 'DEP0102', date: '2025-02-20',
    lines: [['0', 'BMG', '100', 3500], ['1', 'BMG', '200', -2500, 'Refund', '50'], ['2', 'BMG', '120', -1000, 'Paid at the counter', '310']],
  },
  // NetSuite gave it no number.
  { ref: '8004', type: 'Deposit', number: null, date: '2025-03-03', lines: [['0', 'BMG', '100', 1000], ['1', 'BMG', '105', -1000]] },
  // 1084's don't post yet.
  { ref: '8005', type: 'Transfer', number: 'TRN0012', date: '2025-03-04', lines: [['1', '1084', '107', 8000], ['2', '1084', '106', -8000]] },
  // One with lines for both companies: BMG's lines are BMG's entry.
  {
    ref: '8006', type: 'Transfer', number: 'TRN0016', date: '2025-03-06',
    lines: [['1', 'BMG', '110', 3000], ['2', 'BMG', '100', -3000], ['3', '1084', '107', 2000], ['4', '1084', '106', -2000]],
  },
  // Money moved from 1084's checking into BMG's savings: BMG's lines don't balance on their own.
  { ref: '8007', type: 'Transfer', number: 'TRN0017', date: '2025-03-20', lines: [['1', 'BMG', '110', 3000], ['2', 'BMG', '100', -1000], ['3', '1084', '106', -2000]] },
  // Dated before the books start, booked by NetSuite into January 2025.
  { ref: '8008', type: 'Deposit', number: 'DEP0090', date: '2024-12-31', booked: JAN, lines: [['0', 'BMG', '100', 4000], ['1', 'BMG', '105', -4000]] },
  // $0.
  { ref: '8009', type: 'Deposit', number: 'DEP0109', date: '2025-03-09', lines: [['0', 'BMG', '100', 0], ['1', 'BMG', '105', 0]] },
];

describe('the posting job, for bank deposits and transfers', () => {
  let pg: PGlite;
  let clock = 0;
  /** How long a function takes, for running out of time. */
  const takes = new Map<string, number>();
  /** When a function fails, by what it was asked. */
  const failing = new Map<string, (args: Record<string, unknown>) => boolean>();
  const store = new Map<string, any>();
  const docs = new Map<string, NsDocument>();

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

  // A bank deposit's or transfer's entry is its lines in NetSuite's GL copy, so there's nothing to ask NetSuite.
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
    `SELECT a.netsuite_account_id AS account, l.debit::text AS debit, l.credit::text AS credit, l.memo, l.customer_id::text AS customer,
            l.vendor_ref, l.source_line_ref
     FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id JOIN gl_entries e ON e.id = l.entry_id
     WHERE e.entry_no = $1 ORDER BY l.line_no`,
    [no],
  )).rows;
  const ruleOf = async (no: number) => (await pg.query<{ rule: string; type: string; source: string }>(
    'SELECT posting_rule AS rule, source_type AS type, source_id AS source FROM gl_entries WHERE entry_no = $1', [no],
  )).rows[0];
  const differing = async (month: string) => pg.query<{ r: { counts: Record<string, number>; documents: any[] } }>(
    'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r', ['BMG', month, JSON.stringify(BANK_KINDS), 10],
  ).then((res) => res.rows[0].r);

  /** NetSuite changes a document, and the GL copy catches up. */
  const edit = async (ref: string, change: (d: NsDocument) => void) => {
    const d = docs.get(ref)!;
    change(d);
    await copy(pg, d);
  };
  const add = async (d: NsDocument) => {
    docs.set(d.ref, d);
    await copy(pg, d);
  };

  beforeAll(async () => {
    pg = await freshDb();
    store.set(BOOKS_LISTS_SYNC, { last_result: { taxAccounts: [], itemAccounts: [] } });
    clock = Date.parse('2025-03-15T12:00:00Z');
    for (const d of DOCS()) await add(d);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('posts each BMG bank deposit and transfer once, in the month NetSuite booked it into, with its lines as NetSuite has them', async () => {
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 6, replaced: 0, reversed: 0, unchanged: 0, left: 1, failedCount: 0 });
    expect(r.error).toBeUndefined();
    expect(r.notes).toEqual([
      "FleetSuite can't post 1 bank deposit or transfer, as its lines for the company don't balance on their own, so whatever FleetSuite "
        + 'holds for it stayed as it is: TRN0017. The Bank deposits and transfers switch on Invoices vs NetSuite shows its lines.',
    ]);

    // Not TRN0012 (1084's), TRN0017 (doesn't balance for BMG) or DEP0109 ($0).
    expect(await journal()).toEqual([
      { no: 1, date: JAN, key: 'bank_deposit:8008:1', reverses: null, memo: 'DEP0090' },
      { no: 2, date: '2025-01-15', key: 'bank_deposit:8001:1', reverses: null, memo: 'DEP0101' },
      { no: 3, date: '2025-02-03', key: 'bank_transfer:8002:1', reverses: null, memo: 'TRN0011' },
      { no: 4, date: '2025-02-20', key: 'bank_deposit:8003:1', reverses: null, memo: 'DEP0102' },
      { no: 5, date: '2025-03-03', key: 'bank_deposit:8004:1', reverses: null, memo: 'NetSuite 8004' },
      { no: 6, date: '2025-03-06', key: 'bank_transfer:8006:1', reverses: null, memo: 'TRN0016' },
    ]);
    expect(await ruleOf(2)).toEqual({ rule: 'bank@1', type: 'bank_deposit', source: '8001' });
    expect(await ruleOf(3)).toEqual({ rule: 'bank@1', type: 'bank_transfer', source: '8002' });
    // Each line with its memo and name; Undeposited Funds isn't receivables, so no customer goes on it.
    expect(await linesOf(2)).toEqual([
      { account: '100', debit: '1500.00', credit: '0.00', memo: 'Deposit 1/15', customer: null, vendor_ref: null, source_line_ref: '0' },
      { account: '105', debit: '0.00', credit: '1000.00', memo: 'A Customer', customer: null, vendor_ref: null, source_line_ref: '1' },
      { account: '105', debit: '0.00', credit: '500.00', memo: 'Hand-matched Customer · PMT1977', customer: null, vendor_ref: null, source_line_ref: '2' },
    ]);
    expect(await linesOf(3)).toEqual([
      { account: '110', debit: '5000.00', credit: '0.00', memo: 'To savings', customer: null, vendor_ref: null, source_line_ref: '1' },
      { account: '100', debit: '0.00', credit: '5000.00', memo: 'To savings', customer: null, vendor_ref: null, source_line_ref: '2' },
    ]);
    // The vendor on the payables line, and the customer on the receivables line.
    expect(await linesOf(4)).toEqual([
      { account: '100', debit: '35.00', credit: '0.00', memo: null, customer: null, vendor_ref: null, source_line_ref: '0' },
      { account: '200', debit: '0.00', credit: '25.00', memo: 'Sample Supply Co · Refund', customer: null, vendor_ref: '50', source_line_ref: '1' },
      { account: '120', debit: '0.00', credit: '10.00', memo: 'A Customer · Paid at the counter', customer: CUSTOMER, vendor_ref: null, source_line_ref: '2' },
    ]);
    // Only BMG's lines of the one with lines for both companies.
    expect((await linesOf(6)).map((l: any) => [l.account, l.debit, l.credit, l.source_line_ref])).toEqual([
      ['110', '30.00', '0.00', '1'], ['100', '0.00', '30.00', '2'],
    ]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);

    // Differences: what's posted comes to NetSuite's; TRN0017 is the one that differs.
    expect((await differing(JAN)).counts).toEqual({});
    expect((await differing(FEB)).counts).toEqual({});
    const mar = await differing(MAR);
    expect(mar.counts).toEqual({ bank_transfer: 1 });
    expect(mar.documents[0]).toMatchObject({
      kind: 'bank_transfer', netsuite_id: '8007', fleetsuite: { entries: 0, standing: null }, copy: null,
      netsuite: { type: 'Transfer', number: 'TRN0017', date: '2025-03-20', month: MAR },
    });
  });

  it('changes nothing on the next run', async () => {
    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 6, left: 1 });
    expect(await journal()).toEqual(before);
  });

  it('replaces an entry when NetSuite changes an amount, an account, the date, a customer or a vendor, and not for a new number, memo or name', async () => {
    await edit('8001', (d) => {
      d.number = 'DEP0101-A';
      d.lines = [['0', 'BMG', '100', 150000, 'Deposit 1/15 at the branch'], ['1', 'BMG', '105', -100000, null, '310'], ['2', 'BMG', '105', -50000, 'PMT1977', '311']];
    });
    await pg.query(`UPDATE gl_netsuite_lists SET name = 'Sample Supply Company' WHERE kind = 'vendor' AND netsuite_id = '50'`);
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, unchanged: 6 });

    // A third payment put in with them.
    await edit('8001', (d) => {
      d.lines = [
        ['0', 'BMG', '100', 160000, 'Deposit 1/15 at the branch'], ['1', 'BMG', '105', -100000, null, '310'], ['2', 'BMG', '105', -50000, 'PMT1977', '311'],
        ['3', 'BMG', '105', -10000, null, '312'],
      ];
    });
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, unchanged: 5 });
    expect((await journal()).slice(-2)).toEqual([
      { no: 7, date: '2025-01-15', key: null, reverses: 2, memo: 'DEP0101-A changed in NetSuite' },
      { no: 8, date: '2025-01-15', key: 'bank_deposit:8001:2', reverses: null, memo: 'DEP0101-A' },
    ]);
    expect((await linesOf(8)).map((l: any) => [l.account, l.debit, l.credit, l.memo])).toEqual([
      ['100', '1600.00', '0.00', 'Deposit 1/15 at the branch'], ['105', '0.00', '1000.00', 'A Customer'],
      ['105', '0.00', '500.00', 'Hand-matched Customer · PMT1977'], ['105', '0.00', '100.00', 'Another Customer'],
    ]);

    // More moved to savings, another customer and vendor on DEP0102, a day later, and NetSuite moved DEP0090 into February.
    await edit('8002', (d) => { d.lines = [['1', 'BMG', '110', 600000, 'To savings'], ['2', 'BMG', '100', -600000, 'To savings']]; });
    await edit('8003', (d) => {
      d.lines = [['0', 'BMG', '100', 3500], ['1', 'BMG', '200', -2500, 'Refund', '51'], ['2', 'BMG', '120', -1000, 'Paid at the counter', '312']];
    });
    await edit('8004', (d) => { d.date = '2025-03-04'; });
    await edit('8008', (d) => { d.booked = FEB; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 4, unchanged: 2, left: 1 });
    expect((await journal()).slice(-8)).toEqual([
      { no: 9, date: JAN, key: null, reverses: 1, memo: 'DEP0090 changed in NetSuite' },
      { no: 10, date: FEB, key: 'bank_deposit:8008:2', reverses: null, memo: 'DEP0090' },
      { no: 11, date: '2025-02-03', key: null, reverses: 3, memo: 'TRN0011 changed in NetSuite' },
      { no: 12, date: '2025-02-03', key: 'bank_transfer:8002:2', reverses: null, memo: 'TRN0011' },
      { no: 13, date: '2025-02-20', key: null, reverses: 4, memo: 'DEP0102 changed in NetSuite' },
      { no: 14, date: '2025-02-20', key: 'bank_deposit:8003:2', reverses: null, memo: 'DEP0102' },
      { no: 15, date: '2025-03-03', key: null, reverses: 5, memo: 'NetSuite 8004 changed in NetSuite' },
      { no: 16, date: '2025-03-04', key: 'bank_deposit:8004:2', reverses: null, memo: 'NetSuite 8004' },
    ]);
    expect((await linesOf(14)).map((l: any) => [l.account, l.customer, l.vendor_ref, l.memo])).toEqual([
      ['100', null, null, null], ['200', null, '51', 'Another Supplier · Refund'], ['120', OTHER_CUSTOMER, null, 'Another Customer · Paid at the counter'],
    ]);
    // January no longer holds DEP0090, as NetSuite's January doesn't.
    expect((await differing(JAN)).counts).toEqual({});
    expect((await differing(FEB)).counts).toEqual({});
  });

  it('reverses the entry of one NetSuite deletes, moves to the other company, or that comes to nothing now, once', async () => {
    await edit('8001', (d) => { d.gone = true; });
    await edit('8006', (d) => { d.lines = [['3', '1084', '107', 2000], ['4', '1084', '106', -2000]]; });
    await edit('8004', (d) => { d.lines = [['0', 'BMG', '100', 0], ['1', 'BMG', '105', 0]]; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 3, unchanged: 3, left: 1 });
    // The number of one NetSuite no longer has comes from its entry's memo.
    expect((await journal()).slice(-3).map((e) => [e.reverses, e.memo])).toEqual([
      [8, 'DEP0101-A deleted in NetSuite'],
      [6, 'TRN0016 deleted in NetSuite'],
      [16, 'NetSuite 8004 comes to nothing in NetSuite'],
    ]);

    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 3 });
    expect(await journal()).toEqual(before);
    expect((await differing(JAN)).counts).toEqual({});
    expect((await differing(MAR)).counts).toEqual({ bank_transfer: 1 });
  });

  it('posts one once its lines balance, to an account NetSuite has made inactive too, and names one the journal refuses, without amounts', async () => {
    await edit('8007', (d) => {
      d.lines = [['1', 'BMG', '110', 3000], ['2', 'BMG', '100', -3000], ['3', '1084', '106', -2000], ['4', '1084', '107', 2000]];
    });
    // Moved to a savings account NetSuite has made inactive since, and put in checking only 1084 may use.
    await add({ ref: '8010', type: 'Transfer', number: 'TRN0020', date: '2025-03-10', lines: [['1', 'BMG', '111', 900], ['2', 'BMG', '100', -900]] });
    await add({ ref: '8011', type: 'Deposit', number: 'DEP0111', date: '2025-03-11', lines: [['0', 'BMG', '106', 800], ['1', 'BMG', '105', -800]] });

    const r = await run();
    expect(r).toMatchObject({
      posted: 2, left: 0, failedCount: 1, failed: [{ number: 'DEP0111', reason: 'Account 1060 (Checking 1084) belongs to another company' }],
    });
    expect(r.notes).toBeUndefined();
    const posted = (await journal()).slice(-2);
    expect(posted.map((e) => [e.date, e.key])).toEqual([['2025-03-10', 'bank_transfer:8010:1'], ['2025-03-20', 'bank_transfer:8007:1']]);
    expect((await linesOf(posted[0].no)).map((l: any) => [l.account, l.debit, l.credit])).toEqual([['111', '9.00', '0.00'], ['100', '0.00', '9.00']]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);
    expect((await differing(MAR)).counts).toEqual({ bank_deposit: 1 });
  });

  it('posts nothing to an account the chart of accounts doesn\'t have yet, and says so, then posts it once the chart has it', async () => {
    await edit('8011', (d) => { d.lines = [['0', 'BMG', '100', 800], ['1', 'BMG', '105', -800]]; });
    await add({ ref: '8012', type: 'Deposit', number: 'DEP0112', date: '2025-02-14', lines: [['0', 'BMG', '100', 700], ['1', 'BMG', '299', -700]] });
    const r = await run();
    expect(r).toMatchObject({
      posted: 1, failedCount: 1, failed: [{ number: 'DEP0112', reason: "It posts to NetSuite account 299, which the chart of accounts doesn't have" }],
    });
    expect(r.notes).toEqual([
      "NetSuite account 299 isn't in the chart of accounts yet, so invoices, credit memos, payments, deposits, bills, bill payments, checks, "
        + "card charges, journal entries, bank deposits, transfers and stock documents posting there weren't posted. Sync now on the chart of accounts page copies them.",
    ]);
    expect((await journal()).slice(-1).map((e) => e.key)).toEqual(['bank_deposit:8011:1']);

    await pg.query(
      `INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, company_id, active)
       VALUES ($1, '2990', 'Clearing', 'other_current_liability', '299', (SELECT id FROM gl_companies WHERE code = 'BMG'), true)`,
      [accountId('299')],
    );
    const again = await run();
    expect(again).toMatchObject({ posted: 1, failedCount: 0 });
    expect(again.notes).toBeUndefined();
    expect((await journal()).slice(-1).map((e) => [e.date, e.key])).toEqual([['2025-02-14', 'bank_deposit:8012:1']]);
  });

  it('never starts a bank deposit or transfer write with under five seconds left, and does that month again next run', async () => {
    await add({ ref: '8013', type: 'Deposit', number: 'DEP0113', date: '2025-01-20', lines: [['0', 'BMG', '100', 4000], ['1', 'BMG', '105', -4000]] });
    const before = await journal();

    takes.set('gl_bank_month', 26_000);
    expect(await run(30_000)).toMatchObject({ months: [], posted: 0, partial: true });
    expect(store.get(BOOKS_INVOICE_POSTING).last_result.resume).toEqual({ company: 'BMG', month: JAN });
    expect(await journal()).toEqual(before);

    takes.clear();
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 1, failedCount: 0 });
    expect(r.partial).toBeUndefined();
    expect((await journal()).slice(-1).map((e) => e.key)).toEqual(['bank_deposit:8013:1']);
  });

  it('stops, saying why, and writes nothing when it can\'t read the bank deposits and transfers or what the journal holds for them', async () => {
    // NetSuite changes DEP0113, so a run that could read everything would replace its entry.
    await edit('8013', (d) => { d.lines = [['0', 'BMG', '100', 4100], ['1', 'BMG', '105', -4100]]; });
    const before = await journal();
    // Each error says what it was reading.
    const reads: Array<[string, (args: Record<string, unknown>) => boolean, string]> = [
      ['gl_bank_month', () => true, "BMG's bank deposits and transfers for Jan 2025"],
      // Step 1's read of every entry, then a month's read of its documents' entries.
      ['gl_bank_postings', (args) => args.p_source_ids === null, "the journal's entries for BMG's bank deposits and transfers"],
      ['gl_bank_postings', (args) => args.p_source_ids !== null, "the journal's entries for BMG's bank deposits and transfers in Jan 2025"],
    ];
    for (const [fn, when, what] of reads) {
      failing.set(fn, when);
      const r = await run();
      failing.clear();
      expect(r.error, fn).toBe(`Reading ${what}: ${fn} failed`);
      expect(await journal(), fn).toEqual(before);
    }

    // It can read them again: the next run carries on.
    const r = await run();
    expect(r).toMatchObject({ posted: 0, replaced: 1, failedCount: 0 });
    expect(r.error).toBeUndefined();
    expect((await journal()).slice(-1).map((e) => e.key)).toEqual(['bank_deposit:8013:2']);
  });

  it('names every one whose lines don\'t balance in one note, and keeps what stands for them', async () => {
    // TRN0017's entry stands; DEP0114 is new.
    await edit('8007', (d) => { d.lines = [['1', 'BMG', '110', 3000], ['2', 'BMG', '100', -1000], ['3', '1084', '106', -2000]]; });
    await add({ ref: '8014', type: 'Deposit', number: 'DEP0114', date: '2025-03-25', lines: [['0', 'BMG', '100', 500]] });
    const before = await journal();

    const r = await run();
    expect(r).toMatchObject({ posted: 0, replaced: 0, reversed: 0, left: 2, failedCount: 0 });
    expect(r.notes).toEqual([
      "FleetSuite can't post 2 bank deposits and transfers, as their lines for the company don't balance on their own, so whatever FleetSuite "
        + 'holds for them stayed as it is: TRN0017, DEP0114. The Bank deposits and transfers switch on Invoices vs NetSuite shows their lines.',
    ]);
    expect(await journal()).toEqual(before);
    expect((await differing(MAR)).counts).toEqual({ bank_deposit: 1, bank_transfer: 1 });
  });
});
