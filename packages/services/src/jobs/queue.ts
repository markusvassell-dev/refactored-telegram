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
  'POLL_KARBON_TRIGGERS',
  'SYNC_KARBON_WORK_STATUS',
  'ROLL_OVER_ENGAGEMENT',
  'SYNC_CLIENT_DOCUMENTS',
  'LOCATE_PRIOR_YEAR_DOCUMENTS',
  'SCAN_CLIENT_DOCUMENTS',
  'EXTRACT_DOCUMENT_TEXT',
  'PREPARE_ENGAGEMENT',
  'GENERATE_ENGAGEMENT_LETTER',
  'CONVERT_PDF',
  'COMPARE_DOCUMENTS',
  'UPLOAD_TO_KARBON',
  'SYNC_ADOBE_STATUS',
  'RETRIEVE_SIGNED_DOCUMENTS',
  'FILE_EXTERNAL_SIGNATURE',
  'EXTRACT_COVER_LETTER_DATA',
  'GENERATE_COVER_LETTER',
  'DELIVER_COMPLETION_PACKAGE',
  'DETECT_STALE_SOURCES',
  'BULK_ROLLOUT_ITEM',
  'PURGE_TEMPORARY_FILES',
  'SWEEP_STUCK_ENGAGEMENTS',
  'SEND_NOTIFICATION_EMAILS',
  'IMPORT_CLIENTS_FROM_KARBON',
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
  /**
   * The state of the job that already held the key, when deduplicated.
   *
   * Dedup is by key across *every* state, `SUCCEEDED` included, which is right —
   * it is what stops a client being sent a second signature request. But it
   * makes "the work is already queued" and "the work ran to completion an hour
   * ago" arrive as the same answer, and a caller that flips a status to say
   * something is happening needs to tell those apart.
   */
  existingStatus?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTER' | 'CANCELLED';
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
      select: { id: true, status: true },
    });

    if (existing) {
      this.logger.debug('Job already enqueued; skipping duplicate', {
        jobId: existing.id,
        jobType: options.jobType,
        existingStatus: existing.status,
      });
      return { jobId: existing.id, deduplicated: true, existingStatus: existing.status };
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
          select: { id: true, status: true },
        });
        if (raced) return { jobId: raced.id, deduplicated: true, existingStatus: raced.status };
      }
      throw error;
    }
  }

  /**
   * Enqueues work that is safe to repeat, treating a key held by a *finished*
   * job as a request to run it again.
   *
   * Plain `enqueue` dedupes against every state, `SUCCEEDED` included, which is
   * what stops a retried job sending a client a second signature request. The
   * cost is that asking for the same read twice — re-reading a document, or
   * re-scanning a client's library — silently does nothing the second time.
   *
   * That is how an engagement came to sit at "extracting data" for ever: the
   * status was flipped, the enqueue deduped against a job that had already
   * succeeded, no job was created, nothing failed, and so nothing ever said so.
   *
   * Only for reads and recomputations. Anything that writes to a vendor or
   * reaches a client must keep the stricter guarantee.
   */
  async enqueueRerunnable(options: EnqueueOptions): Promise<EnqueueResult & { willRun: boolean }> {
    const first = await this.enqueue(options);
    if (!first.deduplicated) return { ...first, willRun: true };

    if (first.existingStatus === 'PENDING' || first.existingStatus === 'RUNNING') {
      // Genuinely already queued. Doing it twice would be the duplicate work
      // dedup exists to prevent.
      return { ...first, willRun: true };
    }

    // The key is held by a job that has finished, one way or another. The
    // caller is asking for the work again, so give it its own key.
    const retried = await this.enqueue({
      ...options,
      idempotencyKey: `${options.idempotencyKey}_again_${Date.now()}`,
    });

    return { ...retried, willRun: !retried.deduplicated };
  }

  /**
   * Claims one runnable job for this worker.
   *
   * SKIP LOCKED means a second worker polling at the same moment simply gets a
   * different row instead of blocking or stealing this one.
   *
   * The `attempt < maxAttempts` bound is load-bearing and was missing. `fail`
   * is the only thing that ever dead-letters a job, and it runs when a
   * **handler throws** — a job that ends the process instead, such as an
   * out-of-memory during PDF conversion or a container eviction, never reaches
   * it. `reclaimStuckJobs` would then return the row to `PENDING`, this query
   * would take it again, and it would kill the worker again, with `attempt`
   * climbing past `maxAttempts` for ever and nothing looking at it.
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
            -- See the note above: this bound is what stops a job that kills
            -- the worker from being taken for ever.
            AND c."attempt" < c."maxAttempts"
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

  /**
   * Records success, and lets the job say what it did.
   *
   * `result` is stored in full for an administrator, but **nothing reads that
   * column** — no screen selects it and there is no per-job detail page. So a
   * handler that finished real work had no way to report it: `userMessage` was
   * written only by `fail`, which meant the System Jobs page could explain every
   * failure and no success.
   *
   * A handler may therefore return a `userMessage` string alongside its result,
   * and it is lifted onto the column the page already renders. It stays out of
   * `result` so the stored payload remains the machine-readable one.
   */
  async succeed(jobId: string, result?: Record<string, unknown>): Promise<void> {
    const { userMessage, ...rest } = result ?? {};

    await this.prisma.backgroundJob.update({
      where: { id: jobId },
      data: {
        status: 'SUCCEEDED',
        completedAt: new Date(),
        result: rest as Prisma.InputJsonValue,
        userMessage: typeof userMessage === 'string' ? userMessage.slice(0, 1000) : null,
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

  /**
   * Releases jobs whose worker died mid-run, and buries the ones that keep
   * killing it.
   *
   * A worker that dies never calls `fail`, so nothing about such a job is ever
   * written down: it simply sits in `RUNNING` with a lock nobody holds. Putting
   * it back is right — a deploy in the middle of a long job should not lose the
   * work — but putting it back *unconditionally* is how a job that kills the
   * process gets retried for ever.
   *
   * So a job that has already used its attempts is dead-lettered here instead,
   * and the reason says the worker died rather than that the job failed. Those
   * are different things: one sends somebody to the handler's logic, the other
   * to the container's memory limit, and a job with no `failureReason` at all —
   * which is what this produced before — sends them nowhere.
   */
  async reclaimStuckJobs(olderThanMs = 15 * 60_000): Promise<{ released: number; buried: number }> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stuck = { status: 'RUNNING' as JobStatus, lockedAt: { lt: cutoff } };

    // Buried first. Doing it the other way round would release these rows and
    // then immediately bury them, and for the moment in between they would be
    // claimable — which is the whole thing being prevented.
    const buried = await this.prisma.backgroundJob.updateMany({
      where: { ...stuck, attempt: { gte: this.prisma.backgroundJob.fields.maxAttempts } },
      data: {
        status: 'DEAD_LETTER',
        failureReason: 'The worker stopped while this job was running, and its attempts are exhausted.',
        userMessage:
          'This job was interrupted every time it ran. That usually means it exhausted the worker’s memory rather than that it failed — check the worker’s resource limits before retrying it.',
        completedAt: new Date(),
        lockedBy: null,
        lockedAt: null,
      },
    });

    const released = await this.prisma.backgroundJob.updateMany({
      where: stuck,
      data: { status: 'PENDING', lockedBy: null, lockedAt: null, runAt: new Date() },
    });

    return { released: released.count, buried: buried.count };
  }

  /**
   * Deletes succeeded jobs past their retention window.
   *
   * Nothing deleted from this table at all, and four schedulers in the worker
   * write to it on a fixed cadence whether or not there is any work — the
   * notification-mail drain enqueues once a minute, the purge, Adobe sync and
   * Karbon trigger polls once an hour each. That is about 1,500 rows a day
   * before a single engagement is touched, and roughly half a million a year.
   *
   * Nothing breaks as it grows: `@@index([status, runAt])` keeps the claim
   * query fast at any size. What degrades is everything a person touches — the
   * System Jobs page, the backups, and any count over the whole table.
   *
   * **`DEAD_LETTER` rows are never swept, whatever their age.** They are the
   * record of what went wrong, they are the only thing an administrator has to
   * read, and there are few of them precisely because they are the exception.
   * `PENDING` and `RUNNING` are live work and are not the sweep's business
   * either.
   */
  async purgeSucceededJobs(retentionDays: number): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);

    const { count } = await this.prisma.backgroundJob.deleteMany({
      where: { status: 'SUCCEEDED', completedAt: { lt: cutoff } },
    });

    return count;
  }

  async countByStatus(): Promise<Record<string, number>> {
    const grouped = await this.prisma.backgroundJob.groupBy({ by: ['status'], _count: { _all: true } });
    return Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
  }
}
