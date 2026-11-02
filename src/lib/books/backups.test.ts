// Part 84 backs FleetSuite's books up: every table of the books as a CSV
// file, the journal as a workbook to read, and a manifest, in one zip in
// BMG's private file storage, opened again and checked against the books
// before it's kept. This holds the list of tables against every migration
// from 359 on, the CSV and amount rules, the file names, the load order and
// the daily check's look; then makes a real backup of an in-memory Postgres
// (PGlite) running migrations 359, 360, 387 and 506 while an entry is posted
// mid-run, restores it into a second one the way docs/books.md "Backups"
// says, and finds the same books there; and breaks it each way it can break.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

const storage = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  uploads: 0,
  /** HEAD finds a file at the name before anything is sent. */
  takenBefore: false,
  /** What HEAD says once the file is sent, in place of what's there. */
  headAfter: null as null | ((sent: Buffer) => { bytes: number | null; etag: string | null } | null),
  /** The upload is refused with this. */
  refuse: null as string | null,
}));
const gate = vi.hoisted(() => ({
  open: { enabled: true, reason: 'Enabled via Settings → Company (stamped 2026-09-22)', via: 'settings' } as Record<string, unknown>,
  now: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/r2', async () => {
  const { createHash: hash } = await import('node:crypto');
  return {
    r2HeadInfo: vi.fn(async (prefix: string, p: string) => {
      const there = storage.files.get(`${prefix}/${p}`);
      if (!there) return storage.takenBefore ? { bytes: 1234, etag: null } : null;
      if (storage.headAfter) return storage.headAfter(there);
      return { bytes: there.length, etag: hash('md5').update(there).digest('hex') };
    }),
    r2Upload: vi.fn(async (prefix: string, p: string, body: Buffer) => {
      storage.uploads += 1;
      if (storage.refuse) return { success: false, key: `${prefix}/${p}`, publicUrl: '', error: storage.refuse };
      storage.files.set(`${prefix}/${p}`, Buffer.from(body));
      return { success: true, key: `${prefix}/${p}`, publicUrl: '' };
    }),
    r2PresignGet: vi.fn(async (prefix: string, p: string) => `https://files.example/${prefix}/${p}?signed`),
  };
});
vi.mock('@/lib/ledger/pdf-gate', () => ({ ledgerPdfsEnabled: vi.fn(async () => gate.now ?? gate.open) }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { r2PresignGet, r2Upload } from '@/lib/r2';
import { recordHeartbeat } from '@/lib/system-health';
import {
  BACKUP_FORMAT, BACKUP_PREFIX, BACKUP_TABLES, BACKUPS_LISTED, BOOKS_BACKUP, NOT_BOOKS,
  backupDownloadUrl, backupDue, backupFilePath, backupName, checkBackup, csvRow, csvRows, csvValue, exactCents,
  loadBackups, loadOrder, lookAtBackups, moneyText, nextNightly, pgTime, recordOf, runBackup, storageProblem,
} from './backups';

const MIGRATIONS = path.resolve(__dirname, '../../../migrations');
const migration = (file: string) => readFileSync(path.join(MIGRATIONS, file), 'utf8');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const CRAIG = '0b5e1d4a-2f43-4f0f-9d5e-6c1f7a9b3e21';
/** The journal and what it hangs on: the tables the run below copies. */
const JOURNAL = ['gl_companies', 'gl_accounts', 'gl_periods', 'gl_period_events', 'gl_entries', 'gl_lines'];

/** An in-memory Postgres with the books' first migrations and 506, its schema_migrations at 506. */
async function booksDb(): Promise<PGlite> {
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
  for (const file of ['359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '387-books-retired-accounts.sql', '506-books-backups.sql']) {
    await pg.exec(migration(file));
  }
  await pg.exec(`
    CREATE TABLE public.schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
    INSERT INTO public.schema_migrations (filename) VALUES ('505-books-portal.sql'), ('506-books-backups.sql');
  `);
  return pg;
}

type Answer = { data: any; error: { message: string } | null };
type Hook = (fn: string, p: any, real: () => Promise<Answer>) => Promise<Answer>;

/** The app's server login over PGlite, called the way supabase-js calls it; `hook` sees each function call first. */
function serviceOver(pg: PGlite, hook?: Hook) {
  const rpc = async (fn: string, args: { p: unknown }) => {
    const real = async (): Promise<Answer> => {
      try {
        const r = await pg.query<{ r: unknown }>(`SELECT ${fn}(p => $1::jsonb) AS r`, [JSON.stringify(args.p)]);
        return { data: r.rows[0].r, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    };
    return hook ? hook(fn, args.p, real) : real();
  };
  const from = (table: string) => {
    if (table !== 'books_backups') throw new Error(`unexpected table ${table}`);
    let columns = '*';
    const where: string[] = [];
    const values: unknown[] = [];
    const orders: string[] = [];
    let limit: number | null = null;
    const run = async (): Promise<Answer> => {
      try {
        const r = await pg.query<Record<string, unknown>>(
          `SELECT ${columns} FROM public.${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`
            + `${orders.length ? ` ORDER BY ${orders.join(', ')}` : ''}${limit === null ? '' : ` LIMIT ${limit}`}`,
          values,
        );
        // Times as PostgREST gives them, ISO strings.
        return { data: r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))), error: null };
      } catch (e: any) {
        return { data: null, error: { message: e.message } };
      }
    };
    const query: any = {
      select: (cols: string) => { columns = cols; return query; },
      eq: (col: string, value: unknown) => { values.push(value); where.push(`${col} = $${values.length}`); return query; },
      order: (col: string, opts?: { ascending?: boolean }) => { orders.push(`${col} ${opts?.ascending === false ? 'DESC' : 'ASC'}`); return query; },
      limit: (n: number) => { limit = n; return query; },
      maybeSingle: async () => { const r = await run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
    };
    return query;
  };
  return { rpc, from } as any;
}

/** Each table's rows as JSON, in one order, generated columns and all. */
async function dump(pg: PGlite, tables = JOURNAL): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const r = await pg.query<{ rows: unknown[] }>(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM public.${t} t`);
    out[t] = r.rows[0].rows;
  }
  return out;
}

/** Opens a backup's zip: its folder's name, its manifest, and its files. */
async function opened(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const manifestPath = Object.keys(zip.files).find((f) => f.endsWith('/manifest.json'))!;
  const name = manifestPath.split('/')[0];
  const manifest = JSON.parse(await zip.file(manifestPath)!.async('string'));
  return { zip, name, manifest };
}

/** Restores a backup into an empty database, as docs/books.md "Backups" says to. */
async function restore(bytes: Uint8Array): Promise<PGlite> {
  const { zip, name, manifest } = await opened(bytes);
  const db = await booksDb();
  await db.exec('SET session_replication_role = replica');
  await db.exec(`TRUNCATE ${manifest.tables.map((t: any) => `public.${t.table}`).join(', ')} CASCADE`);
  for (const table of manifest.load_order as string[]) {
    const t = manifest.tables.find((x: any) => x.table === table);
    const csv = await zip.file(`${name}/${t.file}`)!.async('arraybuffer');
    await db.query(
      `COPY public.${table} (${t.columns.map((c: any) => `"${c.name}"`).join(', ')}) FROM '/dev/blob' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')`,
      [], { blob: new Blob([csv]) },
    );
  }
  await db.exec('SET session_replication_role = origin');
  for (const t of manifest.tables) {
    for (const column of t.identity) {
      await db.query(`SELECT setval(pg_get_serial_sequence('public.${t.table}', '${column}'), coalesce(max("${column}"), 1), max("${column}") IS NOT NULL) FROM public.${t.table}`);
    }
  }
  return db;
}

/** Waits for the clock's next second, so this backup's file isn't named the same as the last one's. */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1005 - (Date.now() % 1000)));
const inAMinute = () => Date.now() + 60_000;

