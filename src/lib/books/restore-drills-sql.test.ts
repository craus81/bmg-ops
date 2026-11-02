// Migration 507 records the restore drills: a drill restores a made backup,
// one runs at a time, the nightly one skips a backup that has already
// passed, and a drill's record changes only while it runs. This runs
// migrations 359, 360, 387, 506 and 507 in an in-memory Postgres (PGlite) as
// the app's server login and holds each rule.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { unguardedWrites } from './sql-writes';

let db: PGlite;
const CRAIG = '0b5e1d4a-2f43-4f0f-9d5e-6c1f7a9b3e21';
const SHA = 'a'.repeat(64);

const rpc = async <T = any>(fn: string, p: Record<string, unknown>): Promise<T> => {
  const r = await db.query<{ r: T }>(`SELECT ${fn}(p => $1::jsonb) AS r`, [JSON.stringify(p)]);
  return r.rows[0].r;
};

let fileSeq = 0;
/** A backup that ran and finished made (with its file and counts) or failed. */
const backup = async (status: 'made' | 'failed' = 'made'): Promise<string> => {
  const begun = await rpc('books_backup_begin', { how: 'nightly', tables: ['gl_companies'] });
  expect(begun.state).toBe('started');
  const n = String(++fileSeq).padStart(6, '0');
  await rpc('books_backup_finish', status === 'made'
    ? {
      id: begun.id, status, file_path: `2026/fleetsuite-books-2026-11-03-${n}Z.zip`, file_bytes: 2048, file_sha256: SHA,
      tables: 90, rows: 1234, entries: 56, lines: 140, checked: true,
    }
    : { id: begun.id, status, error: 'It ran out of time.' });
  // The next backup begins a moment after this one (the clock counts milliseconds), so the newest is plain.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return begun.id;
};

/** Finishes whatever drill is running, so the next begin starts one. */
const finishRunning = async () => {
  const r = await db.query<{ id: string }>(`SELECT id FROM books_restore_drills WHERE status = 'running'`);
  for (const { id } of r.rows) await rpc('books_restore_drill_finish', { id, status: 'failed', error: 'Test over.' });
};

const passed = (id: string, over: Record<string, unknown> = {}) => rpc('books_restore_drill_finish', {
  id, status: 'passed', tables: 90, rows: 1234, entries: 56, lines: 140, links: 41, ...over,
});

