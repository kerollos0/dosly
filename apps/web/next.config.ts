import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

// Behind Caddy (production) the proxy routes /api, /socket.io and /media itself. Without Caddy
// (local development) set API_INTERNAL_URL, or rely on the default, and Next proxies them.
const api = process.env.API_INTERNAL_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:4000');

const config: NextConfig = {
  output: 'standalone',
  // socket.io polls /socket.io/?EIO=…; a trailing-slash redirect would break it behind the dev rewrite
  skipTrailingSlashRedirect: true,
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  poweredByHeader: false,
  devIndicators: false,
  async rewrites() {
    if (!api) return [];
    return [
      { source: '/api/:path*', destination: `${api}/api/:path*` },
      { source: '/media/:path*', destination: `${api}/media/:path*` },
      { source: '/socket.io/', destination: `${api}/socket.io/` }, // the bare path needs its slash kept
      { source: '/socket.io/:path*', destination: `${api}/socket.io/:path*` }
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }
    ] }];
  }
};
export default config;