beforeEach(() => {
  storage.files.clear();
  storage.uploads = 0;
  storage.takenBefore = false;
  storage.headAfter = null;
  storage.refuse = null;
  gate.now = null;
  vi.mocked(recordHeartbeat).mockClear();
  vi.mocked(r2Upload).mockClear();
});

describe('which tables a backup copies', () => {
  /** Every table a migration from 359 on makes, comments aside. */
  const made = new Map<string, string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => /^\d{3}-.*\.sql$/.test(f) && Number(f.slice(0, 3)) >= 359).sort()) {
    const sql = migration(file).replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
      if (!made.has(m[1].toLowerCase())) made.set(m[1].toLowerCase(), file);
    }
  }

  it('copies every table a migration from 359 on makes, or says why it is not the books', () => {
    expect(made.size).toBeGreaterThan(100);
    expect([...made.keys()].filter((t) => !BACKUP_TABLES.includes(t) && !(t in NOT_BOOKS))).toEqual([]);
  });

  it('names each table once, on one list, and only tables a migration made', () => {
    expect(new Set(BACKUP_TABLES).size).toBe(BACKUP_TABLES.length);
    expect(BACKUP_TABLES.filter((t) => t in NOT_BOOKS)).toEqual([]);
    expect([...BACKUP_TABLES, ...Object.keys(NOT_BOOKS)].filter((t) => !made.has(t))).toEqual([]);
    for (const t of BACKUP_TABLES) expect(t).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
    for (const why of Object.values(NOT_BOOKS)) expect(why.trim().length).toBeGreaterThan(5);
  });

  it('copies the journal, its months, the switches and the year closes, and not its own record', () => {
    for (const t of [...JOURNAL, 'books_switches', 'netsuite_sends', 'gl_year_closes', 'gl_year_close_events']) expect(BACKUP_TABLES).toContain(t);
    expect(BACKUP_TABLES).not.toContain('books_backups');
  });
});

describe('CSV as Postgres COPY reads it', () => {
  const tricky: (string | null)[][] = [
    ['plain', '', null, '0'],
    ['with, comma', 'with "quote"', 'two\nlines', 'crlf\r\nline'],
    ['"', '""', ',', '\\N'],
    ['ünïcödé — ✓', ' spaced ', 'NULL', 'null'],
  ];

  it('quotes every value and leaves NULL an empty field without quotes', () => {
    expect(csvValue(null)).toBe('');
    expect(csvValue('')).toBe('""');
    expect(csvValue('say "hi"')).toBe('"say ""hi"""');
    expect(csvRow(['a', null, ''])).toBe('"a",,""\n');
  });

  it('reads back exactly what it wrote, NULL apart from empty text', () => {
    expect([...csvRows(tricky.map(csvRow).join(''))]).toEqual(tricky);
  });

  it("reads Postgres's own unquoted values and \\r\\n line ends", () => {
    expect([...csvRows('id,amount,note\r\n1,12.50,\r\n2,,"x"')]).toEqual([['id', 'amount', 'note'], ['1', '12.50', null], ['2', null, 'x']]);
    expect([...csvRows('')]).toEqual([]);
    expect([...csvRows('\n')]).toEqual([[null]]);
  });

  it('refuses a quoted value that never ends, or that runs on', () => {
    expect(() => [...csvRows('"open,1\n')]).toThrow('A quoted value never ends.');
    expect(() => [...csvRows('"a"b,1\n')]).toThrow('A value runs on into "b".');
  });
});

