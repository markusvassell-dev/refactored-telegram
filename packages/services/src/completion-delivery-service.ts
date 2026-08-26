import type { Prisma, PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import type { KarbonProvider } from '@element/integrations';
import { NotFoundError, PreconditionError, type Logger } from '@element/shared';
import { clientUploadTarget } from './karbon-target.js';
import type { DocumentStore } from './storage.js';
import type { NotificationService } from './notification-service.js';
import type { WorkflowService } from './workflow-service.js';

/**
 * Putting the finished package in the client's file.
 *
 * `READY_FOR_DELIVERY` was the end of the road. An approved cover letter
 * reached it and **nothing consumed it** — no job, no button, no scheduled
 * pass. The final T2 return and the financial statements reached Karbon by no
 * path at all, so "the client's file is complete" was something this
 * application could describe and not something it could do.
 *
 * Everything goes to the client's own Documents tab rather than a work item. A
 * work item is one year's job; this is the client's permanent record, and it is
 * where somebody looks a year later when they want to know what was filed.
 *
 * The one rule worth stating plainly: **a partial package is a failure, not a
 * partial success.** A client file holding a cover letter that refers to
 * enclosed financial statements which are not there is worse than one holding
 * nothing, because the first reads as complete. So a document whose bytes
 * cannot be found stops the whole delivery by name, and the job retries.
 */

export interface CompletionDeliveryDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  store: DocumentStore;
  workflow: WorkflowService;
  notifications: NotificationService;
  logger: Logger;
}

export interface DeliverPackageInput {
  coverLetterPackageId: string;
  karbon: KarbonProvider;
  correlationId: string;
  testMode: boolean;
}

export interface DeliverPackageResult {
  delivered: boolean;
  /** Karbon file ids, keyed by what each file is. Empty when nothing was sent. */
  fileIds: Record<string, string>;
  skippedReason: string | null;
  messages: string[];
}

/** One file on its way to Karbon. */
interface Deliverable {
  label: string;
  fileName: string;
  mimeType: string;
  /** Where the bytes are in this application's own store. */
  reference: string;
}

export class CompletionDeliveryService {
  constructor(private readonly deps: CompletionDeliveryDeps) {}

