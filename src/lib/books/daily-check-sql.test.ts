// The daily books check (src/lib/books/daily-check.ts) looks at both
// companies' books the way Differences vs NetSuite does, through migration
// 377's functions, at each item's count the way Stock by item does, through
// migration 401's, at each customer's and vendor's balance the way Customer
// and vendor balances does, through migration 406's, at FleetSuite's own
// invoices the way Own invoices does, through migration 407's, at its own
// fulfillments the way Own fulfillments does, through migration 416's, at the
// Inventory Adjusts the way Own adjustments does, through migration 457's, and
// at the likely mistakes the night's look kept, through migration 431's, and at
// what NetSuite has instead of FleetSuite's record of a customer or vendor,
// through migration 480's. This runs the same migrations as
// differences-sql.test.ts, with 401, 406, 407, 416, 431, 435, 454, 457, 477
// and 480, in an in-memory Postgres (PGlite) as the app's
// server login, copies a made-up handful of NetSuite documents for BMG and
// 1084, posts FleetSuite's entries for some of them, copies a few stock moves
// and NetSuite's counts, saves an own invoice, an own fulfillment, a few
// Inventory Adjusts and a few likely mistakes, and runs the check's looks
// against it the way the cron does, holding what it tells the super admins and
// what it records.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { BOOKS_DAILY_CHECK, runDailyCheck, type CheckAlert, type Look } from './daily-check';
import { BOOKS_INVOICE_POSTING } from './invoice-posting';
import { BOOKS_GL_SYNC } from './netsuite-gl';
import { BOOKS_STOCK_SYNC } from './netsuite-stock';

/** Made-up chart: '120' receivables, '210' payables, '400' sales, '220' sales tax, '110' undeposited funds, '600' rent. */
const ACCOUNTS: Array<[string, string, string]> = [
  ['120', 'Receivables', 'accounts_receivable'],
  ['210', 'Payables', 'accounts_payable'],
  ['400', 'Sales', 'income'],
  ['220', 'Sales Tax', 'other_current_liability'],
  ['110', 'Undeposited Funds', 'other_current_asset'],
  ['600', 'Rent', 'expense'],
];
const accountId = (ns: string) => `a0000000-0000-4000-8000-000000000${ns}`;
const DEC = '2025-12-01';
const AUG = '2026-08-01';
const SEP = '2026-09-01';
const OCT = '2026-10-01';

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
    -- What migrations 314, 416, 435 and 454 point at in the app's own schema.
    CREATE TABLE public.profiles (id UUID PRIMARY KEY, full_name TEXT);
    CREATE TABLE public.netsuite_parts (id UUID PRIMARY KEY);
    CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT false $$;
    CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT);
    CREATE TABLE public.netsuite_sales_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), netsuite_id TEXT NOT NULL UNIQUE, tranid TEXT,
      customer_netsuite_id TEXT, customer_name TEXT
    );
    CREATE TABLE public.vendor_invoices (id UUID PRIMARY KEY);
    CREATE TABLE public.payouts (id UUID PRIMARY KEY);
    CREATE TABLE public.po_receipts (id UUID PRIMARY KEY, ns_status TEXT);
    CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
    -- The books switches as migration 466 makes them, for migration 480 to add its piece to.
    CREATE TABLE public.books_switches (
      piece TEXT PRIMARY KEY CHECK (piece IN ('credit_memos')), is_on BOOLEAN NOT NULL DEFAULT false,
      changed_by UUID REFERENCES profiles(id) ON DELETE SET NULL, changed_at TIMESTAMPTZ
    );
  `);
  for (const file of [
    '314-ledger.sql', '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql', '364-books-invoice-check.sql',
    '367-books-invoice-posting.sql', '370-books-credit-memos.sql', '374-books-payment-check.sql', '376-books-payment-posting.sql',
    '377-books-differences.sql', '380-books-netsuite-month.sql', '382-books-customer-deposits.sql', '383-books-deposit-posting.sql',
    '384-books-vendor-bills.sql', '385-books-bill-item-accounts.sql', '386-books-bill-posting.sql', '387-books-retired-accounts.sql',
    '389-books-bill-payments.sql', '390-books-bill-payment-posting.sql', '391-books-checks-and-cards.sql', '392-books-spending-posting.sql',
    '393-books-journal-entries.sql', '394-books-bank-deposits.sql', '395-books-stock-cost.sql', '401-books-stock-by-item.sql',
    '402-books-stock-values.sql', '406-books-party-balances.sql', '407-books-own-invoices.sql', '416-books-own-fulfillments.sql',
    '431-books-mistake-checks.sql', '435-books-own-bills.sql', '454-inventory-adjustments.sql', '457-books-own-adjustments.sql',
    '477-netsuite-sends.sql', '480-fleetsuite-record-wins.sql',
  ]) {
    await pg.exec(readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8'));
  }
  await pg.exec(`UPDATE gl_companies SET netsuite_subsidiary_id = '5' WHERE code = '1084'`);
  for (const [ns, name, type] of ACCOUNTS) {
    await pg.query(
      `INSERT INTO gl_accounts (id, number, name, account_type, netsuite_account_id, active) VALUES ($1, $2, $3, $4, $5, true)`,
      [accountId(ns), `${ns}0`, name, type, ns],
    );
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);

/** A NetSuite transaction as the GL copy keeps it; lines are [line id, company, account, cents debit positive, NetSuite's id for its name]. */
async function copyTxn(pg: PGlite, id: string, type: string, date: string, month: string, lines: Array<[string, string, string, number, string?]>) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [id, type, `${type === 'CustInvc' ? 'INV' : 'JE'}${id}`, date, month],
  );
  for (const [line, company, account, cents, entity] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, entity_id)
       SELECT $1, $2, id, $3, $4, $5, $6, $7, $9 FROM gl_companies WHERE code = $8`,
      [id, line, account, month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0', company, entity ?? null],
    );
  }
}

/** An invoice as the ledger mirror keeps it. */
async function mirrorInvoice(pg: PGlite, id: string, date: string, customer: string) {
  await pg.query(
    `INSERT INTO ledger_invoices (source, external_id, external_ref, doc_type, doc_number, doc_date, total, voided, deleted_at, party_name)
     VALUES ('netsuite', $1, $2, 'invoice', $3, $4, 0, false, NULL, $5)`,
    [`CustInvc/${id}`, id, `INV${id}`, date, customer],
  );
}

/** A NetSuite invoice, in the GL copy and the ledger mirror: 120 debit, 400 credit, and 220 credit for any tax. */
async function invoice(pg: PGlite, id: string, date: string, month: string, cents: number, customer: string, company = 'BMG', tax = 0) {
  await copyTxn(pg, id, 'CustInvc', date, month, [
    ['0', company, '120', cents + tax], ['1', company, '400', -cents], ...(tax ? [['2', company, '220', -tax] as [string, string, string, number]] : []),
  ]);
  await mirrorInvoice(pg, id, date, customer);
}

/** FleetSuite's entry for a document; lines are [account, cents debit positive, the customer's FleetSuite id or the vendor's NetSuite id]. */
const post = (pg: PGlite, company: string, kind: string, id: string, date: string, lines: Array<[string, number, string?]>) => pg.query(
  'SELECT gl_post_entry($1::jsonb)',
  [JSON.stringify({
    company,
    entry_date: date,
    source_type: kind,
    source_id: id,
    posting_rule: `${kind}@1`,
    idempotency_key: `${company === 'BMG' ? '' : `${company}:`}${kind}:${id}:1`,
    lines: lines.map(([account, cents, party]) => ({
      account_id: accountId(account),
      [cents > 0 ? 'debit' : 'credit']: money(cents),
      ...(party ? (account === '210' ? { vendor_ref: party } : { customer_id: party }) : {}),
    })),
  })],
);