describe('amounts in whole cents', () => {
  it('reads an amount exactly', () => {
    expect(exactCents('1250.50')).toBe(125050);
    expect(exactCents('-0.01')).toBe(-1);
    expect(exactCents(' 7 ')).toBe(700);
    expect(exactCents('12.3')).toBe(1230);
    expect(exactCents('12.300')).toBe(1230);
    expect(Object.is(exactCents('-0.00'), 0)).toBe(true);
    expect(exactCents('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('refuses fractions of a cent, words, and amounts too large to add up exactly', () => {
    expect(() => exactCents('12.345')).toThrow("An amount FleetSuite can't read: 12.345");
    expect(() => exactCents('1e5')).toThrow("An amount FleetSuite can't read: 1e5");
    expect(() => exactCents('')).toThrow("An amount FleetSuite can't read");
    expect(() => exactCents('90071992547409.93')).toThrow('An amount too large to add up exactly: 90071992547409.93');
  });

  it('says cents as money', () => {
    expect(moneyText(-123456)).toBe('-$1,234.56');
    expect(moneyText(5)).toBe('$0.05');
    expect(moneyText(0)).toBe('$0.00');
    expect(moneyText(100000000)).toBe('$1,000,000.00');
  });
});

describe('names, times and the order to load', () => {
  it('names a backup by the moment it began, in UTC, as its record allows', () => {
    const at = new Date('2026-11-03T08:11:05.987Z');
    expect(backupName(at)).toBe('fleetsuite-books-2026-11-03-081105Z');
    expect(backupFilePath(at)).toBe('2026/fleetsuite-books-2026-11-03-081105Z.zip');
    const check = /file_path ~ '([^']+)'/.exec(migration('506-books-backups.sql'))![1];
    expect(backupFilePath(at)).toMatch(new RegExp(check));
    expect(backupFilePath(new Date('2026-12-31T23:59:59Z'))).toBe('2026/fleetsuite-books-2026-12-31-235959Z.zip');
  });

  it('reads a moment as Postgres writes it', () => {
    expect(pgTime('2026-11-03 08:11:00.123456+00').toISOString()).toBe('2026-11-03T08:11:00.123Z');
    expect(pgTime('2026-11-03 08:11:00+00').toISOString()).toBe('2026-11-03T08:11:00.000Z');
    expect(pgTime('2026-11-03T02:11:00.5-06:00').toISOString()).toBe('2026-11-03T08:11:00.500Z');
  });

  it('loads each table after the ones its foreign keys point at, a table pointing at itself or outside aside', () => {
    expect(loadOrder([
      { table: 'gl_lines', parents: ['gl_entries', 'gl_accounts', 'gl_companies'] },
      { table: 'gl_entries', parents: ['gl_companies', 'gl_entries', 'gl_periods'] },
      { table: 'gl_accounts', parents: ['gl_accounts', 'gl_companies', 'profiles'] },
      { table: 'gl_periods', parents: ['gl_companies'] },
      { table: 'gl_companies', parents: [] },
    ])).toEqual(['gl_companies', 'gl_accounts', 'gl_periods', 'gl_entries', 'gl_lines']);
  });

  it('takes the first as listed when foreign keys go round in a loop, then what that lets go', () => {
    expect(loadOrder([
      { table: 'a', parents: ['b'] },
      { table: 'b', parents: ['a'] },
      { table: 'c', parents: ['b'] },
    ])).toEqual(['a', 'b', 'c']);
    // Only the first breaks the loop: c, its parent loaded, goes ahead of b, which still waits on c.
    expect(loadOrder([
      { table: 'a', parents: ['c'] },
      { table: 'b', parents: ['c'] },
      { table: 'c', parents: ['a'] },
    ])).toEqual(['a', 'c', 'b']);
  });

  it('runs nightly at 08:11 UTC, 2:11 AM Central', () => {
    expect(nextNightly(new Date('2026-11-03T08:10:59Z')).toISOString()).toBe('2026-11-03T08:11:00.000Z');
    expect(nextNightly(new Date('2026-11-03T08:11:00Z')).toISOString()).toBe('2026-11-04T08:11:00.000Z');
    expect(nextNightly(new Date('2026-12-31T23:00:00Z')).toISOString()).toBe('2027-01-01T08:11:00.000Z');
  });

  it('is due 26 hours after the last good one', () => {
    const now = new Date('2026-11-03T09:58:00Z');
    expect(backupDue(null, now)).toBe(true);
    expect(backupDue({ startedAt: '2026-11-02T08:11:00Z' }, now)).toBe(false);
    expect(backupDue({ startedAt: '2026-11-02T07:57:59Z' }, now)).toBe(true);
  });

  it('says why storage that isn\'t confirmed private takes no copy', () => {
    expect(storageProblem({ enabled: true })).toBeNull();
    expect(storageProblem({ enabled: false })).toBe("BMG's file storage isn't confirmed private (docs/r2-private-flip.md), so no copy of the books goes there.");
    expect(storageProblem({ enabled: false, readError: 'timeout' })).toBe("FleetSuite couldn't check that BMG's file storage is private (timeout), so no copy of the books goes there.");
  });

  it("reads a backup's row, one still running after ten minutes as stopped", () => {
    const now = new Date('2026-11-03T09:58:00Z');
    const row = {
      id: 'b1', how: 'nightly', asked_by_name: null, started_at: '2026-11-03T08:11:00.000Z', finished_at: '2026-11-03T08:11:40.000Z',
      status: 'made', file_path: '2026/fleetsuite-books-2026-11-03-081100Z.zip', file_bytes: '2048', file_sha256: 'ab'.repeat(32),
      table_count: 90, row_count: '12000', entry_count: '300', line_count: '900', checked: true, error: null,
    };
    expect(recordOf(row, now)).toEqual({
      id: 'b1', how: 'nightly', askedBy: null, startedAt: '2026-11-03T08:11:00.000Z', finishedAt: '2026-11-03T08:11:40.000Z',
      status: 'made', file: '2026/fleetsuite-books-2026-11-03-081100Z.zip', fileName: 'fleetsuite-books-2026-11-03-081100Z.zip',
      bytes: 2048, sha256: 'ab'.repeat(32), tables: 90, rows: 12000, entries: 300, lines: 900, checked: true, error: null,
    });
    const running = { ...row, status: 'running', finished_at: null, file_path: null, file_bytes: null, file_sha256: null, checked: null };
    expect(recordOf({ ...running, started_at: '2026-11-03T09:49:00Z' }, now)).toMatchObject({ status: 'running', error: null, file: null, fileName: null, bytes: null });
    expect(recordOf({ ...running, started_at: '2026-11-03T09:47:59Z' }, now)).toMatchObject({ status: 'stopped', error: 'It stopped before it finished.' });
  });
});

