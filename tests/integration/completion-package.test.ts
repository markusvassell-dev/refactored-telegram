import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import {
  CompletionDeliveryService,
  CoverLetterService,
  DocumentStore,
  JobQueue,
  NotificationService,
  WorkflowService,
  maybeStartCoverLetter,
} from '@element/services';
import { MockKarbonProvider } from '@element/integrations';
import { createLogger, PreconditionError } from '@element/shared';

/**
 * The last two steps of an engagement, neither of which existed.
 *
 * **The cover-letter phase was unreachable.** Its trigger gate requires the
 * engagement to be `READY_FOR_COVER_LETTER`, and nothing anywhere moved one
 * into that status — `COMPLETE → READY_FOR_COVER_LETTER` was a legal
 * transition with no caller. So the Generate button refused every time it was
 * pressed, always for the same reason, and everything behind it — the
 * enclosure rules, the narrative editor, the delivery gate — sat behind a door
 * nobody could open.
 *
 * **And `READY_FOR_DELIVERY` consumed nothing.** An approved cover letter
 * reached it and stopped. The final T2 return and the financial statements
 * reached Karbon by no path at all.
 *
 * Nothing here renders a document: every fixture is built from stored PDF
 * bytes, because LibreOffice cannot write its output in this container and a
 * test that needs it tells you nothing about either of these steps.
 */

const prisma = new PrismaClient();
const logger = createLogger({ level: 'error' });
const audit = createAuditLogger(prisma);
const queue = new JobQueue(prisma, logger);
const workflow = new WorkflowService(prisma, audit);
const notifications = new NotificationService({ prisma });

const store = new DocumentStore({
  prisma,
  rootDirectory: '/tmp/element-engagements-tests/completion-package',
  retentionHours: 72,
  maxBytes: 25 * 1024 * 1024,
  signingSecret: 'test-signing-secret-test-signing-secret',
});

const coverLetters = new CoverLetterService({
  prisma,
  audit,
  store,
  // Never actually used here — nothing in this file renders a document — but
  // the service requires one, and a real converter would need LibreOffice.
  pdfConverter: {
    name: 'stub',
    convert: async () => ({ pdf: Buffer.from('%PDF-1.4'), pageCount: 1, durationMs: 0 }),
  },
  workflow,
  logger,
  templateDirectory: '/tmp',
});

const delivery = new CompletionDeliveryService({
  prisma,
  audit,
  store,
  workflow,
  notifications,
  logger,
});

const autostartDeps = { prisma, queue, workflow, coverLetters };

const suffix = randomUUID().slice(0, 8);
const entityKey = `PKG-ORG-${suffix}`;
let clientId: string;
let preparerId: string;

const PDF = Buffer.from('%PDF-1.4 completion package fixture\n%%EOF\n');

async function seedEngagement(options: { compilation?: boolean; withFinals?: boolean } = {}) {
  const engagement = await prisma.engagement.create({
    data: {
      clientId,
      engagementType: 'T2',
      taxYear: 2026,
      status: 'NOT_STARTED',
      compilationSelected: options.compilation ?? true,
      assignedPreparerId: preparerId,
      isTestMode: true,
    },
  });

  const version = await prisma.documentVersion.create({
    data: {
      engagementId: engagement.id,
      documentType: 'T2_ENGAGEMENT_LETTER',
      versionNumber: 1,
      status: 'APPROVED',
      createdBy: preparerId,
    },
  });

  // The designated internal approval the trigger gate looks for.
  await prisma.approval.create({
    data: {
      engagementId: engagement.id,
      documentVersionId: version.id,
      type: 'FINAL_DOCUMENT',
      decision: 'APPROVED',
      userId: preparerId,
      actingRole: 'PARTNER_OR_FINAL_APPROVER',
    },
  });

  // Walked through the legal transitions rather than set directly: the database
  // trigger refuses anything else, which is the point of having it.
  for (const to of ['GENERATING', 'DRAFT_READY', 'REVIEW_REQUIRED', 'IN_REVIEW', 'APPROVED', 'READY_TO_SEND'] as const) {
    await workflow.transition({ engagementId: engagement.id, to, reason: 'fixture' });
  }

  // READY_TO_SEND → SIGNED is refused by a database trigger unless real
  // evidence exists. Not a nuisance: it is what stops an engagement being
  // marked signed on somebody's say-so, so the fixture satisfies it rather
  // than working around it.
  const evidence = await store.put({
    content: PDF,
    fileName: 'signed-letter.pdf',
    mimeType: 'application/pdf',
    scope: engagement.id.replace(/-/g, ''),
  });

  await prisma.externalSignature.create({
    data: {
      engagementId: engagement.id,
      documentVersionId: version.id,
      evidenceReference: evidence.reference,
      evidenceHash: evidence.hash,
      evidenceFileName: 'signed-letter.pdf',
      evidencePageCount: 1,
      method: 'ACROBAT_ESIGN',
      signedOn: new Date('2026-08-01T00:00:00Z'),
      reason: 'Fixture: signed outside the application.',
      recordedBy: preparerId,
    },
  });

  for (const to of ['SIGNED', 'COMPLETE'] as const) {
    await workflow.transition({ engagementId: engagement.id, to, reason: 'fixture' });
  }

  if (options.withFinals !== false) await addFinals(engagement.id);

  return { engagementId: engagement.id, documentVersionId: version.id };
}

