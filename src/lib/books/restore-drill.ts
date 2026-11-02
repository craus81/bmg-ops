import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import JSZip from 'jszip';
import { r2GetBytes, r2HeadInfo } from '@/lib/r2';
import { recordHeartbeat, type HeartbeatResult } from '@/lib/system-health';
import { BACKUP_FORMAT, BACKUP_PREFIX, BACKUP_TABLES, BackupProblem, checkBackup, counted, exactCents, moneyText, reasonOf, type BackupTable } from './backups';

/**
 * The restore drill (part 85; the NetSuite Exit Checklist's "Backups",
 * thread "Replacing NetSuite with FleetSuite"; docs/books.md "The restore
 * drill"). A backup only counts once it has been put back, so every night at
 * 2:51 AM Central, forty minutes after the nightly backup, and whenever a
 * super admin presses Test restore now on Books → Backups, FleetSuite takes
 * the newest good backup out of BMG's file storage and restores it the way
 * the backup's README says, into a scratch database it makes for the purpose
 * and throws away after:
 *   * the zip has to be the very bytes the backup kept (size and SHA-256),
 *     its manifest whole and matching the backup's record, and its files
 *     what the manifest says (checkBackup, the backup's own check);
 *   * the scratch database (PGlite, Postgres in the server's memory) is made
 *     from FleetSuite's own migrations up to the one the backup was made at:
 *     every migration from 359 on that names a table of the books, those
 *     they need from before (DRILL_NEEDS), and stand-ins for the few things
 *     outside the books they reach (DRILL_STAND_INS);
 *   * each table there has to have the backup's shape: its columns and their
 *     types, its key, its generated and identity columns, and the tables it
 *     points at;
 *   * every table is emptied and loaded from its CSV file in the manifest's
 *     load order with the database's triggers off, then each identity
 *     column's numbering is set past its highest number, as the README says;
 *   * then the restored books are checked: each table holds the rows the
 *     manifest says; every row a foreign key between the books' tables
 *     points from finds the row it points at; every journal entry has two
 *     lines or more and balances; each line has its entry's company and date
 *     and an account of that company; and the journal adds up, account by
 *     account, to the trial balance the backup was made with.
 * How each one went is kept (migration 507's books_restore_drills), shown on
 * Books → Backups beside its backup, and the daily check's first look tells
 * the super admins (and Craig by email) about one that failed, or a backup
 * that went 90 minutes without one.
 *
 * It reads BMG's file storage and writes only its own record: the books
 * themselves are never touched, so it needs no switch.
 */

/** Its row in sync_state; left out of System Health like the backup, since the daily check tells about it. */
export const BOOKS_RESTORE_DRILL = 'books_restore_drill';
/** The nightly drill's moment, 08:51 UTC (vercel.json), forty minutes after the nightly backup's. */
export const DRILL_NIGHTLY_UTC = { hour: 8, minute: 51 };
/** A drill still running after this long has stopped: its server was cut off (migration 507 marks it failed). */
export const DRILL_STOPPED_MINUTES = 10;
/** Minutes a made backup can go without a drill before the daily check says it was missed. */
export const DRILL_DUE_MINUTES = 90;
/** Drills the page reads, newest first: two for each backup it lists. */
export const DRILLS_LISTED = 120;
/** The books' first migration; the drill looks at every one from here on. */
export const BOOKS_FIRST_MIGRATION = 359;

/**
 * Migrations from before 359, or naming no table of the books, that the
 * books' migrations need: the QuickBooks import's ledger, which the books'
 * readers sit beside, and inventory's adjustments, which the approval step
 * (migration 494) points at.
 */
export const DRILL_NEEDS: readonly string[] = ['314-ledger.sql', '454-inventory-adjustments.sql'];

/**
 * What the books' migrations reach outside the books, made empty before they
 * run: Supabase's roles, the tables a foreign key or a reader of the books
 * names, and the two role checks their policies call. Only their shape
 * matters; the drill restores nothing into them, and doesn't check the links
 * out to them (migrations/README.md says when a new migration needs one more).
 */
