import { PrismaClient } from '../generated/client/index.js';

/**
 * Prisma client singleton.
 *
 * Next.js dev-mode hot reloading would otherwise create a new pool on every
 * edit and exhaust Postgres connections.
 */

const globalForPrisma = globalThis as unknown as { elementPrisma?: PrismaClient };

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  return new PrismaClient({
    ...(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {}),
    log: process.env.LOG_LEVEL === 'debug' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma: PrismaClient = globalForPrisma.elementPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.elementPrisma = prisma;
}

// Re-exports the generated client, including PrismaClient as a value.
export * from '../generated/client/index.js';
