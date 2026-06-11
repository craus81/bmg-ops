#!/usr/bin/env node
/**
 * Minimal migration runner for the SQL files in migrations/.
 *
 * Tracks applied migrations in a `schema_migrations` table (filename +
 * applied_at). Files run in lexicographic filename order; each pending file
 * runs inside a transaction and is recorded on success.
 *
 * Usage:
 *   npm run migrate                 # apply pending migrations
 *   npm run migrate -- --dry-run    # list pending migrations, change nothing
 *   npm run migrate:baseline        # record all files as applied WITHOUT
 *                                   # running them (one-time, for databases
 *                                   # that were migrated by hand before this
 *                                   # runner existed)
 *
 * Requires SUPABASE_DB_URL (Postgres connection string — Supabase dashboard
 * → Settings → Database → Connection string). DATABASE_URL also works.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(root, '.env.local') });
dotenv.config({ path: path.join(root, '.env') });

const MIGRATIONS_DIR = path.join(root, 'migrations');
const args = process.argv.slice(2);
const baseline = args.includes('--baseline');
const dryRun = args.includes('--dry-run');

const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  console.error(
    'Missing SUPABASE_DB_URL (or DATABASE_URL).\n' +
    'Get the Postgres connection string from the Supabase dashboard:\n' +
    '  Settings → Database → Connection string (URI)'
  );
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1/.test(dbUrl);
const client = new pg.Client({
  connectionString: dbUrl,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});

async function main() {
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await client.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));
  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log(`Up to date — ${applied.size} applied, nothing pending.`);
    return;
  }

  if (dryRun) {
    console.log(`${pending.length} pending migration(s):`);
    for (const f of pending) console.log(`  ${f}`);
    return;
  }

  if (baseline) {
    for (const f of pending) {
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
      console.log(`baselined  ${f}`);
    }
    console.log(`\nRecorded ${pending.length} migration(s) as applied without running them.`);
    return;
  }

  for (const f of pending) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`applied    ${f}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`\nFAILED     ${f}\n${err.message}`);
      console.error('Migration rolled back; nothing after it was run.');
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\nApplied ${pending.length} migration(s).`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => client.end());
