// Migration 506 backs up the books: one backup runs at a time, every table
// is read in pages by its key with each value as Postgres writes it out,
// and the journal is read as of the moment the backup began, so what's
// posted while it runs stays out of it. This runs migrations 359, 360, 387
// and 506 in an in-memory Postgres (PGlite) as the app's server login, with
// made-up tables of every kind of column the books have, and holds each rule.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { unguardedWrites } from './sql-writes';

let db: PGlite;
const acct: Record<'bank' | 'ar' | 'sales' | 'rent', string> = {} as any;
const CRAIG = '0b5e1d4a-2f43-4f0f-9d5e-6c1f7a9b3e21';

const rpc = async <T = any>(fn: string, p: Record<string, unknown>): Promise<T> => {
  const r = await db.query<{ r: T }>(`SELECT ${fn}(p => $1::jsonb) AS r`, [JSON.stringify(p)]);
  return r.rows[0].r;
};

let keySeq = 0;
const post = async (amount: string, over: Record<string, unknown> = {}) => {
  const r = await db.query<{ r: { id: string; entry_no: number } }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify({
    company: 'BMG',
    entry_date: '2026-11-03',
    source_type: 'invoice',
    source_id: `INV-${100 + keySeq}`,
    posting_rule: 'invoice@1',
    idempotency_key: `backup-test:${++keySeq}`,
    memo: `INV${100 + keySeq}, Acme Fleet`,
    lines: [
      { account_id: acct.ar, debit: amount },
      { account_id: acct.sales, credit: amount, division: 'upfit', memo: 'Upfit labor' },
    ],
    ...over,
  })]);
  return r.rows[0].r;
};

const TABLES = ['backup_kinds', 'backup_pairs', 'backup_loose', 'backup_children'];

