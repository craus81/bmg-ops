// Migration 360 keeps FleetSuite's chart of accounts in step with NetSuite's
// through gl_sync_netsuite_accounts(). This runs migrations 359 and 360 in an
// in-memory Postgres (PGlite) as the app's server login and holds the rules:
// matched on NetSuite's id, changes follow NetSuite, nothing posted to is
// retyped, and a cut-short list never marks accounts gone.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

vi.mock('@/lib/netsuite', () => ({ suiteqlQueryAll: vi.fn() }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));
import { ACCOUNTS_QUERY, ACCOUNT_SUBSIDIARIES_QUERY, SUBSIDIARIES_QUERY, syncBooksAccounts } from './netsuite-accounts';

let db: PGlite;

// A fresh database with Supabase's API roles and default grants, migrations
// 359 and 360 run twice as the owner, then the app's server login.
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
  `);
  for (const file of ['359-books-ledger-core.sql', '360-books-netsuite-accounts.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

type NsAccount = {
  netsuite_id: string;
  number?: string | null;
  name: string;
  account_type: string;
  netsuite_type: string;
  parent_netsuite_id?: string | null;
  active?: boolean;
  summary?: boolean;
  description?: string | null;
  company?: string | null;
  subsidiary_ids?: string[] | null;
};

type SyncResult = { received: number; added: number; changed: number; gone: number; issues: { issue: string; netsuite_id?: string }[] };

const sync = async (accounts: NsAccount[], extra: Record<string, unknown> = {}): Promise<SyncResult> => {
  const r = await db.query<{ r: SyncResult }>('SELECT gl_sync_netsuite_accounts($1::jsonb) AS r', [
    JSON.stringify({ complete: true, accounts, ...extra }),
  ]);
  return r.rows[0].r;
};

const account = async (nsId: string) => (await db.query<{
  number: string | null; name: string; account_type: string; company: string | null; parent_ns: string | null;
  active: boolean; is_summary: boolean; is_control: boolean; sync_issue: string | null; updated_at: string;
  netsuite_subsidiary_ids: string[] | null;
}>(
  `SELECT a.number, a.name, a.account_type, c.code AS company, p.netsuite_account_id AS parent_ns, a.active,
          a.is_summary, a.is_control, a.sync_issue, a.updated_at::text AS updated_at, a.netsuite_subsidiary_ids
   FROM gl_accounts a
   LEFT JOIN gl_companies c ON c.id = a.company_id
   LEFT JOIN gl_accounts p ON p.id = a.parent_id
   WHERE a.netsuite_account_id = $1`, [nsId],
)).rows[0];

// A small NetSuite chart: a summary heading listed after its children, AR
// and AP, and two accounts limited to 1084.
const CHART: NsAccount[] = [
  { netsuite_id: '111', number: '10100', name: 'First Bank Operating', account_type: 'bank', netsuite_type: 'Bank', parent_netsuite_id: '110', subsidiary_ids: ['1'] },
  { netsuite_id: '112', number: '10200', name: 'First Bank Payroll', account_type: 'bank', netsuite_type: 'Bank', parent_netsuite_id: '110', subsidiary_ids: ['1'] },
  { netsuite_id: '110', number: '10000', name: 'Cash', account_type: 'bank', netsuite_type: 'Bank', summary: true, subsidiary_ids: ['1'] },
  { netsuite_id: '120', number: '11000', name: 'Accounts Receivable', account_type: 'accounts_receivable', netsuite_type: 'AcctRec', subsidiary_ids: ['1'] },
  { netsuite_id: '210', number: '20000', name: 'Accounts Payable', account_type: 'accounts_payable', netsuite_type: 'AcctPay', subsidiary_ids: ['1'] },
  { netsuite_id: '400', number: '47900', name: 'Sales', account_type: 'income', netsuite_type: 'Income', subsidiary_ids: ['1'] },
  { netsuite_id: '600', number: '60100', name: 'Shop Supplies', account_type: 'expense', netsuite_type: 'Expense', subsidiary_ids: ['2'], company: 'BMG' },
  { netsuite_id: '910', number: '10900', name: '1084 Operating', account_type: 'bank', netsuite_type: 'Bank', subsidiary_ids: ['5'], company: '1084' },
  { netsuite_id: '920', number: '25000', name: 'Building Mortgage', account_type: 'long_term_liability', netsuite_type: 'LongTermLiab', subsidiary_ids: ['5'], company: '1084' },
];

const chartWith = (changes: Record<string, Partial<NsAccount>>, drop: string[] = []) =>
  CHART.filter((a) => !drop.includes(a.netsuite_id)).map((a) => ({ ...a, ...(changes[a.netsuite_id] ?? {}) }));

const postTo = (accountId: string, other: string, key: string) => db.query(
  'SELECT gl_post_entry($1::jsonb)',
  [JSON.stringify({
    company: 'BMG', entry_date: '2026-11-03', source_type: 'invoice', posting_rule: 'invoice@1', idempotency_key: key,
    lines: [{ account_id: accountId, debit: '10.00' }, { account_id: other, credit: '10.00' }],
  })],
);

const idOf = async (nsId: string) =>
  (await db.query<{ id: string }>('SELECT id FROM gl_accounts WHERE netsuite_account_id = $1', [nsId])).rows[0].id;

beforeAll(async () => {
  db = await freshDb();
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('first sync', () => {
  it('adds every account, with parents, headings, control accounts and companies', async () => {
    const r = await sync(CHART, { company_subsidiaries: [{ company: '1084', subsidiary_id: '5' }] });
    expect(r).toMatchObject({ received: 9, added: 9, changed: 0, gone: 0, issues: [] });
    expect(await account('111')).toMatchObject({ number: '10100', account_type: 'bank', parent_ns: '110', company: null, is_summary: false });
    expect(await account('110')).toMatchObject({ is_summary: true, parent_ns: null });
    expect(await account('120')).toMatchObject({ is_control: true });
    expect(await account('210')).toMatchObject({ is_control: true });
    expect(await account('400')).toMatchObject({ is_control: false, netsuite_subsidiary_ids: ['1'] });
    expect(await account('600')).toMatchObject({ company: 'BMG' });
    expect(await account('920')).toMatchObject({ company: '1084', account_type: 'long_term_liability' });
  });

  it('links 1084 to its NetSuite subsidiary once, and never moves an existing link', async () => {
    const companies = await db.query<{ code: string; netsuite_subsidiary_id: string | null }>(
      'SELECT code, netsuite_subsidiary_id FROM gl_companies ORDER BY code',
    );
    expect(companies.rows).toEqual([
      { code: '1084', netsuite_subsidiary_id: '5' },
      { code: 'BMG', netsuite_subsidiary_id: '2' },
    ]);
    await sync(CHART, { company_subsidiaries: [{ company: '1084', subsidiary_id: '7' }, { company: 'BMG', subsidiary_id: '9' }] });
    const again = await db.query<{ code: string; netsuite_subsidiary_id: string | null }>(
      'SELECT code, netsuite_subsidiary_id FROM gl_companies ORDER BY code',
    );
    expect(again.rows).toEqual(companies.rows);
  });

  it('changes nothing when NetSuite hasn\'t changed', async () => {
    const before = await account('111');
    const r = await sync(CHART);
    expect(r).toMatchObject({ added: 0, changed: 0, gone: 0, issues: [] });
    expect((await account('111')).updated_at).toBe(before.updated_at);
  });
});

describe('later syncs', () => {
  it('follows renames, new numbers, new parents and inactive flags', async () => {
    const r = await sync(chartWith({
      '111': { name: 'First Bank Checking', number: '10110' },
      '112': { parent_netsuite_id: null, active: false },
    }));
    expect(r).toMatchObject({ added: 0, changed: 2, gone: 0 });
    expect(await account('111')).toMatchObject({ name: 'First Bank Checking', number: '10110', parent_ns: '110' });
    expect(await account('112')).toMatchObject({ parent_ns: null, active: false });
  });

  it('retypes an account nothing has posted to', async () => {
    await sync(chartWith({ '400': { account_type: 'other_income', netsuite_type: 'OthIncome' } }));
    expect(await account('400')).toMatchObject({ account_type: 'other_income', sync_issue: null });
    await sync(CHART);
    expect(await account('400')).toMatchObject({ account_type: 'income' });
  });

  it('keeps the type and company of an account with postings, and says why', async () => {
    await postTo(await idOf('400'), await idOf('111'), 'sync-test:1');
    const r = await sync(chartWith({ '400': { account_type: 'other_income', netsuite_type: 'OthIncome', name: 'Sales - Upfit' } }));
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ netsuite_id: '400' });
    expect(r.issues[0].issue).toMatch(/type to other_income.*stays income/);
    // Everything else about it still follows NetSuite.
    expect(await account('400')).toMatchObject({ account_type: 'income', name: 'Sales - Upfit' });
    expect((await account('400')).sync_issue).toMatch(/stays income/);

    const moved = await sync(chartWith({ '400': { company: '1084', subsidiary_ids: ['5'] } }));
    expect(moved.issues[0].issue).toMatch(/which company/);
    expect(await account('400')).toMatchObject({ company: null });

    // NetSuite back the way it was: the flag clears.
    await sync(CHART);
    expect(await account('400')).toMatchObject({ account_type: 'income', company: null, name: 'Sales', sync_issue: null });
  });

  it('keeps company limits as they were when NetSuite won\'t say', async () => {
    const blind = CHART.map(({ company: _c, subsidiary_ids: _s, ...rest }) => rest);
    const r = await sync(blind);
    expect(r).toMatchObject({ changed: 0, issues: [] });
    expect(await account('920')).toMatchObject({ company: '1084', netsuite_subsidiary_ids: ['5'] });
  });

  it('marks an account gone from NetSuite inactive, and brings it back if it returns', async () => {
    const r = await sync(chartWith({}, ['600']));
    expect(r.gone).toBe(1);
    expect(await account('600')).toMatchObject({ active: false, sync_issue: 'No longer in NetSuite' });
    expect((await sync(chartWith({}, ['600']))).gone).toBe(0);
    await sync(CHART);
    expect(await account('600')).toMatchObject({ active: true, sync_issue: null });
  });

  it('never marks accounts gone from a list that looks cut short, or a partial one', async () => {
    const short = await sync(CHART.slice(0, 3));
    expect(short.gone).toBe(0);
    expect(short.issues.at(-1)?.issue).toMatch(/none were marked gone/);
    const empty = await sync([]);
    expect(empty.gone).toBe(0);
    expect(empty.issues.at(-1)?.issue).toMatch(/NetSuite sent 0 accounts/);
    const partial = await db.query<{ r: SyncResult }>('SELECT gl_sync_netsuite_accounts($1::jsonb) AS r', [
      JSON.stringify({ complete: false, accounts: CHART.slice(0, 5) }),
    ]);
    expect(partial.rows[0].r.gone).toBe(0);
    const active = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gl_accounts WHERE netsuite_account_id IS NOT NULL AND active`);
    expect(active.rows[0].n).toBe(CHART.length);
  });

  it('refuses a bad list whole, changing nothing', async () => {
    const before = await account('111');
    const ap = await account('210');
    await expect(sync([...CHART, CHART[0]])).rejects.toThrow(/in the list twice/);
    await expect(sync([{ ...CHART[0], netsuite_id: 'abc' }])).rejects.toThrow(/isn't a number/);
    await expect(sync([{ ...CHART[0], name: ' ' }])).rejects.toThrow(/has no name/);
    await expect(sync([{ ...CHART[0], company: 'ACME' }])).rejects.toThrow(/unknown company/);
    await expect(sync(chartWith({ '111': { name: 'Renamed' }, '210': { account_type: 'statistical' } }))).rejects.toThrow(/check constraint/);
    expect(await account('111')).toEqual(before);
    expect(await account('210')).toEqual(ap);
  });
});

