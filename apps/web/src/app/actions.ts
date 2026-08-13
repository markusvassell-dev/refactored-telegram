'use server';

import { revalidatePath } from 'next/cache';
import {
  AppError,
  PreconditionError,
  ValidationError,
  generationIdempotencyKey,
  newCorrelationId,
  toUserMessage,
  type DocumentType,
  type EngagementType,
  type FeeKind,
  type FeeMethod,
  type Role,
} from '@element/shared';
import { factToken, type IntegrationProviderKey } from '@element/services';
import type { FeeRuleLevel } from '@element/database';
import { container } from '@/lib/container';
import { assertCsrf, requirePermission, requireUser, requestContext } from '@/lib/session';

/**
 * Server actions.
 *
 * Each action authenticates, authorises, verifies the CSRF token, delegates to
 * a service, and returns a plain result. No business rule is implemented here.
 */

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Blocking reasons a reviewer can act on. */
  blockers?: string[];
}

/**
 * A successful action may still have something to report — a rollout that
 * queued most of its selection and refused the rest succeeded, and saying so
 * is more useful than calling the whole thing a failure.
 */
type ActionOutcome = string | { message: string; blockers?: string[] };

async function run(action: () => Promise<ActionOutcome>): Promise<ActionResult> {
  try {
    const outcome = await action();
    if (typeof outcome === 'string') return { ok: true, message: outcome };
    return { ok: true, message: outcome.message, ...(outcome.blockers?.length ? { blockers: outcome.blockers } : {}) };
  } catch (error) {
    // An expected refusal explains itself to the user. Anything else shows a
    // generic message on purpose — and must therefore reach the log, or it
    // leaves no trace anywhere at all.
    if (!(error instanceof AppError)) {
      container.logger.error('Server action failed', {
        name: error instanceof Error ? error.name : 'Unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : undefined,
      });
    }

    // Any error may carry the specific reasons a reviewer can act on — a
    // blocked precondition and a field that failed validation are both things
    // to list rather than summarise.
    const blockers =
      error instanceof AppError && Array.isArray(error.context.blockers)
        ? (error.context.blockers as string[])
        : undefined;
    return { ok: false, message: toUserMessage(error), ...(blockers ? { blockers } : {}) };
  }
}

const DOCUMENT_TYPE_BY_ENGAGEMENT: Record<EngagementType, DocumentType> = {
  T1_JOINT: 'T1_JOINT_ENGAGEMENT_LETTER',
  T1_SINGLE: 'T1_SINGLE_ENGAGEMENT_LETTER',
  T2: 'T2_ENGAGEMENT_LETTER',
  T3: 'T3_ENGAGEMENT_LETTER',
};

/**
 * How a signature obtained elsewhere was obtained. Mirrors the database enum;
 * a value not in this list is rejected rather than stored.
 */
const EXTERNAL_SIGNATURE_METHODS = ['ACROBAT_ESIGN', 'WET_INK', 'OTHER_ELECTRONIC'] as const;
type ExternalSignatureMethod = (typeof EXTERNAL_SIGNATURE_METHODS)[number];

export async function startGeneration(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('generation:start');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    if (!engagementId) throw new ValidationError('An engagement is required.');

    const engagement = await container.prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId },
      select: { clientId: true, engagementType: true, taxYear: true },
    });

    const documentType = DOCUMENT_TYPE_BY_ENGAGEMENT[engagement.engagementType];

    // The gate is evaluated up front so the user gets a specific reason rather
    // than a job that fails minutes later.
    const gate = await container.generation.evaluateGate(engagementId, documentType);
    if (!gate.ok) {
      throw new PreconditionError(`Generation is blocked: ${gate.blockers.join(' ')}`, { blockers: gate.blockers });
    }

    const result = await container.queue.enqueue({
      jobType: 'GENERATE_ENGAGEMENT_LETTER',
      idempotencyKey: generationIdempotencyKey({
        clientId: engagement.clientId,
        engagementType: engagement.engagementType,
        taxYear: engagement.taxYear,
        documentType,
      }),
      payload: { engagementId, documentType, actorId: actor.id },
      engagementId,
      correlationId: newCorrelationId(),
    });

    revalidatePath(`/engagements/${engagementId}`);
    return result.deduplicated
      ? 'A draft is already being generated for this engagement; a second one was not started.'
      : 'Generation has been queued. The draft will appear here shortly.';
  });
}

export async function confirmCompilationSelection(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('field:edit_structured');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const selected = formData.get('selected')?.toString();
    if (!engagementId || (selected !== 'yes' && selected !== 'no')) {
      throw new ValidationError('Confirm whether CSRS 4200 compilation services are included.');
    }

    const isSelected = selected === 'yes';
    const before = await container.prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId },
      select: { compilationSelected: true },
    });

    await container.prisma.engagement.update({
      where: { id: engagementId },
      data: { compilationSelected: isSelected },
    });

    await container.prisma.serviceSelection.upsert({
      where: { engagementId_serviceCode: { engagementId, serviceCode: 't2.csrs4200' } },
      create: {
        engagementId,
        serviceCode: 't2.csrs4200',
        label: 'Compilation engagement under CSRS 4200',
        isSelected,
        confirmed: true,
        confirmedByUserId: actor.id,
        confirmedAt: new Date(),
      },
      update: { isSelected, confirmed: true, confirmedByUserId: actor.id, confirmedAt: new Date() },
    });

    await container.audit.record({
      eventType: 'FIELD_EDITED',
      objectType: 'Engagement',
      objectId: engagementId,
      engagementId,
      userId: actor.id,
      beforeValue: { compilationSelected: before.compilationSelected },
      afterValue: { compilationSelected: isSelected },
      reason: 'Reviewer confirmed the CSRS 4200 selection for the new year.',
    });

    revalidatePath(`/engagements/${engagementId}`);
    return isSelected
      ? 'Compilation services confirmed as included. Section 3A will be kept.'
      : 'Compilation services confirmed as not included. Section 3A will be removed entirely.';
  });
}

/** Field inputs are namespaced so they cannot collide with the form's own controls. */
const FIELD_INPUT_PREFIX = 'field:';

/**
 * Saves one group of the structured field form.
 *
 * The form is built from the approved template's field definitions, so the
 * submitted names are tokens that template really declares. Every value is
 * validated against its own definition; a value that fails is reported and not
 * stored, because a plausible-looking wrong value in a legal document is worse
 * than an empty one.
 */
export async function saveFieldGroup(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('field:edit_structured');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    if (!engagementId) throw new ValidationError('An engagement is required.');

    const values: Record<string, string> = {};
    for (const [name, value] of formData.entries()) {
      if (!name.startsWith(FIELD_INPUT_PREFIX) || typeof value !== 'string') continue;
      values[name.slice(FIELD_INPUT_PREFIX.length)] = value;
    }

    if (Object.keys(values).length === 0) throw new ValidationError('There was nothing to save.');

    const result = await container.fields.save({ engagementId, actorId: actor.id, values });

    revalidatePath(`/engagements/${engagementId}`);

    if (result.errors.length > 0) {
      throw new ValidationError(
        `${result.errors.length} value(s) were not saved.`,
        { blockers: result.errors.map((error) => error.message) },
      );
    }

    const changed = result.saved.length + result.cleared.length;
    if (changed === 0) return 'No changes to save.';

    const cleared = result.cleared.length > 0 ? `, ${result.cleared.length} cleared` : '';
    return `Saved ${result.saved.length} value(s)${cleared}.`;
  });
}

