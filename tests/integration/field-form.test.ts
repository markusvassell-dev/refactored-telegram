import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { libreOfficeConverter, parseManifest } from '@element/documents';
import { createLogger } from '@element/shared';
import { DocumentStore, FieldFormService, GenerationService, WorkflowService } from '@element/services';

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

// Generation is built here for one reason: to assert it and the form agree
// about what a token's value is. Sharing a resolver is only worth anything if
// something fails when they drift apart.
const generation = new GenerationService({
  prisma,
  audit,
  store: new DocumentStore({
    prisma,
    rootDirectory: '/tmp/element-engagements-tests/storage',
    retentionHours: 72,
    maxBytes: 25 * 1024 * 1024,
    signingSecret: 'test-signing-secret-test-signing-secret',
  }),
  pdfConverter: libreOfficeConverter({ tempDirectory: '/tmp' }),
  workflow: new WorkflowService(prisma, audit),
  logger: createLogger({ level: 'error' }),
  templateDirectory: `${process.cwd()}/templates/normalized`,
});

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

  /**
   * The bug this pins: read-only is not the same as absent.
   *
   * A deadline and a fee are decided elsewhere, so this form must not accept
   * one typed into it — which it always got right. But it also read values from
   * `extracted_field` alone, and fetched `calculated_date` selecting the token
   * and deliberately *not* the result. So the five T2 deadlines and the fee
   * were computed, stored, and printed on the letter while this screen reported
   * every one of them outstanding, and marked them read-only, so nobody could
   * supply what it claimed to be waiting for.
   */
  it('shows a calculated deadline’s value rather than reporting it outstanding', async () => {
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
    const field = findField(form, 'dates.filing_due');

    expect(field?.value).toBe(`${nextTaxYear}-09-30`);
    expect(field?.ownership).toBe('CALCULATED_DATE');
    expect(form.outstandingRequired).not.toContain('dates.filing_due');
  });

  it('prefers a reviewer’s override of a calculated deadline', async () => {
    const engagement = await newT2();

    await prisma.calculatedDate.create({
      data: {
        engagementId: engagement.id,
        token: 'dates.filing_due',
        result: new Date(Date.UTC(nextTaxYear, 8, 30)),
        manualOverride: new Date(Date.UTC(nextTaxYear, 9, 15)),
        overrideReason: 'Extension agreed with the client.',
        ruleCode: 't2.filing_deadline',
      },
    });

    const form = await fields.formFor(engagement.id);
    expect(findField(form, 'dates.filing_due')?.value).toBe(`${nextTaxYear}-10-15`);
  });

  it('shows a calculated fee’s value rather than reporting it outstanding', async () => {
    const engagement = await newT2();

    await prisma.feeCalculation.create({
      data: {
        engagementId: engagement.id,
        feeKind: 'T2_PREPARATION',
        method: 'PERCENTAGE',
        roundedFee: '1855.00',
      },
    });

    const form = await fields.formFor(engagement.id);
    const field = findField(form, 'pricing.t2_fee');

    expect(field?.value).toBe('1855');
    expect(field?.ownership).toBe('CALCULATED_FEE');
    expect(form.outstandingRequired).not.toContain('pricing.t2_fee');
  });

  it('still reports a deadline outstanding when the rule could not work one out', async () => {
    const engagement = await newT2();

    await prisma.calculatedDate.create({
      data: {
        engagementId: engagement.id,
        token: 'dates.filing_due',
        result: null,
        isBlocked: true,
        blockedReason: 'The year-end is not known yet.',
        ruleCode: 't2.filing_deadline',
      },
    });

    const form = await fields.formFor(engagement.id);
    expect(findField(form, 'dates.filing_due')?.value).toBeNull();
    expect(form.outstandingRequired).toContain('dates.filing_due');
  });

  /**
   * The guard against this happening again.
   *
   * Two readers of the same facts disagreeing is not a defect that gets fixed
   * once — it is a shape. The form and the document now resolve through one
   * function, and this fails the moment they stop.
   */
  it('agrees with generation about which tokens have a value', async () => {
    const engagement = await newT2(true);

    await prisma.calculatedDate.create({
      data: {
        engagementId: engagement.id,
        token: 'dates.filing_due',
        result: new Date(Date.UTC(nextTaxYear, 8, 30)),
        ruleCode: 't2.filing_deadline',
      },
    });
    await prisma.calculatedDate.create({
      data: {
        engagementId: engagement.id,
        token: 'dates.target_completion',
        result: new Date(Date.UTC(nextTaxYear, 7, 15)),
        ruleCode: 't2.target_completion_date',
      },
    });
    await prisma.feeCalculation.create({
      data: {
        engagementId: engagement.id,
        feeKind: 'T2_PREPARATION',
        method: 'PERCENTAGE',
        roundedFee: '1855.00',
      },
    });
    await fields.save({
      engagementId: engagement.id,
      actorId,
      values: { 'corporation.legal_name': 'Parity Holdings Ltd.' },
    });

    const form = await fields.formFor(engagement.id);
    const version = await prisma.templateVersion.findFirstOrThrow({
      where: { id: form.templateVersionId as string },
    });
    const built = await generation.buildValues(engagement.id, parseManifest(version.manifest));

    const populatedInForm = form.groups
      .flatMap((group) => group.fields)
      .filter((field) => field.value !== null && field.value !== '')
      .map((field) => field.token)
      .sort();

    const populatedInDocument = Object.entries(built.values)
      .filter(([, value]) => value !== '')
      .map(([token]) => token)
      .sort();

    expect(populatedInForm).toEqual(populatedInDocument);
  });

  /**
   * The one place they are allowed to differ, asserted so it stays the one
   * place. With compilation not selected the letter prints "Not applicable" in
   * the fee table rather than leaving a gap — a rendering decision, which is
   * why it lives in generation and not in the shared resolver.
   */
  it('differs from generation only over the unselected compilation fee', async () => {
    const engagement = await newT2(false);

    const form = await fields.formFor(engagement.id);
    const version = await prisma.templateVersion.findFirstOrThrow({
      where: { id: form.templateVersionId as string },
    });
    const built = await generation.buildValues(engagement.id, parseManifest(version.manifest));

    const inForm = new Set(
      form.groups
        .flatMap((group) => group.fields)
        .filter((field) => field.value !== null && field.value !== '')
        .map((field) => field.token),
    );
    const onlyInDocument = Object.entries(built.values)
      .filter(([token, value]) => value !== '' && !inForm.has(token))
      .map(([token]) => token);

    expect(onlyInDocument).toEqual(['pricing.compilation_fee']);
    expect(built.values['pricing.compilation_fee']).toBe('Not applicable');
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