export const DRILL_STAND_INS = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE public.profiles (id UUID PRIMARY KEY, full_name TEXT);
CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.get_my_roles() RETURNS TEXT[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[]::text[] $$;
CREATE TABLE public.customers (id UUID PRIMARY KEY, company_name TEXT, netsuite_id TEXT, tax_exempt BOOLEAN);
CREATE TABLE public.netsuite_parts (id UUID PRIMARY KEY, item_number TEXT, taxable_override BOOLEAN, netsuite_id TEXT);
CREATE TABLE public.netsuite_sales_orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), netsuite_id TEXT NOT NULL UNIQUE, tranid TEXT, customer_netsuite_id TEXT, customer_name TEXT, trandate DATE, created_by_name TEXT);
CREATE TABLE public.netsuite_vendor_pos (netsuite_id TEXT NOT NULL UNIQUE, tranid TEXT, vendor_name TEXT, trandate DATE, created_by_name TEXT);
CREATE TABLE public.vendor_invoices (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
CREATE TABLE public.payouts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status TEXT NOT NULL DEFAULT 'approved');
CREATE TABLE public.po_receipts (id UUID PRIMARY KEY, ns_status TEXT NOT NULL);
CREATE TABLE public.quote_settings (id INTEGER PRIMARY KEY CHECK (id = 1), updated_at TIMESTAMPTZ, updated_by UUID, sales_tax_rate_pct NUMERIC);
CREATE TABLE public.drop_ship_orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), purchase_order_id TEXT);
`;

/** The tables a drill can't check the journal without. */
const JOURNAL_TABLES = ['gl_companies', 'gl_accounts', 'gl_entries', 'gl_lines'];

export interface DrillMigration {
  name: string;
  sql: string;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** A name in double quotes, as SQL takes it. */
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const listed = (names: readonly string[]) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '));
const isMigration = (file: string) => file.endsWith('.sql');

/**
 * The migrations the scratch database is made from, in the order they ran:
 * up to `upTo` (the backup's latest; all of them when it has none), each of
 * DRILL_NEEDS, and every one from BOOKS_FIRST_MIGRATION on whose SQL, its
 * comments aside, names one of `tables`. Sorted by name, as scripts/migrate.mjs
 * runs them.
 */
export function drillMigrations(files: readonly string[], read: (file: string) => string, tables: readonly string[], upTo: string | null): DrillMigration[] {
  const names = new RegExp(`\\b(?:${tables.map((t) => t.replace(/[^a-z0-9_]/gi, '')).filter(Boolean).join('|')})\\b`, 'i');
  const out: DrillMigration[] = [];
  for (const name of files.filter((f) => isMigration(f) && (upTo === null || f <= upTo)).sort()) {
    if (DRILL_NEEDS.includes(name)) {
      out.push({ name, sql: read(name) });
      continue;
    }
    if (!(parseInt(name, 10) >= BOOKS_FIRST_MIGRATION)) continue;
    const sql = read(name);
    if (names.test(sql.replace(/--[^\n]*/g, ''))) out.push({ name, sql });
  }
  return out;
}

/** The app's own migrations folder, shipped with the drill's routes (next.config.js). */
const migrationsFolder = () => path.join(process.cwd(), 'migrations');

/** The migrations for a backup made at `upTo`, read from `dir`; a backup newer than them is said. */
export function readDrillMigrations(dir: string, tables: readonly string[], upTo: string | null): DrillMigration[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter(isMigration).sort();
  } catch (err) {
    throw new BackupProblem(`Couldn't read FleetSuite's migrations: ${reasonOf(err)}`);
  }
  const newest = files.at(-1);
  if (!newest) throw new BackupProblem("Couldn't find FleetSuite's migrations.");
  if (upTo !== null && upTo > newest) {
    throw new BackupProblem(`The backup was made by a newer FleetSuite: its books reach migration ${upTo}, and this one's migrations stop at ${newest}.`);
  }
  return drillMigrations(files, (f) => readFileSync(path.join(dir, f), 'utf8'), tables, upTo);
}

/** An empty Postgres in memory with the stand-ins, then each migration in turn; one that won't run is said. */
export async function buildScratchBooks(migrations: readonly DrillMigration[], inTime: () => void = () => undefined): Promise<PGlite> {
  let pg: PGlite;
  try {
    const { PGlite: Scratch } = await import('@electric-sql/pglite');
    pg = await Scratch.create();
  } catch (err) {
    throw new BackupProblem(`Couldn't start a scratch database: ${reasonOf(err)}`);
  }
  try {
    await pg.exec(DRILL_STAND_INS);
    for (const m of migrations) {
      inTime();
      try {
        await pg.exec(m.sql);
      } catch (err) {
        throw new BackupProblem(`FleetSuite's migration ${m.name} wouldn't run in the scratch database: ${reasonOf(err)}`);
      }
    }
    return pg;
  } catch (err) {
    await pg.close().catch(() => undefined);
    if (err instanceof BackupProblem) throw err;
    throw new BackupProblem(`Couldn't set up the scratch database: ${reasonOf(err)}`);
  }
}

// ── The backup's shape against the migrations' ─────────────────────────────

const sorted = (list: readonly string[]) => [...list].sort();
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const inParens = (list: readonly string[]) => `(${list.length ? list.join(', ') : 'none'})`;

/**
 * What differs between a table as the backup describes it and as FleetSuite's
 * migrations make it (both described by migration 506's books_backup_begin),
 * in words, or null. Columns are matched by name; their order doesn't
 * matter, since each file names its columns.
 */
