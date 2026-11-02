// Migration 503 puts each customer's and vendor's balance at the end of a
// month next to NetSuite's, for the year-end package. This runs migrations
// 314, 359–363 and 406 in an in-memory Postgres (PGlite) as the app's server
// login, copies a made-up NetSuite general ledger across November, December
// and January with the starting entry by name, posts FleetSuite's own
// entries for it (an invoice NetSuite posted to the next month, one
// FleetSuite replaced in January, lines naming nobody), keeps what
// gl_party_balances answers, then runs 503 and holds that it answers the
// same and what gl_party_balances_through answers month by month.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { toCents } from './netsuite-gl';
import type { PartyBalancesData } from './party-balances';

const NOV = '2026-11-01';
const DEC = '2026-12-01';
const JAN = '2027-01-01';

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

/** FleetSuite's customers, both matched by the ledger mirror; Echo Express it hasn't matched. */
const ACME = 'c0000000-0000-4000-8000-00000000000a';
const BRAVO = 'c0000000-0000-4000-8000-00000000000b';

const migration = (file: string) => readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');

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
    await pg.exec(migration(file));
  }
  for (const [ns, number, name, type] of ACCOUNTS) {
    await pg.query(
      `INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, active) VALUES ($1, $2, $3, $4, $5, true)`,
      [accountId(number), number, name, type, ns],
    );
  }
  await pg.query(`INSERT INTO customers (id, company_name) VALUES ($1, 'Acme Fleet'), ($2, 'Bravo Transit')`, [ACME, BRAVO]);
  await pg.query(`
    INSERT INTO ledger_customers (source, external_id, external_ref, display_name, cleaned_name, match_status, customer_id) VALUES
      ('netsuite', 'customer/9001', '9001', 'Acme Fleet Services', 'acme fleet services', 'exact', $1),
      ('netsuite', 'customer/9002', '9002', 'Bravo Transit', 'bravo transit', 'exact', $2),
      ('netsuite', 'customer/9006', '9006', 'Echo Express', 'echo express', 'pending', NULL)
  `, [ACME, BRAVO]);
  await pg.exec(`INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES ('vendor', '7001', 'Landlord LLC', true)`);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;

