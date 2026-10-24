// Migration 431 keeps each likely mistake the nightly mistake checks find in
// the copies of NetSuite's bills, checks and card charges. This runs
// migrations 314, 359–363, 384 and 391 with 431 in an in-memory Postgres
// (PGlite) as the app's server login, copies a made-up year of bills and card
// charges the way the copies keep them, and runs the look
// (src/lib/books/mistake-checks.ts) against it the way the cron does, night
// after night, with a super admin clearing what it finds in between: what
// gl_mistake_docs hands the look, what gl_mistake_checks_save,
// gl_mistake_check_clear and gl_mistake_check_reopen keep, and what the page
// reads back.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  accountNamer, BOOKS_MISTAKE_CHECKS, mistakeView, runMistakeChecks, type MistakeDoc, type MistakeView,
} from './mistake-checks';
import { BOOKS_BILLS_SYNC } from './netsuite-bills';
import { BOOKS_SPENDING_SYNC } from './netsuite-spending';

/** Made-up vendors, by NetSuite's id; Harbor Hardware isn't in the copy of NetSuite's vendors list. */
const RIVERBEND = '640';
const LAKESIDE = '641';
const SUMMIT = '642';
const METRO = '643';
const HARBOR = '644';
/** Made-up accounts, by NetSuite's id: supplies, fuel, rent, and the stock and sales tax accounts of item and tax lines. */
const SUPPLIES = '6100';
const FUEL = '6420';
const RENT = '6800';
const STOCK = '1400';
const SALES_TAX = '2200';
/** A super admin, by FleetSuite user id. */
const CRAIG = '5d6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';

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
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '384-books-vendor-bills.sql',
    '391-books-checks-and-cards.sql', '431-books-mistake-checks.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES
      ('vendor', '${RIVERBEND}', 'Riverbend Tire', true),
      ('vendor', '${LAKESIDE}', 'Lakeside Supply', true),
      ('vendor', '${SUMMIT}', 'Summit Office Leasing', true),
      ('vendor', '${METRO}', 'Metro Fuel Services', true);
    INSERT INTO gl_accounts (number, name, account_type, netsuite_account_id) VALUES
      ('6100', 'Supplies', 'expense', '${SUPPLIES}'),
      ('6420', 'Fuel', 'expense', '${FUEL}'),
      ('6800', 'Rent', 'expense', '${RENT}');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const call = <T>(pg: PGlite, fn: string, p: unknown) => one<T>(pg, `SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)]);
const mm = (m: number) => String(m).padStart(2, '0');

/** A bill as the copy of NetSuite's bills hands it over, its one line an expense line coded to the account. */
const bill = (id: string, number: string | null, date: string, vendor: string, total: string, account: string, over: Record<string, unknown> = {}) => ({
  netsuite_id: id, tran_type: 'VendBill', tranid: number, trandate: date, vendor_netsuite_id: vendor, vendor_name: `Vendor ${vendor}`,
  total, voided: false, lines: [{ line_id: '1', item: null, account, amount: total, quantity: null, memo: null, tax: false }], ...over,
});
/** A card charge as the copy of NetSuite's checks and card charges hands it over. */
const cardCharge = (id: string, date: string, payee: string, total: string, account: string) => ({
  netsuite_id: id, tran_type: 'CardChrg', tranid: null, trandate: date, payee_netsuite_id: payee, payee_name: `Payee ${payee}`,
  total, voided: false, lines: [{ line_id: '1', item: null, account, amount: total, own_amount: total, quantity: null, memo: null, tax: false }],
});

/** What NetSuite posted for a document, in the copy of its ledger: all of it to one company. */
async function inLedger(pg: PGlite, id: string, date: string, company: string, account: string, total: string) {
  const month = `${date.slice(0, 7)}-01`;
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, 'VendBill', $1, $2, $3, 'x', 's')`,
    [id, date, month],
  );
  await pg.query(
    `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
     SELECT $1, '1', id, $2, $3, $4, $5, '0' FROM gl_companies WHERE code = $6`,
    [id, account, month, date, total, company],
  );
}