export async function resolveConflict(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('field:edit_structured');
    await assertCsrf(formData.get('csrf')?.toString());

    const conflictId = formData.get('conflictId')?.toString();
    const chosenValue = formData.get('chosenValue')?.toString();
    const chosenSource = formData.get('chosenSource')?.toString();
    if (!conflictId || !chosenValue || !chosenSource) {
      throw new ValidationError('Choose which value is correct.');
    }

    const conflict = await container.prisma.fieldConflict.update({
      where: { id: conflictId },
      data: {
        status: 'RESOLVED',
        resolvedValue: chosenValue,
        resolvedSource: chosenSource as never,
        resolvedByUserId: actor.id,
        resolvedAt: new Date(),
      },
    });

    await container.audit.record({
      eventType: 'CONFLICT_RESOLVED',
      objectType: 'FieldConflict',
      objectId: conflictId,
      engagementId: conflict.engagementId,
      userId: actor.id,
      afterValue: { templateField: conflict.token, chosenValue, chosenSource },
    });

    revalidatePath(`/engagements/${conflict.engagementId}`);
    return 'Conflict resolved. The chosen value and its source have been recorded.';
  });
}

export async function confirmDate(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('field:edit_structured');
    await assertCsrf(formData.get('csrf')?.toString());

    const calculatedDateId = formData.get('calculatedDateId')?.toString();
    if (!calculatedDateId) throw new ValidationError('A date is required.');

    const record = await container.prisma.calculatedDate.findUniqueOrThrow({ where: { id: calculatedDateId } });
    if (record.isBlocked) {
      throw new PreconditionError(
        record.blockedReason ?? 'This deadline cannot be confirmed until the missing information is supplied.',
      );
    }

    await container.prisma.calculatedDate.update({
      where: { id: calculatedDateId },
      data: { confirmedByUserId: actor.id, confirmedAt: new Date() },
    });

    await container.audit.record({
      eventType: 'DATE_CONFIRMED',
      objectType: 'CalculatedDate',
      objectId: calculatedDateId,
      engagementId: record.engagementId,
      userId: actor.id,
      afterValue: { templateField: record.token, result: record.result?.toISOString() ?? null, ruleCode: record.ruleCode },
    });

    revalidatePath(`/engagements/${record.engagementId}`);
    return 'Date confirmed.';
  });
}

export async function overrideFee(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('pricing:prepare');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const feeKind = formData.get('feeKind')?.toString() as FeeKind | undefined;
    const amount = formData.get('amount')?.toString();
    const reason = formData.get('reason')?.toString() ?? '';

    if (!engagementId || !feeKind || !amount) throw new ValidationError('A fee amount is required.');

    const threshold = await container.settings.highIncreaseThresholdPercent(
      container.env.HIGH_FEE_INCREASE_THRESHOLD_PERCENT,
    );

    const result = await container.pricing.override({
      engagementId,
      feeKind,
      amount,
      reason,
      actor,
      highIncreaseThresholdPercent: threshold,
    });

    revalidatePath(`/engagements/${engagementId}`);

    return result.requiredApproval === 'NONE'
      ? `Fee set to ${result.roundedFee?.toFixed(2) ?? '—'} (rounded up to the next $5).`
      : `Fee set to ${result.roundedFee?.toFixed(2) ?? '—'}. This change requires partner approval before the letter can be sent.`;
  });
}

export async function approveFee(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('fee:approve_high_increase');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const feeKind = formData.get('feeKind')?.toString() as FeeKind | undefined;
    if (!engagementId || !feeKind) throw new ValidationError('A fee is required.');

    await container.pricing.approveFee({ engagementId, feeKind, approver: actor });
    revalidatePath(`/engagements/${engagementId}`);
    return 'Fee change approved.';
  });
}

export async function startReview(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('review:comment');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    if (!engagementId) throw new ValidationError('An engagement is required.');

    await container.approvals.startReview(engagementId, actor);
    revalidatePath(`/engagements/${engagementId}`);
    return 'Review started.';
  });
}

export async function addComment(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('review:comment');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const body = formData.get('body')?.toString() ?? '';
    if (!engagementId) throw new ValidationError('An engagement is required.');

    await container.approvals.addComment({
      engagementId,
      documentVersionId: formData.get('documentVersionId')?.toString() ?? null,
      body,
      anchor: formData.get('anchor')?.toString() ?? null,
      actor,
    });

    revalidatePath(`/engagements/${engagementId}`);
    return 'Comment added.';
  });
}

export async function requestChanges(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('review:request_changes');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const reason = formData.get('reason')?.toString() ?? '';
    if (!engagementId) throw new ValidationError('An engagement is required.');

    await container.approvals.requestChanges({ engagementId, reason, actor });
    revalidatePath(`/engagements/${engagementId}`);
    return 'Changes requested. The preparer has been notified.';
  });
}

export async function approveDocument(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('review:approve_ordinary');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const documentVersionId = formData.get('documentVersionId')?.toString();
    if (!engagementId || !documentVersionId) throw new ValidationError('A document version is required.');

    await container.approvals.approveDocument({
      engagementId,
      documentVersionId,
      actor,
      comment: formData.get('comment')?.toString(),
    });

    revalidatePath(`/engagements/${engagementId}`);
    return 'Document approved. It can now be authorised for sending.';
  });
}

export async function markReadyToSend(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('signing:send');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    if (!engagementId) throw new ValidationError('An engagement is required.');

    await container.approvals.markReadyToSend(engagementId, actor);
    revalidatePath(`/engagements/${engagementId}`);
    return 'Authorised for sending.';
  });
}

export async function sendForSignature(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('signing:send');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const documentVersionId = formData.get('documentVersionId')?.toString();
    if (!engagementId || !documentVersionId) throw new ValidationError('A document version is required.');

    const state = await container.testModeState();
    const providers = await container.providers();

    const result = await container.signing.sendForSignature({
      engagementId,
      documentVersionId,
      actor,
      adobeSign: providers.adobeSign,
      testMode: state.testMode,
      productionSendingEnabled: state.productionSendingEnabled,
      sandboxConfigured: !providers.description.adobeSign.startsWith('blocked'),
      correlationId: newCorrelationId(),
    });

    revalidatePath(`/engagements/${engagementId}`);

    return result.deduplicated
      ? 'An agreement already exists for this approved version; a duplicate was not created.'
      : state.testMode
        ? `Test agreement ${result.agreementId} created with the ${providers.description.adobeSign}. No real client was contacted.`
        : `Agreement ${result.agreementId} sent for signature.`;
  });
}