export function shapeProblem(backup: BackupTable, made: BackupTable): string | null {
  const t = backup.table;
  const madeTypes = new Map(made.columns.map((c) => [c.name, c.type]));
  const backupTypes = new Map(backup.columns.map((c) => [c.name, c.type]));
  for (const c of backup.columns) {
    const type = madeTypes.get(c.name);
    if (type === undefined) return `FleetSuite's migrations don't make ${t}.${c.name}, which the backup has.`;
    if (type !== c.type) return `${t}.${c.name} is ${c.type} in the backup and ${type} in FleetSuite's migrations.`;
  }
  for (const c of made.columns) {
    if (!backupTypes.has(c.name)) return `The backup has no ${t}.${c.name}, which FleetSuite's migrations make.`;
  }
  const lists: [string, readonly string[], readonly string[]][] = [
    ['key', backup.key, made.key],
    ['generated columns', sorted(backup.generated), sorted(made.generated)],
    ['identity columns', sorted(backup.identity), sorted(made.identity)],
    ['tables it points at', sorted(backup.parents), sorted(made.parents)],
  ];
  for (const [what, a, b] of lists) {
    if (!sameList(a, b)) return `${t}'s ${what} ${what === 'key' ? 'is' : 'are'} ${inParens(a)} in the backup and ${inParens(b)} in FleetSuite's migrations.`;
  }
  return null;
}

// ── The backup itself ──────────────────────────────────────────────────────

interface ManifestTable extends BackupTable {
  file: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface DrillManifest {
  format: string;
  migration: string | null;
  load_order: string[];
  tables: ManifestTable[];
  journal: { entries: number; lines: number; trial_balance: { company_id: string; account_id: string; debit: string; credit: string }[] };
}

/** A backup's record as migration 507's books_restore_drill_begin hands it over. */
interface DrillBackup {
  id: string;
  started_at: string;
  file_path: string | null;
  file_bytes: number | null;
  file_sha256: string | null;
  migration: string | null;
  tables: number | null;
  rows: number | null;
  entries: number | null;
  lines: number | null;
}

const isNames = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isCount = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** The manifest's own shape, or what's wrong with it. */
function manifestProblem(m: any): string | null {
  if (!m || typeof m !== 'object') return "The backup's manifest.json isn't an object.";
  if (m.format !== BACKUP_FORMAT) return `The backup is in a form this FleetSuite doesn't know (${String(m.format).slice(0, 60)}).`;
  if (m.migration !== null && typeof m.migration !== 'string') return "The backup's manifest doesn't say which migration it was made at.";
  if (!Array.isArray(m.tables) || !m.tables.length) return "The backup's manifest lists no tables.";
  for (const t of m.tables) {
    if (!t || typeof t.table !== 'string' || !TABLE_NAME.test(t.table)) return "The backup's manifest lists a table without a proper name.";
    if (t.file !== `tables/${t.table}.csv`) return `The backup's manifest gives ${t.table} the file ${String(t.file).slice(0, 80)}.`;
    if (!Array.isArray(t.columns) || !t.columns.length || !t.columns.every((c: any) => c && typeof c.name === 'string' && c.name && typeof c.type === 'string')) {
      return `The backup's manifest doesn't give ${t.table}'s columns.`;
    }
    if (![t.generated, t.identity, t.key, t.parents].every(isNames)) return `The backup's manifest doesn't give ${t.table}'s key, generated and identity columns, and parents.`;
    if (!isCount(t.rows) || typeof t.sha256 !== 'string') return `The backup's manifest doesn't give ${t.table}'s rows and SHA-256.`;
  }
  const tables = (m.tables as ManifestTable[]).map((t) => t.table);
  if (new Set(tables).size !== tables.length) return "The backup's manifest lists a table twice.";
  if (!isNames(m.load_order) || !sameList(sorted(m.load_order), sorted(tables))) return "The backup's load order doesn't name each of its tables once.";
  const j = m.journal;
  if (!j || !isCount(j.entries) || !isCount(j.lines) || !Array.isArray(j.trial_balance)) return "The backup's manifest doesn't give the journal's trial balance.";
  const missing = JOURNAL_TABLES.filter((t) => !tables.includes(t));
  if (missing.length) return `The backup doesn't hold the journal: it has no ${listed(missing)}.`;
  return null;
}

/** The manifest against the backup's record, which its counts have to match. */
function recordProblem(m: DrillManifest, b: DrillBackup): string | null {
  if ((m.migration ?? null) !== (b.migration ?? null)) {
    return `The backup's manifest says it was made at migration ${m.migration ?? 'none'}, and its record ${b.migration ?? 'none'}.`;
  }
  const rows = m.tables.reduce((sum, t) => sum + t.rows, 0);
  const pairs: [string, number, number | null][] = [
    ['tables', m.tables.length, b.tables],
    ['rows', rows, b.rows],
    ['journal entries', m.journal.entries, b.entries],
    ['journal lines', m.journal.lines, b.lines],
  ];
  for (const [what, inManifest, inRecord] of pairs) {
    if (inRecord !== null && Number(inRecord) !== inManifest) {
      return `The backup's manifest counts ${inManifest.toLocaleString('en-US')} ${what}, and its record ${Number(inRecord).toLocaleString('en-US')}.`;
    }
  }
  return null;
}

/** The backup's zip out of storage, the very bytes it kept, and its manifest. */
async function openBackup(b: DrillBackup): Promise<{ zip: JSZip; name: string; bytes: Buffer; manifest: DrillManifest }> {
  if (!b.file_path) throw new BackupProblem('The backup has no file to restore.');
  const got = await r2GetBytes(BACKUP_PREFIX, b.file_path);
  if (!got) {
    throw new BackupProblem(await r2HeadInfo(BACKUP_PREFIX, b.file_path)
      ? "BMG's file storage wouldn't hand back the backup's file."
      : `The backup's file isn't in BMG's file storage (${b.file_path}).`);
  }
  const bytes = got.bytes;
  if (b.file_bytes !== null && bytes.length !== Number(b.file_bytes)) {
    throw new BackupProblem(`BMG's file storage holds ${bytes.length.toLocaleString('en-US')} bytes for the backup, and it kept ${Number(b.file_bytes).toLocaleString('en-US')}.`);
  }
  if (b.file_sha256 && sha256(bytes) !== b.file_sha256) {
    throw new BackupProblem("The backup's file in storage isn't the one it kept: its SHA-256 differs.");
  }

  const name = path.posix.basename(b.file_path, '.zip');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    throw new BackupProblem(`The backup's file isn't a zip FleetSuite can open: ${reasonOf(err)}`);
  }
  const file = zip.file(`${name}/manifest.json`);
  if (!file) throw new BackupProblem(`The backup has no ${name}/manifest.json.`);
  let manifest: DrillManifest;
  try {
    manifest = JSON.parse(await file.async('string'));
  } catch (err) {
    throw new BackupProblem(`The backup's manifest.json can't be read: ${reasonOf(err)}`);
  }
  const problem = manifestProblem(manifest) ?? recordProblem(manifest, b);
  if (problem) throw new BackupProblem(problem);
  return { zip, name, bytes, manifest };
}

