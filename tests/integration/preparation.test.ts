import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { PreparationService, PricingService, factToken } from '@element/services';
import { createLogger } from '@element/shared';

/**
 * Engagement preparation, against the real database and the real seeded rules.
 *
 * This is the step between reading last year's letter and generating this
 * year's. The properties that matter are the ones that stop a wrong document
 * from reaching a client: it never chooses between disagreeing sources, never
 * guesses a deadline whose inputs are unknown, never treats last year's
 * services as this year's decision, and never overwrites a human's answer.
 */

const prisma = new PrismaClient();
const logger = createLogger({ level: 'error' });
const audit = createAuditLogger(prisma);
const pricing = new PricingService(prisma, audit);
const preparation = new PreparationService({ prisma, audit, pricing, logger });

let clientId: string;
let actorId: string;

/** Fixture engagements need distinct years: one exists per client, type and year. */
let nextTaxYear = 2700;

beforeAll(async () => {
  await prisma.$connect();

  const user = await prisma.user.upsert({
    where: { email: 'preparation-test@example.test' },
    create: { email: 'preparation-test@example.test', displayName: 'Preparation Test' },
    update: {},
  });
  actorId = user.id;

  const client = await prisma.client.create({
    data: {
      legalName: `Preparation Test Co ${randomUUID().slice(0, 8)}`,
      businessNumber: '11111 1111 RC0001',
      addressLine1: '100 Sample Street',
      city: 'Calgary',
      province: 'AB',
      postalCode: 'T2P 0A0',
      isTestFixture: true,
      contacts: {
        create: {
          fullLegalName: 'Dana Sample',
          firstName: 'Dana',
          email: 'dana@example.test',
          title: 'President',
          isPrimary: true,
        },
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

async function newT2(options: { compilationSelected?: boolean | null } = {}) {
  nextTaxYear += 1;
  return prisma.engagement.create({
    data: {
      clientId,
      engagementType: 'T2',
      taxYear: nextTaxYear,
      yearEnd: new Date(Date.UTC(nextTaxYear, 2, 31)),
      status: 'NOT_STARTED',
      compilationSelected: options.compilationSelected ?? null,
      isTestMode: true,
    },
  });
}

async function priorYearField(engagementId: string, token: string, value: string) {
  return prisma.extractedField.create({
    data: {
      engagementId,
      token,
      value,
      source: 'PRIOR_YEAR_DOCUMENT',
      extractionMethod: 'DETERMINISTIC_PATTERN',
      confidence: 0.9,
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

describe('recording current Karbon information', () => {
  it('records the client record as its own source rather than assuming it', async () => {
    const engagement = await newT2();
    await prepare(engagement.id);

    const legalName = await prisma.extractedField.findFirst({
      where: { engagementId: engagement.id, token: 'corporation.legal_name' },
    });

    expect(legalName?.source).toBe('KARBON_CLIENT');
    expect(legalName?.extractionMethod).toBe('STRUCTURED_EXPORT');
    expect(legalName?.value).toContain('Preparation Test Co');
    // Recorded, not confirmed: a reviewer still confirms before generation.
    expect(legalName?.manuallyConfirmed).toBe(false);
  });

  it('does not overwrite a value a person has confirmed', async () => {
    const engagement = await newT2();
    await prisma.extractedField.create({
      data: {
        engagementId: engagement.id,
        token: 'corporation.legal_name',
        value: 'The Name The Reviewer Typed Ltd.',
        source: 'KARBON_CLIENT',
        extractionMethod: 'MANUAL_ENTRY',
        confidence: 1,
        manuallyConfirmed: true,
        confirmedByUserId: actorId,
        confirmedAt: new Date(),
      },
    });

    await prepare(engagement.id);

    const field = await prisma.extractedField.findFirst({
      where: { engagementId: engagement.id, token: 'corporation.legal_name', source: 'KARBON_CLIENT' },
    });
    expect(field?.value).toBe('The Name The Reviewer Typed Ltd.');
  });
});

describe('reconciling disagreeing sources', () => {
  it('raises a conflict instead of choosing, and recommends the higher-priority source', async () => {
    const engagement = await newT2();
    await priorYearField(engagement.id, 'corporation.legal_name', 'Last Year Name Ltd.');

    const result = await prepare(engagement.id);
    expect(result.conflictsRaised).toBeGreaterThanOrEqual(1);

    const conflict = await prisma.fieldConflict.findFirst({
      where: { engagementId: engagement.id, token: 'corporation.legal_name' },
    });

    expect(conflict?.status).toBe('UNRESOLVED');
    expect(conflict?.recommendedSource).toBe('KARBON_CLIENT');
    expect(conflict?.recommendedValue).toContain('Preparation Test Co');

    const candidates = conflict?.candidates as { value: string; source: string }[];
    expect(candidates.map((candidate) => candidate.source)).toContain('PRIOR_YEAR_DOCUMENT');

    // The disputed field is left as it is; nothing is silently rewritten.
    const priorYear = await prisma.extractedField.findFirst({
      where: { engagementId: engagement.id, token: 'corporation.legal_name', source: 'PRIOR_YEAR_DOCUMENT' },
    });
    expect(priorYear?.value).toBe('Last Year Name Ltd.');
  });

  it('treats a cosmetic difference as agreement', async () => {
    const engagement = await newT2();
    const karbonName = (await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).legalName;
    // Same name, different punctuation and spacing.
    await priorYearField(engagement.id, 'corporation.legal_name', `${karbonName.toUpperCase()} `);

    await prepare(engagement.id);

    const conflict = await prisma.fieldConflict.findFirst({
      where: { engagementId: engagement.id, token: 'corporation.legal_name' },
    });
    expect(conflict).toBeNull();
  });

  it('does not raise the same conflict twice, and leaves a resolved one alone', async () => {
    const engagement = await newT2();
    await priorYearField(engagement.id, 'corporation.legal_name', 'Last Year Name Ltd.');

    const first = await prepare(engagement.id);
    expect(first.conflictsRaised).toBe(1);

    const second = await prepare(engagement.id);
    expect(second.conflictsRaised).toBe(0);

    expect(
      await prisma.fieldConflict.count({ where: { engagementId: engagement.id, token: 'corporation.legal_name' } }),
    ).toBe(1);

    await prisma.fieldConflict.updateMany({
      where: { engagementId: engagement.id, token: 'corporation.legal_name' },
      data: {
        status: 'RESOLVED',
        resolvedValue: 'Last Year Name Ltd.',
        resolvedSource: 'PRIOR_YEAR_DOCUMENT',
        resolvedAt: new Date(),
      },
    });

    await prepare(engagement.id);

    const conflicts = await prisma.fieldConflict.findMany({
      where: { engagementId: engagement.id, token: 'corporation.legal_name' },
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.status).toBe('RESOLVED');
  });
});

describe('calculating fees from the prior-year letter', () => {
  it('applies the seeded increase and rounds up to the next $5', async () => {
    const engagement = await newT2();
    await priorYearField(engagement.id, 'pricing.t2_fee', '$2,000.00');

    const result = await prepare(engagement.id);
    expect(result.feesCalculated).toContain('T2_PREPARATION');
    expect(result.blockedFees).toHaveLength(0);

    const fee = await prisma.feeCalculation.findFirstOrThrow({
      where: { engagementId: engagement.id, feeKind: 'T2_PREPARATION' },
    });

    expect(fee.previousFee?.toString()).toBe('2000');
    expect(fee.previousFeeSource).toBe('PRIOR_YEAR_DOCUMENT');
    // 2000 + 3% = 2060 exactly, which is already a multiple of five.
    expect(fee.roundedFee?.toString()).toBe('2060');
    expect(fee.isBlocked).toBe(false);
  });

  it('rounds a fractional increase upward, never downward', async () => {
    const engagement = await newT2();
    await priorYearField(engagement.id, 'pricing.t2_fee', '1234.00');

    await prepare(engagement.id);

    const fee = await prisma.feeCalculation.findFirstOrThrow({
      where: { engagementId: engagement.id, feeKind: 'T2_PREPARATION' },
    });

    // 1234 + 3% = 1271.02 → next multiple of five is 1275.
    expect(fee.unroundedFee?.toString()).toBe('1271.02');
    expect(fee.roundedFee?.toString()).toBe('1275');
  });

  it('blocks the fee rather than inventing one when no prior-year amount was found', async () => {
    const engagement = await newT2();

    const result = await prepare(engagement.id);

    expect(result.blockedFees).toContain('T2_PREPARATION');
    expect(result.feesCalculated).not.toContain('T2_PREPARATION');

    const fee = await prisma.feeCalculation.findFirstOrThrow({
      where: { engagementId: engagement.id, feeKind: 'T2_PREPARATION' },
    });
    expect(fee.isBlocked).toBe(true);
    expect(fee.roundedFee).toBeNull();
  });

  it('prices the compilation fee only when compilation is selected for this year', async () => {
    const withCompilation = await newT2({ compilationSelected: true });
    await priorYearField(withCompilation.id, 'pricing.t2_fee', '2000');
    await priorYearField(withCompilation.id, 'pricing.compilation_fee', '1000');

    const included = await prepare(withCompilation.id);
    expect(included.feesCalculated).toContain('CSRS_4200_COMPILATION');

    const withoutCompilation = await newT2({ compilationSelected: false });
    await priorYearField(withoutCompilation.id, 'pricing.t2_fee', '2000');
    await priorYearField(withoutCompilation.id, 'pricing.compilation_fee', '1000');

    const excluded = await prepare(withoutCompilation.id);
    expect(excluded.feesCalculated).not.toContain('CSRS_4200_COMPILATION');
    expect(excluded.blockedFees).not.toContain('CSRS_4200_COMPILATION');
  });
});

describe('evaluating the deadline rules', () => {
  it('records the rule, the input and the assumptions behind each date', async () => {
    const engagement = await newT2();
    await prepare(engagement.id);

    const filing = await prisma.calculatedDate.findUniqueOrThrow({
      where: { engagementId_token: { engagementId: engagement.id, token: 'dates.filing_due' } },
    });

    expect(filing.ruleCode).toBe('t2.filing_deadline');
    // Six months after a 31 March year-end.
    expect(filing.result?.toISOString().slice(0, 10)).toBe(`${nextTaxYear}-09-30`);
    expect(filing.isBlocked).toBe(false);
    expect(filing.requiresConfirmation).toBe(true);
    expect(filing.confirmedAt).toBeNull();
    expect((filing.assumptions as string[]).join(' ')).toContain('six months');
  });

  it('blocks the balance-due day until the reviewer answers the fact it depends on', async () => {
    const engagement = await newT2();

    const first = await prepare(engagement.id);
    expect(first.blockedDates).toContain('dates.balance_due');

    const blocked = await prisma.calculatedDate.findUniqueOrThrow({
      where: { engagementId_token: { engagementId: engagement.id, token: 'dates.balance_due' } },
    });
    expect(blocked.isBlocked).toBe(true);
    expect(blocked.result).toBeNull();
    expect(blocked.blockedReason).toContain('qualifiesForThreeMonthBalanceDueDay');

    // The reviewer answers "no": two months after year-end.
    await prisma.extractedField.create({
      data: {
        engagementId: engagement.id,
        token: factToken('qualifiesForThreeMonthBalanceDueDay'),
        value: 'no',
        valueBoolean: false,
        source: 'MANUAL_ENTRY',
        extractionMethod: 'MANUAL_ENTRY',
        confidence: 1,
        manuallyConfirmed: true,
        confirmedByUserId: actorId,
        confirmedAt: new Date(),
      },
    });

    const second = await prepare(engagement.id);
    expect(second.blockedDates).not.toContain('dates.balance_due');

    const unblocked = await prisma.calculatedDate.findUniqueOrThrow({
      where: { engagementId_token: { engagementId: engagement.id, token: 'dates.balance_due' } },
    });
    expect(unblocked.isBlocked).toBe(false);
    expect(unblocked.result?.toISOString().slice(0, 10)).toBe(`${nextTaxYear}-05-31`);
  });

  it('applies the three-month branch when the reviewer answers yes', async () => {
    const engagement = await newT2();
    await prisma.extractedField.create({
      data: {
        engagementId: engagement.id,
        token: factToken('qualifiesForThreeMonthBalanceDueDay'),
        value: 'yes',
        valueBoolean: true,
        source: 'MANUAL_ENTRY',
        extractionMethod: 'MANUAL_ENTRY',
        confidence: 1,
        manuallyConfirmed: true,
      },
    });

    await prepare(engagement.id);

    const balanceDue = await prisma.calculatedDate.findUniqueOrThrow({
      where: { engagementId_token: { engagementId: engagement.id, token: 'dates.balance_due' } },
    });

    expect(balanceDue.result?.toISOString().slice(0, 10)).toBe(`${nextTaxYear}-06-30`);
    expect((balanceDue.assumptions as string[]).join(' ')).toContain('Three-month balance-due day');
  });

  it('never rewrites a date a reviewer has already confirmed', async () => {
    const engagement = await newT2();
    await prepare(engagement.id);

    const chosen = new Date(Date.UTC(nextTaxYear, 8, 15));
    await prisma.calculatedDate.update({
      where: { engagementId_token: { engagementId: engagement.id, token: 'dates.filing_due' } },
      data: { manualOverride: chosen, overrideReason: 'Confirmed against the corporate records.', confirmedByUserId: actorId, confirmedAt: new Date() },
    });

    await prepare(engagement.id);

    const after = await prisma.calculatedDate.findUniqueOrThrow({
      where: { engagementId_token: { engagementId: engagement.id, token: 'dates.filing_due' } },
    });
    expect(after.manualOverride?.toISOString().slice(0, 10)).toBe(`${nextTaxYear}-09-15`);
    expect(after.confirmedAt).not.toBeNull();
  });

  it('proposes the date sent as today, unconfirmed', async () => {
    const engagement = await newT2();
    await prepare(engagement.id);

    const sent = await prisma.calculatedDate.findUniqueOrThrow({
      where: { engagementId_token: { engagementId: engagement.id, token: 'dates.sent' } },
    });

    expect(sent.requiresConfirmation).toBe(true);
    expect(sent.confirmedAt).toBeNull();
    expect((sent.assumptions as string[]).join(' ')).toContain('confirm');
  });
});

describe('seeding the service selections', () => {
  it('carries the prior year forward as a suggestion, not a decision', async () => {
    const engagement = await newT2();

    await prisma.extractedField.create({
      data: {
        engagementId: engagement.id,
        token: 'service.t2.t1135',
        value: 'true',
        valueBoolean: true,
        source: 'PRIOR_YEAR_DOCUMENT',
        extractionMethod: 'DETERMINISTIC_PATTERN',
        confidence: 0.8,
      },
    });

    const result = await prepare(engagement.id);
    expect(result.serviceSelectionsSeeded).toBeGreaterThan(0);

    const t1135 = await prisma.serviceSelection.findUniqueOrThrow({
      where: { engagementId_serviceCode: { engagementId: engagement.id, serviceCode: 't2.t1135' } },
    });

    expect(t1135.priorYearSelected).toBe(true);
    expect(t1135.isSelected).toBe(true);
    // The crucial part: last year's tick does not count as this year's answer.
    expect(t1135.confirmed).toBe(false);
  });

  it('leaves the prior year null when last year said nothing about a service', async () => {
    const engagement = await newT2();
    await prepare(engagement.id);

    const noaReview = await prisma.serviceSelection.findUniqueOrThrow({
      where: { engagementId_serviceCode: { engagementId: engagement.id, serviceCode: 't2.noa_review' } },
    });

    expect(noaReview.priorYearSelected).toBeNull();
    expect(noaReview.isSelected).toBe(false);
    expect(noaReview.confirmed).toBe(false);
  });

  it('does not undo a reviewer confirmation when it runs again', async () => {
    const engagement = await newT2();
    await prepare(engagement.id);

    await prisma.serviceSelection.update({
      where: { engagementId_serviceCode: { engagementId: engagement.id, serviceCode: 't2.gifi' } },
      data: { isSelected: false, confirmed: true, confirmedByUserId: actorId, confirmedAt: new Date() },
    });

    await prepare(engagement.id);

    const gifi = await prisma.serviceSelection.findUniqueOrThrow({
      where: { engagementId_serviceCode: { engagementId: engagement.id, serviceCode: 't2.gifi' } },
    });

    expect(gifi.isSelected).toBe(false);
    expect(gifi.confirmed).toBe(true);
  });
});

describe('running it more than once', () => {
  it('updates rather than duplicates every row it owns', async () => {
    const engagement = await newT2();
    await priorYearField(engagement.id, 'pricing.t2_fee', '2000');

    await prepare(engagement.id);
    const afterFirst = {
      fields: await prisma.extractedField.count({ where: { engagementId: engagement.id } }),
      dates: await prisma.calculatedDate.count({ where: { engagementId: engagement.id } }),
      services: await prisma.serviceSelection.count({ where: { engagementId: engagement.id } }),
      fees: await prisma.feeCalculation.count({ where: { engagementId: engagement.id } }),
    };

    await prepare(engagement.id);
    await prepare(engagement.id);

    expect({
      fields: await prisma.extractedField.count({ where: { engagementId: engagement.id } }),
      dates: await prisma.calculatedDate.count({ where: { engagementId: engagement.id } }),
      services: await prisma.serviceSelection.count({ where: { engagementId: engagement.id } }),
      fees: await prisma.feeCalculation.count({ where: { engagementId: engagement.id } }),
    }).toEqual(afterFirst);
  });

  it('records what it did in the audit trail', async () => {
    const engagement = await newT2();
    await prepare(engagement.id);

    const events = await prisma.auditEvent.findMany({
      where: { engagementId: engagement.id, objectType: 'Engagement' },
    });

    const prepared = events.find((event) => (event.reason ?? '').includes('Engagement prepared'));
    expect(prepared).toBeDefined();
    expect(prepared?.userId).toBe(actorId);
  });
});
