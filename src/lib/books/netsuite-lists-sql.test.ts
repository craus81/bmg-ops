// Migration 363 keeps a copy of the NetSuite lists FleetSuite's posting
// rules need. This runs migrations 359–363 in an in-memory Postgres (PGlite)
// as the app's server login and holds the functions' rules, then runs the
// whole copy against them with a fake NetSuite that answers the job's own
// SuiteQL.
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
  recordHeartbeat: vi.fn(async (service: any, syncType: string, lastResult: unknown) => {
    await service.from('sync_state').upsert({ sync_type: syncType, last_result: lastResult });
    return { ok: true };
  }),
}));

import { BOOKS_LISTS_SYNC, syncBooksLists, type BooksListsSyncResult } from './netsuite-lists';

// A fresh database with Supabase's API roles and default grants, migrations
// 359–363 run twice as the owner, then the app's server login.
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
  for (const file of [
    '359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '361-books-netsuite-gl.sql',
    '362-books-netsuite-gl-store-totals-where.sql', '363-books-netsuite-lists.sql',
  ]) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // must be safe to re-run
  }
  await pg.exec('SET ROLE service_role');
  return pg;
}

type Applied = { received: number; added: number; changed: number };
type Finished = { listed: number; here: number; gone: number; cut_short: boolean };
type Stored = { name: string; parent: string | null; active: boolean; details: Record<string, unknown>; gone: boolean; changed_at: string };

const listRow = (id: string, name: string, fields: Record<string, unknown> = {}) => ({
  netsuite_id: id, name, parent_netsuite_id: null, active: true, details: {}, ...fields,
});