// ── The restore, into the scratch database ─────────────────────────────────

const count = async (pg: PGlite, sql: string, params: unknown[] = []) => Number((await pg.query<{ n: number | string }>(sql, params)).rows[0]?.n ?? 0);

/** Each table of the backup as the scratch database has it, described the way the backup described its own. */
async function sameShape(pg: PGlite, manifest: DrillManifest): Promise<void> {
  const names = manifest.tables.map((t) => t.table);
  const missing = (await pg.query<{ t: string }>(
    `SELECT t FROM unnest($1::text[]) WITH ORDINALITY AS u(t, ord)
     WHERE coalesce((SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.' || quote_ident(u.t))), '-') <> 'r'
     ORDER BY ord`,
    [names],
  )).rows.map((r) => r.t);
  if (missing.length) throw new BackupProblem(`FleetSuite's migrations don't make ${listed(missing)}, which the backup has.`);

  let made: { state: string; tables: BackupTable[] };
  try {
    made = (await pg.query<{ r: typeof made }>('SELECT public.books_backup_begin($1::jsonb) AS r', [JSON.stringify({ how: 'nightly', tables: names })])).rows[0].r;
  } catch (err) {
    throw new BackupProblem(`Couldn't describe the scratch database's tables: ${reasonOf(err)}`);
  }
  if (made?.state !== 'started' || !Array.isArray(made.tables)) throw new BackupProblem("Couldn't describe the scratch database's tables.");
  const madeOf = new Map(made.tables.map((t) => [t.table, t]));
  for (const t of manifest.tables) {
    const problem = shapeProblem(t, madeOf.get(t.table)!);
    if (problem) throw new BackupProblem(problem);
  }
}

/** Every table emptied and loaded from its file, triggers off, then each identity column's numbering set past its highest number. */
async function restoreInto(pg: PGlite, zip: JSZip, name: string, manifest: DrillManifest, inTime: (doing: string) => void): Promise<void> {
  const tables = new Map(manifest.tables.map((t) => [t.table, t]));
  await pg.exec('SET session_replication_role = replica');
  try {
    await pg.exec(`TRUNCATE ${manifest.tables.map((t) => `public.${ident(t.table)}`).join(', ')} CASCADE`);
  } catch (err) {
    throw new BackupProblem(`Couldn't empty the scratch database's tables: ${reasonOf(err)}`);
  }
  for (const table of manifest.load_order) {
    inTime(`loading ${table}`);
    const t = tables.get(table)!;
    const csv = await zip.file(`${name}/${t.file}`)!.async('arraybuffer');
    try {
      await pg.query(
        `COPY public.${ident(table)} (${t.columns.map((c) => ident(c.name)).join(', ')}) FROM '/dev/blob' WITH (FORMAT csv, HEADER MATCH, ENCODING 'UTF8')`,
        [],
        { blob: new Blob([csv]) },
      );
    } catch (err) {
      throw new BackupProblem(`${t.file} wouldn't load into the scratch database: ${reasonOf(err)}`);
    }
  }
  await pg.exec('SET session_replication_role = origin');
  for (const t of manifest.tables) {
    for (const column of t.identity) {
      await pg.query(
        `SELECT setval(pg_get_serial_sequence($1, $2), coalesce(max(${ident(column)}), 1), max(${ident(column)}) IS NOT NULL) FROM public.${ident(t.table)}`,
        [`public.${ident(t.table)}`, column],
      );
    }
  }
}

/** What the restored books hold, once they've checked out. */
export interface DrillCounts {
  tables: number;
  rows: number;
  entries: number;
  lines: number;
  links: number;
}

