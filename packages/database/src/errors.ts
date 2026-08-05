/**
 * Recognising a Prisma error without `instanceof`.
 *
 * Next.js bundles server code in layers, and the generated Prisma runtime can
 * end up loaded more than once in one process. `instanceof
 * PrismaClientKnownRequestError` then returns false for a genuine Prisma error
 * raised through a different copy of the module — which turns a handled unique
 * constraint into an unhandled "something went wrong".
 *
 * The error code is part of Prisma's documented contract, so matching on its
 * shape is both more robust and no less precise.
 */

interface KnownRequestErrorShape {
  name: string;
  code: string;
  meta?: Record<string, unknown>;
}

function asKnownRequestError(error: unknown): KnownRequestErrorShape | null {
  if (typeof error !== 'object' || error === null) return null;

  const candidate = error as Partial<KnownRequestErrorShape>;
  if (typeof candidate.code !== 'string' || typeof candidate.name !== 'string') return null;
  if (!candidate.name.startsWith('PrismaClient')) return null;

  return candidate as KnownRequestErrorShape;
}

/** Prisma's error code (`P2002`, `P2025`, …), or null for anything else. */
export function prismaErrorCode(error: unknown): string | null {
  return asKnownRequestError(error)?.code ?? null;
}

/** A unique constraint was violated: the row already exists. */
export function isUniqueConstraintError(error: unknown): boolean {
  return prismaErrorCode(error) === 'P2002';
}

/** The record a query required does not exist. */
export function isRecordNotFoundError(error: unknown): boolean {
  return prismaErrorCode(error) === 'P2025';
}
