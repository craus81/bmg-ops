import { it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readFileSync } from 'fs';
import { join } from 'path';
/**
 * Migration 379 (Client Files) on a real Postgres: it applies twice (deploys
 * re-run the pipeline), the copy queue column flags exactly the PDFs and
 * photos whose copy is missing or stale and gives up after three failures
 * per revision, and the per-folder counts refresh.
 */
it('migration 379 applies twice and behaves', async () => {
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`CREATE SCHEMA extensions; CREATE ROLE authenticated; CREATE ROLE anon;
    CREATE TABLE customers (id uuid primary key default gen_random_uuid(), company_name text);
    CREATE FUNCTION public.is_internal_staff() RETURNS boolean LANGUAGE sql AS 'select true';`);
  const sql = readFileSync(join(__dirname, '../../migrations/379-dropbox-client-files.sql'), 'utf8');
  await db.exec(sql);
  await db.exec(sql);
  await db.exec(`INSERT INTO dropbox_client_folders (dropbox_id, path_lower, name) VALUES ('id:f', '/office/clients/a', 'A');
    INSERT INTO dropbox_client_files (dropbox_id, folder_id, path_lower, path_display, rel_path, name, ext, kind, size_bytes, rev)
    SELECT 'id:1', id, '/office/clients/a/x.pdf', '/OFFICE/Clients/A/x.pdf', 'A/x.pdf', 'x.pdf', 'pdf', 'pdf', 100, 'r1' FROM dropbox_client_folders;
    INSERT INTO dropbox_client_files (dropbox_id, folder_id, path_lower, path_display, rel_path, name, ext, kind, size_bytes, rev)
    SELECT 'id:2', id, '/office/clients/a/y.eps', '/OFFICE/Clients/A/y.eps', 'A/y.eps', 'y.eps', 'eps', 'print', 900, 'r1' FROM dropbox_client_folders;`);
  let r = await db.query(`select dropbox_id, needs_copy from dropbox_client_files order by dropbox_id`);
  expect(r.rows).toEqual([{ dropbox_id: 'id:1', needs_copy: true }, { dropbox_id: 'id:2', needs_copy: false }]);
  await db.exec(`update dropbox_client_files set copied_rev='r1' where dropbox_id='id:1'`);
  r = await db.query(`select needs_copy from dropbox_client_files where dropbox_id='id:1'`);
  expect(r.rows[0]).toEqual({ needs_copy: false });
  await db.exec(`update dropbox_client_files set rev='r2' where dropbox_id='id:1'`);
  r = await db.query(`select needs_copy from dropbox_client_files where dropbox_id='id:1'`);
  expect(r.rows[0]).toEqual({ needs_copy: true });
  await db.exec(`update dropbox_client_files set copy_failed_rev='r2', copy_attempts=3 where dropbox_id='id:1'`);
  r = await db.query(`select needs_copy from dropbox_client_files where dropbox_id='id:1'`);
  expect(r.rows[0]).toEqual({ needs_copy: false });
  await db.exec(`select refresh_dropbox_client_folder_stats()`);
  r = await db.query(`select file_count, total_bytes::int as b from dropbox_client_folders`);
  expect(r.rows[0]).toEqual({ file_count: 2, b: 1000 });
});

/**
 * Migration 417 (Client Files linked onto graphics jobs): applies twice, a
 * file links once per job, and deleting the job or the file drops the link.
 */
it('migration 418 applies twice and behaves', async () => {
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(`CREATE SCHEMA extensions; CREATE ROLE authenticated; CREATE ROLE anon;
    CREATE TABLE customers (id uuid primary key default gen_random_uuid(), company_name text);
    CREATE TABLE profiles (id uuid primary key);
    CREATE TABLE graphics_jobs (id uuid primary key default gen_random_uuid());
    CREATE FUNCTION public.is_internal_staff() RETURNS boolean LANGUAGE sql AS 'select true';`);
  await db.exec(readFileSync(join(__dirname, '../../migrations/379-dropbox-client-files.sql'), 'utf8'));
  const sql = readFileSync(join(__dirname, '../../migrations/417-graphics-job-client-files.sql'), 'utf8');
  await db.exec(sql);
  await db.exec(sql);
  await db.exec(`INSERT INTO graphics_jobs DEFAULT VALUES;
    INSERT INTO dropbox_client_files (dropbox_id, path_lower, path_display, rel_path, name)
    VALUES ('id:1', '/office/clients/a/x.ai', '/OFFICE/Clients/A/x.ai', 'A/x.ai', 'x.ai');
    INSERT INTO graphics_job_client_files (job_id, client_file_id)
    SELECT j.id, f.id FROM graphics_jobs j, dropbox_client_files f;
    INSERT INTO graphics_job_client_files (job_id, client_file_id)
    SELECT j.id, f.id FROM graphics_jobs j, dropbox_client_files f ON CONFLICT (job_id, client_file_id) DO NOTHING;`);
  let r = await db.query(`select count(*)::int as n from graphics_job_client_files`);
  expect(r.rows[0]).toEqual({ n: 1 });
  await expect(db.exec(`INSERT INTO graphics_job_client_files (job_id, client_file_id)
    SELECT j.id, f.id FROM graphics_jobs j, dropbox_client_files f`)).rejects.toThrow();
  await db.exec(`delete from dropbox_client_files`);
  r = await db.query(`select count(*)::int as n from graphics_job_client_files`);
  expect(r.rows[0]).toEqual({ n: 0 });
});
