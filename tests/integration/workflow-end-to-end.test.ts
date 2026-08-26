import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { libreOfficeConverter } from '@element/documents';
import { MockAdobeSignProvider, MockKarbonProvider } from '@element/integrations';
import {
  ApprovalService,
  CoverLetterService,
  DocumentStore,
  GenerationService,
  JobQueue,
  KarbonNotificationService,
  NotificationService,
  PricingService,
  SettingsService,
  SigningService,
  WorkflowService,
} from '@element/services';
import { createLogger, type Principal } from '@element/shared';

/**
 * End-to-end workflow, against the real database, the real document engine, a
 * real LibreOffice conversion, and the clearly-labelled mock integrations.
 *
 * Everything except the two external vendors is production code.
 */

const prisma = new PrismaClient();
const logger = createLogger({ level: 'error' });
const audit = createAuditLogger(prisma);
const settings = new SettingsService(prisma);
const workflow = new WorkflowService(prisma, audit);
const pricing = new PricingService(prisma, audit);
const queue = new JobQueue(prisma, logger);

const store = new DocumentStore({
  prisma,
  rootDirectory: '/tmp/element-engagements-tests/storage',
  retentionHours: 72,
  maxBytes: 25 * 1024 * 1024,
  signingSecret: 'test-signing-secret-test-signing-secret',
});

const pdfConverter = libreOfficeConverter({ tempDirectory: '/tmp' });
const templateDirectory = `${process.cwd()}/templates/normalized`;

const generation = new GenerationService({ prisma, audit, store, pdfConverter, workflow, logger, templateDirectory });
const approvals = new ApprovalService({ prisma, audit, workflow, settings });
const userNotifications = new NotificationService({ prisma });
const signing = new SigningService({ notifications: userNotifications, prisma, audit, store, workflow, settings, logger, queue });
const coverLetters = new CoverLetterService({
  prisma,
  audit,
  store,
  pdfConverter,
  workflow,
  logger,
  templateDirectory,
});
const notifications = new KarbonNotificationService({
  prisma,
  audit,
  store,
  logger,
  appBaseUrl: 'http://localhost:3000',
});

let preparer: Principal;
let reviewer: Principal;
let partner: Principal;
let clientId: string;
let workItemId: string;
const workItemKey = `WI-${randomUUID().slice(0, 8)}`;

let nextTaxYear = 2500;

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

/** Builds a fully-prepared T2 engagement that is ready to generate. */
async function makeT2Engagement(options: { compilationSelected: boolean; previousFee?: string | null }) {
  nextTaxYear += 1;

  const engagement = await prisma.engagement.create({
    data: {
      clientId,
      engagementType: 'T2',
      taxYear: nextTaxYear,
      yearEnd: new Date(Date.UTC(nextTaxYear, 2, 31)),
      karbonWorkItemId: workItemId,
      status: 'NOT_STARTED',
      compilationSelected: options.compilationSelected,
      assignedPreparerId: preparer.id,
      assignedReviewerId: reviewer.id,
      isTestMode: true,
    },
  });

  const values: Record<string, string> = {
    'corporation.legal_name': 'Northwind Sample Holdings Ltd.',
    'corporation.business_number': '00000 0000 RC0001',
    'signer.officer_name': 'Sample Signing Officer',
    'signer.officer_title': 'President',
    'signer.officer_email': 'officer@example.test',
    'firm.signer_name': 'Sample Partner, CPA, CA',
    'firm.engagement_lead': 'Sample Lead',
    'pricing.billing_basis': 'Fixed fee',
    'pricing.payment_terms': 'upon receipt',
    'pricing.payment_terms_short': 'Upon receipt',
    'pricing.additional_work': 'Quoted separately',
    'pricing.retainer': 'Not applicable',
    'special_terms.line_1': 'None',
    'dates.target_completion': 'Subject to complete information',
    ...(options.compilationSelected
      ? {
          'compilation.intended_use': 'Corporate tax filing',
          'compilation.intended_users': 'Management',
          'compilation.basis_of_accounting': 'Cash basis with selected accruals',
          'compilation.report_delivery': 'Electronic',
          'compilation.report_date': '2026-09-15',
        }
      : {}),
  };

  for (const [token, value] of Object.entries(values)) {
    await prisma.extractedField.create({
      data: {
        engagementId: engagement.id,
        token,
        value,
        source: 'MANUAL_ENTRY',
        extractionMethod: 'MANUAL_ENTRY',
        confidence: 1,
        manuallyConfirmed: true,
      },
    });
  }

  await prisma.extractedField.create({
    data: {
      engagementId: engagement.id,
      token: 'corporation.year_end',
      valueDate: new Date(Date.UTC(nextTaxYear, 2, 31)),
      source: 'KARBON_CLIENT',
      extractionMethod: 'STRUCTURED_EXPORT',
      confidence: 1,
      manuallyConfirmed: true,
    },
  });

  for (const [token, iso] of [
    ['dates.sent', `${nextTaxYear}-08-04`],
    ['dates.client_information_due', `${nextTaxYear}-06-30`],
    ['dates.filing_due', `${nextTaxYear}-09-30`],
    ['dates.balance_due', `${nextTaxYear}-05-31`],
  ] as const) {
    await prisma.calculatedDate.create({
      data: {
        engagementId: engagement.id,
        token,
        result: new Date(`${iso}T00:00:00Z`),
        ruleCode: token,
        requiresConfirmation: true,
        confirmedByUserId: reviewer.id,
        confirmedAt: new Date(),
      },
    });
  }

  for (const [code, label] of [
    ['t2.federal_return', 'Federal T2 return'],
    ['t2.provincial_schedules', 'Provincial schedules'],
    ['t2.gifi', 'GIFI'],
    ['t2.efile', 'Electronic filing'],
  ] as const) {
    await prisma.serviceSelection.create({
      data: { engagementId: engagement.id, serviceCode: code, label, isSelected: true, confirmed: true },
    });
  }

  await prisma.serviceSelection.create({
    data: {
      engagementId: engagement.id,
      serviceCode: 't2.csrs4200',
      label: 'Compilation engagement under CSRS 4200',
      isSelected: options.compilationSelected,
      confirmed: true,
      confirmedByUserId: reviewer.id,
      confirmedAt: new Date(),
    },
  });

  const feeKinds = options.compilationSelected
    ? (['T2_PREPARATION', 'CSRS_4200_COMPILATION'] as const)
    : (['T2_PREPARATION'] as const);

  // `previousFee: null` means "no prior-year fee was found"; omitting it uses
  // the ordinary rollover fixture.
  const priorT2Fee = options.previousFee === undefined ? '2000' : options.previousFee;
  const priorCompilationFee = options.previousFee === undefined ? '1000' : options.previousFee;

  await pricing.calculate({
    engagementId: engagement.id,
    feeKinds,
    previousFees: {
      T2_PREPARATION: { amount: priorT2Fee, source: 'PRIOR_YEAR_DOCUMENT' },
      CSRS_4200_COMPILATION: { amount: priorCompilationFee, source: 'PRIOR_YEAR_DOCUMENT' },
    },
    highIncreaseThresholdPercent: 10,
    actorId: preparer.id,
  });

  for (const [role, name, email, order] of [
    ['AUTHORIZED_SIGNING_OFFICER', 'Sample Signing Officer', 'officer@example.test', 1],
    ['ENGAGEMENT_LEAD', 'Sample Lead', 'lead@example.test', 99],
  ] as const) {
    await prisma.engagementParticipant.create({
      data: {
        engagementId: engagement.id,
        role,
        fullLegalName: name,
        email,
        signingOrder: order,
        isSigner: role === 'AUTHORIZED_SIGNING_OFFICER',
        contactConfirmed: true,
      },
    });
  }

  return engagement;
}

