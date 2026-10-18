// The daily books check (src/lib/books/daily-check.ts) looks at both
// companies' books the way Differences vs NetSuite does, through migration
// 377's functions. This runs the same migrations as differences-sql.test.ts
// in an in-memory Postgres (PGlite) as the app's server login, copies a
// made-up handful of NetSuite documents for BMG and 1084, posts FleetSuite's
// entries for some of them, and runs the check's looks against it the way
// the cron does, holding what it tells the super admins and what it records.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { BOOKS_DAILY_CHECK, runDailyCheck, type CheckAlert, type Look } from './daily-check';
import { BOOKS_INVOICE_POSTING } from './invoice-posting';

/** Made-up chart: '120' receivables, '400' sales, '220' sales tax, '110' undeposited funds, '600' rent. */
const ACCOUNTS: Array<[string, string, string]> = [
  ['120', 'Receivables', 'accounts_receivable'],
  ['400', 'Sales', 'income'],
  ['220', 'Sales Tax', 'other_current_liability'],
  ['110', 'Undeposited Funds', 'other_current_asset'],
  ['600', 'Rent', 'expense'],
];
const accountId = (ns: string) => `a0000000-0000-4000-8000-000000000${ns}`;
const DEC = '2025-12-01';
const AUG = '2026-08-01';
const SEP = '2026-09-01';

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

/** A NetSuite transaction as the GL copy keeps it; lines are [line id, company, account, cents debit positive]. */
async function copyTxn(pg: PGlite, id: string, type: string, date: string, month: string, lines: Array<[string, string, string, number]>) {
  await pg.query(
    `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
     VALUES ($1, $2, $3, $4, $5, 'x', 's')`,
    [id, type, `${type === 'CustInvc' ? 'INV' : 'JE'}${id}`, date, month],
  );
  for (const [line, company, account, cents] of lines) {
    await pg.query(
      `INSERT INTO gl_netsuite_lines (transaction_id, line_id, company_id, netsuite_account_id, posting_month, trandate, debit, credit)
       SELECT $1, $2, id, $3, $4, $5, $6, $7 FROM gl_companies WHERE code = $8`,
      [id, line, account, month, date, cents > 0 ? money(cents) : '0', cents < 0 ? money(cents) : '0', company],
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

/** FleetSuite's entry for a document; lines are [account, cents debit positive]. */
const post = (pg: PGlite, company: string, kind: string, id: string, date: string, lines: Array<[string, number]>) => pg.query(
  'SELECT gl_post_entry($1::jsonb)',
  [JSON.stringify({
    company,
    entry_date: date,
    source_type: kind,
    source_id: id,
    posting_rule: `${kind}@1`,
    idempotency_key: `${company === 'BMG' ? '' : `${company}:`}${kind}:${id}:1`,
    lines: lines.map(([account, cents]) => ({ account_id: accountId(account), [cents > 0 ? 'debit' : 'credit']: money(cents) })),
  })],
);

describe('the daily books check', () => {
  let pg: PGlite;
  const store = new Map<string, { last_result: unknown; updated_at: string }>();
  /** When a function fails, by what it was asked. */
  let failing: ((fn: string, args: Record<string, unknown>) => boolean) | null = null;
  let told: CheckAlert[] = [];

  // sync_state and cron_runs in memory; every function the real one, called the way supabase-js calls it.
  const service = () => ({
    from: (table: string) => {
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
    rpc: async (fn: string, args: Record<string, unknown>) => {
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
    return runDailyCheck(service(), { look: which, tell: async (alerts) => { told.push(...alerts); } });
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

    expect(await look('second')).toMatchObject({ look: 'second', told: 1 });
    expect(told).toEqual([{
      title: "BMG's books: September 2026 no longer matches NetSuite",
      body: 'INV5004 (Acme Fleet) differs from what NetSuite posted. Differences vs NetSuite shows why.',
      url: '/admin/books/differences?company=BMG&month=2026-09',
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
});
