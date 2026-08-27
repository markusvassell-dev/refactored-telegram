import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { putExtractedField } from '@element/services';

/**
 * The one writer of an engagement-level field value.
 *
 * These are about re-writing rather than writing, because there used to be two
 * writers and only one of them was safe to run twice — which did not matter
 * while extraction ran once per engagement, and matters as soon as a document
 * can be re-read.
 */

const prisma = new PrismaClient();

let clientId: string;
let nextTaxYear = 2900;

beforeAll(async () => {
  await prisma.$connect();
  const client = await prisma.client.create({
    data: { legalName: `Field Writer Co ${randomUUID().slice(0, 8)}`, isTestFixture: true },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.$disconnect();
});

async function newEngagement() {
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

describe('re-writing a field', () => {
  /**
   * The live bug. Every reader takes `valueDecimal ?? valueDate ?? value`, so a
   * typed column left behind on an update does not merely go stale — it keeps
   * winning over the corrected text beside it.
   */
  it('refreshes the typed date when a re-read corrects it', async () => {
    const engagement = await newEngagement();

    await putExtractedField(prisma, {
      engagementId: engagement.id,
      token: 'corporation.year_end',
      source: 'PRIOR_YEAR_DOCUMENT',
      method: 'DETERMINISTIC_PATTERN',
      value: 'March 31, 2025',
      valueDate: new Date('2025-03-31T00:00:00Z'),
    });

    await putExtractedField(prisma, {
      engagementId: engagement.id,
      token: 'corporation.year_end',
      source: 'PRIOR_YEAR_DOCUMENT',
      method: 'DETERMINISTIC_PATTERN',
      value: 'December 31, 2025',
      valueDate: new Date('2025-12-31T00:00:00Z'),
    });

    const stored = await prisma.extractedField.findFirstOrThrow({
      where: { engagementId: engagement.id, token: 'corporation.year_end' },
    });

    expect(stored.value).toBe('December 31, 2025');
    expect(stored.valueDate?.toISOString().slice(0, 10)).toBe('2025-12-31');
  });

  it('refreshes the extraction method when a different reader supplies the value', async () => {
    const engagement = await newEngagement();

    await putExtractedField(prisma, {
      engagementId: engagement.id,
      token: 'corporation.legal_name',
      source: 'PRIOR_YEAR_DOCUMENT',
      method: 'DETERMINISTIC_PATTERN',
      value: 'Northwind Holdings Ltd.',
    });

    await putExtractedField(prisma, {
      engagementId: engagement.id,
      token: 'corporation.legal_name',
      source: 'PRIOR_YEAR_DOCUMENT',
      method: 'PDF_TEXT',
      value: 'Northwind Holdings Ltd.',
    });

    const stored = await prisma.extractedField.findFirstOrThrow({
      where: { engagementId: engagement.id, token: 'corporation.legal_name' },
    });
    expect(stored.extractionMethod).toBe('PDF_TEXT');
  });

  it('clears a typed date the new reading did not find', async () => {
    const engagement = await newEngagement();

    await putExtractedField(prisma, {
      engagementId: engagement.id,
      token: 'corporation.year_end',
      source: 'PRIOR_YEAR_DOCUMENT',
      method: 'DETERMINISTIC_PATTERN',
      value: 'March 31, 2025',
      valueDate: new Date('2025-03-31T00:00:00Z'),
    });

    await putExtractedField(prisma, {
      engagementId: engagement.id,
      token: 'corporation.year_end',
      source: 'PRIOR_YEAR_DOCUMENT',
      method: 'DETERMINISTIC_PATTERN',
      value: 'the last day of March',
    });

    const stored = await prisma.extractedField.findFirstOrThrow({
      where: { engagementId: engagement.id, token: 'corporation.year_end' },
    });
    expect(stored.valueDate).toBeNull();
  });

  /**
   * A guard rather than a fix for anything reachable today: nothing currently
   * confirms a row of any source but `MANUAL_ENTRY`, which lives in its own row
   * and wins through `resolveFieldValue` regardless. It is asserted because the
   * invariant is one this codebase already states for the Karbon path, and
   * because confirming an extracted value in place is the obvious next thing to
   * want once a scan can be re-run.
   */
  it('leaves a confirmed value alone rather than rewriting it', async () => {
    const engagement = await newEngagement();

    const { field } = await putExtractedField(prisma, {
      engagementId: engagement.id,
      token: 'signer.officer_name',
      source: 'PRIOR_YEAR_DOCUMENT',
      method: 'DETERMINISTIC_PATTERN',
      value: 'Dana Whitfield',
    });

    await prisma.extractedField.update({
      where: { id: field.id },
      data: { manuallyConfirmed: true, confirmedAt: new Date() },
    });

    const result = await putExtractedField(prisma, {
      engagementId: engagement.id,
      token: 'signer.officer_name',
      source: 'PRIOR_YEAR_DOCUMENT',
      method: 'DETERMINISTIC_PATTERN',
      value: 'D. Whitfield',
    });

    expect(result.written).toBe(false);

    const stored = await prisma.extractedField.findFirstOrThrow({ where: { id: field.id } });
    expect(stored.value).toBe('Dana Whitfield');
  });

  it('keeps a cover-letter package’s value separate from the engagement’s', async () => {
    const engagement = await newEngagement();

    const pkg = await prisma.coverLetterPackage.create({
      data: {
        engagementId: engagement.id,
        documentType: 'T2_COVER_LETTER',
        idempotencyKey: `cover_${engagement.id}`,
      },
    });

    await putExtractedField(prisma, {
      engagementId: engagement.id,
      token: 'corporation.legal_name',
      source: 'PRIOR_YEAR_DOCUMENT',
      method: 'DETERMINISTIC_PATTERN',
      value: 'On the engagement',
    });

    await putExtractedField(prisma, {
      engagementId: engagement.id,
      coverLetterPackageId: pkg.id,
      token: 'corporation.legal_name',
      source: 'PRIOR_YEAR_DOCUMENT',
      method: 'DETERMINISTIC_PATTERN',
      value: 'On the package',
    });

    const rows = await prisma.extractedField.findMany({
      where: { engagementId: engagement.id, token: 'corporation.legal_name' },
      orderBy: { value: 'asc' },
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.value)).toEqual(['On the engagement', 'On the package']);
  });
});
