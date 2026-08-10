import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import type { KarbonProvider } from '@element/integrations';
import {
  DOCUMENT_TYPE_LABELS,
  buildFileName,
  formatMoney,
  karbonCommentIdempotencyKey,
  karbonUploadIdempotencyKey,
  type DocumentType,
  type Logger,
} from '@element/shared';
import type { DocumentStore } from './storage.js';

/**
 * Karbon review notifications.
 *
 * After a draft is generated the Word document and PDF go to the Karbon work
 * item, a review task is created where the API supports it, and a note is
 * posted with the fee comparison and a deep link back into the review
 * workspace.
 *
 * Comments are notifications, never automation commands.
 */

const REVIEW_TITLES: Record<DocumentType, string> = {
  T1_JOINT_ENGAGEMENT_LETTER: 'Review T1 Engagement Letter',
  T1_SINGLE_ENGAGEMENT_LETTER: 'Review T1 Engagement Letter',
  T2_ENGAGEMENT_LETTER: 'Review T2 Engagement Letter',
  T3_ENGAGEMENT_LETTER: 'Review T3 Engagement Letter',
  T1_COVER_LETTER: 'Review T1 Cover Letter',
  T2_COVER_LETTER: 'Review T2 Cover Letter',
  T3_COVER_LETTER: 'Review T3 Cover Letter',
  COMPILATION_COVER_LETTER: 'Review Compilation Engagement Cover Letter',
};

export function reviewTitleFor(documentType: DocumentType): string {
  return REVIEW_TITLES[documentType];
}

export interface NotificationDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  store: DocumentStore;
  logger: Logger;
  appBaseUrl: string;
}

export interface PublishDraftInput {
  engagementId: string;
  documentVersionId: string;
  karbon: KarbonProvider;
  testMode: boolean;
  correlationId: string;
  actorId?: string | null;
}

export interface PublishDraftResult {
  uploaded: { role: string; outcome: string; documentId: string | null }[];
  commentPosted: boolean;
  taskCreated: boolean;
  /** Limitations encountered, surfaced to the user rather than swallowed. */
  notes: string[];
}

export class KarbonNotificationService {
  constructor(private readonly deps: NotificationDeps) {}

  /** Composes the review note. Kept separate so it can be unit tested. */
  async composeReviewComment(engagementId: string, documentType: DocumentType): Promise<string> {
    const [engagement, fees] = await Promise.all([
      this.deps.prisma.engagement.findUniqueOrThrow({
        where: { id: engagementId },
        include: { client: true, reviewer: true },
      }),
      this.deps.prisma.feeCalculation.findMany({ where: { engagementId } }),
    ]);

    const t2 = fees.find((fee) => fee.feeKind === 'T2_PREPARATION');
    const t1 = fees.find((fee) => fee.feeKind === 'T1_PREPARATION');
    const t3 = fees.find((fee) => fee.feeKind === 'T3_PREPARATION');
    const compilation = fees.find((fee) => fee.feeKind === 'CSRS_4200_COMPILATION');
    const primary = t2 ?? t1 ?? t3;

    const lines: string[] = [
      `Review required: ${engagement.taxYear} ${DOCUMENT_TYPE_LABELS[documentType]}`,
      '',
      `A draft has been generated from the approved master template for ${engagement.client.legalName}.`,
      '',
    ];

    if (primary?.previousFee) lines.push(`Previous fee: ${formatMoney(primary.previousFee.toString())}`);
    if (compilation?.previousFee) {
      lines.push(`Previous compilation fee: ${formatMoney(compilation.previousFee.toString())}`);
    }
    if (primary?.roundedFee) lines.push(`Proposed fee: ${formatMoney(primary.roundedFee.toString())}`);
    if (compilation?.roundedFee) {
      lines.push(`Proposed compilation fee: ${formatMoney(compilation.roundedFee.toString())}`);
    }

    if (primary) {
      const method =
        primary.method === 'PERCENTAGE'
          ? `${primary.percentage?.toString() ?? '0'}%`
          : primary.method === 'FIXED_AMOUNT'
            ? `Fixed increase of ${formatMoney(primary.fixedAmount?.toString() ?? '0')}`
            : primary.method === 'EXACT_TARGET'
              ? 'Exact target price'
              : 'No increase';
      lines.push(`Increase method: ${method}`);
      if (primary.roundingApplied) lines.push('Rounding method: Rounded upward to the next $5');
    }

    if (engagement.engagementType === 'T2') {
      lines.push(
        `Compilation services: ${
          engagement.compilationSelected === null
            ? 'Confirmation required'
            : engagement.compilationSelected
              ? 'Included'
              : 'Not included'
        }`,
      );
    }

    lines.push(`Reviewer: ${engagement.reviewer?.displayName ?? 'Unassigned'}`);
    lines.push('');
    lines.push('Open the review workspace:');
    lines.push(`${this.deps.appBaseUrl}/engagements/${engagementId}`);

    return lines.join('\n');
  }

