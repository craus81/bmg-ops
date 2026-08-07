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
 *   node scripts/migrate.mjs --deploy
 *                                   # build-pipeline mode (wired into `npm run
 *                                   # build`): applies pending migrations only
 *                                   # on Vercel PRODUCTION builds, is a no-op
 *                                   # everywhere else, and fails the build if
 *                                   # a migration fails — so code whose schema
 *                                   # didn't apply never goes live
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
const deploy = args.includes('--deploy');

// Deploy mode gates on the Vercel environment, not just the presence of a
// connection string: preview deploys build unmerged PR branches against the
// production database, and must never apply their migrations.
if (deploy && process.env.VERCEL_ENV !== 'production') {
  console.log(
    `Migrations skipped (VERCEL_ENV=${process.env.VERCEL_ENV || 'unset'} — ` +
    'deploy mode only runs on Vercel production builds).'
  );
  process.exit(0);
}

const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!dbUrl) {
  if (deploy) {
    // Missing secret shouldn't brick every deploy — warn loudly and ship.
    // (Once SUPABASE_DB_URL is set in Vercel's Production env, this branch
    // never runs again.)
    console.warn(
      'WARNING: SUPABASE_DB_URL is not set — deploying WITHOUT applying ' +
      'migrations. Add it in Vercel → Settings → Environment Variables ' +
      '(Production scope, "Session pooler" URI from the Supabase dashboard).'
    );
    process.exit(0);
  }
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
  // Serialize concurrent runners (e.g. two production builds racing) — the
  // session-level lock releases automatically when this client disconnects.
  if (!dryRun) await client.query('SELECT pg_advisory_lock(727274001)');
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