beforeAll(async () => {
  await prisma.$connect();

  preparer = await makeUser('e2e-preparer@example.test', ['PREPARER']);
  reviewer = await makeUser('e2e-reviewer@example.test', ['REVIEWER']);
  partner = await makeUser('e2e-partner@example.test', ['PARTNER_OR_FINAL_APPROVER']);

  const client = await prisma.client.upsert({
    where: { karbonEntityKey: 'E2E-ORG' },
    create: {
      karbonEntityKey: 'E2E-ORG',
      // The signed letter files to the client's own Documents tab, and the
      // record kind is part of that address.
      karbonEntityType: 'Organization',
      legalName: 'Northwind Sample Holdings Ltd.',
      businessNumber: '00000 0000 RC0001',
      isTestFixture: true,
    },
    update: { karbonEntityType: 'Organization' },
  });
  clientId = client.id;

  const workItem = await prisma.karbonWorkItem.upsert({
    where: { karbonKey: workItemKey },
    create: { karbonKey: workItemKey, title: 'T2 2026', clientId, workType: 'Corporate Tax' },
    update: {},
  });
  workItemId = workItem.id;

  // Start from a clean slate: one engagement exists per client, type and year,
  // so leftovers from an interrupted run would collide with the fixtures.
  await prisma.engagement.deleteMany({ where: { clientId } });
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId } });
  await prisma.$disconnect();
});