  async publishDraft(input: PublishDraftInput): Promise<PublishDraftResult> {
    const version = await this.deps.prisma.documentVersion.findUniqueOrThrow({
      where: { id: input.documentVersionId },
      include: {
        engagement: { include: { client: true, karbonWorkItem: true, reviewer: true } },
      },
    });

    const workItemKey = version.engagement.karbonWorkItem?.karbonKey;
    const notes: string[] = [];
    const uploaded: PublishDraftResult['uploaded'] = [];

    if (!workItemKey) {
      return {
        uploaded: [],
        commentPosted: false,
        taskCreated: false,
        notes: ['This engagement has no linked Karbon work item, so nothing was uploaded to Karbon.'],
      };
    }

    const baseName = buildFileName({
      year: version.engagement.taxYear,
      documentType: version.documentType,
      clientLegalName: version.engagement.client.legalName,
      role: 'DRAFT_DOCX',
      testMode: input.testMode,
    });

    const files: { role: 'DRAFT_DOCX' | 'DRAFT_PDF'; reference: string | null; name: string; mime: string }[] = [
      {
        role: 'DRAFT_DOCX',
        reference: version.generatedDocxReference,
        name: baseName,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      {
        role: 'DRAFT_PDF',
        reference: version.generatedPdfReference,
        name: baseName.replace(/\.docx$/, '.pdf'),
        mime: 'application/pdf',
      },
    ];

    for (const file of files) {
      if (!file.reference) continue;

      const idempotencyKey = karbonUploadIdempotencyKey({
        karbonWorkItemKey: workItemKey,
        documentVersionId: input.documentVersionId,
        fileRole: file.role,
      });

      const content = await this.deps.store.get(file.reference);
      const result = await input.karbon.uploadDocument({
        workItemKey,
        fileName: file.name,
        content,
        mimeType: file.mime,
        idempotencyKey,
        // Drafts may be replaced; approved and signed files never are.
        neverOverwrite: false,
      });

      uploaded.push({ role: file.role, outcome: result.outcome, documentId: result.objectId ?? null });
      if (result.message) notes.push(result.message);

      await this.recordActivity({
        engagementId: input.engagementId,
        documentVersionId: input.documentVersionId,
        workItemKey,
        type: 'DOCUMENT_UPLOAD',
        outcome: result.outcome,
        idempotencyKey,
        objectId: result.objectId ?? null,
        correlationId: input.correlationId,
        summary: { fileRole: file.role, fileName: file.name },
      });
    }

    if (uploaded[0]?.documentId) {
      await this.deps.prisma.documentVersion.update({
        where: { id: input.documentVersionId },
        data: {
          karbonDocumentId: uploaded.find((file) => file.role === 'DRAFT_DOCX')?.documentId ?? null,
          karbonPdfDocumentId: uploaded.find((file) => file.role === 'DRAFT_PDF')?.documentId ?? null,
        },
      });
    }

    // Karbon publishes no task-creation operation, so this records the attempt
    // and its `SKIPPED_UNSUPPORTED` outcome rather than expecting a task. The
    // row is kept because the Karbon Activity tab should show that the step
    // happened and what became of it — dropping the call would make the
    // limitation invisible instead of visible.
    const title = reviewTitleFor(version.documentType);
    const body = await this.composeReviewComment(input.engagementId, version.documentType);
    const reviewerEmail = version.engagement.reviewer?.email ?? null;

    const taskKey = karbonCommentIdempotencyKey({
      karbonWorkItemKey: workItemKey,
      documentVersionId: input.documentVersionId,
      kind: 'REVIEW_TASK',
    });

    const task = await input.karbon.createTask({
      workItemKey,
      title,
      description: body,
      assigneeEmail: reviewerEmail,
      idempotencyKey: taskKey,
    });

    if (task.message) notes.push(task.message);
    await this.recordActivity({
      engagementId: input.engagementId,
      documentVersionId: input.documentVersionId,
      workItemKey,
      type: 'TASK_CREATE',
      outcome: task.outcome,
      idempotencyKey: taskKey,
      objectId: task.objectId ?? null,
      correlationId: input.correlationId,
      summary: { title },
    });

    // The note is how the reviewer is actually notified, since there is no task
    // to assign. It always goes out.
    const commentKey = karbonCommentIdempotencyKey({
      karbonWorkItemKey: workItemKey,
      documentVersionId: input.documentVersionId,
      kind: 'REVIEW_NOTE',
    });

    const comment = await input.karbon.addComment({
      workItemKey,
      body: `${title}\n\n${body}`,
      idempotencyKey: commentKey,
      assigneeEmail: reviewerEmail,
    });

    if (comment.message) notes.push(comment.message);
    await this.recordActivity({
      engagementId: input.engagementId,
      documentVersionId: input.documentVersionId,
      workItemKey,
      type: 'COMMENT',
      outcome: comment.outcome,
      idempotencyKey: commentKey,
      objectId: comment.objectId ?? null,
      correlationId: input.correlationId,
      summary: { title },
    });

    await this.deps.audit.record({
      eventType: 'KARBON_UPLOAD',
      objectType: 'DocumentVersion',
      objectId: input.documentVersionId,
      engagementId: input.engagementId,
      userId: input.actorId ?? null,
      correlationId: input.correlationId,
      afterValue: { uploaded, task: task.outcome, comment: comment.outcome, testMode: input.testMode },
    });

    return {
      uploaded,
      commentPosted: comment.outcome === 'SUCCEEDED',
      taskCreated: task.outcome === 'SUCCEEDED',
      notes,
    };
  }

  private async recordActivity(input: {
    engagementId: string;
    documentVersionId: string | null;
    workItemKey: string;
    type: 'DOCUMENT_UPLOAD' | 'COMMENT' | 'TASK_CREATE' | 'TASK_COMPLETE' | 'WORK_ITEM_STATUS_UPDATE';
    outcome: string;
    idempotencyKey: string;
    objectId: string | null;
    correlationId: string;
    summary: Record<string, unknown>;
  }): Promise<void> {
    const outcome =
      input.outcome === 'SUCCEEDED'
        ? 'SUCCEEDED'
        : input.outcome === 'SKIPPED_TEST_MODE'
          ? 'SKIPPED_TEST_MODE'
          : input.outcome === 'SKIPPED_UNSUPPORTED'
            ? 'SKIPPED_UNSUPPORTED'
            : 'SUCCEEDED';

    await this.deps.prisma.karbonActivity
      .create({
        data: {
          engagementId: input.engagementId,
          documentVersionId: input.documentVersionId,
          karbonWorkItemKey: input.workItemKey,
          type: input.type,
          outcome,
          idempotencyKey: input.idempotencyKey,
          karbonObjectId: input.objectId,
          requestSummary: input.summary as never,
          correlationId: input.correlationId,
        },
      })
      // The unique idempotency key makes a repeat a no-op rather than an error.
      .catch(() => undefined);
  }
}
