import { isUniqueConstraintError, type Prisma, type PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import type { AdobeSignProvider, AgreementState, AgreementStatus, KarbonProvider } from '@element/integrations';
import { DEFAULT_AGREEMENT_SETTINGS } from '@element/integrations';
import {
  NotFoundError,
  PreconditionError,
  adobeAgreementIdempotencyKey,
  assertCan,
  buildFileName,
  karbonUploadIdempotencyKey,
  sha256Hex,
  type Logger,
  type Principal,
} from '@element/shared';
import { parseManifest, type TemplateManifest } from '@element/documents';
import { evaluateSendGate, type GateResult } from '@element/workflows';
import type { JobQueue } from './jobs/queue.js';
import type { DocumentStore } from './storage.js';
import type { WorkflowService } from './workflow-service.js';
import type { NotificationService } from './notification-service.js';
import type { SettingsService } from './settings.js';

/**
 * Adobe Acrobat Sign orchestration.
 *
 * The idempotency key is derived from the client, engagement type, tax year,
 * approved document version and signing attempt. A retry at any layer — job
 * runner, network, or an impatient user clicking twice — resolves to the same
 * key and therefore the same agreement.
 */

export interface SigningServiceDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  store: DocumentStore;
  workflow: WorkflowService;
  settings: SettingsService;
  logger: Logger;
  notifications: NotificationService;
  /**
   * Needed so a completed webhook can ask for the signed document.
   *
   * Without it `processWebhook` could apply a status and nothing else, which is
   * how a signed letter used to stop dead: the poll was the only thing that
   * enqueued the retrieval, and its query excludes agreements already COMPLETED.
   * When the webhook arrived first — which it does — the poll then skipped that
   * agreement forever.
   */
  queue: JobQueue;
}

export interface SendForSignatureInput {
  engagementId: string;
  documentVersionId: string;
  actor: Principal;
  adobeSign: AdobeSignProvider;
  testMode: boolean;
  productionSendingEnabled: boolean;
  /** True when a real sandbox connection is configured. */
  sandboxConfigured: boolean;
  correlationId: string;
}

export class SigningService {
  constructor(private readonly deps: SigningServiceDeps) {}

  /**
   * The signature anchors of the template a version was rendered from.
   *
   * Returns null when the version predates template tracking, in which case the
   * gate simply cannot say which roles the letter demands. That is a weaker
   * check, not a false pass — `hasSignatureCopy` still blocks the send.
   */
  private async signatureManifest(
    templateVersionId: string | null,
  ): Promise<TemplateManifest | null> {
    if (!templateVersionId) return null;

    const templateVersion = await this.deps.prisma.templateVersion.findUnique({
      where: { id: templateVersionId },
      select: { manifest: true },
    });
    if (!templateVersion) return null;

    return parseManifest(templateVersion.manifest);
  }

