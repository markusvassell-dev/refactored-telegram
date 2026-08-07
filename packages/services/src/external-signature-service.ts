import type { ExternalSignatureMethod, PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import type { KarbonProvider } from '@element/integrations';
import { countPdfPages, isPdf } from '@element/documents';
import { assertGate, evaluateExternalSignatureGate, type GateResult } from '@element/workflows';
import {
  NotFoundError,
  PreconditionError,
  ValidationError,
  assertCan,
  buildFileName,
  karbonCommentIdempotencyKey,
  karbonUploadIdempotencyKey,
  sha256Hex,
  type Logger,
  type Principal,
} from '@element/shared';
import type { DocumentStore } from './storage.js';
import type { WorkflowService } from './workflow-service.js';
import type { NotificationService } from './notification-service.js';

/**
 * Recording a signature this application did not collect.
 *
 * The firm signs engagement letters today using Acrobat Pro's e-sign feature.
 * That product has no API. Acrobat Sign Solutions, which does, is a separate
 * paid licence the firm does not hold. Without a way to record a signature
 * obtained elsewhere, an approved letter can never become a signed one here,
 * and everything downstream of the signature — completion, the compilation
 * cover letter, delivery — is unreachable. The application would be a drafting
 * tool that stops at the moment it starts to matter.
 *
 * What this deliberately is not: a way to skip review. An engagement only
 * reaches READY_TO_SEND after final approval, and this changes nothing about
 * that. What it changes is who collected the signature and what evidence
 * exists — and both facts are recorded permanently, in a table of their own,
 * so that a signature recorded by hand can never be read as one Adobe
 * witnessed.
 *
 * The signed file is required. An assertion with no document behind it is not
 * evidence, and this is the one step in the workflow where a false record would
 * be worth making: it is the difference between a client having agreed to a fee
 * and somebody saying they did.
 */

export interface ExternalSignatureServiceDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  store: DocumentStore;
  workflow: WorkflowService;
  notifications: NotificationService;
  logger: Logger;
}

export interface RecordExternalSignatureInput {
  engagementId: string;
  documentVersionId: string;
  actor: Principal;
  method: ExternalSignatureMethod;
  /** The date the client signed, YYYY-MM-DD. Not the date this was recorded. */
  signedOn: string;
  reason: string;
  /** Participant ids the recorder confirmed had signed. */
  confirmedSignerIds: readonly string[];
  evidence: { fileName: string; mimeType: string; content: Uint8Array };
  correlationId?: string;
  /** Overridable so the gate's date checks are testable. */
  today?: string;
}

export interface RecordExternalSignatureResult {
  externalSignatureId: string;
  evidenceHash: string;
  pageCount: number | null;
  warnings: string[];
  /** True when this exact file was already recorded, so nothing new happened. */
  duplicate: boolean;
}

export class ExternalSignatureService {
  constructor(private readonly deps: ExternalSignatureServiceDeps) {}

  /**
   * What blocks recording a signature right now, without recording one.
   *
   * Separated so the screen can show the reasons before somebody uploads a
   * file, rather than after.
   */
  async evaluateGate(input: {
    engagementId: string;
    documentVersionId: string;
    confirmedSignerIds?: readonly string[];
    signedOn?: string;
    reason?: string;
    evidenceIsPdf?: boolean;
    evidenceByteLength?: number;
    today?: string;
  }): Promise<GateResult> {
    const [engagement, version, approval, participants, openAgreement] = await Promise.all([
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
      this.deps.prisma.adobeAgreement.findFirst({
        where: {
          engagementId: input.engagementId,
          status: { in: ['CREATED', 'OUT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'] },
        },
        select: { id: true },
      }),
    ]);

    const confirmed = new Set(input.confirmedSignerIds ?? []);
    const today = input.today ?? new Date().toISOString().slice(0, 10);

    return evaluateExternalSignatureGate({
      status: engagement.status,
      hasApprovedPdf: version.status === 'APPROVED' && Boolean(version.generatedPdfReference),
      hasInternalApprovalEvent: Boolean(approval),
      expectedSigners: participants.map((participant) => ({
        name: participant.fullLegalName,
        confirmed: confirmed.has(participant.id),
      })),
      evidenceIsPdf: input.evidenceIsPdf ?? true,
      evidenceByteLength: input.evidenceByteLength ?? 1,
      signedOnIso: input.signedOn ?? today,
      todayIso: today,
      hasOpenAdobeAgreement: openAgreement !== null,
      reason: input.reason ?? '',
    });
  }

