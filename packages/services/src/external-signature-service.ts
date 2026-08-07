import type { ExternalSignatureMethod, PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { countPdfPages, isPdf } from '@element/documents';
import { assertGate, evaluateExternalSignatureGate, type GateResult } from '@element/workflows';
import { ValidationError, assertCan, sha256Hex, type Logger, type Principal } from '@element/shared';
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
