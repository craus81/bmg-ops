// Migration 393 reads one company's NetSuite journal entries for a month
// from the copy of NetSuite's GL, and what the journal holds for them; the
// posting job posts them with the journal entry rule. This runs migration
// 314 (with stand-ins for the app tables it points at) and migrations
// 359–364, 367, 370, 374, 376, 377, 380, 382–387 and 389–393, with the ones
// the job reads bank deposits, transfers, refunds and stock documents
// through (394, 395, 397 and 399), in an in-memory
// Postgres (PGlite) as the app's server login and holds the functions'
// rules, then runs the posting job against them with journal entries only.
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

import { BOOKS_INVOICE_POSTING, postInvoices, type JournalEntryPosting } from './invoice-posting';
import { BOOKS_LISTS_SYNC } from './netsuite-lists';
import { NETSUITE_TYPE } from './differences';
import type { JournalMonthData } from './journal-entry-check';

/**
 * Made-up chart: '100' BMG's checking, '106' checking only 1084 may use,
 * '120' receivables, '200' payables, '220' the Chase card, '221' a Chase
 * card no longer used, '610' shop supplies, '640' fuel, '615' 1084's
 * building repairs.
 */
const ACCOUNTS: Array<[string, string, string, string, 'BMG' | '1084' | null, boolean]> = [
  ['100', '1000', 'Checking', 'bank', 'BMG', true],
  ['106', '1060', 'Checking 1084', 'bank', '1084', true],
  ['120', '1200', 'Receivables', 'accounts_receivable', 'BMG', true],
  ['200', '2000', 'Payables', 'accounts_payable', 'BMG', true],
  ['220', '2200', 'Chase Card', 'credit_card', 'BMG', true],
  ['221', '2210', 'Old Chase Card', 'credit_card', 'BMG', false],
  ['610', '6100', 'Shop Supplies', 'expense', null, true],
  ['640', '6400', 'Fuel', 'expense', null, true],
  ['615', '6150', 'Building Repairs', 'expense', '1084', true],
];
const accountId = (ns: string) => `a0000000-0000-4000-8000-000000000${ns}`;
const CUSTOMER = '6f1f6a52-8a43-4b8e-9a0e-2d9c1f0b7c11';
const OTHER_CUSTOMER = '7a2b8c63-9b5c-4c9f-8b1e-3e0d2a1c8d22';
const JAN = '2025-01-01';
const FEB = '2025-02-01';
const MAR = '2025-03-01';
const JOURNAL_KINDS = { journal_entry: NETSUITE_TYPE.journal_entry };

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
    '397-books-stock-postings-once.sql', '399-books-customer-refunds.sql',
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

// ── NetSuite's journal entries, as the copy of its GL has them ────────────

type Company = 'BMG' | '1084';
/** A line in the copy of NetSuite's GL: [line id, company, account, cents debit positive, memo, NetSuite id of its name]. */
type NsLine = [string, Company, string, number, (string | null)?, (string | null)?];

interface NsJournal {
  ref: string;
  number: string | null;
  date: string;
  /** The month NetSuite booked it into; its own unless said. */
  booked?: string;
  lines: NsLine[];
  /** NetSuite's transaction type: a journal entry unless said. */
  type?: string;
  /** NetSuite no longer has it. */
  gone?: boolean;
}

const money = (c: number) => (c / 100).toFixed(2);

/** Copies a journal entry as the copy of NetSuite's GL (migration 361) would, its lines replaced whole. */
async function copy(pg: PGlite, j: NsJournal) {
  await pg.query('DELETE FROM gl_netsuite_lines WHERE transaction_id = $1', [j.ref]);
  await pg.query('DELETE FROM gl_netsuite_transactions WHERE netsuite_id = $1', [j.ref]);
  if (j.gone) return;
  const month = j.booked ?? `${j.date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [j.ref, j.type ?? 'Journal', j.number, j.date, month],
  );
  for (const [line, company, account, c, memo, entity] of j.lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, memo, entity_id)
       SELECT $1, $2, id, $3, $4, $5, $6, $7, $8, $9 FROM gl_companies WHERE code = $10`,
      [j.ref, line, account, month, j.date, money(Math.max(c, 0)), money(Math.max(-c, 0)), memo ?? null, entity ?? null, company],
    );
  }
}

// ── The functions ──────────────────────────────────────────────────────────