  async evaluateSendGate(input: {
    engagementId: string;
    documentVersionId: string;
    testMode: boolean;
    productionSendingEnabled: boolean;
    sandboxConfigured: boolean;
  }): Promise<GateResult> {
    const [engagement, version, approval, participants] = await Promise.all([
      this.deps.prisma.engagement.findUniqueOrThrow({
        where: { id: input.engagementId },
        select: { status: true },
      }),
      this.deps.prisma.documentVersion.findUniqueOrThrow({ where: { id: input.documentVersionId } }),
      this.deps.prisma.approval.findFirst({
        where: {
          documentVersionId: input.documentVersionId,
          type: { in: ['FINAL_DOCUMENT', 'SEND_AUTHORIZATION'] },
          decision: 'APPROVED',
        },
      }),
      this.deps.prisma.engagementParticipant.findMany({
        where: { engagementId: input.engagementId, isSigner: true },
        orderBy: { signingOrder: 'asc' },
      }),
    ]);

    const report = (version.validationReport ?? { errorCount: 0 }) as { errorCount?: number };

    // Which roles the letter itself demands a signature from, and whether the
    // roster still matches the one the signature copy was rendered against.
    const manifest = await this.signatureManifest(version.templateVersionId);
    const requiredRoles = (manifest?.signatureAnchors ?? [])
      .filter((anchor) => anchor.required)
      .map((anchor) => anchor.role);

    const heldRoles = new Set(participants.map((participant) => participant.role));
    const snapshot = (version.renderedFieldValues ?? {}) as {
      signers?: { role: string; signingOrder: number }[];
    };

    return evaluateSendGate({
      status: engagement.status,
      hasApprovedPdf: version.status === 'APPROVED' && Boolean(version.generatedPdfReference),
      hasInternalApprovalEvent: Boolean(approval),
      signers: participants.map((participant) => ({
        name: participant.fullLegalName,
        email: participant.email ?? '',
        confirmed: participant.contactConfirmed,
        signingOrder: participant.signingOrder,
      })),
      signingOrderConfirmed: participants.length > 0 && participants.every((p) => p.contactConfirmed),
      validationErrorCount: report.errorCount ?? 0,
      hasSignatureCopy: Boolean(version.signaturePdfReference),
      unfilledSignatureRoles: requiredRoles.filter((role) => !heldRoles.has(role)),
      signersChangedSinceGeneration: rosterChanged(snapshot.signers, participants),
      testMode: input.testMode,
      productionSendingEnabled: input.productionSendingEnabled,
      sandboxConfigured: input.sandboxConfigured,
    });
  }