/** Finishes whatever backup is running, so the next begin starts one. */
const finishRunning = async () => {
  const r = await db.query<{ id: string }>(`SELECT id FROM books_backups WHERE status = 'running'`);
  for (const { id } of r.rows) await rpc('books_backup_finish', { id, status: 'failed', error: 'Test over.' });
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  `);
  for (const file of ['359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '387-books-retired-accounts.sql', '506-books-backups.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await db.exec(sql);
    await db.exec(sql); // must be safe to re-run
  }
  // Made-up tables with each kind of column the books have: a generated
  // column, arrays, JSON, a composite key, no key at all, an identity key.
  await db.exec(`
    CREATE TABLE public.backup_kinds (
      id UUID PRIMARY KEY,
      n INT,
      amount NUMERIC(16,2),
      note TEXT,
      tags TEXT[],
      codes SMALLINT[],
      facts JSONB,
      on_day DATE,
      at TIMESTAMPTZ,
      ok BOOLEAN,
      doubled INT GENERATED ALWAYS AS (n * 2) STORED
    );
    CREATE TABLE public.backup_pairs (company TEXT, month DATE, total NUMERIC(14,2), PRIMARY KEY (company, month));
    CREATE TABLE public.backup_loose (company TEXT, item TEXT, qty NUMERIC);
    CREATE TABLE public.backup_children (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      kind_id UUID REFERENCES public.backup_kinds(id),
      pair_company TEXT,
      pair_month DATE,
      parent_id BIGINT REFERENCES public.backup_children(id),
      FOREIGN KEY (pair_company, pair_month) REFERENCES public.backup_pairs(company, month)
    );
    CREATE VIEW public.backup_view AS SELECT id FROM public.backup_kinds;
    CREATE TABLE public.schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
    INSERT INTO public.schema_migrations (filename) VALUES ('505-books-portal.sql'), ('506-books-backups.sql');
  `);
  await db.exec('SET ROLE service_role');

  const companies = await db.query<{ id: string; code: string }>('SELECT id, code FROM gl_companies');
  const coolSprings = companies.rows.find((c) => c.code === '1084')!.id;
  const accounts = await db.query<{ id: string; number: string }>(
    `INSERT INTO gl_accounts (number, name, account_type, is_control, company_id) VALUES
       ('10100', 'First Bank Operating', 'bank', false, NULL),
       ('11000', 'Accounts Receivable', 'accounts_receivable', true, NULL),
       ('40000', 'Upfit Sales', 'income', false, NULL),
       ('41000', 'Rent Income', 'income', false, $1)
     RETURNING id, number`,
    [coolSprings],
  );
  const byNumber = Object.fromEntries(accounts.rows.map((a) => [a.number, a.id]));
  acct.bank = byNumber['10100'];
  acct.ar = byNumber['11000'];
  acct.sales = byNumber['40000'];
  acct.rent = byNumber['41000'];
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('migration 506: starting a backup', () => {
  it('starts one with its snapshot, the latest migration and each table\'s columns, key and parents', async () => {
    const r = await rpc('books_backup_begin', { how: 'nightly', tables: TABLES });
    expect(r.state).toBe('started');
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.snapshot).toMatch(/^\d+:\d+:[\d,]*$/);
    expect(r.migration).toBe('506-books-backups.sql');
    expect(r.tables.map((t: any) => t.table)).toEqual(TABLES);
    const [kinds, pairs, loose, children] = r.tables;
    expect(kinds).toEqual({
      table: 'backup_kinds',
      columns: [
        { name: 'id', type: 'uuid' }, { name: 'n', type: 'integer' }, { name: 'amount', type: 'numeric(16,2)' },
        { name: 'note', type: 'text' }, { name: 'tags', type: 'text[]' }, { name: 'codes', type: 'smallint[]' },
        { name: 'facts', type: 'jsonb' }, { name: 'on_day', type: 'date' }, { name: 'at', type: 'timestamp with time zone' },
        { name: 'ok', type: 'boolean' },
      ],
      generated: ['doubled'],
      identity: [],
      key: ['id'],
      parents: [],
    });
    expect(pairs.key).toEqual(['company', 'month']);
    expect(loose.key).toEqual([]);
    expect(children).toMatchObject({ key: ['id'], identity: ['id'], parents: ['backup_kinds', 'backup_pairs'] });
    const row = await db.query<{ how: string; status: string; asked_by: string | null; snapshot: string }>(
      'SELECT how, status, asked_by, snapshot FROM books_backups WHERE id = $1', [r.id],
    );
    expect(row.rows[0]).toEqual({ how: 'nightly', status: 'running', asked_by: null, snapshot: r.snapshot });
  });

  it('runs one at a time: a second asks back which is running', async () => {
    const running = await db.query<{ id: string }>(`SELECT id FROM books_backups WHERE status = 'running'`);
    const again = await rpc('books_backup_begin', { how: 'by_hand', by: CRAIG, by_name: 'Craig', tables: TABLES });
    expect(again).toMatchObject({ state: 'running', id: running.rows[0].id, how: 'nightly' });
    expect(Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM books_backups')).rows[0].n)).toBe(1);
  });

  it('marks one that stopped ten minutes ago failed and starts another', async () => {
    await db.exec(`RESET ROLE; SET session_replication_role = replica;
      UPDATE books_backups SET started_at = now() - INTERVAL '11 minutes' WHERE status = 'running';
      SET session_replication_role = origin; SET ROLE service_role;`);
    const r = await rpc('books_backup_begin', { how: 'by_hand', by: CRAIG, by_name: '  Craig  ', tables: TABLES });
    expect(r.state).toBe('started');
    const rows = await db.query<{ how: string; status: string; error: string | null; finished: boolean; asked_by: string | null; asked_by_name: string | null }>(
      'SELECT how, status, error, finished_at IS NOT NULL AS finished, asked_by, asked_by_name FROM books_backups ORDER BY started_at',
    );
    expect(rows.rows).toEqual([
      { how: 'nightly', status: 'failed', error: 'It stopped before it finished.', finished: true, asked_by: null, asked_by_name: null },
      { how: 'by_hand', status: 'running', error: null, finished: false, asked_by: CRAIG, asked_by_name: 'Craig' },
    ]);
    await finishRunning();
  });

  it('refuses a table that isn\'t there, a view, a name twice or no tables', async () => {
    await expect(rpc('books_backup_begin', { how: 'nightly', tables: ['backup_kinds', 'nope'] })).rejects.toThrow(/nope isn't a table there is to back up/);
    await expect(rpc('books_backup_begin', { how: 'nightly', tables: ['backup_view'] })).rejects.toThrow(/backup_view isn't a table/);
    await expect(rpc('books_backup_begin', { how: 'nightly', tables: ['Backup_Kinds'] })).rejects.toThrow(/isn't a table/);
    await expect(rpc('books_backup_begin', { how: 'nightly', tables: [42] })).rejects.toThrow(/That isn't a table/);
    await expect(rpc('books_backup_begin', { how: 'nightly', tables: ['backup_kinds', 'backup_kinds'] })).rejects.toThrow(/each table once/);
    await expect(rpc('books_backup_begin', { how: 'nightly', tables: [] })).rejects.toThrow(/needs the tables/);
    await expect(rpc('books_backup_begin', { how: 'weekly', tables: TABLES })).rejects.toThrow(/nightly or by hand/);
    expect(Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM books_backups WHERE status = 'running'`)).rows[0].n)).toBe(0);
  });

  it('keeps nobody as who asked for a nightly one', async () => {
    const r = await rpc('books_backup_begin', { how: 'nightly', by: CRAIG, by_name: 'Craig', tables: TABLES });
    const row = await db.query<{ asked_by: string | null; asked_by_name: string | null }>('SELECT asked_by, asked_by_name FROM books_backups WHERE id = $1', [r.id]);
    expect(row.rows[0]).toEqual({ asked_by: null, asked_by_name: null });
    await finishRunning();
  });
});