interface Link {
  name: string;
  child: string;
  parent: string;
  from: string[];
  to: string[];
}

/** The restored books, checked; the first thing wrong is said. */
async function checkRestored(pg: PGlite, manifest: DrillManifest, inTime: (doing: string) => void): Promise<DrillCounts> {
  inTime('checking the restored books');
  const names = manifest.tables.map((t) => t.table);

  // Each table holds the rows the manifest says.
  let rows = 0;
  for (const t of manifest.tables) {
    const n = await count(pg, `SELECT count(*) AS n FROM public.${ident(t.table)}`);
    if (n !== t.rows) {
      throw new BackupProblem(`${t.table} has ${counted(n, 'row', 'rows')} in the scratch database, and the backup's manifest says ${t.rows.toLocaleString('en-US')}.`);
    }
    rows += n;
  }

  // Every row a foreign key between the books' tables points from finds its row; the triggers were off while they loaded.
  const links = (await pg.query<Link>(
    `SELECT c.conname::text AS name, ch.relname::text AS child, pa.relname::text AS parent,
       (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS "from",
       (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS "to"
     FROM pg_catalog.pg_constraint c
     JOIN pg_catalog.pg_class ch ON ch.oid = c.conrelid
     JOIN pg_catalog.pg_class pa ON pa.oid = c.confrelid
     WHERE c.contype = 'f' AND ch.relnamespace = 'public'::regnamespace AND pa.relnamespace = 'public'::regnamespace
       AND ch.relname = ANY($1::text[]) AND pa.relname = ANY($1::text[])
     ORDER BY ch.relname, c.conname`,
    [names],
  )).rows;
  for (const link of links) {
    inTime('checking the links between the restored tables');
    const n = await count(pg,
      `SELECT count(*) AS n FROM public.${ident(link.child)} x
       WHERE ${link.from.map((c) => `x.${ident(c)} IS NOT NULL`).join(' AND ')}
         AND NOT EXISTS (SELECT 1 FROM public.${ident(link.parent)} y WHERE ${link.from.map((c, i) => `y.${ident(link.to[i])} = x.${ident(c)}`).join(' AND ')})`);
    if (n) {
      throw new BackupProblem(`${counted(n, `row of ${link.child} points`, `rows of ${link.child} point`)} at ${link.parent} rows the backup doesn't have (${link.name}).`);
    }
  }

  // The journal, as migration 359's triggers keep it when an entry posts.
  inTime('checking the restored journal');
  const entries = await count(pg, 'SELECT count(*) AS n FROM public.gl_entries');
  const lines = await count(pg, 'SELECT count(*) AS n FROM public.gl_lines');
  if (entries !== manifest.journal.entries) {
    throw new BackupProblem(`The restored journal has ${counted(entries, 'entry', 'entries')}, and the backup was made with ${counted(manifest.journal.entries, 'entry', 'entries')}.`);
  }
  if (lines !== manifest.journal.lines) {
    throw new BackupProblem(`The restored journal has ${counted(lines, 'line', 'lines')}, and the backup was made with ${counted(manifest.journal.lines, 'line', 'lines')}.`);
  }
  const first = async (sql: string) => (await pg.query<{ n: number | string; entry_no: number | string | null }>(sql)).rows[0];
  const short = await first(
    `SELECT count(*) AS n, min(entry_no) AS entry_no FROM (
       SELECT e.entry_no FROM public.gl_entries e LEFT JOIN public.gl_lines l ON l.entry_id = e.id
       GROUP BY e.id, e.entry_no HAVING count(l.id) < 2) s`);
  if (Number(short.n)) {
    throw new BackupProblem(`${counted(Number(short.n), 'journal entry has', 'journal entries have')} fewer than two lines in the restored books, entry ${short.entry_no} first.`);
  }
  const unbalanced = (await pg.query<{ entry_no: number | string; debit: string; credit: string; n: number | string }>(
    `SELECT entry_no, debit, credit, count(*) OVER () AS n FROM (
       SELECT e.entry_no, sum(l.debit)::text AS debit, sum(l.credit)::text AS credit
       FROM public.gl_entries e JOIN public.gl_lines l ON l.entry_id = e.id
       GROUP BY e.id, e.entry_no HAVING sum(l.debit) <> sum(l.credit)) s
     ORDER BY entry_no LIMIT 1`)).rows[0];
  if (unbalanced) {
    throw new BackupProblem(`${counted(Number(unbalanced.n), "journal entry doesn't", "journal entries don't")} balance in the restored books: entry ${unbalanced.entry_no} has `
      + `${moneyText(exactCents(unbalanced.debit))} of debits and ${moneyText(exactCents(unbalanced.credit))} of credits.`);
  }
  const strays = await first(
    `SELECT count(*) AS n, min(e.entry_no) AS entry_no FROM public.gl_lines l JOIN public.gl_entries e ON e.id = l.entry_id
     WHERE l.company_id IS DISTINCT FROM e.company_id OR l.entry_date IS DISTINCT FROM e.entry_date`);
  if (Number(strays.n)) {
    const n = Number(strays.n);
    throw new BackupProblem(`${counted(n, 'journal line has', 'journal lines have')} a company or date other than ${n === 1 ? 'its' : 'their'} entry's in the restored books, entry ${strays.entry_no} first.`);
  }
  const elsewhere = await first(
    `SELECT count(*) AS n, min(e.entry_no) AS entry_no FROM public.gl_lines l
     JOIN public.gl_entries e ON e.id = l.entry_id JOIN public.gl_accounts a ON a.id = l.account_id
     WHERE a.company_id IS NOT NULL AND a.company_id <> e.company_id`);
  if (Number(elsewhere.n)) {
    throw new BackupProblem(`${counted(Number(elsewhere.n), 'journal line is', 'journal lines are')} on another company's account in the restored books, entry ${elsewhere.entry_no} first.`);
  }

  // The journal adds up, account by account, to the trial balance the backup was made with.
  const sums = (await pg.query<{ company_id: string; account_id: string; debit: string; credit: string }>(
    `SELECT company_id::text, account_id::text, sum(debit)::text AS debit, sum(credit)::text AS credit
     FROM public.gl_lines GROUP BY company_id, account_id`)).rows;
  const accountName = new Map((await pg.query<{ id: string; label: string }>(
    `SELECT a.id::text AS id, concat_ws(' ', a.number, a.name) AS label FROM public.gl_accounts a`)).rows.map((r) => [r.id, r.label]));
  const companyCode = new Map((await pg.query<{ id: string; code: string }>('SELECT id::text AS id, code FROM public.gl_companies')).rows.map((r) => [r.id, r.code]));
  const named = (companyId: string, accountId: string) => `${accountName.get(accountId) ?? `account ${accountId}`}${companyCode.has(companyId) ? ` (${companyCode.get(companyId)})` : ''}`;
  const restored = new Map(sums.map((s) => [`${s.company_id}|${s.account_id}`, s]));
  const madeWith = new Map(manifest.journal.trial_balance.map((a) => [`${a.company_id}|${a.account_id}`, a]));
  const cents = (a: { debit: string; credit: string } | undefined) => ({ debit: a ? exactCents(a.debit) : 0, credit: a ? exactCents(a.credit) : 0 });
  for (const key of new Set([...madeWith.keys(), ...restored.keys()])) {
    const got = cents(restored.get(key));
    const want = cents(madeWith.get(key));
    if (got.debit !== want.debit || got.credit !== want.credit) {
      const [companyId, accountId] = key.split('|');
      throw new BackupProblem(`The restored journal adds up differently for ${named(companyId, accountId)}: ${moneyText(got.debit)} of debits and ${moneyText(got.credit)} of credits, `
        + `and the backup was made with ${moneyText(want.debit)} and ${moneyText(want.credit)}.`);
    }
  }

  return { tables: manifest.tables.length, rows, entries, lines, links: links.length };
}