export async function submitWordingException(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('wording:edit');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const documentVersionId = formData.get('documentVersionId')?.toString();
    const sectionAnchor = formData.get('sectionAnchor')?.toString();
    const originalWording = formData.get('originalWording')?.toString();
    const revisedWording = formData.get('revisedWording')?.toString();
    const reason = formData.get('reason')?.toString() ?? '';

    if (!engagementId || !documentVersionId || !sectionAnchor || !originalWording || !revisedWording) {
      throw new ValidationError('A section, the original wording, the revised wording and a reason are all required.');
    }

    await container.approvals.submitWordingException({
      engagementId,
      documentVersionId,
      sectionAnchor,
      originalWording,
      revisedWording,
      reason,
      actor,
    });

    revalidatePath(`/engagements/${engagementId}`);
    return 'Wording change submitted. It requires partner approval before it can be used.';
  });
}

export async function approveWordingException(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('wording:approve');
    await assertCsrf(formData.get('csrf')?.toString());

    const exceptionId = formData.get('exceptionId')?.toString();
    const engagementId = formData.get('engagementId')?.toString();
    if (!exceptionId) throw new ValidationError('A wording change is required.');

    await container.approvals.approveWordingException({ exceptionId, actor });
    if (engagementId) revalidatePath(`/engagements/${engagementId}`);
    return 'Wording change approved for this document version only.';
  });
}

export async function generateCoverLetter(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('generation:start');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    if (!engagementId) throw new ValidationError('An engagement is required.');

    const gate = await container.coverLetters.evaluateTriggerGate(engagementId);
    if (!gate.ok) {
      throw new PreconditionError(`The cover letter cannot be generated yet: ${gate.blockers.join(' ')}`, {
        blockers: gate.blockers,
      });
    }

    await container.queue.enqueue({
      jobType: 'GENERATE_COVER_LETTER',
      idempotencyKey: `coverletter_${engagementId}_${Date.now()}`,
      payload: { engagementId, actorId: actor.id },
      engagementId,
      correlationId: newCorrelationId(),
    });

    revalidatePath(`/engagements/${engagementId}`);
    return 'Cover letter generation queued. It will require review before delivery.';
  });
}

export async function approveCoverLetter(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('cover_letter:approve');
    await assertCsrf(formData.get('csrf')?.toString());

    const coverLetterPackageId = formData.get('coverLetterPackageId')?.toString();
    const documentVersionId = formData.get('documentVersionId')?.toString();
    if (!coverLetterPackageId || !documentVersionId) throw new ValidationError('A cover letter is required.');

    await container.coverLetters.approve({
      coverLetterPackageId,
      documentVersionId,
      actor,
      comment: formData.get('comment')?.toString(),
    });

    revalidatePath('/cover-letters');
    return 'Cover letter approved.';
  });
}

export async function saveCoverLetterNarrative(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('cover_letter:edit');
    await assertCsrf(formData.get('csrf')?.toString());

    const coverLetterPackageId = formData.get('coverLetterPackageId')?.toString();
    const sectionKey = formData.get('sectionKey')?.toString();
    const text = formData.get('text')?.toString();
    if (!coverLetterPackageId || !sectionKey) throw new ValidationError('A cover letter section is required.');
    if (text === undefined) throw new ValidationError('The narrative is required.');

    const outcome = await container.coverLetterNarratives.save({
      coverLetterPackageId,
      sectionKey,
      text,
      reason: formData.get('reason')?.toString(),
      actor,
    });

    revalidatePath('/cover-letters');
    return outcome.markedStale
      ? 'Narrative saved. The letter had already been approved, so it has been sent back for review — regenerate it to produce the new wording.'
      : 'Narrative saved. Regenerate the letter to produce the new wording.';
  });
}

export async function restoreCoverLetterNarrative(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('cover_letter:edit');
    await assertCsrf(formData.get('csrf')?.toString());

    const coverLetterPackageId = formData.get('coverLetterPackageId')?.toString();
    const sectionKey = formData.get('sectionKey')?.toString();
    if (!coverLetterPackageId || !sectionKey) throw new ValidationError('A cover letter section is required.');

    const outcome = await container.coverLetterNarratives.restoreOriginal({
      coverLetterPackageId,
      sectionKey,
      actor,
    });

    revalidatePath('/cover-letters');
    return outcome.markedStale
      ? 'Template wording restored. The letter had already been approved, so it has been sent back for review.'
      : 'Template wording restored. Regenerate the letter to produce it.';
  });
}

export async function markCoverLetterReady(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('cover_letter:approve');
    await assertCsrf(formData.get('csrf')?.toString());

    const coverLetterPackageId = formData.get('coverLetterPackageId')?.toString();
    if (!coverLetterPackageId) throw new ValidationError('A cover letter is required.');

    await container.coverLetters.markReadyForDelivery({ coverLetterPackageId, actor });
    revalidatePath('/cover-letters');
    return 'Marked ready for delivery. Cover letters are not sent through Adobe Sign.';
  });
}

export async function retryJob(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('job:retry');
    await assertCsrf(formData.get('csrf')?.toString());

    const jobId = formData.get('jobId')?.toString();
    if (!jobId) throw new ValidationError('A job is required.');

    await container.queue.retry(jobId);
    await container.audit.record({
      eventType: 'JOB_RETRIED',
      objectType: 'BackgroundJob',
      objectId: jobId,
      userId: actor.id,
    });

    revalidatePath('/system-jobs');
    return 'Job re-queued. Idempotency keys prevent it from duplicating any earlier work.';
  });
}

export async function setTestMode(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('system:manage_test_mode');
    await assertCsrf(formData.get('csrf')?.toString());

    const enabled = formData.get('enabled')?.toString() === 'true';
    const context = await requestContext();

    await container.settings.set('test_mode', enabled, actor);
    if (enabled) await container.settings.set('production_sending_enabled', false, actor);

    await container.audit.record({
      eventType: 'TEST_MODE_CHANGED',
      objectType: 'SystemSetting',
      objectId: 'test_mode',
      userId: actor.id,
      afterValue: { testMode: enabled },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    revalidatePath('/settings');
    return enabled
      ? 'Test Mode is on. Nothing will reach a real client, Karbon, or Adobe Sign.'
      : 'Test Mode is off. Production sending still has to be armed separately.';
  });
}

export async function setProductionSending(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('system:manage_test_mode');
    await assertCsrf(formData.get('csrf')?.toString());

    const enabled = formData.get('enabled')?.toString() === 'true';
    const context = await requestContext();

    if (enabled && container.env.TEST_MODE) {
      throw new PreconditionError(
        'This deployment sets TEST_MODE, which cannot be overridden from the application. Change the environment variable first.',
      );
    }

    await container.settings.set('production_sending_enabled', enabled, actor);

    await container.audit.record({
      eventType: 'PRODUCTION_SENDING_CHANGED',
      objectType: 'SystemSetting',
      objectId: 'production_sending_enabled',
      userId: actor.id,
      afterValue: { productionSendingEnabled: enabled },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });

    revalidatePath('/settings');
    return enabled ? 'Production sending is armed.' : 'Production sending is disabled.';
  });
}

/**
 * States the prior-year search may begin from.
 *
 * `LOCATING_SOURCE_DOCUMENTS` is the job's first act, so an engagement that has
 * already moved past extraction cannot accept it. Refusing here gives the
 * reviewer the reason immediately instead of enqueuing a job that fails on the
 * transition minutes later, in a place only the log would show it.
 */
const PRIOR_YEAR_SEARCH_STATES = new Set([
  'NOT_STARTED',
  'SOURCE_DOCUMENT_REVIEW_REQUIRED',
  'GENERATION_FAILED',
  'NEEDS_ATTENTION',
]);