describe('the lists functions', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); }, 60_000);
  afterAll(async () => { await db?.close(); });

  const apply = async (kind: string, rows: unknown[]) =>
    (await db.query<{ r: Applied }>('SELECT gl_netsuite_lists_apply($1::jsonb) AS r', [JSON.stringify({ kind, rows })])).rows[0].r;
  const finish = async (kind: string, ids: string[]) =>
    (await db.query<{ r: Finished }>('SELECT gl_netsuite_lists_finish($1::jsonb) AS r', [JSON.stringify({ kind, netsuite_ids: ids })])).rows[0].r;
  const stored = async (kind: string, id: string) => (await db.query<Stored>(
    `SELECT name, parent_netsuite_id AS parent, active, details, gone_at IS NOT NULL AS gone, changed_at::text AS changed_at
     FROM gl_netsuite_lists WHERE kind = $1 AND netsuite_id = $2`, [kind, id],
  )).rows[0];

  it('adds new rows, changes only what NetSuite changed, and counts each', async () => {
    expect(await apply('location', [
      listRow('1', "O'Fallon"),
      listRow('3', 'Kansas City', { parent_netsuite_id: '9', details: { full_name: 'Plants : Kansas City' } }),
      listRow('9', 'Plants'),
    ])).toEqual({ received: 3, added: 3, changed: 0 });
    const before = await stored('location', '1');

    expect(await apply('location', [
      listRow('1', "O'Fallon"),
      listRow('3', 'Kansas City', { parent_netsuite_id: '9', details: { full_name: 'Plants : Kansas City' } }),
      listRow('9', 'Plants', { active: false }),
    ])).toEqual({ received: 3, added: 0, changed: 1 });
    expect(await stored('location', '1')).toEqual(before);
    expect(await stored('location', '9')).toMatchObject({ active: false, gone: false });
    expect(await stored('location', '3')).toMatchObject({ parent: '9', details: { full_name: 'Plants : Kansas City' } });
  });

  it('marks what a whole list no longer has as gone, and brings it back when NetSuite lists it again', async () => {
    expect(await finish('location', ['1', '3'])).toEqual({ listed: 2, here: 3, gone: 1, cut_short: false });
    expect(await stored('location', '9')).toMatchObject({ gone: true });
    expect(await finish('location', ['1', '3'])).toMatchObject({ gone: 0 });

    expect(await apply('location', [listRow('9', 'Plants', { active: false })])).toMatchObject({ changed: 1 });
    expect(await stored('location', '9')).toMatchObject({ gone: false, active: false });
  });

  it('marks nothing gone from a list that looks cut short', async () => {
    await apply('term', ['1', '2', '3', '4', '5'].map((id) => listRow(id, `Terms ${id}`)));
    expect(await finish('term', ['1', '2'])).toEqual({ listed: 2, here: 5, gone: 0, cut_short: true });
    expect(await finish('term', [])).toEqual({ listed: 0, here: 5, gone: 0, cut_short: true });
    const here = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM gl_netsuite_lists WHERE kind = 'term' AND gone_at IS NULL`);
    expect(here.rows[0].n).toBe(5);
  });

  it('finishes quietly when a list is empty both here and in NetSuite', async () => {
    expect(await finish('department', [])).toEqual({ listed: 0, here: 0, gone: 0, cut_short: false });
  });

  it('keeps each list to itself', async () => {
    await apply('class', [listRow('1', 'Upfit')]);
    expect(await finish('class', ['1'])).toMatchObject({ gone: 0 });
    // Location 1 and class 1 are different rows; finishing classes never touched locations.
    expect(await stored('location', '1')).toMatchObject({ name: "O'Fallon", gone: false });
    expect(await stored('class', '1')).toMatchObject({ name: 'Upfit' });
  });

  it('refuses a bad page whole, changing nothing', async () => {
    const before = await stored('location', '1');
    await expect(apply('location', [listRow('1', 'Renamed'), listRow('1', 'Twice')])).rejects.toThrow(/location 1 is in the list twice/);
    await expect(apply('location', [listRow('1', 'Renamed'), listRow('x7', 'Bad')])).rejects.toThrow(/NetSuite id "x7" isn't a number/);
    await expect(apply('location', [listRow('1', 'Renamed'), { netsuite_id: '8' }])).rejects.toThrow(/location 8 has no name/);
    await expect(apply('location', [listRow('1', 'Renamed', { parent_netsuite_id: 'top' })])).rejects.toThrow(/check constraint/);
    await expect(apply('location', [listRow('1', 'Renamed', { details: ['not', 'an', 'object'] })])).rejects.toThrow(/check constraint/);
    await expect(apply('customer', [listRow('1', 'Renamed')])).rejects.toThrow(/unknown NetSuite list customer/);
    await expect(db.query('SELECT gl_netsuite_lists_apply($1::jsonb)', [JSON.stringify({ kind: 'location' })])).rejects.toThrow(/rows must be a list/);
    await expect(db.query('SELECT gl_netsuite_lists_finish($1::jsonb)', [JSON.stringify({ kind: 'location' })])).rejects.toThrow(/netsuite_ids must be a list/);
    expect(await stored('location', '1')).toEqual(before);
  });

  it('counts each list, the copied GL lines carrying each location, department and class, and the accounts items and vendors post to', async () => {
    await db.query('SELECT gl_netsuite_apply($1::jsonb)', [JSON.stringify({
      sweep: 'test',
      transactions: [{
        netsuite_id: '501', tran_type: 'CustInvc', tranid: 'INV-1', trandate: '2025-02-03', posting_month: '2025-02-01',
        lines: [
          { line_id: '0', company: 'BMG', netsuite_account_id: '10', debit: '10.00', credit: '0', location_id: '1', class_id: '1' },
          { line_id: '1', company: 'BMG', netsuite_account_id: '40', debit: '0', credit: '6.00', location_id: '1', class_id: '1' },
          { line_id: '2', company: 'BMG', netsuite_account_id: '40', debit: '0', credit: '4.00', location_id: '3', department_id: '2' },
        ],
      }, {
        netsuite_id: '502', tran_type: 'Journal', trandate: '2025-02-10', posting_month: '2025-02-01',
        lines: [
          { line_id: '0', company: 'BMG', netsuite_account_id: '10', debit: '1.00', credit: '0' },
          { line_id: '1', company: 'BMG', netsuite_account_id: '40', debit: '0', credit: '1.00' },
        ],
      }],
    })]);
    await apply('item', [
      listRow('900', 'RD-100', { details: { item_type: 'InvtPart', income_account: '40', cogs_account: '50', asset_account: '12' } }),
      listRow('901', 'RD-101', { details: { item_type: 'InvtPart', income_account: '40', cogs_account: '50', asset_account: '12' } }),
      listRow('902', 'LABOR', { details: { item_type: 'Service', income_account: '41' } }),
      listRow('903', 'OLD-1', { active: false, details: { item_type: 'InvtPart', income_account: '49' } }),
    ]);
    await apply('vendor', [listRow('50', 'Sample Supply Co', { details: { expense_account: '60', payables_account: '20' } })]);

    const { rows: [{ r }] } = await db.query<{ r: any }>('SELECT gl_netsuite_lists_overview() AS r');
    expect(r.counts).toEqual(expect.arrayContaining([
      { kind: 'location', listed: 3, active: 2, gone: 0 },
      { kind: 'item', listed: 4, active: 3, gone: 0 },
      { kind: 'vendor', listed: 1, active: 1, gone: 0 },
    ]));
    const usage = (kind: string) => Object.fromEntries(r.usage.filter((u: any) => u.kind === kind).map((u: any) => [u.netsuite_id ?? 'none', u.lines]));
    expect(usage('all')).toEqual({ none: 5 });
    expect(usage('location')).toEqual({ 1: 2, 3: 1, none: 2 });
    expect(usage('department')).toEqual({ 2: 1, none: 4 });
    expect(usage('class')).toEqual({ 1: 2, none: 3 });

    const accounts = (kind: string, field: string) => r.accounts
      .filter((a: any) => a.kind === kind && a.field === field)
      .map((a: any) => [a.netsuite_account_id, a.item_type, a.rows])
      .sort((x: any[], y: any[]) => String(x[0]).localeCompare(String(y[0])));
    expect(accounts('item', 'income_account')).toEqual([['40', 'InvtPart', 2], ['41', 'Service', 1]]);
    expect(accounts('item', 'cogs_account')).toEqual([['50', 'InvtPart', 2], [null, 'Service', 1]]);
    expect(accounts('vendor', 'payables_account')).toEqual([['20', null, 1]]);
  });

  it('lets only the service role read the lists or run the functions', async () => {
    for (const fn of ['gl_netsuite_lists_apply(jsonb)', 'gl_netsuite_lists_finish(jsonb)', 'gl_netsuite_lists_overview()']) {
      for (const role of ['anon', 'authenticated']) {
        const r = await db.query<{ ok: boolean }>(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn]);
        expect(r.rows[0].ok, `${role} ${fn}`).toBe(false);
      }
      const s = await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [fn]);
      expect(s.rows[0].ok, fn).toBe(true);
    }
    for (const role of ['anon', 'authenticated']) {
      const t = await db.query<{ ok: boolean }>(`SELECT has_table_privilege($1, 'gl_netsuite_lists', 'SELECT') AS ok`, [role]);
      expect(t.rows[0].ok, role).toBe(false);
    }
    const rls = await db.query<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'gl_netsuite_lists'`);
    expect(rls.rows[0].on).toBe(true);
  });
});