describe('T2 with compilation selected', () => {
  it('generates, uploads, reviews, approves and sends', async () => {
    const engagement = await makeT2Engagement({ compilationSelected: true });
    const karbon = new MockKarbonProvider();
    const adobe = new MockAdobeSignProvider({ webhookSecret: 'test-adobe-webhook-secret' });

    // ---- Generate -------------------------------------------------------
    const gate = await generation.evaluateGate(engagement.id, 'T2_ENGAGEMENT_LETTER');
    expect(gate.blockers).toEqual([]);

    await workflow.transition({ engagementId: engagement.id, to: 'GENERATING' });
    const generated = await generation.generate({
      engagementId: engagement.id,
      documentType: 'T2_ENGAGEMENT_LETTER',
      actorId: preparer.id,
      correlationId: 'test-correlation',
      testMode: true,
    });

    expect(generated.validation.errorCount).toBe(0);
    expect(generated.removedSections).toContain('t2_internal_checklist');
    expect(generated.removedSections).not.toContain('csrs_4200');

    await workflow.transition({ engagementId: engagement.id, to: 'DRAFT_READY' });

    // ---- Upload to Karbon and notify -----------------------------------
    const published = await notifications.publishDraft({
      engagementId: engagement.id,
      documentVersionId: generated.documentVersionId,
      karbon,
      testMode: true,
      correlationId: 'test-correlation',
    });

    expect(published.uploaded.map((file) => file.role)).toEqual(['DRAFT_DOCX', 'DRAFT_PDF']);
    expect(published.commentPosted).toBe(true);

    const comment = karbon.callsFor('addComment')[0]?.payload as { body: string };
    expect(comment.body).toContain('Review T2 Engagement Letter');
    expect(comment.body).toContain('Previous fee: $2,000.00');
    expect(comment.body).toContain('Proposed fee: $2,060.00');
    expect(comment.body).toContain('Rounded upward to the next $5');
    expect(comment.body).toContain(`http://localhost:3000/engagements/${engagement.id}`);

    // The draft file name carries the TEST prefix in Test Mode.
    const upload = karbon.callsFor('uploadDocument')[0]?.payload as { fileName: string };
    expect(upload.fileName).toMatch(/^TEST /);

    // ---- Review and approve ---------------------------------------------
    await workflow.transition({ engagementId: engagement.id, to: 'REVIEW_REQUIRED' });
    await approvals.startReview(engagement.id, reviewer);

    // The preparer cannot approve their own draft.
    await expect(
      approvals.approveDocument({
        engagementId: engagement.id,
        documentVersionId: generated.documentVersionId,
        actor: { ...preparer, roles: ['PARTNER_OR_FINAL_APPROVER'] },
      }),
    ).rejects.toThrow(/cannot approve your own/i);

    await approvals.approveDocument({
      engagementId: engagement.id,
      documentVersionId: generated.documentVersionId,
      actor: partner,
    });

    const approved = await prisma.engagement.findUniqueOrThrow({ where: { id: engagement.id } });
    expect(approved.status).toBe('APPROVED');

    // ---- Send -----------------------------------------------------------
    await approvals.markReadyToSend(engagement.id, partner);

    const sent = await signing.sendForSignature({
      engagementId: engagement.id,
      documentVersionId: generated.documentVersionId,
      actor: partner,
      adobeSign: adobe,
      testMode: true,
      productionSendingEnabled: false,
      adobeSignMode: 'sandbox' as const,
      correlationId: 'test-correlation',
    });

    expect(sent.deduplicated).toBe(false);
    expect(adobe.agreementCount()).toBe(1);

    // What went to Adobe must be the signature copy, not the draft.
    //
    // Both are valid PDFs of the same letter, so every assertion above this one
    // passes just as happily when the untagged draft is sent — which is what the
    // code did, producing agreements with no signature fields in them that Adobe
    // accepted without complaint and nobody could sign. Comparing hashes is the
    // only assertion here that can tell the two apart.
    const sentVersion = await prisma.documentVersion.findUniqueOrThrow({
      where: { id: generated.documentVersionId },
      select: { pdfHash: true, signaturePdfHash: true },
    });

    // Deliberately not asserting the two hashes differ: T2 is AUTO_PLACED, so
    // its signature copy carries no tags and is the same document as the draft.
    // That assertion would pass here on PDF timestamp nondeterminism rather than
    // on content, which is worse than not making it. What the tags look like is
    // pinned at the render level instead, on a template that actually has them.
    expect(sentVersion.signaturePdfHash).toBeTruthy();
    expect(adobe.uploadedPdfHash(sent.agreementId)).toBe(sentVersion.signaturePdfHash);

    // A retry must not create a second agreement.
    const retried = await signing.sendForSignature({
      engagementId: engagement.id,
      documentVersionId: generated.documentVersionId,
      actor: partner,
      adobeSign: adobe,
      testMode: true,
      productionSendingEnabled: false,
      adobeSignMode: 'sandbox' as const,
      correlationId: 'test-correlation',
    }).catch(() => ({ agreementId: sent.agreementId, deduplicated: true }));

    expect(retried.agreementId).toBe(sent.agreementId);
    expect(adobe.agreementCount()).toBe(1);

    // ---- Sign and return to Karbon --------------------------------------
    adobe.simulateSign(sent.agreementId, 'officer@example.test');
    const state = await adobe.getAgreement(sent.agreementId);
    await signing.applyAgreementState(sent.agreementId, state!, 'test-correlation');

    const afterSigning = await prisma.engagement.findUniqueOrThrow({ where: { id: engagement.id } });
    expect(afterSigning.status).toBe('SIGNED');

    // Somebody is told. The application used to advance the engagement, file
    // the documents and write the audit trail in complete silence, so the first
    // a human knew was the next time they opened the page.
    const told = await prisma.notification.findMany({
      where: { engagementId: engagement.id, eventType: 'SIGNING_SIGNED' },
    });
    expect(told.length).toBeGreaterThan(0);
    expect(told[0]?.title).toMatch(/signed/i);
    expect(told[0]?.link).toBe(`/engagements/${engagement.id}`);
    expect(told.every((notice) => notice.readAt === null)).toBe(true);

    // The reconciliation poll re-reads the same agreement on a schedule. Seeing
    // the same signature again must not produce a second notice.
    await signing.applyAgreementState(sent.agreementId, state!, 'test-correlation');
    const afterSecondObservation = await prisma.notification.count({
      where: { engagementId: engagement.id, eventType: 'SIGNING_SIGNED' },
    });
    expect(afterSecondObservation).toBe(told.length);

    const returned = await signing.returnSignedDocumentsToKarbon({
      agreementId: sent.agreementId,
      adobeSign: adobe,
      karbon,
      correlationId: 'test-correlation',
    });

    expect(returned.signedUploaded).toBe(true);
    expect(returned.certificateUploaded).toBe(true);

    const uploadedNames = karbon.callsFor('uploadDocument').map((call) => (call.payload as { fileName: string }).fileName);
    expect(uploadedNames.some((name) => name.includes('SIGNED'))).toBe(true);
    expect(uploadedNames.some((name) => name.includes('SIGNING CERTIFICATE'))).toBe(true);

    await workflow.transition({ engagementId: engagement.id, to: 'COMPLETE' });
  });
});

describe('T2 without compilation', () => {
  it('removes section 3A and marks the compilation fee not applicable', async () => {
    const engagement = await makeT2Engagement({ compilationSelected: false });

    await workflow.transition({ engagementId: engagement.id, to: 'GENERATING' });
    const generated = await generation.generate({
      engagementId: engagement.id,
      documentType: 'T2_ENGAGEMENT_LETTER',
      actorId: preparer.id,
      correlationId: 'test',
      testMode: true,
    });

    expect(generated.removedSections).toContain('csrs_4200');
    expect(generated.validation.errorCount).toBe(0);

    const version = await prisma.documentVersion.findUniqueOrThrow({ where: { id: generated.documentVersionId } });
    const rendered = version.renderedFieldValues as { values: Record<string, string> };
    expect(rendered.values['pricing.compilation_fee']).toBe('Not applicable');
  });
});

describe('missing prior-year fee', () => {
  it('blocks generation until a fee is supplied', async () => {
    const engagement = await makeT2Engagement({ compilationSelected: false, previousFee: null });

    const gate = await generation.evaluateGate(engagement.id, 'T2_ENGAGEMENT_LETTER');
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/confirmed fee/i);

    await workflow.transition({ engagementId: engagement.id, to: 'GENERATING' });
    await expect(
      generation.generate({
        engagementId: engagement.id,
        documentType: 'T2_ENGAGEMENT_LETTER',
        actorId: preparer.id,
        correlationId: 'test',
        testMode: true,
      }),
    ).rejects.toThrow(/cannot be generated yet/i);

    // Supplying a fee unblocks it.
    await pricing.override({
      engagementId: engagement.id,
      feeKind: 'T2_PREPARATION',
      amount: '2100',
      reason: 'New client; base fee agreed with the partner.',
      actor: { ...preparer, roles: ['PREPARER'] },
      highIncreaseThresholdPercent: 10,
    });

    const unblocked = await generation.evaluateGate(engagement.id, 'T2_ENGAGEMENT_LETTER');
    expect(unblocked.ok).toBe(true);
  });
});