  async deliver(input: DeliverPackageInput): Promise<DeliverPackageResult> {
    const record = await this.deps.prisma.coverLetterPackage.findUnique({
      where: { id: input.coverLetterPackageId },
      include: {
        engagement: { include: { client: true } },
        documentVersions: { where: { status: 'APPROVED' }, orderBy: { versionNumber: 'desc' }, take: 1 },
      },
    });

    if (!record) throw new NotFoundError('Cover letter package');

    // Already done. Delivery writes into a client's permanent records and
    // cannot be taken back, so a second run must not produce a second copy.
    if (record.status === 'DELIVERED') {
      return {
        delivered: false,
        fileIds: (record.karbonFileIds ?? {}) as Record<string, string>,
        skippedReason: 'This package was already delivered.',
        messages: [],
      };
    }

    if (record.status !== 'READY_FOR_DELIVERY') {
      throw new PreconditionError(
        `Only a package marked ready for delivery can be delivered; this one is ${record.status}.`,
      );
    }

    // Nothing leaves the building in Test Mode. Recorded rather than silent:
    // an operator watching System Jobs should see that the step ran and chose
    // not to send, which is a different thing from the step never running.
    if (input.testMode || input.karbon.isMock) {
      const reason = input.testMode
        ? 'Test Mode is on, so nothing was filed into Karbon.'
        : 'Karbon is not connected, so nothing was filed. Delivery will be retried once it is.';
      return { delivered: false, fileIds: {}, skippedReason: reason, messages: [reason] };
    }

    const resolved = clientUploadTarget(record.engagement.client);
    if (!resolved.ok) {
      throw new PreconditionError(`This package cannot be delivered: ${resolved.unavailable}`);
    }

    const deliverables = await this.collect(record.id, record.engagementId, record.documentVersions[0]);

    const fileIds: Record<string, string> = {};
    const messages: string[] = [];

    for (const item of deliverables) {
      const content = await this.deps.store.get(item.reference);

      const upload = await input.karbon.uploadDocument({
        target: resolved.target,
        fileName: item.fileName,
        content,
        mimeType: item.mimeType,
        idempotencyKey: `deliver_${record.id}_${item.label}`,
        // Nothing in a client's file is ever replaced by this. A name
        // collision means the document is already there — from an earlier
        // delivery, or from the signed letter filed at signing time — and the
        // existing one stands.
        neverOverwrite: true,
      });

      if (upload.objectId) fileIds[item.label] = upload.objectId;
      if (upload.message) messages.push(upload.message);
    }

    const now = new Date();

    await this.deps.prisma.coverLetterPackage.update({
      where: { id: record.id },
      data: {
        status: 'DELIVERED',
        deliveredAt: now,
        karbonFileIds: fileIds as unknown as Prisma.InputJsonValue,
      },
    });

    await this.deps.workflow.transition({
      engagementId: record.engagementId,
      to: 'DELIVERED',
      reason: `The completion package was filed into ${record.engagement.client.legalName}'s Karbon documents.`,
      correlationId: input.correlationId,
    });

    await this.deps.audit.record({
      eventType: 'COMPLETION_PACKAGE_DELIVERED',
      objectType: 'CoverLetterPackage',
      objectId: record.id,
      engagementId: record.engagementId,
      correlationId: input.correlationId,
      afterValue: {
        clientEntityKey: resolved.entityKey,
        files: deliverables.map((item) => item.fileName),
        karbonFileIds: fileIds,
      },
    });

    await this.deps.notifications
      .notify({
        userIds: [
          record.engagement.assignedPreparerId,
          record.engagement.assignedReviewerId,
          record.engagement.finalApproverId,
        ],
        eventType: 'PACKAGE_DELIVERED',
        title: 'Completion package filed',
        body: `The cover letter and every enclosure are now in ${record.engagement.client.legalName}'s Karbon documents.`,
        link: `/engagements/${record.engagementId}`,
        engagementId: record.engagementId,
        deduplicate: true,
      })
      .catch((error: unknown) => {
        // A notice is a courtesy on top of the record. Losing one must never
        // undo a delivery that genuinely happened.
        this.deps.logger.warn('Delivered the package but could not notify the team', {
          engagementId: record.engagementId,
          reason: error instanceof Error ? error.message : String(error),
        });
      });

    return { delivered: true, fileIds, skippedReason: null, messages };
  }

  /**
   * Everything that belongs in the client's file, in the order a person would
   * expect to find it: the letter that explains the package, then what it
   * encloses.
   *
   * A missing set of bytes throws rather than being skipped. The working copy
   * of a source document is purged after its retention window, so this is a
   * real case rather than a theoretical one — and the honest answer is to fail
   * the delivery by name so somebody re-attaches the document, not to file a
   * cover letter listing enclosures that are not there.
   */
  private async collect(
    packageId: string,
    engagementId: string,
    coverLetterVersion: { generatedPdfReference: string | null; documentType: string } | undefined,
  ): Promise<Deliverable[]> {
    if (!coverLetterVersion?.generatedPdfReference) {
      throw new PreconditionError(
        'The approved cover letter has no stored PDF, so there is nothing to deliver. Regenerate it and approve it again.',
      );
    }

    const items: Deliverable[] = [
      {
        label: 'COVER_LETTER',
        fileName: `${coverLetterVersion.documentType}.pdf`,
        mimeType: 'application/pdf',
        reference: coverLetterVersion.generatedPdfReference,
      },
    ];

    const sources = await this.deps.prisma.sourceDocument.findMany({
      where: { engagementId, includedInPackage: true },
      orderBy: { createdAt: 'asc' },
    });

    for (const source of sources) {
      if (!source.storagePath) {
        throw new PreconditionError(
          `${source.fileName} is part of this package but its working copy is no longer held here, so the package would be incomplete. Re-attach it to the engagement and mark it ready again.`,
          { fileName: source.fileName, packageId },
        );
      }

      items.push({
        label: source.kind,
        fileName: source.fileName,
        mimeType: source.mimeType ?? 'application/pdf',
        reference: source.storagePath,
      });
    }

    return items;
  }
}
