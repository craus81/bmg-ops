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
    outputFileTracingIncludes: {
      '/api/admin/sync-help-docs': ['./docs/help/**/*'],
    },
  },
};

module.exports = nextConfig;
