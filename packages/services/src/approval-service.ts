import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import {
  PermissionError,
  PreconditionError,
  ValidationError,
  assertCan,
  assertSeparationOfDuties,
  can,
  isElevatedApprover,
  type Principal,
} from '@element/shared';
import { evaluateApprovalGate, type GateResult } from '@element/workflows';
import type { WorkflowService } from './workflow-service.js';
import type { SettingsService } from './settings.js';

/**
 * Review, approval and exceptional wording edits.
 *
 * Two rules are absolute here:
 *
 *  1. No client-facing document is ever sent or marked ready for delivery
 *     without an explicit approval event recorded against that exact file.
 *  2. Nobody approves their own work — not their own wording exception, not
 *     their own fee override, not their own document.
 */

export interface ApprovalServiceDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  workflow: WorkflowService;
  settings: SettingsService;
}

export class ApprovalService {
  constructor(private readonly deps: ApprovalServiceDeps) {}

  async startReview(engagementId: string, actor: Principal): Promise<void> {
    assertCan(actor, 'review:comment');
    await this.deps.workflow.transition({
      engagementId,
      to: 'IN_REVIEW',
      userId: actor.id,
      reason: 'Review started',
    });
    await this.deps.prisma.documentVersion.updateMany({
      where: { engagementId, status: 'DRAFT' },
      data: { status: 'IN_REVIEW' },
    });
  }

  async addComment(input: {
    engagementId: string;
    documentVersionId?: string | null;
    body: string;
    anchor?: string | null;
    actor: Principal;
  }): Promise<string> {
    assertCan(input.actor, 'review:comment');
    if (!input.body.trim()) throw new ValidationError('A comment cannot be empty.');

    const comment = await this.deps.prisma.reviewComment.create({
      data: {
        engagementId: input.engagementId,
        documentVersionId: input.documentVersionId ?? null,
        userId: input.actor.id,
        body: input.body.trim(),
        anchor: input.anchor ?? null,
      },
    });

    await this.deps.audit.record({
      eventType: 'REVIEW_COMMENT_ADDED',
      objectType: 'ReviewComment',
      objectId: comment.id,
      engagementId: input.engagementId,
      userId: input.actor.id,
      afterValue: { anchor: input.anchor ?? null },
    });

    return comment.id;
  }

  async requestChanges(input: { engagementId: string; reason: string; actor: Principal }): Promise<void> {
    assertCan(input.actor, 'review:request_changes');
    if (!input.reason.trim()) throw new ValidationError('Requesting changes requires a reason.');

    await this.deps.prisma.documentVersion.updateMany({
      where: { engagementId: input.engagementId, status: { in: ['DRAFT', 'IN_REVIEW'] } },
      data: { status: 'CHANGES_REQUESTED' },
    });

    await this.deps.workflow.transition({
      engagementId: input.engagementId,
      to: 'CHANGES_REQUESTED',
      userId: input.actor.id,
      reason: input.reason,
    });

    await this.deps.audit.record({
      eventType: 'CHANGES_REQUESTED',
      objectType: 'Engagement',
      objectId: input.engagementId,
      engagementId: input.engagementId,
      userId: input.actor.id,
      reason: input.reason,
    });
  }

  /** Everything standing between the current draft and approval. */
  async evaluateApprovalGate(engagementId: string, documentVersionId: string): Promise<GateResult> {
    const [version, conflicts, dates, fees, exceptions] = await Promise.all([
      this.deps.prisma.documentVersion.findUniqueOrThrow({ where: { id: documentVersionId } }),
      this.deps.prisma.fieldConflict.count({ where: { engagementId, status: 'UNRESOLVED' } }),
      this.deps.prisma.calculatedDate.findMany({
        where: { engagementId, requiresConfirmation: true, confirmedAt: null },
        select: { token: true },
      }),
      this.deps.prisma.feeCalculation.findMany({ where: { engagementId } }),
      this.deps.prisma.wordingException.count({
        where: { engagementId, approvedAt: null, rejectedAt: null },
      }),
    ]);

    const report = (version.validationReport ?? { errorCount: 0 }) as { errorCount?: number };

    return evaluateApprovalGate({
      validationErrorCount: report.errorCount ?? 0,
      unresolvedConflicts: conflicts,
      unconfirmedDates: dates.map((row) => row.token),
      unconfirmedFees: fees.filter((fee) => fee.isBlocked).map((fee) => fee.feeKind),
      pendingWordingExceptions: exceptions,
      pendingFeeApprovals: fees
        .filter((fee) => fee.requiresApprovalType !== null && fee.approvedAt === null)
        .map((fee) => fee.feeKind),
      hasRenderedDocx: Boolean(version.generatedDocxReference),
      hasRenderedPdf: Boolean(version.generatedPdfReference),
    });
  }

