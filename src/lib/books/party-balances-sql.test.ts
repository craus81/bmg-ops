// Migration 406 puts each customer's and vendor's balance in FleetSuite's
// books next to NetSuite's. This runs migrations 314 and 359–363 with 406 in
// an in-memory Postgres (PGlite) as the app's server login, copies a made-up
// NetSuite general ledger with the starting entry by name, posts FleetSuite's
// own entries for it (a replaced one, lines naming nobody, a customer
// NetSuite's side can't name, one the mirror matched after FleetSuite posted
// it among them), and holds what gl_party_balances and gl_party_documents
// return.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { toCents } from './netsuite-gl';
import type { PartyBalancesData, PartyDocumentsData } from './party-balances';

const SEP = '2026-09-01';
const OCT = '2026-10-01';

/** Made-up chart, keyed by NetSuite id. */
const ACCOUNTS: Array<[string, string, string, string]> = [
  ['110', '1100', 'Checking', 'bank'],
  ['120', '1200', 'Receivables', 'accounts_receivable'],
  ['121', '1210', 'Other receivables', 'accounts_receivable'],
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
    -- What migration 314 points at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY);
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '406-books-party-balances.sql',
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
  // Zulu only by a cleaned name, which posting doesn't go by, and Echo
  // Express it hasn't matched.
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
      ('netsuite', 'customer/9005', '9005', 'Delta Dairy', 'delta dairy', 'exact', $3),
      ('netsuite', 'customer/9006', '9006', 'Echo Express', 'echo express', 'pending', NULL)
  `, [ACME, BRAVO, DELTA, ZULU]);
  await pg.exec(`
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES
      ('vendor', '7001', 'Landlord LLC', true), ('vendor', '7002', 'Parts Supply Co', true), ('vendor', '7003', 'Tow Truck Inc', true);
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

type PostLine = [account: string, cents: number, party?: { customer?: string; vendor?: string; memo?: string }];

/** A FleetSuite entry; lines are [NetSuite account, cents debit positive, who the line names]. */
let keys = 0;
const post = (pg: PGlite, p: { company?: string; kind: string; id: string; date: string; memo?: string; lines: PostLine[] }) => {
  keys += 1;
  return one<{ id: string }>(pg, 'SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify({
    company: p.company ?? 'BMG',
    entry_date: p.date,
    source_type: p.kind,
    source_id: p.id,
    posting_rule: `${p.kind}@1`,
    idempotency_key: `${p.kind}:${p.id}:${keys}`,
    memo: p.memo ?? null,
    lines: p.lines.map(([account, cents, party]) => ({
      account_id: accountId(NS_ACCOUNT[account]),
      [cents > 0 ? 'debit' : 'credit']: money(cents),
      customer_id: party?.customer ?? null,
      vendor_ref: party?.vendor ?? null,
      memo: party?.memo ?? null,
    })),
  })]);
};
const reverse = (pg: PGlite, entryId: string, date: string) =>
  pg.query('SELECT gl_reverse_entry($1::uuid, $2::date, NULL, NULL, NULL)', [entryId, date]);

/** The starting entry: NetSuite's totals per account and, by name, what of them each customer and vendor holds. */
async function opening(pg: PGlite, parties: Array<{ account: string; entity: string | null; cents: number }>) {
  await pg.query(`
    INSERT INTO gl_netsuite_opening (company_id, netsuite_account_id, debit, credit, line_count)
    SELECT id, '120', 1000.00, 200.00, 3 FROM gl_companies WHERE code = 'BMG'
    UNION ALL SELECT id, '200', 0, 300.00, 1 FROM gl_companies WHERE code = 'BMG'
  `);
  return storeParties(pg, parties);
}
const storeParties = (pg: PGlite, parties: Array<{ account: string; entity: string | null; cents: number; company?: string }>) =>
  one<number>(pg, 'SELECT gl_netsuite_store_opening_parties($1::jsonb) AS r', [JSON.stringify({
    parties: parties.map((p) => ({
      company: p.company ?? 'BMG', netsuite_account_id: p.account, entity_id: p.entity,
      debit: p.cents > 0 ? money(p.cents) : '0', credit: p.cents < 0 ? money(p.cents) : '0', line_count: 1,
    })),
  })]);

