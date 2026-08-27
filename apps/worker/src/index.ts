import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { JobRecord, JobType } from '@element/services';
import { buildWorkerContext } from './context.js';
import { buildHandlers } from './handlers.js';
import { dispatchLoop } from './dispatch.js';

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

/**
 * Runs one claimed job to completion.
 *
 * **Never rejects**, which is a contract rather than a courtesy: `dispatchLoop`
 * holds these promises and races them, so a rejection would be thrown into the
 * loop and end the worker. The old shape could reject — `queue.fail` is called
 * inside the `catch` below and was not itself guarded, so a database outage
 * during a failure took the whole thing down — and the loop caught it only
 * because it awaited each job one at a time. It no longer does.
 */
async function runJob(job: JobRecord): Promise<void> {
  const jobLogger = logger.child({
    jobId: job.id,
    jobType: job.jobType,
    correlationId: job.correlationId,
    engagementId: job.engagementId ?? undefined,
    attempt: job.attempt,
  });

  try {
    await runHandler(job, jobLogger);
  } catch (error) {
    // Everything below has already tried to record itself; reaching here means
    // the recording failed too. Saying so is all that is left, and it must not
    // propagate.
    failed += 1;
    lastFailureAt = new Date();
    jobLogger.error('Could not record the outcome of a job', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runHandler(job: JobRecord, jobLogger: ReturnType<typeof logger.child>): Promise<void> {
  const handler = handlers[job.jobType as JobType];
  if (!handler) {
    await context.queue.fail(job, new Error(`No handler is registered for job type ${job.jobType}`));
    jobLogger.error('No handler registered for job type');
    return;
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
}

/**
 * Claims work and runs up to `WORKER_CONCURRENCY` jobs at once.
 *
 * The loop itself is in dispatch.ts, where it can be tested — which is the
 * point, since the reason this ran serially for so long is that nothing in this
 * file can be imported without starting a worker and an HTTP server.
 */
function loop(): Promise<void> {
  return dispatchLoop<JobRecord>({
    claim: () => context.queue.claim(WORKER_ID),
    run: runJob,
    concurrency: context.env.WORKER_CONCURRENCY,
    idleDelayMs: context.env.WORKER_POLL_INTERVAL_MS,
    logger,
    isRunning: () => running,
    sleep,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Periodic maintenance: reclaim stuck jobs and purge expired working copies. */
async function maintenance(): Promise<void> {
  while (running) {
    try {
      const { released, buried } = await context.queue.reclaimStuckJobs();
      if (released > 0) logger.warn('Reclaimed stuck jobs', { released });
      if (buried > 0) {
        // Distinct from a reclaim, and at error level, because this is the
        // shape of a job that ends the worker process rather than failing:
        // usually memory, and never something a retry will fix.
        logger.error('Dead-lettered jobs that used every attempt without ever reporting a failure', {
          buried,
          likelyCause: 'the worker was killed mid-run — check its memory limit',
        });
      }

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

      // A status nothing can clear is the shape of bug this exists for, not one
      // instance of it. `reclaimStuckJobs` above rescues a stuck *job*; nothing
      // watched an engagement parked mid-flight with no job behind it at all.
      await context.queue.enqueue({
        jobType: 'SWEEP_STUCK_ENGAGEMENTS',
        idempotencyKey: `sweep_engagements_${new Date().toISOString().slice(0, 13)}`,
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

/**
 * Asking Karbon what has reached a configured status.
 *
 * Hourly, and deliberately so. The bucket in the idempotency key is what sets
 * the real cadence, not the sleep below — `maintenance` reads as quarter-hourly
 * and is not, because `slice(0, 13)` truncates to the hour and a second pass in
 * the same hour deduplicates against the first. That is also what stops several
 * worker replicas each queueing the same pass.
 *
 * Hourly is right here for two reasons. Karbon allows about 120 requests a
 * minute across everything the firm runs, and this spends one per configured
 * trigger. And an engagement letter is not urgent: the difference between
 * noticing a status change at once and noticing it within the hour is not a
 * difference anybody at the firm can feel.
 */
async function karbonTriggerPoll(): Promise<void> {
  while (running) {
    try {
      await context.queue.enqueue({
        jobType: 'POLL_KARBON_TRIGGERS',
        idempotencyKey: `karbon_triggers_${new Date().toISOString().slice(0, 13)}`,
        payload: {},
      });
    } catch (error) {
      logger.error('Could not queue the Karbon trigger poll', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(15 * 60_000);
  }
}

/**
 * Bringing Karbon work items into line with where engagements have got to.
 *
 * Hourly, on the same bucket-key trick as the trigger poll above, and for the
 * same two reasons: Karbon's rate allowance is shared with everything else the
 * firm runs, and a work status label is not urgent.
 *
 * Separate from the trigger poll rather than folded into it because the two
 * fail independently — Karbon refusing to accept a status write is no reason to
 * stop asking it what has reached one — and because an unconfigured status map
 * makes this pass free while the trigger poll still has work to do.
 */
async function karbonWorkStatusPush(): Promise<void> {
  while (running) {
    try {
      await context.queue.enqueue({
        jobType: 'SYNC_KARBON_WORK_STATUS',
        idempotencyKey: `karbon_work_status_${new Date().toISOString().slice(0, 13)}`,
        payload: {},
      });
    } catch (error) {
      logger.error('Could not queue the Karbon work status push', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(15 * 60_000);
  }
}

/**
 * Getting notices into inboxes.
 *
 * On its own loop rather than folded into maintenance, because the cadences
 * differ by an order of magnitude for good reason: purging temporary files can
 * wait a quarter of an hour, and "a client signed" cannot. The drain is one
 * indexed query when there is nothing to send, so a minute costs nothing.
 */
async function notificationMail(): Promise<void> {
  while (running) {
    try {
      await context.queue.enqueue({
        jobType: 'SEND_NOTIFICATION_EMAILS',
        // Per minute: a second worker on the same minute is a duplicate, not a
        // second batch.
        idempotencyKey: `notification_mail_${new Date().toISOString().slice(0, 16)}`,
        payload: {},
      });
    } catch (error) {
      logger.error('Could not queue the notification mail drain', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(60_000);
  }
}

// ---- Health endpoints -------------------------------------------------------

/**
 * `/api/health` and `/api/ready` are aliases of the worker's own paths, so that
 * one platform configuration serves both services. Railway applies a single
 * `railway.json` to every service built from this repository; a health-check
 * path that only the web service answered would fail the worker's deployment
 * while the worker itself was running perfectly well.
 */
const healthServer = createServer((request, response) => {
  const url = request.url ?? '/';

  if (url === '/health' || url === '/healthz' || url === '/api/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', service: 'worker', workerId: WORKER_ID }));
    return;
  }

  if (url === '/ready' || url === '/api/ready') {
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

/**
 * The platform assigns the port it will probe; the worker does not get to pick
 * it. Railway sets PORT and health-checks that port, so a worker listening on
 * its own WORKER_HEALTH_PORT is unreachable and the deployment is marked
 * unhealthy even though the worker is running perfectly well. PORT wins when it
 * is set; WORKER_HEALTH_PORT stays the default for local development and
 * docker-compose, where nothing assigns one.
 */
const assignedPort = Number.parseInt(process.env.PORT ?? '', 10);
const healthPort = Number.isFinite(assignedPort) && assignedPort > 0 ? assignedPort : context.env.WORKER_HEALTH_PORT;

healthServer.listen(healthPort, () => {
  logger.info('Worker started', {
    workerId: WORKER_ID,
    concurrency: context.env.WORKER_CONCURRENCY,
    healthPort,
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
void notificationMail();
void karbonTriggerPoll();
void karbonWorkStatusPush();
