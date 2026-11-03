// Migration 516 hands the nightly mistake checks NetSuite's journal entries,
// as the copy of its general ledger (migration 361) holds them, each with its
// lines; the bill credits and card refunds were already in what migration
// 431's gl_mistake_docs hands the look. This runs migrations 314, 359–363,
// 384, 391 and 431 with 516 in an in-memory Postgres (PGlite) as the app's
// server login, copies a made-up year of journal entries, bills, bill credits
// and card refunds the way the copies keep them, and runs the look
// (src/lib/books/mistake-checks.ts) against it the way the cron does: what
// gl_mistake_journal_entries hands the look, what the look finds in the
// journal entries, credits and refunds and keeps, what the page shows of it,
// and what clears on its own once it's fixed in NetSuite.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { accountNamer, mistakeView, runMistakeChecks, type JournalRow, type MistakeView } from './mistake-checks';
import { BOOKS_BILLS_SYNC } from './netsuite-bills';
import { BOOKS_GL_SYNC } from './netsuite-gl';
import { BOOKS_SPENDING_SYNC } from './netsuite-spending';

/** Made-up vendors, by NetSuite's id; Harbor Hardware isn't in the copy of NetSuite's vendors list. */
const RIVERBEND = '640';
const LAKESIDE = '641';
const PRAIRIE = '642';
const METRO = '643';
const HARBOR = '644';
/** Made-up accounts, by NetSuite's id. */
const SUPPLIES = '6100';
const FUEL = '6420';
const RENT = '6800';
const DEPRECIATION = '6900';
const ACCUMULATED = '1650';
const ACCRUED = '2100';

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
    '391-books-checks-and-cards.sql', '431-books-mistake-checks.sql', '516-books-mistake-checks-credits-journals.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec(`
    INSERT INTO gl_netsuite_lists (kind, netsuite_id, name, active) VALUES
      ('vendor', '${RIVERBEND}', 'Riverbend Tire', true),
      ('vendor', '${LAKESIDE}', 'Lakeside Supply', true),
      ('vendor', '${PRAIRIE}', 'Prairie Office Supply', true),
      ('vendor', '${METRO}', 'Metro Fuel Services', true);
    INSERT INTO gl_accounts (number, name, account_type, netsuite_account_id) VALUES
      ('6100', 'Supplies', 'expense', '${SUPPLIES}'),
      ('6420', 'Fuel', 'expense', '${FUEL}'),
      ('6800', 'Rent', 'expense', '${RENT}'),
      ('6900', 'Depreciation', 'expense', '${DEPRECIATION}'),
      ('1650', 'Accumulated Depreciation', 'fixed_asset', '${ACCUMULATED}'),
      ('2100', 'Accrued Expenses', 'other_current_liability', '${ACCRUED}');
  `);
  await pg.exec('SET ROLE service_role');
  return pg;
}

const one = async <T>(pg: PGlite, sql: string, params: unknown[] = []) => (await pg.query<{ r: T }>(sql, params)).rows[0].r;
const call = <T>(pg: PGlite, fn: string, p: unknown) => one<T>(pg, `SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)]);
const mm = (m: number) => String(m).padStart(2, '0');
const journalEntries = (pg: PGlite, from: string, to: string) =>
  one<JournalRow[]>(pg, 'SELECT gl_mistake_journal_entries($1::date, $2::date) AS r', [from, to]);

/** A bill or bill credit as the copy of NetSuite's bills hands it over, its one line an expense line coded to the account. */
const bill = (id: string, type: 'VendBill' | 'VendCred', number: string, date: string, vendor: string, total: string, account: string) => ({
  netsuite_id: id, tran_type: type, tranid: number, trandate: date, vendor_netsuite_id: vendor, vendor_name: `Vendor ${vendor}`,
  total, voided: false, lines: [{ line_id: '1', item: null, account, amount: total, quantity: null, memo: null, tax: false }],
});
/** A card refund as the copy of NetSuite's checks and card charges hands it over. */
const cardRefund = (id: string, date: string, payee: string, total: string, account: string) => ({
  netsuite_id: id, tran_type: 'CardRfnd', tranid: null, trandate: date, payee_netsuite_id: payee, payee_name: `Payee ${payee}`,
  total, voided: false, lines: [{ line_id: '1', item: null, account, amount: total, own_amount: total, quantity: null, memo: null, tax: false }],
});

