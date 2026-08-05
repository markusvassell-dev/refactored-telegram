/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output keeps the Docker image small and self-contained.
  output: 'standalone',
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages are TypeScript source; Next compiles them in place.
  transpilePackages: [
    '@element/shared',
    '@element/database',
    '@element/documents',
    '@element/integrations',
    '@element/services',
    '@element/workflows',
    '@element/pricing',
    '@element/dates',
    '@element/audit',
    '@element/ui',
  ],
  // Keep the Prisma engine and the PDF parser out of the client bundle.
  serverExternalPackages: ['@prisma/client', 'pdfjs-dist'],

  webpack: (config) => {
    // Workspace packages are TypeScript ESM source and import siblings with a
    // .js specifier, which is what TypeScript emits. Teach webpack to resolve
    // those back to the .ts files rather than looking for build output.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "object-src 'none'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