// ── The whole copy, with a fake NetSuite ──────────────────────────────────

type NsRow = Record<string, unknown>;

/**
 * Answers the job's SuiteQL the way NetSuite would: only the fields asked
 * for, a refusal for a field it won't give or a record the role can't see,
 * and the sales tax lines counted by tax code and account.
 */
class FakeNetSuite {
  records: Record<string, NsRow[]> = {};
  refuse: Record<string, string[]> = {};
  hidden = new Set<string>();
  taxLines: NsRow[] = [];
  down = false;

  query = async (q: string): Promise<NsRow[]> => {
    if (this.down) throw Object.assign(new Error('NetSuite SuiteQL error (503): unavailable'), { status: 503 });
    if (q.includes("tl.taxline = 'T'")) return this.taxLines;
    const record = /FROM (\w+) r\b/.exec(q)?.[1] ?? '';
    const fail = (detail: string) => Object.assign(
      new Error(`NetSuite SuiteQL error (400): {"o:errorDetails":[{"detail":"Invalid search query. Detailed unprocessed description follows. ${detail}"}]}`),
      { status: 400 },
    );
    if (this.hidden.has(record)) throw fail(`Search error occurred: Record '${record}' was not found.`);
    const fields = /^SELECT (.+?) FROM/.exec(q)![1].split(', ').map((f) => f.replace(/^r\./, ''));
    const refused = fields.find((f) => (this.refuse[record] ?? []).includes(f));
    if (refused) throw fail(`Search error occurred: Field '${refused}' for record '${record}' was not found.`);
    return (this.records[record] ?? []).map((row) => Object.fromEntries(fields.map((f) => [f, row[f] ?? null])));
  };
}