describe("checking a backup's zip", () => {
  const ENTRY_COLUMNS = ['id', 'entry_no'];
  const LINE_COLUMNS = ['entry_id', 'company_id', 'account_id', 'debit', 'credit'];
  const columns = (names: string[]) => names.map((name) => ({ name, type: 'text' }));
  const tb = {
    entries: 2,
    lines: 4,
    accounts: [
      { company_id: 'c1', account_id: 'a1', debit: '100.00', credit: '0.00' },
      { company_id: 'c1', account_id: 'a2', debit: '0.00', credit: '100.00' },
    ],
  };
  const LINES = [
    ['e1', 'c1', 'a1', '60.00', '0.00'], ['e1', 'c1', 'a2', '0.00', '60.00'],
    ['e2', 'c1', 'a1', '40.00', '0.00'], ['e2', 'c1', 'a2', '0.00', '40.00'],
  ];

  /** A zip of the journal's two files and the manifest that describes them. */
  async function zipOf(over: { entries?: (string | null)[][]; lines?: (string | null)[][]; header?: string[]; drop?: string; tamper?: boolean } = {}) {
    const files: Record<string, string> = {
      'tables/gl_entries.csv': [csvRow(over.header ?? ENTRY_COLUMNS), ...(over.entries ?? [['e1', '1'], ['e2', '2']]).map(csvRow)].join(''),
      'tables/gl_lines.csv': [csvRow(LINE_COLUMNS), ...(over.lines ?? LINES).map(csvRow)].join(''),
    };
    const manifest = {
      tables: [
        { table: 'gl_entries', file: 'tables/gl_entries.csv', sha256: sha256(Buffer.from(files['tables/gl_entries.csv'])), columns: columns(ENTRY_COLUMNS) },
        { table: 'gl_lines', file: 'tables/gl_lines.csv', sha256: sha256(Buffer.from(files['tables/gl_lines.csv'])), columns: columns(LINE_COLUMNS) },
      ],
    };
    const zip = new JSZip();
    for (const [file, text] of Object.entries(files)) {
      if (file !== over.drop) zip.file(`books/${file}`, over.tamper && file === 'tables/gl_lines.csv' ? `${text}\n` : text);
    }
    return { bytes: await zip.generateAsync({ type: 'nodebuffer' }), manifest };
  }
  const named = {
    companyCode: new Map([['c1', 'BMG']]),
    accountOf: new Map([['a1', { number: '11000', name: 'Accounts Receivable' }], ['a2', { number: null, name: 'Upfit Sales' }]]),
  };

  it('passes a copy that adds up to the books', async () => {
    const { bytes, manifest } = await zipOf();
    expect(await checkBackup(bytes, { name: 'books', manifest, tb, ...named })).toBeNull();
  });

  it('says a file is missing or not what was written', async () => {
    const missing = await zipOf({ drop: 'tables/gl_lines.csv' });
    expect(await checkBackup(missing.bytes, { name: 'books', manifest: missing.manifest, tb })).toBe('The backup has no tables/gl_lines.csv.');
    const tampered = await zipOf({ tamper: true });
    expect(await checkBackup(tampered.bytes, { name: 'books', manifest: tampered.manifest, tb })).toBe("tables/gl_lines.csv in the backup isn't what was written.");
  });

  it("says a file that doesn't start with its columns can't be read back", async () => {
    const { bytes, manifest } = await zipOf({ header: ['id', 'number'] });
    expect(await checkBackup(bytes, { name: 'books', manifest, tb })).toBe("The backup's journal couldn't be read back: tables/gl_entries.csv doesn't start with its columns.");
  });

  it('says how many entries and lines the copy has, against the books', async () => {
    const oneEntry = await zipOf({ entries: [['e1', '1']] });
    expect(await checkBackup(oneEntry.bytes, { name: 'books', manifest: oneEntry.manifest, tb }))
      .toBe("The backup's journal has 1 entry, and the books had 2 entries when it began.");
    const threeLines = await zipOf({ lines: LINES.slice(0, 3) });
    expect(await checkBackup(threeLines.bytes, { name: 'books', manifest: threeLines.manifest, tb }))
      .toBe("The backup's journal has 3 lines, and the books had 4 lines when it began.");
  });

  it('names the account that adds up differently, cent for cent', async () => {
    const off = await zipOf({ lines: [['e1', 'c1', 'a1', '60.01', '0.00'], ['e1', 'c1', 'a2', '0.00', '60.01'], ...LINES.slice(2)] });
    expect(await checkBackup(off.bytes, { name: 'books', manifest: off.manifest, tb, ...named })).toBe(
      "The backup's journal adds up differently for 11000 Accounts Receivable (BMG): $100.01 of debits and $0.00 of credits, and the books had $100.00 and $0.00.",
    );
    expect(await checkBackup(off.bytes, { name: 'books', manifest: off.manifest, tb })).toBe(
      "The backup's journal adds up differently for account a1: $100.01 of debits and $0.00 of credits, and the books had $100.00 and $0.00.",
    );
  });

  it("names an account the copy has lines on that the books didn't", async () => {
    const extra = await zipOf({ lines: [...LINES.slice(0, 3), ['e2', 'c1', 'a3', '0.00', '40.00']] });
    const books = { ...tb, accounts: [tb.accounts[0], { ...tb.accounts[1], credit: '60.00' }] };
    expect(await checkBackup(extra.bytes, { name: 'books', manifest: extra.manifest, tb: books, ...named }))
      .toBe("The backup's journal has lines on account a3 (BMG), which the books didn't have when it began.");
  });

  it("says an amount it can't read", async () => {
    const bad = await zipOf({ lines: [['e1', 'c1', 'a1', '60.005', '0.00'], ...LINES.slice(1)] });
    expect(await checkBackup(bad.bytes, { name: 'books', manifest: bad.manifest, tb }))
      .toBe("The backup's journal couldn't be read back: An amount FleetSuite can't read: 60.005");
  });
});

