import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { calculateFee, resolveRule, type CandidateRule, type PriceRule } from '@element/pricing';
import {
  assertCan,
  bulkRolloutIdempotencyKey,
  generationIdempotencyKey,
  newCorrelationId,
  type DocumentType,
  type EngagementType,
  type FeeKind,
  type Principal,
} from '@element/shared';
import type { JobQueue } from './jobs/queue.js';

/**
 * Bulk annual rollout.
 *
 * The preview is always computed first and can be exported or dry-run. Bulk
 * generation produces drafts only — it never sends anything to Adobe Sign, and
 * every generated document still goes through individual review and approval.
 */

export interface BulkFilter {
  engagementType?: EngagementType;
  taxYear: number;
  fiscalYearEndMonth?: number;
  partnerUserId?: string;
  engagementLeadId?: string;
  reviewerId?: string;
  clientGroup?: string;
  karbonWorkItemType?: string;
  karbonWorkItemStatus?: string;
  priorYearLetter?: 'FOUND' | 'MISSING';
  previousFee?: 'FOUND' | 'MISSING';
  compilation?: 'SELECTED' | 'NOT_SELECTED';
  exceptions?: 'PRESENT' | 'NONE';
  readiness?: 'READY' | 'BLOCKED';
}

export interface BulkPreviewRow {
  engagementId: string;
  clientId: string;
  clientName: string;
  engagementType: EngagementType;
  taxYear: number;
  priorYearDocument: string | null;
  priorYearFee: string | null;
  increaseMethod: string;
  proposedUnroundedFee: string | null;
  proposedRoundedFee: string | null;
  compilationSelected: boolean | null;
  missingFields: string[];
  warnings: string[];
  assignedReviewer: string | null;
  /** Blocked rows cannot be generated until the blocker is cleared. */
  blocked: boolean;
  blockedReason: string | null;
  included: boolean;
}

export interface BulkPreviewResult {
  batchId: string;
  rows: BulkPreviewRow[];
  summary: { total: number; ready: number; blocked: number };
}

const FEE_KIND_BY_ENGAGEMENT: Record<EngagementType, FeeKind> = {
  T1_JOINT: 'T1_PREPARATION',
  T1_SINGLE: 'T1_PREPARATION',
  T2: 'T2_PREPARATION',
  T3: 'T3_PREPARATION',
};

const DOCUMENT_TYPE_BY_ENGAGEMENT: Record<EngagementType, DocumentType> = {
  T1_JOINT: 'T1_JOINT_ENGAGEMENT_LETTER',
  T1_SINGLE: 'T1_SINGLE_ENGAGEMENT_LETTER',
  T2: 'T2_ENGAGEMENT_LETTER',
  T3: 'T3_ENGAGEMENT_LETTER',
};

