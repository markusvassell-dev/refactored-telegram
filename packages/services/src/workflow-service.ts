import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { NotFoundError, newCorrelationId } from '@element/shared';
import { assertTransition, type EngagementStatus } from '@element/workflows';

/**
 * Engagement status transitions.
 *
 * Every transition is validated in the application, recorded as a
 * WorkflowEvent, and written to the immutable audit trail. The database
 * trigger validates it a second time, so an illegal transition fails even if
 * it is attempted through a path that skipped this service.
 */

export interface TransitionOptions {
  engagementId: string;
  to: EngagementStatus;
  reason?: string;
  userId?: string | null;
  correlationId?: string;
  /** Set alongside a move into NEEDS_ATTENTION or a blocked state. */
  blockedReason?: string | null;
}

export interface TransitionResult {
  from: EngagementStatus;
  to: EngagementStatus;
  changed: boolean;
}

export class WorkflowService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditLogger,
  ) {}

  async transition(options: TransitionOptions): Promise<TransitionResult> {
    const engagement = await this.prisma.engagement.findUnique({
      where: { id: options.engagementId },
      select: { id: true, status: true },
    });

    if (!engagement) throw new NotFoundError('Engagement');

    const from = engagement.status as EngagementStatus;
    if (from === options.to) return { from, to: options.to, changed: false };

    assertTransition(from, options.to);

    const correlationId = options.correlationId ?? newCorrelationId();

    await this.prisma.$transaction([
      this.prisma.engagement.update({
        where: { id: options.engagementId },
        data: {
          status: options.to,
          blockedReason: options.blockedReason ?? null,
          correlationId,
        },
      }),
      this.prisma.workflowEvent.create({
        data: {
          engagementId: options.engagementId,
          fromStatus: from,
          toStatus: options.to,
          reason: options.reason ?? null,
          triggeredBy: options.userId ?? null,
          correlationId,
        },
      }),
    ]);

    await this.audit.record({
      eventType: 'STATUS_CHANGED',
      objectType: 'Engagement',
      objectId: options.engagementId,
      engagementId: options.engagementId,
      userId: options.userId ?? null,
      beforeValue: { status: from },
      afterValue: { status: options.to },
      reason: options.reason ?? null,
      correlationId,
    });

    return { from, to: options.to, changed: true };
  }

  /**
   * Moves an engagement to NEEDS_ATTENTION with a human-readable reason.
   * Used when retries are exhausted or a precondition cannot be satisfied.
   */
  async needsAttention(
    engagementId: string,
    reason: string,
    options: { userId?: string | null; correlationId?: string } = {},
  ): Promise<TransitionResult> {
    return this.transition({
      engagementId,
      to: 'NEEDS_ATTENTION',
      reason,
      blockedReason: reason,
      userId: options.userId ?? null,
      correlationId: options.correlationId,
    });
  }

  async currentStatus(engagementId: string): Promise<EngagementStatus> {
    const engagement = await this.prisma.engagement.findUnique({
      where: { id: engagementId },
      select: { status: true },
    });
    if (!engagement) throw new NotFoundError('Engagement');
    return engagement.status as EngagementStatus;
  }
}