const drill = async (id: string) => (await db.query<Record<string, any>>('SELECT * FROM books_restore_drills WHERE id = $1', [id])).rows[0];

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
  for (const file of ['359-books-ledger-core.sql', '360-books-netsuite-accounts.sql', '387-books-retired-accounts.sql', '506-books-backups.sql', '507-books-restore-drills.sql']) {
    const sql = readFileSync(path.resolve(__dirname, '../../../migrations', file), 'utf8');
    await db.exec(sql);
    await db.exec(sql); // must be safe to re-run
  }
  await db.exec(`
    CREATE TABLE public.schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
    INSERT INTO public.schema_migrations (filename) VALUES ('506-books-backups.sql'), ('507-books-restore-drills.sql');
  `);
  await db.exec('SET ROLE service_role');
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('migration 507: starting a drill', () => {
  it('has nothing to restore before a backup is made', async () => {
    expect(await rpc('books_restore_drill_begin', { how: 'nightly' })).toEqual({ state: 'none' });
    expect(await rpc('books_restore_drill_begin', { how: 'by_hand', by: CRAIG, by_name: 'Craig George' })).toEqual({ state: 'none' });
    await backup('failed');
    expect(await rpc('books_restore_drill_begin', { how: 'nightly' })).toEqual({ state: 'none' });
    expect((await db.query('SELECT id FROM books_restore_drills')).rows).toEqual([]);
  });

  it('restores the newest made backup, handing back its file, size, SHA-256, migration and counts', async () => {
    await backup('made');
    const newest = await backup('made');
    await backup('failed');
    const r = await rpc('books_restore_drill_begin', { how: 'nightly' });
    expect(r.state).toBe('started');
    expect(r.backup).toMatchObject({
      id: newest, file_path: '2026/fleetsuite-books-2026-11-03-000003Z.zip', file_bytes: 2048, file_sha256: SHA,
      migration: '507-books-restore-drills.sql', tables: 90, rows: 1234, entries: 56, lines: 140,
    });
    expect(r.migration).toBe('507-books-restore-drills.sql');
    const row = await drill(r.id);
    expect(row).toMatchObject({ backup_id: newest, how: 'nightly', status: 'running', asked_by: null, asked_by_name: null, finished_at: null, error: null });
    expect(row.migration).toBe('507-books-restore-drills.sql');
    await passed(r.id);
  });

  it('runs one at a time: a second asks back which is running, nightly or by hand', async () => {
    const first = await rpc('books_restore_drill_begin', { how: 'by_hand', by: CRAIG, by_name: 'Craig George' });
    expect(first.state).toBe('started');
    for (const how of ['nightly', 'by_hand']) {
      const again = await rpc('books_restore_drill_begin', { how, by: CRAIG });
      expect(again).toMatchObject({ state: 'running', id: first.id, how: 'by_hand', backup_id: first.backup.id });
      expect(again.started_at).toBeTruthy();
    }
    await finishRunning();
  });

  it('skips a backup that has passed at night, but restores it again by hand', async () => {
    const before = (await db.query('SELECT id FROM books_restore_drills')).rows.length;
    const nightly = await rpc('books_restore_drill_begin', { how: 'nightly' });
    const passedOne = (await db.query<{ id: string; backup_id: string }>(
      `SELECT id, backup_id FROM books_restore_drills WHERE status = 'passed' ORDER BY started_at DESC LIMIT 1`,
    )).rows[0];
    expect(nightly).toEqual({ state: 'drilled', id: passedOne.id, backup_id: passedOne.backup_id });
    expect((await db.query('SELECT id FROM books_restore_drills')).rows.length).toBe(before);

    const byHand = await rpc('books_restore_drill_begin', { how: 'by_hand', by: CRAIG, by_name: ' Craig George ' });
    expect(byHand.state).toBe('started');
    expect(byHand.backup.id).toBe(passedOne.backup_id);
    expect(await drill(byHand.id)).toMatchObject({ how: 'by_hand', asked_by: CRAIG, asked_by_name: 'Craig George' });
    await finishRunning();
  });

  it('tries a failed one again at night, and takes up a newer backup', async () => {
    const newer = await backup('made');
    const first = await rpc('books_restore_drill_begin', { how: 'nightly' });
    expect(first.backup.id).toBe(newer);
    await rpc('books_restore_drill_finish', { id: first.id, status: 'failed', error: 'A table came back short.' });
    const again = await rpc('books_restore_drill_begin', { how: 'nightly' });
    expect(again.state).toBe('started');
    expect(again.backup.id).toBe(newer);
    await passed(again.id);
    expect((await rpc('books_restore_drill_begin', { how: 'nightly' })).state).toBe('drilled');
  });

  it('restores a backup named by hand, only one that was made', async () => {
    const older = (await db.query<{ id: string }>(`SELECT id FROM books_backups WHERE status = 'made' ORDER BY started_at LIMIT 1`)).rows[0].id;
    const r = await rpc('books_restore_drill_begin', { how: 'by_hand', by: CRAIG, by_name: 'Craig George', backup: older });
    expect(r.state).toBe('started');
    expect(r.backup.id).toBe(older);
    await finishRunning();

    const failedOne = (await db.query<{ id: string }>(`SELECT id FROM books_backups WHERE status = 'failed' LIMIT 1`)).rows[0].id;
    await expect(rpc('books_restore_drill_begin', { how: 'by_hand', backup: failedOne })).rejects.toThrow(/that backup wasn't made, so there's nothing to restore/);
    await expect(rpc('books_restore_drill_begin', { how: 'by_hand', backup: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/there's no such backup/);
    await expect(rpc('books_restore_drill_begin', { how: 'by_hand', backup: 'not-a-backup' })).rejects.toThrow(/uuid/);
  });

  it('is nightly or by hand, and keeps nobody as who asked for a nightly one', async () => {
    for (const how of [undefined, 'weekly', '']) {
      await expect(rpc('books_restore_drill_begin', { how })).rejects.toThrow(/a restore drill is nightly or by hand/);
    }
    const newer = await backup('made');
    const r = await rpc('books_restore_drill_begin', { how: 'nightly', by: CRAIG, by_name: 'Craig George' });
    expect(r.backup.id).toBe(newer);
    expect(await drill(r.id)).toMatchObject({ asked_by: null, asked_by_name: null });
    await finishRunning();
  });

  it('marks one that stopped ten minutes ago failed and starts another', async () => {
    const stuck = await rpc('books_restore_drill_begin', { how: 'by_hand' });
    await db.exec('RESET ROLE');
    await db.query(`ALTER TABLE books_restore_drills DISABLE TRIGGER books_restore_drills_guard`);
    await db.query(`UPDATE books_restore_drills SET started_at = now() - INTERVAL '11 minutes' WHERE id = $1`, [stuck.id]);
    await db.query(`ALTER TABLE books_restore_drills ENABLE TRIGGER books_restore_drills_guard`);
    await db.exec('SET ROLE service_role');

    const next = await rpc('books_restore_drill_begin', { how: 'by_hand' });
    expect(next.state).toBe('started');
    expect(await drill(stuck.id)).toMatchObject({ status: 'failed', error: 'It stopped before it finished.' });
    expect((await drill(stuck.id)).finished_at).not.toBeNull();
    await finishRunning();
  });
});

describe('migration 507: finishing a drill', () => {
  it('writes a passed drill with what came back', async () => {
    const r = await rpc('books_restore_drill_begin', { how: 'by_hand' });
    const done = await passed(r.id, { tables: 88, rows: 99, entries: 7, lines: 15, links: 0 });
    expect(done).toMatchObject({ state: 'finished', id: r.id, status: 'passed' });
    expect(done.finished_at).toBeTruthy();
    expect(await drill(r.id)).toMatchObject({
      status: 'passed', table_count: 88, row_count: 99, entry_count: 7, line_count: 15, link_count: 0, error: null,
    });
  });

  it('writes a failed drill with why, trimmed and cut to 600 characters', async () => {
    const r = await rpc('books_restore_drill_begin', { how: 'by_hand' });
    await rpc('books_restore_drill_finish', { id: r.id, status: 'failed', error: `  ${'x'.repeat(700)}  `, tables: 3 });
    expect(await drill(r.id)).toMatchObject({ status: 'failed', error: 'x'.repeat(600), table_count: 3, link_count: null });
  });

  it('refuses a passed drill without what came back, or with an error, and leaves it running', async () => {
    const r = await rpc('books_restore_drill_begin', { how: 'by_hand' });
    for (const missing of ['tables', 'rows', 'entries', 'lines', 'links']) {
      await expect(passed(r.id, { [missing]: null })).rejects.toThrow(/"books_restore_drills_passed"/);
    }
    await expect(passed(r.id, { error: 'Something.' })).rejects.toThrow(/"books_restore_drills_passed"/);
    await expect(rpc('books_restore_drill_finish', { id: r.id, status: 'failed' })).rejects.toThrow(/"books_restore_drills_failed"/);
    await expect(rpc('books_restore_drill_finish', { id: r.id, status: 'done' })).rejects.toThrow(/passed or failed/);
    await expect(rpc('books_restore_drill_finish', { status: 'passed' })).rejects.toThrow(/which restore drill finished/);
    await expect(passed(r.id, { rows: -1 })).rejects.toThrow(/books_restore_drills_row_count_check/);
    expect((await drill(r.id)).status).toBe('running');
    await finishRunning();
  });

  it('says a drill that isn\'t running any more is gone', async () => {
    const r = await rpc('books_restore_drill_begin', { how: 'by_hand' });
    await finishRunning();
    expect(await passed(r.id)).toEqual({ state: 'gone' });
    expect(await rpc('books_restore_drill_finish', { id: '00000000-0000-4000-8000-000000000000', status: 'failed', error: 'x' })).toEqual({ state: 'gone' });
  });
});

describe('migration 507: a drill\'s record, however it\'s written', () => {
  const someBackup = async () => (await db.query<{ id: string }>(`SELECT id FROM books_backups WHERE status = 'made' LIMIT 1`)).rows[0].id;
  const insert = async (over: Record<string, unknown>) => {
    const row = {
      backup_id: await someBackup(), how: 'nightly', status: 'failed', finished_at: '2026-11-06T08:52:00Z', error: 'It ran out of time.', ...over,
    };
    const cols = Object.keys(row);
    await db.query(
      `INSERT INTO books_restore_drills (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };

  it('restores only a backup there is', async () => {
    await expect(insert({ backup_id: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(/books_restore_drills_backup_id_fkey/);
  });

  it('says why it failed without spaces around it, in at most 600 characters', async () => {
    for (const error of [' Padded.', 'Padded. ', '', 'x'.repeat(601)]) {
      await expect(insert({ error })).rejects.toThrow(/books_restore_drills_error_check/);
    }
    await insert({ error: 'x'.repeat(600) });
  });

  it('keeps who asked only for one made by hand', async () => {
    await expect(insert({ asked_by: CRAIG })).rejects.toThrow(/"books_restore_drills_who"/);
    await expect(insert({ asked_by_name: 'Craig George' })).rejects.toThrow(/"books_restore_drills_who"/);
    await insert({ how: 'by_hand', asked_by: CRAIG, asked_by_name: 'Craig George' });
  });

  it('has a finish time once it isn\'t running, and only then', async () => {
    await finishRunning();
    await expect(insert({ finished_at: null })).rejects.toThrow(/"books_restore_drills_finished"/);
    await expect(insert({ status: 'running', error: null })).rejects.toThrow(/"books_restore_drills_finished"/);
  });

  it('runs one at a time, and keeps when, how and on which backup it began', async () => {
    const r = await rpc('books_restore_drill_begin', { how: 'by_hand' });
    await expect(insert({ status: 'running', finished_at: null, error: null })).rejects.toThrow(/books_restore_drills_one_running/);
    const other = (await db.query<{ id: string }>(`SELECT id FROM books_backups WHERE status = 'made' AND id <> $1 LIMIT 1`, [r.backup.id])).rows[0].id;
    for (const [col, value] of [['started_at', '2026-01-01T00:00:00Z'], ['how', 'nightly'], ['backup_id', other], ['migration', '999-later.sql'], ['asked_by_name', 'Someone']]) {
      await expect(db.query(`UPDATE books_restore_drills SET ${col} = $1 WHERE id = $2`, [value, r.id])).rejects.toThrow(/only how a restore drill finished/);
    }
    await finishRunning();
  });

  it('keeps a finished drill\'s record as it is, and every record', async () => {
    const r = (await db.query<{ id: string }>(`SELECT id FROM books_restore_drills WHERE status = 'passed' LIMIT 1`)).rows[0];
    await expect(db.query(`UPDATE books_restore_drills SET error = 'Rewritten.' WHERE id = $1`, [r.id])).rejects.toThrow(/a finished restore drill's record doesn't change/);
    await expect(db.query(`DELETE FROM books_restore_drills WHERE id = $1`, [r.id])).rejects.toThrow(/a restore drill's record stays/);
    // A backup with a drill stays too.
    await expect(db.query(`DELETE FROM books_backups WHERE id = (SELECT backup_id FROM books_restore_drills WHERE id = $1)`, [r.id])).rejects.toThrow(/a backup's record stays/);
  });
});

describe('migration 507: access', () => {
  const functions = [
    'books_restore_drill_begin(jsonb)',
    'books_restore_drill_finish(jsonb)',
    'books_restore_drills_guard()',
  ];

  it('lets only the service role read the drills and call the functions', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const fn of functions) {
        const r = await db.query<{ ok: boolean }>("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, fn]);
        expect(r.rows[0].ok, `${role} ${fn}`).toBe(role === 'service_role');
      }
      const t = await db.query<{ ok: boolean }>("SELECT has_table_privilege($1, 'books_restore_drills', 'SELECT') AS ok", [role]);
      expect(t.rows[0].ok, `${role} books_restore_drills`).toBe(role === 'service_role');
    }
    const rls = await db.query<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'books_restore_drills'`);
    expect(rls.rows[0].on).toBe(true);
  });

  it('gives every DELETE and UPDATE in the functions a WHERE, as Supabase\'s API requires', async () => {
    const bodies = (await db.query<{ name: string; body: string }>(
      `SELECT p.proname AS name, p.prosrc AS body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'books\\_restore\\_drill%' ORDER BY p.proname`,
    )).rows;
    expect(bodies.map((b) => b.name)).toEqual(['books_restore_drill_begin', 'books_restore_drill_finish', 'books_restore_drills_guard']);
    expect(bodies.flatMap((b) => unguardedWrites(b.body).map((w) => `${b.name}: ${w}`))).toEqual([]);
  });
});

describe('migration 507: once a company\'s books are live', () => {
  // Last in the file: going live can't be undone.
  it('won\'t empty the drills\' record', async () => {
    await db.exec(`RESET ROLE; UPDATE gl_companies SET books_live_from = '2027-01-01' WHERE code = 'BMG';`);
    await expect(db.exec('TRUNCATE books_restore_drills')).rejects.toThrow(/books_restore_drills can't be emptied once any company's books are live/);
    await db.exec('SET ROLE service_role;');
  });
});
