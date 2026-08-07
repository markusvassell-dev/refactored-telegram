import { Prisma, isUniqueConstraintError, type JobStatus, type PrismaClient } from '@element/database';
import { AppError, isRetryable, newCorrelationId, toUserMessage, type Logger } from '@element/shared';

/**
 * Postgres-backed background job queue.
 *
 * Built directly on the database we already run, using SELECT ... FOR UPDATE
 * SKIP LOCKED so that several worker processes can pull work concurrently
 * without double-processing a job.
 *
 * Every job carries a deterministic idempotency key. Enqueuing the same logical
 * work twice is a no-op, which is what makes retries safe: a retried
 * generation cannot produce a second draft, a retried upload cannot produce a
 * second Karbon document, and a retried send cannot produce a second Adobe
 * Sign agreement.
 */

export const JOB_TYPES = [
  'KARBON_SYNC',
  'LOCATE_PRIOR_YEAR_DOCUMENTS',
  'EXTRACT_DOCUMENT_TEXT',
  'PREPARE_ENGAGEMENT',
  'GENERATE_ENGAGEMENT_LETTER',
  'CONVERT_PDF',
  'COMPARE_DOCUMENTS',
  'UPLOAD_TO_KARBON',
  'CREATE_ADOBE_AGREEMENT',
  'SYNC_ADOBE_STATUS',
  'RETRIEVE_SIGNED_DOCUMENTS',
  'EXTRACT_COVER_LETTER_DATA',
  'GENERATE_COVER_LETTER',
  'DETECT_STALE_SOURCES',
  'BULK_ROLLOUT_ITEM',
  'PURGE_TEMPORARY_FILES',
  'SEND_NOTIFICATION_EMAILS',
] as const;

export type JobType = (typeof JOB_TYPES)[number];

export interface EnqueueOptions {
  jobType: JobType;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  engagementId?: string | null;
  documentVersionId?: string | null;
  correlationId?: string;
  maxAttempts?: number;
  /** Delay before the job first becomes eligible to run. */
  delayMs?: number;
}

export interface EnqueueResult {
  jobId: string;
  /** True when an identical job already existed and nothing new was created. */
  deduplicated: boolean;
}

export interface JobRecord {
  id: string;
  jobType: JobType;
  payload: Record<string, unknown>;
  correlationId: string;
  attempt: number;
  maxAttempts: number;
  engagementId: string | null;
  documentVersionId: string | null;
}

export interface JobHandlerContext {
  job: JobRecord;
  logger: Logger;
}

export type JobHandler = (context: JobHandlerContext) => Promise<Record<string, unknown> | void>;

/** Exponential backoff with jitter, capped so a stuck job is still retried. */
export function backoffDelayMs(attempt: number): number {
  const base = Math.min(2 ** attempt * 1_000, 15 * 60_000);
  return base + Math.floor(Math.random() * 1_000);
}