// ── Running one ────────────────────────────────────────────────────────────

export interface DrillRunOptions {
  how: 'nightly' | 'by_hand';
  /** profiles.id and name of who pressed Test restore now. */
  by?: string | null;
  byName?: string | null;
  /** The made backup to restore, by hand; the newest made one otherwise. */
  backup?: string | null;
  /** Date.now() past which it stops and fails, before the platform cuts it off. */
  deadline: number;
  /** Where FleetSuite's migrations are; the app's own unless a test gives others. */
  migrationsDir?: string;
  /** Makes the scratch database; buildScratchBooks unless a test hands over one ready made. */
  scratch?: (migrations: readonly DrillMigration[], inTime: () => void) => Promise<PGlite>;
}

export interface DrillRunResult {
  /** none: no made backup to restore; drilled: the nightly found the newest already passed. */
  state: 'passed' | 'failed' | 'running' | 'none' | 'drilled';
  id: string | null;
  backupId: string | null;
  startedAt: string | null;
  counts: DrillCounts | null;
  error: string | null;
  heartbeat?: HeartbeatResult;
}

interface Started {
  state: 'started';
  id: string;
  started_at: string;
  migration: string | null;
  backup: DrillBackup;
}
interface NotStarted {
  state: 'none' | 'running' | 'drilled';
  id?: string;
  started_at?: string;
  backup_id?: string;
}

async function call<T>(service: SupabaseClient, fn: string, p: Record<string, unknown>): Promise<T> {
  const { data, error } = await service.rpc(fn, { p });
  if (error) throw new Error(error.message || `${fn} failed`);
  return data as T;
}

/** Why a drill couldn't start: the database's own refusal as a sentence ('books: there's no such backup' → "There's no such backup."), or what went wrong. */
function startProblem(err: unknown): string {
  const said = reasonOf(err);
  if (!said.startsWith('books: ')) return `Couldn't start a restore test: ${said}`;
  const why = said.slice('books: '.length);
  return `${why.charAt(0).toUpperCase()}${why.slice(1)}${/[.?!]$/.test(why) ? '' : '.'}`;
}

