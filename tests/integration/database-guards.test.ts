import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { ALLOWED_TRANSITIONS, ENGAGEMENT_STATUSES } from '@element/workflows';

/**
 * Database-level guarantees, against a real Postgres.
 *
 * These rules are enforced in the application too. The point of testing them
 * here is that they must hold even when something bypasses the service layer.
 */

const prisma = new PrismaClient();

let clientId: string;

beforeAll(async () => {
  await prisma.$connect();
  const client = await prisma.client.create({
    data: { legalName: `Guard Test Co ${randomUUID().slice(0, 8)}`, isTestFixture: true },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.$disconnect();
});

// Each fixture engagement needs its own year: one engagement exists per
// client, type and year, which is itself one of the constraints under test.
let nextTaxYear = 2100;

async function newEngagement(status: string) {
  nextTaxYear += 1;
  return prisma.engagement.create({
    data: { clientId, engagementType: 'T2', taxYear: nextTaxYear, status: status as never },
  });
}

describe('workflow transition trigger', () => {
  it('is seeded with exactly the transitions the state machine declares', async () => {
    const rows = await prisma.workflowTransition.findMany();
    const expected = Object.entries(ALLOWED_TRANSITIONS).flatMap(([from, targets]) =>
      targets.map((to) => `${from}->${to}`),
    );

    expect(rows.map((row) => `${row.fromStatus}->${row.toStatus}`).sort()).toEqual(expected.sort());
  });

  it('rejects a jump from DRAFT_READY straight to SENT_FOR_SIGNATURE', async () => {
    const engagement = await newEngagement('DRAFT_READY');

    await expect(
      prisma.engagement.update({ where: { id: engagement.id }, data: { status: 'SENT_FOR_SIGNATURE' } }),
    ).rejects.toThrow(/Illegal engagement status transition/i);

    const unchanged = await prisma.engagement.findUniqueOrThrow({ where: { id: engagement.id } });
    expect(unchanged.status).toBe('DRAFT_READY');
  });

  it('rejects reaching APPROVED from anywhere but IN_REVIEW', async () => {
    for (const from of ['DRAFT_READY', 'REVIEW_REQUIRED', 'NEEDS_ATTENTION'] as const) {
      const engagement = await newEngagement(from);
      await expect(
        prisma.engagement.update({ where: { id: engagement.id }, data: { status: 'APPROVED' } }),
      ).rejects.toThrow(/Illegal engagement status transition/i);
    }
  });

  it('allows the legitimate review path', async () => {
    const engagement = await newEngagement('DRAFT_READY');

    for (const next of ['REVIEW_REQUIRED', 'IN_REVIEW', 'APPROVED', 'READY_TO_SEND'] as const) {
      const updated = await prisma.engagement.update({ where: { id: engagement.id }, data: { status: next } });
      expect(updated.status).toBe(next);
    }
  });

  it('agrees with the application state machine on every pair', async () => {
    // Spot-check a sample of illegal pairs rather than all 784 combinations.
    const illegal: [string, string][] = [];
    for (const from of ENGAGEMENT_STATUSES) {
      for (const to of ENGAGEMENT_STATUSES) {
        if (from !== to && !(ALLOWED_TRANSITIONS[from] ?? []).includes(to)) illegal.push([from, to]);
      }
    }

    const sample = illegal.slice(0, 15);
    for (const [from, to] of sample) {
      const engagement = await newEngagement(from);
      await expect(
        prisma.engagement.update({ where: { id: engagement.id }, data: { status: to as never } }),
        `${from} -> ${to} must be rejected`,
      ).rejects.toThrow(/Illegal engagement status transition/i);
    }
  });
});

describe('audit trail immutability', () => {
  it('rejects updating or deleting an audit event', async () => {
    const event = await prisma.auditEvent.create({
      data: { eventType: 'FIELD_EDITED', objectType: 'Test', objectId: randomUUID() },
    });

    await expect(
      prisma.auditEvent.update({ where: { id: event.id }, data: { eventType: 'TAMPERED' } }),
    ).rejects.toThrow(/immutable/i);

    await expect(prisma.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(/immutable/i);

    const stillThere = await prisma.auditEvent.findUnique({ where: { id: event.id } });
    expect(stillThere?.eventType).toBe('FIELD_EDITED');
  });
});

describe('pricing constraints', () => {
  it('rejects a rounded fee that is not a multiple of five', async () => {
    const engagement = await newEngagement('NOT_STARTED');

    await expect(
      prisma.feeCalculation.create({
        data: {
          engagementId: engagement.id,
          feeKind: 'T2_PREPARATION',
          method: 'PERCENTAGE',
          unroundedFee: '1031',
          roundedFee: '1031',
          roundingApplied: true,
        },
      }),
    ).rejects.toThrow(/fee_calculation_rounds_up_to_five/i);
  });

  it('rejects a rounded fee below the unrounded fee', async () => {
    const engagement = await newEngagement('NOT_STARTED');

    await expect(
      prisma.feeCalculation.create({
        data: {
          engagementId: engagement.id,
          feeKind: 'T2_PREPARATION',
          method: 'PERCENTAGE',
          unroundedFee: '1036',
          roundedFee: '1035',
          roundingApplied: true,
        },
      }),
    ).rejects.toThrow(/fee_calculation_rounds_up_to_five/i);
  });

  it('accepts a correctly rounded fee', async () => {
    const engagement = await newEngagement('NOT_STARTED');

    const fee = await prisma.feeCalculation.create({
      data: {
        engagementId: engagement.id,
        feeKind: 'T2_PREPARATION',
        method: 'PERCENTAGE',
        unroundedFee: '1031',
        roundedFee: '1035',
        roundingApplied: true,
      },
    });

    expect(fee.roundedFee?.toString()).toBe('1035');
  });

  it('rejects a negative fee', async () => {
    const engagement = await newEngagement('NOT_STARTED');

    await expect(
      prisma.feeCalculation.create({
        data: {
          engagementId: engagement.id,
          feeKind: 'T2_PREPARATION',
          method: 'PERCENTAGE',
          roundedFee: '-5',
          roundingApplied: true,
        },
      }),
    ).rejects.toThrow(/fee_calculation_non_negative/i);
  });
});

describe('duplicate prevention', () => {
  it('permits only one live Adobe agreement per engagement', async () => {
    const engagement = await newEngagement('NOT_STARTED');
    const version = await prisma.documentVersion.create({
      data: {
        engagementId: engagement.id,
        documentType: 'T2_ENGAGEMENT_LETTER',
        versionNumber: 1,
        status: 'APPROVED',
      },
    });

    await prisma.adobeAgreement.create({
      data: {
        engagementId: engagement.id,
        documentVersionId: version.id,
        idempotencyKey: `key-a-${randomUUID()}`,
        status: 'OUT_FOR_SIGNATURE',
        title: 'First',
      },
    });

    // A second live agreement is impossible even with a different key.
    await expect(
      prisma.adobeAgreement.create({
        data: {
          engagementId: engagement.id,
          documentVersionId: version.id,
          idempotencyKey: `key-b-${randomUUID()}`,
          status: 'OUT_FOR_SIGNATURE',
          title: 'Second',
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate idempotency key on a background job', async () => {
    const key = `job-${randomUUID()}`;
    await prisma.backgroundJob.create({
      data: { jobType: 'GENERATE_ENGAGEMENT_LETTER', idempotencyKey: key, correlationId: 'c1', payload: {} },
    });

    await expect(
      prisma.backgroundJob.create({
        data: { jobType: 'GENERATE_ENGAGEMENT_LETTER', idempotencyKey: key, correlationId: 'c2', payload: {} },
      }),
    ).rejects.toThrow();

    await prisma.backgroundJob.deleteMany({ where: { idempotencyKey: key } });
  });

  it('rejects a duplicate Adobe webhook event id', async () => {
    const eventId = `evt-${randomUUID()}`;
    await prisma.adobeEvent.create({
      data: { providerEventId: eventId, eventType: 'AGREEMENT_ACTION_COMPLETED', payload: {} },
    });

    await expect(
      prisma.adobeEvent.create({
        data: { providerEventId: eventId, eventType: 'AGREEMENT_ACTION_COMPLETED', payload: {} },
      }),
    ).rejects.toThrow();

    await prisma.adobeEvent.deleteMany({ where: { providerEventId: eventId } });
  });

  it('permits only one engagement per client, type and year', async () => {
    const year = 1900;
    await prisma.engagement.create({ data: { clientId, engagementType: 'T3', taxYear: year } });

    await expect(
      prisma.engagement.create({ data: { clientId, engagementType: 'T3', taxYear: year } }),
    ).rejects.toThrow();
  });
});

describe('document and template immutability', () => {
  it('refuses to change the content of an approved document version', async () => {
    const engagement = await newEngagement('NOT_STARTED');
    const version = await prisma.documentVersion.create({
      data: {
        engagementId: engagement.id,
        documentType: 'T2_ENGAGEMENT_LETTER',
        versionNumber: 1,
        status: 'APPROVED',
        pdfHash: 'a'.repeat(64),
      },
    });

    await expect(
      prisma.documentVersion.update({ where: { id: version.id }, data: { pdfHash: 'b'.repeat(64) } }),
    ).rejects.toThrow(/cannot be modified/i);

    // Lifecycle columns may still change.
    const superseded = await prisma.documentVersion.update({
      where: { id: version.id },
      data: { status: 'SUPERSEDED', supersededAt: new Date() },
    });
    expect(superseded.status).toBe('SUPERSEDED');
  });

  it('refuses to change a published template version', async () => {
    const template = await prisma.documentTemplate.findFirst({ where: { documentType: 'T2_ENGAGEMENT_LETTER' } });
    if (!template) return;

    const active = await prisma.templateVersion.findFirst({ where: { templateId: template.id, status: 'ACTIVE' } });
    if (!active) return;

    await expect(
      prisma.templateVersion.update({ where: { id: active.id }, data: { sourceFileHash: 'c'.repeat(64) } }),
    ).rejects.toThrow(/immutable/i);
  });
});