describe('migration 506: reading a table', () => {
  beforeAll(async () => {
    await db.query(`INSERT INTO backup_kinds (id, n, amount, note, tags, codes, facts, on_day, at, ok) VALUES
      ('00000000-0000-4000-8000-000000000001', 1, 1250.50, 'Plain', ARRAY['a', 'b'], ARRAY[1, 2]::smallint[], '{"z": 1, "a": [true, null]}', '2026-11-03', '2026-11-03 02:11:00-06', true),
      ('00000000-0000-4000-8000-000000000002', NULL, NULL, '', ARRAY['with, comma', 'with "quote"', NULL], ARRAY[]::smallint[], 'null', NULL, NULL, false),
      ('00000000-0000-4000-8000-000000000003', 3, -0.01, NULL, NULL, NULL, NULL, '2027-01-01', '2026-12-31 23:59:59.123456+00', NULL),
      ('00000000-0000-4000-8000-000000000004', 4, 0, E'two\\nlines, "quoted"', ARRAY[''], NULL, '"text"', NULL, NULL, NULL),
      ('00000000-0000-4000-8000-000000000005', 5, 99999999999999.99, 'Last', NULL, NULL, '[]', NULL, NULL, NULL)`);
    await db.query(`INSERT INTO backup_pairs (company, month, total) VALUES
      ('1084', '2026-09-01', 10), ('BMG', '2026-10-01', 20), ('BMG', '2026-09-01', 30), ('1084', '2026-10-01', 40), ('BMG', '2026-11-01', 50)`);
    await db.query(`INSERT INTO backup_loose (company, item, qty) VALUES ('BMG', 'HITCH-1', 2), ('BMG', NULL, 1.5), ('1084', 'HITCH-1', NULL)`);
  });

  it('writes each value as Postgres does, in UTC, NULL apart from an empty string, without the generated column', async () => {
    // The session's own time zone is Central; the page writes UTC anyway.
    await db.exec(`SET TIME ZONE 'America/Chicago'; SET datestyle = 'SQL, DMY'`);
    const page = await rpc('books_backup_page', { table: 'backup_kinds' });
    await db.exec(`SET TIME ZONE 'UTC'; SET datestyle = 'ISO, MDY'`);
    expect(page.columns).toEqual(['id', 'n', 'amount', 'note', 'tags', 'codes', 'facts', 'on_day', 'at', 'ok']);
    expect(page.key).toEqual(['id']);
    expect(page.last).toBeNull();
    expect(page.rows).toEqual([
      ['00000000-0000-4000-8000-000000000001', '1', '1250.50', 'Plain', '{a,b}', '{1,2}', '{"a": [true, null], "z": 1}', '2026-11-03', '2026-11-03 08:11:00+00', 'true'],
      ['00000000-0000-4000-8000-000000000002', null, null, '', '{"with, comma","with \\"quote\\"",NULL}', '{}', 'null', null, null, 'false'],
      ['00000000-0000-4000-8000-000000000003', '3', '-0.01', null, null, null, null, '2027-01-01', '2026-12-31 23:59:59.123456+00', null],
      ['00000000-0000-4000-8000-000000000004', '4', '0.00', 'two\nlines, "quoted"', '{""}', null, '"text"', null, null, null],
      ['00000000-0000-4000-8000-000000000005', '5', '99999999999999.99', 'Last', null, null, '[]', null, null, null],
    ]);
  });

  it('reads on from the last key, page by page, every row once', async () => {
    const seen: string[][] = [];
    let after: string[] | null = null;
    let pages = 0;
    do {
      const page: { rows: string[][]; last: string[] | null } = await rpc('books_backup_page', { table: 'backup_kinds', after, limit: 2 });
      seen.push(...page.rows);
      after = page.last;
      pages++;
    } while (after && pages < 10);
    expect(pages).toBe(3);
    expect(seen.map((r) => r[0])).toEqual([1, 2, 3, 4, 5].map((n) => `00000000-0000-4000-8000-00000000000${n}`));
  });

  it('reads a two-column key in its order', async () => {
    const first = await rpc('books_backup_page', { table: 'backup_pairs', limit: 2 });
    expect(first.rows).toEqual([['1084', '2026-09-01', '10.00'], ['1084', '2026-10-01', '40.00']]);
    expect(first.last).toEqual(['1084', '2026-10-01']);
    const second = await rpc('books_backup_page', { table: 'backup_pairs', after: first.last, limit: 2 });
    expect(second.rows).toEqual([['BMG', '2026-09-01', '30.00'], ['BMG', '2026-10-01', '20.00']]);
    const third = await rpc('books_backup_page', { table: 'backup_pairs', after: second.last, limit: 2 });
    expect(third.rows).toEqual([['BMG', '2026-11-01', '50.00']]);
    expect(third.last).toBeNull();
    await expect(rpc('books_backup_page', { table: 'backup_pairs', after: ['BMG'] })).rejects.toThrow(/key's 2 values/);
  });

  it('reads a table without a key whole, in a steady order', async () => {
    const page = await rpc('books_backup_page', { table: 'backup_loose', limit: 1 });
    expect(page.key).toEqual([]);
    expect(page.last).toBeNull();
    // An empty value sorts after a filled one, as Postgres sorts arrays.
    expect(page.rows).toEqual([['1084', 'HITCH-1', null], ['BMG', 'HITCH-1', '2'], ['BMG', null, '1.5']]);
  });

  it('refuses a table without a key that\'s too big to read at once', async () => {
    await db.exec(`RESET ROLE; CREATE TABLE public.backup_huge (n INT); INSERT INTO public.backup_huge SELECT generate_series(1, 100001); SET ROLE service_role;`);
    await expect(rpc('books_backup_page', { table: 'backup_huge' })).rejects.toThrow(/backup_huge has 100001 rows and no key/);
    await db.exec('RESET ROLE; DROP TABLE public.backup_huge; SET ROLE service_role;');
  });

  it('keeps a page to 5,000 rows however many are asked for', async () => {
    await db.exec(`INSERT INTO backup_children (kind_id) SELECT NULL FROM generate_series(1, 5003)`);
    const page = await rpc('books_backup_page', { table: 'backup_children', limit: 100000 });
    expect(page.rows).toHaveLength(5000);
    expect(page.last).toEqual(['5000']);
    const rest = await rpc('books_backup_page', { table: 'backup_children', after: page.last, limit: 100000 });
    expect(rest.rows.map((r: string[]) => r[0])).toEqual(['5001', '5002', '5003']);
    expect(rest.last).toBeNull();
  });

  it('reads the journal only through books_backup_journal, and only tables', async () => {
    await expect(rpc('books_backup_page', { table: 'gl_entries' })).rejects.toThrow(/books_backup_journal/);
    await expect(rpc('books_backup_page', { table: 'gl_lines' })).rejects.toThrow(/books_backup_journal/);
    await expect(rpc('books_backup_page', { table: 'backup_view' })).rejects.toThrow(/isn't a table/);
    await expect(rpc('books_backup_page', { table: 'nope' })).rejects.toThrow(/isn't a table/);
    await expect(rpc('books_backup_page', { table: 'backup_kinds; DROP TABLE backup_kinds' })).rejects.toThrow(/isn't a table/);
  });
});

describe('migration 506: the journal as of the moment a backup began', () => {
  let snapshot: string;
  const before: { id: string; entry_no: number }[] = [];

  beforeAll(async () => {
    before.push(await post('100.00'), await post('250.25'), await post('10.10', {
      company: '1084', source_type: 'manual', posting_rule: 'manual',
      lines: [{ account_id: acct.bank, debit: '10.10' }, { account_id: acct.rent, credit: '10.10' }],
    }));
    const r = await rpc('books_backup_begin', { how: 'nightly', tables: ['gl_companies', 'gl_accounts', 'gl_entries', 'gl_lines'] });
    snapshot = r.snapshot;
    // Posted while the backup runs: not in it.
    await post('999.99');
    await post('1.00');
  });

  afterAll(finishRunning);

  it('reads the entries posted before it began, in order, each with all its lines', async () => {
    const first = await rpc('books_backup_journal', { snapshot, limit: 2 });
    expect(first.entry_columns.slice(0, 3)).toEqual(['id', 'entry_no', 'company_id']);
    expect(first.entry_columns).toContain('posted_txid');
    expect(first.line_columns.slice(0, 3)).toEqual(['id', 'entry_id', 'line_no']);
    expect(first.entries.map((e: string[]) => e[0])).toEqual([before[0].id, before[1].id]);
    expect(first.entries.map((e: string[]) => e[1])).toEqual([String(before[0].entry_no), String(before[1].entry_no)]);
    const at = (name: string) => first.line_columns.indexOf(name);
    expect(first.lines.map((l: string[]) => [l[at('entry_id')], l[at('line_no')], l[at('debit')], l[at('credit')]])).toEqual([
      [before[0].id, '1', '100.00', '0.00'], [before[0].id, '2', '0.00', '100.00'],
      [before[1].id, '1', '250.25', '0.00'], [before[1].id, '2', '0.00', '250.25'],
    ]);
    expect(first.last).toBe(before[1].entry_no);
    const second = await rpc('books_backup_journal', { snapshot, after: first.last, limit: 2 });
    expect(second.entries.map((e: string[]) => e[0])).toEqual([before[2].id]);
    expect(second.lines).toHaveLength(2);
    expect(second.last).toBeNull();
  });

  it('adds up each account as of then', async () => {
    const tb = await rpc('books_backup_trial_balance', { snapshot });
    expect(tb.entries).toBe(3);
    expect(tb.lines).toBe(6);
    const byAccount = Object.fromEntries(tb.accounts.map((a: any) => [a.account_id, [a.debit, a.credit]]));
    expect(byAccount).toEqual({
      [acct.ar]: ['350.25', '0.00'],
      [acct.sales]: ['0.00', '350.25'],
      [acct.bank]: ['10.10', '0.00'],
      [acct.rent]: ['0.00', '10.10'],
    });
  });

  it('takes in the later entries once another backup begins', async () => {
    await finishRunning();
    const r = await rpc('books_backup_begin', { how: 'nightly', tables: ['gl_entries'] });
    const tb = await rpc('books_backup_trial_balance', { snapshot: r.snapshot });
    expect(tb.entries).toBe(5);
    const page = await rpc('books_backup_journal', { snapshot: r.snapshot });
    expect(page.entries).toHaveLength(5);
    expect(page.lines).toHaveLength(10);
  });

  it('needs the snapshot', async () => {
    await expect(rpc('books_backup_journal', {})).rejects.toThrow(/as of the backup's snapshot/);
    await expect(rpc('books_backup_trial_balance', {})).rejects.toThrow(/as of the backup's snapshot/);
  });
});

describe('migration 506: finishing a backup', () => {
  const made = (id: string, over: Record<string, unknown> = {}) => ({
    id, status: 'made', file_path: '2026/fleetsuite-books-2026-11-03-081100Z.zip', file_bytes: 1234567,
    file_sha256: 'a'.repeat(64), tables: 97, rows: 12345, entries: 3, lines: 6, checked: true, ...over,
  });

  it('writes a made backup with its file and counts', async () => {
    const r = await rpc('books_backup_begin', { how: 'by_hand', by: CRAIG, by_name: 'Craig', tables: TABLES });
    const done = await rpc('books_backup_finish', made(r.id));
    expect(done).toMatchObject({ state: 'finished', id: r.id, status: 'made' });
    const row = await db.query('SELECT status, file_path, file_bytes::int AS file_bytes, table_count, row_count::int AS row_count, entry_count::int AS entry_count, line_count::int AS line_count, checked, error FROM books_backups WHERE id = $1', [r.id]);
    expect(row.rows[0]).toEqual({
      status: 'made', file_path: '2026/fleetsuite-books-2026-11-03-081100Z.zip', file_bytes: 1234567, table_count: 97,
      row_count: 12345, entry_count: 3, line_count: 6, checked: true, error: null,
    });
    // Finished once.
    expect(await rpc('books_backup_finish', made(r.id))).toEqual({ state: 'gone' });
  });

  it('refuses a made backup that didn\'t check out or has no file, and leaves it running', async () => {
    const r = await rpc('books_backup_begin', { how: 'nightly', tables: TABLES });
    // Under a name no backup has, so each is refused for what it says.
    const refused = (over: Record<string, unknown>) =>
      rpc('books_backup_finish', made(r.id, { file_path: '2026/fleetsuite-books-2026-11-05-081100Z.zip', ...over }));
    await expect(refused({ checked: false })).rejects.toThrow(/"books_backups_made"/);
    await expect(refused({ checked: null })).rejects.toThrow(/"books_backups_made"/);
    await expect(refused({ file_path: null })).rejects.toThrow(/"books_backups_file"/);
    await expect(refused({ file_path: 'elsewhere/books.zip' })).rejects.toThrow(/books_backups_file_path_check/);
    await expect(refused({ file_sha256: 'nope' })).rejects.toThrow(/books_backups_file_sha256_check/);
    await expect(refused({ status: 'done' })).rejects.toThrow(/made or failed/);
    // Nor under a name a backup has.
    await expect(refused({ file_path: '2026/fleetsuite-books-2026-11-03-081100Z.zip' })).rejects.toThrow(/books_backups_file_path_key/);
    expect((await db.query<{ status: string }>('SELECT status FROM books_backups WHERE id = $1', [r.id])).rows[0].status).toBe('running');
    // A failed one says why, and may keep the file it made.
    await expect(rpc('books_backup_finish', { id: r.id, status: 'failed' })).rejects.toThrow();
    const failed = await rpc('books_backup_finish', made(r.id, {
      status: 'failed', file_path: '2026/fleetsuite-books-2026-11-04-081100Z.zip', checked: false,
      error: `  The copy's journal came to a different trial balance: ${'x'.repeat(700)}`,
    }));
    expect(failed.status).toBe('failed');
    const row = await db.query<{ error: string; checked: boolean }>('SELECT error, checked FROM books_backups WHERE id = $1', [r.id]);
    expect(row.rows[0].checked).toBe(false);
    expect(row.rows[0].error.startsWith("The copy's journal")).toBe(true);
    expect(row.rows[0].error.length).toBeLessThanOrEqual(600);
  });

  it('keeps a finished backup\'s record as it is, and every record', async () => {
    const id = (await db.query<{ id: string }>(`SELECT id FROM books_backups WHERE status = 'made' LIMIT 1`)).rows[0].id;
    await expect(db.query(`UPDATE books_backups SET error = 'changed' WHERE id = $1`, [id])).rejects.toThrow(/doesn't change/);
    await expect(db.query('DELETE FROM books_backups WHERE id = $1', [id])).rejects.toThrow(/record stays/);
    const r = await rpc('books_backup_begin', { how: 'nightly', tables: TABLES });
    await expect(db.query(`UPDATE books_backups SET snapshot = '1:1:' WHERE id = $1`, [r.id])).rejects.toThrow(/only how a backup finished/);
    await finishRunning();
  });
});

describe('migration 506: a backup\'s record, however it\'s written', () => {
  let n = 0;
  /** A record written straight in, past the functions: a failed nightly one unless it says otherwise. */
  const insert = (over: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      how: 'nightly', status: 'failed', snapshot: '1:1:', finished_at: '2026-11-06T08:12:00Z', error: 'It ran out of time.', ...over,
    };
    const columns = Object.keys(row);
    return db.query(
      `INSERT INTO books_backups (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      columns.map((c) => row[c]),
    );
  };
  /** A file under a name no backup has. */
  const file = () => ({
    file_path: `2026/fleetsuite-books-2026-11-06-${String(++n).padStart(6, '0')}Z.zip`, file_bytes: 10, file_sha256: 'b'.repeat(64),
  });

  it('says why it failed without spaces around it, in at most 600 characters', async () => {
    await insert();
    await insert({ error: 'x'.repeat(600) });
    for (const error of [' It ran out of time.', 'It ran out of time. ', '', 'x'.repeat(601)]) {
      await expect(insert({ error }), JSON.stringify(error)).rejects.toThrow(/books_backups_error_check/);
    }
  });

  it('keeps a file\'s name, size and SHA-256 together, the SHA-256 in lower-case hex', async () => {
    await insert(file());
    const { file_path, file_bytes, file_sha256 } = file();
    await expect(insert({ file_path })).rejects.toThrow(/"books_backups_file"/);
    await expect(insert({ file_path, file_bytes })).rejects.toThrow(/"books_backups_file"/);
    await expect(insert({ file_bytes, file_sha256 })).rejects.toThrow(/"books_backups_file"/);
    await expect(insert({ ...file(), file_sha256: 'B'.repeat(64) })).rejects.toThrow(/books_backups_file_sha256_check/);
    await expect(insert({ ...file(), file_sha256: 'b'.repeat(63) })).rejects.toThrow(/books_backups_file_sha256_check/);
  });

  it('keeps who asked only for one made by hand', async () => {
    await insert({ how: 'by_hand', asked_by: CRAIG, asked_by_name: 'Craig' });
    await expect(insert({ asked_by: CRAIG })).rejects.toThrow(/"books_backups_who"/);
    await expect(insert({ asked_by_name: 'Craig' })).rejects.toThrow(/"books_backups_who"/);
  });

  it('has a finish time once it isn\'t running, and only then', async () => {
    await finishRunning();
    await expect(insert({ finished_at: null })).rejects.toThrow(/"books_backups_finished"/);
    await expect(insert({ status: 'running', error: null })).rejects.toThrow(/"books_backups_finished"/);
  });

  it('stays unchecked while it runs until it says why, runs one at a time, and keeps when and how it began', async () => {
    const running = { status: 'running', finished_at: null, error: null };
    await expect(insert({ ...running, checked: false })).rejects.toThrow(/"books_backups_unchecked"/);
    const r = await rpc('books_backup_begin', { how: 'nightly', tables: TABLES });
    expect(r.state).toBe('started');
    await expect(insert(running)).rejects.toThrow(/books_backups_one_running/);
    await expect(db.query(`UPDATE books_backups SET started_at = started_at - interval '1 hour' WHERE id = $1`, [r.id]))
      .rejects.toThrow(/only how a backup finished/);
    await expect(db.query(`UPDATE books_backups SET how = 'by_hand' WHERE id = $1`, [r.id])).rejects.toThrow(/only how a backup finished/);
    await finishRunning();
  });
});

describe('migration 506: access', () => {
  const functions = [
    'books_backup_begin(jsonb)', 'books_backup_page(jsonb)', 'books_backup_journal(jsonb)',
    'books_backup_trial_balance(jsonb)', 'books_backup_finish(jsonb)',
  ];

  it('lets only the service role read the backups and call the functions', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const fn of functions) {
        const r = await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, fn]);
        expect(r.rows[0].ok, `${role} ${fn}`).toBe(role === 'service_role');
      }
      const t = await db.query<{ ok: boolean }>("SELECT has_table_privilege($1, 'books_backups', 'SELECT') AS ok", [role]);
      expect(t.rows[0].ok, `${role} books_backups`).toBe(role === 'service_role');
    }
    const rls = await db.query<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'books_backups'`);
    expect(rls.rows[0].on).toBe(true);
  });

  it('gives every DELETE and UPDATE in the functions a WHERE, as Supabase\'s API requires', async () => {
    const bodies = (await db.query<{ name: string; body: string }>(
      `SELECT p.proname AS name, p.prosrc AS body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'books\\_backup%' ORDER BY p.proname`,
    )).rows;
    expect(bodies.map((b) => b.name)).toEqual([
      'books_backup_begin', 'books_backup_finish', 'books_backup_journal', 'books_backup_page', 'books_backup_trial_balance', 'books_backups_guard',
    ]);
    expect(bodies.flatMap((b) => unguardedWrites(b.body).map((w) => `${b.name}: ${w}`))).toEqual([]);
  });
});

describe('migration 506: once a company\'s books are live', () => {
  // Last in the file: going live can't be undone.
  it('won\'t empty the backups\' record', async () => {
    await db.exec(`RESET ROLE; UPDATE gl_companies SET books_live_from = '2027-01-01' WHERE code = 'BMG';`);
    await expect(db.exec('TRUNCATE books_backups')).rejects.toThrow(/books_backups can't be emptied once any company's books are live/);
    await db.exec('SET ROLE service_role;');
  });
});
