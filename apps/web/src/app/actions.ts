'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
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
import {
  describeDifferences,
  enqueuePriorYearSearch,
  karbonStatusTriggerSchema,
  maybeStartCoverLetter,
  summariseClientImport,
  factToken,
  type ClientImportSource,
  type IntegrationProviderKey,
  type PriorYearSearchOutcome,
} from '@element/services';
import type { FeeRuleLevel, ParticipantRole } from '@element/database';
import { container } from '@/lib/container';
import { assertCsrf, extendSession, requirePermission, requireUser, requestContext } from '@/lib/session';

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

    // Doing something keeps you signed in. A Server Component cannot set a
    // cookie, so page rendering cannot extend a session — this wrapper is the
    // one place every mutation passes through, which makes it the place.
    //
    // After the action, not before: a session should not be extended by a
    // request that turned out to be refused.
    await extendSession();

    if (typeof outcome === 'string') return { ok: true, message: outcome };
    return { ok: true, message: outcome.message, ...(outcome.blockers?.length ? { blockers: outcome.blockers } : {}) };
  } catch (error) {
    // An expected refusal explains itself to the user. Anything else shows a
    // generic message on purpose — and must therefore reach the log, or it
    // leaves no trace anywhere at all.
    //
    // The generic message used to end there, saying an administrator held the
    // technical details. In this firm the person reading it *is* the
    // administrator, and it left them holding a failure with no thread to pull:
    // no time, no name, nothing to search the log for. So an unexpected failure
    // now carries a reference, logged alongside the cause.
    let reference: string | undefined;
    if (!(error instanceof AppError)) {
      reference = newCorrelationId();
      container.logger.error('Server action failed', {
        correlationId: reference,
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

    const message = reference
      ? `${toUserMessage(error)} Reference ${reference} — it is in the application log under that id.`
      : toUserMessage(error);

    return { ok: false, message, ...(blockers ? { blockers } : {}) };
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
      adobeSignMode: providers.adobeSignMode,
      correlationId: newCorrelationId(),
    });

    revalidatePath(`/engagements/${engagementId}`);

    if (result.deduplicated) {
      return 'An agreement already exists for this approved version; a duplicate was not created.';
    }

    // Never let a fabricated agreement read like a real one. The adapter is
    // named in every case rather than only outside Test Mode, because "Test
    // Mode" and "a mock" are different facts: a Test Mode send through a real
    // sandbox does reach Adobe and does email whoever is named on it.
    if (providers.adobeSign.isMock) {
      return `Agreement ${result.agreementId} was created with the ${providers.description.adobeSign}. Nothing reached Adobe and nobody was asked to sign — this id belongs to no real agreement.`;
    }

    return state.testMode
      ? `Test agreement ${result.agreementId} created with the ${providers.description.adobeSign}. It is a real Adobe agreement on the sandbox account, so whoever is named on it will receive it.`
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

    // The step that was missing entirely: READY_FOR_DELIVERY was where a cover
    // letter stopped. The package — this letter and every enclosure — now goes
    // to the client's own Karbon Documents tab.
    await container.queue.enqueue({
      jobType: 'DELIVER_COMPLETION_PACKAGE',
      idempotencyKey: `deliver_${coverLetterPackageId}`,
      payload: { coverLetterPackageId },
      correlationId: newCorrelationId(),
    });

    revalidatePath('/cover-letters');
    return 'Marked ready for delivery, and queued for filing into the client\'s Karbon documents. Cover letters are never sent through Adobe Sign.';
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
 * Queues the Karbon search for last year's engagement letter.
 *
 * The helper and its guards live in `@element/services` because the worker's
 * rollover needs exactly the same ones, and a private second copy is how two
 * callers quietly stop agreeing. This wrapper supplies the container and
 * nothing else.
 */
function priorYearSearch(
  engagementId: string,
  correlationId: string,
  options: { force?: boolean } = {},
): Promise<PriorYearSearchOutcome> {
  return enqueuePriorYearSearch(
    { prisma: container.prisma, queue: container.queue },
    engagementId,
    correlationId,
    options,
  );
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

    const outcome = await priorYearSearch(engagementId, newCorrelationId(), { force: true });
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
    const search = await priorYearSearch(engagementId, correlationId);

    revalidatePath(`/engagements/${engagementId}`);

    const outstanding: string[] = [];
    if (result.conflictsRaised > 0) outstanding.push(`${result.conflictsRaised} conflicting value(s)`);
    if (result.blockedFees.length > 0) outstanding.push(`${result.blockedFees.length} fee(s) without a prior-year amount`);
    if (result.blockedDates.length > 0) outstanding.push(`${result.blockedDates.length} deadline(s) missing information`);
    if (result.signerNotes.length > 0) outstanding.push(`${result.signerNotes.length} signer question(s)`);

    const searchNote = search.enqueued
      ? search.deduplicated
        ? ' Karbon has already been searched for last year’s letter.'
        : ' Searching Karbon for last year’s letter.'
      : ` Last year’s letter was not searched for: ${search.reason ?? 'no reason given.'}`;

    const summary =
      `Prepared: ${result.feesCalculated.length} fee(s) calculated, ${result.datesCalculated} date(s) proposed, ` +
      `${result.serviceSelectionsSeeded} service selection(s) seeded` +
      (result.signersProposed > 0 ? `, ${result.signersProposed} signer(s) proposed` : '') +
      '.';

    const decisions = outstanding.length > 0 ? ` Needs your decision on ${outstanding.join(', ')}.` : '';

    // The signer questions are listed rather than counted: "one signer question"
    // is not something anybody can act on, and each one names a person.
    return {
      message: `${summary}${decisions}${searchNote}`,
      ...(result.signerNotes.length > 0 ? { blockers: result.signerNotes } : {}),
    };
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

    // Go and find last year's letter now, rather than waiting for somebody to
    // open the engagement and press Prepare.
    //
    // The search has always been the largest single thing this application can
    // do for a preparer — it reads the client's Karbon documents and scores each
    // one on its contents — and it started on a button, on a screen you had to
    // know to open first. Creating the engagement is the moment the answer is
    // wanted, and the work takes long enough that starting it a few minutes
    // earlier is most of the benefit.
    //
    // The guards live in `enqueuePriorYearSearch`: a client with no Karbon link
    // enqueues nothing and says so, and the key is stable per engagement, so
    // pressing Prepare afterwards does not search a second time.
    //
    // It also makes the two ways of creating an engagement agree. A rollover
    // started by Karbon already searches immediately, so until now one created
    // by hand behaved *less* automatically than one nobody asked for.
    const search = await priorYearSearch(result.engagementId, newCorrelationId());

    revalidatePath('/engagements');

    // Notes are informational, so they belong in the message rather than in
    // `blockers`, which means "things standing in your way".
    const parts = [`Engagement created. Open it at /engagements/${result.engagementId}.`];
    if (result.clientCreated) parts.push('A new client record was created.');
    parts.push(...result.notes);

    // A first-year client, or one not linked to Karbon, is an ordinary fact
    // rather than a failure — so it is reported in the same sentence as the
    // success, not raised as a blocker.
    parts.push(
      search.enqueued
        ? 'Searching Karbon for last year’s letter.'
        : `Karbon was not searched for last year’s letter: ${search.reason ?? 'no reason given.'}`,
    );

    return parts.join(' ');
  });
}

