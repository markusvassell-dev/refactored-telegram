import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { JobQueue, WorkflowService, enqueuePreparation } from '@element/services';
import { createLogger } from '@element/shared';
import { buildHandlers } from '../../apps/worker/src/handlers.js';
import type { WorkerContext } from '../../apps/worker/src/context.js';

/**
 * An engagement that says it is doing something, with nothing behind it.
 *
 * `EXTRACTING_DATA` was set in two places, each of which then enqueued the
 * extraction job and never read the answer. De-duplication matches by key across
 * every state including `SUCCEEDED`, so choosing the same document a second time
 * flipped the status and created no job. Nothing failed, so the exhausted-retry
 * hook never fired, and no sweeper over engagement status existed: the badge
 * read "extracting data" until job retention eventually freed the key.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error' });
const queue = new JobQueue(prisma, logger);
const workflow = new WorkflowService(prisma, audit);

const context = { prisma, audit, queue, workflow, logger } as unknown as WorkerContext;
const handlers = buildHandlers(context);

function sweepJob() {
  return {
    job: { id: randomUUID(), correlationId: randomUUID(), payload: {} },
    logger,
  } as unknown as Parameters<(typeof handlers)['SWEEP_STUCK_ENGAGEMENTS']>[0];
}

let clientId: string;
let nextTaxYear = 3100;

beforeAll(async () => {
  await prisma.$connect();
  const client = await prisma.client.create({
    data: { legalName: `Stalled Co ${randomUUID().slice(0, 8)}`, isTestFixture: true },
  });
  clientId = client.id;
});

afterAll(async () => {
  const engagements = await prisma.engagement.findMany({ where: { clientId }, select: { id: true } });
  await prisma.backgroundJob.deleteMany({ where: { engagementId: { in: engagements.map((e) => e.id) } } });
  await prisma.engagement.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.$disconnect();
});

async function newEngagement(status: string) {
  nextTaxYear += 1;
  return prisma.engagement.create({
    data: {
      clientId,
      engagementType: 'T2',
      taxYear: nextTaxYear,
      yearEnd: new Date(Date.UTC(nextTaxYear, 2, 31)),
      status: status as never,
      isTestMode: true,
    },
  });
}

/** Backdates the row so the sweeper's staleness window has passed. */
async function ageBy(engagementId: string, minutes: number) {
  // Raw, because `updatedAt` is `@updatedAt`: a Prisma update would stamp it
  // with now and undo exactly what this is for.
  const when = new Date(Date.now() - minutes * 60_000);
  await prisma.$executeRaw`UPDATE engagement SET "updatedAt" = ${when} WHERE id = ${engagementId}`;
}

describe('enqueuing work that is safe to repeat', () => {
  it('runs again when the key is held by a job that already finished', async () => {
    const engagement = await newEngagement('NOT_STARTED');
    const key = `extract_${randomUUID()}`;

    const first = await queue.enqueueRerunnable({
      jobType: 'EXTRACT_DOCUMENT_TEXT',
      idempotencyKey: key,
      payload: { engagementId: engagement.id },
      engagementId: engagement.id,
    });
    expect(first.willRun).toBe(true);

    await prisma.backgroundJob.update({ where: { id: first.jobId }, data: { status: 'SUCCEEDED' } });

    // This is the case that stranded the badge: plain `enqueue` answers
    // "deduplicated" here and creates nothing.
    const second = await queue.enqueueRerunnable({
      jobType: 'EXTRACT_DOCUMENT_TEXT',
      idempotencyKey: key,
      payload: { engagementId: engagement.id },
      engagementId: engagement.id,
    });

    expect(second.willRun).toBe(true);
    expect(second.jobId).not.toBe(first.jobId);
  });

  it('does not queue the same work twice while it is still pending', async () => {
    const engagement = await newEngagement('NOT_STARTED');
    const key = `extract_${randomUUID()}`;

    const first = await queue.enqueueRerunnable({
      jobType: 'EXTRACT_DOCUMENT_TEXT',
      idempotencyKey: key,
      payload: { engagementId: engagement.id },
      engagementId: engagement.id,
    });

    const second = await queue.enqueueRerunnable({
      jobType: 'EXTRACT_DOCUMENT_TEXT',
      idempotencyKey: key,
      payload: { engagementId: engagement.id },
      engagementId: engagement.id,
    });

    // Already queued is not a stall, and doing it twice is the duplicate work
    // de-duplication exists to prevent.
    expect(second.jobId).toBe(first.jobId);
    expect(second.deduplicated).toBe(true);
    expect(second.willRun).toBe(true);
  });

  it('reports the state of the job already holding the key', async () => {
    const engagement = await newEngagement('NOT_STARTED');
    const key = `extract_${randomUUID()}`;

    const first = await queue.enqueue({
      jobType: 'EXTRACT_DOCUMENT_TEXT',
      idempotencyKey: key,
      payload: { engagementId: engagement.id },
      engagementId: engagement.id,
    });
    await prisma.backgroundJob.update({ where: { id: first.jobId }, data: { status: 'DEAD_LETTER' } });

    const again = await queue.enqueue({
      jobType: 'EXTRACT_DOCUMENT_TEXT',
      idempotencyKey: key,
      payload: { engagementId: engagement.id },
      engagementId: engagement.id,
    });

    expect(again.deduplicated).toBe(true);
    expect(again.existingStatus).toBe('DEAD_LETTER');
  });
});

