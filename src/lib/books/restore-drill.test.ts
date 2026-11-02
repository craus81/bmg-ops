// Part 85 puts each backup of FleetSuite's books back, into a scratch
// database made from FleetSuite's own migrations, and checks the books came
// back whole. This makes that scratch database from the latest migrations
// the way the nightly drill does, so a migration it can't run fails here
// first; holds how the drill picks its migrations and compares each table's
// shape; then backs up a copy of the books with every table, restores it and
// finds every row as it was; breaks it each way it can break, from the file
// in storage to the trial balance; and reads the drills back for Books →
// Backups and the daily check.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import JSZip from 'jszip';

const storage = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  /** GET hands nothing back, though HEAD finds the file. */
  unreadable: false,
}));

vi.mock('@/lib/r2', async () => {
  const { createHash: hash } = await import('node:crypto');
  return {
    r2HeadInfo: vi.fn(async (prefix: string, p: string) => {
      const there = storage.files.get(`${prefix}/${p}`);
      return there ? { bytes: there.length, etag: hash('md5').update(there).digest('hex') } : null;
    }),
    r2Upload: vi.fn(async (prefix: string, p: string, body: Buffer) => {
      storage.files.set(`${prefix}/${p}`, Buffer.from(body));
      return { success: true, key: `${prefix}/${p}`, publicUrl: '' };
    }),
    r2GetBytes: vi.fn(async (prefix: string, p: string) => {
      const there = storage.files.get(`${prefix}/${p}`);
      return there && !storage.unreadable ? { bytes: Buffer.from(there), contentType: 'application/zip' } : null;
    }),
    r2PresignGet: vi.fn(async (prefix: string, p: string) => `https://files.example/${prefix}/${p}?signed`),
  };
});
vi.mock('@/lib/ledger/pdf-gate', () => ({ ledgerPdfsEnabled: vi.fn(async () => ({ enabled: true, reason: 'Enabled via Settings → Company', via: 'settings' })) }));
vi.mock('@/lib/system-health', () => ({ recordHeartbeat: vi.fn(async () => ({ ok: true })) }));

import { recordHeartbeat } from '@/lib/system-health';
import { BACKUP_PREFIX, BACKUP_TABLES, BackupProblem, csvRow, csvRows, runBackup, type BackupTable } from './backups';
import {
  BOOKS_FIRST_MIGRATION, BOOKS_RESTORE_DRILL, DRILL_DUE_MINUTES, DRILL_NEEDS, DRILL_STAND_INS, DRILLS_LISTED,
  buildScratchBooks, drillMigrations, drillRecordOf, loadDrills, lookAtDrills, nextNightlyDrill, readDrillMigrations, runRestoreDrill, shapeProblem,
  type DrillMigration, type DrillRunOptions,
} from './restore-drill';

const MIGRATIONS = path.resolve(__dirname, '../../../migrations');
const migration = (file: string) => readFileSync(path.join(MIGRATIONS, file), 'utf8');
const NEWEST = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort().at(-1)!;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const CRAIG = '0b5e1d4a-2f43-4f0f-9d5e-6c1f7a9b3e21';
const inAMinute = () => Date.now() + 60_000;
const minutes = (n: number) => new Date(Date.now() + n * 60_000);

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
    if (table !== 'books_backups' && table !== 'books_restore_drills') throw new Error(`unexpected table ${table}`);
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
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
    };
    return query;
  };
  return { rpc, from } as any;
}