/** The three documents a compilation cover letter cannot proceed without. */
async function addFinals(engagementId: string): Promise<void> {
  for (const kind of ['FINAL_T2_RETURN', 'COMPILED_FINANCIAL_STATEMENTS', 'COMPILATION_ENGAGEMENT_REPORT'] as const) {
    const stored = await store.put({
      content: PDF,
      fileName: `${kind}.pdf`,
      mimeType: 'application/pdf',
      scope: engagementId.replace(/-/g, ''),
    });

    await prisma.sourceDocument.create({
      data: {
        engagementId,
        kind,
        fileName: `${kind}.pdf`,
        fileHash: stored.hash,
        storagePath: stored.reference,
        mimeType: 'application/pdf',
        includedInPackage: true,
        isFinal: true,
        pageCount: 1,
      },
    });
  }
}

/** A package sitting exactly where delivery applies. */
async function readyPackage(engagementId: string) {
  const sources = await prisma.sourceDocument.findMany({ where: { engagementId } });

  const record = await prisma.coverLetterPackage.create({
    data: {
      engagementId,
      documentType: 'COMPILATION_COVER_LETTER',
      status: 'READY_FOR_DELIVERY',
      idempotencyKey: `pkg-${randomUUID()}`,
      sourceFingerprint: sources.map((source) => source.fileHash).join(':'),
    },
  });

  const stored = await store.put({
    content: PDF,
    fileName: 'cover-letter.pdf',
    mimeType: 'application/pdf',
    scope: engagementId.replace(/-/g, ''),
  });

  await prisma.documentVersion.create({
    data: {
      engagementId,
      coverLetterPackageId: record.id,
      documentType: 'COMPILATION_COVER_LETTER',
      versionNumber: 1,
      status: 'APPROVED',
      generatedPdfReference: stored.reference,
      createdBy: preparerId,
    },
  });

  for (const to of [
    'READY_FOR_COVER_LETTER',
    'COVER_LETTER_GENERATING',
    'COVER_LETTER_REVIEW_REQUIRED',
    'COVER_LETTER_IN_REVIEW',
    'COVER_LETTER_APPROVED',
    'READY_FOR_DELIVERY',
  ] as const) {
    await workflow.transition({ engagementId, to, reason: 'fixture' });
  }

  return record.id;
}

/** Connected, so `isMock` is false and the delivery is not skipped. */
function connectedKarbon(): MockKarbonProvider {
  const karbon = new MockKarbonProvider();
  Object.defineProperty(karbon, 'isMock', { value: false });
  return karbon;
}

beforeAll(async () => {
  await prisma.$connect();
  const user = await prisma.user.upsert({
    where: { email: `pkg-preparer-${suffix}@test.example` },
    create: { email: `pkg-preparer-${suffix}@test.example`, displayName: 'Pkg Preparer' },
    update: {},
  });
  preparerId = user.id;
});

