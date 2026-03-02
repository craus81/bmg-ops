/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActionsBodySizeLimit: '10mb',
  },
};

module.exports = nextConfig;
