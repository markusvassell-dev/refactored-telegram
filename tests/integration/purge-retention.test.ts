import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { createLogger } from '@element/shared';
import { buildHandlers } from '../../apps/worker/src/handlers.js';
import type { WorkerContext } from '../../apps/worker/src/context.js';

/**
 * The retention sweep, and the two ways it never finished.
 *
 * `PURGE_TEMPORARY_FILES` deletes working copies once their retention has
 * passed. Both of its passes selected rows by time alone, and neither recorded
 * that a row had been dealt with — so every run re-selected everything that had
 * ever expired.
 *
 * For source documents that was pure waste: the file delete was skipped the
 * second time round, but the UPDATE was not, so each nightly pass rewrote every
 * historical row.
 *
 * For superseded document versions it was worse than waste. The references were
 * never cleared, so the same deletes were re-issued for ever, `purged` counted
 * them again on every pass, and — the part that reaches a person — the row went
 * on claiming a working copy existed. `linksFor` offers a download whenever the
 * reference is non-null, so Version History showed a link for bytes that had
 * been deleted.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error' });

const clientIds: string[] = [];
const deleted: string[] = [];

/** Only the parts of the worker context this one handler touches. */
const context = {
  prisma,
  audit,
  env: { DOCUMENT_RETENTION_HOURS: 24, JOB_RETENTION_DAYS: 30 },
  store: {
    async delete(reference: string) {
      deleted.push(reference);
    },
    async purgeExpired() {
      return 0;
    },
  },
  queue: {
    async purgeSucceededJobs() {
      return 0;
    },
  },
} as unknown as WorkerContext;

const handlers = buildHandlers(context);

const job = {
  job: { id: randomUUID(), correlationId: randomUUID(), payload: {} },
  logger,
} as unknown as Parameters<(typeof handlers)['PURGE_TEMPORARY_FILES']>[0];

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.$disconnect();
});

let nextYear = 2700;

async function anEngagement(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const client = await prisma.client.create({
    data: { legalName: `Purge Co ${suffix}`, isTestFixture: true },
  });
  clientIds.push(client.id);

  nextYear += 1;
  const engagement = await prisma.engagement.create({
    data: { clientId: client.id, engagementType: 'T2', taxYear: nextYear, isTestMode: true },
  });
  return engagement.id;
}

describe('the source-document pass', () => {
  it('does not re-select a document whose working copy is already gone', async () => {
    const engagementId = await anEngagement();
    const suffix = randomUUID().slice(0, 8);

    const document = await prisma.sourceDocument.create({
      data: {
        engagementId,
        fileName: `prior-year-${suffix}.pdf`,
        fileHash: `hash-${suffix}`,
        storagePath: `documents/${suffix}.pdf`,
        // Expired an hour ago. `purgeAfter` is stamped once and never cleared,
        // so the time filter alone matches this row on every future run.
        purgeAfter: new Date(Date.now() - 3_600_000),
      },
    });

    await handlers.PURGE_TEMPORARY_FILES(job);

    const afterFirst = await prisma.sourceDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(afterFirst.storagePath).toBeNull();
    const touchedFirst = afterFirst.updatedAt;

    // The second pass is the assertion. Nothing is left to purge, so nothing
    // should be written — and `updatedAt` is what proves a row was rewritten.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await handlers.PURGE_TEMPORARY_FILES(job);

    const afterSecond = await prisma.sourceDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(afterSecond.updatedAt.getTime()).toBe(touchedFirst.getTime());
  });
});

describe('the superseded-version pass', () => {
  it('clears the references, so nothing offers a download for bytes that are gone', async () => {
    const engagementId = await anEngagement();
    const suffix = randomUUID().slice(0, 8);

    const version = await prisma.documentVersion.create({
      data: {
        engagementId,
        documentType: 'T2_ENGAGEMENT_LETTER',
        versionNumber: 1,
        status: 'SUPERSEDED',
        supersededAt: new Date(Date.now() - 90 * 3_600_000),
        generatedDocxReference: `documents/${suffix}.docx`,
        generatedPdfReference: `documents/${suffix}.pdf`,
      },
    });

    await handlers.PURGE_TEMPORARY_FILES(job);

    const stored = await prisma.documentVersion.findUniqueOrThrow({ where: { id: version.id } });

    // `linksFor` offers a download whenever a reference is non-null. Leaving
    // them set is what made Version History show a link that found nothing.
    expect(stored.generatedDocxReference).toBeNull();
    expect(stored.generatedPdfReference).toBeNull();
  });

  it('does not delete the same files again on the next run', async () => {
    const engagementId = await anEngagement();
    const suffix = randomUUID().slice(0, 8);

    await prisma.documentVersion.create({
      data: {
        engagementId,
        documentType: 'T2_ENGAGEMENT_LETTER',
        versionNumber: 1,
        status: 'SUPERSEDED',
        supersededAt: new Date(Date.now() - 90 * 3_600_000),
        generatedPdfReference: `documents/${suffix}.pdf`,
      },
    });

    deleted.length = 0;
    await handlers.PURGE_TEMPORARY_FILES(job);
    const mine = () => deleted.filter((reference) => reference.includes(suffix));
    expect(mine()).toHaveLength(1);

    // Re-issuing the delete is not harmless: `purged` counted it again, so the
    // number this job reported grew on every pass while nothing was purged.
    await handlers.PURGE_TEMPORARY_FILES(job);
    expect(mine()).toHaveLength(1);
  });
});