function netsuite(): FakeNetSuite {
  const ns = new FakeNetSuite();
  ns.records = {
    location: [
      { id: 1, name: "O'Fallon", isinactive: 'F', fullname: "O'Fallon", subsidiary: 2 },
      { id: 3, name: 'Kansas City', isinactive: 'F', fullname: 'Kansas City', subsidiary: 2 },
      { id: 8, name: 'Old shop', isinactive: 'T' },
    ],
    department: [],
    classification: [{ id: 1, name: 'Upfit', isinactive: 'F' }],
    term: [
      { id: 4, name: 'Net 30', isinactive: 'F', daysuntilnetdue: 30 },
      { id: 7, name: '2% 10 Net 30', isinactive: 'F', daysuntilnetdue: 30, discountpercent: '2%', daysuntilexpiry: 10 },
    ],
    salestaxitem: [{ id: 12, itemid: 'MO-SAMPLE', description: 'Sample County', isinactive: 'F', rate: '6.5%', taxagency: 88 }],
    vendor: [
      { id: 50, entityid: 'V-50', companyname: 'Sample Supply Co', isinactive: 'F', expenseaccount: 60, payablesaccount: 20, terms: 4 },
      { id: 51, entityid: 'Pat Example', isinactive: 'F' },
    ],
    item: [
      { id: 900, itemid: 'RD-100', itemtype: 'InvtPart', isinactive: 'F', displayname: 'Roof rack', incomeaccount: 40, cogsaccount: 50, assetaccount: 12 },
      { id: 901, itemid: 'LABOR', itemtype: 'Service', isinactive: 'F', incomeaccount: 41 },
      { id: 902, itemid: 'GR-1', itemtype: 'NonInvtPart', isinactive: 'F', incomeaccount: 42, expenseaccount: 51 },
    ],
  };
  // NetSuite won't give the tax codes' rates or agencies, nor let the role see classes.
  ns.refuse = { salestaxitem: ['rate', 'taxagency'] };
  ns.hidden = new Set(['classification']);
  ns.taxLines = [
    { tax_code_id: 12, account_id: 23, line_count: 40 },
    { tax_code_id: null, account_id: 23, line_count: 2 },
  ];
  return ns;
}