/**
 * Roles a person may be given on an engagement.
 *
 * Mirrors the database enum. A value not in this list is rejected rather than
 * stored — the same rule the upload kinds below follow.
 */
const PARTICIPANT_ROLES: readonly ParticipantRole[] = [
  'TAXPAYER_1',
  'TAXPAYER_2',
  'AUTHORIZED_SIGNING_OFFICER',
  'AUTHORIZED_REPRESENTATIVE',
  'FIRM_SIGNER',
  'ENGAGEMENT_LEAD',
  'CC_RECIPIENT',
];

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

/**
 * Which Karbon work item statuses start an engagement.
 *
 * `karbon_status_triggers` has existed since the first release and could only
 * ever be set by editing the database, so on every deployment it has been an
 * empty list. That is the whole reason the Karbon trigger path had never run:
 * not a bug in the code behind it, which is tested, but a setting nothing could
 * write. A capability nothing can reach is indistinguishable from one that was
 * never built.
 *
 * Each row is validated on read as well as on write, because the stored value
 * is JSON that a database edit can still reach — and `engagementType` now
 * decides which legal document type a rollover creates.
 */
export async function setKarbonStatusTriggers(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('integration:manage');
    await assertCsrf(formData.get('csrf')?.toString());

    const statuses = formData.getAll('status').map((value) => value.toString().trim());
    const workTypes = formData.getAll('workType').map((value) => value.toString().trim());
    const engagementTypes = formData.getAll('engagementType').map((value) => value.toString().trim());

    const rows = statuses
      // A row with no status is an empty line in the form, not a mistake.
      .map((status, index) => ({
        status,
        workType: workTypes[index] ?? '',
        engagementType: engagementTypes[index] ?? '',
      }))
      .filter((row) => row.status.length > 0);

    const triggers = rows.map((row, index) => {
      const parsed = karbonStatusTriggerSchema.safeParse(row);
      if (!parsed.success) {
        throw new ValidationError(
          `Trigger ${index + 1} is not valid: a status and an engagement type are both required.`,
        );
      }
      return parsed.data;
    });

    // Two triggers on the same work type and status would both match, and which
    // one won would depend on array order — meaning the engagement type a
    // client's letter is created as would depend on the order somebody happened
    // to type them in.
    const seen = new Set<string>();
    for (const trigger of triggers) {
      const key = `${trigger.workType.toLowerCase()}::${trigger.status.toLowerCase()}`;
      if (seen.has(key)) {
        throw new ValidationError(
          `Two triggers match the same work type and status (“${trigger.status}”). Remove one: which engagement type it created would otherwise depend on the order they were entered.`,
        );
      }
      seen.add(key);
    }

    await container.settings.set('karbon_status_triggers', triggers, actor);

    const context = await requestContext();
    await container.audit.record({
      eventType: 'CONFIGURATION_CHANGED',
      objectType: 'SystemSetting',
      objectId: 'karbon_status_triggers',
      userId: actor.id,
      afterValue: { triggers },
      ipAddress: context.ipAddress,
    });

    revalidatePath('/integrations');

    return triggers.length === 0
      ? 'All Karbon status triggers removed. Engagements will only start when somebody starts one.'
      : `${triggers.length} Karbon status trigger(s) saved. A work item reaching one of these statuses will roll the client's engagement forward.`;
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

/**
 * Removes an engagement entirely.
 *
 * `redirect` is called **outside** `run`, and has to be. It works by throwing,
 * so inside the callback the catch block would treat a successful deletion as
 * an unexpected failure, log a correlation id for it, and tell the user their
 * delete did not work — while the engagement was in fact gone.
 *
 * The redirect itself is not decoration either: `revalidatePath` alone would
 * re-render the engagement page, which now resolves to `notFound()`.
 */
export async function deleteEngagement(formData: FormData): Promise<ActionResult> {
  const result = await run(async () => {
    const actor = await requirePermission('engagement:delete');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    if (!engagementId) throw new ValidationError('An engagement is required.');

    await container.engagements.delete({
      engagementId,
      reason: formData.get('reason')?.toString() ?? '',
      actor,
    });

    revalidatePath('/engagements');
    return 'Engagement deleted. The audit log keeps a record of what it was.';
  });

  if (result.ok) redirect('/engagements');
  return result;
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

    // The final document this engagement was waiting for may have just
    // arrived. Quiet when it has not — this runs on every upload, and a line
    // per upload saying "still waiting" is noise rather than news.
    const started = await maybeStartCoverLetter(container.coverLetterAutostart, engagementId);

    const message = `Attached ${file.name}. ${score} Reading it has been queued.${
      started.started ? ' Everything the completion cover letter needs is now here, so it has started generating.' : ''
    }`;

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

/**
 * Clearing the whole list.
 *
 * Takes the form data solely to check the token, which is the only reason this
 * signature exists. It used to take no argument at all — while the form was
 * already sending a token, because `ActionForm` writes one into every form it
 * renders. Nothing read it.
 *
 * That is also why it compiled and why nobody noticed. `ActionForm` types its
 * action as `(formData: FormData) => …`, and TypeScript accepts a function of
 * no arguments wherever one of one argument is wanted. The check was not
 * bypassed; it was never written, and the type system had no way to say so.
 */
export async function markAllNotificationsRead(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requireUser();
    await assertCsrf(formData.get('csrf')?.toString());

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

    // Clients are derived from work items, so how many are examined decides how
    // much of the firm's book can be seen at all. The service reports when the
    // ceiling bound; without a control here that report was unactionable.
    const rawLimit = formData.get('limit')?.toString().trim();
    let limit: number | undefined;
    if (rawLimit) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new ValidationError('The number of records to examine must be a positive whole number.');
      }
      limit = parsed;
    }

    const rawSource = formData.get('source')?.toString();
    const source: ClientImportSource = rawSource === 'WORK_ITEMS' ? 'WORK_ITEMS' : 'CLIENT_LIST';
    const includeAllContactTypes = formData.get('includeAllContactTypes')?.toString() === 'true';

    const providers = await container.providers();

    if (!dryRun) {
      // Queued rather than done here. Every client created costs one read
      // against a rate-limited API, so a book of several hundred is minutes of
      // work — and a request that dies partway reports nothing at all. That is
      // what "Something went wrong" was: not an error anybody could read, but
      // the absence of one.
      //
      // The preconditions stay in the request, following `syncClientDocuments`:
      // a person who cannot import gets told why now, rather than by a job that
      // dies quietly minutes later.
      if (providers.karbon.isMock) {
        throw new PreconditionError(
          'Karbon is not connected, so there is nothing to import. The mock adapter would add fictional sample clients to the real client list, where nothing would distinguish them from the firm’s own.',
        );
      }

      // One import at a time. Two running together would draw on the same
      // Karbon budget and race to create the same clients — survivable, since
      // the import never duplicates, but it wastes an allowance that is the
      // scarce thing here.
      const running = await container.prisma.backgroundJob.findFirst({
        where: { jobType: 'IMPORT_CLIENTS_FROM_KARBON', status: { in: ['PENDING', 'RUNNING'] } },
        select: { id: true },
      });
      if (running) {
        return {
          message:
            'An import is already running. Watch it on System Jobs; starting a second would spend the same Karbon allowance twice.',
        };
      }

      const queued = await container.queue.enqueue({
        jobType: 'IMPORT_CLIENTS_FROM_KARBON',
        // Time-based on purpose: re-running is how a large import finishes, so
        // asking twice must mean importing twice.
        idempotencyKey: `import_clients_${Date.now()}`,
        payload: { actorId: actor.id, limit, source, includeAllContactTypes },
        correlationId: newCorrelationId(),
      });

      revalidatePath('/clients');

      return {
        message: queued.deduplicated
          ? 'An import is already queued.'
          : 'Importing from Karbon in the background. Clients are read one at a time against a rate-limited API, so several hundred takes a few minutes — reload this page to watch them arrive, or open System Jobs for the summary when it finishes.',
      };
    }

    const result = await container.clientImport.run({
      karbon: providers.karbon,
      actor,
      dryRun,
      limit,
      source,
      includeAllContactTypes,
      correlationId: newCorrelationId(),
    });

    revalidatePath('/clients');

    // The same summary the worker writes onto a queued import, so a preview and
    // a completed job cannot describe the same numbers differently.
    const blockers = [
      ...result.notes,
      ...result.failed.map((entry) => `${entry.entityKey}: ${entry.reason}`),
      ...describeDifferences(result.differing),
    ];

    return { message: summariseClientImport(result), blockers };
  });
}

