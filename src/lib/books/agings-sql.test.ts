// Migration 458 puts each customer's and vendor's open documents in
// FleetSuite's books next to NetSuite's, for AR and AP agings. This runs
// migrations 314, 359–363, 406 and 407 with 458 in an in-memory Postgres
// (PGlite) as the app's server login, copies a made-up NetSuite general
// ledger with what NetSuite has open on each document, posts FleetSuite's own
// entries for it (one replaced, one FleetSuite hasn't posted, one only
// FleetSuite has, one for a different amount), and holds what
// gl_netsuite_store_open_items and gl_party_open_documents do and return,
// then ages them with src/lib/books/agings.ts and checks every side adds up
// to Customer and vendor balances.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { toCents } from './netsuite-gl';
import { BUCKETS } from './aging-buckets';
import { buildAgings, type OpenDocumentsData } from './agings';
import { partyBalances, type PartyBalancesData, type PartyKind } from './party-balances';

const JUN = '2026-06-01';
const AUG = '2026-08-01';
const SEP = '2026-09-01';
const OCT = '2026-10-01';
const TODAY = '2026-10-31';

/** Made-up chart, keyed by NetSuite id. */
const ACCOUNTS: Array<[string, string, string, string]> = [
  ['110', '1100', 'Checking', 'bank'],
  ['120', '1200', 'Receivables', 'accounts_receivable'],
  ['200', '2000', 'Payables', 'accounts_payable'],
  ['400', '4000', 'Sales', 'income'],
  ['600', '6000', 'Rent', 'expense'],
];
const accountId = (number: string) => `a0000000-0000-4000-8000-00000000${number}`;
const NS_ACCOUNT: Record<string, string> = Object.fromEntries(ACCOUNTS.map(([ns, number]) => [ns, number]));

/** FleetSuite's customers: Acme, Bravo and Delta the mirror matched, Zulu NetSuite doesn't know. */
const ACME = 'c0000000-0000-4000-8000-00000000000a';
const BRAVO = 'c0000000-0000-4000-8000-00000000000b';
const DELTA = 'c0000000-0000-4000-8000-00000000000d';
const ZULU = 'c0000000-0000-4000-8000-00000000000f';

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
    -- What migrations 314 and 407 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '406-books-party-balances.sql',
    '407-books-own-invoices.sql', '458-books-agings.sql',
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
  // Bravo's name is blank in FleetSuite, so its NetSuite name stands in.
  // Bravo is two customers in NetSuite. Charlie Cab the mirror matched to
  // Zulu only by a cleaned name, which the books don't go by.
  await pg.query(
    `INSERT INTO customers (id, company_name) VALUES ($1, 'Acme Fleet'), ($2, '  '), ($3, 'Delta Dairy'), ($4, 'Zulu Logistics')`,
    [ACME, BRAVO, DELTA, ZULU],
  );
  await pg.query(`
    INSERT INTO ledger_customers (source, external_id, external_ref, display_name, cleaned_name, match_status, customer_id) VALUES
      ('netsuite', 'customer/9001', '9001', 'Acme Fleet Services', 'acme fleet services', 'exact', $1),
      ('netsuite', 'customer/9002', '9002', 'Bravo Transit', 'bravo transit', 'exact', $2),
      ('netsuite', 'customer/9003', '9003', 'Bravo Transit West', 'bravo transit west', 'exact', $2),
      ('netsuite', 'customer/9004', '9004', 'Charlie Cab', 'charlie cab', 'cleaned', $4),
      ('netsuite', 'customer/9005', '9005', 'Delta Dairy', 'delta dairy', 'exact', $3)
  `, [ACME, BRAVO, DELTA, ZULU]);
  await pg.exec(`
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES
      ('vendor', '7001', 'Landlord LLC', true), ('vendor', '7002', 'Parts Supply Co', true);
  `);
  // The ledger mirror's copies of two invoices: INV1003's due date NetSuite's open documents leave out, and one for
  // INV1001 its open document's due date wins over.
  await pg.exec(`
    INSERT INTO ledger_invoices (source, external_id, external_ref, doc_type, doc_number, doc_date, due_date, total) VALUES
      ('netsuite', 'CustInvc/1003', '1003', 'invoice', 'INV1003', '2026-08-15', '2026-09-14', 200),
      ('netsuite', 'CustInvc/1001', '1001', 'invoice', 'INV1001', '2026-09-03', '2026-10-05', 500)
  `);
  // FleetSuite's own copies: INV1003 on other terms than NetSuite's, and one of INV1001 saved under 1084, which BMG's
  // agings must not take.
  await pg.exec(`
    INSERT INTO gl_own_invoices (netsuite_id, company_id, netsuite_number, made_from, invoice_date, due_date, tax_rule, tax_basis,
                                 tax_rate, subtotal, tax, total, lines_from)
    SELECT '1003', id, 'INV1003', 'po', DATE '2026-08-15', DATE '2026-10-14', 'tax@1', 'exempt_customer', 0, 200, 0, 200, 'sent'
    FROM gl_companies WHERE code = 'BMG'
    UNION ALL
    SELECT '1001', id, 'INV1001', 'po', DATE '2026-09-03', DATE '2026-12-01', 'tax@1', 'exempt_customer', 0, 500, 0, 500, 'sent'
    FROM gl_companies WHERE code = '1084'
  `);
  // The starting entry: 170.00 on the receivable account, 150.00 of it Acme's by name.
  await pg.exec(`
    INSERT INTO gl_netsuite_opening (company_id, netsuite_account_id, debit, credit, line_count)
    SELECT id, '120', 170.00, 0, 2 FROM gl_companies WHERE code = 'BMG'
  `);
  await pg.exec('SET ROLE service_role');
  await pg.query('SELECT gl_netsuite_store_opening_parties($1::jsonb)', [JSON.stringify({
    parties: [{ company: 'BMG', netsuite_account_id: '120', entity_id: '9001', debit: '150.00', credit: '0', line_count: 1 }],
  })]);
  return pg;
}

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;