describe('a backup of the books, and a restore from it', () => {
  let pg: PGlite;
  const acct: Record<string, string> = {};
  let keySeq = 0;
  const post = async (over: Record<string, unknown>) => {
    keySeq += 1;
    const r = await pg.query<{ r: { id: string; entry_no: number } }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify({
      company: 'BMG', entry_date: '2026-11-03', source_type: 'invoice', source_id: `INV${1000 + keySeq}`, posting_rule: 'invoice@1',
      idempotency_key: `backup-test:${keySeq}`, ...over,
    })]);
    return r.rows[0].r;
  };
  const record = async (id: string | null) => (await pg.query<any>('SELECT * FROM books_backups WHERE id = $1', [id])).rows[0];
  const count = async (sql: string) => Number((await pg.query<{ n: number }>(sql)).rows[0].n);

  /** Before the entry posted mid-run: what the restore has to hold. */
  let before: Record<string, unknown[]>;
  let made: Awaited<ReturnType<typeof runBackup>>;
  let zipBytes: Buffer;
  /** What storage held and sync_state was told after it, before each test starts afresh. */
  let stored: string[];
  let told: unknown[];
  /** The tables it read a page of, in order. */
  const pages: string[] = [];

  beforeAll(async () => {
    pg = await booksDb();
    await pg.exec('SET ROLE service_role');
    const companies = await pg.query<{ id: string; code: string }>('SELECT id, code FROM gl_companies');
    const coolSprings = companies.rows.find((c) => c.code === '1084')!.id;
    const accounts = await pg.query<{ id: string; number: string }>(
      `INSERT INTO gl_accounts (number, name, account_type, is_control, company_id, active) VALUES
         ('10100', 'First Bank Operating', 'bank', false, NULL, true),
         ('11000', 'Accounts Receivable', 'accounts_receivable', true, NULL, true),
         ('40000', 'Upfit Sales', 'income', false, NULL, true),
         ('41000', 'Rent Income', 'income', false, $1, true),
         ('49999', 'Old Sales', 'income', false, NULL, false)
       RETURNING id, number`,
      [coolSprings],
    );
    for (const a of accounts.rows) acct[a.number] = a.id;
    await pg.query(`INSERT INTO gl_accounts (number, name, account_type, parent_id) VALUES ('40100', 'Upfit Sales, Labor', 'income', $1)`, [acct['40000']]);

    // October's invoice, the month closed, then November's payment, 1084's rent, and the payment reversed.
    await post({
      entry_date: '2026-10-15', memo: 'INV1001, Acme "Fleet"\nsecond line',
      lines: [{ account_id: acct['11000'], debit: '1250.50' }, { account_id: acct['40000'], credit: '1250.50', division: 'upfit', memo: 'Upfit labor' }],
    });
    await pg.query(`SELECT gl_set_period_status('BMG', DATE '2026-10-01', 'closed', $1::uuid, 'Craig', NULL)`, [CRAIG]);
    const payment = await post({
      source_type: 'payment', source_id: 'PYMT1', posting_rule: 'payment@1',
      lines: [{ account_id: acct['10100'], debit: '1250.50' }, { account_id: acct['11000'], credit: '1250.50' }],
    });
    await post({
      company: '1084', entry_date: '2026-11-01', source_type: 'rent', source_id: null, posting_rule: 'rent@1', memo: 'November rent',
      lines: [{ account_id: acct['10100'], debit: '5000.00' }, { account_id: acct['41000'], credit: '5000.00' }],
    });
    await pg.query(`SELECT gl_reverse_entry($1::uuid, DATE '2026-11-04', NULL, $2::uuid, 'Craig')`, [payment.id, CRAIG]);

    // The nightly backup, two rows and two journal entries a page, with an invoice posted while it reads the journal.
    let posted = false;
    made = await runBackup(serviceOver(pg, async (fn, p, real) => {
      if (fn === 'books_backup_page') pages.push(p.table);
      if (fn === 'books_backup_journal' && !posted) {
        posted = true;
        before = await dump(pg);
        await post({ entry_date: '2026-11-05', lines: [{ account_id: acct['11000'], debit: '99.99' }, { account_id: acct['40000'], credit: '99.99' }] });
      }
      return real();
    }), { how: 'nightly', deadline: inAMinute(), tables: JOURNAL, pageRows: 2, journalEntries: 2 });
    stored = [...storage.files.keys()];
    zipBytes = [...storage.files.values()][0];
    told = vi.mocked(recordHeartbeat).mock.calls.at(-1)!;
  }, 60_000);

  afterAll(async () => { await pg?.close(); });

  it('makes it, keeps it under books-backups/ and writes it to its record and sync_state', async () => {
    expect(made).toMatchObject({ state: 'made', error: null });
    expect(made.file).toMatch(/^\d{4}\/fleetsuite-books-\d{4}-\d{2}-\d{2}-\d{6}Z\.zip$/);
    expect(stored).toEqual([`${BACKUP_PREFIX}/${made.file}`]);
    expect(made.bytes).toBe(zipBytes.length);
    const row = await record(made.id);
    expect(row).toMatchObject({
      how: 'nightly', asked_by: null, asked_by_name: null, status: 'made', file_path: made.file, file_sha256: sha256(zipBytes),
      table_count: 6, entry_count: 4, line_count: 8, checked: true, error: null, migration: '506-books-backups.sql',
    });
    expect(Number(row.file_bytes)).toBe(zipBytes.length);
    expect(made.file).toBe(backupFilePath(row.started_at));
    const rows = Object.values(before).reduce((n, t) => n + t.length, 0);
    expect(Number(row.row_count)).toBe(rows);
    expect(told).toEqual([
      expect.anything(), BOOKS_BACKUP,
      { how: 'nightly', id: made.id, state: 'made', file: made.file, bytes: zipBytes.length, tables: 6, rows, entries: 4, lines: 8, checked: true },
      expect.objectContaining({ records: rows, touchLastSyncedAt: true }),
    ]);
  });

  it('holds each table as CSV, the journal workbook, the manifest and the README, each file as the manifest says', async () => {
    const { zip, name, manifest } = await opened(zipBytes);
    expect(name).toBe(made.file!.split('/')[1].replace(/\.zip$/, ''));
    expect(Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort()).toEqual([
      `${name}/${name}-journal.xlsx`, `${name}/README.txt`, `${name}/manifest.json`,
      ...JOURNAL.map((t) => `${name}/tables/${t}.csv`).sort(),
    ].sort());
    const row = await record(made.id);
    expect(manifest).toMatchObject({
      format: BACKUP_FORMAT, how: 'nightly', asked_by: null, snapshot: row.snapshot, migration: '506-books-backups.sql',
      load_order: JOURNAL,
      journal: { workbook: `${name}-journal.xlsx`, entries: 4, lines: 8 },
    });
    expect(manifest.made_at).toBe(new Date(row.started_at).toISOString());
    for (const t of manifest.tables) {
      const bytes = await zip.file(`${name}/${t.file}`)!.async('uint8array');
      expect(sha256(bytes), t.table).toBe(t.sha256);
      expect(bytes.length).toBe(t.bytes);
      expect(t.rows, t.table).toBe(before[t.table].length);
    }
    const lines = manifest.tables.find((t: any) => t.table === 'gl_lines');
    expect(lines).toMatchObject({ key: ['id'], identity: [], parents: ['gl_accounts', 'gl_companies', 'gl_entries'] });
    expect(manifest.tables.find((t: any) => t.table === 'gl_entries').identity).toEqual(['entry_no']);
    expect(manifest.tables.find((t: any) => t.table === 'gl_accounts').generated).toEqual(['normal_balance', 'statement']);
    const readme = await zip.file(`${name}/README.txt`)!.async('string');
    expect(readme).toContain("1. Run FleetSuite's migrations up to 506-books-backups.sql on an empty database.");
    expect(readme).toContain(`\\copy public.<table> (<its columns>) FROM '${name}/tables/<table>.csv' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')`);
  });

  it('leaves out the entry posted while it ran, and still adds up', async () => {
    const { manifest } = await opened(zipBytes);
    expect(await count('SELECT count(*)::int AS n FROM gl_entries')).toBe(5);
    expect(manifest.journal.entries).toBe(4);
    const tb = manifest.journal.trial_balance.map((a: any) => [a.debit, a.credit]);
    expect(tb.sort()).toEqual([['0.00', '1250.50'], ['0.00', '5000.00'], ['1250.50', '1250.50'], ['2501.00', '1250.50'], ['5000.00', '0.00']].sort());
  });

  it('reads each table before the tables it points at, so each row read has its parents in the copy', () => {
    // The companies and the chart of accounts first, for the workbook; the journal as of the snapshot, apart.
    expect([...new Set(pages)]).toEqual(['gl_companies', 'gl_accounts', 'gl_period_events', 'gl_periods']);
    // A page at a time, each table read on to its end.
    expect(pages.filter((t) => t === 'gl_accounts').length).toBeGreaterThan(1);
  });

  it('restores into an empty database as docs/books.md says, every row as it was', async () => {
    const db = await restore(zipBytes);
    try {
      expect(await dump(db)).toEqual(before);
      // The journal adds up there as it did here.
      const { manifest } = await opened(zipBytes);
      const tb = (await db.query<{ r: any }>(`SELECT books_backup_trial_balance(p => jsonb_build_object('snapshot', txid_current_snapshot()::text)) AS r`)).rows[0].r;
      expect(tb).toEqual({ entries: 4, lines: 8, accounts: manifest.journal.trial_balance });
      // Posting goes on from the next entry number, and October stays closed.
      const r = await db.query<{ r: { entry_no: number } }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify({
        company: 'BMG', entry_date: '2026-11-06', source_type: 'invoice', source_id: 'INV2001', posting_rule: 'invoice@1', idempotency_key: 'after-restore:1',
        lines: [{ account_id: acct['11000'], debit: '10.00' }, { account_id: acct['40000'], credit: '10.00' }],
      })]);
      expect(Number(r.rows[0].r.entry_no)).toBe(5);
      await expect(db.query('SELECT gl_post_entry($1::jsonb)', [JSON.stringify({
        company: 'BMG', entry_date: '2026-10-20', source_type: 'invoice', source_id: 'INV2002', posting_rule: 'invoice@1', idempotency_key: 'after-restore:2',
        lines: [{ account_id: acct['11000'], debit: '10.00' }, { account_id: acct['40000'], credit: '10.00' }],
      })])).rejects.toThrow(/closed/);
    } finally {
      await db.close();
    }
  });

  it('puts the journal in the workbook: trial balance, chart of accounts and every line', async () => {
    const { zip, name } = await opened(zipBytes);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await zip.file(`${name}/${name}-journal.xlsx`)!.async('uint8array')) as any);
    expect(book.worksheets.map((s) => s.name)).toEqual(['Read me', 'Trial balance', 'Chart of accounts', 'Journal']);
    const values = (sheet: string) => book.getWorksheet(sheet)!.getSheetValues().filter(Boolean).map((r: any) => r.slice(1));

    const tb = values('Trial balance');
    expect(tb[1]).toEqual(['BMG Fleet Installations (BMG)']);
    expect(tb.slice(2, 6)).toEqual([
      ['10100', 'First Bank Operating', 1250.5, 1250.5, 0],
      ['11000', 'Accounts Receivable', 2501, 1250.5, 1250.5],
      ['40000', 'Upfit Sales', 0, 1250.5, -1250.5],
      [undefined, 'Total', 3751.5, 3751.5, 0],
    ]);
    expect(tb.slice(6, 10)).toEqual([
      ['1084 Cool Springs (1084)'],
      ['10100', 'First Bank Operating', 5000, 0, 5000],
      ['41000', 'Rent Income', 0, 5000, -5000],
      [undefined, 'Total', 5000, 5000, 0],
    ]);

    const chart = values('Chart of accounts');
    expect(chart.find((r) => r[0] === '40100')).toEqual(['40100', 'Upfit Sales, Labor', 'Income', 'Every company', undefined, undefined, 'Yes', '40000']);
    expect(chart.find((r) => r[0] === '41000')!.slice(0, 4)).toEqual(['41000', 'Rent Income', 'Income', '1084']);
    expect(chart.find((r) => r[0] === '11000')![5]).toBe('Yes');
    expect(chart.find((r) => r[0] === '49999')![6]).toBe('No');

    const journal = values('Journal');
    expect(journal).toHaveLength(9);
    expect(journal.slice(1).map((r) => [r[0], r[1], r[3], r[5] ?? 0, r[6] ?? 0])).toEqual([
      ['BMG', 1, '11000', 1250.5, 0], ['BMG', 1, '40000', 0, 1250.5],
      ['BMG', 2, '10100', 1250.5, 0], ['BMG', 2, '11000', 0, 1250.5],
      ['1084', 3, '10100', 5000, 0], ['1084', 3, '41000', 0, 5000],
      ['BMG', 4, '10100', 0, 1250.5], ['BMG', 4, '11000', 1250.5, 0],
    ]);
    const [first] = journal.slice(1);
    expect(first[2]).toEqual(new Date('2026-10-15T00:00:00Z'));
    expect(first[4]).toBe('Accounts Receivable');
    expect(first[7]).toBe('INV1001, Acme "Fleet"\nsecond line');
    expect(first[8]).toBeUndefined();
    expect(journal[2].slice(8, 10)).toEqual(['Upfit labor', 'upfit']);
    expect(first[14]).toBe('invoice INV1001');
    expect(journal[5][14]).toBe('rent');
    expect(journal[7].slice(14, 19)).toEqual(['reversal', 'reversal', expect.stringMatching(/^\d+\/\d+\/\d+, \d+:\d+ [AP]M$/), 'Craig', 2]);

    expect(values('Read me')[0]).toEqual(["FleetSuite's books"]);
    expect(values('Read me')[2][0]).toContain('4 entries and 8 lines');
  });

  it('copies the entry posted while the last one ran in the next one', async () => {
    await nextSecond();
    // Asked for in another order, it still loads each table after the ones it points at.
    const next = await runBackup(serviceOver(pg), { how: 'nightly', deadline: inAMinute(), tables: [...JOURNAL].reverse() });
    expect(next.state).toBe('made');
    expect(next.file).not.toBe(made.file);
    const { manifest } = await opened(storage.files.get(`${BACKUP_PREFIX}/${next.file}`)!);
    expect(manifest.journal).toMatchObject({ entries: 5, lines: 10 });
    expect(manifest.tables.map((t: any) => t.table)).toEqual([...JOURNAL].reverse());
    expect(manifest.load_order).toEqual(['gl_companies', 'gl_periods', 'gl_accounts', 'gl_entries', 'gl_period_events', 'gl_lines']);
  });

  it('keeps who pressed Back up now', async () => {
    await nextSecond();
    const byHand = await runBackup(serviceOver(pg), { how: 'by_hand', by: CRAIG, byName: 'Craig George', deadline: inAMinute(), tables: JOURNAL });
    expect(byHand.state).toBe('made');
    expect(await record(byHand.id)).toMatchObject({ how: 'by_hand', asked_by: CRAIG, asked_by_name: 'Craig George' });
    const { manifest } = await opened(storage.files.get(`${BACKUP_PREFIX}/${byHand.file}`)!);
    expect(manifest).toMatchObject({ how: 'by_hand', asked_by: 'Craig George' });
  });

  it('says one already running, and starts no second', async () => {
    const r = await pg.query<{ r: any }>(`SELECT books_backup_begin(p => $1::jsonb) AS r`, [JSON.stringify({ how: 'nightly', tables: JOURNAL })]);
    const running = r.rows[0].r;
    try {
      const again = await runBackup(serviceOver(pg), { how: 'by_hand', by: CRAIG, byName: 'Craig George', deadline: inAMinute(), tables: JOURNAL });
      expect(again).toEqual({ state: 'running', id: running.id, startedAt: running.started_at, file: null, bytes: null, error: null });
      expect(storage.uploads).toBe(0);
      expect(recordHeartbeat).not.toHaveBeenCalled();
    } finally {
      await pg.query(`SELECT books_backup_finish(p => $1::jsonb)`, [JSON.stringify({ id: running.id, status: 'failed', error: 'Test over.' })]);
    }
  });

  it("says why it couldn't start", async () => {
    const r = await runBackup(serviceOver(pg), { how: 'nightly', deadline: inAMinute(), tables: ['gl_entries', 'nope'] });
    expect(r).toMatchObject({ state: 'failed', id: null, error: "Couldn't start a backup: books: nope isn't a table there is to back up" });
    expect(recordHeartbeat).toHaveBeenCalledWith(
      expect.anything(), BOOKS_BACKUP, expect.objectContaining({ state: 'failed', error: r.error }), expect.objectContaining({ touchLastSyncedAt: false }),
    );
  });

  /**
   * Runs one that fails and checks its record and sync_state say why;
   * `kept` is whether its zip reached storage and its record names it.
   */
  const fails = async (opts: { hook?: Hook; deadline?: number }, error: string | ((row: any) => string | Promise<string>), kept: boolean) => {
    if (kept) await nextSecond();
    const r = await runBackup(serviceOver(pg, opts.hook), { how: 'nightly', deadline: opts.deadline ?? inAMinute(), tables: JOURNAL });
    const row = await record(r.id);
    const why = typeof error === 'string' ? error : await error(row);
    expect(r).toMatchObject({ state: 'failed', error: why });
    expect(row).toMatchObject({ status: 'failed', error: why });
    expect(row.file_path !== null).toBe(kept);
    expect(r.file !== null).toBe(kept);
    expect(storage.files.size).toBe(kept ? 1 : 0);
    expect(recordHeartbeat).toHaveBeenLastCalledWith(
      expect.anything(), BOOKS_BACKUP, expect.objectContaining({ state: 'failed', error: why }), expect.objectContaining({ touchLastSyncedAt: false }),
    );
    return { r, row };
  };
  const fileName = async (row: any) => (await pg.query<{ f: string }>(
    `SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY/"fleetsuite-books-"YYYY-MM-DD-HH24MISS"Z.zip"') AS f FROM books_backups WHERE id = $1`, [row.id],
  )).rows[0].f;

  it('names its file by the moment it began', async () => {
    expect(made.file).toBe(await fileName(await record(made.id)));
    const row = await record(made.id);
    const { manifest } = await opened(zipBytes);
    expect(Math.abs(Date.parse(manifest.made_at) - new Date(row.started_at).getTime())).toBeLessThanOrEqual(1);
  });

  it("copies nothing to storage that isn't confirmed private", async () => {
    gate.now = { enabled: false, reason: 'Off — ledger PDFs are not written until the R2 privacy flip is verified', via: null };
    await fails({}, "BMG's file storage isn't confirmed private (docs/r2-private-flip.md), so no copy of the books goes there.", false);
    gate.now = { enabled: false, reason: 'Could not read the gate — timeout', via: null, readError: 'timeout' };
    await fails({}, "FleetSuite couldn't check that BMG's file storage is private (timeout), so no copy of the books goes there.", false);
    expect(storage.uploads).toBe(0);
  });

  it('stops when a table or the journal changes shape while it is read', async () => {
    await fails({
      hook: async (fn, p, real) => {
        const r = await real();
        if (fn === 'books_backup_page' && p.table === 'gl_periods') r.data.columns = [...r.data.columns, 'added_later'];
        return r;
      },
    }, 'gl_periods changed while it was being copied. The next backup copies it as it is now.', false);
    await fails({
      hook: async (fn, p, real) => {
        const r = await real();
        if (fn === 'books_backup_journal') r.data.line_columns = r.data.line_columns.slice(1);
        return r;
      },
    }, 'The journal changed shape while it was being copied. The next backup copies it as it is now.', false);
    await fails({
      hook: async (fn, p, real) => {
        const r = await real();
        if (fn === 'books_backup_journal') r.data.entry_columns = [...r.data.entry_columns, 'added_later'];
        return r;
      },
    }, 'The journal changed shape while it was being copied. The next backup copies it as it is now.', false);
    expect(storage.uploads).toBe(0);
  });

  it('stops when it runs out of time, and says how far it got', async () => {
    await fails({ deadline: Date.now() - 1 }, 'It ran out of time with 0 of 6 tables copied.', false);
    // The companies take longer than the time left, so the chart of accounts is never read.
    let pages = 0;
    await fails({
      deadline: Date.now() + 200,
      hook: async (fn, p, real) => {
        if (fn === 'books_backup_page') {
          pages += 1;
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        return real();
      },
    }, 'It ran out of time with 1 of 6 tables copied.', false);
    expect(pages).toBe(1);
  });

  it('says what went wrong when the database does', async () => {
    await fails({
      hook: async (fn, p, real) => (fn === 'books_backup_trial_balance' ? { data: null, error: { message: 'canceling statement due to statement timeout' } } : real()),
    }, 'Something went wrong: canceling statement due to statement timeout', false);
  });

  it("won't write over a backup already in storage", async () => {
    storage.takenBefore = true;
    await fails({}, async (row) => `A backup named ${await fileName(row)} is already in storage, so this one wasn't written over it.`, false);
    expect(storage.uploads).toBe(0);
  });

  it("says storage wouldn't take it", async () => {
    storage.refuse = 'Access Denied';
    await fails({}, "Couldn't keep it in BMG's file storage: Access Denied.", false);
  });

  it('keeps one storage holds differently for a look, and says so', async () => {
    storage.headAfter = (sent) => ({ bytes: sent.length - 1, etag: null });
    await fails({}, (row) => `BMG's file storage holds ${Number(row.file_bytes) - 1} bytes of the ${Number(row.file_bytes)} sent.`, true);
    storage.files.clear();
    storage.headAfter = (sent) => ({ bytes: sent.length, etag: 'f'.repeat(32) });
    await fails({}, "BMG's file storage holds different bytes from the ones sent.", true);
    storage.files.clear();
    storage.headAfter = () => null;
    await fails({}, "BMG's file storage doesn't show the file after it was sent.", true);
  });

  it("takes storage's word for the size when its ETag isn't an MD5", async () => {
    storage.headAfter = (sent) => ({ bytes: sent.length, etag: '9b2cf535f27731c974343645a3985328-2' });
    await nextSecond();
    const r = await runBackup(serviceOver(pg), { how: 'nightly', deadline: inAMinute(), tables: JOURNAL });
    expect(r).toMatchObject({ state: 'made', error: null });
  });

  it("keeps one whose journal doesn't add up to the books for a look, and says which account", async () => {
    const { row } = await fails({
      hook: async (fn, p, real) => {
        const r = await real();
        if (fn === 'books_backup_trial_balance') {
          r.data.accounts = r.data.accounts.map((a: any) => (a.account_id === acct['41000'] ? { ...a, credit: '5000.01' } : a));
        }
        return r;
      },
    }, "The backup's journal adds up differently for 41000 Rent Income (1084): $0.00 of debits and $5,000.00 of credits, and the books had $0.00 and $5,000.01.", true);
    expect(row.checked).toBe(false);
  });

  it("says when the record won't take how it went", async () => {
    await nextSecond();
    const r = await runBackup(serviceOver(pg, async (fn, p, real) => (
      fn === 'books_backup_finish' && p.status === 'made' ? { data: null, error: { message: 'permission denied for table books_backups' } } : real()
    )), { how: 'nightly', deadline: inAMinute(), tables: JOURNAL });
    const why = "The backup's record wouldn't take how it went: permission denied for table books_backups";
    expect(r).toMatchObject({ state: 'failed', error: why });
    expect(r.file).toMatch(/\.zip$/);
    expect(await record(r.id)).toMatchObject({ status: 'failed', error: why, file_path: null });
    expect(recordHeartbeat).toHaveBeenLastCalledWith(
      expect.anything(), BOOKS_BACKUP, expect.objectContaining({ state: 'failed', error: why }), expect.objectContaining({ touchLastSyncedAt: false }),
    );
  });
});

