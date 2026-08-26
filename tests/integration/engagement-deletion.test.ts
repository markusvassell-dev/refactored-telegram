import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { DocumentStore, EngagementService } from '@element/services';
import { PermissionError, PreconditionError, ValidationError, createLogger, type Principal } from '@element/shared';

/**
 * Deleting an engagement, and what has to survive it.
 *
 * Nothing in the schema stops a delete: nineteen foreign keys cascade, so one
 * statement removes the participants, documents, fees, dates, approvals and the
 * whole workflow history. That is what makes the two assertions here the
 * important ones — that the audit trail is left able to say what was removed,
 * and that the one class of engagement nobody may remove is refused.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error' });
const store = new DocumentStore({
  prisma,
  rootDirectory: '/tmp/element-engagements-tests/storage',
  retentionHours: 72,
  maxBytes: 25 * 1024 * 1024,
  signingSecret: 'test-signing-secret-test-signing-secret',
});
const engagements = new EngagementService({ prisma, audit, store, logger });

const clientIds: string[] = [];
let administrator: Principal;
let partner: Principal;
let nextTaxYear = 2300;

beforeAll(async () => {
  await prisma.$connect();

  const admin = await prisma.user.upsert({
    where: { email: 'deletion-admin@example.test' },
    create: { email: 'deletion-admin@example.test', displayName: 'Deletion Admin' },
    update: {},
  });
  administrator = { id: admin.id, email: admin.email, displayName: admin.displayName, roles: ['ADMINISTRATOR'] };

  const approver = await prisma.user.upsert({
    where: { email: 'deletion-partner@example.test' },
    create: { email: 'deletion-partner@example.test', displayName: 'Deletion Partner' },
    update: {},
  });
  partner = {
    id: approver.id,
    email: approver.email,
    displayName: approver.displayName,
    roles: ['PARTNER_OR_FINAL_APPROVER'],
  };
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.$disconnect();
});

async function makeEngagement(): Promise<{ engagementId: string; clientId: string; legalName: string }> {
  const legalName = `Deletion Test Co ${randomUUID().slice(0, 8)}`;
  const client = await prisma.client.create({ data: { legalName, isTestFixture: true } });
  clientIds.push(client.id);

  nextTaxYear += 1;
  const engagement = await prisma.engagement.create({
    data: {
      clientId: client.id,
      engagementType: 'T2',
      taxYear: nextTaxYear,
      yearEnd: new Date(Date.UTC(nextTaxYear, 2, 31)),
      status: 'NOT_STARTED',
      compilationSelected: false,
      isTestMode: true,
    },
  });

  await prisma.engagementParticipant.create({
    data: {
      engagementId: engagement.id,
      role: 'AUTHORIZED_SIGNING_OFFICER',
      fullLegalName: 'Sample Signing Officer',
      email: 'officer@example.test',
      signingOrder: 2,
      isSigner: true,
    },
  });

  return { engagementId: engagement.id, clientId: client.id, legalName };
}

async function approvedVersion(engagementId: string): Promise<string> {
  const version = await prisma.documentVersion.create({
    data: { engagementId, documentType: 'T2_ENGAGEMENT_LETTER', versionNumber: 1, status: 'APPROVED' },
  });
  return version.id;
}

const REASON = 'Created against the wrong client';

describe('deleting an engagement', () => {
  it('removes the engagement and its children, and leaves an audit entry that says what it was', async () => {
    const { engagementId, legalName } = await makeEngagement();

    // Written by the status trigger's companion table, and the thing that
    // proves the cascade actually ran: workflow_event cascades, audit_event
    // deliberately does not.
    await prisma.workflowEvent.create({
      data: { engagementId, fromStatus: 'NOT_STARTED', toStatus: 'NOT_STARTED', reason: 'fixture' },
    });

    await engagements.delete({ engagementId, reason: REASON, actor: administrator });

    expect(await prisma.engagement.findUnique({ where: { id: engagementId } })).toBeNull();
    expect(await prisma.engagementParticipant.count({ where: { engagementId } })).toBe(0);
    expect(await prisma.workflowEvent.count({ where: { engagementId } })).toBe(0);

    const entry = await prisma.auditEvent.findFirst({
      where: { engagementId, eventType: 'ENGAGEMENT_DELETED' },
    });

    expect(entry).not.toBeNull();
    expect(entry?.reason).toBe(REASON);
    expect(entry?.userId).toBe(administrator.id);

    // The whole point of the feature: the snapshot has to be readable, and to
    // name the engagement well enough that somebody can tell what was lost.
    const snapshot = entry?.beforeValue as Record<string, unknown>;
    expect(snapshot.clientLegalName).toBe(legalName);
    expect(snapshot.engagementType).toBe('T2');
    expect(snapshot.status).toBe('NOT_STARTED');
    expect(Array.isArray(snapshot.participants)).toBe(true);
    expect((snapshot.participants as unknown[]).length).toBe(1);
  });

  it('masks the participant email in the snapshot rather than storing it whole', async () => {
    // Redaction is applied on write. Every reviewer can read the audit log,
    // which is a wider audience than the engagement had, so a masked value here
    // is the intended outcome and not a defect.
    const { engagementId } = await makeEngagement();

    await engagements.delete({ engagementId, reason: REASON, actor: administrator });

    const entry = await prisma.auditEvent.findFirstOrThrow({
      where: { engagementId, eventType: 'ENGAGEMENT_DELETED' },
    });
    const participants = (entry.beforeValue as { participants: { email: string }[] }).participants;

    expect(participants[0]?.email).not.toBe('officer@example.test');
    expect(participants[0]?.email).toContain('@example.test');
  });

  it('refuses when a signature has been recorded against it', async () => {
    const { engagementId } = await makeEngagement();

    const documentVersionId = await approvedVersion(engagementId);

    await prisma.externalSignature.create({
      data: {
        engagementId,
        documentVersionId,
        method: 'WET_INK',
        signedOn: new Date(),
        evidenceReference: `${engagementId}/signed.pdf`,
        evidenceHash: 'a'.repeat(64),
        evidenceFileName: 'signed.pdf',
        reason: 'Client returned a scanned copy',
        recordedBy: administrator.id,
      },
    });

    await expect(engagements.delete({ engagementId, reason: REASON, actor: administrator })).rejects.toThrow(
      PreconditionError,
    );

    expect(await prisma.engagement.findUnique({ where: { id: engagementId } })).not.toBeNull();
  });

  it('refuses when a real Adobe agreement has been sent, but not when it was a mock', async () => {
    // The pair is the point. A mock agreement contacted nobody and named no
    // real signer, and clearing test sends is most of what this button is for.
    const mock = await makeEngagement();
    await prisma.adobeAgreement.create({
      data: {
        engagementId: mock.engagementId,
        documentVersionId: await approvedVersion(mock.engagementId),
        title: 'T2 Engagement Letter',
        agreementId: `mock-agreement-${randomUUID()}`,
        status: 'OUT_FOR_SIGNATURE',
        idempotencyKey: `k-${randomUUID()}`,
        isMockProvider: true,
      },
    });

    await expect(
      engagements.delete({ engagementId: mock.engagementId, reason: REASON, actor: administrator }),
    ).resolves.toBeUndefined();

    const real = await makeEngagement();
    await prisma.adobeAgreement.create({
      data: {
        engagementId: real.engagementId,
        documentVersionId: await approvedVersion(real.engagementId),
        title: 'T2 Engagement Letter',
        agreementId: `AGR-${randomUUID()}`,
        status: 'OUT_FOR_SIGNATURE',
        idempotencyKey: `k-${randomUUID()}`,
        isMockProvider: false,
      },
    });

    await expect(
      engagements.delete({ engagementId: real.engagementId, reason: REASON, actor: administrator }),
    ).rejects.toThrow(/sent for signature/i);
  });

  it('purges the stored bytes under both scope forms', async () => {
    // Source documents are stored under the raw engagement id; generated
    // documents under the same id with its hyphens stripped. Purging one scope
    // leaves the other behind as blobs nothing can reach.
    const { engagementId } = await makeEngagement();

    const hyphenated = await store.put({
      scope: engagementId,
      fileName: 'source.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.4 source'),
    });
    const stripped = await store.put({
      scope: engagementId.replace(/-/g, ''),
      fileName: 'generated.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.4 generated'),
    });

    await engagements.delete({ engagementId, reason: REASON, actor: administrator });

    expect(await prisma.storedDocument.findUnique({ where: { reference: hyphenated.reference } })).toBeNull();
    expect(await prisma.storedDocument.findUnique({ where: { reference: stripped.reference } })).toBeNull();
  });

  it('refuses a partner, a short reason, and an engagement that is already gone', async () => {
    const { engagementId } = await makeEngagement();

    await expect(engagements.delete({ engagementId, reason: REASON, actor: partner })).rejects.toThrow(PermissionError);
    await expect(engagements.delete({ engagementId, reason: 'oops', actor: administrator })).rejects.toThrow(
      ValidationError,
    );
    await expect(
      engagements.delete({ engagementId: randomUUID(), reason: REASON, actor: administrator }),
    ).rejects.toThrow(ValidationError);

    expect(await prisma.engagement.findUnique({ where: { id: engagementId } })).not.toBeNull();
  });
});