describe('sweeping engagements nothing is working on', () => {
  it('moves a parked engagement with no job behind it back to a person', async () => {
    const engagement = await newEngagement('EXTRACTING_DATA');
    await ageBy(engagement.id, 45);

    await handlers.SWEEP_STUCK_ENGAGEMENTS(sweepJob());

    const after = await prisma.engagement.findUniqueOrThrow({ where: { id: engagement.id } });
    expect(after.status).toBe('SOURCE_DOCUMENT_REVIEW_REQUIRED');
  });

  it('reports what failed when a job did fail and the engagement never heard', async () => {
    const engagement = await newEngagement('EXTRACTING_DATA');

    await prisma.backgroundJob.create({
      data: {
        jobType: 'EXTRACT_DOCUMENT_TEXT',
        idempotencyKey: `dead_${randomUUID()}`,
        payload: { engagementId: engagement.id },
        correlationId: randomUUID(),
        engagementId: engagement.id,
        status: 'DEAD_LETTER',
        userMessage: 'The document has no readable text layer.',
      },
    });

    await ageBy(engagement.id, 45);
    await handlers.SWEEP_STUCK_ENGAGEMENTS(sweepJob());

    const after = await prisma.engagement.findUniqueOrThrow({ where: { id: engagement.id } });
    expect(after.status).toBe('NEEDS_ATTENTION');
    expect(after.blockedReason).toContain('no readable text layer');
  });

  it('leaves an engagement alone while a job is still queued for it', async () => {
    const engagement = await newEngagement('EXTRACTING_DATA');

    await prisma.backgroundJob.create({
      data: {
        jobType: 'EXTRACT_DOCUMENT_TEXT',
        idempotencyKey: `pending_${randomUUID()}`,
        payload: { engagementId: engagement.id },
        correlationId: randomUUID(),
        engagementId: engagement.id,
        status: 'PENDING',
      },
    });

    await ageBy(engagement.id, 45);
    await handlers.SWEEP_STUCK_ENGAGEMENTS(sweepJob());

    // Slow is not stalled.
    const after = await prisma.engagement.findUniqueOrThrow({ where: { id: engagement.id } });
    expect(after.status).toBe('EXTRACTING_DATA');
  });

  it('leaves a recently updated engagement alone', async () => {
    const engagement = await newEngagement('EXTRACTING_DATA');

    await handlers.SWEEP_STUCK_ENGAGEMENTS(sweepJob());

    const after = await prisma.engagement.findUniqueOrThrow({ where: { id: engagement.id } });
    expect(after.status).toBe('EXTRACTING_DATA');
  });

  it('does not touch an engagement that has moved on', async () => {
    const engagement = await newEngagement('DRAFT_READY');
    await ageBy(engagement.id, 240);

    await handlers.SWEEP_STUCK_ENGAGEMENTS(sweepJob());

    const after = await prisma.engagement.findUniqueOrThrow({ where: { id: engagement.id } });
    expect(after.status).toBe('DRAFT_READY');
  });
});

describe('preparing without a document', () => {
  it('queues preparation for a brand-new engagement', async () => {
    const engagement = await newEngagement('NOT_STARTED');

    const outcome = await enqueuePreparation({ prisma, queue }, engagement.id, randomUUID());

    expect(outcome.enqueued).toBe(true);

    const queued = await prisma.backgroundJob.findFirst({
      where: { engagementId: engagement.id, jobType: 'PREPARE_ENGAGEMENT' },
    });
    expect(queued).not.toBeNull();
  });

  it('refuses once the letter is with a person, rather than repricing under them', async () => {
    const engagement = await newEngagement('REVIEW_REQUIRED');

    const outcome = await enqueuePreparation({ prisma, queue }, engagement.id, randomUUID());

    expect(outcome.enqueued).toBe(false);
    expect(outcome.reason).toContain('review required');
  });
});