beforeEach(async () => {
  await prisma.engagement.deleteMany({ where: { client: { karbonEntityKey: entityKey } } });
  await prisma.client.deleteMany({ where: { karbonEntityKey: entityKey } });

  const client = await prisma.client.create({
    data: {
      karbonEntityKey: entityKey,
      karbonEntityType: 'Organization',
      legalName: `Completion Package Co ${suffix}`,
      isTestFixture: true,
    },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { client: { karbonEntityKey: entityKey } } });
  await prisma.client.deleteMany({ where: { karbonEntityKey: entityKey } });
  await prisma.user.deleteMany({ where: { email: `pkg-preparer-${suffix}@test.example` } });
  await prisma.$disconnect();
});

describe('starting the cover letter without being asked', () => {
  it('starts it once the engagement letter is complete and the finals are in', async () => {
    // The assertion whose absence made the whole phase unreachable.
    const { engagementId } = await seedEngagement();

    const outcome = await maybeStartCoverLetter(autostartDeps, engagementId);

    expect(outcome.started).toBe(true);
    expect(await workflow.currentStatus(engagementId)).toBe('READY_FOR_COVER_LETTER');

    const job = await prisma.backgroundJob.findFirstOrThrow({
      where: { engagementId, jobType: 'GENERATE_COVER_LETTER' },
    });
    // Started by nobody, and the audit trail has to be able to say so.
    expect(job.payload).toMatchObject({ actorId: 'system' });
  });

  it('does nothing, and says why, while the final documents are missing', async () => {
    const { engagementId } = await seedEngagement({ withFinals: false });

    const outcome = await maybeStartCoverLetter(autostartDeps, engagementId);

    expect(outcome.started).toBe(false);
    expect(outcome.reason).toMatch(/final source documents are missing/i);
    // The status is untouched: nothing half-moved.
    expect(await workflow.currentStatus(engagementId)).toBe('COMPLETE');
    expect(await prisma.backgroundJob.count({ where: { engagementId } })).toBe(0);
  });

  it('starts when the last final document arrives, whichever order things happened in', async () => {
    // The engagement letter finished first here. The upload is what completes
    // the picture, and it is a different caller in a different process from
    // the one that completed the letter.
    const { engagementId } = await seedEngagement({ withFinals: false });
    expect((await maybeStartCoverLetter(autostartDeps, engagementId)).started).toBe(false);

    await addFinals(engagementId);

    expect((await maybeStartCoverLetter(autostartDeps, engagementId)).started).toBe(true);
  });

  it('converges rather than queueing a second letter, however often it runs', async () => {
    // It is called from five places and at least two of them can fire close
    // together, so this is the ordinary case rather than a corner.
    const { engagementId } = await seedEngagement();

    await maybeStartCoverLetter(autostartDeps, engagementId);
    const second = await maybeStartCoverLetter(autostartDeps, engagementId);

    expect(second.started).toBe(false);
    expect(await prisma.backgroundJob.count({ where: { engagementId, jobType: 'GENERATE_COVER_LETTER' } })).toBe(1);
  });

  it('starts a fresh one when a source document is replaced', async () => {
    // A cover letter is a statement about a particular set of final documents.
    // Swap one and the old letter is wrong, so this must not deduplicate — the
    // key is fingerprinted on the documents for exactly this reason.
    const { engagementId } = await seedEngagement();
    await maybeStartCoverLetter(autostartDeps, engagementId);

    const replaced = await prisma.sourceDocument.findFirstOrThrow({ where: { engagementId } });
    await prisma.sourceDocument.update({
      where: { id: replaced.id },
      data: { fileHash: `${replaced.fileHash}-revised` },
    });

    expect((await maybeStartCoverLetter(autostartDeps, engagementId)).started).toBe(true);
    expect(await prisma.backgroundJob.count({ where: { engagementId, jobType: 'GENERATE_COVER_LETTER' } })).toBe(2);
  });

  it('refuses an engagement that has not finished its letter', async () => {
    const engagement = await prisma.engagement.create({
      data: { clientId, engagementType: 'T2', taxYear: 2026, status: 'NOT_STARTED', isTestMode: true },
    });

    const outcome = await maybeStartCoverLetter(autostartDeps, engagement.id);

    expect(outcome.started).toBe(false);
    expect(outcome.reason).toMatch(/NOT_STARTED/);
  });
});

