import { backoffDelay, diagnosePollingFailure, REPEAT_FAILURE_LOG_AFTER_MS } from './polling-failure.js';
import type { Logger } from '@element/shared';

/**
 * Claiming work and running several jobs at once.
 *
 * This used to be a loop inside `index.ts` that read as concurrent and was not:
 *
 * ```ts
 * if (inFlight >= concurrency) { await sleep(50); continue; }
 * const claimed = await runOne().catch(...);   // ← awaited to completion
 * ```
 *
 * `runOne` raised `inFlight`, awaited the handler and lowered it again in a
 * `finally`. Because the loop awaited `runOne`, `inFlight` was always back to
 * zero by the next check, **the guard could never fire, and the worker ran
 * exactly one job at a time at every setting.** `WORKER_CONCURRENCY` defaults
 * to 4 and two documents described it as live — the runbook told an operator to
 * *lower* it if the worker was being OOM-killed, advice that could not do
 * anything at all.
 *
 * What that cost: the client import ran for eight minutes on 24 August 2026,
 * and for those eight minutes nothing else could run — no letter generated, no
 * notification email sent, no Adobe status synced.
 *
 * It lives here rather than in `index.ts` because `index.ts` starts a worker
 * and an HTTP server the moment it is imported, so nothing in it can be tested.
 * That is the reason this went unnoticed, and it is the same reason
 * `polling-failure.ts` exists.
 */

export interface DispatchOptions<TJob> {
  /** Takes the next job, or answers null when there is none. */
  claim: () => Promise<TJob | null>;
  /**
   * Runs one job to completion.
   *
   * **Must not reject.** The loop holds these promises and races them, and a
   * rejection would be thrown into the loop and end the worker. `runJob` in
   * `index.ts` guards its own failure path for exactly this reason.
   */
  run: (job: TJob) => Promise<void>;
  concurrency: number;
  /** How long to wait when there was nothing to claim. */
  idleDelayMs: number;
  logger: Logger;
  /** Whether to keep going. Checked before each claim. */
  isRunning: () => boolean;
  sleep: (ms: number) => Promise<void>;
  /** Exposed only so a test does not have to watch the clock. */
  now?: () => number;
}

/**
 * Runs until `isRunning` goes false, then waits for in-flight work to finish.
 *
 * Backing off is a property of *claiming*, not of running. That is a change:
 * one `await` used to cover both, so a handler that failed slowed the poller
 * down for every other job as well. A failing handler is already dealt with by
 * `queue.fail`, and punishing the queue for it helps nobody.
 */
export async function dispatchLoop<TJob>(options: DispatchOptions<TJob>): Promise<void> {
  const { claim, run, concurrency, idleDelayMs, logger, isRunning, sleep } = options;
  const now = options.now ?? Date.now;

  const active = new Set<Promise<void>>();
  let consecutiveFailures = 0;
  let lastFailureLoggedAt = 0;

  while (isRunning()) {
    if (active.size >= concurrency) {
      // Wake the moment a slot frees rather than on a fixed tick. The old code
      // polled every 50 ms for a condition that could never hold.
      await Promise.race(active);
      continue;
    }

    let job: TJob | null = null;
    let claimFailed = false;


    try {
      job = await claim();
    } catch (error) {
      claimFailed = true;
      consecutiveFailures += 1;

      const at = now();
      const isFirst = consecutiveFailures === 1;
      if (isFirst || at - lastFailureLoggedAt >= REPEAT_FAILURE_LOG_AFTER_MS) {
        lastFailureLoggedAt = at;
        logger.error('Queue polling failed', {
          message: error instanceof Error ? error.message : String(error),
          consecutiveFailures,
          diagnosis: diagnosePollingFailure(error) ?? undefined,
          // Said once, so nobody reads the silence that follows as the problem
          // having gone away.
          note: isFirst
            ? 'Backing off; this will be repeated at most every five minutes while it persists.'
            : undefined,
        });
      }
    }

    if (claimFailed) {
      await sleep(backoffDelay(idleDelayMs, consecutiveFailures));
      continue;
    }

    if (consecutiveFailures > 0) {
      logger.info('Queue polling recovered', { afterFailures: consecutiveFailures });
      consecutiveFailures = 0;
      lastFailureLoggedAt = 0;
    }

    // `=== null`, not `!job`. `claim` is declared as returning `TJob | null`,
    // and a truthiness test quietly adds "or anything falsy" to that contract —
    // which for the real worker is harmless, since a job is an object, and for
    // anything else is a job silently dropped. The tests below claim numeric
    // jobs and the first one is `0`.
    if (job === null) {
      await sleep(idleDelayMs);
      continue;
    }

    // Deliberately not awaited: this is the whole change.
    //
    // The `catch` is not decoration. `run` is documented as never rejecting,
    // but these promises are handed to `Promise.race`, and one rejection there
    // would be thrown into this loop and stop the worker taking any further
    // work — a contract worth enforcing here rather than trusting every future
    // caller to honour. Referring to `handle` inside its own `.finally` is safe
    // because that callback cannot run before the binding is initialised.
    const handle: Promise<void> = run(job)
      .catch((error: unknown) => {
        logger.error('A job handler rejected, which it is not supposed to do', {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        active.delete(handle);
      });

    active.add(handle);
  }

  // Finish what is in flight rather than abandoning it. `shutdown` in
  // `index.ts` also waits, but on a timer; this makes the drain the loop's own
  // business and therefore deterministic.
  await Promise.allSettled(active);
}