  /**
   * Approves a document version.
   *
   * The approval stores the hash of the exact file approved, so a later
   * question about what somebody signed off on has an unambiguous answer.
   */
  async approveDocument(input: {
    engagementId: string;
    documentVersionId: string;
    actor: Principal;
    comment?: string;
    acceptedExceptions?: string[];
  }): Promise<void> {
    const engagement = await this.deps.prisma.engagement.findUniqueOrThrow({
      where: { id: input.engagementId },
      select: { engagementType: true },
    });

    const requiresFinalApprover = await this.deps.settings.requiresFinalApprover(engagement.engagementType);

    if (requiresFinalApprover) {
      if (!can(input.actor, 'document:approve_final')) {
        throw new PermissionError(
          'This engagement type requires a partner or final approver to approve the document before it can be sent.',
        );
      }
    } else if (!can(input.actor, 'review:approve_ordinary')) {
      throw new PermissionError('Your role does not permit approving this document.');
    }

    const version = await this.deps.prisma.documentVersion.findUniqueOrThrow({
      where: { id: input.documentVersionId },
    });

    // Nobody approves the draft they themselves produced.
    assertSeparationOfDuties({
      approverId: input.actor.id,
      authorId: version.createdBy,
      subject: 'document',
    });

    const gate = await this.evaluateApprovalGate(input.engagementId, input.documentVersionId);
    if (!gate.ok) {
      throw new PreconditionError(`This document cannot be approved yet: ${gate.blockers.join(' ')}`, {
        blockers: gate.blockers,
      });
    }

    await this.deps.prisma.$transaction([
      this.deps.prisma.documentVersion.update({
        where: { id: input.documentVersionId },
        data: { status: 'APPROVED', approvedBy: input.actor.id, approvedAt: new Date() },
      }),
      this.deps.prisma.approval.create({
        data: {
          engagementId: input.engagementId,
          documentVersionId: input.documentVersionId,
          type: 'FINAL_DOCUMENT',
          decision: 'APPROVED',
          userId: input.actor.id,
          actingRole: isElevatedApprover(input.actor) ? 'PARTNER_OR_FINAL_APPROVER' : 'REVIEWER',
          comment: input.comment ?? null,
          exceptionsAccepted: (input.acceptedExceptions ?? []) as never,
          documentHash: version.pdfHash,
        },
      }),
    ]);

    await this.deps.workflow.transition({
      engagementId: input.engagementId,
      to: 'APPROVED',
      userId: input.actor.id,
      reason: 'Document approved',
    });

    await this.deps.audit.record({
      eventType: 'APPROVAL_GRANTED',
      objectType: 'DocumentVersion',
      objectId: input.documentVersionId,
      engagementId: input.engagementId,
      userId: input.actor.id,
      afterValue: { versionNumber: version.versionNumber, documentHash: version.pdfHash },
      reason: input.comment ?? null,
    });
  }

  /** Marks an approved document ready to send. Sending itself is separate. */
  async markReadyToSend(engagementId: string, actor: Principal): Promise<void> {
    assertCan(actor, 'signing:send');
    await this.deps.workflow.transition({
      engagementId,
      to: 'READY_TO_SEND',
      userId: actor.id,
      reason: 'Authorised for sending',
    });
  }

  // ---- Exceptional wording edits -----------------------------------------

  async submitWordingException(input: {
    engagementId: string;
    documentVersionId: string;
    sectionAnchor: string;
    originalWording: string;
    revisedWording: string;
    reason: string;
    actor: Principal;
  }): Promise<string> {
    assertCan(input.actor, 'wording:edit');
    if (!input.reason.trim()) {
      throw new ValidationError('A wording change requires a written reason.');
    }
    if (input.originalWording.trim() === input.revisedWording.trim()) {
      throw new ValidationError('The revised wording is identical to the approved wording.');
    }

    const exception = await this.deps.prisma.wordingException.create({
      data: {
        engagementId: input.engagementId,
        documentVersionId: input.documentVersionId,
        sectionAnchor: input.sectionAnchor,
        originalWording: input.originalWording,
        revisedWording: input.revisedWording,
        reason: input.reason.trim(),
        authorUserId: input.actor.id,
      },
    });

    await this.deps.audit.record({
      eventType: 'WORDING_EDITED',
      objectType: 'WordingException',
      objectId: exception.id,
      engagementId: input.engagementId,
      userId: input.actor.id,
      beforeValue: { wording: input.originalWording },
      afterValue: { wording: input.revisedWording },
      reason: input.reason,
    });

    return exception.id;
  }

  /**
   * Approves a wording exception.
   *
   * Requires elevated approval, and the author may never be the approver.
   * The change applies to this document version only — the master template is
   * untouched unless an administrator deliberately publishes a new version.
   */
  async approveWordingException(input: { exceptionId: string; actor: Principal }): Promise<void> {
    assertCan(input.actor, 'wording:approve');

    const exception = await this.deps.prisma.wordingException.findUniqueOrThrow({
      where: { id: input.exceptionId },
    });

    assertSeparationOfDuties({
      approverId: input.actor.id,
      authorId: exception.authorUserId,
      subject: 'wording change',
    });

    await this.deps.prisma.$transaction([
      this.deps.prisma.wordingException.update({
        where: { id: input.exceptionId },
        data: { approvedByUserId: input.actor.id, approvedAt: new Date() },
      }),
      this.deps.prisma.approval.create({
        data: {
          engagementId: exception.engagementId,
          documentVersionId: exception.documentVersionId,
          type: 'WORDING_EXCEPTION',
          decision: 'APPROVED',
          userId: input.actor.id,
          actingRole: 'PARTNER_OR_FINAL_APPROVER',
          comment: exception.reason,
        },
      }),
    ]);

    await this.deps.audit.record({
      eventType: 'APPROVAL_GRANTED',
      objectType: 'WordingException',
      objectId: input.exceptionId,
      engagementId: exception.engagementId,
      userId: input.actor.id,
      afterValue: { sectionAnchor: exception.sectionAnchor },
    });
  }

  async rejectWordingException(input: { exceptionId: string; reason: string; actor: Principal }): Promise<void> {
    assertCan(input.actor, 'wording:approve');

    const exception = await this.deps.prisma.wordingException.findUniqueOrThrow({
      where: { id: input.exceptionId },
    });

    await this.deps.prisma.wordingException.update({
      where: { id: input.exceptionId },
      data: { rejectedAt: new Date(), rejectionReason: input.reason },
    });

    await this.deps.audit.record({
      eventType: 'APPROVAL_REJECTED',
      objectType: 'WordingException',
      objectId: input.exceptionId,
      engagementId: exception.engagementId,
      userId: input.actor.id,
      reason: input.reason,
    });
  }
}
