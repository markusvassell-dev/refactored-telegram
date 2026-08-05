import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { FieldFormService } from '@element/services';

/**
 * The structured field editor, against the real seeded templates.
 *
 * The form is generated from the approved template's own field definitions, so
 * these tests are really about three promises: a reviewer is shown every field
 * that template declares, is told which are mandatory *for this engagement*,
 * and cannot type into a value that something else decides.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const fields = new FieldFormService({ prisma, audit });

let clientId: string;
let actorId: string;
let nextTaxYear = 2800;

beforeAll(async () => {
  await prisma.$connect();

  const user = await prisma.user.upsert({
    where: { email: 'field-form-test@example.test' },
    create: { email: 'field-form-test@example.test', displayName: 'Field Form Test' },
    update: {},
  });
  actorId = user.id;

  const client = await prisma.client.create({
    data: { legalName: `Field Form Co ${randomUUID().slice(0, 8)}`, isTestFixture: true },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.$disconnect();
});

async function newT2(compilationSelected: boolean | null = null) {
  nextTaxYear += 1;
  return prisma.engagement.create({
    data: {
      clientId,
      engagementType: 'T2',
      taxYear: nextTaxYear,
      yearEnd: new Date(Date.UTC(nextTaxYear, 2, 31)),
      status: 'NOT_STARTED',
      compilationSelected,
      isTestMode: true,
    },
  });
}

function findField(form: Awaited<ReturnType<FieldFormService['formFor']>>, token: string) {
  return form.groups.flatMap((group) => group.fields).find((field) => field.token === token);
}

describe('building the form', () => {
  it('renders every field the approved template declares, labelled and typed', async () => {
    const engagement = await newT2();
    const form = await fields.formFor(engagement.id);

    expect(form.templateVersionId).not.toBeNull();
    expect(form.groups.length).toBeGreaterThan(0);

    const legalName = findField(form, 'corporation.legal_name');
    expect(legalName?.label).toBe('Corporation legal name');
    expect(legalName?.dataType).toBe('STRING');
    expect(legalName?.required).toBe(true);
    // The bracketed text in the letter, so a reviewer can match the two up.
    expect(legalName?.sourcePlaceholder).toBe('[LEGAL NAME OF CORPORATION]');

    const email = findField(form, 'signer.officer_email');
    expect(email?.dataType).toBe('EMAIL');
  });

  it('groups the fields and puts the client first', async () => {
    const engagement = await newT2();
    const form = await fields.formFor(engagement.id);

    expect(form.groups[0]?.key).toBe('CLIENT');
    expect(form.groups.map((group) => group.label)).toContain('Pricing and billing');
  });

  it('makes the compilation fields mandatory only when compilation is selected', async () => {
    const without = await fields.formFor((await newT2(false)).id);
    expect(findField(without, 'compilation.intended_use')?.required).toBe(false);
    expect(without.outstandingRequired).not.toContain('compilation.intended_use');

    const with4200 = await fields.formFor((await newT2(true)).id);
    expect(findField(with4200, 'compilation.intended_use')?.required).toBe(true);
    expect(with4200.outstandingRequired).toContain('compilation.intended_use');
  });

  it('lists what is still outstanding rather than leaving the reviewer to hunt', async () => {
    const engagement = await newT2(false);
    const form = await fields.formFor(engagement.id);

    expect(form.totalRequired).toBeGreaterThan(0);
    expect(form.outstandingRequired).toContain('corporation.legal_name');

    await fields.save({
      engagementId: engagement.id,
      actorId,
      values: { 'corporation.legal_name': 'Northwind Sample Holdings Ltd.' },
    });

    const after = await fields.formFor(engagement.id);
    expect(after.outstandingRequired).not.toContain('corporation.legal_name');
    expect(after.outstandingRequired.length).toBe(form.outstandingRequired.length - 1);
  });

  it('marks a field the system must never guess', async () => {
    const engagement = await prisma.engagement.create({
      data: {
        clientId,
        engagementType: 'T3',
        taxYear: (nextTaxYear += 1),
        yearEnd: new Date(Date.UTC(nextTaxYear, 11, 31)),
        status: 'NOT_STARTED',
        isTestMode: true,
      },
    });

    const form = await fields.formFor(engagement.id);
    const capacity = findField(form, 'representative.capacity');

    expect(capacity?.autoPopulatable).toBe(false);
    expect(capacity?.enumValues).toContain('Trustee');
    expect(capacity?.helpText).toContain('never assumed');
  });

  it('shows where a value came from, with its evidence', async () => {
    const engagement = await newT2();

    const field = await prisma.extractedField.create({
      data: {
        engagementId: engagement.id,
        token: 'corporation.legal_name',
        value: 'Northwind Sample Holdings Ltd.',
        source: 'PRIOR_YEAR_DOCUMENT',
        extractionMethod: 'DETERMINISTIC_PATTERN',
        confidence: 0.82,
      },
    });

    await prisma.fieldEvidence.create({
      data: { extractedFieldId: field.id, pageNumber: 1, supportingText: 'between Northwind Sample Holdings Ltd.' },
    });

    const form = await fields.formFor(engagement.id);
    const legalName = findField(form, 'corporation.legal_name');

    expect(legalName?.value).toBe('Northwind Sample Holdings Ltd.');
    expect(legalName?.valueSource).toBe('PRIOR_YEAR_DOCUMENT');
    expect(legalName?.valueBasis).toBe('HIGHEST_PRIORITY_SOURCE');
    expect(legalName?.confidence).toBeCloseTo(0.82);
    expect(legalName?.evidence[0]?.supportingText).toContain('Northwind');
  });

  it('flags a field whose sources still disagree', async () => {
    const engagement = await newT2();

    await prisma.fieldConflict.create({
      data: {
        engagementId: engagement.id,
        token: 'corporation.legal_name',
        candidates: [{ value: 'A Ltd.', source: 'KARBON_CLIENT' }],
        recommendedValue: 'A Ltd.',
        recommendedSource: 'KARBON_CLIENT',
        status: 'UNRESOLVED',
      },
    });

    const form = await fields.formFor(engagement.id);
    expect(findField(form, 'corporation.legal_name')?.conflictUnresolved).toBe(true);
  });
});

describe('values decided elsewhere', () => {
  it('shows a calculated deadline read-only and refuses to store one typed here', async () => {
    const engagement = await newT2();

    await prisma.calculatedDate.create({
      data: {
        engagementId: engagement.id,
        token: 'dates.filing_due',
        result: new Date(Date.UTC(nextTaxYear, 8, 30)),
        ruleCode: 't2.filing_deadline',
      },
    });

    const form = await fields.formFor(engagement.id);
    expect(findField(form, 'dates.filing_due')?.ownership).toBe('CALCULATED_DATE');

    const result = await fields.save({
      engagementId: engagement.id,
      actorId,
      values: { 'dates.filing_due': '2026-01-01' },
    });

    expect(result.saved).toHaveLength(0);
    expect(result.errors[0]?.message).toMatch(/Dates and Deadlines tab/);

    // Nothing was written, so generation still uses the calculated deadline.
    const stored = await prisma.extractedField.findFirst({
      where: { engagementId: engagement.id, token: 'dates.filing_due' },
    });
    expect(stored).toBeNull();
  });

  it('refuses a fee typed into the field editor', async () => {
    const engagement = await newT2();

    const form = await fields.formFor(engagement.id);
    expect(findField(form, 'pricing.t2_fee')?.ownership).toBe('CALCULATED_FEE');

    const result = await fields.save({
      engagementId: engagement.id,
      actorId,
      values: { 'pricing.t2_fee': '9999' },
    });

    expect(result.errors[0]?.message).toMatch(/Pricing tab/);
  });

  it('refuses a token the approved template does not declare', async () => {
    const engagement = await newT2();

    const result = await fields.save({
      engagementId: engagement.id,
      actorId,
      values: { 'made.up_token': 'anything' },
    });

    expect(result.saved).toHaveLength(0);
    expect(result.errors[0]?.message).toMatch(/not part of the approved template/);
  });
});

describe('saving', () => {
  it('stores a value, confirms it, and records the edit without copying the value into the audit trail', async () => {
    const engagement = await newT2();

    const result = await fields.save({
      engagementId: engagement.id,
      actorId,
      values: { 'corporation.legal_name': 'Northwind Sample Holdings Ltd.' },
    });

    expect(result.saved).toEqual(['corporation.legal_name']);

    const stored = await prisma.extractedField.findFirstOrThrow({
      where: { engagementId: engagement.id, token: 'corporation.legal_name', source: 'MANUAL_ENTRY' },
    });
    expect(stored.value).toBe('Northwind Sample Holdings Ltd.');
    expect(stored.manuallyConfirmed).toBe(true);
    expect(stored.confirmedByUserId).toBe(actorId);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { engagementId: engagement.id, eventType: 'FIELD_EDITED' },
    });
    // Which field, and that it now has a value — but never the value itself.
    expect(JSON.stringify(event.afterValue)).not.toContain('Northwind');
    expect(JSON.stringify(event.afterValue)).toContain('corporation.legal_name');
    expect(event.objectId).toContain('corporation.legal_name');
  });

  it('stores a typed value in its typed column as well as its text', async () => {
    const engagement = await newT2(true);

    await fields.save({
      engagementId: engagement.id,
      actorId,
      values: { 'compilation.report_date': '2026-09-15' },
    });

    const stored = await prisma.extractedField.findFirstOrThrow({
      where: { engagementId: engagement.id, token: 'compilation.report_date', source: 'MANUAL_ENTRY' },
    });

    expect(stored.value).toBe('2026-09-15');
    expect(stored.valueDate?.toISOString().slice(0, 10)).toBe('2026-09-15');
  });

  it('reports a bad value and stores none of the batch it belongs to', async () => {
    const engagement = await newT2();

    const result = await fields.save({
      engagementId: engagement.id,
      actorId,
      values: { 'corporation.legal_name': 'Good Value Ltd.', 'signer.officer_email': 'not-an-email' },
    });

    expect(result.saved).toEqual(['corporation.legal_name']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.token).toBe('signer.officer_email');

    // The invalid one is not stored — a wrong value is worse than a blank one.
    const email = await prisma.extractedField.findFirst({
      where: { engagementId: engagement.id, token: 'signer.officer_email' },
    });
    expect(email).toBeNull();
  });

  it('reports an unchanged value rather than rewriting it', async () => {
    const engagement = await newT2();
    const values = { 'corporation.legal_name': 'Same Value Ltd.' };

    await fields.save({ engagementId: engagement.id, actorId, values });
    const second = await fields.save({ engagementId: engagement.id, actorId, values });

    expect(second.saved).toHaveLength(0);
    expect(second.unchanged).toEqual(['corporation.legal_name']);

    expect(
      await prisma.auditEvent.count({ where: { engagementId: engagement.id, eventType: 'FIELD_EDITED' } }),
    ).toBe(1);
  });

  it('clears a value when the reviewer empties the box, rather than storing ""', async () => {
    const engagement = await newT2();

    await fields.save({
      engagementId: engagement.id,
      actorId,
      values: { 'corporation.legal_name': 'Will Be Cleared Ltd.' },
    });

    const result = await fields.save({
      engagementId: engagement.id,
      actorId,
      values: { 'corporation.legal_name': '  ' },
    });

    expect(result.cleared).toEqual(['corporation.legal_name']);

    const stored = await prisma.extractedField.findFirstOrThrow({
      where: { engagementId: engagement.id, token: 'corporation.legal_name', source: 'MANUAL_ENTRY' },
    });
    expect(stored.value).toBeNull();
    expect(stored.manuallyConfirmed).toBe(false);

    // And it counts as outstanding again.
    const form = await fields.formFor(engagement.id);
    expect(form.outstandingRequired).toContain('corporation.legal_name');
  });

  it('leaves a field alone when it was not submitted', async () => {
    const engagement = await newT2();

    await fields.save({
      engagementId: engagement.id,
      actorId,
      values: { 'corporation.legal_name': 'Untouched Ltd.' },
    });

    await fields.save({
      engagementId: engagement.id,
      actorId,
      values: { 'pricing.billing_basis': 'Fixed fee' },
    });

    const stored = await prisma.extractedField.findFirstOrThrow({
      where: { engagementId: engagement.id, token: 'corporation.legal_name', source: 'MANUAL_ENTRY' },
    });
    expect(stored.value).toBe('Untouched Ltd.');
  });

  it('shows a value the reviewer typed as theirs, overriding what Karbon said', async () => {
    const engagement = await newT2();

    await prisma.extractedField.create({
      data: {
        engagementId: engagement.id,
        token: 'corporation.legal_name',
        value: 'From Karbon Ltd.',
        source: 'KARBON_CLIENT',
        extractionMethod: 'STRUCTURED_EXPORT',
        confidence: 1,
      },
    });

    await fields.save({
      engagementId: engagement.id,
      actorId,
      values: { 'corporation.legal_name': 'Typed By Reviewer Ltd.' },
    });

    const form = await fields.formFor(engagement.id);
    const legalName = findField(form, 'corporation.legal_name');

    expect(legalName?.value).toBe('Typed By Reviewer Ltd.');
    expect(legalName?.valueBasis).toBe('MANUALLY_CONFIRMED');
  });
});