/** A NetSuite transaction as the GL copy keeps it; lines are [company, account, cents debit positive, NetSuite's name id]. */
async function copyTxn(pg: PGlite, id: string, type: string, date: string, month: string, lines: Array<[string, string, number, string?]>) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [id, type, `${type}${id}`, date, month],
  );
  for (const [i, [company, account, cents, entity]] of lines.entries()) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, entity_id)
       SELECT $1, $2, id, $3, $4, $5, $6, $7, $8 FROM gl_companies WHERE code = $9`,
      [id, String(i), account, month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0', entity ?? null, company],
    );
  }
}

/** A FleetSuite entry; lines are [NetSuite account, cents debit positive, who the line names]. */
let keys = 0;
const post = (pg: PGlite, p: { company?: string; kind: string; id: string; date: string; lines: Array<[string, number, { customer?: string; vendor?: string }?]> }) => {
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

type Kind = 'customer' | 'vendor';
const cases: Array<[company: string, kind: Kind]> = [['BMG', 'customer'], ['BMG', 'vendor'], ['1084', 'customer'], ['1084', 'vendor'], ['NOPE', 'customer']];

describe("migration 503's customer and vendor balances at a month's end", () => {
  let db: PGlite;
  /** What migration 406's gl_party_balances answered for each company and kind, before 503. */
  const before = new Map<string, PartyBalancesData>();

  beforeAll(async () => {
    db = await freshDb();
    // Before 2025: Acme owed 700.00, Echo Express 100.00, and BMG owed the landlord 300.00.
    await db.exec(`
      INSERT INTO gl_netsuite_opening (company_id, netsuite_account_id, debit, credit, line_count)
      SELECT id, '120', 800.00, 0, 2 FROM gl_companies WHERE code = 'BMG'
      UNION ALL SELECT id, '200', 0, 300.00, 1 FROM gl_companies WHERE code = 'BMG'
    `);
    expect(await one<number>(db, 'SELECT gl_netsuite_store_opening_parties($1::jsonb) AS r', [JSON.stringify({
      parties: [
        { company: 'BMG', netsuite_account_id: '120', entity_id: '9001', debit: '700.00', credit: '0', line_count: 1 },
        { company: 'BMG', netsuite_account_id: '120', entity_id: '9006', debit: '100.00', credit: '0', line_count: 1 },
        { company: 'BMG', netsuite_account_id: '200', entity_id: '7001', debit: '0', credit: '300.00', line_count: 1 },
      ],
    })])).toBe(3);

    // NetSuite. Acme: November's invoice, its payment in December, December's
    // invoice 1006 as NetSuite has it now, and a January invoice. Bravo: an
    // invoice dated December 30 that NetSuite posted to January. Echo Express,
    // whom the mirror hasn't matched: a December invoice. The landlord: a
    // December bill paid in January. 1084: a December invoice for Acme.
    await copyTxn(db, '1001', 'CustInvc', '2026-11-05', NOV, [['BMG', '120', 50000, '9001'], ['BMG', '400', -50000, '9001']]);
    await copyTxn(db, '2001', 'CustPymt', '2026-12-20', DEC, [['BMG', '110', 50000, '9001'], ['BMG', '120', -50000, '9001']]);
    await copyTxn(db, '1006', 'CustInvc', '2026-12-15', DEC, [['BMG', '120', 40000, '9001'], ['BMG', '400', -40000, '9001']]);
    await copyTxn(db, '1004', 'CustInvc', '2027-01-05', JAN, [['BMG', '120', 40000, '9001'], ['BMG', '400', -40000, '9001']]);
    await copyTxn(db, '1002', 'CustInvc', '2026-12-30', JAN, [['BMG', '120', 30000, '9002'], ['BMG', '400', -30000, '9002']]);
    await copyTxn(db, '1003', 'CustInvc', '2026-12-10', DEC, [['BMG', '120', 25000, '9006'], ['BMG', '400', -25000, '9006']]);
    await copyTxn(db, '4001', 'VendBill', '2026-12-01', DEC, [['BMG', '200', -40000, '7001'], ['BMG', '600', 40000, '7001']]);
    await copyTxn(db, '4101', 'VendPymt', '2027-01-10', JAN, [['BMG', '200', 40000, '7001'], ['BMG', '110', -40000, '7001']]);
    await copyTxn(db, '1009', 'CustInvc', '2026-12-10', DEC, [['1084', '120', 60000, '9001'], ['1084', '400', -60000, '9001']]);

    // FleetSuite. Invoice 1006 posted at 450.00 on December 15, reversed and
    // posted again at 400.00 on January 2. Bravo's invoice is in December by
    // its date. Echo's line names nobody. Nothing yet for Acme's January invoice.
    await post(db, { kind: 'invoice', id: '1001', date: '2026-11-05', lines: [['120', 50000, { customer: ACME }], ['400', -50000]] });
    await post(db, { kind: 'payment', id: '2001', date: '2026-12-20', lines: [['110', 50000], ['120', -50000, { customer: ACME }]] });
    const first = await post(db, { kind: 'invoice', id: '1006', date: '2026-12-15', lines: [['120', 45000, { customer: ACME }], ['400', -45000]] });
    await db.query('SELECT gl_reverse_entry($1::uuid, $2::date, NULL, NULL, NULL)', [first.id, '2027-01-02']);
    await post(db, { kind: 'invoice', id: '1006', date: '2027-01-02', lines: [['120', 40000, { customer: ACME }], ['400', -40000]] });
    await post(db, { kind: 'invoice', id: '1002', date: '2026-12-30', lines: [['120', 30000, { customer: BRAVO }], ['400', -30000]] });
    await post(db, { kind: 'invoice', id: '1003', date: '2026-12-10', lines: [['120', 25000], ['400', -25000]] });
    await post(db, { kind: 'vendor_bill', id: '4001', date: '2026-12-01', lines: [['200', -40000, { vendor: '7001' }], ['600', 40000]] });
    await post(db, { kind: 'bill_payment', id: '4101', date: '2027-01-10', lines: [['200', 40000, { vendor: '7001' }], ['110', -40000]] });
    await post(db, { company: '1084', kind: 'invoice', id: '1009', date: '2026-12-10', lines: [['120', 60000, { customer: ACME }], ['400', -60000]] });

    for (const [company, kind] of cases) {
      before.set(`${company} ${kind}`, await one<PartyBalancesData>(db, 'SELECT gl_party_balances($1, $2) AS r', [company, kind]));
    }
    await db.exec('RESET ROLE');
    await db.exec(migration('503-books-party-balances-through.sql'));
    await db.exec(migration('503-books-party-balances-through.sql')); // must be safe to re-run
    await db.exec('SET ROLE service_role');
  }, 60_000);
  afterAll(async () => { await db?.close(); });

  const through = (kind: Kind, month: string | null, company = 'BMG') =>
    one<PartyBalancesData>(db, 'SELECT gl_party_balances_through($1, $2, $3::date) AS r', [company, kind, month]);
  const cents = (s: string | null) => (s === null ? null : toCents(s));
  /** Each party: who, its opening, what each side moved since, its documents and how many differ. */
  const brief = (data: PartyBalancesData) => data.parties.map((p) => [
    p.party, p.name, cents(p.opening), cents(p.netsuite), cents(p.fleetsuite), p.documents, p.differing,
  ]);

  it('answers as migration 406 did for the balances now, and so does every month at once', async () => {
    for (const [company, kind] of cases) {
      const was = before.get(`${company} ${kind}`)!;
      expect(await one(db, 'SELECT gl_party_balances($1, $2) AS r', [company, kind]), `${company} ${kind}`).toEqual(was);
      expect(await through(kind, null, company), `${company} ${kind}`).toEqual(was);
      expect(await through(kind, '2099-12-01', company), `${company} ${kind}`).toEqual(was);
    }
    // Something to compare: the answers aren't empty.
    expect(before.get('BMG customer')!.parties).toHaveLength(3);
  });

  it("counts NetSuite's lines in the month they posted to and FleetSuite's by date, through December", async () => {
    const dec = await through('customer', DEC);
    expect(dec.accounts).toEqual([{ netsuite_account_id: '120', number: '1200', name: 'Receivables' }]);
    expect(dec.opening).toEqual({ total: '800.00', named: '800.00', complete: true });
    expect(brief(dec)).toEqual([
      // Echo Express, whom FleetSuite's books can't name: its December invoice, the same on both sides.
      ['', null, 10000, 25000, 25000, 1, 0],
      // Acme: invoice 1006 at 450.00 on FleetSuite's side, its January replacement not yet; the January invoice not yet either.
      [ACME, 'Acme Fleet', 70000, 40000, 45000, 3, 1],
      // Bravo: FleetSuite's December 30 invoice, which NetSuite posted to January.
      [BRAVO, 'Bravo Transit', 0, 0, 30000, 1, 1],
    ]);
    expect(dec.parties[0].members?.map((m) => [m.entity_id, m.name, cents(m.opening), cents(m.netsuite)])).toEqual([
      ['9006', 'Echo Express', 10000, 25000],
    ]);
    expect(dec.parties[0].members_count).toBe(1);
    // Any day of December counts all of it.
    expect(await through('customer', '2026-12-15')).toEqual(dec);
    expect(await through('customer', '2026-12-31')).toEqual(dec);
  });

  it('takes in each month as it comes: January settles invoice 1006 and Bravo, and adds Acme\'s January invoice on NetSuite\'s side', async () => {
    expect(brief(await through('customer', JAN))).toEqual([
      ['', null, 10000, 25000, 25000, 1, 0],
      [ACME, 'Acme Fleet', 70000, 80000, 40000, 4, 1],
      [BRAVO, 'Bravo Transit', 0, 30000, 30000, 1, 0],
    ]);
    // November: what was owed before 2025 and Acme's November invoice. Bravo has nothing yet, so it isn't listed.
    expect(brief(await through('customer', NOV))).toEqual([
      ['', null, 10000, 0, 0, 0, 0],
      [ACME, 'Acme Fleet', 70000, 50000, 50000, 1, 0],
    ]);
    // Before 2025, the starting entry alone.
    expect(brief(await through('customer', '2024-12-01'))).toEqual([
      ['', null, 10000, 0, 0, 0, 0],
      [ACME, 'Acme Fleet', 70000, 0, 0, 0, 0],
    ]);
  });

  it("does the same for vendors, and keeps each company's own", async () => {
    expect(brief(await through('vendor', NOV))).toEqual([['7001', 'Landlord LLC', -30000, 0, 0, 0, 0]]);
    expect(brief(await through('vendor', DEC))).toEqual([['7001', 'Landlord LLC', -30000, -40000, -40000, 1, 0]]);
    expect(brief(await through('vendor', JAN))).toEqual([['7001', 'Landlord LLC', -30000, 0, 0, 2, 0]]);
    expect(brief(await through('customer', DEC, '1084'))).toEqual([[ACME, 'Acme Fleet', 0, 60000, 60000, 1, 0]]);
    expect((await through('customer', NOV, '1084')).parties).toEqual([]);
    expect((await through('vendor', DEC, '1084')).parties).toEqual([]);
    expect(await through('customer', DEC, 'NOPE')).toEqual({ accounts: expect.any(Array), opening: { total: '0', named: '0', complete: true }, parties: [] });
  });

  it('comes to the receivable and payable accounts through the month, as the trial balance counts them', async () => {
    for (const month of [NOV, DEC, JAN]) {
      for (const [kind, account] of [['customer', '120'], ['vendor', '200']] as const) {
        const found = await through(kind, month);
        const sum = (side: 'netsuite' | 'fleetsuite') => found.parties.reduce((total, p) => total + toCents(p.opening) + toCents(p[side]), 0);
        const ledger = await one<{ fleetsuite: string; netsuite: string }>(db, `
          SELECT jsonb_build_object(
            'fleetsuite', (SELECT coalesce(sum(debit - credit), 0) FROM gl_lines WHERE account_id = $1::uuid
                            AND company_id = (SELECT id FROM gl_companies WHERE code = 'BMG') AND entry_date < ($3::date + interval '1 month')),
            'netsuite', (SELECT coalesce(sum(debit - credit), 0) FROM gl_netsuite_lines WHERE netsuite_account_id = $2
                          AND company_id = (SELECT id FROM gl_companies WHERE code = 'BMG') AND posting_month <= $3::date)
          ) AS r`, [accountId(NS_ACCOUNT[account]), account, month]);
        const opening = toCents(found.opening.total);
        expect([month, kind, sum('fleetsuite'), sum('netsuite')]).toEqual([
          month, kind, opening + toCents(String(ledger.fleetsuite)), opening + toCents(String(ledger.netsuite)),
        ]);
      }
    }
  });

  it('is for the server alone', async () => {
    await db.exec('RESET ROLE');
    for (const fn of ['public.gl_party_balances_through(text, text, date)', 'public.gl_party_balances(text, text)']) {
      const can = async (role: string) => one<boolean>(db, `SELECT has_function_privilege($1, $2, 'EXECUTE') AS r`, [role, fn]);
      expect(await can('anon'), fn).toBe(false);
      expect(await can('authenticated'), fn).toBe(false);
      expect(await can('service_role'), fn).toBe(true);
    }
    await db.exec('SET ROLE service_role');
  });
});
