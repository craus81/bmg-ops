/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: '100mb',
    },
    outputFileTracingIncludes: {
      '/api/admin/sync-help-docs': ['./docs/help/**/*'],
    },
  },
};

module.exports = nextConfig;