  async sendForSignature(input: SendForSignatureInput): Promise<{ agreementId: string; deduplicated: boolean }> {
    assertCan(input.actor, 'signing:send');

    const gate = await this.evaluateSendGate(input);
    if (!gate.ok) {
      throw new PreconditionError(`This document cannot be sent: ${gate.blockers.join(' ')}`, {
        blockers: gate.blockers,
      });
    }

    const engagement = await this.deps.prisma.engagement.findUniqueOrThrow({
      where: { id: input.engagementId },
      include: { client: true, participants: { where: { isSigner: true }, orderBy: { signingOrder: 'asc' } } },
    });

    const version = await this.deps.prisma.documentVersion.findUniqueOrThrow({
      where: { id: input.documentVersionId },
    });

    // Signing attempt increments only when a previous agreement is finished,
    // so a transport retry keeps the same key.
    const previousAttempts = await this.deps.prisma.adobeAgreement.count({
      where: { engagementId: input.engagementId },
    });
    const signingAttempt = previousAttempts + 1;

    const idempotencyKey = adobeAgreementIdempotencyKey({
      clientId: engagement.clientId,
      engagementType: engagement.engagementType,
      taxYear: engagement.taxYear,
      approvedDocumentVersionId: input.documentVersionId,
      signingAttempt,
    });

    // If this exact key already produced an agreement, return it unchanged.
    const existing = await this.deps.prisma.adobeAgreement.findUnique({ where: { idempotencyKey } });
    if (existing?.agreementId) {
      this.deps.logger.info('Adobe agreement already exists for this key; not creating another', {
        engagementId: input.engagementId,
        agreementId: existing.agreementId,
      });
      return { agreementId: existing.agreementId, deduplicated: true };
    }

    const title = buildFileName({
      year: engagement.taxYear,
      documentType: version.documentType,
      clientLegalName: engagement.client.legalName,
      role: 'APPROVED_PDF',
      testMode: input.testMode,
    }).replace(/\.pdf$/, '');

    // Ask Adobe whether this key already produced an agreement.
    //
    // The local check above only sees what this database recorded. If the row
    // was lost, or the process died between Adobe creating the agreement and the
    // id being written back, the local check finds nothing and a retry sends the
    // client a second copy of the same engagement letter. Adobe is the authority
    // on what Adobe holds.
    //
    // `findByExternalId` throws rather than returning null when the lookup
    // itself fails, so "could not check" stops the send instead of being read as
    // "none exists".
    const remote = await input.adobeSign.findByExternalId(idempotencyKey);
    if (remote) {
      this.deps.logger.warn('Adobe already holds an agreement for this key; adopting it rather than creating another', {
        engagementId: input.engagementId,
        agreementId: remote,
      });

      await this.deps.prisma.adobeAgreement.upsert({
        where: { idempotencyKey },
        create: {
          idempotencyKey,
          engagementId: input.engagementId,
          documentVersionId: input.documentVersionId,
          agreementId: remote,
          title,
          status: 'OUT_FOR_SIGNATURE',
          isTestMode: input.testMode,
        },
        update: { agreementId: remote },
      });

      return { agreementId: remote, deduplicated: true };
    }

    await this.deps.workflow.transition({
      engagementId: input.engagementId,
      to: 'SENDING_FOR_SIGNATURE',
      userId: input.actor.id,
      reason: 'Creating Adobe Sign agreement',
      correlationId: input.correlationId,
    });

    // The signature copy, not the draft.
    //
    // This used to read `generatedPdfReference` — the human-readable draft, whose
    // signature lines are rows of underscores. Adobe accepts such a document
    // without complaint and creates an agreement with no signature fields in it,
    // so the request went out looking correct and could never be signed. The
    // gate above refuses when this copy is missing, so by here it exists.
    const pdf = await this.deps.store.get(version.signaturePdfReference as string);

    // Queried separately, because `engagement.participants` above is filtered to
    // `isSigner: true` and an engagement lead is a CC recipient, not a signer.
    // Looking for one in the filtered list always found nothing, so the lead was
    // never copied on a single signature request — a silent omission, since an
    // empty CC list is indistinguishable from one nobody asked for.
    const lead = await this.deps.prisma.engagementParticipant.findFirst({
      where: { engagementId: input.engagementId, role: { in: ['ENGAGEMENT_LEAD', 'ENGAGEMENT_PARTNER'] } },
      orderBy: { role: 'asc' },
      select: { email: true },
    });
    const engagementLeadEmail = lead?.email ?? undefined;

    // Reserve the row before calling Adobe so a crash mid-call cannot lose the
    // key and allow a duplicate on the next attempt.
    const record = await this.deps.prisma.adobeAgreement.upsert({
      where: { idempotencyKey },
      create: {
        engagementId: input.engagementId,
        documentVersionId: input.documentVersionId,
        idempotencyKey,
        status: 'CREATED',
        title,
        signingAttempt,
        isTestMode: input.testMode,
        reminderFrequency: `Every ${DEFAULT_AGREEMENT_SETTINGS.reminderEveryBusinessDays} business days`,
        expiresAt: new Date(Date.now() + DEFAULT_AGREEMENT_SETTINGS.expiresInDays * 86_400_000),
        ccEmails: (engagementLeadEmail ? [engagementLeadEmail] : []) as never,
      },
      update: {},
    });

    try {
      const result = await input.adobeSign.createAgreement({
        idempotencyKey,
        title,
        pdf,
        fileName: `${title}.pdf`,
        signers: engagement.participants.map((participant) => ({
          role: participant.role as never,
          name: participant.fullLegalName,
          email: participant.email as string,
          order: participant.signingOrder,
          title: participant.title,
        })),
        ccEmails: engagementLeadEmail ? [engagementLeadEmail] : [],
        message: `Please review and sign the ${engagement.taxYear} engagement letter for ${engagement.client.legalName}.`,
        expiresInDays: DEFAULT_AGREEMENT_SETTINGS.expiresInDays,
        reminderEveryBusinessDays: DEFAULT_AGREEMENT_SETTINGS.reminderEveryBusinessDays,
        locale: DEFAULT_AGREEMENT_SETTINGS.locale,
        allowDelegation: DEFAULT_AGREEMENT_SETTINGS.allowDelegation,
        authenticationMethod: DEFAULT_AGREEMENT_SETTINGS.authenticationMethod,
        engagementType: engagement.engagementType,
      });

      await this.deps.prisma.$transaction([
        this.deps.prisma.adobeAgreement.update({
          where: { id: record.id },
          data: { agreementId: result.agreementId, status: 'OUT_FOR_SIGNATURE', sentAt: new Date() },
        }),
        this.deps.prisma.documentVersion.update({
          where: { id: input.documentVersionId },
          data: { status: 'SENT_FOR_SIGNATURE' },
        }),
        ...engagement.participants.map((participant) =>
          this.deps.prisma.adobeSigner.create({
            data: {
              agreementId: record.id,
              participantId: participant.id,
              name: participant.fullLegalName,
              email: participant.email as string,
              role: participant.role,
              signingOrder: participant.signingOrder,
              status: participant.signingOrder === engagement.participants[0]?.signingOrder
                ? 'OUT_FOR_SIGNATURE'
                : 'WAITING_FOR_OTHERS',
            },
          }),
        ),
      ]);

      await this.deps.workflow.transition({
        engagementId: input.engagementId,
        to: 'SENT_FOR_SIGNATURE',
        userId: input.actor.id,
        reason: `Adobe Sign agreement ${result.agreementId}`,
        correlationId: input.correlationId,
      });

      await this.deps.audit.record({
        eventType: 'ADOBE_AGREEMENT_SENT',
        objectType: 'AdobeAgreement',
        objectId: record.id,
        engagementId: input.engagementId,
        userId: input.actor.id,
        correlationId: input.correlationId,
        afterValue: {
          agreementId: result.agreementId,
          signerCount: engagement.participants.length,
          testMode: input.testMode,
          provider: input.adobeSign.name,
          deduplicated: result.deduplicated,
        },
      });

      return { agreementId: result.agreementId, deduplicated: result.deduplicated };
    } catch (error) {
      await this.deps.prisma.adobeAgreement.update({
        where: { id: record.id },
        data: { status: 'FAILED', failureReason: error instanceof Error ? error.message : String(error) },
      });
      await this.deps.workflow.transition({
        engagementId: input.engagementId,
        to: 'READY_TO_SEND',
        userId: input.actor.id,
        reason: 'Adobe Sign send failed; the approved document is unchanged and can be re-sent safely.',
        correlationId: input.correlationId,
      });
      throw error;
    }
  }