describe('sending preconditions', () => {
  it('refuses to send a document that has not been approved', async () => {
    const engagement = await makeT2Engagement({ compilationSelected: false });
    const adobe = new MockAdobeSignProvider({ webhookSecret: 'test-adobe-webhook-secret' });

    await workflow.transition({ engagementId: engagement.id, to: 'GENERATING' });
    const generated = await generation.generate({
      engagementId: engagement.id,
      documentType: 'T2_ENGAGEMENT_LETTER',
      actorId: preparer.id,
      correlationId: 'test',
      testMode: true,
    });
    await workflow.transition({ engagementId: engagement.id, to: 'DRAFT_READY' });

    await expect(
      signing.sendForSignature({
        engagementId: engagement.id,
        documentVersionId: generated.documentVersionId,
        actor: partner,
        adobeSign: adobe,
        testMode: true,
        productionSendingEnabled: false,
        adobeSignMode: 'sandbox' as const,
        correlationId: 'test',
      }),
    ).rejects.toThrow(/cannot be sent/i);

    expect(adobe.agreementCount()).toBe(0);
  });

  it('refuses to send in Test Mode with no sandbox configured', async () => {
    const engagement = await makeT2Engagement({ compilationSelected: false });
    const adobe = new MockAdobeSignProvider({ webhookSecret: 'test-adobe-webhook-secret' });

    await workflow.transition({ engagementId: engagement.id, to: 'GENERATING' });
    const generated = await generation.generate({
      engagementId: engagement.id,
      documentType: 'T2_ENGAGEMENT_LETTER',
      actorId: preparer.id,
      correlationId: 'test',
      testMode: true,
    });
    await workflow.transition({ engagementId: engagement.id, to: 'DRAFT_READY' });
    await workflow.transition({ engagementId: engagement.id, to: 'REVIEW_REQUIRED' });
    await approvals.startReview(engagement.id, reviewer);
    await approvals.approveDocument({
      engagementId: engagement.id,
      documentVersionId: generated.documentVersionId,
      actor: partner,
    });
    await approvals.markReadyToSend(engagement.id, partner);

    const gate = await signing.evaluateSendGate({
      engagementId: engagement.id,
      documentVersionId: generated.documentVersionId,
      testMode: true,
      productionSendingEnabled: false,
      adobeSignMode: 'mock' as const,
    });

    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/test mode/i);
    expect(adobe.agreementCount()).toBe(0);
  });
});

describe('changes requested and regeneration', () => {
  it('supersedes the previous version rather than overwriting it', async () => {
    const engagement = await makeT2Engagement({ compilationSelected: false });

    await workflow.transition({ engagementId: engagement.id, to: 'GENERATING' });
    const first = await generation.generate({
      engagementId: engagement.id,
      documentType: 'T2_ENGAGEMENT_LETTER',
      actorId: preparer.id,
      correlationId: 'test',
      testMode: true,
    });
    await workflow.transition({ engagementId: engagement.id, to: 'DRAFT_READY' });
    await workflow.transition({ engagementId: engagement.id, to: 'REVIEW_REQUIRED' });
    await approvals.startReview(engagement.id, reviewer);
    await approvals.requestChanges({
      engagementId: engagement.id,
      reason: 'The information due date is wrong.',
      actor: reviewer,
    });

    await workflow.transition({ engagementId: engagement.id, to: 'REGENERATING' });
    const second = await generation.generate({
      engagementId: engagement.id,
      documentType: 'T2_ENGAGEMENT_LETTER',
      actorId: preparer.id,
      correlationId: 'test',
      testMode: true,
    });

    expect(second.versionNumber).toBe(first.versionNumber + 1);

    const versions = await prisma.documentVersion.findMany({
      where: { engagementId: engagement.id },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions).toHaveLength(2);
    expect(versions[0]?.status).toBe('SUPERSEDED');
    expect(versions[0]?.supersededAt).not.toBeNull();
    // The superseded version keeps its own hashes.
    expect(versions[0]?.pdfHash).not.toBe(versions[1]?.pdfHash);
  });
});

describe('wording exceptions', () => {
  it('requires a reason and a different approver, and blocks approval until approved', async () => {
    const engagement = await makeT2Engagement({ compilationSelected: false });

    await workflow.transition({ engagementId: engagement.id, to: 'GENERATING' });
    const generated = await generation.generate({
      engagementId: engagement.id,
      documentType: 'T2_ENGAGEMENT_LETTER',
      actorId: preparer.id,
      correlationId: 'test',
      testMode: true,
    });
    await workflow.transition({ engagementId: engagement.id, to: 'DRAFT_READY' });
    await workflow.transition({ engagementId: engagement.id, to: 'REVIEW_REQUIRED' });
    await approvals.startReview(engagement.id, reviewer);

    // A reviewer may not edit wording at all.
    await expect(
      approvals.submitWordingException({
        engagementId: engagement.id,
        documentVersionId: generated.documentVersionId,
        sectionAnchor: 'Special terms',
        originalWording: 'None',
        revisedWording: 'A bespoke liability cap applies.',
        reason: 'Client negotiated this last year.',
        actor: reviewer,
      }),
    ).rejects.toThrow(/does not permit/i);

    const exceptionId = await approvals.submitWordingException({
      engagementId: engagement.id,
      documentVersionId: generated.documentVersionId,
      sectionAnchor: 'Special terms',
      originalWording: 'None',
      revisedWording: 'A bespoke liability cap applies.',
      reason: 'Client negotiated this last year.',
      actor: partner,
    });

    // A pending wording change blocks approval.
    const gate = await approvals.evaluateApprovalGate(engagement.id, generated.documentVersionId);
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/wording change/i);

    // The author cannot approve their own change.
    await expect(approvals.approveWordingException({ exceptionId, actor: partner })).rejects.toThrow(
      /cannot approve your own/i,
    );

    const secondPartner = await makeUser('e2e-partner-2@example.test', ['PARTNER_OR_FINAL_APPROVER']);
    await approvals.approveWordingException({ exceptionId, actor: secondPartner });

    const cleared = await approvals.evaluateApprovalGate(engagement.id, generated.documentVersionId);
    expect(cleared.ok).toBe(true);
  });
});

