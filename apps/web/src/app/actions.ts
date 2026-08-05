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
} from '@element/shared';
import { factToken } from '@element/services';
import type { FeeRuleLevel } from '@element/database';
import { container } from '@/lib/container';
import { assertCsrf, requirePermission, requestContext } from '@/lib/session';

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

    const result = await container.preparation.prepare({
      engagementId,
      actorId: actor.id,
      correlationId: newCorrelationId(),
      highIncreaseThresholdPercent: threshold,
    });

    revalidatePath(`/engagements/${engagementId}`);

    const outstanding: string[] = [];
    if (result.conflictsRaised > 0) outstanding.push(`${result.conflictsRaised} conflicting value(s)`);
    if (result.blockedFees.length > 0) outstanding.push(`${result.blockedFees.length} fee(s) without a prior-year amount`);
    if (result.blockedDates.length > 0) outstanding.push(`${result.blockedDates.length} deadline(s) missing information`);

    const summary =
      `Prepared: ${result.feesCalculated.length} fee(s) calculated, ${result.datesCalculated} date(s) proposed, ` +
      `${result.serviceSelectionsSeeded} service selection(s) seeded.`;

    return outstanding.length > 0 ? `${summary} Needs your decision on ${outstanding.join(', ')}.` : summary;
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