describe('migration 393\'s functions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // The bookkeeper's entry for March's Chase statement, its lines out of order in the copy.
    await copy(db, {
      ref: '9001', number: 'JE1201', date: '2025-03-31',
      lines: [['10', 'BMG', '220', -16512, 'Chase statement 03/2025'], ['2', 'BMG', '610', 12000, 'Gloves'], ['1', 'BMG', '640', 4512, 'Fuel', '77']],
    });
    // Two customers' small balances written off: one matched to a FleetSuite customer, one not yet.
    await copy(db, {
      ref: '9002', number: 'JE1202', date: '2025-03-12',
      lines: [['1', 'BMG', '120', -2500, null, '310'], ['2', 'BMG', '120', -1000, null, '311'], ['3', 'BMG', '610', 3500, 'Small balances written off']],
    });
    // A vendor's bill paid on the card, and a name the vendors copy doesn't have, though an item has the same NetSuite id.
    await copy(db, {
      ref: '9003', number: 'JE1203', date: '2025-03-12',
      lines: [['1', 'BMG', '200', 5000, null, '50'], ['2', 'BMG', '200', 700, null, '59'], ['3', 'BMG', '220', -5700, 'Paid on the card', '50']],
    });
    // An intercompany entry, with lines for both companies.
    await copy(db, {
      ref: '9004', number: 'JE1204', date: '2025-03-20',
      lines: [['1', 'BMG', '640', 3000], ['2', 'BMG', '220', -3000], ['3', '1084', '615', 2000], ['4', '1084', '106', -2000]],
    });
    // 1084's alone; dated in February and booked into March, with no number; April's; and a check, which isn't a journal entry.
    await copy(db, { ref: '9005', number: 'JE1205', date: '2025-03-05', lines: [['1', '1084', '615', 8000], ['2', '1084', '106', -8000]] });
    await copy(db, { ref: '9006', number: null, date: '2025-02-28', booked: MAR, lines: [['1', 'BMG', '640', 1000], ['2', 'BMG', '100', -1000]] });
    await copy(db, { ref: '9007', number: 'JE1207', date: '2025-04-02', lines: [['1', 'BMG', '640', 1000], ['2', 'BMG', '100', -1000]] });
    await copy(db, { ref: '8001', number: '10234', date: '2025-03-05', type: 'Check', lines: [['0', 'BMG', '100', -2000], ['1', 'BMG', '640', 2000]] });
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<{ r: T }>(sql, params)).rows[0].r;
  const month = (company: string, m: string) => one<JournalMonthData>('SELECT gl_journal_month($1, $2::date) AS r', [company, m]);

  it('gl_journal_month gives the company\'s journal entries NetSuite booked into the month, each with its lines for the company and their names', async () => {
    const mar = await month('BMG', MAR);
    // By date, then number; not the check, 1084's or April's.
    expect(mar.journal_entries.map((e) => [e.netsuite_id, e.number, e.date, e.posting_month, e.companies])).toEqual([
      ['9006', null, '2025-02-28', MAR, ['BMG']],
      ['9002', 'JE1202', '2025-03-12', MAR, ['BMG']],
      ['9003', 'JE1203', '2025-03-12', MAR, ['BMG']],
      ['9004', 'JE1204', '2025-03-20', MAR, ['1084', 'BMG']],
      ['9001', 'JE1201', '2025-03-31', MAR, ['BMG']],
    ]);
    const [, writeOff, paid, shared, statement] = mar.journal_entries;
    // In NetSuite's order, 2 before 10, with a name only when FleetSuite has a copy of it.
    expect(statement.lines).toEqual([
      { line_id: '1', account: '640', debit: '45.12', credit: '0.00', memo: 'Fuel', entity_id: '77', name: null, customer_id: null },
      { line_id: '2', account: '610', debit: '120.00', credit: '0.00', memo: 'Gloves', entity_id: null, name: null, customer_id: null },
      { line_id: '10', account: '220', debit: '0.00', credit: '165.12', memo: 'Chase statement 03/2025', entity_id: null, name: null, customer_id: null },
    ]);
    // A customer's name from the ledger mirror, and the FleetSuite customer only when the mirror matched it by its NetSuite id.
    expect(writeOff.lines.map((l) => [l.entity_id, l.name, l.customer_id])).toEqual([
      ['310', 'A Customer', CUSTOMER], ['311', 'Hand-matched Customer', null], [null, null, null],
    ]);
    // A vendor's from the vendors copy, never an item's.
    expect(paid.lines.map((l) => [l.entity_id, l.name, l.customer_id])).toEqual([['50', 'Sample Supply Co', null], ['59', null, null], ['50', 'Sample Supply Co', null]]);
    // Only this company's lines of an intercompany entry.
    expect(shared.lines.map((l) => [l.line_id, l.account])).toEqual([['1', '640'], ['2', '220']]);

    const other = await month('1084', MAR);
    expect(other.journal_entries.map((e) => [e.netsuite_id, e.companies, e.lines.map((l) => l.line_id)])).toEqual([
      ['9005', ['1084'], ['1', '2']], ['9004', ['1084', 'BMG'], ['3', '4']],
    ]);
    // Any day of the month reads the month; a month with none reads none.
    expect((await month('BMG', '2025-04-15')).journal_entries.map((e) => e.netsuite_id)).toEqual(['9007']);
    expect(await month('BMG', FEB)).toEqual({ journal_entries: [] });
  });

  /** A journal entry's entry, fuel charged to the card; `fields` change it. */
  const entry = (company: string, key: string, sourceId: string, amount: string, fields: Record<string, unknown> = {}) => ({
    company,
    entry_date: '2025-03-31',
    source_type: 'journal_entry',
    source_id: sourceId,
    posting_rule: 'journal_entry@1',
    idempotency_key: key,
    memo: `JE for ${sourceId}`,
    lines: [
      { account_id: accountId(company === 'BMG' ? '640' : '615'), debit: amount, source_line_ref: '1' },
      { account_id: accountId(company === 'BMG' ? '220' : '106'), credit: amount, source_line_ref: '2' },
    ],
    ...fields,
  });
  const post = (p: unknown) => one<{ id: string; entry_no: number }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify(p)]);
  const postings = async (company: string, ids: string[] | null, lines: boolean) =>
    (await one<{ journal_entries: JournalEntryPosting[] }>('SELECT gl_journal_postings($1, $2::text[], $3) AS r', [company, ids && textArray(ids), lines]))
      .journal_entries;

  it('gl_journal_postings says what the journal holds for each journal entry and what the copy of NetSuite\'s GL says of it now', async () => {
    const first = await post(entry('BMG', 'journal_entry:9001:1', '9001', '165.12', { memo: 'JE1201' }));
    const second = (await one<{ entry: { id: string; entry_no: number } }>(
      'SELECT gl_repost_entry($1::uuid, $2, $3::jsonb) AS r',
      [first.id, 'JE1201 changed in NetSuite', JSON.stringify(entry('BMG', 'journal_entry:9001:2', '9001', '170.00', { memo: 'JE1201' }))],
    )).entry;
    await post(entry('BMG', 'journal_entry:9002:1', '9002', '35.00', {
      memo: 'JE1202',
      lines: [
        { account_id: accountId('120'), credit: '35.00', source_line_ref: '1', customer_id: CUSTOMER, memo: 'A Customer' },
        { account_id: accountId('610'), debit: '35.00', source_line_ref: '3' },
      ],
    }));
    await post(entry('BMG', 'journal_entry:9003:1', '9003', '57.00', {
      memo: 'JE1203',
      lines: [
        { account_id: accountId('200'), debit: '57.00', source_line_ref: '1', vendor_ref: '50', memo: 'Sample Supply Co' },
        { account_id: accountId('220'), credit: '57.00', source_line_ref: '3' },
      ],
    }));
    await post(entry('BMG', 'journal_entry:9004:1', '9004', '30.00', { memo: 'JE1204' }));
    // NetSuite moved it to 1084, deleted it, or it's a check filed as a journal entry: the copy has no journal entry of it for BMG.
    await post(entry('BMG', 'journal_entry:9005:1', '9005', '80.00', { memo: 'JE1205' }));
    await post(entry('BMG', 'journal_entry:9008:1', '9008', '12.00', { memo: 'JE1208' }));
    await post(entry('BMG', 'journal_entry:8001:1', '8001', '20.00', { memo: '10234' }));
    // 1084's.
    const other = await post(entry('1084', 'journal_entry:9005:1-1084', '9005', '80.00', { memo: 'JE1205' }));
    // A check's entry under a journal entry's NetSuite id is another document's, and one filed as a journal entry with
    // no NetSuite id is no document's.
    await post(entry('BMG', 'check:9001:1', '9001', '1.00', { source_type: 'check', posting_rule: 'spending@1' }));
    await post(entry('BMG', 'journal_entry:none:1', '', '2.00'));
    // Two entries standing for one journal entry, which the posting job reverses down to one: the newer is the one that stands.
    const older = await post(entry('BMG', 'journal_entry:9010:1', '9010', '8.00', { entry_date: '2025-04-10', memo: 'JE1210' }));
    const newer = await post(entry('BMG', 'journal_entry:9010:2', '9010', '8.00', { entry_date: '2025-04-11', memo: 'JE1210-A' }));

    const held = await postings('BMG', null, false);
    // Once the copy no longer has a journal entry, the newest entry's memo gives its number.
    expect(held.map((p) => [p.source_type, p.source_id, p.entries, p.journal])).toEqual([
      ['journal_entry', '8001', 1, { number: '10234', deleted: true }],
      ['journal_entry', '9001', 2, { number: 'JE1201', deleted: false }],
      ['journal_entry', '9002', 1, { number: 'JE1202', deleted: false }],
      ['journal_entry', '9003', 1, { number: 'JE1203', deleted: false }],
      ['journal_entry', '9004', 1, { number: 'JE1204', deleted: false }],
      ['journal_entry', '9005', 1, { number: 'JE1205', deleted: true }],
      ['journal_entry', '9008', 1, { number: 'JE1208', deleted: true }],
      ['journal_entry', '9010', 2, { number: 'JE1210-A', deleted: true }],
    ]);
    expect(held[7]).toMatchObject({
      unreversed: [newer.id, older.id],
      current: { id: newer.id, entry_no: newer.entry_no, entry_date: '2025-04-11', lines: null },
    });
    expect(held[1]).toEqual({
      source_type: 'journal_entry',
      source_id: '9001',
      entries: 2,
      unreversed: [second.id],
      history: [
        { entry_no: first.entry_no, entry_date: '2025-03-31', reversed_by: first.entry_no + 1 },
        { entry_no: second.entry_no, entry_date: '2025-03-31', reversed_by: null },
      ],
      current: { id: second.id, entry_no: second.entry_no, entry_date: '2025-03-31', lines: null },
      journal: { number: 'JE1201', deleted: false },
    });

    // Only the ones asked about, with the lines of the entry that stands: the customer on receivables, the vendor on payables.
    const asked = await postings('BMG', ['9002', '9003', '9999'], true);
    expect(asked.map((p) => [p.source_id, p.current?.lines])).toEqual([
      ['9002', [
        { account: '120', debit: '0.00', credit: '35.00', division: null, source_line_ref: '1', customer_id: CUSTOMER, vendor_ref: null },
        { account: '610', debit: '35.00', credit: '0.00', division: null, source_line_ref: '3', customer_id: null, vendor_ref: null },
      ]],
      ['9003', [
        { account: '200', debit: '57.00', credit: '0.00', division: null, source_line_ref: '1', customer_id: null, vendor_ref: '50' },
        { account: '220', debit: '0.00', credit: '57.00', division: null, source_line_ref: '3', customer_id: null, vendor_ref: null },
      ]],
    ]);
    expect((await postings('1084', null, false)).map((p) => [p.source_id, p.current?.id, p.journal])).toEqual([
      ['9005', other.id, { number: 'JE1205', deleted: false }],
    ]);
  });

  it('is the service role\'s alone, and neither read writes anything', async () => {
    for (const fn of ['gl_journal_month(text, date)', 'gl_journal_postings(text, text[], boolean)']) {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await one<boolean>('SELECT has_function_privilege($1::name, $2, \'EXECUTE\') AS r', [role, fn]), `${role} ${fn}`)
          .toBe(role === 'service_role');
      }
    }
    for (const name of ['gl_journal_month', 'gl_journal_postings']) {
      const body = await one<string>('SELECT prosrc AS r FROM pg_proc WHERE proname = $1', [name]);
      expect(body, name).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    }
  });
});