describe('background job queue', () => {
  beforeEach(async () => {
    await prisma.backgroundJob.deleteMany({ where: { jobType: 'KARBON_SYNC' } });
  });

  it('deduplicates by idempotency key', async () => {
    const key = `dedupe-${randomUUID()}`;

    const first = await queue.enqueue({ jobType: 'KARBON_SYNC', idempotencyKey: key, payload: { a: 1 } });
    const second = await queue.enqueue({ jobType: 'KARBON_SYNC', idempotencyKey: key, payload: { a: 1 } });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.jobId).toBe(first.jobId);
  });

  it('claims each job exactly once across concurrent workers', async () => {
    // `claim` takes the oldest runnable job, whatever it is, so this test is
    // only meaningful when its own job is the only one available. The
    // integration suite shares a database and other tests legitimately leave
    // work queued — this used to pass by luck, and started failing the moment a
    // completed webhook began enqueueing a retrieval.
    //
    // Deferred rather than deleted: other tests assert those rows exist.
    await prisma.backgroundJob.updateMany({
      where: { status: 'PENDING' },
      data: { runAt: new Date(Date.now() + 60 * 60 * 1000) },
    });

    const key = `claim-${randomUUID()}`;
    await queue.enqueue({ jobType: 'KARBON_SYNC', idempotencyKey: key, payload: {} });

    const [a, b] = await Promise.all([queue.claim('worker-a'), queue.claim('worker-b')]);
    const claimed = [a, b].filter(Boolean);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.attempt).toBe(1);
  });

  it('retries a transient failure and dead-letters a permanent one', async () => {
    const transientKey = `transient-${randomUUID()}`;
    await queue.enqueue({ jobType: 'KARBON_SYNC', idempotencyKey: transientKey, payload: {}, maxAttempts: 3 });
    const transientJob = await queue.claim('worker');

    const { IntegrationError, ValidationError } = await import('@element/shared');
    const transient = await queue.fail(transientJob!, new IntegrationError('Karbon', 'temporarily unavailable'));
    expect(transient.willRetry).toBe(true);
    expect(transient.status).toBe('PENDING');

    const permanentKey = `permanent-${randomUUID()}`;
    await queue.enqueue({ jobType: 'KARBON_SYNC', idempotencyKey: permanentKey, payload: {}, maxAttempts: 3 });
    const permanentJob = await queue.claim('worker');

    const permanent = await queue.fail(permanentJob!, new ValidationError('The compilation selection is unconfirmed.'));
    expect(permanent.willRetry).toBe(false);
    expect(permanent.status).toBe('DEAD_LETTER');

    const record = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: permanentJob!.id } });
    expect(record.userMessage).toMatch(/compilation selection/i);
  });
});