interface PriorYearSearchOutcome {
  enqueued: boolean;
  deduplicated: boolean;
  /** Why it was not started, in words a reviewer can act on. */
  reason?: string;
}

/**
 * Queues the Karbon search for last year's engagement letter.
 *
 * The worker has been able to do this since the first release: it searches the
 * current work item, then the prior year's work items, then the client's own
 * document area, and scores each candidate on its text rather than its
 * filename. What was missing was anybody asking. Until now the only caller was
 * the Karbon status webhook, and `karbon_status_triggers` ships empty, so on a
 * tenant that had never configured a status trigger the search simply never
 * ran — leaving every engagement asking the reviewer to upload by hand a
 * document Karbon was already holding.
 *
 * A fully tested capability that nothing reaches is indistinguishable from one
 * that was never built, which is why `tests/integration/prior-year-search.test.ts`
 * now asserts the caller and not just the handler.
 */
async function enqueuePriorYearSearch(
  engagementId: string,
  correlationId: string,
  options: { force?: boolean } = {},
): Promise<PriorYearSearchOutcome> {
  const engagement = await container.prisma.engagement.findUnique({
    where: { id: engagementId },
    select: {
      status: true,
      client: { select: { karbonEntityKey: true } },
      karbonWorkItem: { select: { karbonKey: true } },
    },
  });

  if (!engagement) return { enqueued: false, deduplicated: false, reason: 'The engagement no longer exists.' };

  // Nothing to search. Saying which link is missing is the difference between
  // a fixable message and "no documents found".
  if (!engagement.client.karbonEntityKey && !engagement.karbonWorkItem?.karbonKey) {
    return {
      enqueued: false,
      deduplicated: false,
      reason:
        'This engagement is not linked to Karbon — neither the client nor a work item carries a Karbon key — so there is nowhere to search. Attach last year’s letter below.',
    };
  }

  if (!PRIOR_YEAR_SEARCH_STATES.has(engagement.status)) {
    return {
      enqueued: false,
      deduplicated: false,
      reason: `Searching would move this engagement back to locating source documents, which is not allowed from ${engagement.status
        .replace(/_/g, ' ')
        .toLowerCase()}.`,
    };
  }

  const result = await container.queue.enqueue({
    jobType: 'LOCATE_PRIOR_YEAR_DOCUMENTS',
    // Stable per engagement so re-running preparation does not search twice;
    // an explicit re-run asks for a fresh look and gets its own key.
    idempotencyKey: options.force
      ? `locate_prior_year_${engagementId}_${Date.now()}`
      : `locate_prior_year_${engagementId}`,
    payload: { engagementId },
    engagementId,
    correlationId,
  });

  return { enqueued: true, deduplicated: result.deduplicated };
}

/**
 * Searches Karbon again for the prior-year letter, on request.
 *
 * Preparation starts this automatically; this is the button for after the
 * missing Karbon link has been fixed, or after last year's letter has been
 * filed where the first search could not see it.
 */
export async function locatePriorYearDocuments(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    await requirePermission('source_document:select');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    if (!engagementId) throw new ValidationError('An engagement is required.');

    const outcome = await enqueuePriorYearSearch(engagementId, newCorrelationId(), { force: true });
    revalidatePath(`/engagements/${engagementId}`);

    if (!outcome.enqueued) throw new PreconditionError(outcome.reason ?? 'The search could not be started.');

    return 'Searching Karbon for last year’s letter. Candidates appear below with the score each one earned.';
  });
}

/**
 * Runs the preparation step: records what Karbon says, raises conflicts where
 * sources disagree, seeds service selections from the prior year as
 * suggestions, calculates the fees, and evaluates the deadlines.
 *
 * It proposes; a reviewer confirms. It never overwrites a decision a person
 * has already made.
 */
export async function prepareEngagement(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('generation:start');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    if (!engagementId) throw new ValidationError('An engagement is required.');

    const threshold = await container.settings.highIncreaseThresholdPercent(
      container.env.HIGH_FEE_INCREASE_THRESHOLD_PERCENT,
    );

    const correlationId = newCorrelationId();

    const result = await container.preparation.prepare({
      engagementId,
      actorId: actor.id,
      correlationId,
      highIncreaseThresholdPercent: threshold,
    });

    // Preparation reconciles what is already known; the prior-year letter is
    // the largest single source of what it reconciles against, so the search
    // starts here. It runs in the background: preparation's own result must
    // not depend on Karbon being reachable this second.
    const search = await enqueuePriorYearSearch(engagementId, correlationId);

    revalidatePath(`/engagements/${engagementId}`);

    const outstanding: string[] = [];
    if (result.conflictsRaised > 0) outstanding.push(`${result.conflictsRaised} conflicting value(s)`);
    if (result.blockedFees.length > 0) outstanding.push(`${result.blockedFees.length} fee(s) without a prior-year amount`);
    if (result.blockedDates.length > 0) outstanding.push(`${result.blockedDates.length} deadline(s) missing information`);

    const searchNote = search.enqueued
      ? search.deduplicated
        ? ' Karbon has already been searched for last year’s letter.'
        : ' Searching Karbon for last year’s letter.'
      : ` Last year’s letter was not searched for: ${search.reason ?? 'no reason given.'}`;

    const summary =
      `Prepared: ${result.feesCalculated.length} fee(s) calculated, ${result.datesCalculated} date(s) proposed, ` +
      `${result.serviceSelectionsSeeded} service selection(s) seeded.`;

    const decisions = outstanding.length > 0 ? ` Needs your decision on ${outstanding.join(', ')}.` : '';
    return `${summary}${decisions}${searchNote}`;
  });
}

/**
 * Records a fact a deadline depends on — for example whether a corporation
 * qualifies for the three-month balance-due day. Until it is answered the
 * dependent deadline stays blocked rather than being guessed.
 */
export async function confirmDateFact(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('field:edit_structured');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const key = formData.get('factKey')?.toString();
    const answer = formData.get('answer')?.toString();

    if (!engagementId || !key || (answer !== 'yes' && answer !== 'no')) {
      throw new ValidationError('Answer yes or no to record this fact.');
    }

    const token = factToken(key);
    const value = answer === 'yes';

    const existing = await container.prisma.extractedField.findFirst({
      where: { engagementId, coverLetterPackageId: null, token, source: 'MANUAL_ENTRY' },
      select: { id: true, valueBoolean: true },
    });

    if (existing) {
      await container.prisma.extractedField.update({
        where: { id: existing.id },
        data: { valueBoolean: value, value: answer, confirmedByUserId: actor.id, confirmedAt: new Date() },
      });
    } else {
      await container.prisma.extractedField.create({
        data: {
          engagementId,
          token,
          value: answer,
          valueBoolean: value,
          source: 'MANUAL_ENTRY',
          extractionMethod: 'MANUAL_ENTRY',
          confidence: 1,
          manuallyConfirmed: true,
          confirmedByUserId: actor.id,
          confirmedAt: new Date(),
        },
      });
    }

    await container.audit.record({
      eventType: 'DATE_CONFIRMED',
      objectType: 'ExtractedField',
      objectId: `${engagementId}:${token}`,
      engagementId,
      userId: actor.id,
      beforeValue: { [key]: existing?.valueBoolean ?? null },
      afterValue: { [key]: value },
      reason: 'Reviewer confirmed a fact a deadline depends on.',
    });

    // Re-evaluate immediately so the reviewer sees the deadline unblock.
    const threshold = await container.settings.highIncreaseThresholdPercent(
      container.env.HIGH_FEE_INCREASE_THRESHOLD_PERCENT,
    );
    await container.preparation.prepare({
      engagementId,
      actorId: actor.id,
      correlationId: newCorrelationId(),
      highIncreaseThresholdPercent: threshold,
    });

    revalidatePath(`/engagements/${engagementId}`);
    return 'Recorded. The dependent deadlines have been recalculated.';
  });
}

