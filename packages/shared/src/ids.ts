import { randomUUID } from 'node:crypto';

/** Correlation id threaded through every job, integration call and audit event. */
export function newCorrelationId(): string {
  return `cor_${randomUUID()}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export { randomUUID };