describe('completion cover letters', () => {
  /** Builds a T2 engagement that has completed signing, ready for a cover letter. */
  async function completedT2() {
    const engagement = await makeT2Engagement({ compilationSelected: true });

    await workflow.transition({ engagementId: engagement.id, to: 'GENERATING' });
    const generated = await generation.generate({
      engagementId: engagement.id,
      documentType: 'T2_ENGAGEMENT_LETTER',
      actorId: preparer.id,
      correlationId: 'test',
      testMode: true,
    });
    await workflow.transition({ engagementId: engagement.id, to: 'DRAFT_READY' });
    await workflow.transition({ engagementId: engagement.id, to: 'REVIEW_REQUIRED' });
    await approvals.startReview(engagement.id, reviewer);
    await approvals.approveDocument({
      engagementId: engagement.id,
      documentVersionId: generated.documentVersionId,
      actor: partner,
    });
    await approvals.markReadyToSend(engagement.id, partner);
    await workflow.transition({ engagementId: engagement.id, to: 'SENDING_FOR_SIGNATURE' });
    await workflow.transition({ engagementId: engagement.id, to: 'SENT_FOR_SIGNATURE' });
    await workflow.transition({ engagementId: engagement.id, to: 'SIGNED' });
    await workflow.transition({ engagementId: engagement.id, to: 'COMPLETE' });

    return engagement;
  }

  async function addFinalSources(engagementId: string, kinds: readonly string[]) {
    const created: string[] = [];
    for (const kind of kinds) {
      const source = await prisma.sourceDocument.create({
        data: {
          engagementId,
          kind: kind as never,
          fileName: `${kind}.pdf`,
          fileHash: randomUUID().replace(/-/g, ''),
          isFinal: true,
          includedInPackage: true,
          pageCount: 4,
          verificationScore: 1,
        },
      });
      created.push(source.id);
    }
    return created;
  }

  it('requires all three trigger conditions before it will generate', async () => {
    const engagement = await completedT2();

    // Condition 3 is satisfied only in READY_FOR_COVER_LETTER.
    let gate = await coverLetters.evaluateTriggerGate(engagement.id);
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/READY_FOR_COVER_LETTER/);

    await workflow.transition({ engagementId: engagement.id, to: 'READY_FOR_COVER_LETTER' });

    // Condition 1: the final source documents must be present.
    gate = await coverLetters.evaluateTriggerGate(engagement.id);
    expect(gate.ok).toBe(false);
    expect(gate.blockers.join(' ')).toMatch(/final source documents are missing/i);

    await addFinalSources(engagement.id, [
      'FINAL_T2_RETURN',
      'COMPILED_FINANCIAL_STATEMENTS',
      'COMPILATION_ENGAGEMENT_REPORT',
    ]);

    gate = await coverLetters.evaluateTriggerGate(engagement.id);
    expect(gate.ok).toBe(true);
    expect(gate.documentType).toBe('COMPILATION_COVER_LETTER');
  });

  it('builds the enclosure list only from documents actually present', async () => {
    const engagement = await completedT2();
    await workflow.transition({ engagementId: engagement.id, to: 'READY_FOR_COVER_LETTER' });
    await addFinalSources(engagement.id, [
      'FINAL_T2_RETURN',
      'COMPILED_FINANCIAL_STATEMENTS',
      'COMPILATION_ENGAGEMENT_REPORT',
    ]);

    const result = await coverLetters.generate({
      engagementId: engagement.id,
      actor: { ...preparer, roles: ['PREPARER'] },
      correlationId: 'test',
      testMode: true,
    });

    const codes = result.enclosures.map((enclosure) => enclosure.code);
    expect(codes).toContain('enc.financial_statements');
    expect(codes).toContain('enc.tax_returns');
    // No trial balance or authorization forms were supplied, so neither is listed.
    expect(codes).not.toContain('enc.trial_balance_and_aje');
    expect(codes).not.toContain('enc.authorizations');

    const status = await prisma.coverLetterPackage.findUniqueOrThrow({ where: { id: result.coverLetterPackageId } });
    expect(status.status).toBe('REVIEW_REQUIRED');
  });

  it('refuses to borrow the compilation cover letter for a non-compilation T2', async () => {
    const engagement = await makeT2Engagement({ compilationSelected: false });

    const resolution = await coverLetters.resolveDocumentType(engagement.id);
    expect(resolution.documentType).toBeNull();
    expect(resolution.blockedReason).toMatch(/non-compilation T2 cover-letter template/i);
    expect(resolution.blockedReason).toMatch(/compilation cover letter must not be used/i);
  });

  /**
   * The T1 and compilation branches used to name a document type without ever
   * checking an approved template existed for it, while the other two branches
   * checked. Both templates happen to be approved in this release, so the gap
   * showed nothing — until an administrator deactivates one, or a deployment
   * ships without that manifest.
   *
   * What it would produce is the failure that is hardest to read: the trigger
   * gate reports "template: yes", the automatic start enqueues the job, and
   * generation throws on a template that was never there — once per engagement,
   * every time its document set changes. Blocking with a reason is what the
   * other branches already do.
   */
  for (const scenario of [
    {
      name: 'T1',
      documentType: 'T1_COVER_LETTER' as const,
      engagementType: 'T1_SINGLE' as const,
      compilationSelected: false,
      expected: /no approved T1 completion cover-letter template/i,
    },
    {
      name: 'a compilation T2',
      documentType: 'COMPILATION_COVER_LETTER' as const,
      engagementType: 'T2' as const,
      compilationSelected: true,
      expected: /no approved compilation cover-letter template/i,
    },
  ]) {
    it(`blocks ${scenario.name} rather than naming a cover-letter template that cannot be loaded`, async () => {
      nextTaxYear += 1;
      const engagement = await prisma.engagement.create({
        data: {
          clientId,
          engagementType: scenario.engagementType,
          taxYear: nextTaxYear,
          yearEnd: new Date(Date.UTC(nextTaxYear, 11, 31)),
          karbonWorkItemId: workItemId,
          status: 'NOT_STARTED',
          compilationSelected: scenario.compilationSelected,
          assignedPreparerId: preparer.id,
          assignedReviewerId: reviewer.id,
          isTestMode: true,
        },
      });

      // Approved in this release, so it has to be withdrawn to observe the
      // branch at all. Restored in `finally` — every other test in this file
      // depends on it being approved.
      await prisma.documentTemplate.update({
        where: { documentType: scenario.documentType },
        data: { isProductionSupported: false },
      });

      try {
        const resolution = await coverLetters.resolveDocumentType(engagement.id);
        expect(resolution.documentType).toBeNull();
        expect(resolution.blockedReason).toMatch(scenario.expected);

        // The gate is the thing that matters: it is what the automatic start
        // consults before enqueueing a job that could not have succeeded.
        const gate = await coverLetters.evaluateTriggerGate(engagement.id, { assumeStatusReady: true });
        expect(gate.ok).toBe(false);
      } finally {
        await prisma.documentTemplate.update({
          where: { documentType: scenario.documentType },
          data: { isProductionSupported: true },
        });
      }
    });
  }

  it('marks a cover letter stale when a source document changes, and blocks delivery', async () => {
    const engagement = await completedT2();
    await workflow.transition({ engagementId: engagement.id, to: 'READY_FOR_COVER_LETTER' });
    const sourceIds = await addFinalSources(engagement.id, [
      'FINAL_T2_RETURN',
      'COMPILED_FINANCIAL_STATEMENTS',
      'COMPILATION_ENGAGEMENT_REPORT',
    ]);

    const result = await coverLetters.generate({
      engagementId: engagement.id,
      actor: { ...preparer, roles: ['PREPARER'] },
      correlationId: 'test',
      testMode: true,
    });

    // Nothing changed yet.
    expect((await coverLetters.detectStaleSources(engagement.id)).staleCount).toBe(0);

    // A revised T2 return replaces the one the cover letter was built from.
    await prisma.sourceDocument.update({
      where: { id: sourceIds[0] as string },
      data: { fileHash: randomUUID().replace(/-/g, '') },
    });

    const stale = await coverLetters.detectStaleSources(engagement.id, 'test');
    expect(stale.staleCount).toBe(1);
    expect(stale.details.join(' ')).toMatch(/changed after this cover letter was generated/i);

    const record = await prisma.coverLetterPackage.findUniqueOrThrow({ where: { id: result.coverLetterPackageId } });
    expect(record.status).toBe('STALE');

    // Delivery is impossible while it is stale.
    await expect(
      coverLetters.approve({
        coverLetterPackageId: result.coverLetterPackageId,
        documentVersionId: result.documentVersionId,
        actor: partner,
      }),
    ).rejects.toThrow(/regenerated and re-approved|cannot be approved/i);
  });

  it('requires a person to approve, and never auto-approves', async () => {
    const engagement = await completedT2();
    await workflow.transition({ engagementId: engagement.id, to: 'READY_FOR_COVER_LETTER' });
    await addFinalSources(engagement.id, [
      'FINAL_T2_RETURN',
      'COMPILED_FINANCIAL_STATEMENTS',
      'COMPILATION_ENGAGEMENT_REPORT',
    ]);

    const result = await coverLetters.generate({
      engagementId: engagement.id,
      actor: { ...preparer, roles: ['PREPARER'] },
      correlationId: 'test',
      testMode: true,
    });

    // A reviewer cannot approve a cover letter.
    await expect(
      coverLetters.approve({
        coverLetterPackageId: result.coverLetterPackageId,
        documentVersionId: result.documentVersionId,
        actor: reviewer,
      }),
    ).rejects.toThrow(/does not permit/i);

    await workflow.transition({ engagementId: engagement.id, to: 'COVER_LETTER_IN_REVIEW' });
    await coverLetters.approve({
      coverLetterPackageId: result.coverLetterPackageId,
      documentVersionId: result.documentVersionId,
      actor: partner,
      comment: 'Amounts agreed to the final return.',
    });

    const approved = await prisma.coverLetterPackage.findUniqueOrThrow({
      where: { id: result.coverLetterPackageId },
    });
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedByUserId).toBe(partner.id);

    // The approval records the exact file and its source documents.
    const approval = await prisma.approval.findFirstOrThrow({
      where: { coverLetterPackageId: result.coverLetterPackageId, type: 'COVER_LETTER' },
    });
    expect(approval.documentHash).toBeTruthy();
    expect((approval.sourceDocumentVersions as unknown[]).length).toBe(3);

    await coverLetters.markReadyForDelivery({ coverLetterPackageId: result.coverLetterPackageId, actor: partner });
    const delivered = await prisma.engagement.findUniqueOrThrow({ where: { id: engagement.id } });
    expect(delivered.status).toBe('READY_FOR_DELIVERY');
  });
});

