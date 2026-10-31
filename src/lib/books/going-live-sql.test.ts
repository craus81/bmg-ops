// Migration 476 has each customer's and vendor's balance through a day on the
// receivable and payable accounts, both sides, and lists the opening entries
// a company's books have; src/lib/books/going-live.ts posts the opening
// entry with them once the books are live. This runs migrations 314,
// 359–363, 387, 396, 406 and 407 with 476 in an in-memory Postgres (PGlite)
// as the app's server login, copies a made-up NetSuite general ledger with
// FleetSuite's own journal differing from it, then goes live: the opening
// entry posts customer by customer and vendor by vendor, the books and every
// balance then match NetSuite's, nothing else dated before the live date
// posts, a change NetSuite makes to the day after trues them up again, and
// the live date stays.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({ isSuiteqlError: () => false, suiteqlQuery: vi.fn(), suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { postOpeningEntries, readChart, readOpeningEntries, readOpeningParties, readTotals, withCompanies } from './going-live';
import { workOutOpeningEntry } from './opening-balances';
import { partyBalances, type PartyBalancesData } from './party-balances';

const JUN25 = '2025-06-01';
const NOV = '2026-11-01';
const DEC = '2026-12-01';
const LIVE_FROM = '2027-01-01';

/** Made-up chart, keyed by NetSuite id. */
const ACCOUNTS: Array<[string, string, string, string]> = [
  ['110', '1100', 'Checking', 'bank'],
  ['120', '1200', 'Receivables', 'accounts_receivable'],
  ['200', '2000', 'Payables', 'accounts_payable'],
  ['300', '3000', 'Retained Earnings', 'equity'],
  ['400', '4000', 'Sales', 'income'],
  ['600', '6000', 'Rent', 'expense'],
];
const accountId = (number: string) => `a0000000-0000-4000-8000-00000000${number}`;
const NS_ACCOUNT: Record<string, string> = Object.fromEntries(ACCOUNTS.map(([ns, number]) => [ns, number]));

/** FleetSuite's customers, Acme and Bravo, both of whom the ledger mirror matched; Charlie Cab it hasn't. */
const ACME = 'c0000000-0000-4000-8000-00000000000a';
const BRAVO = 'c0000000-0000-4000-8000-00000000000b';

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
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '387-books-retired-accounts.sql',
    '396-books-reports.sql', '406-books-party-balances.sql', '407-books-own-invoices.sql', '476-books-going-live.sql',
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
  // Bravo's name is blank in FleetSuite, so the first of its NetSuite names stands in. Charlie Cab is only a maybe for
  // Acme, which the books don't take, so its balance is no customer's.
  await pg.query(`INSERT INTO customers (id, company_name) VALUES ($1, 'Acme Fleet'), ($2, '  ')`, [ACME, BRAVO]);
  await pg.query(`
    INSERT INTO ledger_customers (source, external_id, external_ref, display_name, cleaned_name, match_status, customer_id) VALUES
      ('netsuite', 'customer/9001', '9001', 'Acme Fleet Services', 'acme fleet services', 'exact', $1),
      ('netsuite', 'customer/9002', '9002', 'Bravo Transit', 'bravo transit', 'exact', $2),
      ('netsuite', 'customer/9004', '9004', 'Charlie Cab', 'charlie cab', 'ambiguous', $1),
      ('netsuite', 'customer/9005', '9005', 'Bravo Transit (old)', 'bravo transit old', 'exact', $2)
  `, [ACME, BRAVO]);
  await pg.exec(`INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES ('vendor', '7001', 'Landlord LLC', true)`);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;

type CopyLine = [line: string, company: string, account: string, cents: number, entity?: string];