/** Each table's rows as JSON, in one order, generated columns and all. */
async function dump(pg: PGlite, tables: readonly string[]): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const r = await pg.query<{ rows: unknown[] }>(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM public.${t} t`);
    out[t] = r.rows[0].rows;
  }
  return out;
}

/** Made the way the nightly drill makes it, from the latest migrations; each drill below starts from a copy. */
let template: PGlite;
let picked: DrillMigration[];

beforeAll(async () => {
  picked = readDrillMigrations(MIGRATIONS, BACKUP_TABLES, null);
  template = await buildScratchBooks(picked);
}, 180_000);

afterAll(async () => { await template?.close(); });

beforeEach(() => {
  storage.unreadable = false;
  vi.mocked(recordHeartbeat).mockClear();
});

describe("the drill's scratch database", () => {
  it("makes every table of the books from FleetSuite's latest migrations, as the nightly drill will", async () => {
    const made = await template.query<{ t: string }>(
      `SELECT t FROM unnest($1::text[]) t WHERE (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.' || t)) = 'r'`,
      [BACKUP_TABLES],
    );
    expect(made.rows.map((r) => r.t).sort()).toEqual([...BACKUP_TABLES].sort());
    expect(picked.map((m) => m.name)).toEqual(expect.arrayContaining([...DRILL_NEEDS, '359-books-ledger-core.sql', '506-books-backups.sql']));
    expect(picked.map((m) => m.name)).toEqual([...picked.map((m) => m.name)].sort());
  });

  it('takes each migration from 359 on that names a table of the books, its comments aside, and the ones they need', () => {
    const sql: Record<string, string> = {
      '001-start.sql': 'CREATE TABLE gl_entries (id int);',
      '314-ledger.sql': 'CREATE TABLE ledger_accounts (id int);',
      '358-before.sql': 'ALTER TABLE gl_entries ADD COLUMN x int;',
      '359-books.sql': 'CREATE TABLE gl_entries (id int);',
      '360-elsewhere.sql': 'CREATE TABLE photo_shares (id int);',
      '361-said.sql': '-- gl_entries gets a column next time\nCREATE TABLE photo_links (id int);',
      '362-longer.sql': 'CREATE TABLE gl_entries_archive (id int);',
      '454-inventory-adjustments.sql': 'CREATE TABLE inventory_adjustments (id int);',
      '500-later.sql': 'ALTER TABLE public.GL_ENTRIES ADD COLUMN memo text;',
    };
    const read = vi.fn((f: string) => sql[f]);
    const names = (upTo: string | null) => drillMigrations([...Object.keys(sql).reverse(), 'README.md'], read, ['gl_entries'], upTo).map((m) => m.name);
    expect(names(null)).toEqual(['314-ledger.sql', '359-books.sql', '454-inventory-adjustments.sql', '500-later.sql']);
    expect(read).not.toHaveBeenCalledWith('001-start.sql');
    expect(read).not.toHaveBeenCalledWith('358-before.sql');
    expect(names('454-inventory-adjustments.sql')).toEqual(['314-ledger.sql', '359-books.sql', '454-inventory-adjustments.sql']);
    expect(names('359-books.sql')).toEqual(['314-ledger.sql', '359-books.sql']);
    expect(drillMigrations(['359-books.sql'], read, ['gl_entries'], null)[0]).toEqual({ name: '359-books.sql', sql: sql['359-books.sql'] });
    expect(BOOKS_FIRST_MIGRATION).toBe(359);
  });

  it('says a backup made by a newer FleetSuite, and migrations it can neither read nor find', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'drill-migrations-'));
    try {
      expect(() => readDrillMigrations(dir, ['gl_entries'], null)).toThrow("Couldn't find FleetSuite's migrations.");
      writeFileSync(path.join(dir, '359-books.sql'), 'CREATE TABLE gl_entries (id int);');
      writeFileSync(path.join(dir, '360-more.sql'), 'ALTER TABLE gl_entries ADD COLUMN memo text;');
      expect(readDrillMigrations(dir, ['gl_entries'], '360-more.sql').map((m) => m.name)).toEqual(['359-books.sql', '360-more.sql']);
      expect(() => readDrillMigrations(dir, ['gl_entries'], '361-later.sql')).toThrow(new BackupProblem(
        "The backup was made by a newer FleetSuite: its books reach migration 361-later.sql, and this one's migrations stop at 360-more.sql.",
      ));
      expect(() => readDrillMigrations(path.join(dir, 'gone'), ['gl_entries'], null)).toThrow(/^Couldn't read FleetSuite's migrations: ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says the migration that won't run, by name", async () => {
    await expect(buildScratchBooks([
      { name: '359-books-ledger-core.sql', sql: migration('359-books-ledger-core.sql') },
      { name: '360-broken.sql', sql: 'SELECT public.no_such_thing();' },
    ])).rejects.toThrow(new BackupProblem(
      "FleetSuite's migration 360-broken.sql wouldn't run in the scratch database: function public.no_such_thing() does not exist",
    ));
  });

  it('makes the stand-ins first, empty', async () => {
    const pg = await buildScratchBooks([]);
    try {
      const r = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM public.profiles');
      expect(r.rows[0].n).toBe(0);
      expect(DRILL_STAND_INS).toMatch(/CREATE ROLE service_role NOLOGIN BYPASSRLS;/);
    } finally {
      await pg.close();
    }
  });

  it('stops when it runs out of time', async () => {
    let calls = 0;
    await expect(buildScratchBooks(picked, () => {
      calls += 1;
      if (calls === 3) throw new BackupProblem('It ran out of time making the scratch database.');
    })).rejects.toThrow('It ran out of time making the scratch database.');
    expect(calls).toBe(3);
  });
});

describe("a table's shape in the backup against FleetSuite's migrations", () => {
  const backup: BackupTable = {
    table: 'gl_periods',
    columns: [{ name: 'id', type: 'uuid' }, { name: 'company_id', type: 'uuid' }, { name: 'period_start', type: 'date' }],
    generated: ['period_end'],
    identity: [],
    key: ['id'],
    parents: ['gl_companies', 'profiles'],
  };
  const made = (over: Partial<BackupTable>): BackupTable => ({ ...backup, ...over });

  it('takes the same shape, the columns in any order and the lists as sets', () => {
    expect(shapeProblem(backup, made({}))).toBeNull();
    expect(shapeProblem(backup, made({ columns: [...backup.columns].reverse(), parents: ['profiles', 'gl_companies'] }))).toBeNull();
  });

  it('names a column one has and the other lacks, or of another type', () => {
    expect(shapeProblem(backup, made({ columns: backup.columns.slice(0, 2) }))).toBe("FleetSuite's migrations don't make gl_periods.period_start, which the backup has.");
    expect(shapeProblem(backup, made({ columns: [...backup.columns, { name: 'note', type: 'text' }] }))).toBe('The backup has no gl_periods.note, which FleetSuite\'s migrations make.');
    expect(shapeProblem(backup, made({ columns: [backup.columns[0], backup.columns[1], { name: 'period_start', type: 'text' }] })))
      .toBe("gl_periods.period_start is date in the backup and text in FleetSuite's migrations.");
  });

  it('says a different key, generated or identity columns, or tables pointed at', () => {
    expect(shapeProblem(backup, made({ key: ['company_id', 'period_start'] }))).toBe("gl_periods's key is (id) in the backup and (company_id, period_start) in FleetSuite's migrations.");
    expect(shapeProblem(backup, made({ generated: [] }))).toBe("gl_periods's generated columns are (period_end) in the backup and (none) in FleetSuite's migrations.");
    expect(shapeProblem(backup, made({ identity: ['id'] }))).toBe("gl_periods's identity columns are (none) in the backup and (id) in FleetSuite's migrations.");
    expect(shapeProblem(backup, made({ parents: ['gl_companies'] }))).toBe("gl_periods's tables it points at are (gl_companies, profiles) in the backup and (gl_companies) in FleetSuite's migrations.");
  });
});