interface Item {
  id: string; key: string; kind: string; company: string; party_name: string | null; amount: string | null; state: string;
  cleared_how: string | null; cleared_by: string | null; cleared_note: string | null; why: string; gone_why: string | null;
  learned: boolean; back: boolean;
}

describe('migration 431: mistake checks', () => {
  let pg: PGlite;
  const store = new Map<string, Record<string, unknown>>();
  /** A function or table that fails when the look asks for it. */
  let failing: string | null = null;

  /** A read of one of the books' tables, built the way supabase-js builds it and answered the way PostgREST answers. */
  const read = (table: string) => {
    let columns = '*';
    const where: Array<[string, unknown]> = [];
    let order: string | null = null;
    let range: [number, number] | null = null;
    const run = async () => {
      if (failing === table) return { data: null, error: { message: `${table} failed` } };
      const r = await pg.query<{ r: Record<string, unknown> }>(
        `SELECT to_jsonb(t) AS r FROM (SELECT ${columns} FROM ${table}`
          + `${where.length ? ` WHERE ${where.map(([col], i) => `${col} = $${i + 1}`).join(' AND ')}` : ''}`
          + `${order ? ` ORDER BY ${order}` : ''}${range ? ` LIMIT ${range[1] - range[0] + 1} OFFSET ${range[0]}` : ''}) t`,
        where.map(([, value]) => value),
      );
      return { data: r.rows.map((row) => row.r), error: null };
    };
    const query: any = {
      select: (cols: string) => { columns = cols; return query; },
      eq: (col: string, value: unknown) => { where.push([col, value]); return query; },
      order: (col: string) => { order = col; return query; },
      range: (from: number, to: number) => { range = [from, to]; return query; },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
    };
    return query;
  };

  // sync_state and cron_runs in memory; every other table and function the real one, called the way supabase-js calls it.
  const service = () => ({
    from: (table: string) => {
      if (table === 'sync_state') {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: async () => ({ data: store.get(key) ?? null, error: null }),
            }),
          }),
          upsert: async (row: Record<string, unknown>) => {
            const key = String(row.sync_type);
            store.set(key, { ...store.get(key), ...JSON.parse(JSON.stringify(row)) });
            return { error: null };
          },
        };
      }
      if (table === 'cron_runs') return { insert: async () => ({ error: null }) };
      return read(table);
    },
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      if (failing === fn) return { data: null, error: { message: `${fn} failed` } };
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

  /** The night's look on a day, as the cron runs it at 4:46 AM Central. */
  const night = (day: string) => runMistakeChecks(service(), { now: new Date(`${day}T09:46:00Z`) });
  const items = async () => (await pg.query<Item>(`
    SELECT m.id, m.key, m.kind, c.code AS company, m.party_name, m.amount::text AS amount, m.state, m.cleared_how,
           m.cleared_by::text AS cleared_by, m.cleared_note, m.why, m.gone_why, m.learned, m.back_at IS NOT NULL AS back
    FROM gl_mistake_checks m JOIN gl_companies c ON c.id = m.company_id
    ORDER BY m.key`)).rows;
  const item = async (key: string) => (await items()).find((i) => i.key === key)!;
  /** When the copies of NetSuite's bills and of its checks and card charges last had all of NetSuite's changes. */
  const copied = (bills: Date, spending = bills) => {
    store.set(BOOKS_BILLS_SYNC, { last_synced_at: bills.toISOString(), updated_at: bills.toISOString() });
    store.set(BOOKS_SPENDING_SYNC, { last_synced_at: spending.toISOString(), updated_at: spending.toISOString() });
  };

  beforeAll(async () => {
    pg = await freshDb();
    const months = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const fuel = ['610.00', '905.00', '700.00', '655.00', '780.00', '820.00', '690.00', '745.00', '860.00'];
    await call(pg, 'gl_netsuite_bills_apply', {
      rows: [
        // Riverbend's October bill, entered twice with its number typed two ways, once more since gone from NetSuite,
        // and once more voided; and a bill entered twice in June, before the check looks.
        bill('8001', 'INV-20931', '2026-10-03', RIVERBEND, '412.50', SUPPLIES),
        bill('8002', 'inv 20931', '2026-10-09', RIVERBEND, '412.50', SUPPLIES),
        bill('8003', 'INV-20931', '2026-10-15', RIVERBEND, '412.50', SUPPLIES),
        bill('8004', 'INV-20931', '2026-10-16', RIVERBEND, '412.50', SUPPLIES, { voided: true }),
        bill('7991', 'INV-100', '2026-06-01', RIVERBEND, '50.00', SUPPLIES),
        bill('7992', 'INV-100', '2026-06-04', RIVERBEND, '50.00', SUPPLIES),
        // Summit's rent to 1084 on the 3rd of each month, to September.
        ...months.map((m) => bill(`82${mm(m)}`, `SOL-${mm(m)}`, `2026-${mm(m)}-03`, SUMMIT, '1850.00', RENT)),
        // Metro's fuel each month, then October's coded to rent.
        ...months.map((m, i) => bill(`83${mm(m)}`, `MF-${mm(m)}`, `2026-${mm(m)}-06`, METRO, fuel[i], FUEL)),
        bill('8310', 'MF-10', '2026-10-06', METRO, '702.40', RENT),
        // Harbor's bills: one with an item line, a tax line and two expense lines, and one whose lines weren't read.
        bill('8501', 'H-1', '2026-08-20', HARBOR, '96.30', SUPPLIES, {
          lines: [
            { line_id: '1', item: '9001', account: STOCK, amount: '40.00', quantity: 2, memo: null, tax: false },
            { line_id: '2', item: null, account: SUPPLIES, amount: '30.00', quantity: null, memo: null, tax: false },
            { line_id: '3', item: null, account: FUEL, amount: '20.00', quantity: null, memo: null, tax: false },
            { line_id: '4', item: null, account: SUPPLIES, amount: '0.00', quantity: null, memo: null, tax: false },
            { line_id: '5', item: null, account: SALES_TAX, amount: '6.30', quantity: null, memo: null, tax: true },
          ],
        }),
        (({ lines: _lines, ...rest }) => rest)(bill('8502', 'H-2', '2026-08-21', HARBOR, '18.00', SUPPLIES)),
      ],
    });
    await call(pg, 'gl_netsuite_spending_apply', {
      rows: [
        // Lakeside's $89.90 each month, but $899.00 in September.
        ...[1, 2, 3, 4, 5, 6, 7, 8].map((m) => cardCharge(`81${mm(m)}`, `2026-${mm(m)}-12`, LAKESIDE, '89.90', SUPPLIES)),
        cardCharge('8109', '2026-09-12', LAKESIDE, '899.00', SUPPLIES),
        cardCharge('8110', '2026-10-12', LAKESIDE, '89.90', SUPPLIES),
        // The same again, since gone from NetSuite.
        cardCharge('8111', '2026-10-12', LAKESIDE, '89.90', SUPPLIES),
      ],
    });
    for (const m of months) await inLedger(pg, `82${mm(m)}`, `2026-${mm(m)}-03`, '1084', RENT, '1850.00');
    await pg.exec(`
      RESET ROLE;
      UPDATE gl_netsuite_bills SET gone_at = now() WHERE netsuite_id = '8003';
      UPDATE gl_netsuite_spending SET gone_at = now() WHERE netsuite_id = '8111';
      SET ROLE service_role;
    `);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('hands the look the bills, checks and card charges NetSuite still has, each with its companies and expense accounts', async () => {
    const october = await one<MistakeDoc[]>(pg, `SELECT gl_mistake_docs('2026-10-01', '2026-11-01') AS r`);
    // Oldest first; the bill and the card charge gone from NetSuite left out, the voided bill in, marked.
    expect(october.map((d) => [d.netsuite_id, d.voided])).toEqual([
      ['8001', false], ['8310', false], ['8002', false], ['8110', false], ['8004', true],
    ]);
    expect(october[0]).toEqual({
      netsuite_id: '8001', type: 'VendBill', number: 'INV-20931', date: '2026-10-03', party: RIVERBEND, name: 'Riverbend Tire',
      total: '412.50', voided: false, companies: [], accounts: [SUPPLIES], lines_known: true,
    });
    expect(october[3]).toMatchObject({ type: 'CardChrg', number: null, party: LAKESIDE, name: 'Lakeside Supply', total: '89.90' });

    const [rent] = await one<MistakeDoc[]>(pg, `SELECT gl_mistake_docs('2026-09-03', '2026-09-04') AS r`);
    expect(rent).toMatchObject({ netsuite_id: '8209', companies: ['1084'], accounts: [RENT] });

    // Item and tax lines' accounts left out, each account once; the copy's name for a vendor the list doesn't have.
    const harbor = await one<MistakeDoc[]>(pg, `SELECT gl_mistake_docs('2026-08-20', '2026-08-22') AS r`);
    expect(harbor.map((d) => [d.netsuite_id, d.name, d.accounts, d.lines_known])).toEqual([
      ['8501', 'Vendor 644', [SUPPLIES, FUEL], true],
      ['8502', 'Vendor 644', [], false],
    ]);
    expect(await one(pg, `SELECT gl_mistake_docs('2027-01-01', '2027-02-01') AS r`)).toEqual([]);
  });

  it("keeps what the first night's look finds, each open, with why", async () => {
    const result = await night('2026-10-24');
    expect(result).toMatchObject({ docs: 36, found: 4, added: 4, back: 0, gone: 0, heartbeat: { ok: true } });
    expect(result.error).toBeUndefined();
    expect(store.get(BOOKS_MISTAKE_CHECKS)?.last_result).toEqual({ docs: 36, found: 4, added: 4, back: 0, gone: 0 });

    const kept = await items();
    expect(kept.map((i) => [i.key, i.company, i.party_name, i.amount, i.state])).toEqual([
      ['far_off:8109', 'BMG', 'Lakeside Supply', '899.00', 'open'],
      ['missing:1084:642:2026-10', '1084', 'Summit Office Leasing', '1850.00', 'open'],
      ['odd_account:8310', 'BMG', 'Metro Fuel Services', '702.40', 'open'],
      ['twice:8001+8002', 'BMG', 'Riverbend Tire', '412.50', 'open'],
    ]);
    expect(kept.map((i) => i.why)).toEqual([
      'Their last 8 card charges were $89.90 each. This one is ten times that, which can be a slipped decimal point.',
      "Billed every month since January 2026, usually around the 3rd. Nothing for October yet, and it's the 24th.",
      'Coded to 6800 Rent. Their 9 earlier bills all went to 6420 Fuel.',
      'Two bills with the same amount and the same invoice number, INV-20931: one dated Oct 3, the other Oct 9.',
    ]);

    // The next night finds the same and adds nothing.
    expect(await night('2026-10-24')).toMatchObject({ found: 4, added: 0, back: 0, gone: 0 });
    expect((await items()).map((i) => i.id)).toEqual(kept.map((i) => i.id));
  });

  it("leaves what a super admin cleared, brings back what they said was fixed when the copies made since still show it, and clears on its own what's no longer so", async () => {
    const [farOff, missing, odd, twice] = (await items()).map((i) => i.id);
    expect(await call(pg, 'gl_mistake_check_clear', { id: twice, how: 'fixed', note: '  Voided the second one.  ', by: CRAIG }))
      .toEqual({ id: twice, how: 'fixed', learned: false });
    // Nothing to learn from one far off its usual.
    expect(await call(pg, 'gl_mistake_check_clear', { id: farOff, how: 'fine', note: '  A one-time order.  ', learn: true, by: CRAIG }))
      .toEqual({ id: farOff, how: 'fine', learned: false });
    expect(await call(pg, 'gl_mistake_check_clear', { id: odd, how: 'fine', learn: true, by: CRAIG }))
      .toEqual({ id: odd, how: 'fine', learned: true });

    // A look before both copies have run again leaves the one said to be fixed alone: the copies have only what NetSuite
    // had by the older of the two.
    copied(new Date(Date.now() + 3_600_000), new Date(Date.now() - 3_600_000));
    expect(await night('2026-10-24')).toMatchObject({ found: 3, added: 0, back: 0, gone: 0 });
    expect(await item('twice:8001+8002')).toMatchObject({ state: 'cleared', cleared_how: 'fixed' });

    // The copies ran since, the duplicate still there, and Summit's October rent came.
    copied(new Date(Date.now() + 3_600_000));
    await call(pg, 'gl_netsuite_bills_apply', { rows: [bill('8210', 'SOL-10', '2026-10-20', SUMMIT, '1850.00', RENT)] });
    await inLedger(pg, '8210', '2026-10-20', '1084', RENT, '1850.00');
    expect(await night('2026-10-25')).toMatchObject({ found: 2, added: 0, back: 1, gone: 1 });

    expect(await item('twice:8001+8002')).toMatchObject({
      id: twice, state: 'open', cleared_how: null, cleared_by: null, cleared_note: null, back: true,
    });
    expect(await item('far_off:8109')).toMatchObject({
      id: farOff, state: 'cleared', cleared_how: 'fine', cleared_by: CRAIG, cleared_note: 'A one-time order.', back: false,
    });
    expect(await item('odd_account:8310')).toMatchObject({ id: odd, state: 'cleared', cleared_how: 'fine', learned: true });
    expect(await item('missing:1084:642:2026-10')).toMatchObject({
      id: missing, state: 'cleared', cleared_how: 'gone', cleared_by: null, gone_why: 'The October bill came in, dated the 20th.',
    });
  });

  it('clears on its own one whose document NetSuite voided, saying so', async () => {
    await call(pg, 'gl_netsuite_bills_apply', { rows: [bill('8002', 'inv 20931', '2026-10-09', RIVERBEND, '412.50', SUPPLIES, { voided: true })] });
    expect(await night('2026-10-26')).toMatchObject({ found: 1, added: 0, back: 0, gone: 1 });
    expect(await item('twice:8001+8002')).toMatchObject({
      state: 'cleared', cleared_how: 'gone', gone_why: 'Bill inv 20931, Oct 9 was voided in NetSuite.',
    });
  });

  it('opens one again, unlearning what clearing it taught, so the next look finds it again', async () => {
    const odd = (await item('odd_account:8310')).id;
    const missing = (await item('missing:1084:642:2026-10')).id;
    expect(await call(pg, 'gl_mistake_check_reopen', { id: odd })).toEqual({ id: odd });
    expect(await call(pg, 'gl_mistake_check_reopen', { id: missing })).toEqual({ id: missing });
    expect(await item('odd_account:8310')).toMatchObject({ state: 'open', cleared_how: null, cleared_by: null, learned: false, back: false });

    expect(await night('2026-10-27')).toMatchObject({ found: 2, added: 0, back: 0, gone: 1 });
    expect(await item('odd_account:8310')).toMatchObject({ state: 'open', why: 'Coded to 6800 Rent. Their 9 earlier bills all went to 6420 Fuel.' });
    // October's rent still came, so the missing one clears on its own again.
    expect(await item('missing:1084:642:2026-10')).toMatchObject({ state: 'cleared', cleared_how: 'gone' });
  });

  it("learns nothing from one cleared as fine without being told to, so the look still finds it, and leaves it cleared", async () => {
    const odd = (await item('odd_account:8310')).id;
    expect(await call(pg, 'gl_mistake_check_clear', { id: odd, how: 'fine', note: '   ' })).toEqual({ id: odd, how: 'fine', learned: false });
    expect(await night('2026-10-27')).toMatchObject({ found: 2, added: 0, back: 0, gone: 0 });
    expect(await item('odd_account:8310')).toMatchObject({ state: 'cleared', cleared_how: 'fine', cleared_note: null, learned: false });
    expect(await call(pg, 'gl_mistake_check_reopen', { id: odd })).toEqual({ id: odd });
  });

  it('reads back for the page the way the page reads it', async () => {
    const { data } = await read('gl_mistake_checks')
      .select('id, key, kind, company_id, party_netsuite_id, party_name, doc_date, amount, strength, why, docs, learn, state, '
        + 'cleared_how, cleared_by, cleared_at, cleared_note, gone_why, learned, back_at, found_at')
      .order('id')
      .range(0, 999);
    const companies = new Map((await pg.query<{ id: string; code: string }>('SELECT id, code FROM gl_companies')).rows.map((c) => [c.id, c.code]));
    const accounts = (await pg.query<{ netsuite_account_id: string; number: string; name: string }>(
      'SELECT netsuite_account_id, number, name FROM gl_accounts',
    )).rows;
    const views = (data as Array<Record<string, any>>).map((row) => mistakeView(row, {
      companyCode: (id) => (companies.get(id) as 'BMG' | '1084' | undefined) ?? null,
      accountName: accountNamer(accounts),
      names: new Map([[CRAIG, 'Craig']]),
      link: (type, id) => `https://netsuite.example/${type}/${id}`,
    })).filter((v): v is MistakeView => v !== null);
    const view = (kind: string) => views.find((v) => v.kind === kind)!;

    expect(views).toHaveLength(4);
    expect(view('odd_account')).toMatchObject({
      company: 'BMG', party: 'Metro Fuel Services', date: '2026-10-06', cents: 70240, state: 'open', by: null, backAt: null,
      docs: [{ label: 'Bill MF-10, Oct 6', url: 'https://netsuite.example/VendBill/8310' }],
      learnText: "Fine for Metro Fuel Services from now on: don't flag 6800 Rent for them again",
    });
    expect(view('far_off')).toMatchObject({ state: 'cleared', how: 'fine', by: 'Craig', note: 'A one-time order.', cents: 89900 });
    expect(view('missing')).toMatchObject({
      company: '1084', date: '2026-10-01', cents: 185000, how: 'gone', goneWhy: 'The October bill came in, dated the 20th.',
      docs: [{ label: 'Last: Bill SOL-09, Sep 3', url: 'https://netsuite.example/VendBill/8209' }],
    });
    expect(view('twice').docs.map((d) => d.label)).toEqual(['Bill INV-20931, Oct 3', 'Bill inv 20931, Oct 9']);
  });

  it("refuses to clear what's cleared, open what's open, or clear another way", async () => {
    const farOff = (await item('far_off:8109')).id;
    const odd = (await item('odd_account:8310')).id;
    const before = await items();
    await expect(call(pg, 'gl_mistake_check_clear', { id: farOff, how: 'fine' })).rejects.toThrow("gl: it's already cleared");
    await expect(call(pg, 'gl_mistake_check_reopen', { id: odd })).rejects.toThrow("gl: it's already open");
    await expect(call(pg, 'gl_mistake_check_clear', { id: odd, how: 'gone' })).rejects.toThrow('gl: a mistake clears as fixed or fine');
    await expect(call(pg, 'gl_mistake_check_clear', { id: odd, how: 'fixed', by: 'craig' })).rejects.toThrow("gl: who cleared it isn't a user");
    await expect(call(pg, 'gl_mistake_check_clear', { id: CRAIG, how: 'fixed' })).rejects.toThrow("gl: there's no such mistake to clear");
    await expect(call(pg, 'gl_mistake_check_reopen', { id: 'x' })).rejects.toThrow("gl: there's no such mistake to open again");
    expect(await items()).toEqual(before);
  });

  it("refuses a look it can't keep, keeping none of it", async () => {
    const before = await items();
    const ok = { key: 'far_off:9999', kind: 'far_off', company: 'BMG', date: '2026-10-01', why: 'Why.', docs: [] };
    await expect(call(pg, 'gl_mistake_checks_save', { found: {} })).rejects.toThrow('gl: found must be a list');
    await expect(call(pg, 'gl_mistake_checks_save', { found: [], gone: {} })).rejects.toThrow('gl: gone must be a list');
    await expect(call(pg, 'gl_mistake_checks_save', { found: [ok, ok] })).rejects.toThrow('gl: far_off:9999 is in the look twice');
    for (const bad of [
      { ...ok, kind: 'odd' }, { ...ok, key: 'twice:9999' }, { ...ok, key: 'far_off:' }, { ...ok, company: '1085' },
      { ...ok, why: ' ' }, { ...ok, party: 'acme' }, { ...ok, docs: {} }, { ...ok, date: '' }, { ...ok, learn: [] },
    ]) {
      await expect(call(pg, 'gl_mistake_checks_save', { found: [bad] })).rejects.toThrow(/isn't a mistake the check can keep/);
    }
    expect(await items()).toEqual(before);
  });

  it('keeps to its own rules when written to directly', async () => {
    const twice = (await item('twice:8001+8002')).id;
    const farOff = (await item('far_off:8109')).id;
    await expect(pg.query(`INSERT INTO gl_mistake_checks (key, kind, company_id, doc_date, why)
      SELECT 'twice', 'twice', id, '2026-10-01', 'Why.' FROM gl_companies WHERE code = 'BMG'`)).rejects.toThrow(/check constraint/);
    await expect(pg.query(`INSERT INTO gl_mistake_checks (key, kind, company_id, doc_date, why)
      SELECT 'far_off:1', 'twice', id, '2026-10-01', 'Why.' FROM gl_companies WHERE code = 'BMG'`)).rejects.toThrow(/check constraint/);
    // Learned only when cleared as fine with something to learn; cleared with a time; a clearer only for a super admin's clear.
    await expect(pg.query('UPDATE gl_mistake_checks SET learned = true WHERE id = $1', [farOff])).rejects.toThrow(/check constraint/);
    await expect(pg.query('UPDATE gl_mistake_checks SET cleared_at = NULL WHERE id = $1', [farOff])).rejects.toThrow(/check constraint/);
    await expect(pg.query('UPDATE gl_mistake_checks SET cleared_by = $2 WHERE id = $1', [twice, CRAIG])).rejects.toThrow(/check constraint/);
    await expect(pg.query(`UPDATE gl_mistake_checks SET why = ' ' WHERE id = $1`, [twice])).rejects.toThrow(/check constraint/);
  });

  it("says why when it couldn't look, and keeps what it had", async () => {
    const before = await items();
    const lastGood = store.get(BOOKS_MISTAKE_CHECKS)?.last_synced_at;
    for (const [what, error] of [
      ['gl_mistake_docs', 'reading the copied documents from January 2025: gl_mistake_docs failed'],
      ['gl_mistake_checks', 'gl_mistake_checks failed'],
      ['gl_mistake_checks_save', 'saving what it found: gl_mistake_checks_save failed'],
    ]) {
      failing = what;
      try {
        const result = await night('2026-10-28');
        expect(result.error).toBe(error);
        expect(store.get(BOOKS_MISTAKE_CHECKS)?.last_result).toMatchObject({ error });
        expect(store.get(BOOKS_MISTAKE_CHECKS)?.last_synced_at).toBe(lastGood);
        expect(await items()).toEqual(before);
      } finally {
        failing = null;
      }
    }
  });

  it("clears on its own one a look didn't find, saying so even when the look gave no why", async () => {
    expect(await item('odd_account:8310')).toMatchObject({ state: 'open' });
    expect(await call(pg, 'gl_mistake_checks_save', { found: [], gone: [{ key: 'odd_account:8310', why: ' ' }] }))
      .toEqual({ found: 0, added: 0, back: 0, gone: 1 });
    expect(await item('odd_account:8310')).toMatchObject({
      state: 'cleared', cleared_how: 'gone', gone_why: 'The copies of NetSuite no longer show it.',
    });
  });

  it("is the server's alone: the app's logins can't read or write it", async () => {
    await pg.exec('RESET ROLE');
    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`SET ROLE ${role}`);
      // Each refused for itself: a function the table's refusal would also stop is still closed on its own.
      await expect(pg.query('SELECT * FROM gl_mistake_checks')).rejects.toThrow(/permission denied for table gl_mistake_checks/);
      await expect(pg.query(`SELECT gl_mistake_docs('2026-10-01', '2026-11-01')`)).rejects.toThrow(/permission denied for function gl_mistake_docs/);
      await expect(pg.query(`SELECT gl_mistake_checks_save('{"found": []}'::jsonb)`))
        .rejects.toThrow(/permission denied for function gl_mistake_checks_save/);
      await expect(pg.query(`SELECT gl_mistake_check_clear('{}'::jsonb)`)).rejects.toThrow(/permission denied for function gl_mistake_check_clear/);
      await expect(pg.query(`SELECT gl_mistake_check_reopen('{}'::jsonb)`)).rejects.toThrow(/permission denied for function gl_mistake_check_reopen/);
      await pg.exec('RESET ROLE');
    }
    await pg.exec('SET ROLE service_role');
  });
});