/**
 * Replaces a client's stored legal name with the one Karbon holds.
 *
 * The counterpart to the import's refusal to overwrite. That refusal is right —
 * a name here may have been corrected on purpose — but it left the other case
 * with no remedy at all: a client stored under its storefront name would print
 * that way on every letter, and nothing in the application could change it.
 */
export async function adoptKarbonLegalName(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('client:correct');
    await assertCsrf(formData.get('csrf')?.toString());

    const clientId = formData.get('clientId')?.toString();
    if (!clientId) throw new ValidationError('A client is required.');

    const result = await container.clientDirectory.adoptKarbonLegalName({ clientId, actor });

    revalidatePath('/clients');
    revalidatePath(`/clients/${clientId}`);

    return `Legal name changed from “${result.previousLegalName}” to “${result.legalName}”.${
      result.displayNameFilled ? ` “${result.displayNameFilled}” was kept as the trade name.` : ''
    }`;
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
/**
 * Chooses one of the candidates the Karbon search ranked.
 *
 * The search does the right thing when it cannot decide: it writes every
 * candidate with its score and the signals behind it, moves the engagement to
 * `SOURCE_DOCUMENT_REVIEW_REQUIRED`, and asks. What it could not do was take an
 * answer. Nothing anywhere wrote `source_document.confirmed_at` — there were
 * confirm actions for service selections, extracted fields and calculated
 * dates, and none for the document all of those are derived from. The reviewer
 * was shown a ranked list, a **Confirmed** column reading "No" on every row,
 * and no way to change it; the only way on was to re-attach the same file from
 * the catalogue, which produced a second row for a document already listed.
 *
 * Confirming is a choice, not a verdict on the contents. The verification score
 * stays exactly as it was scored — the service's own rule holds here too:
 * *"Choosing a file is a deliberate act, but it is not evidence about what the
 * file contains."* What changes is that a person has taken responsibility for
 * it, and that is recorded against their name.
 *
 * Extraction is enqueued by `karbonDocumentId` rather than by the row id, which
 * is the same branch the confident path takes. That branch re-downloads through
 * the Karbon scope on the source row, so no bytes need storing here — the
 * locate job keeps metadata and discards content by design.
 */
export async function useSourceDocumentCandidate(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('source_document:select');
    await assertCsrf(formData.get('csrf')?.toString());

    const sourceDocumentId = formData.get('sourceDocumentId')?.toString();
    if (!sourceDocumentId) throw new ValidationError('A document is required.');

    const document = await container.prisma.sourceDocument.findUnique({
      where: { id: sourceDocumentId },
      select: {
        id: true,
        engagementId: true,
        fileName: true,
        karbonDocumentId: true,
        karbonWorkItemKey: true,
        confirmedAt: true,
        engagement: { select: { status: true, client: { select: { karbonEntityKey: true } } } },
      },
    });

    if (!document) throw new ValidationError('That document is no longer attached to this engagement.');

    if (document.confirmedAt) {
      return `${document.fileName} is already the confirmed prior-year document for this engagement.`;
    }

    // Nothing to re-download it from. An attached file has its bytes in storage
    // and is read by row id instead, so this only bites a candidate whose
    // Karbon link has gone — and saying which link is missing is the difference
    // between a fixable message and a failed job.
    if (!document.karbonDocumentId) {
      throw new PreconditionError(
        `${document.fileName} carries no Karbon document id, so it cannot be read back from Karbon. Attach it by hand instead.`,
      );
    }

    if (!document.karbonWorkItemKey && !document.engagement.client.karbonEntityKey) {
      throw new PreconditionError(
        `Neither ${document.fileName} nor this client carries a Karbon key, so there is no entity to list the file under. Attach it by hand instead.`,
      );
    }

    const correlationId = newCorrelationId();

    await container.prisma.sourceDocument.update({
      where: { id: document.id },
      data: { confirmedAt: new Date(), confirmedByUserId: actor.id },
    });

    const context = await requestContext();
    await container.audit.record({
      eventType: 'SOURCE_DOCUMENT_SELECTED',
      objectType: 'SourceDocument',
      objectId: document.id,
      engagementId: document.engagementId,
      userId: actor.id,
      afterValue: { fileName: document.fileName, confirmedBy: actor.email },
      reason: 'A reviewer chose this document from the ranked candidates.',
      correlationId,
      ipAddress: context.ipAddress,
    });

    await container.workflow.transition({
      engagementId: document.engagementId,
      to: 'EXTRACTING_DATA',
      reason: `${document.fileName} was chosen from the candidates by ${actor.displayName}`,
      correlationId,
    });

    await container.queue.enqueue({
      jobType: 'EXTRACT_DOCUMENT_TEXT',
      idempotencyKey: `extract_${document.id}`,
      payload: {
        engagementId: document.engagementId,
        karbonDocumentId: document.karbonDocumentId,
        actorId: actor.id,
      },
      engagementId: document.engagementId,
      correlationId,
    });

    const started = await maybeStartCoverLetter(container.coverLetterAutostart, document.engagementId);

    revalidatePath(`/engagements/${document.engagementId}`);

    return `${document.fileName} is now the prior-year document for this engagement. It is being read; its values arrive as suggestions a reviewer still confirms.${
      started.started ? ' The completion cover letter has also started generating.' : ''
    }`;
  });
}

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

    const started = await maybeStartCoverLetter(container.coverLetterAutostart, engagementId);

    revalidatePath(`/engagements/${engagementId}`);

    return `Brought ${catalogued.fileName} in from ${catalogued.sourceLabel}. It is being read now, and its contents are scored against this client and year before anything is used.${
      started.started ? ' The completion cover letter has also started generating.' : ''
    }`;
  });
}