describe("Books → Backups and the daily check's look", () => {
  let pg: PGlite;
  const NOW = new Date('2026-11-03T09:58:00Z');
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000);

  /** A backup's row as a run leaves it, begun `hoursAgo`. */
  const add = async (status: 'made' | 'failed' | 'running', hoursAgo: number, error: string | null = null) => {
    const started = at(hoursAgo);
    const file = status === 'made' ? backupFilePath(started) : null;
    const r = await pg.query<{ id: string }>(
      `INSERT INTO books_backups (how, started_at, finished_at, status, snapshot, file_path, file_bytes, file_sha256,
                                  table_count, row_count, entry_count, line_count, checked, error)
       VALUES ('nightly', $1, $2, $3, '1:1:', $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        started.toISOString(), status === 'running' ? null : new Date(started.getTime() + 40_000).toISOString(), status,
        file, file ? 2048 : null, file ? 'ab'.repeat(32) : null,
        status === 'made' ? 90 : null, status === 'made' ? 12000 : null, status === 'made' ? 300 : null, status === 'made' ? 900 : null,
        status === 'made' ? true : null, status === 'failed' ? error ?? 'It ran out of time with 40 of 90 tables copied.' : null,
      ],
    );
    return { id: r.rows[0].id, startedAt: started.toISOString() };
  };

  beforeAll(async () => { pg = await booksDb(); }, 30_000);
  afterAll(async () => { await pg?.close(); });
  beforeEach(async () => { await pg.exec('TRUNCATE books_backups'); });

  it("looks only at the day's first look", async () => {
    const service = { from: () => { throw new Error('read'); } } as any;
    expect(await lookAtBackups(service, false, NOW)).toBeNull();
  });

  it('says when none has ever been made', async () => {
    expect(await lookAtBackups(serviceOver(pg), true, NOW)).toEqual({ kind: 'never', id: null, error: null, lastMadeAt: null });
  });

  it("says nothing while last night's is good", async () => {
    await add('failed', 30);
    await add('made', 1.8);
    expect(await lookAtBackups(serviceOver(pg), true, NOW)).toBeNull();
  });

  it('says the newest failed, and when the last good one was', async () => {
    const good = await add('made', 25.8);
    const bad = await add('failed', 1.8, 'Something went wrong: canceling statement due to statement timeout');
    expect(await lookAtBackups(serviceOver(pg), true, NOW)).toEqual({
      kind: 'failed', id: bad.id, error: 'Something went wrong: canceling statement due to statement timeout', lastMadeAt: good.startedAt,
    });
  });

  it('counts one that stopped mid-run as failed', async () => {
    const stuck = await add('running', 1.8);
    expect(await lookAtBackups(serviceOver(pg), true, NOW)).toEqual({ kind: 'failed', id: stuck.id, error: 'It stopped before it finished.', lastMadeAt: null });
  });

  it('says none was made in 26 hours', async () => {
    const good = await add('made', 26.1);
    expect(await lookAtBackups(serviceOver(pg), true, NOW)).toEqual({ kind: 'missed', id: null, error: null, lastMadeAt: good.startedAt });
  });

  it('lists the newest first, with the last good one, the next nightly and whether storage is private', async () => {
    const good = await add('made', 25.8);
    const bad = await add('failed', 1.8);
    const view = await loadBackups(serviceOver(pg), NOW);
    expect(view.backups.map((b) => [b.id, b.status])).toEqual([[bad.id, 'failed'], [good.id, 'made']]);
    expect(view.backups[1]).toMatchObject({ fileName: backupFilePath(at(25.8)).split('/')[1], bytes: 2048, tables: 90, rows: 12000, entries: 300, lines: 900, checked: true });
    expect(view.lastMade?.id).toBe(good.id);
    expect(view.due).toBe(false);
    expect(view.next).toBe('2026-11-04T08:11:00.000Z');
    expect(view.storageProblem).toBeNull();
    gate.now = { enabled: false, reason: 'Off', via: null };
    expect((await loadBackups(serviceOver(pg), NOW)).storageProblem).toBe("BMG's file storage isn't confirmed private (docs/r2-private-flip.md), so no copy of the books goes there.");
  });

  it('finds the last good one past the ones it lists', async () => {
    const good = await add('made', 24 * 30);
    for (let i = 0; i < BACKUPS_LISTED; i += 1) await add('failed', 24 * 29 - i);
    const view = await loadBackups(serviceOver(pg), NOW);
    expect(view.backups).toHaveLength(BACKUPS_LISTED);
    expect(view.backups.some((b) => b.id === good.id)).toBe(false);
    expect(view.lastMade?.id).toBe(good.id);
    expect(view.due).toBe(true);
  });

  it("hands a short-lived link to a made backup's zip, and none to one without a file", async () => {
    const good = await add('made', 1.8);
    const bad = await add('failed', 1);
    const path = backupFilePath(at(1.8));
    expect(await backupDownloadUrl(serviceOver(pg), good.id)).toEqual({ url: `https://files.example/${BACKUP_PREFIX}/${path}?signed`, fileName: path.split('/')[1] });
    expect(r2PresignGet).toHaveBeenCalledWith(BACKUP_PREFIX, path, { filename: path.split('/')[1], disposition: 'attachment', expiresIn: 300 });
    expect(await backupDownloadUrl(serviceOver(pg), bad.id)).toBeNull();
    expect(await backupDownloadUrl(serviceOver(pg), '00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});