describe('a restore drill of a real backup', () => {
  let source: PGlite;
  let service: any;
  let made: Awaited<ReturnType<typeof runBackup>>;
  let original: Buffer;
  let manifestRows: number;
  /** The night's backup's manifest, as made. */
  let nightManifest: any;
  let links: number;
  const acct: Record<string, string> = {};
  const entry: Record<number, string> = {};
  let keySeq = 0;
  const post = async (over: Record<string, unknown>) => {
    keySeq += 1;
    const r = await source.query<{ r: { id: string; entry_no: number } }>('SELECT gl_post_entry($1::jsonb) AS r', [JSON.stringify({
      company: 'BMG', entry_date: '2026-11-03', source_type: 'invoice', source_id: `INV${1000 + keySeq}`, posting_rule: 'invoice@1',
      idempotency_key: `drill-test:${keySeq}`, ...over,
    })]);
    entry[Number(r.rows[0].r.entry_no)] = r.rows[0].r.id;
    return r.rows[0].r;
  };
  const drillRow = async (id: string | null) => (await source.query<any>('SELECT * FROM books_restore_drills WHERE id = $1', [id])).rows[0];

  /** The migrations each drill asked its scratch database for. */
  const asked: string[][] = [];
  /** The last scratch database, left open after its drill so a test can look. */
  let kept: { db: PGlite; close: () => Promise<void> } | null = null;
  async function scratch(migrations: readonly DrillMigration[]): Promise<PGlite> {
    asked.push(migrations.map((m) => m.name));
    await kept?.close();
    const db = (await template.clone()) as PGlite;
    const close = db.close.bind(db);
    (db as any).close = async () => undefined;
    kept = { db, close };
    return db;
  }
  /** A scratch database the migrations made otherwise. */
  const scratchThen = (change: string) => async (migrations: readonly DrillMigration[]) => {
    const db = await scratch(migrations);
    await db.exec(change);
    return db;
  };
  const drillOf = (backup: string | null, over: Partial<DrillRunOptions> = {}) => runRestoreDrill(service, {
    how: 'by_hand', by: CRAIG, byName: 'Craig', backup, deadline: inAMinute(), scratch, ...over,
  });

  beforeAll(async () => {
    source = (await template.clone()) as PGlite;
    await source.exec(migration('507-books-restore-drills.sql'));
    await source.exec('CREATE TABLE public.schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    await source.query("INSERT INTO public.schema_migrations (filename) VALUES ('506-books-backups.sql'), ($1)", [NEWEST]);
    await source.exec('SET ROLE service_role');

    const companies = await source.query<{ id: string; code: string }>('SELECT id, code FROM gl_companies');
    const coolSprings = companies.rows.find((c) => c.code === '1084')!.id;
    const accounts = await source.query<{ id: string; number: string }>(
      `INSERT INTO gl_accounts (number, name, account_type, is_control, company_id, active) VALUES
         ('10199', 'Drill Operating', 'bank', false, NULL, true),
         ('11099', 'Drill Receivable', 'accounts_receivable', true, NULL, true),
         ('40099', 'Drill Upfit Sales', 'income', false, NULL, true),
         ('41099', 'Drill Rent Income', 'income', false, $1, true)
       RETURNING id, number`,
      [coolSprings],
    );
    for (const a of accounts.rows) acct[a.number] = a.id;

    // October's invoice, the month closed, November's payment, 1084's rent, the payment reversed, and one more invoice.
    await post({
      entry_date: '2026-10-15', memo: 'INV1001, Acme "Fleet"\nsecond line',
      lines: [{ account_id: acct['11099'], debit: '1250.50' }, { account_id: acct['40099'], credit: '1250.50', division: 'upfit', memo: 'Upfit labor' }],
    });
    await source.query(`SELECT gl_set_period_status('BMG', DATE '2026-10-01', 'closed', $1::uuid, 'Craig', NULL)`, [CRAIG]);
    const payment = await post({
      source_type: 'payment', source_id: 'PYMT1', posting_rule: 'payment@1',
      lines: [{ account_id: acct['10199'], debit: '1250.50' }, { account_id: acct['11099'], credit: '1250.50' }],
    });
    await post({
      company: '1084', entry_date: '2026-11-01', source_type: 'rent', source_id: null, posting_rule: 'rent@1', memo: 'November rent',
      lines: [{ account_id: acct['10199'], debit: '5000.00' }, { account_id: acct['41099'], credit: '5000.00' }],
    });
    const reversal = await source.query<{ r: { id: string; entry_no: number } }>(`SELECT gl_reverse_entry($1::uuid, DATE '2026-11-04', NULL, $2::uuid, 'Craig') AS r`, [payment.id, CRAIG]);
    entry[Number(reversal.rows[0].r.entry_no)] = reversal.rows[0].r.id;
    await post({ lines: [{ account_id: acct['11099'], debit: '100.00' }, { account_id: acct['40099'], credit: '100.00' }] });

    service = serviceOver(source);
    made = await runBackup(service, { how: 'nightly', deadline: inAMinute() });
    expect(made).toMatchObject({ state: 'made', error: null });
    original = storage.files.get(`${BACKUP_PREFIX}/${made.file}`)!;
    const zip = await JSZip.loadAsync(original);
    nightManifest = JSON.parse(await zip.file(Object.keys(zip.files).find((f) => f.endsWith('/manifest.json'))!)!.async('string'));
    manifestRows = nightManifest.tables.reduce((sum: number, t: { rows: number }) => sum + t.rows, 0);
    links = (await template.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_class ch ON ch.oid = c.conrelid JOIN pg_class pa ON pa.oid = c.confrelid
       WHERE c.contype = 'f' AND ch.relname = ANY($1) AND pa.relname = ANY($1)`,
      [BACKUP_TABLES],
    )).rows[0].n;
  }, 120_000);

  afterAll(async () => {
    await kept?.close();
    await source?.close();
  });

  it("restores the night's backup into a scratch database and finds the books whole", async () => {
    const result = await runRestoreDrill(service, { how: 'nightly', deadline: inAMinute(), scratch });
    expect(result).toMatchObject({
      state: 'passed', backupId: made.id, error: null,
      counts: { tables: BACKUP_TABLES.length, rows: manifestRows, entries: 5, lines: 10, links },
    });
    expect(links).toBeGreaterThan(50);
    expect(await drillRow(result.id)).toMatchObject({
      backup_id: made.id, how: 'nightly', asked_by: null, asked_by_name: null, status: 'passed', migration: NEWEST,
      table_count: BACKUP_TABLES.length, row_count: manifestRows, entry_count: 5, line_count: 10, link_count: links, error: null,
    });
    expect(asked.at(-1)).toEqual(picked.map((m) => m.name));
    expect(vi.mocked(recordHeartbeat).mock.calls.at(-1)).toEqual([
      service, BOOKS_RESTORE_DRILL,
      { how: 'nightly', id: result.id, backup: made.id, state: 'passed', tables: BACKUP_TABLES.length, rows: manifestRows, entries: 5, lines: 10, links },
      { startedAt: expect.any(Number), records: manifestRows, touchLastSyncedAt: true },
    ]);
  });

  it('puts back every row of every table as it was, and numbers the next entry past the highest', async () => {
    expect(await dump(kept!.db, BACKUP_TABLES)).toEqual(await dump(source, BACKUP_TABLES));
    const next = await kept!.db.query<{ n: number }>(`SELECT nextval(pg_get_serial_sequence('public.gl_entries', 'entry_no'))::int AS n`);
    expect(next.rows[0].n).toBe(Math.max(...Object.keys(entry).map(Number)) + 1);
    // The triggers are back on: an entry that doesn't balance is refused again.
    await expect(kept!.db.query(`SELECT gl_post_entry($1::jsonb)`, [JSON.stringify({
      company: 'BMG', entry_date: '2026-11-05', source_type: 'invoice', source_id: 'INV9', posting_rule: 'invoice@1', idempotency_key: 'after-restore',
      lines: [{ account_id: acct['11099'], debit: '1.00' }, { account_id: acct['40099'], credit: '2.00' }],
    })])).rejects.toThrow(/does not balance/);
  });

  it('restores a backup once a night; by hand it restores it again, and keeps who asked', async () => {
    const again = await runRestoreDrill(service, { how: 'nightly', deadline: inAMinute(), scratch });
    expect(again).toMatchObject({ state: 'drilled', backupId: made.id, counts: null, error: null });
    const byHand = await drillOf(null);
    expect(byHand).toMatchObject({ state: 'passed', backupId: made.id });
    expect(await drillRow(byHand.id)).toMatchObject({ how: 'by_hand', asked_by: CRAIG, asked_by_name: 'Craig', status: 'passed' });
  });

  it('says one already running, and starts no second', async () => {
    const running = (await source.query<{ r: { id: string } }>(`SELECT books_restore_drill_begin('{"how":"by_hand","by_name":"Zach"}'::jsonb) AS r`)).rows[0].r;
    try {
      const result = await drillOf(null);
      expect(result).toMatchObject({ state: 'running', id: running.id, backupId: made.id, error: null });
      expect(recordHeartbeat).not.toHaveBeenCalled();
    } finally {
      await source.query(`SELECT books_restore_drill_finish($1::jsonb)`, [JSON.stringify({ id: running.id, status: 'failed', error: 'Made for the test.' })]);
    }
  });

  it("says why it couldn't start", async () => {
    const result = await drillOf(randomUUID());
    expect(result).toMatchObject({ state: 'failed', id: null, backupId: null, error: "There's no such backup." });
    expect(vi.mocked(recordHeartbeat).mock.calls[0].slice(1)).toEqual([
      BOOKS_RESTORE_DRILL, { how: 'by_hand', state: 'failed', error: "There's no such backup." }, { startedAt: expect.any(Number), records: null, touchLastSyncedAt: false },
    ]);
    const broken = serviceOver(source, async (fn, p, real) => (fn === 'books_restore_drill_begin' ? { data: null, error: { message: 'connection reset' } } : real()));
    expect(await runRestoreDrill(broken, { how: 'nightly', deadline: inAMinute(), scratch })).toMatchObject({
      state: 'failed', error: "Couldn't start a restore test: connection reset",
    });
  });

  // ── Broken backups: each a copy of the night's, changed, kept under a name of its own and recorded as made ──

  interface Tamper {
    files: Map<string, Buffer>;
    manifest: any;
    /** Written as manifest.json in place of the manifest, when given. */
    manifestText?: string;
    /** A table's CSV file, its columns' row first. */
    rows(table: string): (string | null)[][];
    /** Writes a table's CSV file, and gives the manifest its new SHA-256 unless `sign` is false. */
    write(table: string, rows: (string | null)[][], sign?: boolean): void;
    /** Works the journal's trial balance, entries and lines out again from the CSV files, as a backup of those books would have them. */
    retally(): void;
  }
  let fileSeq = 0;

  async function tampered(
    change: (t: Tamper) => void | Promise<void>,
    opts: { make?: (bytes: Buffer) => Buffer; store?: (bytes: Buffer) => Buffer | null; migration?: string; record?: { rows?: number } } = {},
  ): Promise<string> {
    const zip = await JSZip.loadAsync(original);
    const folder = Object.keys(zip.files).find((f) => f.endsWith('/manifest.json'))!.split('/')[0];
    const files = new Map<string, Buffer>();
    for (const [p, f] of Object.entries(zip.files)) if (!f.dir) files.set(p.slice(folder.length + 1), Buffer.from(await f.async('uint8array')));
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    const t: Tamper = {
      files,
      manifest,
      rows: (table) => [...csvRows(files.get(`tables/${table}.csv`)!.toString('utf8'))],
      write: (table, rows, sign = true) => {
        const csv = Buffer.from(rows.map((r) => csvRow(r)).join(''), 'utf8');
        files.set(`tables/${table}.csv`, csv);
        const m = manifest.tables.find((x: any) => x.table === table);
        m.rows = rows.length - 1;
        if (sign) Object.assign(m, { sha256: sha256(csv), bytes: csv.length });
      },
      retally: () => {
        const [header, ...lines] = t.rows('gl_lines');
        const at = (c: string) => header.indexOf(c);
        const sums = new Map<string, { company_id: string; account_id: string; debit: number; credit: number }>();
        for (const l of lines) {
          const key = `${l[at('company_id')]}|${l[at('account_id')]}`;
          const s = sums.get(key) ?? { company_id: l[at('company_id')]!, account_id: l[at('account_id')]!, debit: 0, credit: 0 };
          s.debit += Math.round(Number(l[at('debit')]) * 100);
          s.credit += Math.round(Number(l[at('credit')]) * 100);
          sums.set(key, s);
        }
        manifest.journal.lines = lines.length;
        manifest.journal.trial_balance = [...sums.values()].map((s) => ({ ...s, debit: (s.debit / 100).toFixed(2), credit: (s.credit / 100).toFixed(2) }));
      },
    };
    await change(t);
    if (files.has('manifest.json')) files.set('manifest.json', Buffer.from(t.manifestText ?? JSON.stringify(manifest, null, 2)));

    fileSeq += 1;
    const filePath = `2026/fleetsuite-books-2026-11-04-${String(fileSeq).padStart(6, '0')}Z.zip`;
    const name = filePath.split('/')[1].replace(/\.zip$/, '');
    const out = new JSZip();
    for (const [p, b] of files) out.file(`${name}/${p}`, b);
    let bytes = await out.generateAsync({ type: 'nodebuffer' });
    if (opts.make) bytes = opts.make(bytes);

    // The record counts what the manifest says; a manifest that can't be read counts as the night's.
    const counts = t.manifestText === undefined && files.has('manifest.json') ? manifest : nightManifest;
    if (opts.migration) await source.query('INSERT INTO public.schema_migrations (filename) VALUES ($1)', [opts.migration]);
    const begun = (await source.query<{ r: { id: string } }>('SELECT books_backup_begin($1::jsonb) AS r', [JSON.stringify({ how: 'nightly', tables: ['gl_companies'] })])).rows[0].r;
    await source.query('SELECT books_backup_finish($1::jsonb)', [JSON.stringify({
      id: begun.id, status: 'made', file_path: filePath, file_bytes: bytes.length, file_sha256: sha256(bytes), checked: true,
      tables: counts.tables.length, rows: opts.record?.rows ?? counts.tables.reduce((sum: number, x: any) => sum + x.rows, 0),
      entries: counts.journal.entries, lines: counts.journal.lines,
    })]);
    if (opts.migration) await source.query('DELETE FROM public.schema_migrations WHERE filename = $1', [opts.migration]);
    const stored = opts.store ? opts.store(bytes) : bytes;
    if (stored) storage.files.set(`${BACKUP_PREFIX}/${filePath}`, stored);
    return begun.id;
  }

  /** Runs a drill of the backup and expects it to fail, saying `error`; the record says so too. */
  async function fails(backup: string, error: string | RegExp, over: Partial<DrillRunOptions> = {}) {
    const result = await drillOf(backup, over);
    expect(result).toMatchObject({ state: 'failed', backupId: backup, counts: null });
    if (typeof error === 'string') expect(result.error).toBe(error);
    else expect(result.error).toMatch(error);
    expect(await drillRow(result.id)).toMatchObject({ status: 'failed', error: result.error, row_count: null, link_count: null });
    expect(vi.mocked(recordHeartbeat).mock.calls.at(-1)![2]).toMatchObject({ state: 'failed', error: result.error, backup });
    return result;
  }

  it('passes a copy made again from the same files', async () => {
    const copy = await tampered(() => undefined);
    expect(await drillOf(copy)).toMatchObject({ state: 'passed', backupId: copy, error: null });
  });

  it("says the backup's file isn't in storage, or storage won't hand it back", async () => {
    const gone = await tampered(() => undefined, { store: () => null });
    await fails(gone, /^The backup's file isn't in BMG's file storage \(2026\/fleetsuite-books-2026-11-04-\d{6}Z\.zip\)\.$/);
    const there = await tampered(() => undefined);
    storage.unreadable = true;
    await fails(there, "BMG's file storage wouldn't hand back the backup's file.");
  });

  it('says storage holds other bytes than the backup kept', async () => {
    const longer = await tampered(() => undefined, { store: (b) => Buffer.concat([b, Buffer.from('x')]) });
    await fails(longer, /^BMG's file storage holds [\d,]+ bytes for the backup, and it kept [\d,]+\.$/);
    const flipped = await tampered(() => undefined, { store: (b) => { const c = Buffer.from(b); c[c.length - 40] ^= 1; return c; } });
    await fails(flipped, "The backup's file in storage isn't the one it kept: its SHA-256 differs.");
  });

  it("says a file that isn't a zip, or a zip without its manifest", async () => {
    await fails(await tampered(() => undefined, { make: () => Buffer.from('not a zip at all') }), /^The backup's file isn't a zip FleetSuite can open: /);
    await fails(await tampered((t) => { t.files.delete('manifest.json'); }), /^The backup has no fleetsuite-books-2026-11-04-\d{6}Z\/manifest\.json\.$/);
  });

  it("says a manifest it can't read, or that doesn't add up to the backup's record", async () => {
    await fails(await tampered((t) => { t.manifestText = '{ "format": '; }), /^The backup's manifest\.json can't be read: /);
    await fails(await tampered((t) => { t.manifestText = '[]'; }), "The backup is in a form this FleetSuite doesn't know (undefined).");
    await fails(await tampered((t) => { t.manifest.format = 'fleetsuite-books-backup@2'; }), "The backup is in a form this FleetSuite doesn't know (fleetsuite-books-backup@2).");
    await fails(await tampered((t) => { t.manifest.load_order = t.manifest.load_order.slice(1); }), "The backup's load order doesn't name each of its tables once.");
    await fails(await tampered((t) => {
      t.manifest.tables = t.manifest.tables.filter((x: any) => x.table !== 'gl_entries');
      t.manifest.load_order = t.manifest.load_order.filter((x: string) => x !== 'gl_entries');
    }), "The backup doesn't hold the journal: it has no gl_entries.");
    await fails(await tampered((t) => { t.manifest.tables.find((x: any) => x.table === 'gl_period_events').file = 'tables/../../etc.csv'; }),
      "The backup's manifest gives gl_period_events the file tables/../../etc.csv.");
    await fails(await tampered((t) => { delete t.manifest.tables.find((x: any) => x.table === 'gl_periods').parents; }),
      "The backup's manifest doesn't give gl_periods's key, generated and identity columns, and parents.");
    await fails(await tampered(() => undefined, { record: { rows: manifestRows + 1 } }),
      `The backup's manifest counts ${manifestRows.toLocaleString('en-US')} rows, and its record ${(manifestRows + 1).toLocaleString('en-US')}.`);
    await fails(await tampered((t) => { t.manifest.migration = '506-books-backups.sql'; }), `The backup's manifest says it was made at migration 506-books-backups.sql, and its record ${NEWEST}.`);
  });

  it("says a file in it isn't what was written, as the backup's own check does", async () => {
    await fails(await tampered((t) => { t.files.set('tables/gl_period_events.csv', Buffer.concat([t.files.get('tables/gl_period_events.csv')!, Buffer.from('\n')])); }),
      "tables/gl_period_events.csv in the backup isn't what was written.");
  });

  it('says a backup made by a newer FleetSuite', async () => {
    const later = await tampered((t) => { t.manifest.migration = '999-later.sql'; }, { migration: '999-later.sql' });
    await fails(later, `The backup was made by a newer FleetSuite: its books reach migration 999-later.sql, and this one's migrations stop at ${NEWEST}.`);
  });

  it("says the migration that wouldn't run in the scratch database", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'drill-migrations-'));
    try {
      for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql'))) copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
      writeFileSync(path.join(dir, '360-books-netsuite-accounts.sql'), `${migration('360-books-netsuite-accounts.sql')}\nSELECT public.no_such_thing();\n`);
      await fails(made.id!, "FleetSuite's migration 360-books-netsuite-accounts.sql wouldn't run in the scratch database: function public.no_such_thing() does not exist",
        { migrationsDir: dir, scratch: undefined });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("says a table the migrations don't make, or make otherwise", async () => {
    await fails(made.id!, "FleetSuite's migrations don't make gl_snapped_bills, which the backup has.", { scratch: scratchThen('DROP TABLE public.gl_snapped_bills CASCADE') });
    await fails(made.id!, "The backup has no gl_period_events.note, which FleetSuite's migrations make.", { scratch: scratchThen('ALTER TABLE public.gl_period_events ADD COLUMN note TEXT') });
    await fails(made.id!, "gl_period_events.reason is text in the backup and character varying(200) in FleetSuite's migrations.",
      { scratch: scratchThen('ALTER TABLE public.gl_period_events ALTER COLUMN reason TYPE varchar(200)') });
    await fails(made.id!, /^Couldn't describe the scratch database's tables: function public\.books_backup_begin\(jsonb\) does not exist/,
      { scratch: scratchThen('DROP FUNCTION public.books_backup_begin(jsonb)') });
  });

  it("says a file that won't load: a value of the wrong kind, a key twice, columns out of order", async () => {
    await fails(await tampered((t) => {
      const [header, first, ...rest] = t.rows('gl_period_events');
      t.write('gl_period_events', [header, ['not-a-uuid', ...first.slice(1)], ...rest]);
    }), 'tables/gl_period_events.csv wouldn\'t load into the scratch database: invalid input syntax for type uuid: "not-a-uuid"');
    await fails(await tampered((t) => {
      const [header, first, ...rest] = t.rows('gl_period_events');
      t.write('gl_period_events', [header, first, first, ...rest]);
    }), /^tables\/gl_period_events\.csv wouldn't load into the scratch database: duplicate key value violates unique constraint "gl_period_events_pkey"/);
    await fails(await tampered((t) => {
      const [header, ...rest] = t.rows('gl_period_events');
      t.write('gl_period_events', [[header[1], header[0], ...header.slice(2)], ...rest]);
    }), /^tables\/gl_period_events\.csv wouldn't load into the scratch database: column name mismatch in header line field 1: got "period_id", expected "id"/);
  });

  it('says a table that came back with other rows than the manifest says', async () => {
    const periods = nightManifest.tables.find((x: any) => x.table === 'gl_periods').rows;
    expect(periods).toBeGreaterThan(1);
    await fails(await tampered((t) => { t.manifest.tables.find((x: any) => x.table === 'gl_periods').rows += 1; }),
      `gl_periods has ${periods} rows in the scratch database, and the backup's manifest says ${periods + 1}.`);
  });

  it('says a row that points at a row the backup lacks', async () => {
    await fails(await tampered((t) => {
      const [header, ...rest] = t.rows('gl_period_events');
      const at = header.indexOf('period_id');
      t.write('gl_period_events', [header, ...rest.map((r) => r.map((v, i) => (i === at ? randomUUID() : v)))]);
    }), "1 row of gl_period_events points at gl_periods rows the backup doesn't have (gl_period_events_period_id_fkey).");
  });

  /** gl_lines' rows changed by `change`, the file signed, and the trial balance worked out again when `retally`. */
  const lines = (change: (rows: (string | null)[][], at: (c: string) => number) => (string | null)[][], retally = false) => (t: Tamper) => {
    const [header, ...rest] = t.rows('gl_lines');
    t.write('gl_lines', [header, ...change(rest, (c) => header.indexOf(c))]);
    if (retally) t.retally();
  };

  it("says an entry that doesn't balance, though every account still adds up", async () => {
    await fails(await tampered(lines((rows, at) => rows.map((r) => {
      if (r[at('account_id')] !== acct['11099'] || r[at('debit')] === '0.00') return r;
      const moved = r[at('entry_id')] === entry[1] ? '1300.50' : r[at('entry_id')] === entry[5] ? '50.00' : r[at('debit')];
      return r.map((v, i) => (i === at('debit') ? moved : v));
    }))), "2 journal entries don't balance in the restored books: entry 1 has $1,300.50 of debits and $1,250.50 of credits.");
  });

  it('says an entry left with one line', async () => {
    await fails(await tampered(lines((rows, at) => rows.filter((r) => !(r[at('entry_id')] === entry[5] && r[at('credit')] !== '0.00')), true)),
      '1 journal entry has fewer than two lines in the restored books, entry 5 first.');
  });

  it("says a line with a date other than its entry's", async () => {
    await fails(await tampered(lines((rows, at) => rows.map((r) => (r[at('entry_id')] === entry[3] && r[at('debit')] !== '0.00' ? r.map((v, i) => (i === at('entry_date') ? '2026-11-02' : v)) : r)))),
      "1 journal line has a company or date other than its entry's in the restored books, entry 3 first.");
  });

  it("says a line on another company's account", async () => {
    await fails(await tampered(lines((rows, at) => rows.map((r) => (r[at('entry_id')] === entry[5] && r[at('credit')] !== '0.00' ? r.map((v, i) => (i === at('account_id') ? acct['41099'] : v)) : r)), true)),
      "1 journal line is on another company's account in the restored books, entry 5 first.");
  });

  it("says a manifest whose trial balance the backup's journal doesn't add up to, as the backup's own check does", async () => {
    await fails(await tampered((t) => { t.manifest.journal.trial_balance.find((a: any) => a.account_id === acct['40099']).credit = '1350.49'; }),
      /^The backup's journal adds up differently for account [0-9a-f-]{36}: \$0\.00 of debits and \$1,350\.50 of credits, and the books had \$0\.00 and \$1,350\.49\.$/);
  });

  it('says a restored journal that adds up otherwise than the trial balance the backup was made with', async () => {
    // A trigger that fires even with the others off moves an entry's amount as it loads, the entry still balanced.
    const moving = scratchThen(`
      CREATE FUNCTION public.drill_moves() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.debit = 100.00 THEN NEW.debit := 101.00; END IF;
        IF NEW.credit = 100.00 THEN NEW.credit := 101.00; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER drill_moves BEFORE INSERT ON public.gl_lines FOR EACH ROW EXECUTE FUNCTION public.drill_moves();
      ALTER TABLE public.gl_lines ENABLE ALWAYS TRIGGER drill_moves;
    `);
    // Whichever of the two accounts the trial balance lists first is named.
    await fails(made.id!, new RegExp(`^The restored journal adds up differently for (${[
      '11099 Drill Receivable \\(BMG\\): \\$2,602\\.00 of debits and \\$1,250\\.50 of credits, and the backup was made with \\$2,601\\.00 and \\$1,250\\.50',
      '40099 Drill Upfit Sales \\(BMG\\): \\$0\\.00 of debits and \\$1,351\\.50 of credits, and the backup was made with \\$0\\.00 and \\$1,350\\.50',
    ].join('|')})\\.$`),
      { scratch: moving });
  });

  it('runs out of time, and says where', async () => {
    await fails(made.id!, 'It ran out of time before it opened the backup.', { deadline: Date.now() - 1 });
    // Its time runs out once the scratch database is made.
    const opts: DrillRunOptions = { how: 'by_hand', by: CRAIG, byName: 'Craig', backup: made.id, deadline: inAMinute() };
    opts.scratch = async (m) => {
      const db = await scratch(m);
      opts.deadline = Date.now() - 1;
      return db;
    };
    const result = await runRestoreDrill(service, opts);
    expect(result).toMatchObject({ state: 'failed', error: `It ran out of time loading ${nightManifest.load_order[0]}.` });
    expect(await drillRow(result.id)).toMatchObject({ status: 'failed', error: result.error });
  });

  it("says what went wrong when something else does, and when the record won't take how it went", async () => {
    await fails(made.id!, 'Something went wrong: the scratch database went away', { scratch: async () => { throw new Error('the scratch database went away'); } });
    let once = false;
    const refusing = serviceOver(source, async (fn, p, real) => {
      if (fn === 'books_restore_drill_finish' && !once) {
        once = true;
        return { data: null, error: { message: 'row is too big' } };
      }
      return real();
    });
    const result = await runRestoreDrill(refusing, { how: 'by_hand', by: CRAIG, byName: 'Craig', backup: made.id, deadline: inAMinute(), scratch });
    expect(result).toMatchObject({ state: 'failed', error: "The restore test's record wouldn't take how it went: row is too big" });
    expect(await drillRow(result.id)).toMatchObject({ status: 'failed', error: "The restore test's record wouldn't take how it went: row is too big" });
  });
});

describe("Books → Backups and the daily check's look", () => {
  let pg: PGlite;
  let service: any;
  let n = 0;
  const backup = async (status: 'made' | 'failed' = 'made') => {
    n += 1;
    const begun = (await pg.query<{ r: { id: string; started_at: string } }>(`SELECT books_backup_begin('{"how":"nightly","tables":["gl_companies"]}'::jsonb) AS r`)).rows[0].r;
    await pg.query('SELECT books_backup_finish($1::jsonb)', [JSON.stringify(status === 'made'
      ? { id: begun.id, status, file_path: `2026/fleetsuite-books-2026-11-03-${String(n).padStart(6, '0')}Z.zip`, file_bytes: 10, file_sha256: 'a'.repeat(64), tables: 1, rows: 1, entries: 0, lines: 0, checked: true }
      : { id: begun.id, status, error: 'It ran out of time.' })]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return begun;
  };
  const drill = async (backupId: string, status: 'passed' | 'failed' | null, how: 'nightly' | 'by_hand' = 'by_hand') => {
    const begun = (await pg.query<{ r: { id: string; started_at: string } }>('SELECT books_restore_drill_begin($1::jsonb) AS r', [JSON.stringify({ how, backup: how === 'by_hand' ? backupId : undefined, by_name: how === 'by_hand' ? 'Craig' : undefined })])).rows[0].r;
    if (status) {
      await pg.query('SELECT books_restore_drill_finish($1::jsonb)', [JSON.stringify(status === 'passed'
        ? { id: begun.id, status, tables: 90, rows: 1200, entries: 30, lines: 90, links: 67 }
        : { id: begun.id, status, error: 'gl_lines has 89 rows in the scratch database, and the backup\'s manifest says 90.' })]);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    return begun;
  };

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(DRILL_STAND_INS);
    for (const file of ['359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '387-books-retired-accounts.sql', '506-books-backups.sql', '507-books-restore-drills.sql']) {
      await pg.exec(migration(file));
    }
    await pg.exec('SET ROLE service_role');
    service = serviceOver(pg);
  }, 60_000);

  afterAll(async () => { await pg?.close(); });

  it('restores nothing before a backup is made, and says so', async () => {
    expect(await runRestoreDrill(service, { how: 'nightly', deadline: inAMinute() })).toEqual({
      state: 'none', id: null, backupId: null, startedAt: null, counts: null, error: null,
    });
    expect(recordHeartbeat).not.toHaveBeenCalled();
    expect(await lookAtDrills(service, true)).toBeNull();
    expect((await loadDrills(service)).newest).toBeNull();
  });

  it("looks only at the day's first look", async () => {
    await backup();
    expect(await lookAtDrills(service, false, minutes(600))).toBeNull();
  });

  it('says a good backup that went 90 minutes without a restore test', async () => {
    const b = await backup();
    expect(await lookAtDrills(service, true, minutes(DRILL_DUE_MINUTES - 1))).toBeNull();
    expect(await lookAtDrills(service, true, minutes(DRILL_DUE_MINUTES + 1))).toEqual({ kind: 'missed', id: null, backupId: b.id, backupAt: expect.any(String), error: null });
    expect(new Date((await lookAtDrills(service, true, minutes(DRILL_DUE_MINUTES + 1)))!.backupAt).getTime()).toBe(new Date(b.started_at).getTime());
    // The page says the same.
    expect((await loadDrills(service, minutes(DRILL_DUE_MINUTES - 1))).newest).toEqual({ backupId: b.id, backupAt: expect.any(String), drill: null, overdue: false });
    expect((await loadDrills(service, minutes(DRILL_DUE_MINUTES + 1))).newest).toMatchObject({ backupId: b.id, drill: null, overdue: true });
  });

  it("says the newest good backup's restore test failed or stopped, and nothing once one passes", async () => {
    const b = await backup();
    await backup('failed');
    const failed = await drill(b.id, 'failed');
    expect(await lookAtDrills(service, true, minutes(120))).toEqual({
      kind: 'failed', id: failed.id, backupId: b.id, backupAt: expect.any(String), error: "gl_lines has 89 rows in the scratch database, and the backup's manifest says 90.",
    });
    const stopped = await drill(b.id, null);
    expect(await lookAtDrills(service, true, minutes(5))).toBeNull();
    expect(await lookAtDrills(service, true, minutes(11))).toMatchObject({ kind: 'failed', id: stopped.id, error: 'It stopped before it finished.' });
    await pg.query('SELECT books_restore_drill_finish($1::jsonb)', [JSON.stringify({ id: stopped.id, status: 'passed', tables: 90, rows: 1200, entries: 30, lines: 90, links: 67 })]);
    expect(await lookAtDrills(service, true, minutes(120))).toBeNull();
    // A test that fails by hand after it passed is the latest word.
    const after = await drill(b.id, 'failed');
    expect(await lookAtDrills(service, true, minutes(120))).toMatchObject({ kind: 'failed', id: after.id });
    await drill(b.id, 'passed');
    expect(await lookAtDrills(service, true, minutes(120))).toBeNull();
  });

  it('lists the newest first, with the last one that passed and when the next nightly one runs', async () => {
    const b = await backup();
    const passed = await drill(b.id, 'passed', 'nightly');
    const failed = await drill(b.id, 'failed');
    const now = new Date();
    const view = await loadDrills(service, now);
    expect(view.drills[0]).toMatchObject({ id: failed.id, backupId: b.id, how: 'by_hand', askedBy: 'Craig', status: 'failed', rows: null, error: expect.stringContaining('gl_lines') });
    expect(view.drills[1]).toMatchObject({ id: passed.id, how: 'nightly', askedBy: null, status: 'passed', tables: 90, rows: 1200, entries: 30, lines: 90, links: 67, error: null });
    expect(view.lastPassed).toMatchObject({ id: passed.id });
    expect(view.newest).toEqual({ backupId: b.id, backupAt: expect.any(String), drill: view.drills[0], overdue: false });
    expect(view.next).toBe(nextNightlyDrill(now).toISOString());
    // A backup made since, not yet tested, is the newest; the one that passed is still the last that did.
    const since = await backup();
    const later = await loadDrills(service, now);
    expect(later.newest).toEqual({ backupId: since.id, backupAt: expect.any(String), drill: null, overdue: false });
    expect(later.lastPassed).toMatchObject({ id: passed.id });
  });

  it('finds the last one that passed past the ones it lists', async () => {
    const b = await backup();
    const passed = await drill(b.id, 'passed');
    for (let i = 0; i < DRILLS_LISTED; i += 1) await drill(b.id, 'failed');
    const view = await loadDrills(service);
    expect(view.drills).toHaveLength(DRILLS_LISTED);
    expect(view.drills.every((d) => d.status === 'failed')).toBe(true);
    expect(view.lastPassed).toMatchObject({ id: passed.id, status: 'passed' });
  }, 60_000);
});

describe('a drill as the page reads it, and the next nightly one', () => {
  const row = { id: 'd1', backup_id: 'b1', how: 'nightly', asked_by_name: null, started_at: '2026-11-03T08:51:00.000Z', finished_at: null, status: 'running',
    table_count: null, row_count: null, entry_count: null, line_count: null, link_count: null, error: null };

  it('reads one still running after ten minutes as stopped', () => {
    expect(drillRecordOf(row, new Date('2026-11-03T08:55:00Z'))).toMatchObject({ status: 'running', error: null });
    expect(drillRecordOf(row, new Date('2026-11-03T09:01:01Z'))).toMatchObject({ status: 'stopped', error: 'It stopped before it finished.' });
    expect(drillRecordOf({ ...row, status: 'passed', finished_at: '2026-11-03T08:52:10Z', table_count: 90, row_count: '41200', entry_count: '3100', line_count: '9800', link_count: 67 }, new Date('2026-11-04T00:00:00Z')))
      .toEqual({ id: 'd1', backupId: 'b1', how: 'nightly', askedBy: null, startedAt: '2026-11-03T08:51:00.000Z', finishedAt: '2026-11-03T08:52:10Z', status: 'passed',
        tables: 90, rows: 41200, entries: 3100, lines: 9800, links: 67, error: null });
  });

  it('runs nightly at 08:51 UTC, 2:51 AM Central', () => {
    expect(nextNightlyDrill(new Date('2026-11-03T08:50:00Z')).toISOString()).toBe('2026-11-03T08:51:00.000Z');
    expect(nextNightlyDrill(new Date('2026-11-03T08:51:00Z')).toISOString()).toBe('2026-11-04T08:51:00.000Z');
    expect(nextNightlyDrill(new Date('2026-12-31T23:00:00Z')).toISOString()).toBe('2027-01-01T08:51:00.000Z');
  });
});