/**
 * Records who signs an engagement letter.
 *
 * Nothing in this application could create an `EngagementParticipant` before
 * this action existed. The table was written only by the demo seed, so on a
 * real engagement it was always empty — and `evaluateSendGate` refuses an
 * engagement with no signers. An approved letter therefore had nowhere to go,
 * by either route: Adobe Sign could not be asked, and the "record signed
 * elsewhere" bridge refused too, telling the reviewer this engagement "names
 * nobody who must sign" while offering no way to name anybody.
 */
export async function saveSigner(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('field:edit_structured');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const role = formData.get('role')?.toString() as ParticipantRole | undefined;
    const fullLegalName = formData.get('fullLegalName')?.toString();

    if (!engagementId) throw new ValidationError('An engagement is required.');
    if (!role || !PARTICIPANT_ROLES.includes(role)) throw new ValidationError('Choose what this person signs as.');
    if (!fullLegalName?.trim()) throw new ValidationError('A signer needs a full legal name.');

    const result = await container.participants.upsert({
      engagementId,
      actor,
      role,
      fullLegalName,
      email: formData.get('email')?.toString() ?? null,
      title: formData.get('title')?.toString() ?? null,
    });

    revalidatePath(`/engagements/${engagementId}`);

    return result.created
      ? `${fullLegalName.trim()} added. Confirm the address before this can be sent.`
      : `${fullLegalName.trim()} updated. The confirmation was cleared, because the details a reviewer approved have changed.`;
  });
}