  async record(input: RecordExternalSignatureInput): Promise<RecordExternalSignatureResult> {
    assertCan(input.actor, 'signing:record_external');

    const content = Buffer.from(input.evidence.content);
    // The bytes decide, not the extension. A .pdf that is really a Word file —
    // or an unsigned copy of the same letter — is not evidence of a signature.
    const evidenceIsPdf = content.byteLength > 0 && isPdf(content);
    const today = input.today ?? new Date().toISOString().slice(0, 10);

    // The duplicate check comes before the gate, and before anything is
    // stored. Recording the same file twice is a double-click, and the second
    // click arrives when the engagement is already SIGNED — so a gate run first
    // rejects it with "the engagement must be in READY_TO_SEND, not SIGNED",
    // which is true, unhelpful, and alarming for what is simply a repeat. It
    // also saves writing a file only to delete it again.
    const evidenceHash = sha256Hex(content);
    const existing = await this.deps.prisma.externalSignature.findUnique({
      where: {
        engagementId_evidenceHash: { engagementId: input.engagementId, evidenceHash },
      },
      select: { id: true, evidencePageCount: true },
    });

    if (existing) {
      return {
        externalSignatureId: existing.id,
        evidenceHash,
        pageCount: existing.evidencePageCount,
        warnings: ['This exact document is already recorded against this engagement. Nothing was changed.'],
        duplicate: true,
      };
    }

    const gate = await this.evaluateGate({
      engagementId: input.engagementId,
      documentVersionId: input.documentVersionId,
      confirmedSignerIds: input.confirmedSignerIds,
      signedOn: input.signedOn,
      reason: input.reason,
      evidenceIsPdf,
      evidenceByteLength: content.byteLength,
      today,
    });
    assertGate(gate, 'Recording a signature');

    const signedOn = new Date(`${input.signedOn}T00:00:00.000Z`);
    if (Number.isNaN(signedOn.getTime())) {
      throw new ValidationError('The signature date is not a date.');
    }

    // Stored through the same choke point every other document uses: the
    // contents must match the declared type, the size limit applies, and path
    // traversal is impossible.
    const stored = await this.deps.store.put({
      content,
      fileName: input.evidence.fileName,
      mimeType: 'application/pdf',
      scope: input.engagementId,
    });

    const participants = await this.deps.prisma.engagementParticipant.findMany({
      where: { id: { in: [...input.confirmedSignerIds] }, engagementId: input.engagementId },
      select: { id: true, fullLegalName: true, role: true },
    });

    const pageCount = countPdfPages(content);

    const signature = await this.deps.prisma.externalSignature.create({
      data: {
        engagementId: input.engagementId,
        documentVersionId: input.documentVersionId,
        evidenceReference: stored.reference,
        evidenceHash,
        evidenceFileName: input.evidence.fileName,
        evidencePageCount: pageCount,
        method: input.method,
        signedOn,
        reason: input.reason.trim(),
        recordedBy: input.actor.id,
        signers: {
          create: participants.map((participant) => ({
            participantId: participant.id,
            fullLegalName: participant.fullLegalName,
            role: participant.role,
          })),
        },
      },
    });

    // The approved version is not touched. Its PDF remains exactly what was
    // approved; the signed copy lives on this record. Overwriting it would
    // destroy the only thing that proves what the firm actually approved.
    await this.deps.workflow.transition({
      engagementId: input.engagementId,
      to: 'SIGNED',
      reason: `Signature obtained outside the application (${input.method}) and recorded by ${input.actor.email}`,
      correlationId: input.correlationId,
    });

    await this.deps.audit.record({
      eventType: 'EXTERNAL_SIGNATURE_RECORDED',
      objectType: 'ExternalSignature',
      objectId: signature.id,
      engagementId: input.engagementId,
      userId: input.actor.id,
      correlationId: input.correlationId ?? null,
      reason: input.reason.trim(),
      afterValue: {
        method: input.method,
        signedOn: input.signedOn,
        // The hash, never the document. A signed engagement letter carries
        // client details that have no business in an audit payload.
        evidenceHash,
        evidenceFileName: input.evidence.fileName,
        pageCount,
        signers: participants.map((participant) => ({
          name: participant.fullLegalName,
          role: participant.role,
        })),
      },
    });

    await this.announce(input.engagementId, input.method);

    return {
      externalSignatureId: signature.id,
      evidenceHash,
      pageCount,
      warnings: gate.warnings,
      duplicate: false,
    };
  }

