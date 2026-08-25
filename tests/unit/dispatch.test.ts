import { describe, expect, it, vi } from 'vitest';
import { dispatchLoop } from '../../apps/worker/src/dispatch.js';
import { createLogger } from '@element/shared';

/**
 * The worker runs several jobs at once, and this is the file that says so.
 *
 * It did not. The loop read as concurrent — there was an `inFlight >=
 * concurrency` guard and a `WORKER_CONCURRENCY` setting defaulting to 4 — and
 * it awaited each job to completion, so `inFlight` was always back to zero by
 * the next check and the guard could never fire. **The worker ran exactly one
 * job at a time at every setting**, while two documents described the knob as
 * live and the runbook told operators to lower it to fix memory pressure.
 *
 * Nothing failed. Jobs still ran, in order, and every test passed — the queue
 * simply drained four times slower than anybody believed, and an eight-minute
 * client import stopped every letter, email and status sync behind it.
 *
 * So the first assertion below is the one that matters: three jobs in flight at
 * the same moment. It is the thing that was actually wrong, and its absence is
 * why this shipped.
 */

const logger = createLogger({ base: { test: 'dispatch' } });

/** A job that does not finish until the test lets it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * A `sleep` that returns at once but still yields to the event loop.
 *
 * It has to be a real macrotask. An `async () => {}` returns a resolved
 * promise, and awaiting one only yields a microtask — so the loop's idle path
 * spins through microtasks for ever and starves the timers `vi.waitFor`
 * depends on, and the test hangs rather than failing. That is a property of
 * the test, not of the loop, but it is easy to walk into twice.
 */