  /**
   * Applies an agreement state to the database.
   * Used by both webhook processing and the reconciliation poll.
   */
  async applyAgreementState(agreementId: string, state: AgreementState, correlationId?: string): Promise<void> {
    const record = await this.deps.prisma.adobeAgreement.findUnique({
      where: { agreementId },
      include: { signers: true },
    });
    if (!record) throw new NotFoundError(`Adobe agreement ${agreementId}`);

    for (const signer of state.signers) {
      const existing = record.signers.find((candidate) => candidate.email === signer.email);
      if (!existing) continue;
      await this.deps.prisma.adobeSigner.update({
        where: { id: existing.id },
        data: {
          status: signer.status,
          signedAt: signer.signedAt ? new Date(signer.signedAt) : existing.signedAt,
          viewedAt: signer.viewedAt ? new Date(signer.viewedAt) : existing.viewedAt,
        },
      });
    }

    await this.deps.prisma.adobeAgreement.update({
      where: { id: record.id },
      data: {
        status: state.status,
        completedAt: state.completedAt ? new Date(state.completedAt) : record.completedAt,
        declinedAt: state.status === 'DECLINED' ? new Date() : record.declinedAt,
        declineReason: state.declineReason ?? record.declineReason,
        expiredAt: state.status === 'EXPIRED' ? new Date() : record.expiredAt,
      },
    });

    const nextStatus = mapAgreementStatusToEngagementStatus(state.status);
    if (nextStatus) {
      const current = await this.deps.workflow.currentStatus(record.engagementId);
      if (current !== nextStatus) {
        await this.deps.workflow.transition({
          engagementId: record.engagementId,
          to: nextStatus,
          reason: `Adobe Sign reported ${state.status}`,
          correlationId,
        });

        // Only on the transition, so the reconciliation poll re-observing a
        // signature it already saw does not announce it twice.
        await this.announce(record.engagementId, state.status);
      }
    }

    await this.deps.audit.record({
      eventType: 'ADOBE_SIGNING_EVENT',
      objectType: 'AdobeAgreement',
      objectId: record.id,
      engagementId: record.engagementId,
      correlationId: correlationId ?? null,
      afterValue: {
        status: state.status,
        signers: state.signers.map((signer) => ({ email: signer.email, status: signer.status })),
      },
    });
  }


