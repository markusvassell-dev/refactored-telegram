import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Unit tests run everywhere with no external dependencies.
 *
 * Integration tests need a real Postgres and a real LibreOffice, because the
 * point of them is to exercise the database triggers and the actual document
 * conversion rather than a simulation of either.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    // Workspace packages import siblings with a .js specifier, as TypeScript
    // emits. Map those back to the .ts sources. Vite supports this; the cast is
    // only because Vitest re-exports a narrower resolve type.
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  } as never,
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Integration tests share one database, so files run one at a time.
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'integration', include: ['tests/integration/**/*.test.ts'] },
      },
    ],
  },
});