export class BulkRolloutService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly queue: JobQueue,
    private readonly audit: AuditLogger,
  ) {}

  async preview(filter: BulkFilter, options: { batchPriceRule?: PriceRule; highIncreaseThresholdPercent: number }): Promise<BulkPreviewResult> {
    const engagements = await this.prisma.engagement.findMany({
      where: {
        taxYear: filter.taxYear,
        ...(filter.engagementType ? { engagementType: filter.engagementType } : {}),
        ...(filter.reviewerId ? { assignedReviewerId: filter.reviewerId } : {}),
        ...(filter.compilation
          ? { compilationSelected: filter.compilation === 'SELECTED' }
          : {}),
        client: {
          ...(filter.clientGroup ? { clientGroup: filter.clientGroup } : {}),
          ...(filter.partnerUserId ? { partnerUserId: filter.partnerUserId } : {}),
        },
      },
      include: {
        client: true,
        reviewer: true,
        karbonWorkItem: true,
        sourceDocuments: { where: { kind: { in: ['PRIOR_YEAR_ENGAGEMENT_LETTER', 'PRIOR_YEAR_SIGNED_LETTER'] } } },
        feeCalculations: true,
        wordingExceptions: { where: { approvedAt: null, rejectedAt: null } },
      },
    });

    const ruleRows = await this.prisma.feeRule.findMany({ where: { isActive: true } });
    const rules: CandidateRule[] = ruleRows.map((row) => ({
      id: row.id,
      level: row.level,
      engagementType: row.engagementType,
      feeKind: row.feeKind,
      clientId: row.clientId,
      clientGroup: row.clientGroup,
      partnerUserId: row.partnerUserId,
      isActive: row.isActive,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      method: row.method,
      percentage: row.percentage?.toString() ?? null,
      fixedAmount: row.fixedAmount?.toString() ?? null,
      exactTarget: row.exactTarget?.toString() ?? null,
      skipRounding: row.skipRounding,
      appliesToAncillaryCharges: row.appliesToAncillaryCharges,
    }));

    const rows: BulkPreviewRow[] = [];

    for (const engagement of engagements) {
      const feeKind = FEE_KIND_BY_ENGAGEMENT[engagement.engagementType];
      const existingFee = engagement.feeCalculations.find((fee) => fee.feeKind === feeKind);
      const priorDocument = engagement.sourceDocuments[0] ?? null;

      const rule =
        options.batchPriceRule ??
        resolveRule(rules, {
          engagementType: engagement.engagementType,
          feeKind,
          clientId: engagement.clientId,
          clientGroup: engagement.client.clientGroup,
          partnerUserId: engagement.client.partnerUserId,
        });

      const previousFee = existingFee?.previousFee?.toString() ?? null;

      const calculation = rule
        ? calculateFee({
            feeKind,
            rule,
            previousFee,
            previousFeeSource: existingFee?.previousFeeSource ?? null,
            highIncreaseThresholdPercent: options.highIncreaseThresholdPercent,
          })
        : null;

      const missingFields: string[] = [];
      if (!priorDocument) missingFields.push('Prior-year engagement letter');
      if (!previousFee) missingFields.push('Prior-year fee');
      if (engagement.engagementType === 'T2' && engagement.compilationSelected === null) {
        missingFields.push('CSRS 4200 confirmation');
      }

      const warnings = calculation?.warnings.map((warning) => warning.message) ?? [];
      if (engagement.wordingExceptions.length > 0) {
        warnings.push(`${engagement.wordingExceptions.length} wording change(s) await partner approval.`);
      }

      const blockedReason =
        calculation?.blockedReason ??
        (rule ? null : 'No pricing rule applies. Choose a price method before generating.');

      const row: BulkPreviewRow = {
        engagementId: engagement.id,
        clientId: engagement.clientId,
        clientName: engagement.client.legalName,
        engagementType: engagement.engagementType,
        taxYear: engagement.taxYear,
        priorYearDocument: priorDocument?.fileName ?? null,
        priorYearFee: previousFee,
        increaseMethod: rule?.method ?? 'NOT SET',
        proposedUnroundedFee: calculation?.unroundedFee?.toFixed(2) ?? null,
        proposedRoundedFee: calculation?.roundedFee?.toFixed(2) ?? null,
        compilationSelected: engagement.compilationSelected,
        missingFields,
        warnings,
        assignedReviewer: engagement.reviewer?.displayName ?? null,
        blocked: Boolean(blockedReason) || missingFields.length > 0,
        blockedReason,
        included: !blockedReason && missingFields.length === 0,
      };

      if (filter.priorYearLetter === 'FOUND' && !priorDocument) continue;
      if (filter.priorYearLetter === 'MISSING' && priorDocument) continue;
      if (filter.previousFee === 'FOUND' && !previousFee) continue;
      if (filter.previousFee === 'MISSING' && previousFee) continue;
      if (filter.exceptions === 'PRESENT' && engagement.wordingExceptions.length === 0) continue;
      if (filter.exceptions === 'NONE' && engagement.wordingExceptions.length > 0) continue;
      if (filter.readiness === 'READY' && row.blocked) continue;
      if (filter.readiness === 'BLOCKED' && !row.blocked) continue;
      if (
        filter.fiscalYearEndMonth &&
        (!engagement.yearEnd || engagement.yearEnd.getUTCMonth() + 1 !== filter.fiscalYearEndMonth)
      ) {
        continue;
      }
      if (filter.karbonWorkItemStatus && engagement.karbonWorkItem?.status !== filter.karbonWorkItemStatus) continue;
      if (filter.karbonWorkItemType && engagement.karbonWorkItem?.workType !== filter.karbonWorkItemType) continue;

      rows.push(row);
    }

    return {
      batchId: newCorrelationId(),
      rows,
      summary: {
        total: rows.length,
        ready: rows.filter((row) => !row.blocked).length,
        blocked: rows.filter((row) => row.blocked).length,
      },
    };
  }

  /**
   * Queues generation for the selected engagements.
   *
   * Nothing is sent to Adobe Sign; each draft still requires individual review
   * and approval. Duplicate protection comes from the deterministic keys.
   */
  async run(input: {
    batchId: string;
    engagementIds: readonly string[];
    actor: Principal;
    dryRun: boolean;
  }): Promise<{ queued: number; skipped: number; dryRun: boolean }> {
    assertCan(input.actor, 'generation:start');

    if (input.dryRun) {
      return { queued: 0, skipped: input.engagementIds.length, dryRun: true };
    }

    let queued = 0;
    let skipped = 0;

    for (const engagementId of input.engagementIds) {
      const engagement = await this.prisma.engagement.findUnique({
        where: { id: engagementId },
        select: { id: true, clientId: true, engagementType: true, taxYear: true },
      });
      if (!engagement) {
        skipped += 1;
        continue;
      }

      const documentType = DOCUMENT_TYPE_BY_ENGAGEMENT[engagement.engagementType];

      const result = await this.queue.enqueue({
        jobType: 'GENERATE_ENGAGEMENT_LETTER',
        idempotencyKey: bulkRolloutIdempotencyKey({
          batchId: input.batchId,
          clientId: engagement.clientId,
          documentType,
        }),
        payload: {
          engagementId,
          documentType,
          actorId: input.actor.id,
          batchId: input.batchId,
          // The generation job itself also checks this key, so a duplicate
          // draft cannot be produced by two different routes.
          generationKey: generationIdempotencyKey({
            clientId: engagement.clientId,
            engagementType: engagement.engagementType,
            taxYear: engagement.taxYear,
            documentType,
          }),
        },
        engagementId,
      });

      if (result.deduplicated) skipped += 1;
      else queued += 1;
    }

    await this.audit.record({
      eventType: 'GENERATION_REQUESTED',
      objectType: 'BulkRollout',
      objectId: input.batchId,
      userId: input.actor.id,
      afterValue: { queued, skipped, engagementCount: input.engagementIds.length },
    });

    return { queued, skipped, dryRun: false };
  }
}