/** Confirms or clears a service selection for the new year. */
export async function confirmServiceSelection(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('field:edit_structured');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const serviceCode = formData.get('serviceCode')?.toString();
    const selected = formData.get('selected')?.toString() === 'yes';

    if (!engagementId || !serviceCode) throw new ValidationError('A service is required.');

    const existing = await container.prisma.serviceSelection.findUnique({
      where: { engagementId_serviceCode: { engagementId, serviceCode } },
    });

    await container.prisma.serviceSelection.update({
      where: { engagementId_serviceCode: { engagementId, serviceCode } },
      data: { isSelected: selected, confirmed: true, confirmedByUserId: actor.id, confirmedAt: new Date() },
    });

    await container.audit.record({
      eventType: 'FIELD_EDITED',
      objectType: 'ServiceSelection',
      objectId: `${engagementId}:${serviceCode}`,
      engagementId,
      userId: actor.id,
      beforeValue: { isSelected: existing?.isSelected ?? null },
      afterValue: { isSelected: selected },
      reason: 'Reviewer confirmed the selection for the new year.',
    });

    revalidatePath(`/engagements/${engagementId}`);
    return selected ? 'Service included.' : 'Service not included.';
  });
}

/**
 * Queues an annual rollout for the selected engagements.
 *
 * This is the one action that touches many clients at once, so it does not
 * trust the submitted list: every selected engagement is re-evaluated by the
 * service, and one that is still blocked is refused and named rather than
 * quietly skipped. Nothing reaches Adobe Sign — each draft still goes through
 * individual review and approval.
 */
export async function runBulkRollout(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('generation:start');
    await assertCsrf(formData.get('csrf')?.toString());

    const batchId = formData.get('batchId')?.toString();
    if (!batchId) throw new ValidationError('This preview has expired. Refresh and select again.');

    const engagementIds = formData
      .getAll('engagementId')
      .map((value) => value.toString())
      .filter(Boolean);

    if (engagementIds.length === 0) {
      throw new ValidationError('Select at least one engagement to generate.');
    }

    const threshold = await container.settings.highIncreaseThresholdPercent(
      container.env.HIGH_FEE_INCREASE_THRESHOLD_PERCENT,
    );

    const result = await container.bulk.run({
      batchId,
      engagementIds,
      actor,
      dryRun: formData.get('dryRun') === 'yes',
      highIncreaseThresholdPercent: threshold,
    });

    revalidatePath('/bulk-rollout');

    const verb = result.dryRun ? 'would be queued' : 'queued';
    const parts = [`${result.queued} draft(s) ${verb}`];
    if (result.deduplicated > 0) {
      parts.push(`${result.deduplicated} already queued and left alone`);
    }

    const message = result.dryRun
      ? `${parts.join(', ')}. Nothing was queued — this was a dry run.`
      : `${parts.join(', ')}. Each draft still needs individual review and approval.`;

    // Partial success is still success, and the refusals are the useful part.
    if (result.refused.length > 0) {
      return {
        message: `${message} ${result.refused.length} were refused:`,
        blockers: result.refused.map((entry) => `${entry.clientName}: ${entry.reason}`),
      };
    }

    return message;
  });
}

/**
 * Starts an engagement by hand.
 *
 * The only other way one exists is the seed, so this is what lets a firm begin
 * real work before the Karbon connection has been verified against a live
 * tenant. Everything it refuses, it refuses with a reason a person can act on.
 */
export async function createEngagement(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('engagement:create');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementType = formData.get('engagementType')?.toString() as EngagementType | undefined;
    const taxYear = Number(formData.get('taxYear'));

    if (!engagementType) throw new ValidationError('Choose an engagement type.');

    const state = await container.testModeState();

    const result = await container.engagements.create({
      clientId: formData.get('clientId')?.toString() || null,
      newClientName: formData.get('newClientName')?.toString() || null,
      engagementType,
      taxYear,
      yearEnd: formData.get('yearEnd')?.toString() || null,
      karbonWorkItemKey: formData.get('karbonWorkItemKey')?.toString() || null,
      assignedReviewerId: formData.get('assignedReviewerId')?.toString() || null,
      actorId: actor.id,
      // A test-mode engagement is labelled as one everywhere it appears.
      isTestMode: state.testMode,
    });

    revalidatePath('/engagements');

    // Notes are informational, so they belong in the message rather than in
    // `blockers`, which means "things standing in your way".
    const parts = [`Engagement created. Open it at /engagements/${result.engagementId}.`];
    if (result.clientCreated) parts.push('A new client record was created.');
    parts.push(...result.notes);

    return parts.join(' ');
  });
}

/** Kinds a person may attach by hand, in the order they are usually needed. */
const UPLOADABLE_KINDS = [
  'PRIOR_YEAR_ENGAGEMENT_LETTER',
  'PRIOR_YEAR_SIGNED_LETTER',
  'FINAL_T2_RETURN',
  'COMPILED_FINANCIAL_STATEMENTS',
  'COMPILATION_ENGAGEMENT_REPORT',
  'FEDERAL_FILING_AUTHORIZATION',
  'PROVINCIAL_FILING_AUTHORIZATION',
  'T1_RETURN',
  'T183',
  'ADJUSTING_JOURNAL_ENTRIES',
  'TRIAL_BALANCE',
  'INSTALMENT_SCHEDULE',
  'PAYMENT_SUMMARY',
  'OTHER_SUPPORTING_SCHEDULE',
] as const;

export type UploadableKind = (typeof UPLOADABLE_KINDS)[number];

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * Attaches a source document by hand.
 *
 * Every automatic route to a prior-year letter runs through Karbon, so this is
 * what lets an engagement get past a blocked fee before that connection is
 * verified. The file goes through the same content checks as one Karbon
 * supplied, and reading it is queued rather than done in the request.
 */
// ---- Integrations ----------------------------------------------------------

