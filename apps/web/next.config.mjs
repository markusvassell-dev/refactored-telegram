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

  experimental: {
    serverActions: {
      // Server actions default to a 1 MB body, which would reject an ordinary
      // scanned engagement letter with an opaque error. Matched to
      // DOCUMENT_MAX_UPLOAD_BYTES, which is what actually enforces the limit —
      // with a little headroom for the rest of the form.
      bodySizeLimit: '26mb',
    },
  },

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
    // React Refresh in `next dev` evaluates code strings, so development needs
    // 'unsafe-eval'. Production does not, and must not have it.
    const isDevelopment = process.env.NODE_ENV !== 'production';
    const scriptSrc = ["'self'", "'unsafe-inline'", ...(isDevelopment ? ["'unsafe-eval'"] : [])].join(' ');

    // Sign-in is a form that posts to this application and is answered with a
    // redirect to Microsoft. `form-action` is checked against where the
    // submission ends up, not only where it was aimed, so a policy of `'self'`
    // alone blocks the redirect — and the browser blocks it silently. Clicking
    // "Continue with Microsoft" simply did nothing, with the reason visible
    // only in a console nobody had open.
    //
    // Configurable because a national cloud has a different sign-in host:
    // Entra's authority is login.microsoftonline.com for the global cloud,
    // login.microsoftonline.us for US Government, and so on. Anything listed
    // here can receive a form submission from this application, so it stays a
    // short, explicit list rather than a wildcard.
    const signInHosts = (process.env.ENTRA_SIGN_IN_HOSTS ?? 'https://login.microsoftonline.com')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean);

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
              `script-src ${scriptSrc}`,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "object-src 'none'",
              // The document preview embeds a same-origin PDF.
              "frame-src 'self' blob:",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              `form-action 'self' ${signInHosts.join(' ')}`,
            ].join('; '),
          },
        ],
      },
      // Routes this application embeds in its own pages.
      //
      // `frame-src 'self'` on the page is not enough on its own: the *framed*
      // response must also permit it, and the blanket `DENY` /
      // `frame-ancestors 'none'` above refuses even a same-origin parent.
      // Narrowed to `self` here and nowhere else, so no other site can frame
      // one of these either.
      //
      // A list rather than a single entry because it was a single entry, and
      // adding a second embedded viewer without noticing this produced a
      // perfectly correct PDF that the browser replaced with "refused to
      // connect". Anything rendered in an iframe belongs here.
      //
      // Listed after the catch-all deliberately: a later rule matching the
      // same path wins for the headers it names.
      ...['/api/documents/:path*', '/api/templates/:path*'].map((source) => ({
        source,
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          {
            key: 'Content-Security-Policy',
            value: ["default-src 'none'", "frame-ancestors 'self'", "base-uri 'none'", "form-action 'none'"].join('; '),
          },
        ],
      })),
    ];
  },
};

export default nextConfig;