// ── The job ────────────────────────────────────────────────────────────────

// Made-up journal entries, from December 2024 to March 2025.
const DOCS = (): NsJournal[] => [
  // The bookkeeper's entry for January's Chase statement: fuel and supplies charged to the card.
  {
    ref: '9001', number: 'JE1201', date: '2025-01-31',
    lines: [['1', 'BMG', '640', 4512, 'Fuel', '77'], ['2', 'BMG', '610', 12000, 'Gloves'], ['3', 'BMG', '220', -16512, 'Chase statement 01/2025']],
  },
  // A customer's small balance written off.
  { ref: '9002', number: 'JE1202', date: '2025-02-12', lines: [['1', 'BMG', '120', -2500, null, '310'], ['2', 'BMG', '610', 2500, null, '310']] },
  // A vendor's bill paid on the card.
  { ref: '9003', number: 'JE1203', date: '2025-02-20', lines: [['1', 'BMG', '200', 5000, null, '50'], ['2', 'BMG', '220', -5000, 'Paid on the card', '50']] },
  // NetSuite gave it no number.
  { ref: '9004', number: null, date: '2025-03-03', lines: [['1', 'BMG', '640', 1000], ['2', 'BMG', '100', -1000]] },
  // 1084's don't post yet.
  { ref: '9005', number: 'JE1205', date: '2025-03-04', lines: [['1', '1084', '615', 8000], ['2', '1084', '106', -8000]] },
  // An intercompany entry: BMG's lines are BMG's entry.
  {
    ref: '9006', number: 'JE1206', date: '2025-03-06',
    lines: [['1', 'BMG', '640', 3000], ['2', 'BMG', '220', -3000], ['3', '1084', '615', 2000], ['4', '1084', '106', -2000]],
  },
  // One whose lines for BMG don't balance on their own.
  { ref: '9007', number: 'JE1207', date: '2025-03-20', lines: [['1', 'BMG', '640', 3000], ['2', 'BMG', '220', -1000], ['3', '1084', '106', -2000]] },
  // Dated before the books start, booked by NetSuite into January 2025.
  { ref: '9008', number: 'JE1180', date: '2024-12-31', booked: JAN, lines: [['1', 'BMG', '640', 4000], ['2', 'BMG', '220', -4000]] },
  // $0.
  { ref: '9009', number: 'JE1209', date: '2025-03-09', lines: [['1', 'BMG', '640', 0], ['2', 'BMG', '220', 0]] },
];

