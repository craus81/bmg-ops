# Migrations

SQL migrations for the Supabase Postgres database, applied in lexicographic
filename order by `scripts/migrate.mjs`.

## Running

```sh
npm run migrate              # apply pending migrations
npm run migrate -- --dry-run # list what would run
```

Requires `SUPABASE_DB_URL` in `.env.local` — the Postgres connection string
from the Supabase dashboard (Settings → Database → Connection string).

Applied migrations are tracked in the `schema_migrations` table (filename +
timestamp). Each file runs in its own transaction and is recorded on success.

## Baseline for existing databases

Databases that predate this runner (e.g. production, which was migrated by
hand through the Supabase SQL editor) need a **one-time baseline** so the
runner doesn't try to re-apply history:

```sh
npm run migrate:baseline
```

This records every current file in `schema_migrations` **without executing
anything**. Only run it against a database whose schema is already up to
date. After that, `npm run migrate` applies only genuinely new files.

## Adding a migration

- Name it `<next-number>-<short-topic>.sql` — three digits, one number per
  file, next free number (no gaps needed, no duplicates allowed).
- Write idempotent SQL where practical (`IF NOT EXISTS`, `CREATE OR REPLACE`)
  — the historical files follow this convention.
- Don't renumber or edit files that have already been applied somewhere.

## History notes (June 2026 cleanup)

- The `000-0X-setup-*.sql` files are the original pre-numbering schema setup,
  moved here from the repo root; they sort before `001`.
- Former duplicate numbers 072–078 (two parallel work streams) were
  renumbered into unique slots 072–085, shifting the old 079–101 to 086–108.
  Both orderings are dependency-valid; already-migrated databases are
  unaffected because application state is tracked by the baseline, not by
  filename history.
- `scripts/sql/` holds one-off repair scripts that are *not* part of the
  migration sequence.
- The full sequence was replay-tested on a fresh Postgres 16 instance.
  **Caveat:** seven core tables predate all SQL files and were created
  through the Supabase UI, so they are not captured here: `profiles`,
  `companies`, `customers`, `purchase_orders`, `po_line_items`,
  `scanned_vehicles`, `notifications`, plus `time_entries`/`time_breaks`
  and `vehicle_photos`. Bootstrapping a brand-new environment requires a
  schema dump of those tables first (`pg_dump --schema-only` from an
  existing environment). Two unrecorded production ALTERs
  (`customer_job_assignments.job_id` uuid→text and
  `graphics_proofs.graphics_job_id`) were back-filled into `027` as
  no-op-safe statements during the cleanup.