const immediately = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the dispatch loop', () => {
  it('runs up to the configured number of jobs at once', async () => {
    // Against the previous implementation this reaches 1 and deadlocks: the
    // second job is never claimed, because the first is still being awaited.
    const gates = [deferred(), deferred(), deferred()];
    let claimed = 0;
    let peak = 0;
    let inFlight = 0;
    let running = true;

    const loop = dispatchLoop<number>({
      claim: async () => (claimed < 3 ? claimed++ : null),
      run: async (job) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gates[job]!.promise;
        inFlight -= 1;
      },
      concurrency: 3,
      idleDelayMs: 1,
      logger,
      isRunning: () => running,
      sleep: immediately,
    });

    await vi.waitFor(() => expect(inFlight).toBe(3));
    expect(peak).toBe(3);

    for (const gate of gates) gate.resolve();
    running = false;
    await loop;
  });

  it('never exceeds the limit, however much work is waiting', async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    let inFlight = 0;
    let peak = 0;
    let running = true;

    const loop = dispatchLoop<number>({
      claim: async () => {
        gates.push(deferred());
        return gates.length - 1;
      },
      run: async (job) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await gates[job]!.promise;
        inFlight -= 1;
      },
      concurrency: 2,
      idleDelayMs: 1,
      logger,
      isRunning: () => running,
      sleep: immediately,
    });

    await vi.waitFor(() => expect(inFlight).toBe(2));
    // An unbounded queue of work must not become an unbounded number of
    // handlers: several of these open database connections and shell out to
    // LibreOffice, which is what the memory limit is spent on.
    expect(peak).toBe(2);

    running = false;
    for (const gate of gates) gate.resolve();
    await loop;
  });

  it('keeps claiming while a slow job runs', async () => {
    // The behaviour the eight-minute client import needed and did not have.
    const slow = deferred();
    const finished: string[] = [];
    let handed = 0;
    let running = true;

    const loop = dispatchLoop<string>({
      claim: async () => {
        if (handed === 0) {
          handed += 1;
          return 'the-slow-one';
        }
        if (handed < 4) {
          handed += 1;
          return `quick-${handed}`;
        }
        return null;
      },
      run: async (job) => {
        if (job === 'the-slow-one') await slow.promise;
        finished.push(job);
      },
      concurrency: 4,
      idleDelayMs: 1,
      logger,
      isRunning: () => running,
      sleep: immediately,
    });

    await vi.waitFor(() => expect(finished).toHaveLength(3));
    expect(finished).not.toContain('the-slow-one');

    slow.resolve();
    running = false;
    await loop;
    expect(finished).toContain('the-slow-one');
  });

  it('finishes what is in flight before it returns', async () => {
    // A deploy must not abandon half-done work. `shutdown` also waits, but on a
    // timer; the drain here is what makes it deterministic.
    const gate = deferred();
    let done = false;
    let running = true;
    let claimed = false;

    const loop = dispatchLoop<number>({
      claim: async () => (claimed ? null : ((claimed = true), 1)),
      run: async () => {
        await gate.promise;
        done = true;
      },
      concurrency: 2,
      idleDelayMs: 1,
      logger,
      isRunning: () => running,
      sleep: immediately,
    });

    await vi.waitFor(() => expect(claimed).toBe(true));
    running = false;
    gate.resolve();
    await loop;

    expect(done).toBe(true);
  });

  it('does not stop taking work when a handler rejects', async () => {
    // `run` is documented as never rejecting, and `runJob` honours that. But
    // these promises are handed to `Promise.race`, so one rejection would be
    // thrown into the loop and the worker would quietly stop claiming anything
    // ever again — a failure with no error and no restart.
    let claims = 0;
    const ran: number[] = [];
    let running = true;

    const loop = dispatchLoop<number>({
      claim: async () => (claims < 3 ? claims++ : null),
      run: async (job) => {
        ran.push(job);
        if (job === 0) throw new Error('a handler that should not have thrown');
      },
      concurrency: 1,
      idleDelayMs: 1,
      logger,
      isRunning: () => running,
      sleep: immediately,
    });

    await vi.waitFor(() => expect(ran).toEqual([0, 1, 2]));
    running = false;
    await loop;
  });

  it('backs off when the queue cannot be reached, and recovers', async () => {
    const waits: number[] = [];
    let attempts = 0;
    let running = true;
    const ran: number[] = [];

    const loop = dispatchLoop<number>({
      claim: async () => {
        attempts += 1;
        if (attempts <= 3) throw new Error("Can't reach database server");
        return attempts === 4 ? 1 : null;
      },
      run: async (job) => {
        ran.push(job);
      },
      concurrency: 2,
      idleDelayMs: 100,
      logger,
      isRunning: () => running,
      sleep: (ms) => {
        waits.push(ms);
        return immediately();
      },
    });

    await vi.waitFor(() => expect(ran).toEqual([1]));
    running = false;
    await loop;

    // Geometric: the first failure waits the ordinary interval so a blip costs
    // nothing, and it climbs from there.
    expect(waits.slice(0, 3)).toEqual([100, 200, 400]);
  });

  it('does not back off the poller because a handler failed', async () => {
    // A change from the previous shape, and a deliberate one. One `await` used
    // to cover both claiming and running, so a failing handler slowed the
    // queue for every other job. A failed handler is already dealt with by
    // `queue.fail`; punishing the queue for it helps nobody.
    const waits: number[] = [];
    let claims = 0;
    let running = true;
    const ran: number[] = [];

    const loop = dispatchLoop<number>({
      claim: async () => (claims < 3 ? claims++ : null),
      run: async (job) => {
        ran.push(job);
        throw new Error('this handler always fails');
      },
      concurrency: 1,
      idleDelayMs: 100,
      logger,
      isRunning: () => running,
      sleep: (ms) => {
        waits.push(ms);
        return immediately();
      },
    });

    await vi.waitFor(() => expect(ran).toEqual([0, 1, 2]));
    running = false;
    await loop;

    // Every wait is the plain idle interval — nothing longer, which is what a
    // backoff would look like.
    expect(waits.every((wait) => wait === 100)).toBe(true);
  });
});