/**
 * Vouches for a signer's name and address.
 *
 * A different permission from editing on purpose: typing a name is clerical,
 * and standing behind where a client's engagement letter will be sent is not.
 */
export async function confirmSigner(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('signing:send');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const participantId = formData.get('participantId')?.toString();
    const confirmed = formData.get('confirmed')?.toString() !== 'false';

    if (!engagementId || !participantId) throw new ValidationError('A signer is required.');

    await container.participants.confirm({ engagementId, participantId, actor, confirmed });
    revalidatePath(`/engagements/${engagementId}`);

    return confirmed ? 'Signer confirmed.' : 'Confirmation withdrawn.';
  });
}

export async function removeSigner(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('field:edit_structured');
    await assertCsrf(formData.get('csrf')?.toString());

    const engagementId = formData.get('engagementId')?.toString();
    const participantId = formData.get('participantId')?.toString();

    if (!engagementId || !participantId) throw new ValidationError('A signer is required.');

    await container.participants.remove({ engagementId, participantId, actor });
    revalidatePath(`/engagements/${engagementId}`);

    return 'Signer removed.';
  });
}

/**
 * Names the person who signs on the firm's behalf.
 *
 * `PreparationService` reads `firm_signer_user_id` to propose the FIRM_SIGNER
 * participant, and until now nothing wrote it. So the setting was permanently
 * unset, every preparation reported "No firm signer has been named", and the
 * firm-first signing order — the whole point of the ordering work — could not be
 * configured at all. The same defect as the read-only Signers tab: reachable to
 * read, unreachable to write.
 */
