import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { EngagementReadinessService, WorkflowService } from '@element/services';
import { createLogger } from '@element/shared';
import { buildHandlers } from '../../apps/worker/src/handlers.js';
import type { WorkerContext } from '../../apps/worker/src/context.js';

/**
 * The last thing checked before a person is asked to read a draft.
 *
 * `UPLOAD_TO_KARBON` used to move an engagement to `REVIEW_REQUIRED`
 * unconditionally: the draft went in front of a reviewer whatever the
 * application already knew about it. That is what these pin.
 *
 * Note what a failing check does *not* do. It does not hold the engagement at
 * `DRAFT_READY`, because that looks identical to an upload that never
 * finished; and it cannot park it in `SOURCE_DOCUMENT_REVIEW_REQUIRED`, which
 * the state machine does not allow from `DRAFT_READY` and which would throw.
 * It goes to `NEEDS_ATTENTION` carrying the reasons in `blockedReason` — the
 * screen the firm already watches, and the one state that recovers straight to
 * `REVIEW_REQUIRED` once the reasons are dealt with.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error' });
const workflow = new WorkflowService(prisma, audit);
const engagementReadiness = new EngagementReadinessService({ prisma, audit });

const clientIds: string[] = [];
let nextTaxYear = 2600;

/**
 * Only the parts of the worker context this one handler touches. Building the
 * real context would need LibreOffice, a document store and a Karbon
 * connection; none of them decide anything being tested here.
 */
const context = {
  prisma,
  workflow,
  engagementReadiness,
  notifications: {
    async publishDraft() {
      return { uploaded: [], notes: ['Karbon is a mock in this test.'] };
    },
  },
  async providers() {
    return { karbon: {} };
  },
  async testMode() {
    return { testMode: true, productionSendingEnabled: false };
  },
} as unknown as WorkerContext;

const handlers = buildHandlers(context);

function job(engagementId: string, documentVersionId: string) {
  return {
    job: {
      id: randomUUID(),
      correlationId: randomUUID(),
      payload: { engagementId, documentVersionId },
    },
    logger,
  } as unknown as Parameters<(typeof handlers)['UPLOAD_TO_KARBON']>[0];
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.engagement.deleteMany({
    where: { clientId: { in: clientIds } },
  });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.$disconnect();
});

/**
 * A draft sitting at DRAFT_READY, which is where the gate is consulted.
 *
 * T1 joint by default because its master template is the approved, active one.
 * That is not incidental: an engagement type with no approved template fails
 * the master-template check outright, which is correct — there is nothing to
 * render a letter from — and is asserted on its own below.
 */
async function draftReady(
  engagementType: 'T1_JOINT' | 'T1_SINGLE' = 'T1_JOINT',
): Promise<{ engagementId: string; documentVersionId: string }> {
  const suffix = randomUUID().slice(0, 8);
  const client = await prisma.client.create({
    data: { legalName: `Review Gate Co ${suffix}`, isTestFixture: true },
  });
  clientIds.push(client.id);

  nextTaxYear += 1;
  const engagement = await prisma.engagement.create({
    data: {
      clientId: client.id,
      engagementType,
      taxYear: nextTaxYear,
      status: 'DRAFT_READY',
      isTestMode: true,
    },
  });

  const version = await prisma.documentVersion.create({
    data: {
      engagementId: engagement.id,
      documentType: engagementType === 'T1_JOINT' ? 'T1_JOINT_ENGAGEMENT_LETTER' : 'T1_SINGLE_ENGAGEMENT_LETTER',
      versionNumber: 1,
      validationReport: { errorCount: 0, errors: [] },
    },
  });

  return { engagementId: engagement.id, documentVersionId: version.id };
}

describe('the review gate', () => {
  it('does not put a draft in front of a reviewer when a readiness check fails', async () => {
    const { engagementId, documentVersionId } = await draftReady();

    // A value that will be printed and signed, present only because last
    // year's letter said so, with no current source and nobody having read it.
    await prisma.extractedField.create({
      data: {
        engagementId,
        token: 'CLIENT_ADDRESS',
        value: '12 Old Street, Toronto',
        source: 'PRIOR_YEAR_DOCUMENT',
        extractionMethod: 'DETERMINISTIC_PATTERN',
      },
    });

    const result = (await handlers.UPLOAD_TO_KARBON(job(engagementId, documentVersionId))) as {
      readyForReview: boolean;
    };

    expect(result.readyForReview).toBe(false);

    const after = await prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId },
    });
    expect(after.status).toBe('NEEDS_ATTENTION');

    // Readable on the engagement itself, not only in a job result nobody
    // opens. This is what the dashboard and the Needs Attention screen show.
    expect(after.blockedReason).toMatch(/Previous-Year Comparison/);
    expect(after.blockedReason).toMatch(/only because last year/i);
  });

  it('requests review once every check passes', async () => {
    const { engagementId, documentVersionId } = await draftReady();

    const result = (await handlers.UPLOAD_TO_KARBON(job(engagementId, documentVersionId))) as {
      readyForReview: boolean;
    };

    expect(result.readyForReview).toBe(true);

    const after = await prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId },
    });
    expect(after.status).toBe('REVIEW_REQUIRED');
  });

  it('refuses when the engagement type has no approved master template', async () => {
    // Nothing to render a letter from is not a draft worth reviewing, and the
    // Master-Template tab has always displayed a template name without ever
    // checking there was an approved one behind it.
    const { engagementId, documentVersionId } = await draftReady('T1_SINGLE');

    await handlers.UPLOAD_TO_KARBON(job(engagementId, documentVersionId));

    const after = await prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId },
    });
    expect(after.status).toBe('NEEDS_ATTENTION');
    expect(after.blockedReason).toMatch(/No approved template version is active/);
  });

  it('leaves an engagement that is not at DRAFT_READY exactly where it is', async () => {
    const { engagementId, documentVersionId } = await draftReady();

    // Through the state machine rather than around it: the database refuses an
    // illegal transition, so a test that wrote the status directly would be
    // testing a state the application can never be in.
    await workflow.transition({ engagementId, to: 'REVIEW_REQUIRED' });
    await workflow.transition({ engagementId, to: 'IN_REVIEW' });

    await handlers.UPLOAD_TO_KARBON(job(engagementId, documentVersionId));

    const after = await prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId },
    });
    expect(after.status).toBe('IN_REVIEW');
  });
});