describe('delivering the package into the client documents', () => {
  it('files the cover letter and every enclosure against the client, not a work item', async () => {
    // The destination is the whole point. A work item is one year's job; this
    // is the client's permanent file, and it is where somebody looks a year
    // later to find out what was sent.
    const { engagementId } = await seedEngagement();
    const packageId = await readyPackage(engagementId);
    const karbon = connectedKarbon();

    const result = await delivery.deliver({
      coverLetterPackageId: packageId,
      karbon,
      correlationId: 'test-correlation',
      testMode: false,
    });

    expect(result.delivered).toBe(true);

    const uploads = karbon.calls.filter((call) => call.operation === 'uploadDocument');
    // The cover letter plus three finals.
    expect(uploads).toHaveLength(4);
    for (const upload of uploads) {
      const payload = upload.payload as { targetField: string; targetKey: string };
      expect(payload.targetField).toBe('organization_keys');
      expect(payload.targetKey).toBe(entityKey);
    }

    expect(await workflow.currentStatus(engagementId)).toBe('DELIVERED');
    const record = await prisma.coverLetterPackage.findUniqueOrThrow({ where: { id: packageId } });
    expect(record.status).toBe('DELIVERED');
    expect(record.deliveredAt).not.toBeNull();
    // What went where, recorded rather than assumed.
    expect(Object.keys(record.karbonFileIds as Record<string, string>)).toContain('COVER_LETTER');
  });

  it('does not deliver a second copy when it runs again', async () => {
    // Delivery writes into a client's permanent records and cannot be taken
    // back, so at-least-once delivery of the job must be effectively-once here.
    const { engagementId } = await seedEngagement();
    const packageId = await readyPackage(engagementId);

    await delivery.deliver({ coverLetterPackageId: packageId, karbon: connectedKarbon(), correlationId: 'c1', testMode: false });

    const second = connectedKarbon();
    const repeat = await delivery.deliver({
      coverLetterPackageId: packageId,
      karbon: second,
      correlationId: 'c2',
      testMode: false,
    });

    expect(repeat.delivered).toBe(false);
    expect(repeat.skippedReason).toMatch(/already delivered/i);
    expect(second.calls.filter((call) => call.operation === 'uploadDocument')).toHaveLength(0);
  });

  it('sends nothing in Test Mode, and says so rather than staying silent', async () => {
    const { engagementId } = await seedEngagement();
    const packageId = await readyPackage(engagementId);
    const karbon = connectedKarbon();

    const result = await delivery.deliver({
      coverLetterPackageId: packageId,
      karbon,
      correlationId: 'test-correlation',
      testMode: true,
    });

    expect(result.delivered).toBe(false);
    expect(result.skippedReason).toMatch(/test mode/i);
    expect(karbon.calls.filter((call) => call.operation === 'uploadDocument')).toHaveLength(0);
    // Not marked delivered, so it is still there to deliver for real later.
    expect(await workflow.currentStatus(engagementId)).toBe('READY_FOR_DELIVERY');
  });

  it('refuses rather than filing a package with a document missing from it', async () => {
    // A client file holding a cover letter that refers to enclosed financial
    // statements which are not there is worse than one holding nothing,
    // because the first reads as complete. The working copy of a source
    // document is purged after its retention window, so this is a real case.
    const { engagementId } = await seedEngagement();
    const packageId = await readyPackage(engagementId);

    const purged = await prisma.sourceDocument.findFirstOrThrow({ where: { engagementId } });
    await prisma.sourceDocument.update({ where: { id: purged.id }, data: { storagePath: null } });

    await expect(
      delivery.deliver({
        coverLetterPackageId: packageId,
        karbon: connectedKarbon(),
        correlationId: 'c1',
        testMode: false,
      }),
    ).rejects.toThrow(/no longer held here/i);
  });

  it('refuses, naming the fix, when the client is not linked to Karbon', async () => {
    const { engagementId } = await seedEngagement();
    const packageId = await readyPackage(engagementId);
    await prisma.client.update({ where: { id: clientId }, data: { karbonEntityType: null } });

    await expect(
      delivery.deliver({
        coverLetterPackageId: packageId,
        karbon: connectedKarbon(),
        correlationId: 'c1',
        testMode: false,
      }),
    ).rejects.toThrow(PreconditionError);
  });
});