export async function setFirmSigner(formData: FormData): Promise<ActionResult> {
  return run(async () => {
    const actor = await requirePermission('system:manage_test_mode');
    await assertCsrf(formData.get('csrf')?.toString());

    const userId = formData.get('userId')?.toString() ?? '';
    const context = await requestContext();

    // An empty selection clears it, which is a legitimate choice — better than pointing
    // at somebody who has left the firm.
    if (!userId) {
      await container.settings.set('firm_signer_user_id', null, actor);
      await container.audit.record({
        eventType: 'CONFIGURATION_CHANGED',
        objectType: 'SystemSetting',
        objectId: 'firm_signer_user_id',
        userId: actor.id,
        afterValue: { firmSignerUserId: null },
        ipAddress: context.ipAddress,
      });
      revalidatePath('/settings');
      return 'The default firm signer has been cleared. Engagements will not propose one until it is set again.';
    }

    const signer = await container.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true, email: true, isActive: true },
    });

    if (!signer) throw new ValidationError('That user no longer exists.');
    if (!signer.isActive) {
      throw new ValidationError(
        `${signer.displayName} is not an active user, so they cannot be sent an agreement to sign.`,
      );
    }

    await container.settings.set('firm_signer_user_id', signer.id, actor);

    await container.audit.record({
      eventType: 'CONFIGURATION_CHANGED',
      objectType: 'SystemSetting',
      objectId: 'firm_signer_user_id',
      userId: actor.id,
      afterValue: { firmSignerUserId: signer.id, email: signer.email },
      ipAddress: context.ipAddress,
    });

    revalidatePath('/settings');

    // Existing engagements are deliberately left alone: their signers may have
    // been confirmed by a reviewer already, and a settings change must not
    // quietly re-point a letter somebody has approved.
    return `${signer.displayName} will be proposed as the firm signer on new engagements. Engagements already prepared keep the signer they have.`;
  });
}