export async function saveIntegrationConnection(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('integration:manage');
    await assertCsrf(formData.get('csrf')?.toString());

    const provider = formData.get('provider')?.toString() as IntegrationProviderKey | undefined;
    if (provider !== 'KARBON' && provider !== 'ADOBE_SIGN') {
      throw new ValidationError('An integration is required.');
    }

    // Every credential field, whether or not the form sent a value: a blank one
    // means "leave what is stored", which the service handles.
    const credentials: Record<string, string | undefined> = {};
    for (const key of ['bearerToken', 'accessKey', 'clientId', 'clientSecret', 'refreshToken']) {
      const value = formData.get(key);
      if (typeof value === 'string') credentials[key] = value;
    }

    const state = await container.testModeState();

    const outcome = await container.integrations.save({
      provider,
      baseUrl: formData.get('baseUrl')?.toString(),
      isSandbox: formData.get('isSandbox')?.toString() === 'true',
      isEnabled: formData.get('isEnabled')?.toString() === 'true',
      credentials,
      testModeActive: state.testMode,
      actor,
    });

    revalidatePath('/integrations');
    return outcome.rotated.length > 0
      ? `Saved. Rotated: ${outcome.rotated.join(', ')}. Run the connection check to confirm the new credentials work.`
      : 'Saved. No credential was changed.';
  });
}

export async function checkIntegrationConnection(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('integration:manage');
    await assertCsrf(formData.get('csrf')?.toString());

    const provider = formData.get('provider')?.toString() as IntegrationProviderKey | undefined;
    if (provider !== 'KARBON' && provider !== 'ADOBE_SIGN') {
      throw new ValidationError('An integration is required.');
    }

    const result = await container.integrations.checkConnection({ provider, actor });

    revalidatePath('/integrations');

    // A failed check is a recorded answer, not an error: the detail is the
    // whole point of running it.
    return result.ok
      ? 'The connection works. The vendor answered a read-only request successfully.'
      : `The connection did not work: ${result.detail ?? 'the vendor gave no detail'}`;
  });
}

export async function clearIntegrationCredentials(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('integration:manage');
    await assertCsrf(formData.get('csrf')?.toString());

    const provider = formData.get('provider')?.toString() as IntegrationProviderKey | undefined;
    if (provider !== 'KARBON' && provider !== 'ADOBE_SIGN') {
      throw new ValidationError('An integration is required.');
    }

    await container.integrations.clearCredentials({
      provider,
      reason: formData.get('reason')?.toString() ?? '',
      actor,
    });

    revalidatePath('/integrations');
    return 'Credentials removed and the connection disabled. It now falls back to the mock adapter.';
  });
}

// ---- Users and roles -------------------------------------------------------

export async function grantRole(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('user:manage');
    await assertCsrf(formData.get('csrf')?.toString());

    const userId = formData.get('userId')?.toString();
    const role = formData.get('role')?.toString() as Role | undefined;
    if (!userId || !role) throw new ValidationError('A person and a role are required.');

    await container.users.grantRole({
      userId,
      role,
      reason: formData.get('reason')?.toString() ?? '',
      actor,
    });

    revalidatePath('/users');
    return `Granted ${role}.`;
  });
}

export async function revokeRole(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('user:manage');
    await assertCsrf(formData.get('csrf')?.toString());

    const userId = formData.get('userId')?.toString();
    const role = formData.get('role')?.toString() as Role | undefined;
    if (!userId || !role) throw new ValidationError('A person and a role are required.');

    await container.users.revokeRole({
      userId,
      role,
      reason: formData.get('reason')?.toString() ?? '',
      actor,
    });

    revalidatePath('/users');
    return `Removed ${role}.`;
  });
}

export async function setUserActive(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('user:manage');
    await assertCsrf(formData.get('csrf')?.toString());

    const userId = formData.get('userId')?.toString();
    if (!userId) throw new ValidationError('A person is required.');

    const isActive = formData.get('isActive')?.toString() === 'true';

    await container.users.setActive({
      userId,
      isActive,
      reason: formData.get('reason')?.toString() ?? '',
      actor,
    });

    revalidatePath('/users');
    return isActive ? 'Account reactivated.' : 'Account deactivated. They can no longer sign in.';
  });
}

// ---- Templates -------------------------------------------------------------

export async function uploadTemplateVersion(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('template:manage');
    await assertCsrf(formData.get('csrf')?.toString());

    const documentType = formData.get('documentType')?.toString() as DocumentType | undefined;
    const file = formData.get('file');

    if (!documentType) throw new ValidationError('A document type is required.');
    if (!(file instanceof File) || file.size === 0) throw new ValidationError('Choose a template file to upload.');

    const outcome = await container.templatePublishing.uploadDraft({
      documentType,
      fileName: file.name,
      content: Buffer.from(await file.arrayBuffer()),
      notes: formData.get('notes')?.toString(),
      actor,
    });

    revalidatePath('/templates');

    const warning =
      outcome.warnings.length > 0 ? ` ${outcome.warnings.length} warning(s) — review them before activating.` : '';

    return `Uploaded as draft v${outcome.versionNumber}; ${outcome.replacements} placeholder(s) rewritten. Another administrator must activate it.${warning}`;
  });
}

export async function activateTemplateVersion(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('template:publish');
    await assertCsrf(formData.get('csrf')?.toString());

    const templateVersionId = formData.get('templateVersionId')?.toString();
    if (!templateVersionId) throw new ValidationError('A template version is required.');

    const outcome = await container.templatePublishing.activate({ templateVersionId, actor });

    revalidatePath('/templates');
    return outcome.retiredVersionNumber === null
      ? 'Activated. This document type can now be generated.'
      : `Activated. v${outcome.retiredVersionNumber} is retired; documents already generated from it are unchanged.`;
  });
}

export async function discardTemplateDraft(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('template:manage');
    await assertCsrf(formData.get('csrf')?.toString());

    const templateVersionId = formData.get('templateVersionId')?.toString();
    if (!templateVersionId) throw new ValidationError('A template version is required.');

    await container.templatePublishing.discardDraft({
      templateVersionId,
      reason: formData.get('reason')?.toString() ?? '',
      actor,
    });

    revalidatePath('/templates');
    return 'Draft discarded.';
  });
}

export async function uploadSourceDocument(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('source_document:select');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const kind = formData.get('kind')?.toString() as UploadableKind | undefined;
    const file = formData.get('file');

    if (!engagementId) throw new ValidationError('An engagement is required.');
    if (!kind || !UPLOADABLE_KINDS.includes(kind)) throw new ValidationError('Choose what this document is.');
    if (!(file instanceof File) || file.size === 0) throw new ValidationError('Choose a file to upload.');

    // The browser's reported type is a hint; the extension decides what we
    // claim, and `DocumentStore.put` then checks the bytes really are that.
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    const mimeType = MIME_BY_EXTENSION[extension];
    if (!mimeType) throw new ValidationError('Only .docx and .pdf files are accepted.');

    const result = await container.sourceDocuments.upload({
      engagementId,
      actorId: actor.id,
      fileName: file.name,
      mimeType,
      content: new Uint8Array(await file.arrayBuffer()),
      kind,
    });

    // Reading it is queued: extraction converts a PDF, runs the deterministic
    // patterns and then hands over to preparation, which is too slow for a
    // request and must survive a restart.
    if (!result.duplicate) {
      await container.queue.enqueue({
        jobType: 'EXTRACT_DOCUMENT_TEXT',
        idempotencyKey: `extract_${engagementId}_${result.sourceDocumentId}`,
        payload: { engagementId, sourceDocumentId: result.sourceDocumentId, actorId: actor.id },
        engagementId,
        correlationId: newCorrelationId(),
      });
    }

    revalidatePath(`/engagements/${engagementId}`);

    if (result.duplicate) {
      return 'This exact file is already attached to this engagement; nothing was changed.';
    }

    const score =
      result.verificationScore === null
        ? 'Its contents were not scored, because this kind is not an engagement letter.'
        : // Not monetary arithmetic: this formats a confidence score for a message.
          // eslint-disable-next-line no-restricted-syntax
          `Content verification scored it ${Math.round(result.verificationScore * 100)}%.`;

    const message = `Attached ${file.name}. ${score} Reading it has been queued.`;

    const details = [...result.notes, ...result.disqualifiers];
    return details.length > 0 ? { message, blockers: details } : message;
  });
}

