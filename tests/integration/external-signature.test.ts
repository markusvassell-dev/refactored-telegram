import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import {
  DocumentStore,
  ExternalSignatureService,
  NotificationService,
  WorkflowService,
} from '@element/services';
import { createLogger, PermissionError, PreconditionError, type Principal } from '@element/shared';

/**
 * Recording a signature this application did not collect.
 *
 * The firm holds Acrobat Pro, which has no API; Acrobat Sign Solutions, which
 * does, is a separate paid licence. Without this bridge an approved letter can
 * never become a signed one and the second half of the workflow is unreachable.
 *
 * These tests are about the properties that make the bridge safe to have at
 * all. It is the one step where a false record would be worth making — the
 * difference between a client having agreed to a fee and somebody saying they
 * did — so the questions are: is evidence genuinely required, is the approved
 * document left alone, and can a signature recorded by hand ever be mistaken
 * for one Adobe witnessed.
 */

const prisma = new PrismaClient();
const logger = createLogger({ level: 'error' });
const audit = createAuditLogger(prisma);
const notifications = new NotificationService({ prisma });
const workflow = new WorkflowService(prisma, audit);

const store = new DocumentStore({
  rootDirectory: '/tmp/element-engagements-tests/external-signatures',
  retentionHours: 72,
  maxBytes: 25 * 1024 * 1024,
  signingSecret: 'test-signing-secret-test-signing-secret',
});

const service = new ExternalSignatureService({ prisma, audit, store, workflow, notifications, logger });

const suffix = randomUUID().slice(0, 8);
const clientIds: string[] = [];
let approver: Principal;
let preparer: Principal;

const TAX_YEAR = 2907;
const SIGNED_PDF = Buffer.from('%PDF-1.4 signed engagement letter', 'utf8');
const TODAY = '2026-08-07';

async function makeUser(email: string, roles: Principal['roles']): Promise<Principal> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, displayName: email.split('@')[0] as string },
    update: {},
  });
  for (const role of roles) {
    await prisma.userRole.upsert({
      where: { userId_role: { userId: user.id, role } },
      create: { userId: user.id, role },
      update: {},
    });
  }
  return { id: user.id, email: user.email, displayName: user.displayName, roles };
}

/**
 * An engagement parked exactly where the bridge applies: past final approval,
 * approved PDF in hand, waiting for a signature that will never arrive through
 * an API the firm cannot call.
 */
async function readyToSendEngagement(
  options: { signers?: number; engagementType?: 'T2' | 'T1_JOINT' } = {},
): Promise<{ engagementId: string; documentVersionId: string; participantIds: string[] }> {
  const client = await prisma.client.create({
    data: { legalName: `External Signature Co ${randomUUID().slice(0, 8)}`, isTestFixture: true },
  });
  clientIds.push(client.id);

  const engagement = await prisma.engagement.create({
    data: {
      clientId: client.id,
      engagementType: options.engagementType ?? 'T2',
      taxYear: TAX_YEAR,
      status: 'NOT_STARTED',
      assignedPreparerId: preparer.id,
      finalApproverId: approver.id,
    },
  });

  // Walked through the legal transitions rather than set directly: the
  // database refuses anything else, which is the point.
  for (const to of ['GENERATING', 'DRAFT_READY', 'REVIEW_REQUIRED', 'IN_REVIEW', 'APPROVED', 'READY_TO_SEND'] as const) {
    await workflow.transition({ engagementId: engagement.id, to, reason: 'fixture' });
  }

  const version = await prisma.documentVersion.create({
    data: {
      engagementId: engagement.id,
      documentType: 'T2_ENGAGEMENT_LETTER',
      versionNumber: 1,
      status: 'APPROVED',
      generatedPdfReference: 'fixture/approved.pdf',
      pdfHash: 'fixture-approved-hash',
      approvedBy: approver.id,
      approvedAt: new Date(),
    },
  });

  await prisma.approval.create({
    data: {
      engagementId: engagement.id,
      documentVersionId: version.id,
      userId: approver.id,
      actingRole: 'PARTNER_OR_FINAL_APPROVER',
      type: 'FINAL_DOCUMENT',
      decision: 'APPROVED',
    },
  });

  const participantIds: string[] = [];
  const roles = ['AUTHORIZED_SIGNING_OFFICER', 'TAXPAYER_2'] as const;
  for (let index = 0; index < (options.signers ?? 1); index += 1) {
    const participant = await prisma.engagementParticipant.create({
      data: {
        engagementId: engagement.id,
        role: roles[index] ?? 'CC_RECIPIENT',
        fullLegalName: `Signer ${index + 1}`,
        email: `signer${index + 1}-${suffix}@test.example`,
        isSigner: true,
        contactConfirmed: true,
        signingOrder: index + 1,
      },
    });
    participantIds.push(participant.id);
  }

  return { engagementId: engagement.id, documentVersionId: version.id, participantIds };
}

