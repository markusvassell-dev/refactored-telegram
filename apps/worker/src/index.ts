import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { JobType } from '@element/services';
import { buildWorkerContext } from './context.js';
import { buildHandlers } from './handlers.js';

/**
 * Worker entry point.
 *
 * Polls the Postgres-backed queue, runs handlers with bounded concurrency, and
 * exposes a health endpoint so Railway can tell whether the worker is alive and
 * whether it is actually draining work.
 */

const WORKER_ID = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;

const context = buildWorkerContext();
const handlers = buildHandlers(context);
const logger = context.logger.child({ workerId: WORKER_ID });

let running = true;
let inFlight = 0;
let lastSuccessAt: Date | null = null;
let lastFailureAt: Date | null = null;
let processed = 0;
let failed = 0;

async function runOne(): Promise<boolean> {
  const job = await context.queue.claim(WORKER_ID);
  if (!job) return false;

  const jobLogger = logger.child({
    jobId: job.id,
    jobType: job.jobType,
    correlationId: job.correlationId,
    engagementId: job.engagementId ?? undefined,
    attempt: job.attempt,
  });

  const handler = handlers[job.jobType as JobType];
  if (!handler) {
    await context.queue.fail(job, new Error(`No handler is registered for job type ${job.jobType}`));
    jobLogger.error('No handler registered for job type');
    return true;
  }

  inFlight += 1;
  try {
    jobLogger.info('Job started');
    const result = await handler({ job, logger: jobLogger });
    await context.queue.succeed(job.id, result ?? {});
    lastSuccessAt = new Date();
    processed += 1;
    jobLogger.info('Job succeeded');
  } catch (error) {
    failed += 1;
    lastFailureAt = new Date();

    const outcome = await context.queue.fail(job, error);
    jobLogger.error('Job failed', {
      willRetry: outcome.willRetry,
      status: outcome.status,
      message: error instanceof Error ? error.message : String(error),
    });

    // Once retries are exhausted the engagement is surfaced to a human rather
    // than silently left in an intermediate state.
    if (!outcome.willRetry && job.engagementId) {
      await context.workflow
        .needsAttention(
          job.engagementId,
          `A background job (${job.jobType}) could not be completed after ${job.attempt} attempts.`,
          { correlationId: job.correlationId },
        )
        .catch((secondary: unknown) => {
          jobLogger.error('Could not move the engagement to NEEDS_ATTENTION', {
            message: secondary instanceof Error ? secondary.message : String(secondary),
          });
        });

      await context.audit
        .record({
          eventType: 'JOB_FAILED',
          objectType: 'BackgroundJob',
          objectId: job.id,
          engagementId: job.engagementId,
          correlationId: job.correlationId,
          afterValue: { jobType: job.jobType, attempts: job.attempt },
        })
        .catch(() => undefined);
    }
  } finally {
    inFlight -= 1;
  }

  return true;
}

async function loop(): Promise<void> {
  const concurrency = context.env.WORKER_CONCURRENCY;
  const idleDelay = context.env.WORKER_POLL_INTERVAL_MS;

  while (running) {
    if (inFlight >= concurrency) {
      await sleep(50);
      continue;
    }

    const claimed = await runOne().catch((error: unknown) => {
      logger.error('Queue polling failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    });

    if (!claimed) await sleep(idleDelay);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Periodic maintenance: reclaim stuck jobs and purge expired working copies. */
async function maintenance(): Promise<void> {
  while (running) {
    try {
      const reclaimed = await context.queue.reclaimStuckJobs();
      if (reclaimed > 0) logger.warn('Reclaimed stuck jobs', { reclaimed });

      await context.queue.enqueue({
        jobType: 'PURGE_TEMPORARY_FILES',
        idempotencyKey: `purge_${new Date().toISOString().slice(0, 13)}`,
        payload: {},
      });

      await context.queue.enqueue({
        jobType: 'SYNC_ADOBE_STATUS',
        idempotencyKey: `adobe_sync_${new Date().toISOString().slice(0, 13)}`,
        payload: {},
      });
    } catch (error) {
      logger.error('Maintenance pass failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(15 * 60_000);
  }
}

// ---- Health endpoints -------------------------------------------------------

const healthServer = createServer((request, response) => {
  const url = request.url ?? '/';

  if (url === '/health' || url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', workerId: WORKER_ID }));
    return;
  }

  if (url === '/ready') {
    void context.prisma
      .$queryRaw`SELECT 1`
      .then(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            status: 'ready',
            workerId: WORKER_ID,
            inFlight,
            processed,
            failed,
            lastSuccessAt,
            lastFailureAt,
          }),
        );
      })
      .catch(() => {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'not-ready', reason: 'database unreachable' }));
      });
    return;
  }

  response.writeHead(404).end();
});

healthServer.listen(context.env.WORKER_HEALTH_PORT, () => {
  logger.info('Worker started', {
    workerId: WORKER_ID,
    concurrency: context.env.WORKER_CONCURRENCY,
    healthPort: context.env.WORKER_HEALTH_PORT,
    testMode: context.env.TEST_MODE,
  });
});

async function shutdown(signal: string): Promise<void> {
  logger.info('Shutting down', { signal, inFlight });
  running = false;

  // Let in-flight jobs finish so a deploy cannot orphan half-done work.
  const deadline = Date.now() + 30_000;
  while (inFlight > 0 && Date.now() < deadline) await sleep(200);

  healthServer.close();
  await context.prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

void loop();
void maintenance();