describe('the posting job, for journal entries', () => {
  let pg: PGlite;
  let clock = 0;
  /** How long a function takes, for running out of time. */
  const takes = new Map<string, number>();
  /** When a function fails, by what it was asked. */
  const failing = new Map<string, (args: Record<string, unknown>) => boolean>();
  const store = new Map<string, any>();
  const docs = new Map<string, NsJournal>();

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

  // A journal entry's entry is its lines in NetSuite's GL copy, so there's nothing to ask NetSuite.
  const query = async () => { throw new Error('NetSuite was asked about lines'); };
  const run = (budgetMs = 240_000) => postInvoices(service(), { deadline: clock + budgetMs, deps: { query, now: () => clock } });

  /** The journal, entry by entry: a journal entry's entry by its key, a reversal by the entry it reverses. */
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
    'SELECT gl_books_difference_documents($1, $2::date, $3::jsonb, $4) AS r', ['BMG', month, JSON.stringify(JOURNAL_KINDS), 10],
  ).then((res) => res.rows[0].r);

  /** NetSuite changes a journal entry, and the GL copy catches up. */
  const edit = async (ref: string, change: (j: NsJournal) => void) => {
    const j = docs.get(ref)!;
    change(j);
    await copy(pg, j);
  };
  const add = async (j: NsJournal) => {
    docs.set(j.ref, j);
    await copy(pg, j);
  };

  beforeAll(async () => {
    pg = await freshDb();
    store.set(BOOKS_LISTS_SYNC, { last_result: { taxAccounts: [], itemAccounts: [] } });
    clock = Date.parse('2025-03-15T12:00:00Z');
    for (const j of DOCS()) await add(j);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('posts each BMG journal entry once, in the month NetSuite booked it into, with its lines as NetSuite has them', async () => {
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 6, replaced: 0, reversed: 0, unchanged: 0, left: 1, failedCount: 0 });
    expect(r.error).toBeUndefined();
    expect(r.notes).toEqual([
      "FleetSuite can't post 1 journal entry, as its lines for the company don't balance on their own, so whatever FleetSuite holds for it "
        + 'stayed as it is: JE1207. The Journal entries switch on Invoices vs NetSuite shows its lines.',
    ]);

    // Not JE1205 (1084's), JE1207 (doesn't balance for BMG) or JE1209 ($0).
    expect(await journal()).toEqual([
      { no: 1, date: JAN, key: 'journal_entry:9008:1', reverses: null, memo: 'JE1180' },
      { no: 2, date: '2025-01-31', key: 'journal_entry:9001:1', reverses: null, memo: 'JE1201' },
      { no: 3, date: '2025-02-12', key: 'journal_entry:9002:1', reverses: null, memo: 'JE1202' },
      { no: 4, date: '2025-02-20', key: 'journal_entry:9003:1', reverses: null, memo: 'JE1203' },
      { no: 5, date: '2025-03-03', key: 'journal_entry:9004:1', reverses: null, memo: 'NetSuite 9004' },
      { no: 6, date: '2025-03-06', key: 'journal_entry:9006:1', reverses: null, memo: 'JE1206' },
    ]);
    expect(await ruleOf(2)).toEqual({ rule: 'journal_entry@1', type: 'journal_entry', source: '9001' });
    // Each line with its memo; a name FleetSuite has no copy of adds nothing.
    expect(await linesOf(2)).toEqual([
      { account: '640', debit: '45.12', credit: '0.00', memo: 'Fuel', customer: null, vendor_ref: null, source_line_ref: '1' },
      { account: '610', debit: '120.00', credit: '0.00', memo: 'Gloves', customer: null, vendor_ref: null, source_line_ref: '2' },
      { account: '220', debit: '0.00', credit: '165.12', memo: 'Chase statement 01/2025', customer: null, vendor_ref: null, source_line_ref: '3' },
    ]);
    // The customer on the receivables line, and the vendor on the payables line, each line's memo with its name in front.
    expect(await linesOf(3)).toEqual([
      { account: '120', debit: '0.00', credit: '25.00', memo: 'A Customer', customer: CUSTOMER, vendor_ref: null, source_line_ref: '1' },
      { account: '610', debit: '25.00', credit: '0.00', memo: 'A Customer', customer: null, vendor_ref: null, source_line_ref: '2' },
    ]);
    expect(await linesOf(4)).toEqual([
      { account: '200', debit: '50.00', credit: '0.00', memo: 'Sample Supply Co', customer: null, vendor_ref: '50', source_line_ref: '1' },
      { account: '220', debit: '0.00', credit: '50.00', memo: 'Sample Supply Co · Paid on the card', customer: null, vendor_ref: null, source_line_ref: '2' },
    ]);
    // Only BMG's lines of the intercompany entry.
    expect((await linesOf(6)).map((l: any) => [l.account, l.debit, l.credit, l.source_line_ref])).toEqual([
      ['640', '30.00', '0.00', '1'], ['220', '0.00', '30.00', '2'],
    ]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);

    // Differences: what's posted comes to NetSuite's; JE1207 is the one that differs.
    expect((await differing(JAN)).counts).toEqual({});
    expect((await differing(FEB)).counts).toEqual({});
    const mar = await differing(MAR);
    expect(mar.counts).toEqual({ journal_entry: 1 });
    expect(mar.documents[0]).toMatchObject({
      kind: 'journal_entry', netsuite_id: '9007', fleetsuite: { entries: 0, standing: null }, copy: null,
      netsuite: { type: 'Journal', number: 'JE1207', date: '2025-03-20', month: MAR },
    });
  });

  it('changes nothing on the next run', async () => {
    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 6, left: 1 });
    expect(await journal()).toEqual(before);
  });

  it('replaces an entry when NetSuite changes an amount, an account, the date, a customer or a vendor, and not for a new number, memo or name', async () => {
    await edit('9001', (j) => {
      j.number = 'JE1201-A';
      j.lines = [['1', 'BMG', '640', 4512, 'Fuel for the box truck', '77'], ['2', 'BMG', '610', 12000, 'Gloves'], ['3', 'BMG', '220', -16512, 'Chase statement 01/2025']];
    });
    await pg.query(`UPDATE gl_netsuite_lists SET name = 'Sample Supply Company' WHERE kind = 'vendor' AND netsuite_id = '50'`);
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, unchanged: 6 });

    // More fuel.
    await edit('9001', (j) => {
      j.lines = [['1', 'BMG', '640', 5512, 'Fuel for the box truck', '77'], ['2', 'BMG', '610', 12000, 'Gloves'], ['3', 'BMG', '220', -17512, 'Chase statement 01/2025']];
    });
    expect(await run()).toMatchObject({ posted: 0, replaced: 1, unchanged: 5 });
    expect((await journal()).slice(-2)).toEqual([
      { no: 7, date: '2025-01-31', key: null, reverses: 2, memo: 'JE1201-A changed in NetSuite' },
      { no: 8, date: '2025-01-31', key: 'journal_entry:9001:2', reverses: null, memo: 'JE1201-A' },
    ]);
    expect((await linesOf(8)).map((l: any) => [l.debit, l.credit, l.memo])).toEqual([
      ['55.12', '0.00', 'Fuel for the box truck'], ['120.00', '0.00', 'Gloves'], ['0.00', '175.12', 'Chase statement 01/2025'],
    ]);

    // Another customer's balance written off, another vendor's bill paid, a day later, and NetSuite moved JE1180 into February.
    await edit('9002', (j) => { j.lines = [['1', 'BMG', '120', -2500, null, '312'], ['2', 'BMG', '610', 2500, null, '312']]; });
    await edit('9003', (j) => { j.lines = [['1', 'BMG', '200', 5000, null, '51'], ['2', 'BMG', '220', -5000, 'Paid on the card', '51']]; });
    await edit('9004', (j) => { j.date = '2025-03-04'; });
    await edit('9008', (j) => { j.booked = FEB; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 4, unchanged: 2, left: 1 });
    expect((await journal()).slice(-8)).toEqual([
      { no: 9, date: JAN, key: null, reverses: 1, memo: 'JE1180 changed in NetSuite' },
      { no: 10, date: FEB, key: 'journal_entry:9008:2', reverses: null, memo: 'JE1180' },
      { no: 11, date: '2025-02-12', key: null, reverses: 3, memo: 'JE1202 changed in NetSuite' },
      { no: 12, date: '2025-02-12', key: 'journal_entry:9002:2', reverses: null, memo: 'JE1202' },
      { no: 13, date: '2025-02-20', key: null, reverses: 4, memo: 'JE1203 changed in NetSuite' },
      { no: 14, date: '2025-02-20', key: 'journal_entry:9003:2', reverses: null, memo: 'JE1203' },
      { no: 15, date: '2025-03-03', key: null, reverses: 5, memo: 'NetSuite 9004 changed in NetSuite' },
      { no: 16, date: '2025-03-04', key: 'journal_entry:9004:2', reverses: null, memo: 'NetSuite 9004' },
    ]);
    expect((await linesOf(12)).map((l: any) => [l.account, l.customer, l.memo])).toEqual([
      ['120', OTHER_CUSTOMER, 'Another Customer'], ['610', null, 'Another Customer'],
    ]);
    expect((await linesOf(14)).map((l: any) => [l.account, l.vendor_ref, l.memo])).toEqual([
      ['200', '51', 'Another Supplier'], ['220', null, 'Another Supplier · Paid on the card'],
    ]);
    // January no longer holds JE1180, as NetSuite's January doesn't.
    expect((await differing(JAN)).counts).toEqual({});
    expect((await differing(FEB)).counts).toEqual({});
  });

  it('reverses the entry of a journal entry NetSuite deletes, moves to the other company, or that comes to nothing now, once', async () => {
    await edit('9001', (j) => { j.gone = true; });
    await edit('9006', (j) => { j.lines = [['3', '1084', '615', 2000], ['4', '1084', '106', -2000]]; });
    await edit('9004', (j) => { j.lines = [['1', 'BMG', '640', 0], ['2', 'BMG', '100', 0]]; });
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 3, unchanged: 3, left: 1 });
    // The number of one NetSuite no longer has comes from its entry's memo.
    expect((await journal()).slice(-3).map((e) => [e.reverses, e.memo])).toEqual([
      [8, 'JE1201-A deleted in NetSuite'],
      [6, 'JE1206 deleted in NetSuite'],
      [16, 'NetSuite 9004 comes to nothing in NetSuite'],
    ]);

    const before = await journal();
    expect(await run()).toMatchObject({ posted: 0, replaced: 0, reversed: 0, unchanged: 3 });
    expect(await journal()).toEqual(before);
    expect((await differing(JAN)).counts).toEqual({});
    expect((await differing(MAR)).counts).toEqual({ journal_entry: 1 });
  });

  it('posts one once its lines balance, to an account NetSuite has made inactive too, and names one the journal refuses, without amounts', async () => {
    await edit('9007', (j) => {
      j.lines = [['1', 'BMG', '640', 3000], ['2', 'BMG', '220', -3000], ['3', '1084', '106', -2000], ['4', '1084', '615', 2000]];
    });
    // Charged to a card NetSuite has made inactive since, and paid from checking only 1084 may use.
    await add({ ref: '9010', number: 'JE1210', date: '2025-03-10', lines: [['1', 'BMG', '640', 900], ['2', 'BMG', '221', -900]] });
    await add({ ref: '9011', number: 'JE1211', date: '2025-03-11', lines: [['1', 'BMG', '640', 800], ['2', 'BMG', '106', -800]] });

    const r = await run();
    expect(r).toMatchObject({
      posted: 2, left: 0, failedCount: 1, failed: [{ number: 'JE1211', reason: 'Account 1060 (Checking 1084) belongs to another company' }],
    });
    expect(r.notes).toBeUndefined();
    const posted = (await journal()).slice(-2);
    expect(posted.map((e) => [e.date, e.key])).toEqual([['2025-03-10', 'journal_entry:9010:1'], ['2025-03-20', 'journal_entry:9007:1']]);
    expect((await linesOf(posted[0].no)).map((l: any) => [l.account, l.debit, l.credit])).toEqual([['640', '9.00', '0.00'], ['221', '0.00', '9.00']]);
    expect(JSON.stringify(store.get(BOOKS_INVOICE_POSTING).last_result)).not.toMatch(/\d\.\d|\$/);
    expect((await differing(MAR)).counts).toEqual({ journal_entry: 1 });
  });

  it('posts nothing to an account the chart of accounts doesn\'t have yet, and says so, then posts it once the chart has it', async () => {
    await edit('9011', (j) => { j.lines = [['1', 'BMG', '640', 800], ['2', 'BMG', '100', -800]]; });
    await add({ ref: '9012', number: 'JE1212', date: '2025-02-14', lines: [['1', 'BMG', '640', 700], ['2', 'BMG', '299', -700]] });
    const r = await run();
    expect(r).toMatchObject({
      posted: 1, failedCount: 1, failed: [{ number: 'JE1212', reason: "It posts to NetSuite account 299, which the chart of accounts doesn't have" }],
    });
    expect(r.notes).toEqual([
      "NetSuite account 299 isn't in the chart of accounts yet, so invoices, credit memos, payments, deposits, bills, bill payments, checks, "
        + "card charges, journal entries, bank deposits, transfers, customer refunds and stock documents posting there weren't posted. Sync now on the chart of accounts page copies them.",
    ]);
    expect((await journal()).slice(-1).map((e) => e.key)).toEqual(['journal_entry:9011:1']);

    await pg.query(
      `INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, company_id, active)
       VALUES ($1, '2990', 'Clearing', 'other_current_liability', '299', (SELECT id FROM gl_companies WHERE code = 'BMG'), true)`,
      [accountId('299')],
    );
    const again = await run();
    expect(again).toMatchObject({ posted: 1, failedCount: 0 });
    expect(again.notes).toBeUndefined();
    expect((await journal()).slice(-1).map((e) => [e.date, e.key])).toEqual([['2025-02-14', 'journal_entry:9012:1']]);
  });

  it('never starts a journal entry write with under five seconds left, and does that month again next run', async () => {
    await add({ ref: '9013', number: 'JE1213', date: '2025-01-20', lines: [['1', 'BMG', '640', 4000], ['2', 'BMG', '220', -4000]] });
    const before = await journal();

    takes.set('gl_journal_month', 26_000);
    expect(await run(30_000)).toMatchObject({ months: [], posted: 0, partial: true });
    expect(store.get(BOOKS_INVOICE_POSTING).last_result.resume).toEqual({ company: 'BMG', month: JAN });
    expect(await journal()).toEqual(before);

    takes.clear();
    const r = await run();
    expect(r).toMatchObject({ months: [JAN, FEB, MAR], posted: 1, failedCount: 0 });
    expect(r.partial).toBeUndefined();
    expect((await journal()).slice(-1).map((e) => e.key)).toEqual(['journal_entry:9013:1']);
  });

  it('stops, saying why, and writes nothing when it can\'t read the journal entries or what the journal holds for them', async () => {
    // NetSuite changes JE1213, so a run that could read everything would replace its entry.
    await edit('9013', (j) => { j.lines = [['1', 'BMG', '640', 4100], ['2', 'BMG', '220', -4100]]; });
    const before = await journal();
    // Each error says what it was reading.
    const reads: Array<[string, (args: Record<string, unknown>) => boolean, string]> = [
      ['gl_journal_month', () => true, "BMG's journal entries for Jan 2025"],
      // Step 1's read of every entry, then a month's read of its journal entries' entries.
      ['gl_journal_postings', (args) => args.p_source_ids === null, "the journal's entries for BMG's journal entries"],
      ['gl_journal_postings', (args) => args.p_source_ids !== null, "the journal's entries for BMG's journal entries in Jan 2025"],
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
    expect((await journal()).slice(-1).map((e) => e.key)).toEqual(['journal_entry:9013:2']);
  });

  it('names every journal entry whose lines don\'t balance in one note, and keeps what stands for them', async () => {
    // JE1207's entry stands; JE1214 is new.
    await edit('9007', (j) => { j.lines = [['1', 'BMG', '640', 3000], ['2', 'BMG', '220', -1000], ['3', '1084', '106', -2000]]; });
    await add({ ref: '9014', number: 'JE1214', date: '2025-03-25', lines: [['1', 'BMG', '640', 500]] });
    const before = await journal();

    const r = await run();
    expect(r).toMatchObject({ posted: 0, replaced: 0, reversed: 0, left: 2, failedCount: 0 });
    expect(r.notes).toEqual([
      "FleetSuite can't post 2 journal entries, as their lines for the company don't balance on their own, so whatever FleetSuite holds for "
        + 'them stayed as it is: JE1207, JE1214. The Journal entries switch on Invoices vs NetSuite shows their lines.',
    ]);
    expect(await journal()).toEqual(before);
    expect((await differing(MAR)).counts).toEqual({ journal_entry: 2 });
  });
});
