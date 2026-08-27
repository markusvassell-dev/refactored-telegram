import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { EngagementReadinessService } from '@element/services';

/**
 * Settling the routine, and refusing the rest.
 *
 * Two things are being pinned here, and the second matters more than the first.
 *
 * `settle` confirms a date whose rule computed cleanly and a service selection
 * identical to last year's — the confirmations that were only ever clicks.
 *
 * What it must *not* touch is the real subject of this file. A conflict, a fee
 * awaiting a partner, an unanswered compilation question and a date the rule
 * could not compute are each a decision that ends up recorded against whoever
 * approves the letter. A future change that makes the automation "more
 * helpful" by relaxing one of those should fail here loudly.
 *
 * `check` turns the two comparison tabs into a pass or a fail. The
 * previous-year half is the one with teeth: a value that reaches a signed
 * letter *only* because last year's letter said so, with no current source and
 * nobody having read it, is how a stale client name goes out over the firm's
 * signature.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const service = new EngagementReadinessService({ prisma, audit });

const clientIds: string[] = [];
const userIds: string[] = [];
let nextTaxYear = 2500;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.engagement.deleteMany({
    where: { clientId: { in: clientIds } },
  });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

async function engagement(
  engagementType: 'T1_SINGLE' | 'T2' = 'T1_SINGLE',
  overrides: { compilationSelected?: boolean | null } = {},
): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const client = await prisma.client.create({
    data: { legalName: `Readiness Co ${suffix}`, isTestFixture: true },
  });
  clientIds.push(client.id);

  nextTaxYear += 1;
  const row = await prisma.engagement.create({
    data: {
      clientId: client.id,
      engagementType,
      taxYear: nextTaxYear,
      yearEnd: new Date(Date.UTC(nextTaxYear, 11, 31)),
      status: 'EXTRACTING_DATA',
      isTestMode: true,
      compilationSelected: overrides.compilationSelected ?? null,
    },
  });
  return row.id;
}

async function aReviewer(): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `readiness-${randomUUID().slice(0, 8)}@example.test`,
      displayName: 'A Reviewer',
      entraObjectId: randomUUID(),
    },
  });
  userIds.push(user.id);
  return user.id;
}

describe('settling the values the application has no doubt about', () => {
  it('confirms a date the rule computed cleanly, and records that no person read it', async () => {
    const engagementId = await engagement();
    await prisma.calculatedDate.create({
      data: {
        engagementId,
        token: 'FILING_DEADLINE',
        result: new Date(Date.UTC(nextTaxYear + 1, 5, 30)),
        ruleCode: 'T1_FILING',
        assumptions: ['Assumes no self-employment income.'],
      },
    });

    const result = await service.settle(engagementId);

    expect(result.datesConfirmed).toBe(1);
    expect(result.assumptions).toContain('Assumes no self-employment income.');

    const stored = await prisma.calculatedDate.findFirstOrThrow({
      where: { engagementId },
    });
    expect(stored.confirmedAt).not.toBeNull();

    // The whole point of the attribution. `confirmedByUserId` is a foreign key
    // to `user` and there is deliberately no `system` row to point at, so
    // writing one would be a constraint violation that fails invisibly. Its
    // absence is also the honest record: the application settled this, and
    // nobody has read it.
    expect(stored.confirmedByUserId).toBeNull();
  });

  it('leaves a blocked date alone, because the rule said it could not work one out', async () => {
    const engagementId = await engagement();
    await prisma.calculatedDate.create({
      data: {
        engagementId,
        token: 'YEAR_END',
        isBlocked: true,
        blockedReason: 'No year-end has been recorded for this client.',
      },
    });

    const result = await service.settle(engagementId);

    expect(result.datesConfirmed).toBe(0);
    const stored = await prisma.calculatedDate.findFirstOrThrow({
      where: { engagementId },
    });
    expect(stored.confirmedAt).toBeNull();
    expect(result.leftForAPerson.join(' ')).toMatch(/No year-end has been recorded/);
  });

  it('confirms a service selection identical to last year, and not one that differs', async () => {
    const engagementId = await engagement();
    await prisma.serviceSelection.createMany({
      data: [
        {
          engagementId,
          serviceCode: 't1.t2125',
          label: 'Business income',
          isSelected: true,
          priorYearSelected: true,
        },
        {
          engagementId,
          serviceCode: 't1.rental',
          label: 'Rental income',
          isSelected: true,
          priorYearSelected: false,
        },
        {
          engagementId,
          serviceCode: 't1.new',
          label: 'Something new',
          isSelected: true,
          priorYearSelected: null,
        },
      ],
    });

    const result = await service.settle(engagementId);

    expect(result.serviceSelectionsConfirmed).toBe(1);

    const rows = await prisma.serviceSelection.findMany({
      where: { engagementId },
      orderBy: { serviceCode: 'asc' },
    });
    const byCode = new Map(rows.map((row) => [row.serviceCode, row]));

    expect(byCode.get('t1.t2125')?.confirmed).toBe(true);
    expect(byCode.get('t1.t2125')?.confirmedByUserId).toBeNull();

    // Changed from last year: somebody decided this, or nobody has looked at
    // the default. Either way it is not the application's to confirm.
    expect(byCode.get('t1.rental')?.confirmed).toBe(false);

    // No prior year at all is not agreement with the prior year.
    expect(byCode.get('t1.new')?.confirmed).toBe(false);
  });
});

describe('what settling must never touch', () => {
  it('leaves an unresolved conflict for a person, and says so', async () => {
    const engagementId = await engagement();
    const field = await prisma.extractedField.create({
      data: {
        engagementId,
        token: 'CLIENT_LEGAL_NAME',
        value: 'Acme Holdings Ltd.',
        source: 'KARBON_CLIENT',
        extractionMethod: 'STRUCTURED_EXPORT',
      },
    });
    await prisma.fieldConflict.create({
      data: {
        engagementId,
        extractedFieldId: field.id,
        token: 'CLIENT_LEGAL_NAME',
        status: 'UNRESOLVED',
        candidates: [
          { value: 'Acme Holdings Ltd.', source: 'KARBON_CLIENT' },
          { value: 'Acme Holdings Inc.', source: 'PRIOR_YEAR_DOCUMENT' },
        ],
      },
    });

    const result = await service.settle(engagementId);

    const conflict = await prisma.fieldConflict.findFirstOrThrow({
      where: { engagementId },
    });
    expect(conflict.status).toBe('UNRESOLVED');
    expect(result.leftForAPerson.join(' ')).toMatch(/two sources disagree/i);
  });

  it('leaves a fee awaiting a partner, and a blocked fee, exactly as it found them', async () => {
    const engagementId = await engagement();
    await prisma.feeCalculation.createMany({
      data: [
        {
          engagementId,
          feeKind: 'T1_PREPARATION',
          method: 'PERCENTAGE',
          roundedFee: '1450',
          previousFee: '900',
          requiresApprovalType: 'FEE_HIGH_INCREASE',
        },
        {
          engagementId,
          feeKind: 'CSRS_4200_COMPILATION',
          method: 'NO_INCREASE',
          isBlocked: true,
          blockedReason: 'No prior-year fee and no rule matched.',
        },
      ],
    });

    const result = await service.settle(engagementId);

    const fees = await prisma.feeCalculation.findMany({
      where: { engagementId },
    });
    expect(fees.every((fee) => fee.approvedAt === null)).toBe(true);

    const left = result.leftForAPerson.join(' ');
    expect(left).toMatch(/partner/i);
    expect(left).toMatch(/could not be derived/i);
  });

  it('never answers the compilation question, because it decides what the firm is engaged to do', async () => {
    const engagementId = await engagement('T2', { compilationSelected: null });

    const result = await service.settle(engagementId);

    const stored = await prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId },
    });
    expect(stored.compilationSelected).toBeNull();
    expect(result.leftForAPerson.join(' ')).toMatch(/CSRS 4200/);
  });
});

describe('the previous-year comparison, computed', () => {
  it('fails when the only thing supplying a value is last year’s letter', async () => {
    const engagementId = await engagement();
    await prisma.extractedField.create({
      data: {
        engagementId,
        token: 'CLIENT_ADDRESS',
        value: '12 Old Street, Toronto',
        source: 'PRIOR_YEAR_DOCUMENT',
        extractionMethod: 'DETERMINISTIC_PATTERN',
      },
    });

    const report = await service.check(engagementId);
    const section = report.sections.find((row) => row.key === 'PREVIOUS_YEAR');

    expect(section?.ok).toBe(false);
    expect(section?.outstanding.join(' ')).toMatch(/only because last year/i);
    expect(report.ok).toBe(false);
  });

  it('passes once a current source corroborates the value', async () => {
    const engagementId = await engagement();
    await prisma.extractedField.createMany({
      data: [
        {
          engagementId,
          token: 'CLIENT_ADDRESS',
          value: '12 Old Street, Toronto',
          source: 'PRIOR_YEAR_DOCUMENT',
          extractionMethod: 'DETERMINISTIC_PATTERN',
        },
        {
          engagementId,
          token: 'CLIENT_ADDRESS',
          value: '12 Old Street, Toronto',
          source: 'KARBON_CLIENT',
          extractionMethod: 'STRUCTURED_EXPORT',
        },
      ],
    });

    const section = (await service.check(engagementId)).sections.find((row) => row.key === 'PREVIOUS_YEAR');

    expect(section?.ok).toBe(true);
    expect(section?.noted.join(' ')).toMatch(/carried forward/i);
  });

  it('passes, and reports both values, when a stronger source changed it', async () => {
    const engagementId = await engagement();
    await prisma.extractedField.createMany({
      data: [
        {
          engagementId,
          token: 'CLIENT_LEGAL_NAME',
          value: 'Acme Holdings Ltd.',
          source: 'PRIOR_YEAR_DOCUMENT',
          extractionMethod: 'DETERMINISTIC_PATTERN',
        },
        {
          engagementId,
          token: 'CLIENT_LEGAL_NAME',
          value: 'Acme Holdings Inc.',
          source: 'KARBON_CLIENT',
          extractionMethod: 'STRUCTURED_EXPORT',
        },
      ],
    });

    const section = (await service.check(engagementId)).sections.find((row) => row.key === 'PREVIOUS_YEAR');

    expect(section?.ok).toBe(true);
    // Both values, so a reviewer can see what moved rather than being told
    // only that something did.
    expect(section?.noted.join(' ')).toMatch(/Acme Holdings Ltd\./);
    expect(section?.noted.join(' ')).toMatch(/Acme Holdings Inc\./);
  });

  it('passes once a person has read and confirmed the carried-forward value', async () => {
    const engagementId = await engagement();
    const reviewer = await aReviewer();
    await prisma.extractedField.create({
      data: {
        engagementId,
        token: 'CLIENT_ADDRESS',
        value: '12 Old Street, Toronto',
        source: 'PRIOR_YEAR_DOCUMENT',
        extractionMethod: 'DETERMINISTIC_PATTERN',
        manuallyConfirmed: true,
        confirmedByUserId: reviewer,
        confirmedAt: new Date(),
      },
    });

    const section = (await service.check(engagementId)).sections.find((row) => row.key === 'PREVIOUS_YEAR');

    expect(section?.ok).toBe(true);
  });
});

describe('the master-template comparison, computed', () => {
  it('fails when the engagement is linked to a version that is no longer approved', async () => {
    const engagementId = await engagement();

    const template = await prisma.documentTemplate.findFirst({
      where: { documentType: 'T1_SINGLE_ENGAGEMENT_LETTER' },
      include: { versions: { where: { status: 'ACTIVE' }, take: 1 } },
    });

    // Only meaningful where the deployment actually has an approved template.
    // Reported rather than silently skipped, so a run against a bare database
    // does not look like a pass.
    if (!template?.versions[0]) {
      const section = (await service.check(engagementId)).sections.find((row) => row.key === 'MASTER_TEMPLATE');
      expect(section?.ok).toBe(false);
      expect(section?.outstanding.join(' ')).toMatch(/No approved template version is active/);
      return;
    }

    const retired = await prisma.templateVersion.create({
      data: {
        templateId: template.id,
        versionNumber: 9000 + Math.floor(Math.random() * 900),
        status: 'RETIRED',
        sourceFileHash: 'retired-hash',
        sourceFileName: 'old.docx',
        manifest: {},
      },
    });

    await prisma.engagement.update({
      where: { id: engagementId },
      data: { templateVersionId: retired.id },
    });

    const section = (await service.check(engagementId)).sections.find((row) => row.key === 'MASTER_TEMPLATE');

    expect(section?.ok).toBe(false);
    expect(section?.outstanding.join(' ')).toMatch(/no longer the approved one/i);

    await prisma.engagement.update({
      where: { id: engagementId },
      data: { templateVersionId: null },
    });
    await prisma.templateVersion.delete({ where: { id: retired.id } });
  });

  it('fails while a wording change is unapproved', async () => {
    const engagementId = await engagement();
    const author = await aReviewer();
    await prisma.wordingException.create({
      data: {
        engagementId,
        sectionAnchor: 'scope.3a',
        originalWording: 'The approved wording.',
        revisedWording: 'Something a partner has not seen.',
        reason: 'Client asked for it.',
        authorUserId: author,
      },
    });

    const section = (await service.check(engagementId)).sections.find((row) => row.key === 'MASTER_TEMPLATE');

    expect(section?.ok).toBe(false);
    expect(section?.outstanding.join(' ')).toMatch(/have not been approved/i);
  });

  it('fails when the rendered document did not pass its own validation', async () => {
    const engagementId = await engagement();
    await prisma.documentVersion.create({
      data: {
        engagementId,
        documentType: 'T1_SINGLE_ENGAGEMENT_LETTER',
        versionNumber: 1,
        validationReport: {
          errorCount: 2,
          errors: ['Highlighting remains.', 'Internal-only text remains.'],
        },
      },
    });

    const section = (await service.check(engagementId)).sections.find((row) => row.key === 'MASTER_TEMPLATE');

    expect(section?.ok).toBe(false);
    expect(section?.outstanding.join(' ')).toMatch(/failed 2 validation check/i);
  });
});

describe('the report as a whole', () => {
  it('counts what the application confirmed rather than a person', async () => {
    const engagementId = await engagement();
    await prisma.calculatedDate.create({
      data: {
        engagementId,
        token: 'FILING_DEADLINE',
        result: new Date(Date.UTC(nextTaxYear + 1, 5, 30)),
        ruleCode: 'T1_FILING',
      },
    });
    await prisma.serviceSelection.create({
      data: {
        engagementId,
        serviceCode: 't1.t2125',
        label: 'Business income',
        isSelected: true,
        priorYearSelected: true,
      },
    });

    await service.settle(engagementId);
    const report = await service.check(engagementId);

    expect(report.settledAutomatically).toBe(2);
  });

  it('names an outstanding item on the tab that fixes it', async () => {
    const engagementId = await engagement();
    await prisma.calculatedDate.create({
      data: {
        engagementId,
        token: 'YEAR_END',
        isBlocked: true,
        blockedReason: 'No year-end has been recorded for this client.',
      },
    });

    const report = await service.check(engagementId);
    const dates = report.sections.find((row) => row.key === 'DATES');

    expect(report.ok).toBe(false);
    expect(dates?.ok).toBe(false);
    expect(dates?.outstanding.join(' ')).toMatch(/No year-end has been recorded/);
  });
});

describe('a token carrying more than one conflict row', () => {
  /**
   * `reconcile` clears only UNRESOLVED conflicts when it re-runs, and Prepare
   * is documented as safe to re-run. So a token whose conflict a reviewer
   * resolved keeps that row and gains a fresh UNRESOLVED one on the next
   * Prepare — two rows, one token.
   *
   * `resolveFieldValue` applies a resolved conflict and ignores an unresolved
   * one, so which row the comparison reads decides the value. Without an
   * ordering it was whichever Postgres returned last, which meant the same
   * engagement could pass the readiness gate on one run and fail on the next
   * with nothing changed.
   */
  it('reads the resolved row, not whichever the database returned last', async () => {
    const engagementId = await engagement();

    await prisma.extractedField.createMany({
      data: [
        {
          engagementId,
          token: 'CLIENT_LEGAL_NAME',
          value: 'Acme Holdings Ltd.',
          source: 'PRIOR_YEAR_DOCUMENT',
          extractionMethod: 'DETERMINISTIC_PATTERN',
        },
        {
          engagementId,
          token: 'CLIENT_LEGAL_NAME',
          value: 'Acme Holdings Inc.',
          source: 'KARBON_CLIENT',
          extractionMethod: 'STRUCTURED_EXPORT',
        },
      ],
    });

    // The reviewer's decision, made first.
    await prisma.fieldConflict.create({
      data: {
        engagementId,
        token: 'CLIENT_LEGAL_NAME',
        status: 'RESOLVED',
        candidates: [],
        resolvedValue: 'Acme Holdings Ltd.',
        resolvedSource: 'PRIOR_YEAR_DOCUMENT',
        resolvedAt: new Date(),
      },
    });

    // A later Prepare raises the disagreement again without clearing the above.
    await prisma.fieldConflict.create({
      data: {
        engagementId,
        token: 'CLIENT_LEGAL_NAME',
        status: 'UNRESOLVED',
        candidates: [],
      },
    });

    // Run it several times: the fault was a nondeterministic read, so a single
    // pass could agree with the fix by luck.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const section = (await service.check(engagementId)).sections.find((row) => row.key === 'PREVIOUS_YEAR');

      // The reviewer chose the prior-year value, so it is carried forward
      // rather than reported as superseded by Karbon.
      expect(section?.noted.join(' ')).toMatch(/carried forward as "Acme Holdings Ltd\."/);
    }
  });
});