describe('the copy job against the real functions', () => {
  let pg: PGlite;
  const clock = Date.parse('2026-10-11T12:00:00Z');
  const store = new Map<string, any>();

  beforeAll(async () => { pg = await freshDb(); }, 60_000);
  afterAll(async () => { await pg?.close(); });

  // sync_state in memory; every function the real one, called the way
  // supabase-js calls them: by name, with named arguments.
  const service = () => ({
    from: (table: string) => {
      if (table !== 'sync_state') throw new Error(`unexpected table ${table}`);
      return {
        upsert: async (row: Record<string, unknown>) => {
          store.set(row.sync_type as string, JSON.parse(JSON.stringify(row)));
          return { error: null };
        },
      };
    },
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

  const run = (ns: FakeNetSuite, budgetMs?: number): Promise<BooksListsSyncResult> => syncBooksLists(service(), {
    deadline: budgetMs === undefined ? undefined : clock + budgetMs,
    deps: { query: ns.query, now: () => clock },
  });
  const rows = async (kind: string) => (await pg.query<{ id: string; name: string; active: boolean; details: Record<string, unknown>; gone: boolean }>(
    `SELECT netsuite_id AS id, name, active, details, gone_at IS NOT NULL AS gone FROM gl_netsuite_lists WHERE kind = $1 ORDER BY netsuite_id::int`, [kind],
  )).rows;

  it('copies every list it can see, says what NetSuite wouldn\'t give, and records the run', async () => {
    const r = await run(netsuite());
    expect(r.error).toBeUndefined();
    expect(r.lists).toMatchObject({
      location: { received: 3, added: 3, changed: 0, gone: 0 },
      department: { received: 0, added: 0 },
      term: { received: 2, added: 2 },
      tax_code: { received: 1, added: 1, missing: ['rate', 'tax_agency_id'] },
      vendor: { received: 2, added: 2 },
      item: { received: 3, added: 3 },
    });
    expect(r.lists.class?.error).toMatch(/Record 'classification' was not found/);
    expect(r.notes).toEqual([
      "NetSuite's integration role can't see classes, so they aren't copied. The role needs permission to view them.",
      "NetSuite wouldn't give the tax codes' rates and tax agencies, so they're left out.",
    ]);
    expect(r.taxAccounts).toEqual([
      { tax_code_id: '12', account_id: '23', lines: 40 },
      { tax_code_id: null, account_id: '23', lines: 2 },
    ]);

    expect(await rows('location')).toEqual([
      { id: '1', name: "O'Fallon", active: true, details: { subsidiary_id: '2' }, gone: false },
      { id: '3', name: 'Kansas City', active: true, details: { subsidiary_id: '2' }, gone: false },
      { id: '8', name: 'Old shop', active: false, details: {}, gone: false },
    ]);
    expect(await rows('term')).toEqual([
      { id: '4', name: 'Net 30', active: true, details: { days_until_net_due: 30 }, gone: false },
      { id: '7', name: '2% 10 Net 30', active: true, details: { days_until_net_due: 30, discount_percent: 2, discount_days: 10 }, gone: false },
    ]);
    expect(await rows('tax_code')).toEqual([
      { id: '12', name: 'MO-SAMPLE', active: true, details: { description: 'Sample County' }, gone: false },
    ]);
    expect((await rows('vendor'))[0]).toEqual({
      id: '50', name: 'Sample Supply Co', active: true, gone: false,
      details: { entity_id: 'V-50', expense_account: '60', payables_account: '20', terms_id: '4' },
    });
    expect(await rows('item')).toEqual([
      { id: '900', name: 'RD-100', active: true, gone: false, details: { item_type: 'InvtPart', display_name: 'Roof rack', income_account: '40', cogs_account: '50', asset_account: '12' } },
      { id: '901', name: 'LABOR', active: true, gone: false, details: { item_type: 'Service', income_account: '41' } },
      { id: '902', name: 'GR-1', active: true, gone: false, details: { item_type: 'NonInvtPart', income_account: '42', expense_account: '51' } },
    ]);

    const recorded = store.get(BOOKS_LISTS_SYNC);
    expect(recorded.last_result.lists.item).toEqual({ received: 3, added: 3, changed: 0, gone: 0 });
  });

  it('changes nothing when NetSuite hasn\'t changed', async () => {
    const r = await run(netsuite());
    for (const kind of ['location', 'department', 'term', 'tax_code', 'vendor', 'item'] as const) {
      expect(r.lists[kind], kind).toMatchObject({ added: 0, changed: 0, gone: 0 });
    }
  });

  it('follows NetSuite\'s changes: a renamed location, a new account on an item, an item no longer listed', async () => {
    const ns = netsuite();
    ns.records.location[1] = { ...ns.records.location[1], name: 'Kansas City plant' };
    ns.records.item = [{ ...ns.records.item[0], cogsaccount: 52 }, ns.records.item[2]];
    const r = await run(ns);
    expect(r.lists.location).toMatchObject({ changed: 1, gone: 0 });
    expect(r.lists.item).toMatchObject({ received: 2, changed: 1, gone: 1 });
    const items = await rows('item');
    expect(items.find((i) => i.id === '900')?.details.cogs_account).toBe('52');
    expect(items.find((i) => i.id === '901')).toMatchObject({ gone: true, active: true });
  });

  it('notes a field NetSuite stops giving, and leaves it out of every row', async () => {
    const ns = netsuite();
    ns.refuse.item = ['cogsaccount'];
    const r = await run(ns);
    expect(r.lists.item).toMatchObject({ missing: ['cogs_account'] });
    expect(r.notes).toContain("NetSuite wouldn't give the items' COGS accounts, so they're left out.");
    expect((await rows('item')).find((i) => i.id === '900')?.details).not.toHaveProperty('cogs_account');
  });

  it('leaves the lists it has no time for to the next run', async () => {
    const r = await run(netsuite(), 30_000);
    expect(r.lists.vendor).toMatchObject({ received: 2 });
    expect(r.lists.item).toEqual({ skipped: true });
    expect(r.notes).toContain("There wasn't time left to copy the items; the next run will.");
  });

  it('fails the run only when NetSuite gives none of the lists', async () => {
    const ns = netsuite();
    ns.down = true;
    const r = await run(ns);
    expect(r.error).toBe("NetSuite wouldn't give any of the lists.");
    expect(r.lists.item?.error).toMatch(/503/);
    expect(r.notes).toContain("NetSuite wouldn't say which accounts sales tax posts to (NetSuite SuiteQL error (503): unavailable).");
    // Nothing was marked gone by a run that read nothing.
    expect((await rows('location')).every((l) => !l.gone)).toBe(true);
  });
});