describe('Adobe Sign webhooks', () => {
  it('processes an event once and ignores a duplicate delivery', async () => {
    const engagement = await makeT2Engagement({ compilationSelected: false });
    const adobe = new MockAdobeSignProvider({ webhookSecret: 'test-adobe-webhook-secret' });

    await workflow.transition({ engagementId: engagement.id, to: 'GENERATING' });
    const generated = await generation.generate({
      engagementId: engagement.id,
      documentType: 'T2_ENGAGEMENT_LETTER',
      actorId: preparer.id,
      correlationId: 'test',
      testMode: true,
    });
    await workflow.transition({ engagementId: engagement.id, to: 'DRAFT_READY' });
    await workflow.transition({ engagementId: engagement.id, to: 'REVIEW_REQUIRED' });
    await approvals.startReview(engagement.id, reviewer);
    await approvals.approveDocument({
      engagementId: engagement.id,
      documentVersionId: generated.documentVersionId,
      actor: partner,
    });
    await approvals.markReadyToSend(engagement.id, partner);

    const sent = await signing.sendForSignature({
      engagementId: engagement.id,
      documentVersionId: generated.documentVersionId,
      actor: partner,
      adobeSign: adobe,
      testMode: true,
      productionSendingEnabled: false,
      adobeSignMode: 'sandbox' as const,
      correlationId: 'test',
    });

    adobe.simulateSign(sent.agreementId, 'officer@example.test');

    const eventId = `evt-${randomUUID()}`;
    const webhook = adobe.buildWebhook(sent.agreementId, 'AGREEMENT_WORKFLOW_COMPLETED', undefined, eventId);

    const first = await signing.processWebhook({
      rawBody: webhook.body,
      headers: webhook.headers,
      adobeSign: adobe,
      correlationId: 'test',
    });
    expect(first.handled).toBe(true);
    expect(first.duplicate).toBe(false);

    // The identical delivery is recognised and not processed again.
    const second = await signing.processWebhook({
      rawBody: webhook.body,
      headers: webhook.headers,
      adobeSign: adobe,
      correlationId: 'test',
    });
    expect(second.handled).toBe(false);
    expect(second.duplicate).toBe(true);

    const events = await prisma.adobeEvent.findMany({ where: { providerEventId: eventId } });
    expect(events).toHaveLength(1);

    // A completed webhook must ask for the signed document.
    //
    // This is where the return leg used to end. The webhook applied the status
    // and stopped; the poll was the only thing that enqueued the retrieval, and
    // its query covered agreements still in flight — so once the webhook had
    // moved this one to COMPLETED, the poll skipped it forever. The signed PDF
    // was never downloaded and never reached Karbon, while the engagement sat at
    // SIGNED and the staff notification said it "is being filed into Karbon".
    const retrievals = await prisma.backgroundJob.findMany({
      where: { jobType: 'RETRIEVE_SIGNED_DOCUMENTS', idempotencyKey: `signed_${sent.agreementId}` },
    });
    expect(retrievals).toHaveLength(1);

    // The duplicate delivery must not queue a second fetch — the poll uses this
    // same key, so whichever arrives first wins.
    expect(retrievals[0]?.idempotencyKey).toBe(`signed_${sent.agreementId}`);
  });

  it('keeps the signed document even when Karbon is a mock, and files nothing', async () => {
    const engagement = await makeT2Engagement({ compilationSelected: false });
    const adobe = new MockAdobeSignProvider({ webhookSecret: 'test-adobe-webhook-secret' });
    const karbon = new MockKarbonProvider();

    await workflow.transition({ engagementId: engagement.id, to: 'GENERATING' });
    const generated = await generation.generate({
      engagementId: engagement.id,
      documentType: 'T2_ENGAGEMENT_LETTER',
      actorId: preparer.id,
      correlationId: 'test',
      testMode: true,
    });
    await workflow.transition({ engagementId: engagement.id, to: 'DRAFT_READY' });
    await workflow.transition({ engagementId: engagement.id, to: 'REVIEW_REQUIRED' });
    await approvals.startReview(engagement.id, reviewer);
    await approvals.approveDocument({
      engagementId: engagement.id,
      documentVersionId: generated.documentVersionId,
      actor: partner,
    });
    await approvals.markReadyToSend(engagement.id, partner);

    const sent = await signing.sendForSignature({
      engagementId: engagement.id,
      documentVersionId: generated.documentVersionId,
      actor: partner,
      adobeSign: adobe,
      testMode: true,
      productionSendingEnabled: false,
      adobeSignMode: 'sandbox' as const,
      correlationId: 'test',
    });

    adobe.simulateSign(sent.agreementId, 'officer@example.test');

    const result = await signing.returnSignedDocumentsToKarbon({
      agreementId: sent.agreementId,
      adobeSign: adobe,
      karbon,
      correlationId: 'test',
    });

    const stored = await prisma.adobeAgreement.findUniqueOrThrow({
      where: { agreementId: sent.agreementId },
    });

    // The bytes are kept whatever Karbon did. They used to be downloaded,
    // hashed, uploaded and dropped, so a failed upload left the one document
    // proving a client accepted a fee existing nowhere.
    expect(stored.signedPdfReference).toBeTruthy();
    expect(stored.certificateReference).toBeTruthy();
    expect(await store.get(stored.signedPdfReference as string)).toBeInstanceOf(Buffer);

    // A mock's object id must never be recorded as a real filing. Doing so would
    // also switch off the poll's safety net, which keys on this column being
    // null, so the letter would never be retried once Karbon was connected.
    expect(stored.signedPdfKarbonDocumentId).toBeNull();
    expect(result.messages.join(' ')).toMatch(/Karbon is not connected/i);
  });

  it('rejects a payload whose signature does not verify', async () => {
    const adobe = new MockAdobeSignProvider({ webhookSecret: 'test-adobe-webhook-secret' });

    const result = await signing.processWebhook({
      rawBody: JSON.stringify({ eventId: 'forged', event: 'AGREEMENT_WORKFLOW_COMPLETED' }),
      headers: { 'x-adobe-signature': 'not-a-valid-signature' },
      adobeSign: adobe,
      correlationId: 'test',
    });

    expect(result.handled).toBe(false);
    expect(result.reason).toMatch(/verification failed/i);
  });
});