  /**
   * Tells the people responsible for an engagement that its signing state
   * changed in a way they would want to know about.
   *
   * Silence was the previous behaviour: the client signed, the documents were
   * filed, the audit trail recorded it, and the first a human knew was the next
   * time somebody opened the engagement. A declined or expired agreement was
   * worse — that is work that has stopped, and nothing said so.
   *
   * Failing to notify never fails the signing. A notice is a courtesy on top of
   * the record; losing one must not roll back a signature that genuinely
   * happened.
   */
  private async announce(engagementId: string, status: AgreementStatus): Promise<void> {
    // Keyed on the vendor's word, but the event type is the *meaning*. Adobe
    // says both SIGNED and COMPLETED for a letter that has been signed, and
    // deriving the event type from the vendor's word (`SIGNING_${status}`)
    // made those two different kinds of news: deduplication could not see one
    // as the other, so a poll reporting COMPLETED after a webhook reported
    // SIGNED told everybody a second time about one signature.
    const signed = {
      eventType: 'SIGNING_SIGNED',
      title: 'Engagement letter signed',
      body: 'The client has signed. The signed document and its certificate are being filed into Karbon.',
    };

    const announcements: Partial<Record<AgreementStatus, { eventType: string; title: string; body: string }>> = {
      SIGNED: signed,
      COMPLETED: signed,
      DECLINED: {
        eventType: 'SIGNING_DECLINED',
        title: 'Engagement letter declined',
        body: 'The client declined to sign. Nothing further happens automatically — this needs somebody to decide what to do.',
      },
      EXPIRED: {
        eventType: 'SIGNING_EXPIRED',
        title: 'Engagement letter expired',
        body: 'The signature request expired before the client signed. It is not resent automatically.',
      },
    };

    const announcement = announcements[status];
    if (!announcement) return;

    try {
      const engagement = await this.deps.prisma.engagement.findUnique({
        where: { id: engagementId },
        select: {
          assignedPreparerId: true,
          assignedReviewerId: true,
          finalApproverId: true,
          taxYear: true,
          engagementType: true,
          client: { select: { legalName: true } },
        },
      });
      if (!engagement) return;

      await this.deps.notifications.notify({
        userIds: [engagement.assignedPreparerId, engagement.assignedReviewerId, engagement.finalApproverId],
        eventType: announcement.eventType,
        title: `${announcement.title}: ${engagement.client.legalName}`,
        body: `${engagement.engagementType} ${engagement.taxYear}. ${announcement.body}`,
        link: `/engagements/${engagementId}`,
        engagementId,
        deduplicate: true,
      });
    } catch (error) {
      this.deps.logger.error('Could not raise a signing notification', {
        engagementId,
        status,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Processes a webhook exactly once.
   * A duplicate delivery of the same provider event id is recorded and ignored.
   */
  async processWebhook(input: {
    rawBody: string;
    headers: Record<string, string | undefined>;
    adobeSign: AdobeSignProvider;
    correlationId: string;
  }): Promise<{ handled: boolean; duplicate: boolean; reason?: string }> {
    if (!input.adobeSign.verifyWebhook(input.rawBody, input.headers)) {
      return { handled: false, duplicate: false, reason: 'Signature verification failed.' };
    }

    const event = input.adobeSign.parseWebhook(input.rawBody);
    if (!event || !event.eventId) {
      return { handled: false, duplicate: false, reason: 'Malformed webhook payload.' };
    }

    const linkedAgreement = event.agreementId
      ? await this.deps.prisma.adobeAgreement.findUnique({
          where: { agreementId: event.agreementId },
          select: { id: true },
        })
      : null;

    // The unique constraint on providerEventId is what actually makes this
    // exactly-once, even if two deliveries arrive concurrently.
    try {
      await this.deps.prisma.adobeEvent.create({
        data: {
          providerEventId: event.eventId,
          eventType: event.eventType,
          payload: event.raw as Prisma.InputJsonValue,
          signatureValid: true,
          agreementId: linkedAgreement?.id ?? null,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { handled: false, duplicate: true, reason: 'This event has already been processed.' };
      }
      throw error;
    }

    if (!event.agreementId) {
      return { handled: false, duplicate: false, reason: 'The event carried no agreement id.' };
    }

    const state = await input.adobeSign.getAgreement(event.agreementId);
    if (!state) {
      return { handled: false, duplicate: false, reason: 'The agreement could not be read back from Adobe Sign.' };
    }

    await this.applyAgreementState(event.agreementId, state, input.correlationId);

    // Signed means go and fetch it.
    //
    // This used to end at `applyAgreementState`, so the engagement reached
    // SIGNED and stopped. The poll was the only thing that ever enqueued the
    // retrieval, and its query covers CREATED / OUT_FOR_SIGNATURE /
    // PARTIALLY_SIGNED only — so once the webhook had moved the agreement to
    // COMPLETED, the poll skipped it forever. The signed PDF was never
    // downloaded and never reached Karbon, while the staff notification said it
    // "is being filed into Karbon".
    //
    // The idempotency key is the same one the poll uses, so whichever arrives
    // first wins and the other is deduplicated rather than fetching twice.
    if (state.status === 'COMPLETED' || state.status === 'SIGNED') {
      await this.deps.queue.enqueue({
        jobType: 'RETRIEVE_SIGNED_DOCUMENTS',
        idempotencyKey: `signed_${event.agreementId}`,
        payload: { agreementId: event.agreementId },
        correlationId: input.correlationId,
      });
    }

    await this.deps.prisma.adobeEvent.update({
      where: { providerEventId: event.eventId },
      data: { processedAt: new Date() },
    });

    return { handled: true, duplicate: false };
  }

  /**
   * Retrieves the signed PDF and signing certificate and returns both to
   * Karbon. Verifies the agreement really belongs to this engagement first.
   */
  async returnSignedDocumentsToKarbon(input: {
    agreementId: string;
    adobeSign: AdobeSignProvider;
    karbon: KarbonProvider;
    correlationId: string;
  }): Promise<{ signedUploaded: boolean; certificateUploaded: boolean; messages: string[] }> {
    const record = await this.deps.prisma.adobeAgreement.findUnique({
      where: { agreementId: input.agreementId },
      include: {
        engagement: { include: { client: true, karbonWorkItem: true } },
        documentVersion: true,
        // Who signed and when — the note below reports it, so a reader of the
        // Karbon work item can see it without opening Adobe.
        signers: { orderBy: { signingOrder: 'asc' } },
      },
    });

    if (!record) throw new NotFoundError(`Adobe agreement ${input.agreementId}`);

    // The agreement must match the engagement it claims to belong to.
    if (record.documentVersion.engagementId !== record.engagementId) {
      throw new PreconditionError('The agreement does not belong to this engagement. Nothing was uploaded.');
    }

    const workItemKey = record.engagement.karbonWorkItem?.karbonKey;
    const messages: string[] = [];
    if (!workItemKey) {
      return {
        signedUploaded: false,
        certificateUploaded: false,
        messages: ['This engagement has no linked Karbon work item, so the signed files were not uploaded.'],
      };
    }

    const [signedPdf, certificate] = await Promise.all([
      input.adobeSign.downloadSignedPdf(input.agreementId),
      input.adobeSign.downloadAuditReport(input.agreementId),
    ]);

    const signedName = buildFileName({
      year: record.engagement.taxYear,
      documentType: record.documentVersion.documentType,
      clientLegalName: record.engagement.client.legalName,
      role: 'SIGNED_PDF',
      testMode: record.isTestMode,
    });
    const certificateName = buildFileName({
      year: record.engagement.taxYear,
      documentType: record.documentVersion.documentType,
      clientLegalName: record.engagement.client.legalName,
      role: 'SIGNING_CERTIFICATE',
      testMode: record.isTestMode,
    });

    const signedUpload = await input.karbon.uploadDocument({
      workItemKey,
      fileName: signedName,
      content: signedPdf,
      mimeType: 'application/pdf',
      idempotencyKey: karbonUploadIdempotencyKey({
        karbonWorkItemKey: workItemKey,
        documentVersionId: record.documentVersionId,
        fileRole: 'SIGNED_PDF',
      }),
      // A signed document is never overwritten.
      neverOverwrite: true,
    });

    const certificateUpload = await input.karbon.uploadDocument({
      workItemKey,
      fileName: certificateName,
      content: certificate,
      mimeType: 'application/pdf',
      idempotencyKey: karbonUploadIdempotencyKey({
        karbonWorkItemKey: workItemKey,
        documentVersionId: record.documentVersionId,
        fileRole: 'SIGNING_CERTIFICATE',
      }),
      neverOverwrite: true,
    });

    if (signedUpload.message) messages.push(signedUpload.message);
    if (certificateUpload.message) messages.push(certificateUpload.message);

    // A mock adapter answers SUCCEEDED with an id from an in-memory map that
    // dies with the process. Recording it would mark the signed letter as filed
    // in Karbon when nothing was filed anywhere — and because the poll's safety
    // net keys on this column being null, a fabricated id would also switch off
    // the only thing that would ever retry it. Same rule as
    // `external-signature-service.ts:371`.
    const reallyFiled = !input.karbon.isMock;

    if (!reallyFiled) {
      messages.push(
        'Karbon is not connected, so these were filed to the mock adapter only. The signed letter still exists nowhere but this application, and filing will be retried once Karbon is connected.',
      );
    }

    // Keep the bytes regardless of what Karbon did with them.
    //
    // Previously they were downloaded, hashed, uploaded and dropped. If the
    // upload failed, or the engagement had no linked work item, the one document
    // proving a client accepted a fee existed nowhere at all.
    const scope = record.engagementId.replace(/-/g, '');
    const [storedSigned, storedCertificate] = await Promise.all([
      this.deps.store.put({ content: signedPdf, fileName: signedName, mimeType: 'application/pdf', scope }),
      this.deps.store.put({
        content: certificate,
        fileName: certificateName,
        mimeType: 'application/pdf',
        scope,
      }),
    ]);

    await this.deps.prisma.adobeAgreement.update({
      where: { id: record.id },
      data: {
        signedPdfKarbonDocumentId: reallyFiled ? (signedUpload.objectId ?? null) : null,
        certificateKarbonDocumentId: reallyFiled ? (certificateUpload.objectId ?? null) : null,
        signedPdfHash: sha256Hex(signedPdf),
        certificateHash: sha256Hex(certificate),
        signedPdfReference: storedSigned.reference,
        certificateReference: storedCertificate.reference,
      },
    });

    for (const [role, upload] of [
      ['SIGNED_PDF', signedUpload],
      ['SIGNING_CERTIFICATE', certificateUpload],
    ] as const) {
      await this.deps.prisma.karbonActivity.create({
        data: {
          engagementId: record.engagementId,
          documentVersionId: record.documentVersionId,
          karbonWorkItemKey: workItemKey,
          type: 'DOCUMENT_UPLOAD',
          outcome:
            upload.outcome === 'SUCCEEDED'
              ? 'SUCCEEDED'
              : upload.outcome === 'SKIPPED_TEST_MODE'
                ? 'SKIPPED_TEST_MODE'
                : 'SKIPPED_UNSUPPORTED',
          idempotencyKey: karbonUploadIdempotencyKey({
            karbonWorkItemKey: workItemKey,
            documentVersionId: record.documentVersionId,
            fileRole: role,
          }),
          karbonObjectId: upload.objectId ?? null,
          requestSummary: { fileRole: role } as never,
          correlationId: input.correlationId,
        },
      }).catch(() => undefined); // The unique idempotency key makes this a no-op on retry.
    }

    await this.deps.prisma.documentVersion.update({
      where: { id: record.documentVersionId },
      data: { status: 'SIGNED' },
    });

    // A note saying who signed, so the work item reads as a record on its own.
    //
    // Two PDFs appearing on a work item say a signature happened somewhere; they
    // do not say who signed or when without opening them. Posted after the
    // uploads so it cannot claim a filing that did not occur.
    if (reallyFiled) {
      const signedList = record.signers
        .filter((signer) => signer.signedAt)
        .map(
          (signer) =>
            `${signer.name} (${signer.email}) on ${signer.signedAt?.toISOString().slice(0, 10) ?? 'an unrecorded date'}`,
        );

      const note = [
        `Engagement letter signed via Adobe Acrobat Sign${record.isTestMode ? ' (TEST MODE — not a real client signature)' : ''}.`,
        signedList.length > 0 ? `Signed by: ${signedList.join('; ')}.` : 'No signer completion dates were recorded.',
        `The signed letter and Adobe audit report are filed on this work item.`,
      ].join(' ');

      const comment = await input.karbon.addComment({
        workItemKey,
        body: note,
        idempotencyKey: `signed_note_${record.id}`,
      });

      if (comment.message) messages.push(comment.message);

      await this.deps.prisma.karbonActivity
        .create({
          data: {
            engagementId: record.engagementId,
            documentVersionId: record.documentVersionId,
            karbonWorkItemKey: workItemKey,
            type: 'COMMENT',
            outcome: comment.outcome === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
            idempotencyKey: `signed_note_${record.id}`,
            karbonObjectId: comment.objectId ?? null,
            requestSummary: { kind: 'SIGNED_NOTE' } as never,
            correlationId: input.correlationId,
          },
        })
        .catch(() => undefined);
    }

    await this.deps.audit.record({
      eventType: 'KARBON_UPLOAD',
      objectType: 'AdobeAgreement',
      objectId: record.id,
      engagementId: record.engagementId,
      correlationId: input.correlationId,
      afterValue: {
        signed: signedUpload.outcome,
        certificate: certificateUpload.outcome,
        signedHash: sha256Hex(signedPdf),
        filedToKarbon: reallyFiled,
      },
    });

    return {
      signedUploaded: signedUpload.outcome === 'SUCCEEDED',
      certificateUploaded: certificateUpload.outcome === 'SUCCEEDED',
      messages,
    };
  }
}

function mapAgreementStatusToEngagementStatus(
  status: AgreementState['status'],
): 'PARTIALLY_SIGNED' | 'SIGNED' | 'DECLINED' | 'EXPIRED' | 'NEEDS_ATTENTION' | null {
  switch (status) {
    case 'PARTIALLY_SIGNED':
      return 'PARTIALLY_SIGNED';
    case 'SIGNED':
    case 'COMPLETED':
      return 'SIGNED';
    case 'DECLINED':
      return 'DECLINED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'CANCELLED':
    case 'FAILED':
      return 'NEEDS_ATTENTION';
    default:
      return null;
  }
}

/**
 * Whether the signer roster differs from the one a document was rendered against.
 *
 * Only role and signing order matter here: those are what the Adobe tags encode,
 * because a tag names a participant *set* by position rather than a person. A
 * corrected spelling or a new email address does not move anybody's field and so
 * is not this function's business — the letter body carries those, and changing
 * them already supersedes the version through the ordinary generation path.
 *
 * A missing snapshot counts as changed. Versions generated before the roster was
 * recorded cannot prove their tags match the current signers, and assuming they
 * do is exactly the silent misrouting this check exists to prevent.
 */
function rosterChanged(
  snapshot: { role: string; signingOrder: number }[] | undefined,
  current: readonly { role: string; signingOrder: number }[],
): boolean {
  if (!snapshot) return true;

  const key = (roster: readonly { role: string; signingOrder: number }[]): string =>
    roster
      .map((signer) => `${signer.role}:${signer.signingOrder}`)
      .sort()
      .join('|');

  return key(snapshot) !== key(current);
}