/** A line of a document in the copy of NetSuite's ledger: company, account, debit, credit and, when it has one, its name. */
type Line = [company: string, account: string, debit: string, credit: string, entity?: string];
/** A document as the copy of NetSuite's general ledger takes it (gl_netsuite_apply), its lines numbered from 1 unless said. */
const inLedger = (id: string, type: string, number: string | null, date: string, lines: Line[], lineIds = lines.map((_, i) => String(i + 1))) => ({
  netsuite_id: id, tran_type: type, tranid: number, trandate: date, posting_month: `${date.slice(0, 7)}-01`,
  lines: lines.map(([company, account, debit, credit, entity], i) => ({
    line_id: lineIds[i], company, netsuite_account_id: account, debit, credit, entity_id: entity ?? null,
  })),
});
const journal = (id: string, number: string | null, date: string, lines: Line[], lineIds?: string[]) =>
  inLedger(id, 'Journal', number, date, lines, lineIds);
/** A month's depreciation on 1084's books. */
const depreciation = (m: number, amount = '1250.00') =>
  journal(`91${mm(m)}`, `DEP-${mm(m)}`, `2026-${mm(m)}-28`, [['1084', DEPRECIATION, amount, '0.00'], ['1084', ACCUMULATED, '0.00', amount]]);
/** An accrual of supplies Lakeside sent on BMG's books, and the same lines turned, as a reversing entry has them. */
const accrual: Line[] = [['BMG', SUPPLIES, '640.00', '0.00', LAKESIDE], ['BMG', ACCRUED, '0.00', '640.00']];
const accrualTurned: Line[] = [['BMG', SUPPLIES, '0.00', '640.00', LAKESIDE], ['BMG', ACCRUED, '640.00', '0.00']];
/** Rent accrued on BMG's books, and the same lines turned. */
const rentAccrual: Line[] = [['BMG', RENT, '900.00', '0.00'], ['BMG', ACCRUED, '0.00', '900.00']];
const rentAccrualTurned: Line[] = [['BMG', RENT, '0.00', '900.00'], ['BMG', ACCRUED, '900.00', '0.00']];

interface Item {
  id: string; key: string; kind: string; company: string; party_name: string | null; amount: string | null; state: string;
  cleared_how: string | null; why: string; gone_why: string | null;
}