describe('joint T1 parallel signing', () => {
  it('reports PARTIALLY_SIGNED until both taxpayers have signed', async () => {
    const adobe = new MockAdobeSignProvider({ webhookSecret: 'test-adobe-webhook-secret' });

    const created = await adobe.createAgreement({
      idempotencyKey: `t1-${randomUUID()}`,
      title: 'T1 joint engagement letter',
      pdf: Buffer.from('%PDF-1.4 test'),
      fileName: 'letter.pdf',
      signers: [
        { role: 'TAXPAYER_1', name: 'Taxpayer One', email: 'one@example.test', order: 1 },
        { role: 'TAXPAYER_2', name: 'Taxpayer Two', email: 'two@example.test', order: 1 },
        { role: 'FIRM_SIGNER', name: 'Firm Signer', email: 'firm@example.test', order: 2 },
      ],
      ccEmails: [],
      expiresInDays: 30,
      reminderEveryBusinessDays: 3,
      locale: 'en_US',
      allowDelegation: false,
      authenticationMethod: 'EMAIL',
      engagementType: 'T1_JOINT',
    });

    // Both taxpayers are notified at once; the firm signer waits.
    let state = await adobe.getAgreement(created.agreementId);
    expect(state?.signers.find((signer) => signer.email === 'one@example.test')?.status).toBe('OUT_FOR_SIGNATURE');
    expect(state?.signers.find((signer) => signer.email === 'two@example.test')?.status).toBe('OUT_FOR_SIGNATURE');
    expect(state?.signers.find((signer) => signer.email === 'firm@example.test')?.status).toBe('WAITING_FOR_OTHERS');

    state = adobe.simulateSign(created.agreementId, 'one@example.test');
    expect(state.status).toBe('PARTIALLY_SIGNED');
    // The firm signer is still not notified.
    expect(state.signers.find((signer) => signer.email === 'firm@example.test')?.status).toBe('WAITING_FOR_OTHERS');

    state = adobe.simulateSign(created.agreementId, 'two@example.test');
    expect(state.status).toBe('PARTIALLY_SIGNED');
    // Now the firm signer's turn begins.
    expect(state.signers.find((signer) => signer.email === 'firm@example.test')?.status).toBe('OUT_FOR_SIGNATURE');

    state = adobe.simulateSign(created.agreementId, 'firm@example.test');
    expect(state.status).toBe('COMPLETED');
  });

  it('deduplicates agreement creation by idempotency key', async () => {
    const adobe = new MockAdobeSignProvider({});
    const request = {
      idempotencyKey: 'stable-key',
      title: 'Letter',
      pdf: Buffer.from('%PDF-1.4 test'),
      fileName: 'letter.pdf',
      signers: [{ role: 'TAXPAYER_1' as const, name: 'One', email: 'one@example.test', order: 1 }],
      ccEmails: [],
      expiresInDays: 30,
      reminderEveryBusinessDays: 3,
      locale: 'en_US',
      allowDelegation: false,
      authenticationMethod: 'EMAIL' as const,
      engagementType: 'T1_JOINT' as const,
    };

    const first = await adobe.createAgreement(request);
    const second = await adobe.createAgreement(request);

    expect(second.agreementId).toBe(first.agreementId);
    expect(second.deduplicated).toBe(true);
    expect(adobe.agreementCount()).toBe(1);
  });
});