/** Restores the backup into a scratch database and checks it; what came back, or a BackupProblem saying what's wrong. */
async function drill(begun: Started, opts: DrillRunOptions): Promise<DrillCounts> {
  const inTime = (doing: string) => {
    if (Date.now() > opts.deadline) throw new BackupProblem(`It ran out of time ${doing}.`);
  };
  inTime('before it opened the backup');
  const { zip, name, bytes, manifest } = await openBackup(begun.backup);

  // The backup's own check, again: every file as written, and the journal adding up to its trial balance.
  const problem = await checkBackup(bytes, {
    name,
    manifest,
    tb: { entries: manifest.journal.entries, lines: manifest.journal.lines, accounts: manifest.journal.trial_balance },
  });
  if (problem) throw new BackupProblem(problem);

  inTime('before it made the scratch database');
  const tables = [...new Set([...BACKUP_TABLES, ...manifest.tables.map((t) => t.table)])];
  const migrations = readDrillMigrations(opts.migrationsDir ?? migrationsFolder(), tables, manifest.migration ?? null);
  const pg = await (opts.scratch ?? buildScratchBooks)(migrations, () => inTime('making the scratch database'));
  try {
    await sameShape(pg, manifest);
    await restoreInto(pg, zip, name, manifest, inTime);
    return await checkRestored(pg, manifest, inTime);
  } catch (err) {
    if (err instanceof BackupProblem) throw err;
    throw new BackupProblem(`The scratch database refused it: ${reasonOf(err)}`);
  } finally {
    await pg.close().catch(() => undefined);
  }
}

/**
 * Runs a restore drill now: starts it (one at a time; one already running is
 * said, not doubled; the nightly one skips a backup that already passed),
 * restores the backup into a scratch database and checks it, and writes how
 * it went to its row and to sync_state. Never throws for a problem with the
 * backup or the restore; a failed one says why.
 */
export async function runRestoreDrill(service: SupabaseClient, opts: DrillRunOptions): Promise<DrillRunResult> {
  const startedAt = Date.now();
  let begun: Started | NotStarted;
  try {
    begun = await call<Started | NotStarted>(service, 'books_restore_drill_begin', {
      how: opts.how,
      by: opts.how === 'by_hand' ? opts.by ?? null : null,
      by_name: opts.how === 'by_hand' ? opts.byName ?? null : null,
      backup: opts.how === 'by_hand' ? opts.backup ?? null : null,
    });
  } catch (err) {
    const error = startProblem(err);
    const heartbeat = await recordHeartbeat(service, BOOKS_RESTORE_DRILL, { how: opts.how, state: 'failed', error }, { startedAt, records: null, touchLastSyncedAt: false });
    return { state: 'failed', id: null, backupId: null, startedAt: null, counts: null, error, heartbeat };
  }
  if (begun.state !== 'started') {
    return { state: begun.state, id: begun.id ?? null, backupId: begun.backup_id ?? null, startedAt: begun.started_at ?? null, counts: null, error: null };
  }

  let counts: DrillCounts | null = null;
  let error: string | null = null;
  try {
    counts = await drill(begun, opts);
  } catch (err) {
    error = err instanceof BackupProblem ? err.message : `Something went wrong: ${reasonOf(err)}`;
    console.error('[books] restore drill failed:', reasonOf(err));
  }
  const status: 'passed' | 'failed' = counts ? 'passed' : 'failed';
  const finalError = counts ? null : (error ?? 'It stopped without saying why.');
  try {
    await call(service, 'books_restore_drill_finish', { id: begun.id, status, error: finalError, ...(counts ?? {}) });
  } catch (err) {
    // Whatever the record wouldn't take, it says the drill failed and why.
    const why = `The restore test's record wouldn't take how it went: ${reasonOf(err)}`;
    await call(service, 'books_restore_drill_finish', { id: begun.id, status: 'failed', error: why }).catch(() => null);
    const heartbeat = await recordHeartbeat(service, BOOKS_RESTORE_DRILL, { how: opts.how, id: begun.id, backup: begun.backup.id, state: 'failed', error: why }, { startedAt, records: null, touchLastSyncedAt: false });
    return { state: 'failed', id: begun.id, backupId: begun.backup.id, startedAt: begun.started_at, counts: null, error: why, heartbeat };
  }

  const heartbeat = await recordHeartbeat(service, BOOKS_RESTORE_DRILL, {
    how: opts.how,
    id: begun.id,
    backup: begun.backup.id,
    state: status,
    ...(counts ?? {}),
    ...(finalError ? { error: finalError } : {}),
  }, { startedAt, records: counts?.rows ?? null, touchLastSyncedAt: status === 'passed' });
  return { state: status, id: begun.id, backupId: begun.backup.id, startedAt: begun.started_at, counts, error: finalError, heartbeat };
}

// ── Reading them back ──────────────────────────────────────────────────────

export type DrillStatus = 'running' | 'passed' | 'failed' | 'stopped';

/** One drill as Books → Backups shows it. */
export interface DrillRecord {
  id: string;
  backupId: string;
  how: 'nightly' | 'by_hand';
  askedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: DrillStatus;
  tables: number | null;
  rows: number | null;
  entries: number | null;
  lines: number | null;
  links: number | null;
  error: string | null;
}