/**
 * Changes a date rule.
 *
 * A date rule is the firm's interpretation of a statutory deadline, so this is
 * deliberately not a quiet settings toggle: it needs the administrator role, a
 * written reason, and it records the whole definition before and after. Dates a
 * reviewer has already confirmed are never rewritten; the rest are recalculated
 * the next time their engagement is prepared.
 */
export async function updateDateRule(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('date_rule:manage');
    await assertCsrf(formData.get('csrf')?.toString());

    const code = formData.get('code')?.toString();
    const definitionJson = formData.get('definition')?.toString();

    if (!code) throw new ValidationError('A date rule is required.');
    if (!definitionJson) throw new ValidationError('The rule definition was not submitted.');

    let definition: unknown;
    try {
      definition = JSON.parse(definitionJson);
    } catch {
      throw new ValidationError('The rule definition was not readable. Reload the page and try again.');
    }

    const result = await container.dateRules.update({
      code,
      actorId: actor.id,
      reason: formData.get('reason')?.toString() ?? '',
      label: formData.get('label')?.toString() ?? '',
      notes: formData.get('notes')?.toString() ?? null,
      isActive: formData.get('isActive') === 'yes',
      requiresConfirmation: formData.get('requiresConfirmation') === 'yes',
      definition,
    });

    revalidatePath('/date-rules');
    revalidatePath(`/date-rules/${code}`);

    const parts = [`Saved ${code}.`];
    if (result.impact.pendingRecalculation > 0) {
      parts.push(
        `${result.impact.pendingRecalculation} unconfirmed date(s) will be recalculated the next time their engagement is prepared.`,
      );
    }
    if (result.impact.confirmed > 0) {
      parts.push(`${result.impact.confirmed} already-confirmed date(s) are left as they are.`);
    }

    return parts.join(' ');
  });
}

/**
 * Creates or changes a pricing rule.
 *
 * The annual increase is the number a partner is most likely to revisit, so it
 * belongs in the application rather than the database. Like a date rule this is
 * an administrator action with a written reason, and it records the rule on both
 * sides. A fee somebody already approved is never revisited — an approval is a
 * decision about a specific number, not about the rule that produced it.
 */
export async function saveFeeRule(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('pricing_rule:manage');
    await assertCsrf(formData.get('csrf')?.toString());

    const text = (name: string): string | null => formData.get(name)?.toString().trim() || null;

    const result = await container.feeRules.save({
      id: text('id'),
      actorId: actor.id,
      reason: formData.get('reason')?.toString() ?? '',
      level: (text('level') ?? 'GLOBAL') as FeeRuleLevel,
      engagementType: text('engagementType') as EngagementType | null,
      feeKind: text('feeKind') as FeeKind | null,
      clientId: text('clientId'),
      clientGroup: text('clientGroup'),
      partnerUserId: text('partnerUserId'),
      method: (text('method') ?? 'PERCENTAGE') as FeeMethod,
      percentage: text('percentage'),
      fixedAmount: text('fixedAmount'),
      exactTarget: text('exactTarget'),
      skipRounding: formData.get('skipRounding') === 'yes',
      appliesToAncillaryCharges: formData.get('appliesToAncillaryCharges') === 'yes',
      effectiveFrom: text('effectiveFrom'),
      effectiveTo: text('effectiveTo'),
      isActive: formData.get('isActive') === 'yes',
      description: text('description'),
    });

    revalidatePath('/pricing-rules');
    revalidatePath(`/pricing-rules/${result.id}`);

    const parts = [result.created ? 'Pricing rule created.' : 'Pricing rule saved.'];
    if (result.impact.pendingRecalculation > 0) {
      parts.push(
        `${result.impact.pendingRecalculation} unapproved fee(s) will be recalculated the next time their engagement is prepared.`,
      );
    }
    if (result.impact.approved > 0) {
      parts.push(`${result.impact.approved} already-approved fee(s) are left as they are.`);
    }

    return parts.join(' ');
  });
}

/**
 * Clearing a notification.
 *
 * Scoped to the reader in the service, not merely here: a notification id is
 * not a capability, and one person must not be able to clear another's list by
 * guessing one.
 */
export async function markNotificationRead(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireUser();
    await assertCsrf(formData.get('csrf')?.toString());

    const notificationId = formData.get('notificationId')?.toString();
    if (!notificationId) throw new ValidationError('A notification is required.');

    await container.userNotifications.markRead(notificationId, actor.id);
    revalidatePath('/notifications');
    return { ok: true, message: 'Marked read.' };
  });
}

export async function markAllNotificationsRead(): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireUser();
    const { cleared } = await container.userNotifications.markAllRead(actor.id);
    revalidatePath('/notifications');
    return { ok: true, message: cleared === 0 ? 'Nothing was unread.' : `Marked ${cleared} read.` };
  });
}

/**
 * Records a signature obtained outside this application.
 *
 * The bridge for a firm holding Acrobat Pro rather than Acrobat Sign Solutions:
 * the letter is signed by whatever means the firm already uses, and the signed
 * document is brought back here so the engagement can be completed. Nothing
 * about review changes — the engagement is already past final approval — but
 * the provenance is recorded permanently and is never mistaken for a signature
 * Adobe witnessed.
 */
export async function recordExternalSignature(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('signing:record_external');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const documentVersionId = formData.get('documentVersionId')?.toString();
    const method = formData.get('method')?.toString();
    const signedOn = formData.get('signedOn')?.toString();
    const reason = formData.get('reason')?.toString() ?? '';
    const file = formData.get('evidence');

    if (!engagementId || !documentVersionId) throw new ValidationError('A document version is required.');
    if (!method || !EXTERNAL_SIGNATURE_METHODS.includes(method as ExternalSignatureMethod)) {
      throw new ValidationError('Choose how the letter was signed.');
    }
    if (!signedOn || !/^\d{4}-\d{2}-\d{2}$/.test(signedOn)) {
      throw new ValidationError('Give the date the client signed.');
    }
    if (!(file instanceof File) || file.size === 0) {
      throw new ValidationError('Attach the signed document.');
    }

    // Every confirmed signer arrives as a separate checkbox of the same name.
    const confirmedSignerIds = formData.getAll('signer').map((value) => value.toString());

    const result = await container.externalSignature.record({
      engagementId,
      documentVersionId,
      actor,
      method: method as ExternalSignatureMethod,
      signedOn,
      reason,
      confirmedSignerIds,
      evidence: {
        fileName: file.name,
        mimeType: 'application/pdf',
        content: new Uint8Array(await file.arrayBuffer()),
      },
      correlationId: newCorrelationId(),
    });

    // Filing it into Karbon is queued rather than done here: it is a network
    // call to a vendor, it must survive a restart, and it must retry. Until it
    // runs, the signed letter exists only in this application's document store
    // — which on a container platform is reclaimed on the next deploy unless a
    // volume is attached.
    if (!result.duplicate) {
      await container.queue.enqueue({
        jobType: 'FILE_EXTERNAL_SIGNATURE',
        idempotencyKey: `file_external_signature_${result.externalSignatureId}`,
        payload: { externalSignatureId: result.externalSignatureId },
        engagementId,
        documentVersionId,
      });
    }

    revalidatePath(`/engagements/${engagementId}`);

    return result.duplicate
      ? 'That document is already recorded against this engagement; nothing was changed.'
      : 'Signature recorded, and filing it into Karbon has been queued. The file shows it was signed outside this application.';
  });
}