const STARTING_PARTIES = [
  { account: '120', entity: '9001', cents: 70000 },
  { account: '120', entity: '9004', cents: 30000 },
  { account: '120', entity: null, cents: -20000 },
  { account: '200', entity: '7001', cents: -30000 },
];

describe("migration 406's customer and vendor balances", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    expect(await opening(db, STARTING_PARTIES)).toBe(4);

    // NetSuite. Acme: an invoice and its payment, a fee journaled from the
    // receivable account to the other one, and an October invoice FleetSuite
    // hasn't posted. Bravo: one invoice for each of its NetSuite customers.
    // Charlie Cab, whom the mirror hasn't matched, an invoice. Delta: an
    // invoice and its payment. Echo Express, unmatched too: a reclass from
    // one receivable account to the other that comes to nothing. Vendors: a
    // bill and its payment, a bill FleetSuite hasn't posted, one paid off,
    // and an accrual naming nobody. 1084 has an invoice of its own for Acme.
    const acme = { entity: '9001' };
    await copyTxn(db, '1001', 'CustInvc', 'INV1001', '2026-09-03', SEP, [['0', 'BMG', '120', 50000, acme], ['1', 'BMG', '400', -50000, acme]]);
    await copyTxn(db, '1002', 'CustInvc', 'INV1002', '2026-09-10', SEP, [['0', 'BMG', '120', 30000, { entity: '9002' }], ['1', 'BMG', '400', -30000, { entity: '9002' }]]);
    await copyTxn(db, '1003', 'CustInvc', 'INV1003', '2026-09-12', SEP, [['0', 'BMG', '120', 20000, { entity: '9003' }], ['1', 'BMG', '400', -20000, { entity: '9003' }]]);
    await copyTxn(db, '1004', 'CustInvc', 'INV1004', '2026-09-14', SEP, [['0', 'BMG', '120', 25000, { entity: '9004' }], ['1', 'BMG', '400', -25000, { entity: '9004' }]]);
    await copyTxn(db, '2001', 'CustPymt', 'PMT2001', '2026-09-18', SEP, [['0', 'BMG', '110', 50000, acme], ['1', 'BMG', '120', -50000, acme]]);
    await copyTxn(db, '3001', 'Journal', 'JE3001', '2026-09-20', SEP, [
      ['0', 'BMG', '121', 4000, { entity: '9001', memo: 'Fee' }], ['1', 'BMG', '120', -4000, { memo: 'Fee' }],
    ]);
    await copyTxn(db, '1007', 'CustInvc', 'INV1007', '2026-10-02', OCT, [['0', 'BMG', '120', 10000, acme], ['1', 'BMG', '400', -10000, acme]]);
    await copyTxn(db, '1009', 'CustInvc', 'INV1009', '2026-09-08', SEP, [['0', 'BMG', '120', 12000, { entity: '9005' }], ['1', 'BMG', '400', -12000, { entity: '9005' }]]);
    await copyTxn(db, '2009', 'CustPymt', 'PMT2009', '2026-09-15', SEP, [['0', 'BMG', '110', 12000, { entity: '9005' }], ['1', 'BMG', '120', -12000, { entity: '9005' }]]);
    await copyTxn(db, '3002', 'Journal', 'JE3002', '2026-09-22', SEP, [
      ['0', 'BMG', '121', 5000, { entity: '9006', memo: 'Reclass' }], ['1', 'BMG', '120', -5000, { entity: '9006', memo: 'Reclass' }],
    ]);
    await copyTxn(db, '3003', 'Journal', 'JE3003', '2026-09-24', SEP, [['0', 'BMG', '600', 2500, { memo: 'Accrued rent' }], ['1', 'BMG', '200', -2500, { memo: 'Accrued rent' }]]);
    await copyTxn(db, '4001', 'VendBill', 'BILL4001', '2026-09-05', SEP, [['0', 'BMG', '200', -80000, { entity: '7001' }], ['1', 'BMG', '600', 80000, { entity: '7001' }]]);
    await copyTxn(db, '4002', 'VendBill', 'BILL4002', '2026-09-06', SEP, [['0', 'BMG', '200', -15000, { entity: '7002' }], ['1', 'BMG', '600', 15000, { entity: '7002' }]]);
    await copyTxn(db, '4003', 'VendBill', 'BILL4003', '2026-09-07', SEP, [['0', 'BMG', '200', -9000, { entity: '7003' }], ['1', 'BMG', '600', 9000, { entity: '7003' }]]);
    await copyTxn(db, '4101', 'VendPymt', 'BPAY4101', '2026-09-25', SEP, [['0', 'BMG', '200', 80000, { entity: '7001' }], ['1', 'BMG', '110', -80000, { entity: '7001' }]]);
    await copyTxn(db, '4103', 'VendPymt', 'BPAY4103', '2026-09-26', SEP, [['0', 'BMG', '200', 9000, { entity: '7003' }], ['1', 'BMG', '110', -9000, { entity: '7003' }]]);
    await copyTxn(db, '1006', 'CustInvc', 'INV1006', '2026-09-14', SEP, [['0', '1084', '120', 60000, acme], ['1', '1084', '400', -60000, acme]]);

    // FleetSuite. INV1003 was replaced: the first entry, its reversal, the
    // right one. INV1004's line names nobody, as the mirror couldn't match
    // Charlie Cab, and so does the fee's other side. Delta's invoice and
    // payment name nobody either: they posted before the mirror matched
    // Delta. Zulu has an invoice NetSuite never had.
    await post(db, { kind: 'invoice', id: '1001', date: '2026-09-03', lines: [['120', 50000, { customer: ACME }], ['400', -50000]] });
    await post(db, { kind: 'invoice', id: '1002', date: '2026-09-10', lines: [['120', 30000, { customer: BRAVO }], ['400', -30000]] });
    const first = await post(db, { kind: 'invoice', id: '1003', date: '2026-09-12', lines: [['120', 21000, { customer: BRAVO }], ['400', -21000]] });
    await reverse(db, first.id, '2026-09-12');
    await post(db, { kind: 'invoice', id: '1003', date: '2026-09-12', lines: [['120', 20000, { customer: BRAVO }], ['400', -20000]] });
    await post(db, { kind: 'invoice', id: '1004', date: '2026-09-14', lines: [['120', 25000], ['400', -25000]] });
    await post(db, { kind: 'payment', id: '2001', date: '2026-09-18', lines: [['110', 50000], ['120', -50000, { customer: ACME }]] });
    await post(db, { kind: 'journal_entry', id: '3001', date: '2026-09-20', lines: [['121', 4000, { customer: ACME, memo: 'Fee' }], ['120', -4000]] });
    await post(db, { kind: 'invoice', id: '1008', date: '2026-09-28', lines: [['120', 7500, { customer: ZULU }], ['400', -7500]] });
    await post(db, { kind: 'invoice', id: '1009', date: '2026-09-08', lines: [['120', 12000], ['400', -12000]] });
    await post(db, { kind: 'payment', id: '2009', date: '2026-09-15', lines: [['110', 12000], ['120', -12000]] });
    await post(db, { kind: 'journal_entry', id: '3002', date: '2026-09-22', lines: [['121', 5000], ['120', -5000]] });
    await post(db, { kind: 'journal_entry', id: '3003', date: '2026-09-24', lines: [['600', 2500], ['200', -2500]] });
    await post(db, { kind: 'vendor_bill', id: '4001', date: '2026-09-05', lines: [['200', -80000, { vendor: '7001' }], ['600', 80000]] });
    await post(db, { kind: 'vendor_bill', id: '4003', date: '2026-09-07', lines: [['200', -9000, { vendor: '7003' }], ['600', 9000]] });
    await post(db, { kind: 'bill_payment', id: '4101', date: '2026-09-25', lines: [['200', 80000, { vendor: '7001' }], ['110', -80000]] });
    await post(db, { kind: 'bill_payment', id: '4103', date: '2026-09-26', lines: [['200', 9000, { vendor: '7003' }], ['110', -9000]] });
    await post(db, { company: '1084', kind: 'invoice', id: '1006', date: '2026-09-14', lines: [['120', 60000, { customer: ACME }], ['400', -60000]] });
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const balances = (kind: 'customer' | 'vendor', company = 'BMG') =>
    one<PartyBalancesData>(db, 'SELECT gl_party_balances($1, $2) AS r', [company, kind]);
  const documents = (kind: 'customer' | 'vendor', party: string, opts: { company?: string; differs?: boolean; limit?: number } = {}) =>
    one<PartyDocumentsData>(db, 'SELECT gl_party_documents($1, $2, $3, $4, $5) AS r', [
      opts.company ?? 'BMG', kind, party, opts.differs ?? false, opts.limit ?? 100,
    ]);
  const cents = (s: string | null) => (s === null ? null : toCents(s));
  const brief = (data: PartyBalancesData) => data.parties.map((p) => [
    p.party, p.name, cents(p.opening), cents(p.netsuite), cents(p.fleetsuite), p.documents, p.differing,
  ]);

  it("puts every customer's balance next to NetSuite's, from the starting entry, by the FleetSuite customer the line names", async () => {
    const found = await balances('customer');
    expect(found.accounts).toEqual([
      { netsuite_account_id: '120', number: '1200', name: 'Receivables' },
      { netsuite_account_id: '121', number: '1210', name: 'Other receivables' },
    ]);
    expect(brief(found)).toEqual([
      // Charlie Cab and the fee's other side: lines FleetSuite's books can't
      // name, together, the same on both sides; FleetSuite's side has Delta's
      // invoice and payment too, which come to nothing. Echo's reclass comes
      // to nothing on both sides, so it isn't counted.
      ['', null, 10000, 21000, 21000, 4, 2],
      // Acme: the October invoice FleetSuite hasn't posted.
      [ACME, 'Acme Fleet', 70000, 14000, 4000, 4, 1],
      // Bravo: two NetSuite customers, one FleetSuite customer; INV1003 nets to the replacement.
      [BRAVO, 'Bravo Transit', 0, 50000, 50000, 2, 0],
      // Delta: nothing owed either side, but both its documents are FleetSuite's under no one.
      [DELTA, 'Delta Dairy', 0, 0, 0, 2, 2],
      // Zulu: FleetSuite's alone; the cleaned-name match brings Charlie Cab's lines nowhere near it.
      [ZULU, 'Zulu Logistics', 0, 0, 7500, 1, 1],
    ]);
    expect(found.parties.map((p) => p.netsuite_ids)).toEqual([[], ['9001'], ['9002', '9003'], ['9005'], []]);
  });

  it('lists the NetSuite names behind the customers FleetSuite can\'t name, with what each holds there', async () => {
    const unnamed = (await balances('customer')).parties[0];
    // Echo Express holds nothing there, so it isn't listed.
    expect(unnamed.members_count).toBe(2);
    expect(unnamed.members?.map((m) => [m.entity_id, m.name, cents(m.opening), cents(m.netsuite)])).toEqual([
      ['9004', 'Charlie Cab', 30000, 25000],
      ['', null, -20000, -4000],
    ]);
    // Named customers have no members.
    expect((await balances('customer')).parties[1]).toMatchObject({ members: null, members_count: null });
  });

  it('holds the starting entry by name next to the whole of it, and says when the two differ', async () => {
    expect((await balances('customer')).opening).toEqual({ total: '800.00', named: '800.00', complete: true });
    expect((await balances('vendor')).opening).toEqual({ total: '-300.00', named: '-300.00', complete: true });
    // A read that missed a name leaves the by-name part short.
    expect(await storeParties(db, STARTING_PARTIES.slice(1))).toBe(3);
    expect((await balances('customer')).opening).toEqual({ total: '800.00', named: '100.00', complete: false });
    expect((await balances('vendor')).opening).toMatchObject({ complete: true });
    // The same amounts on fewer lines than NetSuite's totals counted.
    expect(await storeParties(db, [
      { account: '120', entity: '9001', cents: 100000 }, { account: '120', entity: null, cents: -20000 }, STARTING_PARTIES[3],
    ])).toBe(3);
    expect((await balances('customer')).opening).toEqual({ total: '800.00', named: '800.00', complete: false });
    // Nothing stored at all.
    expect(await storeParties(db, [])).toBe(0);
    expect((await balances('customer')).opening).toEqual({ total: '800.00', named: '0', complete: false });
    expect(await storeParties(db, STARTING_PARTIES)).toBe(4);
    expect((await balances('customer')).opening).toMatchObject({ complete: true });
  });

  it("puts every vendor's balance next to NetSuite's, leaving out the ones at nothing on both sides", async () => {
    const found = await balances('vendor');
    expect(found.accounts).toEqual([{ netsuite_account_id: '200', number: '2000', name: 'Payables' }]);
    expect(brief(found)).toEqual([
      ['', null, 0, -2500, -2500, 1, 0],
      ['7001', 'Landlord LLC', -30000, 0, 0, 2, 0],
      ['7002', 'Parts Supply Co', 0, -15000, 0, 1, 1],
    ]);
    expect(found.parties.map((p) => [p.netsuite_ids, p.members])).toEqual([[[], null], [['7001'], null], [['7002'], null]]);
  });

  it("keeps each company's balances its own", async () => {
    expect(brief(await balances('customer', '1084'))).toEqual([[ACME, 'Acme Fleet', 0, 60000, 60000, 1, 0]]);
    expect((await balances('customer', '1084')).opening).toEqual({ total: '0', named: '0', complete: true });
    expect((await balances('vendor', '1084')).parties).toEqual([]);
    expect((await balances('customer', 'NOPE')).parties).toEqual([]);
  });

  it('lists the documents behind one balance, both sides, those that differ first, then the newest', async () => {
    const acme = await documents('customer', ACME);
    expect(acme).toMatchObject({ party: ACME, name: 'Acme Fleet', netsuite_ids: ['9001'], documents: 4, differing: 1 });
    expect([cents(acme.opening), cents(acme.netsuite), cents(acme.fleetsuite)]).toEqual([70000, 14000, 4000]);
    expect(acme.rows.map((r) => [r.number, r.date, cents(r.netsuite), cents(r.fleetsuite)])).toEqual([
      ['INV1007', '2026-10-02', 10000, 0],
      ['JE3001', '2026-09-20', 4000, 4000],
      ['PMT2001', '2026-09-18', -50000, -50000],
      ['INV1001', '2026-09-03', 50000, 50000],
    ]);
    expect(acme.rows[0]).toMatchObject({ kind: null, type: 'CustInvc', month: OCT, name: 'Acme Fleet Services', entries: 0, entry_no: null });
    expect(acme.rows[1]).toMatchObject({ kind: 'journal_entry', type: 'Journal', month: SEP, memo: 'Fee', entries: 1 });
    expect(acme.rows[1].entry_no).toEqual(expect.any(Number));
  });

  it('lists a replaced document once, at what stands, and one only FleetSuite has by its own date', async () => {
    const bravo = await documents('customer', BRAVO);
    expect(bravo.rows.map((r) => [r.number, cents(r.netsuite), cents(r.fleetsuite), r.entries, r.name])).toEqual([
      ['INV1003', 20000, 20000, 3, 'Bravo Transit West'],
      ['INV1002', 30000, 30000, 1, 'Bravo Transit'],
    ]);
    expect(bravo).toMatchObject({ name: 'Bravo Transit', netsuite_ids: ['9002', '9003'], opening: '0' });
    const zulu = await documents('customer', ZULU);
    expect(zulu.rows).toEqual([expect.objectContaining({
      doc: '1008', type: null, number: null, month: null, date: '2026-09-28', kind: 'invoice', name: null, netsuite: '0', fleetsuite: '75.00',
    })]);
  });

  it("lists the documents of the customers FleetSuite can't name, and a vendor's", async () => {
    const unnamed = await documents('customer', '');
    expect(unnamed).toMatchObject({ party: '', name: null, netsuite_ids: [], documents: 4, differing: 2 });
    expect(cents(unnamed.opening)).toBe(10000);
    expect(unnamed.rows.map((r) => [r.number, cents(r.netsuite), cents(r.fleetsuite), r.name])).toEqual([
      // Delta's, here on FleetSuite's side alone, named as NetSuite names them.
      ['PMT2009', 0, -12000, 'Delta Dairy'],
      ['INV1009', 0, 12000, 'Delta Dairy'],
      // The fee's other side names nobody, so the document's first name stands.
      ['JE3001', -4000, -4000, 'Acme Fleet Services'],
      ['INV1004', 25000, 25000, 'Charlie Cab'],
    ]);
    const delta = await documents('customer', DELTA);
    expect(delta.rows.map((r) => [r.number, cents(r.netsuite), cents(r.fleetsuite)])).toEqual([
      ['PMT2009', -12000, 0],
      ['INV1009', 12000, 0],
    ]);
    const nobody = await documents('vendor', '');
    expect(nobody).toMatchObject({ name: null, netsuite_ids: [], documents: 1, differing: 0, netsuite: '-25.00', fleetsuite: '-25.00' });
    expect(nobody.rows).toEqual([expect.objectContaining({ number: 'JE3003', memo: 'Accrued rent', name: null })]);
    const parts = await documents('vendor', '7002');
    expect(parts).toMatchObject({ name: 'Parts Supply Co', netsuite_ids: ['7002'], documents: 1, differing: 1, netsuite: '-150.00', fleetsuite: '0' });
    expect(parts.rows).toEqual([expect.objectContaining({ number: 'BILL4002', type: 'VendBill', kind: null, name: 'Parts Supply Co' })]);
    expect((await documents('vendor', '7003')).rows.map((r) => r.number)).toEqual(['BPAY4103', 'BILL4003']);
  });

  it('lists only the documents that differ with p_differs, and at most p_limit, the counts still of all', async () => {
    expect((await documents('customer', ACME, { differs: true })).rows.map((r) => r.number)).toEqual(['INV1007']);
    const two = await documents('customer', ACME, { limit: 2 });
    expect(two.rows.map((r) => r.number)).toEqual(['INV1007', 'JE3001']);
    expect(two).toMatchObject({ documents: 4, differing: 1 });
    // Those that differ come first though newer ones don't.
    expect((await documents('customer', '', { limit: 1 })).rows.map((r) => r.number)).toEqual(['PMT2009']);
    expect(await documents('customer', ACME, { company: '1084' })).toMatchObject({ documents: 1, differing: 0 });
    expect(await documents('customer', 'c0000000-0000-4000-8000-0000000000ff')).toMatchObject({
      name: null, netsuite_ids: [], opening: '0', documents: 0, rows: [],
    });
  });

  it("comes to each party's balance, so its documents add up to the list", async () => {
    for (const kind of ['customer', 'vendor'] as const) {
      for (const party of (await balances(kind)).parties) {
        const found = await documents(kind, party.party);
        expect([found.netsuite, found.fleetsuite, found.opening, found.documents, found.differing], `${kind} ${party.party}`)
          .toEqual([party.netsuite, party.fleetsuite, party.opening, party.documents, party.differing]);
      }
    }
  });

  it('refuses a starting entry by name that is not a list or names a company that does not exist', async () => {
    await expect(one(db, 'SELECT gl_netsuite_store_opening_parties($1::jsonb) AS r', ['{}'])).rejects.toThrow(/must be a list/);
    await expect(storeParties(db, [{ account: '120', entity: '9001', cents: 100, company: 'NOPE' }])).rejects.toThrow(/doesn't exist/);
    // Neither touched what was there.
    expect((await balances('customer')).opening).toMatchObject({ named: '800.00', complete: true });
  });

  it('is for the server alone', async () => {
    await db.exec('RESET ROLE');
    for (const fn of [
      'public.gl_netsuite_store_opening_parties(jsonb)',
      'public.gl_party_balances(text, text)',
      'public.gl_party_documents(text, text, text, boolean, integer)',
    ]) {
      const can = async (role: string) => one<boolean>(db, `SELECT has_function_privilege($1, $2, 'EXECUTE') AS r`, [role, fn]);
      expect(await can('anon'), fn).toBe(false);
      expect(await can('authenticated'), fn).toBe(false);
      expect(await can('service_role'), fn).toBe(true);
    }
    const table = async (role: string) => one<boolean>(db, `SELECT has_table_privilege($1, 'public.gl_netsuite_opening_parties', 'SELECT') AS r`, [role]);
    expect(await table('anon')).toBe(false);
    expect(await table('authenticated')).toBe(false);
    await db.exec('SET ROLE service_role');
  });
});