describe('the journal and the synced chart', () => {
  it('refuses postings to a heading', async () => {
    await expect(postTo(await idOf('110'), await idOf('111'), 'sync-test:2')).rejects.toThrow(/is a heading/);
  });

  it('lets only the service role run the sync', async () => {
    for (const role of ['anon', 'authenticated']) {
      const r = await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, 'gl_sync_netsuite_accounts(jsonb)', 'EXECUTE') AS ok`, [role]);
      expect(r.rows[0].ok, role).toBe(false);
    }
    const s = await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', 'gl_sync_netsuite_accounts(jsonb)', 'EXECUTE') AS ok`);
    expect(s.rows[0].ok).toBe(true);
  });
});

describe('the cron step against the real function', () => {
  let pg: PGlite;
  beforeAll(async () => { pg = await freshDb(); }, 60_000);
  afterAll(async () => { await pg?.close(); });

  // Reads gl_companies and calls functions the way supabase-js does: by
  // name, with named arguments.
  const service = () => ({
    from: (table: string) => ({
      select: async (cols: string) => ({ data: (await pg.query(`SELECT ${cols} FROM ${table}`)).rows, error: null }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const names = Object.keys(args);
      try {
        const r = await pg.query<{ r: unknown }>(
          `SELECT ${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) AS r`,
          names.map((n) => JSON.stringify(args[n])),
        );
        return { data: r.rows[0].r, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    },
  }) as any;

  const netsuite = (accounts: Array<Record<string, unknown>>) => async (q: string) => {
    if (q === ACCOUNTS_QUERY) return accounts;
    if (q === ACCOUNT_SUBSIDIARIES_QUERY) return [{ account: 10, subsidiary: 1 }, { account: 11, subsidiary: 2 }, { account: 12, subsidiary: 5 }];
    if (q === SUBSIDIARIES_QUERY) return [{ id: 1, name: 'Parent', isinactive: 'F' }, { id: 2, name: 'BMG Fleet Installations', isinactive: 'F' }, { id: 5, name: '1084 Cool Springs LLC', isinactive: 'F' }];
    throw new Error(`unexpected query ${q}`);
  };

  it('fills the chart from NetSuite rows and links 1084 on the first run', async () => {
    const rows = [
      { id: 10, acctnumber: '10100', acctname: 'First Bank Operating', accttype: 'Bank', parent: null, isinactive: 'F', issummary: 'F' },
      { id: 11, acctnumber: '60100', acctname: 'Shop Supplies', accttype: 'Expense', parent: null, isinactive: 'F', issummary: 'F' },
      { id: 12, acctnumber: '25000', acctname: 'Building Mortgage', accttype: 'LongTermLiab', parent: null, isinactive: 'F', issummary: 'F' },
      { id: 13, acctnumber: '90000', acctname: 'Estimates', accttype: 'NonPosting', parent: null, isinactive: 'F', issummary: 'F' },
    ];
    const r = await syncBooksAccounts(service(), { query: netsuite(rows) });
    expect(r).toMatchObject({ received: 3, added: 3, changed: 0, gone: 0, linked: [{ company: '1084', subsidiary_id: '5' }], skipped: { NonPosting: 1 } });
    expect(r.error).toBeUndefined();
    const chart = await pg.query<{ number: string; company: string | null }>(
      `SELECT a.number, c.code AS company FROM gl_accounts a LEFT JOIN gl_companies c ON c.id = a.company_id ORDER BY a.number`,
    );
    expect(chart.rows).toEqual([
      { number: '10100', company: null },
      { number: '25000', company: '1084' },
      { number: '60100', company: 'BMG' },
    ]);
    const again = await syncBooksAccounts(service(), { query: netsuite(rows) });
    expect(again).toMatchObject({ added: 0, changed: 0, gone: 0, linked: [] });
  });
});
