import type { PrismaClient } from '@element/database';
import type { KarbonProvider } from '@element/integrations';
import type { Logger } from '@element/shared';
import type { AuditLogger } from '@element/audit';

/**
 * Telling Karbon where an engagement has got to.
 *
 * The firm's work item is where the rest of the practice looks, and until now
 * nothing this application did was visible there. `updateWorkItemStatus` has
 * existed on the Karbon client for some time and **was called from nowhere**;
 * `karbon_status_map` has existed as a setting, seeded empty, with a reader and
 * no writer. Both halves of the feature were built and never joined.
 *
 * ## Why this reconciles instead of reacting
 *
 * The obvious design is to push on every status transition. `WorkflowService`
 * holds no queue, and threading one through it would put Karbon inside the path
 * that changes an engagement's own status — so a Karbon outage, or a rate limit,
 * would become a reason a letter cannot be approved. That trade is not worth
 * making for a status label.
 *
 * So this compares what the map says an engagement's status *should* be in
 * Karbon against what was last pushed, and pushes the difference. A missed push
 * is corrected on the next pass, a repeated push is a no-op, and Karbon being
 * down delays a label rather than blocking the work.
 *
 * ## Nothing is guessed
 *
 * Work status values are tenant-specific: one firm's "Completed" is another's
 * "Complete" or "Ready to invoice". An application status with no entry in the
 * map is **skipped**, which is the contract the setting was written with. An
 * empty map — the seeded default — therefore means this does nothing at all,
 * which is the right behaviour until an administrator has said what their
 * statuses are called.
 */

export interface KarbonWorkStatusDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  logger: Logger;
}

export interface WorkStatusSyncResult {
  /** Engagements whose Karbon work status was changed. */
  pushed: number;
  /** Considered and found already correct, or with no mapping to apply. */
  skipped: number;
  /** Push attempts that failed. The next pass tries again. */
  failed: number;
  /** Set when nothing was attempted at all, and why. */
  skippedReason?: string;
}

export class KarbonWorkStatusService {
  constructor(private readonly deps: KarbonWorkStatusDeps) {}

  async sync(input: {
    karbon: KarbonProvider;
    statusMap: Record<string, string>;
    testMode: boolean;
    correlationId?: string;
    /** Bounds one pass, so a first run over a full book cannot exhaust the rate limit. */
    limit?: number;
  }): Promise<WorkStatusSyncResult> {
    const mappedStatuses = Object.keys(input.statusMap);
    if (mappedStatuses.length === 0) {
      return { pushed: 0, skipped: 0, failed: 0, skippedReason: 'No application status is mapped to a Karbon work status.' };
    }

    if (input.testMode || input.karbon.isMock) {
      return {
        pushed: 0,
        skipped: 0,
        failed: 0,
        skippedReason: input.karbon.isMock
          ? 'The Karbon connection is a mock adapter, so no work item was changed.'
          : 'Test Mode is on, so nothing was written to Karbon.',
      };
    }

    // Only engagements whose status is mapped and whose work item is known.
    // The `pushed` comparison is done in memory rather than SQL because the
    // target depends on the map, which is configuration rather than a column.
    const candidates = await this.deps.prisma.engagement.findMany({
      where: {
        status: { in: mappedStatuses as never[] },
        karbonWorkItem: { isNot: null },
      },
      select: {
        id: true,
        status: true,
        karbonWorkStatusPushed: true,
        karbonWorkItem: { select: { karbonKey: true } },
      },
      take: input.limit ?? 50,
    });

    let pushed = 0;
    let skipped = 0;
    let failed = 0;

    for (const engagement of candidates) {
      const target = input.statusMap[engagement.status];
      const workItemKey = engagement.karbonWorkItem?.karbonKey;

      if (!target || !workItemKey || engagement.karbonWorkStatusPushed === target) {
        skipped += 1;
        continue;
      }

      try {
        const result = await input.karbon.updateWorkItemStatus(workItemKey, target);

        if (result.outcome !== 'SUCCEEDED') {
          skipped += 1;
          continue;
        }

        // Recorded only after Karbon accepted it. Writing it first would make a
        // failed push look permanently done and never be retried.
        await this.deps.prisma.engagement.update({
          where: { id: engagement.id },
          data: { karbonWorkStatusPushed: target },
        });

        await this.deps.audit.record({
          eventType: 'KARBON_WORK_STATUS_PUSHED',
          objectType: 'KarbonWorkItem',
          objectId: workItemKey,
          engagementId: engagement.id,
          beforeValue: { karbonWorkStatus: engagement.karbonWorkStatusPushed },
          afterValue: { karbonWorkStatus: target, fromEngagementStatus: engagement.status },
          correlationId: input.correlationId,
        });

        pushed += 1;
      } catch (error) {
        // One work item failing must not stop the rest of the pass, and the
        // next pass retries it because nothing was recorded as pushed.
        failed += 1;
        this.deps.logger.warn('Could not push a work status to Karbon', {
          engagementId: engagement.id,
          workItemKey,
          target,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { pushed, skipped, failed };
  }
}