/**
 * Brings the firm's clients in from Karbon.
 *
 * Without it, populating a firm with hundreds of T1s meant typing them into a
 * form one at a time — the kind of task nobody finishes, leaving an application
 * nobody can use. It never overwrites a client already here: Karbon is the
 * system of record for documents, not for the details that go into a legal
 * document, and somebody may have corrected those deliberately.
 */
export async function importClientsFromKarbon(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('engagement:create');
    await assertCsrf(formData.get('csrf')?.toString());

    const dryRun = formData.get('dryRun')?.toString() !== 'false';
    const providers = await container.providers();

    const result = await container.clientImport.run({
      karbon: providers.karbon,
      actor,
      dryRun,
      correlationId: newCorrelationId(),
    });

    revalidatePath('/clients');

    const parts = [
      `${result.found} client(s) found in Karbon.`,
      dryRun
        ? `${result.created.length} would be added.`
        : `${result.created.length} added.`,
      `${result.unchanged} already here and matching.`,
    ];
    if (result.backfilled.length > 0) {
      // Said separately from "differ and were left alone", because they are
      // opposites and a reader needs to tell them apart: this is what changed
      // on a client already here, that is what deliberately did not.
      const contacts = result.backfilled.reduce((total, row) => total + row.contactsAdded, 0);
      const filled = dryRun ? 'would have blanks filled' : 'had blanks filled';
      parts.push(
        `${result.backfilled.length} ${filled}${contacts > 0 ? `, adding ${contacts} contact(s)` : ''}.`,
      );
    }
    if (result.differing.length > 0) parts.push(`${result.differing.length} differ and were left alone.`);
    if (result.failed.length > 0) parts.push(`${result.failed.length} could not be read.`);

    // The reasons, not just the count. A number with no explanation is a
    // mystery somebody has to come back and investigate; the client that could
    // not be read is a client no engagement can be started for, and the cause
    // is usually specific and actionable.
    const blockers = [...result.notes, ...result.failed.map((entry) => `${entry.entityKey}: ${entry.reason}`)];

    return { ok: true, message: parts.join(' '), blockers };
  });
}

/**
 * Catalogues every document Karbon holds for a client.
 *
 * Queued rather than done here: a client with years of history means tens of
 * file-list requests against a rate-limited API, which is well past what a
 * request should hold open.
 */
export async function syncClientDocuments(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    await requirePermission('source_document:select');
    await assertCsrf(formData.get('csrf')?.toString());

    const clientId = formData.get('clientId')?.toString();
    if (!clientId) throw new ValidationError('A client is required.');

    const client = await container.prisma.client.findUnique({
      where: { id: clientId },
      select: { legalName: true, karbonEntityKey: true },
    });

    if (!client) throw new ValidationError('That client no longer exists.');
    if (!client.karbonEntityKey) {
      throw new PreconditionError(
        `${client.legalName} is not linked to Karbon, so there is no document area to read. Import the client from Karbon, or set its entity key, first.`,
      );
    }

    const result = await container.queue.enqueue({
      jobType: 'SYNC_CLIENT_DOCUMENTS',
      // Time-based on purpose: re-reading is how the catalogue stays current,
      // so asking twice must mean looking twice.
      idempotencyKey: `sync_client_documents_${clientId}_${Date.now()}`,
      payload: { clientId },
      correlationId: newCorrelationId(),
    });

    revalidatePath(`/clients/${clientId}`);

    return result.deduplicated
      ? 'A document sync for this client is already running.'
      : `Reading ${client.legalName}'s documents from Karbon. Its work items are read one at a time, so a long-standing client takes a minute.`;
  });
}

/**
 * Pulls one catalogued Karbon document into an engagement as a source document.
 *
 * The bytes are fetched now, from a fresh listing. The download token Karbon
 * issued when the catalogue was built expired about fifteen minutes later, so
 * there is nothing stored to reuse and re-listing is not an inefficiency.
 *
 * What arrives is scored exactly as an uploaded file is. Being filed in Karbon
 * against this client is evidence about a document, not proof of what it is —
 * a folder can hold the wrong year, and a signed T2 letter sitting in a client's
 * area is still the wrong document for their T1.
 */
export async function importKarbonDocument(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('source_document:select');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const documentId = formData.get('karbonDocumentId')?.toString();
    const kind = formData.get('kind')?.toString() as UploadableKind | undefined;

    if (!engagementId) throw new ValidationError('An engagement is required.');
    if (!documentId) throw new ValidationError('A document is required.');
    if (!kind || !UPLOADABLE_KINDS.includes(kind)) throw new ValidationError('Choose what this document is.');

    const catalogued = await container.prisma.karbonClientDocument.findUnique({
      where: { id: documentId },
      select: {
        karbonFileKey: true,
        fileName: true,
        sourceEntityType: true,
        sourceEntityKey: true,
        sourceLabel: true,
      },
    });

    if (!catalogued) throw new ValidationError('That document is no longer in the catalogue.');

    const providers = await container.providers();

    // Scoped to the entity that holds the file: Karbon issues a download token
    // only alongside that entity's listing, so the scope is not optional.
    const scope =
      catalogued.sourceEntityType === 'WorkItem'
        ? { workItemKey: catalogued.sourceEntityKey }
        : { entityKey: catalogued.sourceEntityKey };

    const downloaded = await providers.karbon.downloadDocument(catalogued.karbonFileKey, scope);

    const result = await container.sourceDocuments.upload({
      engagementId,
      actorId: actor.id,
      fileName: downloaded.fileName || catalogued.fileName,
      mimeType: downloaded.mimeType,
      content: new Uint8Array(downloaded.content),
      kind,
      karbonDocumentId: catalogued.karbonFileKey,
      karbonWorkItemKey: catalogued.sourceEntityType === 'WorkItem' ? catalogued.sourceEntityKey : null,
    });

    await container.queue.enqueue({
      jobType: 'EXTRACT_DOCUMENT_TEXT',
      idempotencyKey: `extract_${result.sourceDocumentId}`,
      payload: { engagementId, sourceDocumentId: result.sourceDocumentId, actorId: actor.id },
      engagementId,
      correlationId: newCorrelationId(),
    });

    revalidatePath(`/engagements/${engagementId}`);

    return `Brought ${catalogued.fileName} in from ${catalogued.sourceLabel}. It is being read now, and its contents are scored against this client and year before anything is used.`;
  });
}