describe('the daily books check', () => {
  let pg: PGlite;
  const store = new Map<string, { last_result: unknown; updated_at: string; last_synced_at?: string }>();
  /** When a function or a read of a table fails, by what it was asked (a read's `where`). */
  let failing: ((fn: string, args: Record<string, unknown>) => boolean) | null = null;
  /**
   * What a look told about months and stock; about balances, own invoices, fulfillments, bills, receipts and adjustments, likely mistakes,
   * sends to NetSuite and changes in NetSuite, apart.
   */
  let told: CheckAlert[] = [];
  let toldBalances: CheckAlert[] = [];
  let toldOwn: CheckAlert[] = [];
  let toldFulfillments: CheckAlert[] = [];
  let toldBills: CheckAlert[] = [];
  let toldReceipts: CheckAlert[] = [];
  let toldAdjustments: CheckAlert[] = [];
  let toldMistakes: CheckAlert[] = [];
  let toldSends: CheckAlert[] = [];
  let toldChanges: CheckAlert[] = [];

  /** A read of one of the books' tables, or a change to one, built the way supabase-js builds it, run against the database. */
  const read = (table: string) => {
    let columns = '*';
    const where: string[] = [];
    const values: unknown[] = [];
    const param = (value: unknown) => { values.push(value); return `$${values.length}`; };
    const orders: string[] = [];
    let range: [number, number] | null = null;
    let limit: number | null = null;
    let patch: Record<string, unknown> | null = null;
    const run = async () => {
      if (failing?.(table, { where: where.join(' AND ') })) return { data: null, error: { message: `${table} failed` } };
      const filter = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      if (patch) {
        const sets = Object.entries(patch).map(([col, value]) => `${col} = ${param(value)}`);
        await pg.query(`UPDATE ${table} SET ${sets.join(', ')}${filter}`, values);
        return { data: null, error: null };
      }
      // A date as PostgREST gives it, 'YYYY-MM-DD'.
      const cols = columns.replace(/\bbooks_live_from\b/, "to_char(books_live_from, 'YYYY-MM-DD') AS books_live_from")
        .replace(/\bperiod_start\b/, "to_char(period_start, 'YYYY-MM-DD') AS period_start");
      const r = await pg.query<Record<string, unknown>>(
        `SELECT ${cols} FROM ${table}${filter}${orders.length ? ` ORDER BY ${orders.join(', ')}` : ''}`
          + `${range ? ` LIMIT ${range[1] - range[0] + 1} OFFSET ${range[0]}` : ''}${limit !== null ? ` LIMIT ${limit}` : ''}`,
        values,
      );
      // A time as PostgREST gives it, an ISO string.
      return { data: r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))), error: null };
    };
    const query: any = {
      select: (cols: string) => { columns = cols; return query; },
      eq: (col: string, value: unknown) => { where.push(`${col} = ${param(value)}`); return query; },
      is: (col: string, value: null) => { if (value !== null) throw new Error('only is null'); where.push(`${col} IS NULL`); return query; },
      lt: (col: string, value: unknown) => { where.push(`${col} < ${param(value)}`); return query; },
      in: (col: string, list: unknown[]) => { where.push(`${col} = ANY(${param(list)})`); return query; },
      order: (col: string, opts?: { ascending?: boolean }) => { orders.push(`${col} ${opts?.ascending === false ? 'DESC' : 'ASC'}`); return query; },
      range: (from: number, to: number) => { range = [from, to]; return query; },
      limit: (n: number) => { limit = n; return query; },
      update: (p: Record<string, unknown>) => { patch = p; return query; },
      maybeSingle: async () => { const r = await run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
    };
    return query;
  };

  // sync_state and cron_runs in memory; every function the real one, called the way supabase-js calls it.
  const service = () => ({
    from: (table: string) => {
      if (['gl_mistake_checks', 'gl_companies', 'gl_periods', 'netsuite_sends', 'profiles', 'books_switches', 'record_differences'].includes(table)) return read(table);
      if (table === 'sync_state') {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: async () => ({ data: store.get(key) ?? null, error: null }),
            }),
          }),
          upsert: async (row: { sync_type: string; last_result: unknown; updated_at: string }) => {
            store.set(row.sync_type, JSON.parse(JSON.stringify({ last_result: row.last_result, updated_at: row.updated_at })));
            return { error: null };
          },
        };
      }
      if (table === 'cron_runs') return { insert: async () => ({ error: null }) };
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      if (failing?.(fn, args)) return { data: null, error: { message: `${fn} failed` } };
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

  const look = async (which: Look) => {
    told = [];
    toldBalances = [];
    toldOwn = [];
    toldFulfillments = [];
    toldBills = [];
    toldReceipts = [];
    toldAdjustments = [];
    toldMistakes = [];
    toldSends = [];
    toldChanges = [];
    const into = (alert: CheckAlert) => (alert.about === 'balance' ? toldBalances : alert.about === 'own' ? toldOwn
      : alert.about === 'fulfillment' ? toldFulfillments : alert.about === 'bill' ? toldBills : alert.about === 'receipt' ? toldReceipts
        : alert.about === 'adjustment' ? toldAdjustments : alert.about === 'mistake' ? toldMistakes : alert.about === 'send' ? toldSends
          : alert.about === 'change' ? toldChanges : told);
    return runDailyCheck(service(), {
      look: which,
      tell: async (alerts) => {
        for (const alert of alerts) into(alert).push(alert);
      },
    });
  };
  const held = () => (store.get(BOOKS_DAILY_CHECK)?.last_result as any)?.companies;

  beforeAll(async () => {
    pg = await freshDb();
    // BMG's December 2025: INV5003's sales tax went to sales in FleetSuite, a difference everyone knows of.
    await invoice(pg, '5003', '2025-12-10', DEC, 10000, 'Beta Corp', 'BMG', 700);
    await post(pg, 'BMG', 'invoice', '5003', '2025-12-10', [['120', 10700], ['400', -10700]]);
    // BMG's September 2026 matches.
    await invoice(pg, '5002', '2026-09-10', SEP, 25000, 'Acme Fleet');
    await post(pg, 'BMG', 'invoice', '5002', '2026-09-10', [['120', 25000], ['400', -25000]]);
    // 1084's September 2026: a journal entry for the rent, which matches.
    await copyTxn(pg, '7001', 'Journal', '2026-09-01', SEP, [['1', '1084', '110', 500000], ['2', '1084', '600', -500000]]);
    await post(pg, '1084', 'journal_entry', '7001', '2026-09-01', [['110', 500000], ['600', -500000]]);
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('learns where things stand at its first look and tells nobody', async () => {
    const result = await look('second');
    expect(result).toMatchObject({ look: 'second', told: 0 });
    expect(result.error).toBeUndefined();
    expect(result.heartbeat).toEqual({ ok: true });
    expect(told).toEqual([]);
    expect(held()).toEqual({ BMG: { known: { [DEC]: 1 }, noted: {} }, 1084: { known: {}, noted: {} } });
  });

  it('notes a month that stopped matching at the first look and tells about it at the second', async () => {
    // NetSuite has an invoice FleetSuite never posted.
    await invoice(pg, '5004', '2026-09-20', SEP, 48000, 'Acme Fleet');

    expect(await look('first')).toMatchObject({ look: 'first', told: 0 });
    expect(told).toEqual([]);
    expect(held().BMG).toEqual({ known: { [DEC]: 1 }, noted: { [SEP]: 1 } });

    // The month, and the balance of the customers its invoice names: none the mirror matched, here.
    expect(await look('second')).toMatchObject({ look: 'second', told: 2 });
    expect(told).toEqual([{
      title: "BMG's books: September 2026 no longer matches NetSuite",
      body: 'INV5004 (Acme Fleet) differs from what NetSuite posted. Differences vs NetSuite shows why.',
      url: '/admin/books/differences?company=BMG&month=2026-09',
    }]);
    expect(toldBalances).toEqual([{
      title: "BMG's books: the balance of customers not matched to FleetSuite no longer matches NetSuite",
      body: 'INV5004 differs from what NetSuite posted. Customer and vendor balances shows why.',
      url: '/admin/books/balances/party?company=BMG&kind=customer&party=none',
      about: 'balance',
    }]);
    expect(held().BMG).toEqual({ known: { [DEC]: 1, [SEP]: 1 }, noted: {} });

    // The next morning, nothing more.
    await look('first');
    await look('second');
    expect(told).toEqual([]);
  });

  it('says nothing of a document the next posting run caught up', async () => {
    await invoice(pg, '5005', '2026-08-12', AUG, 9000, 'Acme Fleet');
    await look('first');
    expect(held().BMG.noted).toEqual({ [AUG]: 1 });
    await post(pg, 'BMG', 'invoice', '5005', '2026-08-12', [['120', 9000], ['400', -9000]]);
    expect(await look('second')).toMatchObject({ told: 0 });
    expect(told).toEqual([]);
    expect(held().BMG).toEqual({ known: { [DEC]: 1, [SEP]: 1 }, noted: {} });
  });

  it('tells when more of a month that already differed differs, the largest difference first', async () => {
    await invoice(pg, '5006', '2025-12-15', DEC, 30000, 'Acme Fleet');
    await look('first');
    await look('second');
    expect(told).toEqual([{
      title: "BMG's books: more of December 2025 differs from NetSuite",
      body: '2 documents differ now, 1 before: INV5006 (Acme Fleet) and INV5003 (Beta Corp). Differences vs NetSuite shows why.',
      url: '/admin/books/differences?company=BMG&month=2025-12',
    }]);
    expect(held().BMG.known).toEqual({ [DEC]: 2, [SEP]: 1 });
    expect(toldBalances).toEqual([{
      title: "BMG's books: more documents of customers not matched to FleetSuite differ from NetSuite",
      body: '2 documents differ now, 1 before: INV5004 and INV5006. Customer and vendor balances shows why.',
      url: '/admin/books/balances/party?company=BMG&kind=customer&party=none',
      about: 'balance',
    }]);
  });

  it("looks at 1084's books too", async () => {
    await copyTxn(pg, '7002', 'Journal', '2026-09-30', SEP, [['1', '1084', '600', 12000], ['2', '1084', '110', -12000]]);
    await look('first');
    await look('second');
    expect(told).toEqual([{
      title: "1084's books: September 2026 no longer matches NetSuite",
      body: 'JE7002 differs from what NetSuite posted. Differences vs NetSuite shows why.',
      url: '/admin/books/differences?company=1084&month=2026-09',
    }]);
    expect(held()['1084']).toEqual({ known: { [SEP]: 1 }, noted: {} });
  });

  it("keeps what it held for a company it couldn't look at, says why, and still looks at the other", async () => {
    await invoice(pg, '5007', '2026-08-20', AUG, 4000, 'Acme Fleet');
    await copyTxn(pg, '7003', 'Journal', '2026-08-31', AUG, [['1', '1084', '600', 3000], ['2', '1084', '110', -3000]]);
    failing = (fn, args) => fn === 'gl_books_difference_documents' && args.p_company === '1084';
    try {
      const result = await look('first');
      expect(result.error).toBe("1084: couldn't list August 2026's documents (gl_books_difference_documents failed)");
      expect(held()['1084']).toEqual({ known: { [SEP]: 1 }, noted: {} });
      expect(held().BMG.noted).toEqual({ [AUG]: 1 });
    } finally {
      failing = null;
    }
    // The posting run failed since, which the notification says, as it may be why.
    store.set(BOOKS_INVOICE_POSTING, { last_result: { error: 'NetSuite timed out' }, updated_at: new Date().toISOString() });
    await look('second');
    expect(told).toEqual([{
      title: "BMG's books: August 2026 no longer matches NetSuite",
      body: 'INV5007 (Acme Fleet) differs from what NetSuite posted. Differences vs NetSuite shows why. '
        + 'The last posting run failed, so FleetSuite may be behind.',
      url: '/admin/books/differences?company=BMG&month=2026-08',
    }]);
    // 1084's August wasn't noted at the first look, so it waits for the next morning.
    await look('first');
    await look('second');
    expect(told.map((a) => a.title)).toEqual(["1084's books: August 2026 no longer matches NetSuite"]);
  });

  it('records months and how many documents differ, never an amount', () => {
    const record = store.get(BOOKS_DAILY_CHECK)!.last_result;
    expect(record).toEqual({
      look: 'second',
      told: 1,
      companies: {
        BMG: { known: { [DEC]: 2, [AUG]: 1, [SEP]: 1 }, noted: {} },
        1084: { known: { [AUG]: 1, [SEP]: 1 }, noted: {} },
      },
      balances: {
        BMG: { known: { 'c:': 3 }, noted: {} },
        1084: { known: {}, noted: {} },
      },
      own: { known: {}, noted: {} },
      fulfillments: { known: {}, noted: {} },
      bills: { known: {}, noted: {} },
      receipts: { known: {}, noted: {} },
      adjustments: { known: {}, noted: {} },
      mistakes: { known: {}, noted: {} },
    });
  });

  it("records nothing when it can't read what it last recorded, which would pass what differs now for what's known", async () => {
    const before = JSON.stringify(store.get(BOOKS_DAILY_CHECK));
    const real = service();
    const broken = {
      ...real,
      from: (table: string) => (table !== 'sync_state' ? real.from(table) : {
        ...real.from(table),
        select: () => ({
          eq: (_col: string, key: string) => ({
            maybeSingle: async () => (key === BOOKS_DAILY_CHECK
              ? { data: null, error: { message: 'timeout' } }
              : { data: store.get(key) ?? null, error: null }),
          }),
        }),
      }),
    };
    const result = await runDailyCheck(broken as any, { look: 'second', tell: async () => { throw new Error('nothing to tell'); } });
    expect(result).toEqual({ look: 'second', told: 0, error: "Couldn't read the last check: timeout" });
    expect(JSON.stringify(store.get(BOOKS_DAILY_CHECK))).toBe(before);
  });

  it("leaves the record as it was when the notifications can't go, so the next morning tells again", async () => {
    await invoice(pg, '5008', '2026-08-25', AUG, 2000, 'Acme Fleet');
    await look('first');
    const noted = JSON.stringify(store.get(BOOKS_DAILY_CHECK));
    await expect(runDailyCheck(service(), { look: 'second', tell: async () => { throw new Error('push is down'); } }))
      .rejects.toThrow('push is down');
    expect(JSON.stringify(store.get(BOOKS_DAILY_CHECK))).toBe(noted);
    await look('first');
    await look('second');
    expect(told).toEqual([{
      title: "BMG's books: more of August 2026 differs from NetSuite",
      body: '2 documents differ now, 1 before: INV5007 (Acme Fleet) and INV5008 (Acme Fleet). '
        + 'Differences vs NetSuite shows why. The last posting run failed, so FleetSuite may be behind.',
      url: '/admin/books/differences?company=BMG&month=2026-08',
    }]);
  });

  // ── Stock by item ──────────────────────────────────────────────────────

  const LADDER = '9001';
  const BINS = '9002';
  const WENTZVILLE = '11';
  const KANSAS_CITY = '12';
  const heldStock = () => (store.get(BOOKS_DAILY_CHECK)?.last_result as any)?.stock;
  const fn = (name: string, p: unknown) => pg.query(`SELECT ${name}($1::jsonb)`, [JSON.stringify(p)]);
  /** A stock document as the copy hands it over; lines are [line, item, location, quantity], each moving stock. */
  const moved = (id: string, type: string, date: string, lines: Array<[string, string, string, string]>) => fn('gl_netsuite_stock_apply', {
    documents: [{
      netsuite_id: id, tran_type: type, tranid: `${type === 'ItemRcpt' ? 'IR' : 'IA'}${id}`, trandate: date,
      lines: lines.map(([line_id, item_id, location_id, quantity]) => ({ line_id, company: 'BMG', item_id, location_id, quantity, moves_stock: true })),
    }],
  });
  /** NetSuite's counts as the copy reads them as it ends, and that copy's record. */
  const counted = async (rows: Array<{ item_id: string; location_id?: string | null; quantity: string }>, by: 'location' | 'item' = 'location') => {
    await fn('gl_netsuite_stock_store_counts', { rows });
    store.set(BOOKS_STOCK_SYNC, {
      last_result: { read: 1, added: 1, changed: 0, unchanged: 0, lines: 1, gone: 0, opening: 0, counts: rows.length, countsBy: by },
      updated_at: new Date().toISOString(),
    });
  };

  it("doesn't look at stock until a copy of NetSuite's stock moves has read NetSuite's counts as it ended", async () => {
    await pg.exec(`
      RESET ROLE;
      INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active, details) VALUES
        ('item', '${LADDER}', 'LDR-24', true, '{"display_name": "Ladder rack 24 in", "item_type": "InvtPart"}'),
        ('item', '${BINS}', 'BIN-10', true, '{"item_type": "InvtPart"}'),
        ('location', '${WENTZVILLE}', 'Wentzville', true, '{"subsidiary_id": "2"}'),
        ('location', '${KANSAS_CITY}', 'Kansas City', true, '{"subsidiary_id": "2"}');
      SET ROLE service_role;
    `);
    await moved('6001', 'ItemRcpt', '2026-09-02', [['1', LADDER, WENTZVILLE, '10']]);
    await moved('6002', 'ItemRcpt', '2026-09-03', [['1', BINS, WENTZVILLE, '40']]);
    await fn('gl_netsuite_stock_store_counts', { rows: [{ item_id: LADDER, location_id: WENTZVILLE, quantity: '10' }, { item_id: BINS, location_id: WENTZVILLE, quantity: '38' }] });

    // No copy yet, then one cut short for time: nothing to compare.
    await look('first');
    expect(heldStock()).toBeUndefined();
    store.set(BOOKS_STOCK_SYNC, { last_result: { read: 200, added: 200, changed: 0, unchanged: 0, lines: 400, partial: true }, updated_at: new Date().toISOString() });
    await look('first');
    expect(heldStock()).toBeUndefined();

    // The first look at stock learns where things stand: the bins differ by two, which nobody is told of.
    await counted([{ item_id: LADDER, location_id: WENTZVILLE, quantity: '10' }, { item_id: BINS, location_id: WENTZVILLE, quantity: '38' }]);
    expect(await look('second')).toMatchObject({ told: 0 });
    expect(told).toEqual([]);
    expect(heldStock()).toEqual({ by: 'location', known: { [`${BINS}|${WENTZVILLE}`]: 2 }, noted: {} });
  });

  it('notes an item whose count stopped matching at the first look and tells about it at the second', async () => {
    // FleetSuite's copy has an adjustment NetSuite's count doesn't show.
    await moved('6003', 'InvAdjst', '2026-10-16', [['1', LADDER, WENTZVILLE, '-1']]);
    await look('first');
    expect(told).toEqual([]);
    expect(heldStock().noted).toEqual({ [`${LADDER}|${WENTZVILLE}`]: 1 });

    expect(await look('second')).toMatchObject({ told: 1 });
    expect(told).toEqual([{
      title: 'Stock: LDR-24 at Wentzville no longer matches NetSuite',
      body: 'Ladder rack 24 in. FleetSuite counts 9 and NetSuite 10. Stock by item shows why.',
      url: '/admin/books/stock/item?item=9001&location=11',
      about: 'stock',
    }]);
    expect(heldStock()).toEqual({ by: 'location', known: { [`${LADDER}|${WENTZVILLE}`]: 1, [`${BINS}|${WENTZVILLE}`]: 2 }, noted: {} });

    // The next morning, nothing more.
    await look('first');
    await look('second');
    expect(told).toEqual([]);
  });

  it("tells when an item's counts draw further apart, and nothing of one NetSuite's count caught up with by the second look", async () => {
    await moved('6004', 'ItemRcpt', '2026-10-17', [['1', BINS, WENTZVILLE, '3']]);
    await look('first');
    await look('second');
    expect(told).toEqual([{
      title: "Stock: BIN-10 at Wentzville is further off NetSuite's count",
      body: 'FleetSuite counts 43 and NetSuite 38, further apart than before. Stock by item shows why.',
      url: '/admin/books/stock/item?item=9002&location=11',
      about: 'stock',
    }]);
    expect(heldStock().known[`${BINS}|${WENTZVILLE}`]).toBe(5);

    // Two racks into Kansas City while the copy ran, so NetSuite's count missed them at the first look, not the second.
    await moved('6005', 'ItemRcpt', '2026-10-18', [['1', LADDER, KANSAS_CITY, '2']]);
    await look('first');
    expect(heldStock().noted).toEqual({ [`${LADDER}|${KANSAS_CITY}`]: 2 });
    await counted([
      { item_id: LADDER, location_id: WENTZVILLE, quantity: '10' }, { item_id: LADDER, location_id: KANSAS_CITY, quantity: '2' },
      { item_id: BINS, location_id: WENTZVILLE, quantity: '38' },
    ]);
    expect(await look('second')).toMatchObject({ told: 0 });
    expect(told).toEqual([]);
    expect(heldStock()).toEqual({ by: 'location', known: { [`${LADDER}|${WENTZVILLE}`]: 1, [`${BINS}|${WENTZVILLE}`]: 5 }, noted: {} });
  });

  it("keeps what it held for stock when it couldn't look, and says why", async () => {
    const before = heldStock();
    failing = (name) => name === 'gl_stock_items';
    try {
      const result = await look('first');
      expect(result.error).toBe("Stock: couldn't compare the counts (gl_stock_items failed)");
      expect(heldStock()).toEqual(before);
    } finally {
      failing = null;
    }
  });

  it("starts afresh when NetSuite's counts come company-wide, telling nothing that morning", async () => {
    await counted([{ item_id: LADDER, quantity: '12' }, { item_id: BINS, quantity: '38' }], 'item');
    await look('first');
    await look('second');
    expect(told).toEqual([]);
    expect(heldStock()).toEqual({ by: 'item', known: { [LADDER]: 1, [BINS]: 5 }, noted: {} });
  });

  it('records items and how far apart their counts are, never an amount', () => {
    const record = store.get(BOOKS_DAILY_CHECK)!.last_result as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      'adjustments', 'balances', 'bills', 'companies', 'fulfillments', 'look', 'mistakes', 'own', 'receipts', 'stock', 'told',
    ]);
    expect(record.stock).toEqual({ by: 'item', known: { [LADDER]: 1, [BINS]: 5 }, noted: {} });
  });

  // ── Customer and vendor balances ───────────────────────────────────────

  const ACME = 'c0000000-0000-4000-8000-00000000000a';
  const heldBalances = () => (store.get(BOOKS_DAILY_CHECK)?.last_result as any)?.balances;

  it("tells when a customer's balance stops matching NetSuite's, naming its documents", async () => {
    // Acme is NetSuite's customer 9001, which the mirror matched; FleetSuite posted its October invoice for less.
    await pg.query(`INSERT INTO customers (id, company_name) VALUES ($1, 'Acme Fleet')`, [ACME]);
    await pg.query(
      `INSERT INTO ledger_customers (source, external_id, external_ref, display_name, cleaned_name, match_status, customer_id)
       VALUES ('netsuite', 'customer/9001', '9001', 'Acme Fleet Services', 'acme fleet services', 'exact', $1)`,
      [ACME],
    );
    await copyTxn(pg, '5101', 'CustInvc', '2026-10-05', OCT, [['0', 'BMG', '120', 60000, '9001'], ['1', 'BMG', '400', -60000, '9001']]);
    await post(pg, 'BMG', 'invoice', '5101', '2026-10-05', [['120', 55000, ACME], ['400', -55000]]);
    await look('first');
    expect(heldBalances().BMG.noted).toEqual({ [`c:${ACME}`]: 1 });
    expect(toldBalances).toEqual([]);
    await look('second');
    expect(toldBalances).toEqual([{
      title: "BMG's books: Acme Fleet's balance no longer matches NetSuite",
      body: 'INV5101 differs from what NetSuite posted. Customer and vendor balances shows why. '
        + 'The last posting run failed, so FleetSuite may be behind.',
      url: `/admin/books/balances/party?company=BMG&kind=customer&party=${ACME}`,
      about: 'balance',
    }]);
    // The month it's in is told about as a month.
    expect(told.map((a) => a.title)).toEqual(["BMG's books: October 2026 no longer matches NetSuite"]);

    // The next morning, nothing more.
    await look('first');
    await look('second');
    expect(toldBalances).toEqual([]);
  });

  it("tells when a vendor's balance stops matching, by NetSuite's name for it, and nothing of one caught up by the second look", async () => {
    await pg.query(`INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES ('vendor', '7101', 'Landlord LLC', true)`);
    await copyTxn(pg, '6101', 'VendBill', '2026-10-01', OCT, [['0', 'BMG', '210', -30000, '7101'], ['1', 'BMG', '600', 30000, '7101']]);
    await post(pg, 'BMG', 'vendor_bill', '6101', '2026-10-01', [['210', -30000, '7101'], ['600', 30000]]);
    await copyTxn(pg, '6102', 'VendPymt', '2026-10-10', OCT, [['0', 'BMG', '210', 30000, '7101'], ['1', 'BMG', '110', -30000, '7101']]);
    await look('first');
    expect(heldBalances().BMG.noted).toEqual({ 'v:7101': 1 });
    await look('second');
    expect(toldBalances).toEqual([{
      title: "BMG's books: Landlord LLC's balance no longer matches NetSuite",
      body: 'JE6102 differs from what NetSuite posted. Customer and vendor balances shows why. '
        + 'The last posting run failed, so FleetSuite may be behind.',
      url: '/admin/books/balances/party?company=BMG&kind=vendor&party=7101',
      about: 'balance',
    }]);

    // A second bill NetSuite has, which the posting run catches up with before the second look.
    await copyTxn(pg, '6103', 'VendBill', '2026-10-12', OCT, [['0', 'BMG', '210', -5000, '7101'], ['1', 'BMG', '600', 5000, '7101']]);
    await look('first');
    expect(heldBalances().BMG.noted).toEqual({ 'v:7101': 2 });
    await post(pg, 'BMG', 'vendor_bill', '6103', '2026-10-12', [['210', -5000, '7101'], ['600', 5000]]);
    await look('second');
    expect(toldBalances).toEqual([]);
  });

  it("keeps what it held for a company's balances when it couldn't look, and says why", async () => {
    const before = heldBalances().BMG;
    failing = (name, args) => name === 'gl_party_balances' && args.p_company === 'BMG' && args.p_kind === 'vendor';
    try {
      const result = await look('first');
      expect(result.error).toBe("BMG's balances: couldn't compare the vendor balances (gl_party_balances failed)");
      expect(heldBalances().BMG).toEqual(before);
    } finally {
      failing = null;
    }
  });

  it('records whose balances differ and in how many documents, never an amount', () => {
    expect(heldBalances()).toEqual({
      BMG: { known: { 'c:': 4, [`c:${ACME}`]: 1, 'v:7101': 1 }, noted: {} },
      1084: { known: {}, noted: {} },
    });
  });

  // ── FleetSuite's own invoices ──────────────────────────────────────────

  const heldOwn = () => (store.get(BOOKS_DAILY_CHECK)?.last_result as any)?.own;

  it("tells when one of FleetSuite's own invoices stops matching NetSuite's, linking to its check", async () => {
    // FleetSuite's copy of an invoice it made for Acme, due the day it was made, as Acme has no terms...
    await pg.query('SELECT gl_own_invoice_save($1::jsonb)', [JSON.stringify({
      netsuite_id: '5201', netsuite_number: 'INV5201', company: 'BMG', made_from: 'po', customer_netsuite_id: '9001', customer_id: ACME,
      invoice_date: '2026-10-15', location_netsuite_id: '1', location_from: 'sent', terms_days: 0, due_date: '2026-10-15',
      tax_rule: 'tax@1', tax_basis: 'rate', tax_rate: '0.084880', subtotal: '100.00', tax: '8.49', total: '108.49', lines_from: 'sent', unknowns: [],
      lines: [{ line_no: 1, item_netsuite_id: '55', item_number: 'SHELF-1', quantity: 1, rate: 100, amount: '100.00', priced: true, taxable: true, tax: '8.49' }],
    })]);
    // ...and NetSuite's, due 30 days on, which posted as FleetSuite posted it, so the books and the balances still match.
    await pg.query(
      `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
       VALUES ('5201', 'CustInvc', 'INV5201', '2026-10-15', $1, 'x', 's')`,
      [OCT],
    );
    for (const [line, account, cents, location] of [['0', '120', 10849, '1'], ['1', '400', -10000, '1'], ['2', '220', -849, null]] as const) {
      await pg.query(
        `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit, entity_id, location_id)
         SELECT '5201', $1, id, $2, $3, '2026-10-15', $4, $5, '9001', $6 FROM gl_companies WHERE code = 'BMG'`,
        [line, account, OCT, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0', location],
      );
    }
    await post(pg, 'BMG', 'invoice', '5201', '2026-10-15', [['120', 10849, ACME], ['400', -10000], ['220', -849]]);
    const doc = await pg.query<{ id: string }>(
      `INSERT INTO ledger_invoices (source, external_id, external_ref, doc_type, doc_number, doc_date, due_date, total, customer_netsuite_id, party_name, voided, deleted_at, lines_synced_at)
       VALUES ('netsuite', 'CustInvc/5201', '5201', 'invoice', 'INV5201', '2026-10-15', '2026-11-14', 108.49, '9001', 'Acme Fleet Services', false, NULL, now())
       RETURNING id`,
    );
    for (const [line, kind, item, amount, quantity] of [['1', 'item', '55', '100.00', '1'], ['2', 'tax', '77', '8.49', null]] as const) {
      await pg.query(
        `INSERT INTO ledger_invoice_lines (document_id, line_external_id, line_no, line_kind, item_external_id, amount, quantity, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [doc.rows[0].id, line, Number(line), kind, item, amount, quantity, JSON.stringify({ netamount: `-${amount}` })],
      );
    }

    await look('first');
    expect(toldOwn).toEqual([]);
    expect(heldOwn()).toEqual({ known: {}, noted: { 5201: 1 } });

    expect(await look('second')).toMatchObject({ told: 1 });
    expect(toldOwn).toEqual([{
      title: "Own invoices: INV5201 (Acme Fleet) differs from NetSuite's",
      body: "Due: FleetSuite's is the invoice's date, as the customer has no terms in NetSuite, and NetSuite's is 30 days later. "
        + 'Own invoices shows why.',
      url: '/admin/books/own-invoices/invoice?id=5201',
      about: 'own',
    }]);
    expect(told).toEqual([]);
    expect(toldBalances).toEqual([]);
    expect(heldOwn()).toEqual({ known: { 5201: 1 }, noted: {} });

    // The next morning, nothing more.
    await look('first');
    await look('second');
    expect(toldOwn).toEqual([]);
  });

  it("keeps what it held for the own invoices when it couldn't look, and says why", async () => {
    const before = heldOwn();
    failing = (name) => name === 'gl_own_invoice_pairs';
    try {
      const result = await look('first');
      expect(result.error).toBe("Own invoices: couldn't check October 2026's invoices (gl_own_invoice_pairs failed)");
      expect(heldOwn()).toEqual(before);
    } finally {
      failing = null;
    }
  });

  it('records which own invoices differ and in how many things, never an amount', () => {
    expect(heldOwn()).toEqual({ known: { 5201: 1 }, noted: {} });
  });

  // ── FleetSuite's own fulfillments ──────────────────────────────────────

  const heldFulfillments = () => (store.get(BOOKS_DAILY_CHECK)?.last_result as any)?.fulfillments;

  it("tells when one of FleetSuite's own fulfillments stops matching NetSuite's, linking to its check", async () => {
    // FleetSuite fulfilled Acme's order from Kansas City, where its PO location rule books the PO's invoice...
    await pg.exec(`
      RESET ROLE;
      INSERT INTO netsuite_sales_orders (netsuite_id, tranid, customer_netsuite_id, customer_name) VALUES ('6201', 'SO6201', '9001', 'Acme Fleet');
      SET ROLE service_role;
    `);
    await pg.query('SELECT gl_own_fulfillment_save($1::jsonb)', [JSON.stringify({
      netsuite_id: '6101', netsuite_number: 'IF6101', company: 'BMG', made_from: 'sales_order', made_from_id: 'po-1', sales_order_id: '6201',
      customer_netsuite_id: '9001', fulfil_date: '2026-10-19', location_netsuite_id: KANSAS_CITY, location_from: 'po_rule', unknowns: [],
      lines: [{ line_no: 1, item_netsuite_id: LADDER, item_number: 'LDR-24', item_type: 'InvtPart', quantity: 2, sales_order_line_id: '1' }],
    })]);
    // ...and NetSuite took the racks from Wentzville, booking no cost, as the copy of its ledger, made since, has it.
    await fn('gl_netsuite_stock_apply', {
      documents: [{
        netsuite_id: '6101', tran_type: 'ItemShip', tranid: 'IF6101', trandate: '2026-10-19',
        lines: [{ line_id: '1', company: 'BMG', item_id: LADDER, location_id: WENTZVILLE, quantity: '-2', moves_stock: true }],
      }],
    });
    await counted([{ item_id: LADDER, quantity: '9' }, { item_id: BINS, quantity: '38' }], 'item');
    // Another, still waiting for NetSuite's fulfillment, which isn't told about.
    await pg.query('SELECT gl_own_fulfillment_save($1::jsonb)', [JSON.stringify({
      netsuite_id: '6102', netsuite_number: 'IF6102', company: 'BMG', made_from: 'vehicle', sales_order_id: '6201', fulfil_date: '2026-10-19',
      location_netsuite_id: WENTZVILLE, location_from: 'customer_rule', unknowns: [],
      lines: [{ line_no: 1, item_netsuite_id: BINS, item_number: 'BIN-10', item_type: 'InvtPart', quantity: 1, sales_order_line_id: '2' }],
    })]);
    store.set(BOOKS_GL_SYNC, { last_result: {}, updated_at: new Date().toISOString(), last_synced_at: new Date(Date.now() + 3_600_000).toISOString() });

    await look('first');
    expect(toldFulfillments).toEqual([]);
    expect(heldFulfillments()).toEqual({ known: {}, noted: { 6101: 1 } });

    expect(await look('second')).toMatchObject({ told: 1 });
    expect(toldFulfillments).toEqual([{
      title: "Own fulfillments: IF6101 (Acme Fleet) differs from NetSuite's",
      body: "Location: FleetSuite's PO location rule puts it in Kansas City, and NetSuite took stock from Wentzville. "
        + 'Own fulfillments shows why.',
      url: '/admin/books/own-fulfillments/fulfillment?id=6101',
      about: 'fulfillment',
    }]);
    expect(told).toEqual([]);
    expect(toldOwn).toEqual([]);
    expect(heldFulfillments()).toEqual({ known: { 6101: 1 }, noted: {} });

    // The next morning, nothing more.
    await look('first');
    await look('second');
    expect(toldFulfillments).toEqual([]);
  });

  it("keeps what it held for the own fulfillments when it couldn't look, and says why", async () => {
    const before = heldFulfillments();
    failing = (name) => name === 'gl_own_fulfillment_pairs';
    try {
      const result = await look('first');
      expect(result.error).toBe("Own fulfillments: couldn't check October 2026's fulfillments (gl_own_fulfillment_pairs failed)");
      expect(heldFulfillments()).toEqual(before);
    } finally {
      failing = null;
    }
  });

  it('records which own fulfillments differ and in how many things, never an amount', () => {
    expect(heldFulfillments()).toEqual({ known: { 6101: 1 }, noted: {} });
  });

  // ── Books' own bills and receipts ──────────────────────────────────────

  const RECEIPT_KEY = '0b6a1c3e-5f2d-4c8b-9a7e-1d2c3b4a5f60';
  const heldBills = () => (store.get(BOOKS_DAILY_CHECK)?.last_result as any)?.bills;
  const heldReceipts = () => (store.get(BOOKS_DAILY_CHECK)?.last_result as any)?.receipts;

  it("tells when one of Books' own bills or receipts stops matching NetSuite's, linking to its check", async () => {
    // FleetSuite billed Northside's vendor invoice for $1,250, which NetSuite's bill has at $1,205...
    await pg.query('SELECT gl_own_bill_save($1::jsonb)', [JSON.stringify({
      netsuite_id: '6301', netsuite_number: 'VI-1042', subsidiary_id: '2', made_from: 'vendor_invoice', vendor_netsuite_id: '412',
      vendor_name: 'Northside Install Co.', reference_no: 'VI-1042', bill_date: '2026-10-20', unknowns: [],
      lines: [{ line_no: 1, account_netsuite_id: '600', description: 'Install', amount: '1250.00' }],
    })]);
    await fn('gl_netsuite_bills_apply', {
      rows: [{
        netsuite_id: '6301', tran_type: 'VendBill', tranid: 'VI-1042', trandate: '2026-10-20', vendor_netsuite_id: '412',
        vendor_name: 'Northside Install Co.', total: '1205.00', status: 'A', status_label: 'Open', voided: false, memo: null,
        lines: [{ line_id: '1', item: null, account: '600', amount: '-1205.00', own_amount: '-1205.00', quantity: null, memo: 'Install', tax: false }],
        links: [],
      }],
    });
    // ...and received 12 ladder racks on PO453-ACME, which NetSuite's item receipt has as 10.
    await pg.query('SELECT gl_own_receipt_save($1::jsonb)', [JSON.stringify({
      receipt_key: RECEIPT_KEY, netsuite_id: '6401', netsuite_number: 'IR6401', po_netsuite_id: '5001', po_number: 'PO453-ACME',
      vendor_netsuite_id: '77', vendor_name: 'Acme Truck Racks', receive_date: '2026-10-21', unknowns: [],
      lines: [{ line_no: 1, item_netsuite_id: LADDER, item_number: 'LDR-24', quantity: 12, rate: 150, po_receipt_id: RECEIPT_KEY }],
    })]);
    await moved('6401', 'ItemRcpt', '2026-10-21', [['1', LADDER, WENTZVILLE, '10']]);
    // NetSuite's counts take the receipt in too, so stock still matches.
    await counted([{ item_id: LADDER, quantity: '19' }, { item_id: BINS, quantity: '38' }], 'item');
    // A payout's bill, still waiting for the copy of NetSuite's bills, which isn't told about.
    await pg.query('SELECT gl_own_bill_save($1::jsonb)', [JSON.stringify({
      netsuite_id: '6302', made_from: 'payout', bill_date: '2026-10-20', lines: [{ line_no: 1, account_netsuite_id: '600', amount: '300.00' }],
    })]);

    await look('first');
    expect([toldBills, toldReceipts]).toEqual([[], []]);
    expect(heldBills()).toEqual({ known: {}, noted: { 6301: 2 } });
    expect(heldReceipts()).toEqual({ known: {}, noted: { [RECEIPT_KEY]: 2 } });

    expect(await look('second')).toMatchObject({ told: 2 });
    expect(toldBills).toEqual([{
      title: "Own bills: Northside Install Co.'s bill VI-1042 differs from NetSuite's",
      body: "Lines: 6000 Rent: Books' copy says $1,250.00, and NetSuite's bill $1,205.00. NetSuite's is $45.00 less. Own bills shows why.",
      url: '/admin/books/own-bills/bill?id=6301',
      about: 'bill',
    }]);
    expect(toldReceipts).toEqual([{
      title: "Own receipts: the receipt on PO453-ACME (Acme Truck Racks) differs from NetSuite's",
      body: "NetSuite's receipt IR6401 has 10 of LDR-24. FleetSuite received 12. Own receipts shows why.",
      url: `/admin/books/own-receipts/receipt?key=${RECEIPT_KEY}`,
      about: 'receipt',
    }]);
    expect([told, toldOwn, toldFulfillments]).toEqual([[], [], []]);
    expect(heldBills()).toEqual({ known: { 6301: 2 }, noted: {} });

    // The next morning, nothing more.
    await look('first');
    await look('second');
    expect([toldBills, toldReceipts]).toEqual([[], []]);
  });

  it("keeps what it held for the own bills and receipts when it couldn't look, and says why", async () => {
    const before = [heldBills(), heldReceipts()];
    failing = (name) => name === 'gl_own_bill_pairs' || name === 'gl_own_receipt_months';
    try {
      const result = await look('first');
      expect(result.error).toBe(
        "Own bills: couldn't check October 2026's bills (gl_own_bill_pairs failed) Own receipts: couldn't list the months (gl_own_receipt_months failed)",
      );
      expect([heldBills(), heldReceipts()]).toEqual(before);
    } finally {
      failing = null;
    }
  });

  it('records which own bills and receipts differ and in how many things, never an amount', () => {
    expect(heldBills()).toEqual({ known: { 6301: 2 }, noted: {} });
    expect(heldReceipts()).toEqual({ known: { [RECEIPT_KEY]: 2 }, noted: {} });
  });

  // ── The Inventory Adjusts ──────────────────────────────────────────────

  const ADJUST_ID = '4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c';
  const heldAdjustments = () => (store.get(BOOKS_DAILY_CHECK)?.last_result as any)?.adjustments;
  /** An Inventory Adjust as Inventory Adjust saves it, made at 10 AM Central on Oct 30. */
  const adjusted = (id: string, netsuiteId: string | null, change: string) => pg.exec(`
    RESET ROLE;
    INSERT INTO inventory_adjustments (id, netsuite_item_id, item_number, location_id, mode, entered_qty, change, on_hand_before, reason,
      netsuite_adjustment_id, netsuite_adjustment_number, created_by_name, created_at)
    VALUES ('${id}', '${BINS}', 'BIN-10', '${WENTZVILLE}', 'delta', abs(${change}), ${change}, 43, 'Damaged',
      ${netsuiteId ? `'${netsuiteId}', 'ADJ${netsuiteId}'` : 'NULL, NULL'}, 'Pat Example', '2026-10-30T15:00:00Z');
    SET ROLE service_role;
  `);

  it('tells when an Inventory Adjust stops matching NetSuite\'s adjustment, linking to its check', async () => {
    // Pat took two damaged bins off at Wentzville, and NetSuite's adjustment, with nothing booked in the copy of its
    // ledger made since, took three.
    await adjusted(ADJUST_ID, '6501', '-2');
    await moved('6501', 'InvAdjst', '2026-10-30', [['1', BINS, WENTZVILLE, '-3']]);
    await counted([{ item_id: LADDER, quantity: '19' }, { item_id: BINS, quantity: '35' }], 'item');
    // One NetSuite didn't say it made, and one still waiting for NetSuite's, neither told about.
    await adjusted('5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d', null, '-1');
    await adjusted('6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e', '6502', '1');

    await look('first');
    expect(toldAdjustments).toEqual([]);
    expect(heldAdjustments()).toEqual({ known: {}, noted: { [ADJUST_ID]: 1 } });

    expect(await look('second')).toMatchObject({ told: 1 });
    expect(toldAdjustments).toEqual([{
      title: "Own adjustments: ADJ6501 (BIN-10, 2 fewer) differs from NetSuite's",
      body: "Change: Inventory Adjust made it 2 fewer BIN-10, and NetSuite's adjustment 3 fewer. Own adjustments shows why.",
      url: `/admin/books/own-adjustments/adjustment?id=${ADJUST_ID}`,
      about: 'adjustment',
    }]);
    expect([told, toldOwn, toldFulfillments, toldBills, toldReceipts]).toEqual([[], [], [], [], []]);
    expect(heldAdjustments()).toEqual({ known: { [ADJUST_ID]: 1 }, noted: {} });

    // The next morning, nothing more.
    await look('first');
    await look('second');
    expect(toldAdjustments).toEqual([]);
  });

  it("keeps what it held for the Inventory Adjusts when it couldn't look, and says why", async () => {
    const before = heldAdjustments();
    for (const [read, error] of [
      ['gl_own_adjustment_pairs', "Own adjustments: couldn't check October 2026's adjustments (gl_own_adjustment_pairs failed)"],
      ['gl_own_adjustment_months', "Own adjustments: couldn't list the months (gl_own_adjustment_months failed)"],
    ]) {
      failing = (name) => name === read;
      try {
        const result = await look('first');
        expect(result.error).toBe(error);
        expect(heldAdjustments()).toEqual(before);
      } finally {
        failing = null;
      }
    }
  });

  it('records which Inventory Adjusts differ by their id alone, never an item or an amount', () => {
    expect(heldAdjustments()).toEqual({ known: { [ADJUST_ID]: 1 }, noted: {} });
  });

  // ── Likely mistakes ────────────────────────────────────────────────────

  const heldMistakes = () => (store.get(BOOKS_DAILY_CHECK)?.last_result as any)?.mistakes;
  const TWICE = {
    key: 'twice:8001+8002', kind: 'twice', company: 'BMG', party: '630', party_name: 'Metro Fuel Services', date: '2026-10-09',
    amount: 1234, strength: 3, docs: [],
    why: 'Two bills with the same amount and the same invoice number, INV-20931: one dated Oct 3, the other Oct 9.',
  };
  const FAR_OFF = {
    key: 'far_off:8003', kind: 'far_off', company: '1084', party: '631', party_name: 'Lakeside Supply', date: '2026-10-12',
    amount: 8990, strength: 2, docs: [],
    why: 'Their last 11 card charges were $89.90 each. This one is a hundred times that.',
  };
  /** What the night's look found, kept the way it keeps it, with the copies it looked through made by then. */
  const found = (items: unknown[], copiedThrough = new Date()) =>
    fn('gl_mistake_checks_save', { found: items, gone: [], copied_through: copiedThrough.toISOString() });
  const idOf = async (key: string) =>
    (await pg.query<{ id: string }>('SELECT id FROM gl_mistake_checks WHERE key = $1', [key])).rows[0].id;

  it("tells about a likely mistake the night's look found and nobody cleared, opening it on Mistake checks", async () => {
    await found([TWICE]);
    const id = await idOf(TWICE.key);

    await look('first');
    expect(toldMistakes).toEqual([]);
    expect(heldMistakes()).toEqual({ known: {}, noted: { [id]: 1 } });

    expect(await look('second')).toMatchObject({ told: 1 });
    expect(toldMistakes).toEqual([{
      title: 'Mistake checks: Metro Fuel Services may be entered twice',
      body: `${TWICE.why} Mistake checks shows it.`,
      url: `/admin/books/mistake-checks?company=BMG&item=${id}`,
      about: 'mistake',
    }]);
    expect(told).toEqual([]);
    expect(toldFulfillments).toEqual([]);
    expect(heldMistakes()).toEqual({ known: { [id]: 1 }, noted: {} });

    // The next morning, nothing more.
    await look('first');
    await look('second');
    expect(toldMistakes).toEqual([]);
  });

  it('tells nothing of one a super admin cleared before the second look, and forgets one cleared since', async () => {
    await found([TWICE, FAR_OFF]);
    const [twice, farOff] = [await idOf(TWICE.key), await idOf(FAR_OFF.key)];
    await look('first');
    expect(heldMistakes()).toEqual({ known: { [twice]: 1 }, noted: { [farOff]: 1 } });

    await fn('gl_mistake_check_clear', { id: farOff, how: 'fine' });
    await fn('gl_mistake_check_clear', { id: twice, how: 'fixed', note: 'Voided the second bill.' });
    expect(await look('second')).toMatchObject({ told: 0 });
    expect(toldMistakes).toEqual([]);
    expect(heldMistakes()).toEqual({ known: {}, noted: {} });
  });

  it('tells again about one that came back', async () => {
    // The copies still show the duplicate once they were made after it was cleared, so the night's look opens it again.
    await found([TWICE], new Date(Date.now() + 3_600_000));
    const id = await idOf(TWICE.key);
    await look('first');
    expect(await look('second')).toMatchObject({ told: 1 });
    expect(toldMistakes.map((a) => a.url)).toEqual([`/admin/books/mistake-checks?company=BMG&item=${id}`]);
  });

  it("keeps what it held for the mistakes when it couldn't read them, and says why", async () => {
    const before = heldMistakes();
    failing = (name) => name === 'gl_mistake_checks';
    try {
      const result = await look('first');
      expect(result.error).toBe("Mistake checks: couldn't read the open ones (gl_mistake_checks failed)");
      expect(heldMistakes()).toEqual(before);
    } finally {
      failing = null;
    }
  });

  it('records which likely mistakes are open by their id alone, never a vendor or an amount', async () => {
    expect(heldMistakes()).toEqual({ known: { [await idOf(TWICE.key)]: 1 }, noted: {} });
  });

  it("keeps what it held for each company when it couldn't read when their books went live, and says why", async () => {
    const before = held();
    failing = (name) => name === 'gl_companies';
    try {
      const result = await look('first');
      expect(result.error).toContain("BMG: couldn't read the companies (gl_companies failed) 1084: couldn't read the companies (gl_companies failed)");
      expect(held()).toEqual(before);
    } finally {
      failing = null;
    }
  });

  it("tells once about each send to NetSuite it isn't sure about, at the first look that finds it", async () => {
    // Made-up sends (migration 477), as FleetSuite keeps them.
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const JESSIE = 'd0000000-0000-4000-8000-000000000001';
    await pg.query("INSERT INTO profiles (id, full_name) VALUES ($1, 'Jessie')", [JESSIE]);
    const send = (id: string, row: Record<string, unknown>) => {
      const all = { id, started_at: ago(90), method: 'POST', action: 'create', record_type: 'invoice', made_type: 'invoice', ...row };
      const cols = Object.keys(all);
      return pg.query(`INSERT INTO netsuite_sends (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(all));
    };
    const ID = (n: number) => `e0000000-0000-4000-8000-00000000000${n}`;
    // NetSuite had a problem of its own: not sure.
    await send(ID(1), { finished_at: ago(89), outcome: 'unsure', http_status: 503, error: 'Service unavailable', user_id: JESSIE });
    // Never heard back, ten minutes on.
    await send(ID(2), { started_at: ago(10), action: 'change', record_type: 'salesOrder', record_id: '4521', made_type: null });
    // Still on its way: not yet.
    await send(ID(3), { started_at: ago(1) });
    // NetSuite took one and refused one: nothing to look for.
    await send(ID(4), { finished_at: ago(89), outcome: 'took', http_status: 204, made_id: '9001' });
    await send(ID(5), { finished_at: ago(89), outcome: 'refused', http_status: 400, error: 'Invalid field value' });
    // One a super admin already looked for, and one already told about.
    await send(ID(6), { finished_at: ago(89), outcome: 'unsure', looked_at: ago(30), looked_by: JESSIE });
    await send(ID(7), { finished_at: ago(89), outcome: 'unsure', told_at: ago(60) });

    await look('first');
    expect(toldSends).toEqual([
      {
        title: 'NetSuite feed: not sure about the new invoice',
        body: expect.stringMatching(/^Sent [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d\d [AP]M by Jessie: Service unavailable\. NetSuite may have done it anyway, so look for it there before anyone tries again\.$/),
        url: `/admin/books/netsuite-feed?send=${ID(1)}`,
        about: 'send',
      },
      {
        title: 'NetSuite feed: not sure about the change to a sales order',
        body: expect.stringMatching(/^Sent [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d\d [AP]M: FleetSuite never heard back from NetSuite\. NetSuite may have done it anyway/),
        url: `/admin/books/netsuite-feed?send=${ID(2)}`,
        about: 'send',
      },
    ]);
    const marked = await pg.query<{ id: string }>('SELECT id FROM netsuite_sends WHERE told_at IS NOT NULL ORDER BY id');
    expect(marked.rows.map((r) => r.id)).toEqual([ID(1), ID(2), ID(7)]);

    // Told once: the next look says nothing of them.
    await look('second');
    expect(toldSends).toEqual([]);

    // One it can't read is said, and the rest of the check goes on.
    failing = (name) => name === 'netsuite_sends';
    try {
      const result = await look('first');
      expect(result.error).toContain("NetSuite feed: couldn't read the sends (netsuite_sends failed)");
      expect(result.heartbeat).toBeDefined();
      // Nor when only the ones that never heard back can't be.
      failing = (name, args) => name === 'netsuite_sends' && String(args.where).includes('outcome IS NULL');
      expect((await look('first')).error).toContain("NetSuite feed: couldn't read the sends (netsuite_sends failed)");
    } finally {
      failing = null;
    }
    await pg.query('DELETE FROM netsuite_sends WHERE id = ANY($1)', [[1, 2, 3, 4, 5, 6, 7].map(ID)]);
  });

  it('tells once about each change made in NetSuite while FleetSuite’s record wins, at the first look that finds it', async () => {
    // Made-up differences, noted as the syncs note them (migration 480).
    const seen = (over: Record<string, unknown>) => ({
      kind: 'customer', netsuite_id: '2001', name: 'Acme Fleet Services', field: 'email',
      fleetsuite: 'billing@acmefleet.example', netsuite: 'ap@acmefleet.example', differs: true, ...over,
    });
    await pg.query('SELECT note_record_differences($1::jsonb)', [JSON.stringify([seen({})])]);
    await pg.query('SELECT note_record_differences($1::jsonb)', [JSON.stringify([
      seen({ kind: 'vendor', netsuite_id: '3001', name: 'Fellers', field: 'phone', fleetsuite: '314-555-0199', netsuite: null }),
      seen({ netsuite_id: '2002', field: 'name', name: null, fleetsuite: 'Harbor Fleet', netsuite: 'Harbor Fleet LLC' }),
    ])]);
    // Oldest first: Acme's an hour before the other two, which were seen in the one call, the vendor's a minute after Harbor's.
    await pg.exec(`UPDATE record_differences SET first_seen_at = first_seen_at - interval '1 hour' WHERE netsuite_id = '2001'`);
    await pg.exec(`UPDATE record_differences SET first_seen_at = first_seen_at + interval '1 minute' WHERE netsuite_id = '3001'`);
    // One already told about, and one dealt with.
    await pg.query('SELECT note_record_differences($1::jsonb)', [JSON.stringify([seen({ netsuite_id: '2003' }), seen({ netsuite_id: '2004' })])]);
    await pg.exec(`UPDATE record_differences SET told_at = now() WHERE netsuite_id = '2003'`);
    await pg.exec(`UPDATE record_differences SET status = 'same', closed_at = now() WHERE netsuite_id = '2004'`);
    const id = async (netsuiteId: string) => (await pg.query<{ id: string }>('SELECT id FROM record_differences WHERE netsuite_id = $1', [netsuiteId])).rows[0].id;

    // While it's off, nothing is told: none of them can be kept or taken.
    await look('first');
    expect(toldChanges).toEqual([]);
    expect((await pg.query('SELECT 1 FROM record_differences WHERE told_at IS NOT NULL')).rows).toHaveLength(1);

    await pg.exec(`UPDATE books_switches SET is_on = true WHERE piece = 'fleetsuite_records'`);
    try {
      // Each counts as told about.
      expect(await look('first')).toMatchObject({ told: 3 });
      expect(toldChanges).toEqual([
        {
          title: 'Email changed in NetSuite for Acme Fleet Services',
          body: 'NetSuite has "ap@acmefleet.example" where FleetSuite has "billing@acmefleet.example". '
            + "FleetSuite's stays until someone keeps it, which sends it on to NetSuite, or takes NetSuite's.",
          url: `/admin/books/changed-in-netsuite?change=${await id('2001')}`,
          about: 'change',
        },
        expect.objectContaining({ title: 'Name changed in NetSuite for NetSuite ID 2002', url: `/admin/books/changed-in-netsuite?change=${await id('2002')}` }),
        expect.objectContaining({ title: 'Phone changed in NetSuite for Fellers', body: expect.stringMatching(/^NetSuite has no phone where FleetSuite has "314-555-0199"\./) }),
      ]);
      const marked = await pg.query<{ netsuite_id: string }>('SELECT netsuite_id FROM record_differences WHERE told_at IS NOT NULL ORDER BY netsuite_id');
      expect(marked.rows.map((r) => r.netsuite_id)).toEqual(['2001', '2002', '2003', '3001']);

      // Told once: the next look says nothing of them.
      await look('second');
      expect(toldChanges).toEqual([]);

      // One it can't read is said, and the rest of the check goes on; one it can't mark is told again next time.
      await pg.query('SELECT note_record_differences($1::jsonb)', [JSON.stringify([seen({ netsuite_id: '2005' })])]);
      failing = (name, args) => name === 'record_differences' && String(args.where).startsWith('id = ANY');
      try {
        const result = await look('first');
        expect(toldChanges.map((a) => a.title)).toEqual(['Email changed in NetSuite for Acme Fleet Services']);
        expect(result.error).toContain("Changed in NetSuite: couldn't mark what changed in NetSuite told about (record_differences failed)");
        failing = (name) => name === 'record_differences';
        const unread = await look('first');
        expect(unread.error).toContain("Changed in NetSuite: couldn't read what changed in NetSuite (record_differences failed)");
        expect(unread.heartbeat).toBeDefined();
        expect(toldChanges).toEqual([]);
      } finally {
        failing = null;
      }
      await look('first');
      expect(toldChanges.map((a) => a.url)).toEqual([`/admin/books/changed-in-netsuite?change=${await id('2005')}`]);
    } finally {
      await pg.exec(`UPDATE books_switches SET is_on = false WHERE piece = 'fleetsuite_records'`);
      await pg.exec('DELETE FROM record_differences WHERE true');
    }
  });

  // From here on BMG's books are live, which can't be undone (migration 359).
  it("looks only at the months since a company's books went live, the opening entry standing in the month before", async () => {
    // Made-up: BMG's books went live on September 1, 2026, so its December 2025 and August 2026 stay as they were.
    await pg.query("UPDATE gl_companies SET books_live_from = '2026-09-01' WHERE code = 'BMG'");
    expect(Object.keys(held().BMG.known)).toEqual(expect.arrayContaining([DEC, AUG, SEP]));
    const since = Object.fromEntries(Object.entries(held().BMG.known).filter(([month]) => month >= SEP));
    // What NetSuite changes in August now, the opening entry trues up.
    await invoice(pg, '5012', '2026-08-26', AUG, 2500, 'Acme Fleet');
    await look('first');
    expect(held().BMG).toEqual({ known: since, noted: {} });
    await look('second');
    expect(told).toEqual([]);

    // From the day they went live, as before.
    await invoice(pg, '5013', '2026-09-25', SEP, 7000, 'Acme Fleet');
    await look('first');
    await look('second');
    expect(told.map((a) => a.title)).toEqual(["BMG's books: more of September 2026 differs from NetSuite"]);
    // 1084's books aren't live, so its August is still looked at.
    expect(held()['1084']).toEqual({ known: { [AUG]: 1, [SEP]: 1 }, noted: {} });
  });

  it("says of a month closed in FleetSuite's books that NetSuite's change waits until it's reopened", async () => {
    // Made-up: BMG's September 2026 closed on Books → Months, and NetSuite then has another invoice in it.
    await pg.query("SELECT gl_set_period_status('BMG', '2026-09-01', 'closed', NULL, 'Craig', NULL)");
    await invoice(pg, '5014', '2026-09-27', SEP, 3000, 'Acme Fleet');
    await look('first');
    await look('second');
    expect(told).toEqual([{
      title: "BMG's books: more of September 2026 differs from NetSuite",
      body: expect.stringContaining("September 2026 is closed in FleetSuite's books, so NetSuite's change waits until it's reopened on Books → Months. "
        + 'Differences vs NetSuite shows why.'),
      url: '/admin/books/differences?company=BMG&month=2026-09',
    }]);
  });
});