/** A NetSuite transaction as the GL copy keeps it; lines are [line id, company, account, cents debit positive, name]. */
async function copyTxn(pg: PGlite, id: string, type: string, date: string, month: string, lines: CopyLine[]) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [id, type, `${type}${id}`, date, month],
  );
  for (const [line, company, account, cents, entity] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, entity_id)
       SELECT $1, $2, id, $3, $4, $5, $6, $7, $8 FROM gl_companies WHERE code = $9`,
      [id, line, account, month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0', entity ?? null, company],
    );
  }
}

/** NetSuite's own totals as the copy stores them: the starting entry, and every month's as the copied lines add up. */
async function storeTotals(pg: PGlite) {
  const months = (await pg.query<Record<string, unknown>>(`
    SELECT c.code AS company, l.netsuite_account_id, to_char(l.posting_month, 'YYYY-MM-DD') AS month,
           sum(l.debit)::text AS debit, sum(l.credit)::text AS credit, count(*)::int AS line_count
    FROM gl_netsuite_lines l JOIN gl_companies c ON c.id = l.company_id
    GROUP BY 1, 2, 3
  `)).rows;
  const opening = [
    { company: 'BMG', netsuite_account_id: '110', debit: '1000.00', credit: '0', line_count: 1 },
    { company: 'BMG', netsuite_account_id: '300', debit: '0', credit: '1000.00', line_count: 1 },
  ];
  await pg.query('SELECT gl_netsuite_store_totals($1::jsonb)', [JSON.stringify({ opening, months })]);
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

describe("migration 476 and going live", () => {
  let db: PGlite;
  /** The last copy of NetSuite's ledger, as sync_state keeps it. */
  let copy: { last_result: unknown; last_synced_at: string | null; updated_at: string } | null = null;

  // sync_state in memory; gl_accounts and every function the real one, called the way supabase-js calls them.
  const service: any = {
    from: (table: string) => {
      if (table === 'sync_state') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: copy, error: null }) }) }) };
      if (table === 'gl_accounts') {
        return {
          select: (cols: string) => ({
            order: (col: string) => ({
              range: async (from: number, to: number) => ({
                data: (await db.query(`SELECT ${cols} FROM gl_accounts ORDER BY ${col} LIMIT ${to - from + 1} OFFSET ${from}`)).rows,
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      const names = Object.keys(args);
      try {
        const r = await db.query<{ r: unknown }>(
          `SELECT ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) AS r`,
          names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n])),
        );
        return { data: r.rows[0].r, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    },
  };
  const codeOf = async () => new Map((await db.query<{ id: string; code: string }>('SELECT id, code FROM gl_companies')).rows.map((c) => [c.id, c.code]));
  /** The opening entry for December 31, 2026 as Going live works it out now. */
  const entryNow = async (today = '2027-01-02') => {
    const { data, journal } = await readTotals(service, 'BMG', withCompanies(await readChart(service), await codeOf()));
    return workOutOpeningEntry(data, journal, DEC, today, await readOpeningParties(service, 'BMG', '2026-12-31'));
  };
  const goLive = async (today: string) => postOpeningEntries(service, { today, live: [{ code: 'BMG', liveFrom: LIVE_FROM }], codeOf: await codeOf() });
  const balances = async (kind: 'customer' | 'vendor') =>
    partyBalances(await one<PartyBalancesData>(db, 'SELECT gl_party_balances($1, $2) AS r', ['BMG', kind]), kind).parties;

  beforeAll(async () => {
    db = await freshDb();

    // NetSuite's general ledger: a cash sale in 2025; Acme's payment in November 2026; December's invoices for Acme,
    // Bravo and Charlie Cab, and the landlord's bill; and an invoice of 1084's for Acme.
    await copyTxn(db, '1000', 'CashSale', '2025-06-12', JUN25, [['0', 'BMG', '110', 25000], ['1', 'BMG', '400', -25000]]);
    await copyTxn(db, '2001', 'CustPymt', '2026-11-20', NOV, [['0', 'BMG', '110', 10000, '9001'], ['1', 'BMG', '120', -10000, '9001']]);
    await copyTxn(db, '1001', 'CustInvc', '2026-12-03', DEC, [['0', 'BMG', '120', 50000, '9001'], ['1', 'BMG', '400', -50000, '9001']]);
    await copyTxn(db, '1002', 'CustInvc', '2026-12-08', DEC, [['0', 'BMG', '120', 30000, '9002'], ['1', 'BMG', '400', -30000, '9002']]);
    await copyTxn(db, '1004', 'CustInvc', '2026-12-15', DEC, [['0', 'BMG', '120', 20000, '9004'], ['1', 'BMG', '400', -20000, '9004']]);
    await copyTxn(db, '4001', 'VendBill', '2026-12-01', DEC, [['0', 'BMG', '200', -40000, '7001'], ['1', 'BMG', '600', 40000, '7001']]);
    await copyTxn(db, '1006', 'CustInvc', '2026-12-10', DEC, [['0', '1084', '120', 60000, '9001'], ['1', '1084', '400', -60000, '9001']]);
    await storeTotals(db);

    // FleetSuite's books: the sale at 240.00; Acme's payment as NetSuite has it; Acme's invoice as Bravo's; Bravo's
    // invoice as NetSuite has it; nothing for Charlie Cab; and the landlord's bill at 450.00.
    await post(db, { kind: 'cash_sale', id: '1000', date: '2025-06-12', lines: [['110', 24000], ['400', -24000]] });
    await post(db, { kind: 'payment', id: '2001', date: '2026-11-20', lines: [['110', 10000], ['120', -10000, { customer: ACME }]] });
    await post(db, { kind: 'invoice', id: '1001', date: '2026-12-03', lines: [['120', 50000, { customer: BRAVO }], ['400', -50000]] });
    await post(db, { kind: 'invoice', id: '1002', date: '2026-12-08', lines: [['120', 30000, { customer: BRAVO }], ['400', -30000]] });
    await post(db, { kind: 'vendor_bill', id: '4001', date: '2026-12-01', lines: [['200', -45000, { vendor: '7001' }], ['600', 45000]] });
    await post(db, { company: '1084', kind: 'invoice', id: '1006', date: '2026-12-10', lines: [['120', 60000, { customer: ACME }], ['400', -60000]] });
  });
  afterAll(async () => { await db?.close(); });

  it("lists each customer's and vendor's balance through the day, both sides, where they differ", async () => {
    expect(await one(db, "SELECT gl_opening_parties('BMG', '2026-12-31') AS r")).toEqual({
      parties: [
        { account: '120', kind: 'customer', party: '', name: null, netsuite: '200.00', fleetsuite: '0' },
        { account: '120', kind: 'customer', party: ACME, name: 'Acme Fleet', netsuite: '400.00', fleetsuite: '-100.00' },
        { account: '120', kind: 'customer', party: BRAVO, name: 'Bravo Transit', netsuite: '300.00', fleetsuite: '800.00' },
        { account: '200', kind: 'vendor', party: '7001', name: 'Landlord LLC', netsuite: '-400.00', fleetsuite: '-450.00' },
      ],
    });
    // Through November, Acme's payment is the same on both sides, and December's documents don't count yet.
    expect(await one(db, "SELECT gl_opening_parties('BMG', '2026-11-30') AS r")).toEqual({ parties: [] });
    // 1084's invoice for Acme is its own.
    expect(await one(db, "SELECT gl_opening_parties('1084', '2026-12-31') AS r")).toEqual({ parties: [] });
    expect(await one(db, "SELECT gl_opening_parties('XYZ', '2026-12-31') AS r")).toEqual({ parties: [] });
  });

  it('is for the service role only', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`RESET ROLE; SET ROLE ${role}`);
      await expect(db.query("SELECT gl_opening_parties('BMG', '2026-12-31')")).rejects.toThrow(/permission denied for function/);
      await expect(db.query("SELECT gl_opening_entries('BMG')")).rejects.toThrow(/permission denied for function/);
    }
    await db.exec('RESET ROLE; SET ROLE service_role');
    expect(await one(db, "SELECT gl_opening_entries('BMG') AS r")).toEqual({ entries: [] });
  });

  it("works out the entry customer by customer and vendor by vendor", async () => {
    const entry = await entryNow();
    expect(entry.problems).toEqual([]);
    expect(entry.lines.map((l) => [l.number, l.cents, l.parties?.map((p) => [p.name, p.cents])])).toEqual([
      ['1100', 1000, undefined],
      ['1200', 20000, [[null, 20000], ['Acme Fleet', 50000], ['Bravo Transit', -50000]]],
      ['2000', 5000, [['Landlord LLC', 5000]]],
      ['3000', -1000, undefined],
      ['4000', -20000, undefined],
      ['6000', -5000, undefined],
    ]);
    expect(entry).toMatchObject({ debit: 76000, credit: 76000 });
  });

  it("posts nothing before the books are live, or before a whole copy since the day ended", async () => {
    expect(await postOpeningEntries(service, { today: '2027-01-02', live: [], codeOf: await codeOf() })).toEqual({ posted: 0, notes: [] });
    copy = { last_result: {}, last_synced_at: '2026-12-31T20:00:00Z', updated_at: '2027-01-01T04:00:00Z' };
    await db.exec(`UPDATE gl_companies SET books_live_from = '${LIVE_FROM}' WHERE code = 'BMG'`);
    expect(await goLive('2026-12-31')).toEqual({ posted: 0, notes: [] });
    expect(await goLive('2027-01-01')).toEqual({
      posted: 0,
      notes: ["BMG's opening entry for December 31, 2026 is waiting: No whole copy of NetSuite's ledger has been made since December 31, 2026 ended. Going live shows it."],
    });
    expect(await one(db, "SELECT gl_opening_entries('BMG') AS r")).toEqual({ entries: [] });
  });

  it("posts the opening entry once the books are live, and they then match NetSuite's, every balance too", async () => {
    copy = { last_result: {}, last_synced_at: '2027-01-01T08:00:00Z', updated_at: '2027-01-01T08:00:00Z' };
    expect(await goLive('2027-01-01')).toEqual({ posted: 1, notes: [] });

    const posted = await readOpeningEntries(service, 'BMG');
    expect(posted).toEqual([expect.objectContaining({
      date: '2026-12-31', memo: "Opening balances: NetSuite's on December 31, 2026", debit: 76000, lines: 8, reversedBy: null,
    })]);
    const lines = (await db.query(`
      SELECT a.number, l.debit::text AS debit, l.credit::text AS credit, l.customer_id, l.vendor_ref, l.memo, e.idempotency_key AS key
      FROM gl_lines l JOIN gl_accounts a ON a.id = l.account_id JOIN gl_entries e ON e.id = l.entry_id
      WHERE e.source_type = 'opening_balance' ORDER BY l.line_no
    `)).rows;
    expect(lines.map((l: any) => [l.number, l.debit, l.credit, l.customer_id, l.vendor_ref, l.memo])).toEqual([
      ['1100', '10.00', '0.00', null, null, null],
      ['1200', '200.00', '0.00', null, null, null],
      ['1200', '500.00', '0.00', ACME, null, 'Acme Fleet'],
      ['1200', '0.00', '500.00', BRAVO, null, 'Bravo Transit'],
      ['2000', '50.00', '0.00', null, '7001', 'Landlord LLC'],
      ['3000', '0.00', '10.00', null, null, null],
      ['4000', '0.00', '200.00', null, null, null],
      ['6000', '0.00', '50.00', null, null, null],
    ]);
    expect(new Set(lines.map((l: any) => l.key))).toEqual(new Set(['opening_balance:BMG:2027-01-01:1']));

    // Nothing differs on the day now, account by account or customer by customer, and every balance matches.
    expect(await entryNow()).toMatchObject({ lines: [], debit: 0, credit: 0, problems: [] });
    expect(await one(db, "SELECT gl_opening_parties('BMG', '2026-12-31') AS r")).toEqual({ parties: [] });
    for (const kind of ['customer', 'vendor'] as const) {
      const differ = (await balances(kind)).filter((p) => p.differs);
      expect(differ).toEqual([]);
    }
    // So the next run has nothing to post.
    expect(await goLive('2027-01-02')).toEqual({ posted: 0, notes: [] });
    expect(await readOpeningEntries(service, 'BMG')).toHaveLength(1);
  });

  it('takes nothing else dated before the books went live', async () => {
    await expect(post(db, { kind: 'manual', id: 'm1', date: '2026-12-31', lines: [['110', 100], ['600', -100]] }))
      .rejects.toThrow('is before BMG Fleet Installations went live');
    await expect(post(db, { kind: 'invoice', id: '1004', date: '2026-12-15', lines: [['120', 20000], ['400', -20000]] }))
      .rejects.toThrow('is before BMG Fleet Installations went live');
    // From the day they went live, as before; 1084's books aren't live.
    await post(db, { kind: 'manual', id: 'm2', date: '2027-01-04', lines: [['110', 100], ['600', -100]] });
    await post(db, { company: '1084', kind: 'manual', id: 'm3', date: '2026-12-31', lines: [['110', 100], ['600', -100]] });
  });

  it("trues the books up when NetSuite's numbers for the day change after", async () => {
    // The CPA's year-end adjustment: 20.00 more rent in December, and a change to Charlie Cab's invoice.
    await copyTxn(db, '9001', 'Journal', '2026-12-31', DEC, [['0', 'BMG', '600', 2000], ['1', 'BMG', '110', -2000]]);
    await db.exec(`UPDATE gl_netsuite_lines SET debit = 180.00 WHERE transaction_id = '1004' AND line_id = '0'`);
    await db.exec(`UPDATE gl_netsuite_lines SET credit = 180.00 WHERE transaction_id = '1004' AND line_id = '1'`);
    await storeTotals(db);
    expect((await entryNow()).lines.map((l) => [l.number, l.cents])).toEqual([['1100', -2000], ['1200', -2000], ['4000', 2000], ['6000', 2000]]);

    copy = { last_result: {}, last_synced_at: '2027-02-10T08:00:00Z', updated_at: '2027-02-10T08:00:00Z' };
    expect(await goLive('2027-02-10')).toEqual({ posted: 1, notes: [] });
    const posted = await readOpeningEntries(service, 'BMG');
    expect(posted.map((e) => [e.memo, e.debit, e.lines])).toEqual([
      ["Opening balances: NetSuite's on December 31, 2026", 76000, 8],
      ["Opening balances trued up: NetSuite's on December 31, 2026", 4000, 4],
    ]);
    expect(await one(db, "SELECT idempotency_key AS r FROM gl_entries WHERE id = $1", [posted[1].id])).toBe('opening_balance:BMG:2027-01-01:2');
    expect(await entryNow('2027-02-10')).toMatchObject({ lines: [], problems: [] });
    expect((await balances('customer')).filter((p) => p.differs)).toEqual([]);
  });

  it('lists an opening entry reversed since with the entry that reversed it', async () => {
    const [, trueUp] = await readOpeningEntries(service, 'BMG');
    // Not on its own day, as nothing but opening entries is dated before the books went live. Made up: undone on February 11.
    await expect(db.query('SELECT gl_reverse_entry($1, NULL, NULL, NULL, NULL)', [trueUp.id])).rejects.toThrow('is before BMG Fleet Installations went live');
    const reversal = await one<{ entry_no: number }>(db, "SELECT gl_reverse_entry($1, '2027-02-11', 'Made up', NULL, NULL) AS r", [trueUp.id]);
    expect((await readOpeningEntries(service, 'BMG')).map((e) => [e.entryNo, e.reversedBy])).toEqual([
      [expect.any(Number), null],
      [trueUp.entryNo, Number(reversal.entry_no)],
    ]);
  });

  it('keeps the live date, and the journal', async () => {
    await expect(db.exec(`UPDATE gl_companies SET books_live_from = '2027-02-01' WHERE code = 'BMG'`))
      .rejects.toThrow("went live on 2027-01-01, and that date can't change");
    await expect(db.exec(`UPDATE gl_companies SET books_live_from = NULL WHERE code = 'BMG'`)).rejects.toThrow("can't change");
    await expect(db.query('SELECT gl_reset_journal()')).rejects.toThrow();
  });
});