export class JobQueue {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
  ) {}

  async enqueue(options: EnqueueOptions): Promise<EnqueueResult> {
    const existing = await this.prisma.backgroundJob.findUnique({
      where: { idempotencyKey: options.idempotencyKey },
      select: { id: true },
    });

    if (existing) {
      this.logger.debug('Job already enqueued; skipping duplicate', {
        jobId: existing.id,
        jobType: options.jobType,
      });
      return { jobId: existing.id, deduplicated: true };
    }

    try {
      const job = await this.prisma.backgroundJob.create({
        data: {
          jobType: options.jobType,
          idempotencyKey: options.idempotencyKey,
          correlationId: options.correlationId ?? newCorrelationId(),
          payload: options.payload as Prisma.InputJsonValue,
          engagementId: options.engagementId ?? null,
          documentVersionId: options.documentVersionId ?? null,
          maxAttempts: options.maxAttempts ?? 5,
          runAt: new Date(Date.now() + (options.delayMs ?? 0)),
        },
        select: { id: true },
      });
      return { jobId: job.id, deduplicated: false };
    } catch (error) {
      // A concurrent enqueue won the race; that is still a successful dedupe.
      if (isUniqueConstraintError(error)) {
        const raced = await this.prisma.backgroundJob.findUnique({
          where: { idempotencyKey: options.idempotencyKey },
          select: { id: true },
        });
        if (raced) return { jobId: raced.id, deduplicated: true };
      }
      throw error;
    }
  }

  /**
   * Claims one runnable job for this worker.
   *
   * SKIP LOCKED means a second worker polling at the same moment simply gets a
   * different row instead of blocking or stealing this one.
   */
  async claim(workerId: string): Promise<JobRecord | null> {
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        jobType: string;
        payload: Record<string, unknown>;
        correlationId: string;
        attempt: number;
        maxAttempts: number;
        engagementId: string | null;
        documentVersionId: string | null;
      }[]
    >(Prisma.sql`
      UPDATE "background_job" AS j
         SET "status"    = 'RUNNING',
             "attempt"   = j."attempt" + 1,
             "startedAt" = NOW(),
             "lockedBy"  = ${workerId},
             "lockedAt"  = NOW(),
             "updatedAt" = NOW()
       WHERE j."id" = (
         SELECT c."id"
           FROM "background_job" AS c
          WHERE c."status" = 'PENDING'
            AND c."runAt" <= NOW()
          ORDER BY c."runAt" ASC, c."createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
      RETURNING j."id", j."jobType", j."payload", j."correlationId",
                j."attempt", j."maxAttempts", j."engagementId", j."documentVersionId"
    `);

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      jobType: row.jobType as JobType,
      payload: row.payload ?? {},
      correlationId: row.correlationId,
      attempt: row.attempt,
      maxAttempts: row.maxAttempts,
      engagementId: row.engagementId,
      documentVersionId: row.documentVersionId,
    };
  }

  async succeed(jobId: string, result?: Record<string, unknown>): Promise<void> {
    await this.prisma.backgroundJob.update({
      where: { id: jobId },
      data: {
        status: 'SUCCEEDED',
        completedAt: new Date(),
        result: (result ?? {}) as Prisma.InputJsonValue,
        failureReason: null,
        lockedBy: null,
        lockedAt: null,
      },
    });
  }

  /**
   * Records a failure.
   *
   * Transient failures back off and retry. A permanent validation failure is
   * never retried automatically — retrying it would just burn attempts and
   * delay the human who actually has to fix it.
   */
  async fail(job: JobRecord, error: unknown): Promise<{ willRetry: boolean; status: JobStatus }> {
    const retryable = isRetryable(error);
    const attemptsLeft = job.attempt < job.maxAttempts;
    const willRetry = retryable && attemptsLeft;

    const failureDetail = {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : String(error),
      category: error instanceof AppError ? error.category : 'INTERNAL',
      context: error instanceof AppError ? error.context : {},
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 12).join('\n') : undefined,
    };

    const status: JobStatus = willRetry ? 'PENDING' : 'DEAD_LETTER';

    await this.prisma.backgroundJob.update({
      where: { id: job.id },
      data: {
        status,
        failureReason: failureDetail.message.slice(0, 1000),
        failureDetail: failureDetail as unknown as Prisma.InputJsonValue,
        userMessage: toUserMessage(error),
        runAt: willRetry ? new Date(Date.now() + backoffDelayMs(job.attempt)) : undefined,
        completedAt: willRetry ? null : new Date(),
        lockedBy: null,
        lockedAt: null,
      },
    });

    return { willRetry, status };
  }

  /** Re-queues a dead-lettered job. Used by the administrator retry button. */
  async retry(jobId: string): Promise<void> {
    await this.prisma.backgroundJob.update({
      where: { id: jobId },
      data: {
        status: 'PENDING',
        runAt: new Date(),
        attempt: 0,
        failureReason: null,
        failureDetail: Prisma.JsonNull,
        userMessage: null,
        completedAt: null,
      },
    });
  }

  /** Releases jobs whose worker died mid-run so they become runnable again. */
  async reclaimStuckJobs(olderThanMs = 15 * 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const result = await this.prisma.backgroundJob.updateMany({
      where: { status: 'RUNNING', lockedAt: { lt: cutoff } },
      data: { status: 'PENDING', lockedBy: null, lockedAt: null, runAt: new Date() },
    });
    return result.count;
  }

  async countByStatus(): Promise<Record<string, number>> {
    const grouped = await this.prisma.backgroundJob.groupBy({ by: ['status'], _count: { _all: true } });
    return Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
  }
}
