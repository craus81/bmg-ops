const RESTORE_DRILL_FILES = [
  './migrations/*.sql',
  './node_modules/@electric-sql/pglite/package.json',
  './node_modules/@electric-sql/pglite/dist/*.js',
  './node_modules/@electric-sql/pglite/dist/*.cjs',
  './node_modules/@electric-sql/pglite/dist/*.wasm',
  './node_modules/@electric-sql/pglite/dist/*.data',
  './node_modules/@electric-sql/pglite/dist/fs/*',
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      // Conservative cap. The codebase doesn't use server actions today; this
      // limits the blast radius if one is added. Bulk file uploads go through
      // /api/* routes and aren't bound by this setting. Raise deliberately
      // on a per-action basis if a future action genuinely needs more.
      bodySizeLimit: '10mb',
    },
    // The books' restore drill (src/lib/books/restore-drill.ts) runs Postgres
    // itself, as WebAssembly: PGlite is loaded from node_modules as it ships,
    // not bundled, so it finds its own .wasm and .data files beside it.
    serverComponentsExternalPackages: ['@electric-sql/pglite'],
    outputFileTracingIncludes: {
      '/api/admin/sync-help-docs': ['./docs/help/**/*'],
      // The Integration Checkup compares schema_migrations against the
      // migrations the repo actually ships, so the .sql filenames have to
      // travel with the serverless bundle. Only the names are read.
      '/api/system-health/connections': ['./migrations/*.sql'],
      // The restore drill builds its scratch database from the books'
      // migrations, and PGlite reads its Postgres build from files.
      '/api/admin/books/backups': RESTORE_DRILL_FILES,
      '/api/cron/books-restore-drill': RESTORE_DRILL_FILES,
    },
  },
};

module.exports = nextConfig;