function recordInput(fixture: Awaited<ReturnType<typeof readyToSendEngagement>>, overrides: Record<string, unknown> = {}) {
  return {
    engagementId: fixture.engagementId,
    documentVersionId: fixture.documentVersionId,
    actor: approver,
    method: 'ACROBAT_ESIGN' as const,
    signedOn: '2026-08-05',
    reason: 'Signed in Acrobat because the Acrobat Sign licence is not bought yet.',
    confirmedSignerIds: fixture.participantIds,
    evidence: { fileName: 'signed.pdf', mimeType: 'application/pdf', content: SIGNED_PDF },
    today: TODAY,
    ...overrides,
  };
}

beforeAll(async () => {
  await prisma.$connect();
  approver = await makeUser(`external-sig-approver-${suffix}@test.example`, ['PARTNER_OR_FINAL_APPROVER']);
  preparer = await makeUser(`external-sig-preparer-${suffix}@test.example`, ['PREPARER']);
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: [approver.id, preparer.id] } } });
  await prisma.$disconnect();
});

describe('recording a signature obtained elsewhere', () => {
  it('advances the engagement to SIGNED and keeps the evidence', async () => {
    const fixture = await readyToSendEngagement();

    const result = await service.record(recordInput(fixture));

    expect(result.duplicate).toBe(false);
    expect(result.evidenceHash).toMatch(/^[0-9a-f]{64}$/);

    const engagement = await prisma.engagement.findUniqueOrThrow({ where: { id: fixture.engagementId } });
    expect(engagement.status).toBe('SIGNED');

    const signature = await prisma.externalSignature.findFirstOrThrow({
      where: { engagementId: fixture.engagementId },
      include: { signers: true },
    });
    expect(signature.evidenceFileName).toBe('signed.pdf');
    expect(signature.method).toBe('ACROBAT_ESIGN');
    expect(signature.signers).toHaveLength(1);

    // The evidence is genuinely retrievable, not just a row claiming it exists.
    await expect(store.get(signature.evidenceReference)).resolves.toEqual(SIGNED_PDF);
  });

  it('leaves the approved document exactly as it was', async () => {
    // The approved PDF is the only thing that proves what the firm actually
    // approved. Overwriting it with the signed copy would destroy that, and the
    // spec forbids it outright.
    const fixture = await readyToSendEngagement();
    const before = await prisma.documentVersion.findUniqueOrThrow({ where: { id: fixture.documentVersionId } });

    await service.record(recordInput(fixture));

    const after = await prisma.documentVersion.findUniqueOrThrow({ where: { id: fixture.documentVersionId } });
    expect(after.generatedPdfReference).toBe(before.generatedPdfReference);
    expect(after.pdfHash).toBe(before.pdfHash);
    expect(after.status).toBe('APPROVED');
  });

  it('refuses a file that is not a PDF, whatever it is called', async () => {
    const fixture = await readyToSendEngagement();

    await expect(
      service.record(
        recordInput(fixture, {
          evidence: {
            fileName: 'signed.pdf',
            mimeType: 'application/pdf',
            content: Buffer.from('PK this is a word file', 'utf8'),
          },
        }),
      ),
    ).rejects.toThrow(PreconditionError);

    const engagement = await prisma.engagement.findUniqueOrThrow({ where: { id: fixture.engagementId } });
    expect(engagement.status).toBe('READY_TO_SEND');
  });

  it('refuses when only one of two joint signers is confirmed', async () => {
    // A half-signed joint letter must never read as a complete one.
    const fixture = await readyToSendEngagement({ signers: 2, engagementType: 'T1_JOINT' });

    await expect(
      service.record(recordInput(fixture, { confirmedSignerIds: [fixture.participantIds[0]] })),
    ).rejects.toThrow(PreconditionError);

    const engagement = await prisma.engagement.findUniqueOrThrow({ where: { id: fixture.engagementId } });
    expect(engagement.status).toBe('READY_TO_SEND');
  });

  it('records both signers when both are confirmed', async () => {
    const fixture = await readyToSendEngagement({ signers: 2, engagementType: 'T1_JOINT' });

    await service.record(recordInput(fixture));

    const signature = await prisma.externalSignature.findFirstOrThrow({
      where: { engagementId: fixture.engagementId },
      include: { signers: true },
    });
    expect(signature.signers.map((signer) => signer.fullLegalName).sort()).toEqual(['Signer 1', 'Signer 2']);
  });

  it('refuses a role that cannot authorise a send', async () => {
    const fixture = await readyToSendEngagement();

    await expect(service.record(recordInput(fixture, { actor: preparer }))).rejects.toThrow(PermissionError);

    const count = await prisma.externalSignature.count({ where: { engagementId: fixture.engagementId } });
    expect(count).toBe(0);
  });

  it('treats the same file recorded twice as one signature, not two', async () => {
    const fixture = await readyToSendEngagement();

    const first = await service.record(recordInput(fixture));
    const second = await service.record(recordInput(fixture));

    expect(second.duplicate).toBe(true);
    expect(second.externalSignatureId).toBe(first.externalSignatureId);
    expect(await prisma.externalSignature.count({ where: { engagementId: fixture.engagementId } })).toBe(1);
  });

  it('writes an audit event carrying the hash and never the document', async () => {
    const fixture = await readyToSendEngagement();
    await service.record(recordInput(fixture));

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { engagementId: fixture.engagementId, eventType: 'EXTERNAL_SIGNATURE_RECORDED' },
    });

    expect(event.userId).toBe(approver.id);
    expect(event.reason).toMatch(/Acrobat Sign licence/);

    const after = event.afterValue as Record<string, unknown>;
    expect(after.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(after.method).toBe('ACROBAT_ESIGN');
    // A signed engagement letter carries client details that have no business
    // being copied into an audit payload.
    expect(JSON.stringify(after)).not.toContain('%PDF');
  });

  it('tells the people responsible, in words that do not promise a certificate', async () => {
    const fixture = await readyToSendEngagement();
    await service.record(recordInput(fixture));

    const notice = await prisma.notification.findFirstOrThrow({
      where: { engagementId: fixture.engagementId, userId: approver.id },
    });

    // A different event type from the Adobe one on purpose: the Adobe notice
    // says the signed document and certificate are being filed automatically,
    // and neither of those happens here.
    expect(notice.eventType).toBe('SIGNING_RECORDED_EXTERNALLY');
    expect(notice.title).toMatch(/recorded by hand/i);
    expect(notice.body).not.toMatch(/certificate/i);
  });
});