type CopyLine = [line: string, company: string, account: string, cents: number, entity?: string];

/** A NetSuite transaction as the GL copy keeps it; lines are [line id, company, account, cents debit positive, name]. */
async function copyTxn(pg: PGlite, id: string, type: string, number: string, date: string, month: string, lines: CopyLine[]) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [id, type, number, date, month],
  );
  for (const [line, company, account, cents, entity] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, entity_id)
       SELECT $1, $2, id, $3, $4, $5, $6, $7, $8 FROM gl_companies WHERE code = $9`,
      [id, line, account, month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0', entity ?? null, company],
    );
  }
}

type PostLine = [account: string, cents: number, party?: { customer?: string; vendor?: string }];

/** A FleetSuite entry; lines are [NetSuite account, cents debit positive, who the line names]. */
let keys = 0;
const post = (pg: PGlite, p: { company?: string; kind: string; id: string; date: string; lines: PostLine[] }) => {
  keys += 1;
  return one<{ id: string }>(pg, 'SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify({
    company: p.company ?? 'BMG',
    entry_date: p.date,
    source_type: p.kind,
    source_id: p.id,
    posting_rule: `${p.kind}@1`,
    idempotency_key: `${p.kind}:${p.id}:${keys}`,
    lines: p.lines.map(([account, cents, party]) => ({
      account_id: accountId(NS_ACCOUNT[account]),
      [cents > 0 ? 'debit' : 'credit']: money(cents),
      customer_id: party?.customer ?? null,
      vendor_ref: party?.vendor ?? null,
    })),
  })]);
};
const reverse = (pg: PGlite, entryId: string, date: string) =>
  pg.query('SELECT gl_reverse_entry($1::uuid, $2::date, NULL, NULL, NULL)', [entryId, date]);

interface Item {
  id: string;
  type: string;
  number?: string | null;
  date: string;
  due?: string | null;
  entity?: string | null;
  subsidiary?: string | null;
  cents: number;
}
const storeOpen = (pg: PGlite, items: Item[]) =>
  one<number>(pg, 'SELECT gl_netsuite_store_open_items($1::jsonb) AS r', [JSON.stringify({
    items: items.map((i) => ({
      netsuite_id: i.id, tran_type: i.type, tranid: i.number ?? null, trandate: i.date, due_date: i.due ?? null,
      entity_id: i.entity ?? null, subsidiary_id: i.subsidiary === undefined ? '2' : i.subsidiary,
      amount_open: (i.cents / 100).toFixed(2),
    })),
  })]);

/** What NetSuite has open: BMG is subsidiary 2, and 1084's is 5, which 1084 isn't linked to yet. */
const OPEN: Item[] = [
  // Acme: INV1001 with 300.00 of 500.00 paid, INV1007 FleetSuite hasn't posted, a credit memo not yet applied, and
  // INV0900 from before 2025, which neither side's ledger has.
  { id: '1001', type: 'CustInvc', number: 'INV1001', date: '2026-09-03', due: '2026-10-03', entity: '9001', cents: 20000 },
  { id: '1007', type: 'CustInvc', number: 'INV1007', date: '2026-10-02', due: '2026-11-01', entity: '9001', cents: 10000 },
  { id: '1010', type: 'CustCred', number: 'CM1010', date: '2026-10-10', entity: '9001', cents: -5000 },
  { id: '900', type: 'CustInvc', number: 'INV0900', date: '2024-11-20', due: '2024-12-20', entity: '9001', cents: 15000 },
  // Bravo: INV1002 FleetSuite posted for 310.00, and INV1003, its due date left out.
  { id: '1002', type: 'CustInvc', number: 'INV1002', date: '2026-06-10', due: '2026-07-10', entity: '9002', cents: 30000 },
  { id: '1003', type: 'CustInvc', number: 'INV1003', date: '2026-08-15', due: null, entity: '9003', cents: 20000 },
  // Charlie Cab, whom FleetSuite can't name: INV1004, and INV1005 with 100.00 of 300.00 paid, which FleetSuite hasn't
  // posted.
  { id: '1004', type: 'CustInvc', number: 'INV1004', date: '2026-09-14', due: '2026-10-14', entity: '9004', cents: 25000 },
  { id: '1005', type: 'CustInvc', number: 'INV1005', date: '2026-10-01', due: '2026-10-31', entity: '9004', cents: 20000 },
  // 1084's.
  { id: '1006', type: 'CustInvc', number: 'INV1006', date: '2026-09-14', due: '2026-10-14', entity: '9001', subsidiary: '5', cents: 60000 },
  // Vendors: a bill FleetSuite hasn't posted, a bill and a bill credit for the landlord, and a bill naming nobody.
  { id: '4002', type: 'VendBill', number: 'BILL4002', date: '2026-09-06', due: '2026-10-06', entity: '7002', cents: -15000 },
  { id: '4004', type: 'VendBill', number: 'BILL4004', date: '2026-10-01', due: '2026-11-01', entity: '7001', cents: -80000 },
  { id: '4005', type: 'VendCred', number: 'VC4005', date: '2026-10-05', entity: '7001', cents: 2000 },
  { id: '4006', type: 'VendBill', number: 'BILL4006', date: '2026-10-20', due: '2026-10-30', entity: null, cents: -3000 },
];

describe("migration 458's open documents", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();

    // NetSuite's general ledger since 2025.
    await copyTxn(db, '1001', 'CustInvc', 'INV1001', '2026-09-03', SEP, [['0', 'BMG', '120', 50000, '9001'], ['1', 'BMG', '400', -50000, '9001']]);
    await copyTxn(db, '2001', 'CustPymt', 'PMT2001', '2026-09-18', SEP, [['0', 'BMG', '110', 30000, '9001'], ['1', 'BMG', '120', -30000, '9001']]);
    await copyTxn(db, '1007', 'CustInvc', 'INV1007', '2026-10-02', OCT, [['0', 'BMG', '120', 10000, '9001'], ['1', 'BMG', '400', -10000, '9001']]);
    await copyTxn(db, '1010', 'CustCred', 'CM1010', '2026-10-10', OCT, [['0', 'BMG', '120', -5000, '9001'], ['1', 'BMG', '400', 5000, '9001']]);
    // INV1011 is paid off in NetSuite; FleetSuite posted it for 125.00, a day later.
    await copyTxn(db, '1011', 'CustInvc', 'INV1011', '2026-09-01', SEP, [['0', 'BMG', '120', 12000, '9001'], ['1', 'BMG', '400', -12000, '9001']]);
    await copyTxn(db, '2011', 'CustPymt', 'PMT2011', '2026-09-20', SEP, [['0', 'BMG', '110', 12000, '9001'], ['1', 'BMG', '120', -12000, '9001']]);
    // A payment of Acme's not applied to any invoice yet.
    await copyTxn(db, '2013', 'CustPymt', 'PMT2013', '2026-10-20', OCT, [['0', 'BMG', '110', 4000, '9001'], ['1', 'BMG', '120', -4000, '9001']]);
    await copyTxn(db, '1002', 'CustInvc', 'INV1002', '2026-06-10', JUN, [['0', 'BMG', '120', 30000, '9002'], ['1', 'BMG', '400', -30000, '9002']]);
    await copyTxn(db, '1003', 'CustInvc', 'INV1003', '2026-08-15', AUG, [['0', 'BMG', '120', 20000, '9003'], ['1', 'BMG', '400', -20000, '9003']]);
    await copyTxn(db, '1004', 'CustInvc', 'INV1004', '2026-09-14', SEP, [['0', 'BMG', '120', 25000, '9004'], ['1', 'BMG', '400', -25000, '9004']]);
    await copyTxn(db, '1005', 'CustInvc', 'INV1005', '2026-10-01', OCT, [['0', 'BMG', '120', 30000, '9004'], ['1', 'BMG', '400', -30000, '9004']]);
    await copyTxn(db, '2005', 'CustPymt', 'PMT2005', '2026-10-15', OCT, [['0', 'BMG', '110', 10000, '9004'], ['1', 'BMG', '120', -10000, '9004']]);
    // Delta's payment, which FleetSuite posted for 75.00: a difference, on a document that doesn't age.
    await copyTxn(db, '2012', 'CustPymt', 'PMT2012', '2026-10-05', OCT, [['0', 'BMG', '110', 7000, '9005'], ['1', 'BMG', '120', -7000, '9005']]);
    await copyTxn(db, '1006', 'CustInvc', 'INV1006', '2026-09-14', SEP, [['0', '1084', '120', 60000, '9001'], ['1', '1084', '400', -60000, '9001']]);
    await copyTxn(db, '4001', 'VendBill', 'BILL4001', '2026-09-05', SEP, [['0', 'BMG', '200', -40000, '7001'], ['1', 'BMG', '600', 40000, '7001']]);
    await copyTxn(db, '4101', 'VendPymt', 'BPAY4101', '2026-09-25', SEP, [['0', 'BMG', '200', 40000, '7001'], ['1', 'BMG', '110', -40000, '7001']]);
    await copyTxn(db, '4002', 'VendBill', 'BILL4002', '2026-09-06', SEP, [['0', 'BMG', '200', -15000, '7002'], ['1', 'BMG', '600', 15000, '7002']]);
    await copyTxn(db, '4004', 'VendBill', 'BILL4004', '2026-10-01', OCT, [['0', 'BMG', '200', -80000, '7001'], ['1', 'BMG', '600', 80000, '7001']]);
    await copyTxn(db, '4005', 'VendCred', 'VC4005', '2026-10-05', OCT, [['0', 'BMG', '200', 2000, '7001'], ['1', 'BMG', '600', -2000, '7001']]);
    await copyTxn(db, '4006', 'VendBill', 'BILL4006', '2026-10-20', OCT, [['0', 'BMG', '200', -3000], ['1', 'BMG', '600', 3000]]);

    // FleetSuite's books.
    await post(db, { kind: 'invoice', id: '1001', date: '2026-09-03', lines: [['120', 50000, { customer: ACME }], ['400', -50000]] });
    await post(db, { kind: 'payment', id: '2001', date: '2026-09-18', lines: [['110', 30000], ['120', -30000, { customer: ACME }]] });
    await post(db, { kind: 'credit_memo', id: '1010', date: '2026-10-10', lines: [['120', -5000, { customer: ACME }], ['400', 5000]] });
    await post(db, { kind: 'invoice', id: '1011', date: '2026-09-02', lines: [['120', 12500, { customer: ACME }], ['400', -12500]] });
    await post(db, { kind: 'payment', id: '2011', date: '2026-09-20', lines: [['110', 12000], ['120', -12000, { customer: ACME }]] });
    await post(db, { kind: 'payment', id: '2013', date: '2026-10-20', lines: [['110', 4000], ['120', -4000, { customer: ACME }]] });
    await post(db, { kind: 'invoice', id: '1002', date: '2026-06-10', lines: [['120', 31000, { customer: BRAVO }], ['400', -31000]] });
    await post(db, { kind: 'invoice', id: '1003', date: '2026-08-15', lines: [['120', 20000, { customer: BRAVO }], ['400', -20000]] });
    await post(db, { kind: 'invoice', id: '1004', date: '2026-09-14', lines: [['120', 25000], ['400', -25000]] });
    await post(db, { kind: 'payment', id: '2005', date: '2026-10-15', lines: [['110', 10000], ['120', -10000]] });
    await post(db, { kind: 'payment', id: '2012', date: '2026-10-05', lines: [['110', 7500], ['120', -7500, { customer: DELTA }]] });
    // Zulu's invoice only FleetSuite has: made, reversed a day after its replacement's date, and made again.
    const first = await post(db, { kind: 'invoice', id: '1008', date: '2026-09-27', lines: [['120', 8000, { customer: ZULU }], ['400', -8000]] });
    await reverse(db, first.id, '2026-09-29');
    await post(db, { kind: 'invoice', id: '1008', date: '2026-09-28', lines: [['120', 7500, { customer: ZULU }], ['400', -7500]] });
    await post(db, { company: '1084', kind: 'invoice', id: '1006', date: '2026-09-14', lines: [['120', 60000, { customer: ACME }], ['400', -60000]] });
    await post(db, { kind: 'vendor_bill', id: '4001', date: '2026-09-05', lines: [['200', -40000, { vendor: '7001' }], ['600', 40000]] });
    await post(db, { kind: 'bill_payment', id: '4101', date: '2026-09-25', lines: [['200', 40000, { vendor: '7001' }], ['110', -40000]] });
    await post(db, { kind: 'vendor_bill', id: '4004', date: '2026-10-01', lines: [['200', -80000, { vendor: '7001' }], ['600', 80000]] });
    await post(db, { kind: 'vendor_credit', id: '4005', date: '2026-10-05', lines: [['200', 2000, { vendor: '7001' }], ['600', -2000]] });
    await post(db, { kind: 'vendor_bill', id: '4006', date: '2026-10-20', lines: [['200', -3000], ['600', 3000]] });

    expect(await storeOpen(db, OPEN)).toBe(OPEN.length);
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const open = (kind: PartyKind, company = 'BMG') =>
    one<OpenDocumentsData>(db, 'SELECT gl_party_open_documents($1, $2) AS r', [company, kind]);
  const balances = (kind: PartyKind, company = 'BMG') =>
    one<PartyBalancesData>(db, 'SELECT gl_party_balances($1, $2) AS r', [company, kind]);
  const brief = (data: OpenDocumentsData) => data.rows.map((r) => [
    r.party, r.doc, r.type, r.number, r.date, r.netsuite_due, r.fleetsuite_due, toCents(r.netsuite), toCents(r.fleetsuite),
    r.netsuite_lines, r.fleetsuite_lines,
  ]);

  it("lists each customer's open documents, both sides, by customer then date", async () => {
    const found = await open('customer');
    expect(found).toMatchObject({ linked: true, documents: 8 });
    expect(brief(found)).toEqual([
      // Charlie Cab's invoices, under the customers FleetSuite can't name. FleetSuite hasn't posted INV1005, so it
      // isn't open in FleetSuite's books, though NetSuite has some of it paid.
      ['', '1004', 'CustInvc', 'INV1004', '2026-09-14', '2026-10-14', '2026-10-14', 25000, 25000, true, true],
      ['', '1005', 'CustInvc', 'INV1005', '2026-10-01', '2026-10-31', '2026-10-31', 20000, 0, true, false],
      // From before 2025, neither ledger has it: open the same on both sides.
      [ACME, '900', 'CustInvc', 'INV0900', '2024-11-20', '2024-12-20', '2024-12-20', 15000, 15000, false, false],
      // Paid off in NetSuite, but FleetSuite's books have 5.00 more on it than NetSuite's. Dated as NetSuite dates it.
      [ACME, '1011', 'CustInvc', 'INV1011', '2026-09-01', null, null, 0, 500, true, true],
      // Partly paid: what's open is NetSuite's, and its due date beats the ledger mirror's and 1084's own copy's.
      [ACME, '1001', 'CustInvc', 'INV1001', '2026-09-03', '2026-10-03', '2026-10-03', 20000, 20000, true, true],
      // FleetSuite hasn't posted it, so it isn't open in FleetSuite's books.
      [ACME, '1007', 'CustInvc', 'INV1007', '2026-10-02', '2026-11-01', '2026-11-01', 10000, 0, true, false],
      [ACME, '1010', 'CustCred', 'CM1010', '2026-10-10', null, null, -5000, -5000, true, true],
      // FleetSuite posted 10.00 more.
      [BRAVO, '1002', 'CustInvc', 'INV1002', '2026-06-10', '2026-07-10', '2026-07-10', 30000, 31000, true, true],
      // NetSuite's due date from the ledger mirror's copy, FleetSuite's from its own copy of the invoice.
      [BRAVO, '1003', 'CustInvc', 'INV1003', '2026-08-15', '2026-09-14', '2026-10-14', 20000, 20000, true, true],
      // Only FleetSuite has it, dated as its standing entry is, not its reversal or the one it replaced.
      [ZULU, '1008', 'CustInvc', null, '2026-09-28', null, null, 0, 7500, false, true],
    ]);
  });

  it('names each customer with a document, as Customer and vendor balances does', async () => {
    expect((await open('customer')).parties).toEqual([
      { party: '', name: null, netsuite_ids: [] },
      { party: ACME, name: 'Acme Fleet', netsuite_ids: ['9001'] },
      { party: BRAVO, name: 'Bravo Transit', netsuite_ids: ['9002', '9003'] },
      { party: ZULU, name: 'Zulu Logistics', netsuite_ids: [] },
    ]);
  });

  it("leaves out documents that don't age, though their sides differ", async () => {
    // Delta's payment differs, but a payment isn't an open invoice: it's in what's not in one.
    const found = await open('customer');
    expect(found.rows.some((r) => r.party === DELTA || r.doc === '2012')).toBe(false);
    expect(found.parties.some((p) => p.party === DELTA)).toBe(false);
    // Paid off the same on both sides: not open anywhere.
    expect(found.rows.some((r) => ['2001', '2011', '2013'].includes(r.doc))).toBe(false);
  });

  it("lists each vendor's open bills and bill credits", async () => {
    const found = await open('vendor');
    expect(found).toMatchObject({ linked: true, documents: 4 });
    expect(brief(found)).toEqual([
      ['', '4006', 'VendBill', 'BILL4006', '2026-10-20', '2026-10-30', '2026-10-30', -3000, -3000, true, true],
      ['7001', '4004', 'VendBill', 'BILL4004', '2026-10-01', '2026-11-01', '2026-11-01', -80000, -80000, true, true],
      ['7001', '4005', 'VendCred', 'VC4005', '2026-10-05', null, null, 2000, 2000, true, true],
      ['7002', '4002', 'VendBill', 'BILL4002', '2026-09-06', '2026-10-06', '2026-10-06', -15000, 0, true, false],
    ]);
    expect(found.parties).toEqual([
      { party: '', name: null, netsuite_ids: [] },
      { party: '7001', name: 'Landlord LLC', netsuite_ids: ['7001'] },
      { party: '7002', name: 'Parts Supply Co', netsuite_ids: ['7002'] },
    ]);
  });

  it("keeps a company's documents its own, and reads none for a company not linked to a subsidiary", async () => {
    // 1084 isn't linked yet: its invoice is posted the same on both sides, so nothing is open in its books.
    expect(await open('customer', '1084')).toEqual({ linked: false, documents: 0, parties: [], rows: [] });
    await db.exec(`RESET ROLE; UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084'; SET ROLE service_role`);
    try {
      const linked = await open('customer', '1084');
      expect(linked).toMatchObject({ linked: true, documents: 1 });
      expect(brief(linked)).toEqual([
        [ACME, '1006', 'CustInvc', 'INV1006', '2026-09-14', '2026-10-14', '2026-10-14', 60000, 60000, true, true],
      ]);
      expect(await open('vendor', '1084')).toEqual({ linked: true, documents: 0, parties: [], rows: [] });
      // BMG's are unchanged.
      expect((await open('customer')).documents).toBe(8);
    } finally {
      await db.exec(`RESET ROLE; UPDATE gl_companies SET netsuite_subsidiary_id = NULL WHERE code = '1084'; SET ROLE service_role`);
    }
    expect(await open('customer', 'NOPE')).toEqual({ linked: null, documents: 0, parties: [], rows: [] });
  });

  it("ages them so every side adds up to the customer's or vendor's balance, and the total to the account's", async () => {
    for (const kind of ['customer', 'vendor'] as const) {
      for (const company of ['BMG', '1084']) {
        const party = partyBalances(await balances(kind, company), kind);
        const agings = buildAgings(party, await open(kind, company), kind, TODAY);
        for (const side of ['fleetsuite', 'netsuite'] as const) {
          const bucketed = BUCKETS.reduce((sum, b) => sum + agings.totals.buckets[b][side], 0);
          expect(bucketed + agings.totals.notOpen[side] + agings.totals.unsplit, `${kind} ${company} ${side}`).toBe(party.totals[side]);
          for (const p of agings.parties) {
            const own = BUCKETS.reduce((sum, b) => sum + p.buckets[b][side], 0);
            expect(own + p.notOpen[side], `${kind} ${company} ${side} ${p.party}`).toBe(p.balance[side]);
          }
        }
      }
    }
  });

  it("ages BMG's customers to today: what's open by how late, and what's left of each balance", async () => {
    const agings = buildAgings(partyBalances(await balances('customer'), 'customer'), await open('customer'), 'customer', TODAY);
    const row = (party: string) => {
      const p = agings.parties.find((x) => x.party === party)!;
      return {
        fleetsuite: BUCKETS.map((b) => p.buckets[b].fleetsuite),
        netsuite: BUCKETS.map((b) => p.buckets[b].netsuite),
        notOpen: p.notOpen,
        balance: p.balance,
      };
    };
    // Acme: INV0900 680 days late, INV1011 60 days from its date, INV1001 28 days late and the credit memo 21 days
    // from its date, INV1007 not yet due; the unapplied payment is what's not in an open invoice.
    expect(row(ACME)).toEqual({
      fleetsuite: [0, 15000, 500, 0, 15000],
      netsuite: [10000, 15000, 0, 0, 15000],
      notOpen: { fleetsuite: -4000, netsuite: -4000 },
      balance: { fleetsuite: 26500, netsuite: 36000 },
    });
    // Bravo: INV1002 113 days late; INV1003 47 days late by NetSuite's due date, 17 by FleetSuite's own copy's.
    expect(row(BRAVO)).toEqual({
      fleetsuite: [0, 20000, 0, 0, 31000],
      netsuite: [0, 0, 20000, 0, 30000],
      notOpen: { fleetsuite: 0, netsuite: 0 },
      balance: { fleetsuite: 51000, netsuite: 50000 },
    });
    // Delta: nothing open, only its payment, which differs.
    expect(row(DELTA)).toEqual({
      fleetsuite: [0, 0, 0, 0, 0],
      netsuite: [0, 0, 0, 0, 0],
      notOpen: { fleetsuite: -7500, netsuite: -7000 },
      balance: { fleetsuite: -7500, netsuite: -7000 },
    });
    // The customers FleetSuite can't name: INV1005 is due today in NetSuite's books and not in FleetSuite's, where
    // the payment on it is what's not in an open invoice.
    expect(row('')).toEqual({
      fleetsuite: [0, 25000, 0, 0, 0],
      netsuite: [20000, 25000, 0, 0, 0],
      notOpen: { fleetsuite: -10000, netsuite: 0 },
      balance: { fleetsuite: 15000, netsuite: 45000 },
    });
    // What of the starting entry isn't split by name.
    expect(agings.totals.unsplit).toBe(2000);
    expect(agings.differing).toBe(5);
  });

  it("takes a document only FleetSuite's books have as the kind it posted as", async () => {
    // A credit memo for Zulu, and a bill (reposted for less) and a bill credit for Parts Supply Co, that NetSuite
    // doesn't have at all, and 1084's INV1006 posted in BMG's books by mistake.
    // The bill's first entry is reversed after its replacement posts, so the reversal is its latest entry.
    const replaced = await post(db, { kind: 'vendor_bill', id: '4020', date: '2026-10-11', lines: [['200', -7000, { vendor: '7002' }], ['600', 7000]] });
    const made = [
      await post(db, { kind: 'credit_memo', id: '1020', date: '2026-10-12', lines: [['120', -2500, { customer: ZULU }], ['400', 2500]] }),
      await post(db, { kind: 'vendor_bill', id: '4020', date: '2026-10-13', lines: [['200', -6000, { vendor: '7002' }], ['600', 6000]] }),
      await post(db, { kind: 'vendor_credit', id: '4021', date: '2026-10-14', lines: [['200', 1000, { vendor: '7002' }], ['600', -1000]] }),
      await post(db, { kind: 'invoice', id: '1006', date: '2026-09-14', lines: [['120', 60000, { customer: ACME }], ['400', -60000]] }),
    ];
    await reverse(db, replaced.id, '2026-10-12');
    const only = (data: OpenDocumentsData) => brief(data).filter((r) => ['1006', '1020', '4020', '4021'].includes(r[1] as string));
    try {
      expect(only(await open('customer'))).toEqual([
        // NetSuite has it in 1084's books, so in BMG's it's FleetSuite's alone.
        [ACME, '1006', 'CustInvc', 'INV1006', '2026-09-14', null, null, 0, 60000, false, true],
        [ZULU, '1020', 'CustCred', null, '2026-10-12', null, null, 0, -2500, false, true],
      ]);
      expect(only(await open('vendor'))).toEqual([
        ['7002', '4020', 'VendBill', null, '2026-10-13', null, null, 0, -6000, false, true],
        ['7002', '4021', 'VendCred', null, '2026-10-14', null, null, 0, 1000, false, true],
      ]);
    } finally {
      for (const entry of made) await reverse(db, entry.id, '2026-10-30');
    }
    // Reversed, they're open nowhere.
    expect(only(await open('customer'))).toEqual([]);
    expect(only(await open('vendor'))).toEqual([]);
  });

  it('replaces the copy whole, and an empty list empties it', async () => {
    expect(await storeOpen(db, OPEN.slice(0, 2))).toBe(2);
    expect((await open('customer')).documents).toBe(2);
    expect(await storeOpen(db, [])).toBe(0);
    expect(await open('customer')).toMatchObject({ documents: 0 });
    // With nothing open in NetSuite, only the documents whose sides differ are left, at FleetSuite's difference.
    expect((await open('customer')).rows.map((r) => [r.doc, toCents(r.netsuite), toCents(r.fleetsuite)])).toEqual([
      ['1011', 0, 500], ['1002', 0, 1000], ['1008', 0, 7500],
    ]);
    expect(await storeOpen(db, OPEN)).toBe(OPEN.length);
  });

  it('keeps blanks as nothing: no number, and no name', async () => {
    expect(await storeOpen(db, [...OPEN, { id: '4007', type: 'VendBill', number: '  ', date: '2026-10-21', cents: -100 }])).toBe(OPEN.length + 1);
    const stored = await db.query<{ tranid: string | null; entity_id: string; due_date: string | null }>(
      `SELECT tranid, entity_id, due_date::text FROM gl_netsuite_open_items WHERE netsuite_id = '4007'`,
    );
    expect(stored.rows).toEqual([{ tranid: null, entity_id: '', due_date: null }]);
    expect(await storeOpen(db, OPEN)).toBe(OPEN.length);
  });

  it("refuses an open amount at nothing or on the wrong side, a bad type, or a list that isn't one, keeping the copy", async () => {
    const bad: Item[] = [
      { id: '5001', type: 'CustInvc', date: '2026-10-01', cents: -100 },
      { id: '5002', type: 'CustCred', date: '2026-10-01', cents: 100 },
      { id: '5003', type: 'VendBill', date: '2026-10-01', cents: 100 },
      { id: '5004', type: 'VendCred', date: '2026-10-01', cents: -100 },
      { id: '5005', type: 'CustCred', date: '2026-10-01', cents: 0 },
      { id: '5006', type: 'Journal', date: '2026-10-01', cents: -100 },
      { id: 'X5007', type: 'CustInvc', date: '2026-10-01', cents: 100 },
      { id: '5008', type: 'CustInvc', date: '2026-10-01', entity: 'Acme', cents: 100 },
      { id: '5009', type: 'CustInvc', date: '2026-10-01', subsidiary: 'two', cents: 100 },
    ];
    for (const item of bad) {
      await expect(storeOpen(db, [...OPEN, item]), item.id).rejects.toThrow(/violates check constraint/);
    }
    await expect(one(db, 'SELECT gl_netsuite_store_open_items($1::jsonb) AS r', ['{}'])).rejects.toThrow(/must be a list/);
    await expect(one(db, 'SELECT gl_netsuite_store_open_items($1::jsonb) AS r', ['{"items": {}}'])).rejects.toThrow(/must be a list/);
    // None of them touched what was there.
    expect((await open('customer')).documents).toBe(8);
  });

  it('is for the server alone', async () => {
    await db.exec('RESET ROLE');
    for (const fn of ['public.gl_netsuite_store_open_items(jsonb)', 'public.gl_party_open_documents(text, text)']) {
      const can = async (role: string) => one<boolean>(db, `SELECT has_function_privilege($1, $2, 'EXECUTE') AS r`, [role, fn]);
      expect(await can('anon'), fn).toBe(false);
      expect(await can('authenticated'), fn).toBe(false);
      expect(await can('service_role'), fn).toBe(true);
    }
    const table = async (role: string) => one<boolean>(db, `SELECT has_table_privilege($1, 'public.gl_netsuite_open_items', 'SELECT') AS r`, [role]);
    expect(await table('anon')).toBe(false);
    expect(await table('authenticated')).toBe(false);
    expect(await one<boolean>(db, `SELECT relrowsecurity AS r FROM pg_class WHERE oid = 'public.gl_netsuite_open_items'::regclass`)).toBe(true);
    await db.exec('SET ROLE service_role');
  });
});