  /**
   * Files the signed document into Karbon.
   *
   * Until this existed the evidence lived in one place: this application's own
   * document store, which on a container platform is reclaimed on the next
   * deploy unless a volume happens to be attached. The signed engagement letter
   * is the document that proves a client agreed to a fee, and it was the only
   * thing in the system with no copy anywhere else — the Adobe path has always
   * returned its signed PDF and certificate to Karbon, and the manual path
   * returned nothing.
   *
   * Karbon remains the system of record. This makes that true for a signature
   * recorded by hand as well.
   */
  async fileToKarbon(input: {
    externalSignatureId: string;
    karbon: KarbonProvider;
    correlationId: string;
  }): Promise<{ uploaded: boolean; skipped: boolean; messages: string[] }> {
    const record = await this.deps.prisma.externalSignature.findUnique({
      where: { id: input.externalSignatureId },
      include: {
        engagement: { include: { client: true, karbonWorkItem: true } },
        documentVersion: true,
        signers: true,
        recorder: true,
      },
    });

    if (!record) throw new NotFoundError(`External signature ${input.externalSignatureId}`);

    // The signature must belong to the engagement it claims to. Same check the
    // Adobe path makes, for the same reason: an upload is written to a client's
    // permanent file and cannot be taken back.
    if (record.documentVersion.engagementId !== record.engagementId) {
      throw new PreconditionError('The signature does not belong to this engagement. Nothing was uploaded.');
    }

    // Already filed. Re-running must not produce a second copy of a signed
    // document in a client's file.
    if (record.karbonDocumentId) {
      return { uploaded: false, skipped: true, messages: ['This signature is already filed in Karbon.'] };
    }

    const workItemKey = record.engagement.karbonWorkItem?.karbonKey;
    if (!workItemKey) {
      return {
        uploaded: false,
        skipped: true,
        messages: ['This engagement has no linked Karbon work item, so the signed document was not uploaded.'],
      };
    }

    const content = await this.deps.store.get(record.evidenceReference);

    // The same naming as an Adobe-signed letter, because that is what it is —
    // the firm's filing convention should not fork on how the signature was
    // collected. Where it was collected is recorded in the note below, and
    // permanently in this application.
    const fileName = buildFileName({
      year: record.engagement.taxYear,
      documentType: record.documentVersion.documentType,
      clientLegalName: record.engagement.client.legalName,
      role: 'SIGNED_PDF',
      testMode: record.engagement.isTestMode,
    });

    const idempotencyKey = karbonUploadIdempotencyKey({
      karbonWorkItemKey: workItemKey,
      documentVersionId: record.documentVersionId,
      fileRole: 'SIGNED_PDF',
    });

    const upload = await input.karbon.uploadDocument({
      workItemKey,
      fileName,
      content,
      mimeType: 'application/pdf',
      idempotencyKey,
      // A signed document is never overwritten. If Adobe already filed one for
      // this version, that one stands.
      neverOverwrite: true,
    });

    const messages: string[] = [];
    if (upload.message) messages.push(upload.message);

    if (upload.outcome === 'SUCCEEDED' && upload.objectId) {
      await this.deps.prisma.externalSignature.update({
        where: { id: record.id },
        data: { karbonDocumentId: upload.objectId },
      });
    }

    await this.deps.prisma.karbonActivity
      .create({
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
          idempotencyKey,
          karbonObjectId: upload.objectId ?? null,
          requestSummary: { fileRole: 'SIGNED_PDF', signedOutsideApplication: true } as never,
          correlationId: input.correlationId,
        },
      })
      .catch(() => undefined); // The unique idempotency key makes this a no-op on retry.

    // Somebody working in Karbon sees a signed letter that looks like any
    // other. The note is the only thing telling them it carries no Adobe
    // certificate. Best-effort: a failed note must never fail the filing, and
    // it is a note for a human, never a trigger for anything.
    if (upload.outcome === 'SUCCEEDED') {
      const signedBy = record.signers.map((signer) => signer.fullLegalName).join(', ');
      await input.karbon
        .addComment({
          workItemKey,
          body: [
            `Signed engagement letter filed. Signed on ${record.signedOn.toISOString().slice(0, 10)} by ${signedBy || 'the client'}.`,
            `Obtained outside Element Engagements (${record.method.replace(/_/g, ' ').toLowerCase()}), so there is no Adobe Sign certificate for it.`,
            `Recorded in Element Engagements by ${record.recorder?.displayName ?? 'a former user'}.`,
          ].join(' '),
          idempotencyKey: karbonCommentIdempotencyKey({
            karbonWorkItemKey: workItemKey,
            documentVersionId: record.documentVersionId,
            kind: 'external_signature_filed',
          }),
        })
        .catch((error: unknown) => {
          this.deps.logger.warn('Filed the signed document but could not add the Karbon note', {
            externalSignatureId: record.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
    }

    await this.deps.audit.record({
      eventType: 'KARBON_UPLOAD',
      objectType: 'ExternalSignature',
      objectId: record.id,
      engagementId: record.engagementId,
      correlationId: input.correlationId,
      afterValue: {
        outcome: upload.outcome,
        fileName,
        karbonDocumentId: upload.objectId ?? null,
        evidenceHash: record.evidenceHash,
      },
    });

    return { uploaded: upload.outcome === 'SUCCEEDED', skipped: false, messages };
  }

  /**
   * Tells the people responsible that the letter is signed.
   *
   * Deliberately a different event type from `SIGNING_SIGNED`. The Adobe notice
   * says the signed document and certificate are being filed automatically;
   * that is not true here, and a notice that says it would send somebody
   * looking in Karbon for a certificate that does not exist.
   *
   * A lost notice never rolls back a recorded signature.
   */
  private async announce(engagementId: string, method: ExternalSignatureMethod): Promise<void> {
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
        eventType: 'SIGNING_RECORDED_EXTERNALLY',
        title: `Engagement letter signed (recorded by hand): ${engagement.client.legalName}`,
        body: `${engagement.engagementType} ${engagement.taxYear}. A signature obtained outside this application (${method}) has been recorded, with the signed document attached. Nothing was filed into Karbon automatically.`,
        link: `/engagements/${engagementId}`,
        engagementId,
        deduplicate: true,
      });
    } catch (error) {
      this.deps.logger.error('Could not raise an external signature notification', {
        engagementId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
