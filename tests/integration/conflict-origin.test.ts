import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { PreparationService, PricingService } from '@element/services';
import { createLogger } from '@element/shared';

/**
 * Two kinds of disagreement, and only one of them is reconciliation's to clear.
 *
 * `reconcile` compares the sources it can see — what Karbon says against what
 * last year's letter said — and clears an unresolved conflict for a token once
 * they agree. A scan reading a client's whole library produces a different
 * disagreement: two *documents* saying different things under the same source,
 * which that comparison cannot see at all.
 *
 * Undistinguished, the scan's question is deleted the moment Karbon happens to
 * agree with whichever document won — and a decision somebody still had to make
 * disappears with nothing to show it ever existed.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error' });
const preparation = new PreparationService({
  prisma,
  audit,
  pricing: new PricingService(prisma, audit),
  logger,
});

let clientId: string;
let actorId: string;
let nextTaxYear = 3200;

beforeAll(async () => {
  await prisma.$connect();

  const user = await prisma.user.upsert({
    where: { email: 'conflict-origin-test@example.test' },
    create: { email: 'conflict-origin-test@example.test', displayName: 'Conflict Origin Test' },
    update: {},
  });
  actorId = user.id;

  const client = await prisma.client.create({
    data: {
      legalName: `Conflict Origin Co ${randomUUID().slice(0, 8)}`,
      isTestFixture: true,
      contacts: {
        create: { fullLegalName: 'Dana Sample', email: 'dana@example.test', title: 'President', isPrimary: true },
      },
    },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId } });
  await prisma.clientContact.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.$disconnect();
});

async function newT2() {
  nextTaxYear += 1;
  return prisma.engagement.create({
    data: {
      clientId,
      engagementType: 'T2',
      taxYear: nextTaxYear,
      yearEnd: new Date(Date.UTC(nextTaxYear, 2, 31)),
      status: 'NOT_STARTED',
      isTestMode: true,
    },
  });
}

function prepare(engagementId: string) {
  return preparation.prepare({
    engagementId,
    actorId,
    correlationId: randomUUID(),
    highIncreaseThresholdPercent: 10,
  });
}

describe('a disagreement between documents', () => {
  it('survives a reconciliation that finds the sources agreeing', async () => {
    const engagement = await newT2();

    // What the scan would leave behind: one value written, and a question about
    // the document that disagreed with it.
    await prisma.extractedField.create({
      data: {
        engagementId: engagement.id,
        token: 'corporation.legal_name',
        // Deliberately the same as the client record, so reconciliation sees
        // its own sources agreeing and reaches for the delete.
        value: (await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).legalName,
        source: 'PRIOR_YEAR_DOCUMENT',
        extractionMethod: 'DETERMINISTIC_PATTERN',
        confidence: 1,
      },
    });

    await prisma.fieldConflict.create({
      data: {
        engagementId: engagement.id,
        token: 'corporation.legal_name',
        origin: 'CROSS_DOCUMENT',
        candidates: [
          { value: 'From the signed letter', source: 'PRIOR_YEAR_DOCUMENT', fileName: 'signed.pdf' },
          { value: 'From the trial balance', source: 'PRIOR_YEAR_DOCUMENT', fileName: 'tb.pdf' },
        ],
        recommendedValue: 'From the signed letter',
        recommendedSource: 'PRIOR_YEAR_DOCUMENT',
        status: 'UNRESOLVED',
      },
    });

    await prepare(engagement.id);

    const survived = await prisma.fieldConflict.findFirst({
      where: { engagementId: engagement.id, token: 'corporation.legal_name', origin: 'CROSS_DOCUMENT' },
    });

    expect(survived).not.toBeNull();
    expect(survived?.status).toBe('UNRESOLVED');
  });

  it('still clears a stale disagreement between sources', async () => {
    const engagement = await newT2();
    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });

    await prisma.extractedField.create({
      data: {
        engagementId: engagement.id,
        token: 'corporation.legal_name',
        value: client.legalName,
        source: 'PRIOR_YEAR_DOCUMENT',
        extractionMethod: 'DETERMINISTIC_PATTERN',
        confidence: 1,
      },
    });

    await prisma.fieldConflict.create({
      data: {
        engagementId: engagement.id,
        token: 'corporation.legal_name',
        origin: 'CROSS_SOURCE',
        candidates: [{ value: 'Something stale', source: 'KARBON_CLIENT' }],
        recommendedValue: 'Something stale',
        recommendedSource: 'KARBON_CLIENT',
        status: 'UNRESOLVED',
      },
    });

    await prepare(engagement.id);

    // The sources now agree, so this one is genuinely answered.
    const cleared = await prisma.fieldConflict.findFirst({
      where: { engagementId: engagement.id, token: 'corporation.legal_name', origin: 'CROSS_SOURCE' },
    });
    expect(cleared).toBeNull();
  });

  it('defaults an existing conflict to a disagreement between sources', async () => {
    const engagement = await newT2();

    const conflict = await prisma.fieldConflict.create({
      data: {
        engagementId: engagement.id,
        token: 'signer.officer_title',
        candidates: [{ value: 'President', source: 'KARBON_CLIENT' }],
        status: 'UNRESOLVED',
      },
    });

    // The column is defaulted, so no backfill was needed for rows written
    // before it existed.
    expect(conflict.origin).toBe('CROSS_SOURCE');
  });
});