describe('migration 516: the mistake checks look at bill credits, card refunds and journal entries', () => {
  let pg: PGlite;
  const store = new Map<string, Record<string, unknown>>();
  /** A function, table or sync record that fails when the look asks for it. */
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
              maybeSingle: async () => (failing === key
                ? { data: null, error: { message: `${key} failed` } }
                : { data: store.get(key) ?? null, error: null }),
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

  /** The night's look on a day, as the cron runs it at 4:46 AM Central, once the copies have run. */
  const night = (day: string) => {
    for (const sync of [BOOKS_BILLS_SYNC, BOOKS_SPENDING_SYNC, BOOKS_GL_SYNC]) {
      store.set(sync, { last_synced_at: `${day}T09:39:00Z`, updated_at: `${day}T09:39:00Z` });
    }
    return runMistakeChecks(service(), { now: new Date(`${day}T09:46:00Z`) });
  };
  const items = async () => (await pg.query<Item>(`
    SELECT m.id, m.key, m.kind, c.code AS company, m.party_name, m.amount::text AS amount, m.state, m.cleared_how, m.why, m.gone_why
    FROM gl_mistake_checks m JOIN gl_companies c ON c.id = m.company_id
    ORDER BY m.key`)).rows;
  const item = async (key: string) => (await items()).find((i) => i.key === key)!;

  beforeAll(async () => {
    pg = await freshDb();
    await call(pg, 'gl_netsuite_bills_apply', {
      rows: [
        // Riverbend's bills to supplies, April to August, then a credit coded to fuel.
        ...[4, 5, 6, 7, 8].map((m) => bill(`84${mm(m)}`, 'VendBill', `RB-${mm(m)}`, `2026-${mm(m)}-10`, RIVERBEND, '300.00', SUPPLIES)),
        bill('8409', 'VendCred', 'CR-1', '2026-09-15', RIVERBEND, '120.00', FUEL),
        // Lakeside billed $300 in the year, then a credit for $3,000.
        bill('8501', 'VendBill', 'LS-1', '2026-02-05', LAKESIDE, '100.00', SUPPLIES),
        bill('8502', 'VendBill', 'LS-2', '2026-06-05', LAKESIDE, '200.00', SUPPLIES),
        bill('8503', 'VendCred', 'LC-77', '2026-10-08', LAKESIDE, '3000.00', SUPPLIES),
        // A credit from Harbor, who never billed.
        bill('8601', 'VendCred', 'H-CR', '2026-10-02', HARBOR, '250.00', SUPPLIES),
        // Metro's credit entered twice.
        bill('8701', 'VendCred', 'MC-5', '2026-10-05', METRO, '75.00', FUEL),
        bill('8702', 'VendCred', 'MC-5', '2026-10-07', METRO, '75.00', FUEL),
      ],
    });
    // Prairie's refund entered twice on one day.
    await call(pg, 'gl_netsuite_spending_apply', {
      rows: [cardRefund('8801', '2026-10-12', PRAIRIE, '45.00', SUPPLIES), cardRefund('8802', '2026-10-12', PRAIRIE, '45.00', SUPPLIES)],
    });
    await call(pg, 'gl_netsuite_apply', {
      sweep: 's1',
      transactions: [
        // 1084's depreciation each month, then October's typed ten times over.
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => depreciation(m)),
        depreciation(10, '12500.00'),
        // An accrual entered twice; on its second day 1084's rent accrued, with no number and its lines out of order.
        journal('9980', 'JE-2001', '2026-10-15', accrual),
        journal('9990', 'JE-2002', '2026-10-16', accrual),
        journal('10010', null, '2026-10-16', [['1084', ACCRUED, '0.00', '1850.00'], ['1084', RENT, '1850.00', '0.00']], ['9', '10']),
        // Rent accrued twice, the second already undone by a reversing entry.
        journal('10101', 'JE-2101', '2026-10-19', rentAccrual),
        journal('10102', 'JE-2102', '2026-10-20', rentAccrual),
        journal('10103', 'JE-2103', '2026-10-21', rentAccrualTurned),
        // A bill in the ledger, which isn't a journal entry.
        inLedger('8999', 'VendBill', 'INV-1', '2026-10-16', [['BMG', SUPPLIES, '20.00', '0.00'], ['BMG', ACCRUED, '0.00', '20.00']]),
      ],
    });
    // A journal entry the copy holds no line of.
    await pg.query(
      `INSERT INTO gl_netsuite_transactions (netsuite_id, tran_type, tranid, trandate, posting_month, content_hash, sweep)
       VALUES ('10020', 'Journal', 'JE-2020', '2026-10-16', '2026-10-01', 'x', 's1')`,
    );
  }, 60_000);
  afterAll(async () => { await pg?.close(); });

  it('hands the look the journal entries the copy of NetSuite\'s ledger holds, oldest first, each with its lines in order', async () => {
    // Left out: the bill in the ledger, and the entry the copy holds no line of.
    expect(await journalEntries(pg, '2026-10-15', '2026-10-17')).toEqual([
      {
        netsuite_id: '9980', number: 'JE-2001', date: '2026-10-15', lines: [
          { company: 'BMG', account: SUPPLIES, entity: LAKESIDE, debit: '640.00', credit: '0.00' },
          { company: 'BMG', account: ACCRUED, entity: null, debit: '0.00', credit: '640.00' },
        ],
      },
      {
        netsuite_id: '9990', number: 'JE-2002', date: '2026-10-16', lines: [
          { company: 'BMG', account: SUPPLIES, entity: LAKESIDE, debit: '640.00', credit: '0.00' },
          { company: 'BMG', account: ACCRUED, entity: null, debit: '0.00', credit: '640.00' },
        ],
      },
      // After 9990 on the same day, and line 9 before line 10: by number, not as text.
      {
        netsuite_id: '10010', number: null, date: '2026-10-16', lines: [
          { company: '1084', account: ACCRUED, entity: null, debit: '0.00', credit: '1850.00' },
          { company: '1084', account: RENT, entity: null, debit: '1850.00', credit: '0.00' },
        ],
      },
    ]);
    // From the first day, up to the last.
    expect((await journalEntries(pg, '2026-10-15', '2026-10-16')).map((j) => j.netsuite_id)).toEqual(['9980']);
    expect(await journalEntries(pg, '2026-10-16', '2026-10-16')).toEqual([]);
    expect((await journalEntries(pg, '2026-01-01', '2026-04-01')).map((j) => [j.number, j.date])).toEqual([
      ['DEP-01', '2026-01-28'], ['DEP-02', '2026-02-28'], ['DEP-03', '2026-03-28'],
    ]);
    expect(await journalEntries(pg, '2027-01-01', '2027-04-01')).toEqual([]);
  });

  it('finds a journal entry entered twice or ten times over, and credits and refunds that look wrong, keeping each with why', async () => {
    const result = await night('2026-10-30');
    // 12 bills and credits, 2 refunds and 16 journal entries.
    expect(result).toMatchObject({ docs: 30, found: 7, added: 7, back: 0, gone: 0, heartbeat: { ok: true } });
    expect(result.error).toBeUndefined();

    const kept = await items();
    expect(kept.map((i) => [i.key, i.company, i.party_name, i.amount, i.state])).toEqual([
      ['far_off:8503', 'BMG', 'Lakeside Supply', '3000.00', 'open'],
      ['far_off:8601', 'BMG', 'Vendor 644', '250.00', 'open'],
      ['far_off:9110', '1084', null, '12500.00', 'open'],
      ['odd_account:8409', 'BMG', 'Riverbend Tire', '120.00', 'open'],
      ['twice:8701+8702', 'BMG', 'Metro Fuel Services', '75.00', 'open'],
      ['twice:8801+8802', 'BMG', 'Prairie Office Supply', '45.00', 'open'],
      ['twice:9980+9990', 'BMG', null, '640.00', 'open'],
    ]);
    expect(kept.map((i) => i.why)).toEqual([
      'Their bills in the year before it came to $300.00, less than this credit. It may be for the wrong vendor, or have a slipped decimal point.',
      'No bills, checks or card charges from them in the year before it, so this credit has nothing to take back. It may be for the wrong vendor.',
      'The last 9 journal entries to 1650 Accumulated Depreciation and 6900 Depreciation were $1,250.00 each. '
        + 'This one is ten times that, which can be a slipped decimal point.',
      'Coded to 6420 Fuel. Their 5 earlier bills all went to 6100 Supplies.',
      'Two bill credits with the same amount and the same number, MC-5: one dated Oct 5, the other Oct 7.',
      'Two card refunds for the same amount on the same day. It may be one entered twice, or two refunds.',
      'Two journal entries with the same lines, to the same accounts for the same amounts: one dated Oct 15, the other Oct 16. '
        + 'It may be one entered twice.',
    ]);

    // The next night finds the same and adds nothing.
    expect(await night('2026-10-30')).toMatchObject({ found: 7, added: 0, back: 0, gone: 0 });
    expect((await items()).map((i) => i.id)).toEqual(kept.map((i) => i.id));
  });

  it('shows one about journal entries on the page by the entry, linked to its NetSuite page', async () => {
    const { data } = await read('gl_mistake_checks')
      .select('id, key, kind, company_id, party_netsuite_id, party_name, doc_date, amount, strength, why, docs, learn, state, '
        + 'cleared_how, cleared_by, cleared_at, cleared_note, gone_why, learned, back_at, found_at')
      .order('key')
      .range(0, 999);
    const companies = new Map((await pg.query<{ id: string; code: string }>('SELECT id, code FROM gl_companies')).rows.map((c) => [c.id, c.code]));
    const accounts = (await pg.query<{ netsuite_account_id: string; number: string; name: string }>(
      'SELECT netsuite_account_id, number, name FROM gl_accounts',
    )).rows;
    const views = (data as Array<Record<string, any>>).map((row) => mistakeView(row, {
      companyCode: (id) => (companies.get(id) as 'BMG' | '1084' | undefined) ?? null,
      accountName: accountNamer(accounts),
      names: new Map(),
      link: (type, id) => `https://netsuite.example/${type}/${id}`,
    })).filter((v): v is MistakeView => v !== null);

    expect(views.map((v) => [v.kind, v.party, v.cents, v.docs])).toEqual([
      ['far_off', 'Lakeside Supply', 300000, [{ label: 'Bill credit LC-77, Oct 8', url: 'https://netsuite.example/VendCred/8503' }]],
      ['far_off', 'Vendor 644', 25000, [{ label: 'Bill credit H-CR, Oct 2', url: 'https://netsuite.example/VendCred/8601' }]],
      ['far_off', 'Journal entry DEP-10', 1250000, [{ label: 'Journal entry DEP-10, Oct 28', url: 'https://netsuite.example/Journal/9110' }]],
      ['odd_account', 'Riverbend Tire', 12000, [{ label: 'Bill credit CR-1, Sep 15', url: 'https://netsuite.example/VendCred/8409' }]],
      ['twice', 'Metro Fuel Services', 7500, [
        { label: 'Bill credit MC-5, Oct 5', url: 'https://netsuite.example/VendCred/8701' },
        { label: 'Bill credit MC-5, Oct 7', url: 'https://netsuite.example/VendCred/8702' },
      ]],
      ['twice', 'Prairie Office Supply', 4500, [
        { label: 'Card refund, Oct 12', url: 'https://netsuite.example/CardRfnd/8801' },
        { label: 'Card refund, Oct 12', url: 'https://netsuite.example/CardRfnd/8802' },
      ]],
      ['twice', 'Journal entry JE-2002', 64000, [
        { label: 'Journal entry JE-2001, Oct 15', url: 'https://netsuite.example/Journal/9980' },
        { label: 'Journal entry JE-2002, Oct 16', url: 'https://netsuite.example/Journal/9990' },
      ]],
    ]);
    // Clearing a journal entry as fine teaches the check nothing: there's no vendor to learn for.
    expect(views.find((v) => v.party === 'Journal entry DEP-10')?.learnText).toBeNull();
  });

  it("says why when it couldn't read the journal entries, or when the ledger's copy last ran, and keeps what it had", async () => {
    const before = await items();
    for (const [what, error] of [
      ['gl_mistake_journal_entries', 'reading the copied journal entries from January 2025: gl_mistake_journal_entries failed'],
      [BOOKS_GL_SYNC, `${BOOKS_GL_SYNC} failed`],
    ]) {
      failing = what;
      try {
        const result = await night('2026-10-30');
        expect(result.error).toBe(error);
        expect(await items()).toEqual(before);
      } finally {
        failing = null;
      }
    }
  });

  it('clears on its own what was fixed in NetSuite: an extra entry undone by another, an entry corrected, a credit moved to its vendor', async () => {
    await call(pg, 'gl_netsuite_apply', {
      sweep: 's2',
      transactions: [journal('10300', 'JE-2003', '2026-10-30', accrualTurned), depreciation(10)],
    });
    await call(pg, 'gl_netsuite_bills_apply', { rows: [bill('8601', 'VendCred', 'H-CR', '2026-10-02', RIVERBEND, '250.00', SUPPLIES)] });

    expect(await night('2026-10-31')).toMatchObject({ docs: 31, found: 4, added: 0, back: 0, gone: 3 });
    expect((await items()).filter((i) => i.state === 'cleared').map((i) => [i.key, i.cleared_how, i.gone_why])).toEqual([
      ['far_off:8601', 'gone', 'Bill credit H-CR, Oct 2 is for Riverbend Tire now.'],
      ['far_off:9110', 'gone', "It's now $1,250.00."],
      ['twice:9980+9990', 'gone', 'Journal entry JE-2002, Oct 16 and journal entry JE-2003, Oct 30 undo each other.'],
    ]);
    expect(await item('odd_account:8409')).toMatchObject({ state: 'open' });
  });

  it("is the server's alone: the app's logins can't read the journal entries through it", async () => {
    await pg.exec('RESET ROLE');
    for (const role of ['anon', 'authenticated']) {
      await pg.exec(`SET ROLE ${role}`);
      await expect(pg.query(`SELECT gl_mistake_journal_entries('2026-10-01', '2026-11-01')`))
        .rejects.toThrow(/permission denied for function gl_mistake_journal_entries/);
      await pg.exec('RESET ROLE');
    }
    await pg.exec('SET ROLE service_role');
  });
});