describe('what the database itself refuses', () => {
  it('will not mark an engagement signed with no evidence recorded', async () => {
    // Defence in depth. The service checks this, but this is the step worth
    // faking, so the database refuses it too — no application bug, migration or
    // console session can produce a signed engagement with nothing behind it.
    const fixture = await readyToSendEngagement();

    await expect(
      prisma.engagement.update({ where: { id: fixture.engagementId }, data: { status: 'SIGNED' } }),
    ).rejects.toThrow(/no external signature evidence/i);
  });

  it('will not let a recorded signature be rewritten afterwards', async () => {
    // The value of the record is that it cannot be quietly adjusted later.
    // Correcting a mistake means recording the correction.
    const fixture = await readyToSendEngagement();
    await service.record(recordInput(fixture));

    const signature = await prisma.externalSignature.findFirstOrThrow({
      where: { engagementId: fixture.engagementId },
    });

    await expect(
      prisma.externalSignature.update({
        where: { id: signature.id },
        data: { signedOn: new Date('2020-01-01T00:00:00.000Z') },
      }),
    ).rejects.toThrow(/cannot be altered once recorded/i);

    await expect(
      prisma.externalSignature.update({ where: { id: signature.id }, data: { reason: 'something else entirely' } }),
    ).rejects.toThrow(/cannot be altered once recorded/i);
  });

  it('still allows the Karbon document id to be filled in later', async () => {
    // Filing into Karbon happens after the fact and must remain possible.
    const fixture = await readyToSendEngagement();
    await service.record(recordInput(fixture));

    const signature = await prisma.externalSignature.findFirstOrThrow({
      where: { engagementId: fixture.engagementId },
    });

    await expect(
      prisma.externalSignature.update({
        where: { id: signature.id },
        data: { karbonDocumentId: 'karbon-doc-1' },
      }),
    ).resolves.toMatchObject({ karbonDocumentId: 'karbon-doc-1' });
  });
});