const DRILL_COLUMNS = 'id, backup_id, how, asked_by_name, started_at, finished_at, status, table_count, row_count, entry_count, line_count, link_count, error';

const asNumber = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** A row of books_restore_drills as the page shows it; one still running past DRILL_STOPPED_MINUTES has stopped. */
export function drillRecordOf(row: any, now: Date): DrillRecord {
  const startedAt = String(row.started_at);
  const stopped = row.status === 'running' && now.getTime() - new Date(startedAt).getTime() > DRILL_STOPPED_MINUTES * 60_000;
  return {
    id: row.id,
    backupId: row.backup_id,
    how: row.how,
    askedBy: row.asked_by_name ?? null,
    startedAt,
    finishedAt: row.finished_at ?? null,
    status: stopped ? 'stopped' : row.status,
    tables: asNumber(row.table_count),
    rows: asNumber(row.row_count),
    entries: asNumber(row.entry_count),
    lines: asNumber(row.line_count),
    links: asNumber(row.link_count),
    error: stopped ? 'It stopped before it finished.' : row.error ?? null,
  };
}

/** The next nightly drill after `now`: 08:51 UTC, 2:51 AM Central (3:51 in summer time). */
export function nextNightlyDrill(now: Date): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DRILL_NIGHTLY_UTC.hour, DRILL_NIGHTLY_UTC.minute));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** How the newest good backup's restore stands: what Books → Backups says first, and what the daily check tells. */
export interface NewestBackupTest {
  backupId: string;
  backupAt: string;
  /** Its latest restore drill, if it has had one. */
  drill: DrillRecord | null;
  /** It has had none, DRILL_DUE_MINUTES after it began: the night's drill didn't run. */
  overdue: boolean;
}

export interface DrillsView {
  /** The newest DRILLS_LISTED, newest first. */
  drills: DrillRecord[];
  lastPassed: DrillRecord | null;
  /** Null until a backup is made. */
  newest: NewestBackupTest | null;
  next: string;
}

async function newestBackupTest(service: SupabaseClient, now: Date): Promise<NewestBackupTest | null> {
  const made = await service.from('books_backups').select('id, started_at')
    .eq('status', 'made').order('started_at', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (made.error) throw new Error(`couldn't read the backups (${made.error.message})`);
  const backup = made.data?.[0] as { id: string; started_at: string } | undefined;
  if (!backup) return null;
  const { data, error } = await service.from('books_restore_drills').select(DRILL_COLUMNS)
    .eq('backup_id', backup.id).order('started_at', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (error) throw new Error(`couldn't read the restore tests (${error.message})`);
  const backupAt = String(backup.started_at);
  const drill = data?.[0] ? drillRecordOf(data[0], now) : null;
  return { backupId: backup.id, backupAt, drill, overdue: !drill && now.getTime() - new Date(backupAt).getTime() > DRILL_DUE_MINUTES * 60_000 };
}

async function lastPassedDrill(service: SupabaseClient, now: Date): Promise<DrillRecord | null> {
  const { data, error } = await service.from('books_restore_drills').select(DRILL_COLUMNS)
    .eq('status', 'passed').order('started_at', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (error) throw new Error(`couldn't read the restore tests (${error.message})`);
  return data?.[0] ? drillRecordOf(data[0], now) : null;
}

/** Books → Backups: the newest drills, the last one that passed, how the newest good backup's stands, and when the next nightly one runs. */
export async function loadDrills(service: SupabaseClient, now = new Date()): Promise<DrillsView> {
  const { data, error } = await service.from('books_restore_drills').select(DRILL_COLUMNS)
    .order('started_at', { ascending: false }).order('id', { ascending: false }).limit(DRILLS_LISTED);
  if (error) throw new Error(`couldn't read the restore tests (${error.message})`);
  const drills = (data ?? []).map((r) => drillRecordOf(r, now));
  return {
    drills,
    lastPassed: drills.find((d) => d.status === 'passed') ?? await lastPassedDrill(service, now),
    newest: await newestBackupTest(service, now),
    next: nextNightlyDrill(now).toISOString(),
  };
}

// ── The daily check's look ─────────────────────────────────────────────────

/** What the daily check's first look tells about the newest good backup's restore: its latest drill failed, or none ran on it. */
export interface DrillAlertItem {
  kind: 'failed' | 'missed';
  id: string | null;
  backupId: string;
  backupAt: string;
  error: string | null;
}

/** Looked at only at the day's first look, after the night's drill, so each problem is told once a day. */
export async function lookAtDrills(service: SupabaseClient, first: boolean, now = new Date()): Promise<DrillAlertItem | null> {
  if (!first) return null;
  const newest = await newestBackupTest(service, now);
  // No good backup at all is the backups' own alert to tell.
  if (!newest) return null;
  const { backupId, backupAt, drill } = newest;
  if (newest.overdue) return { kind: 'missed', id: null, backupId, backupAt, error: null };
  if (drill && (drill.status === 'failed' || drill.status === 'stopped')) return { kind: 'failed', id: drill.id, backupId, backupAt, error: drill.error };
  return null;
}
