import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { JobQueue } from '@element/services';
import { createLogger } from '@element/shared';

/**
 * The two ends of a job's life that nothing was watching.
 *
 * Both defects here are about jobs that never *fail* in the sense the queue
 * understands. `fail` is the only thing that dead-letters a job and it runs
 * when a handler throws — so a job that ends the worker process instead was
 * invisible to every mechanism the queue has. It sat in RUNNING with a lock
 * nobody held, `reclaimStuckJobs` returned it to PENDING, `claim` took it
 * again, and it killed the worker again. `attempt` climbed past `maxAttempts`
 * for ever and nothing looked at it.
 *
 * And at the other end, nothing ever deleted a row. Four schedulers write to
 * this table on a fixed cadence whether or not there is work, so it grew by
 * about 1,500 rows a day before a single engagement was touched.
 */

const prisma = new PrismaClient();
const queue = new JobQueue(prisma, createLogger({ base: { test: 'job-queue-limits' } }));

const suffix = randomUUID().slice(0, 8);
const key = (name: string) => `limits-${name}-${suffix}`;

/** A job in whatever state the test needs, without going through the queue. */
async function seed(options: {
  name: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'DEAD_LETTER';
  attempt?: number;
  maxAttempts?: number;
  lockedAt?: Date | null;
  completedAt?: Date | null;
}): Promise<string> {
  const job = await prisma.backgroundJob.create({
    data: {
      jobType: 'PURGE_TEMPORARY_FILES',
      idempotencyKey: key(options.name),
      correlationId: randomUUID(),
      payload: {},
      status: options.status,
      attempt: options.attempt ?? 0,
      maxAttempts: options.maxAttempts ?? 5,
      lockedAt: options.lockedAt ?? null,
      lockedBy: options.lockedAt ? 'a-worker-that-died' : null,
      completedAt: options.completedAt ?? null,
      // Far enough back that ordering never lets an unrelated job win the claim.
      runAt: new Date(Date.now() - 60_000),
    },
    select: { id: true },
  });
  return job.id;
}

const AN_HOUR_AGO = () => new Date(Date.now() - 3_600_000);
const LONG_AGO = () => new Date(Date.now() - 90 * 86_400_000);

beforeAll(async () => {
  await prisma.$connect();
});

beforeEach(async () => {
  await prisma.backgroundJob.deleteMany({ where: { idempotencyKey: { contains: `-${suffix}` } } });
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { idempotencyKey: { contains: `-${suffix}` } } });
  await prisma.$disconnect();
});

describe('claiming a job', () => {
  it('will not take one that has already used every attempt', async () => {
    // The defect. Without the bound in `claim`, a job that kills the worker is
    // reclaimed and re-taken without limit, because the only thing that ever
    // dead-letters is a handler that threw — and this one never gets that far.
    const exhausted = await seed({ name: 'exhausted', status: 'PENDING', attempt: 5, maxAttempts: 5 });

    const claimed = await queue.claim('worker-1');

    expect(claimed?.id).not.toBe(exhausted);
  });

  it('still takes one with an attempt left', async () => {
    // The other half: the bound must not be so tight that ordinary retries stop.
    const id = await seed({ name: 'one-left', status: 'PENDING', attempt: 4, maxAttempts: 5 });

    const claimed = await queue.claim('worker-1');

    expect(claimed?.id).toBe(id);
    expect(claimed?.attempt).toBe(5);
  });
});

describe('reclaiming after a worker dies', () => {
  it('puts an interrupted job back when it still has attempts', async () => {
    // A deploy in the middle of a long job must not lose the work.
    const id = await seed({ name: 'interrupted', status: 'RUNNING', attempt: 1, lockedAt: AN_HOUR_AGO() });

    const { released, buried } = await queue.reclaimStuckJobs();

    expect(released).toBeGreaterThanOrEqual(1);
    expect(buried).toBe(0);
    const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('PENDING');
    expect(row.lockedBy).toBeNull();
  });

  it('buries one that has been interrupted every time, and says why', async () => {
    const id = await seed({ name: 'always-dies', status: 'RUNNING', attempt: 5, maxAttempts: 5, lockedAt: AN_HOUR_AGO() });

    const { buried } = await queue.reclaimStuckJobs();

    expect(buried).toBe(1);
    const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('DEAD_LETTER');
    // A job buried this way used to carry no reason at all, because `fail` was
    // never called on it. "The worker stopped" and "the job failed" send an
    // administrator to different places, so the record has to say which.
    expect(row.failureReason).toMatch(/worker stopped/i);
    expect(row.userMessage).toMatch(/memory/i);
    expect(row.lockedBy).toBeNull();
  });

  it('leaves a job whose worker is still holding it alone', async () => {
    const id = await seed({ name: 'live', status: 'RUNNING', attempt: 1, lockedAt: new Date() });

    await queue.reclaimStuckJobs();

    expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id } })).status).toBe('RUNNING');
  });
});

describe('sweeping finished jobs', () => {
  it('deletes a succeeded job past the window', async () => {
    const id = await seed({ name: 'old-success', status: 'SUCCEEDED', completedAt: LONG_AGO() });

    expect(await queue.purgeSucceededJobs(30)).toBeGreaterThanOrEqual(1);
    expect(await prisma.backgroundJob.findUnique({ where: { id } })).toBeNull();
  });

  it('keeps a dead-lettered job of exactly the same age', async () => {
    // The assertion that matters most here. These are the record of what went
    // wrong and the only thing an administrator has to read; a sweep that took
    // them would delete the evidence and leave the bookkeeping.
    const id = await seed({ name: 'old-failure', status: 'DEAD_LETTER', completedAt: LONG_AGO() });

    await queue.purgeSucceededJobs(30);

    expect(await prisma.backgroundJob.findUnique({ where: { id } })).not.toBeNull();
  });

  it('keeps a recent success, and never touches live work', async () => {
    const recent = await seed({ name: 'recent-success', status: 'SUCCEEDED', completedAt: new Date() });
    const pending = await seed({ name: 'pending', status: 'PENDING' });
    const running = await seed({ name: 'running', status: 'RUNNING', lockedAt: new Date() });

    await queue.purgeSucceededJobs(30);

    for (const id of [recent, pending, running]) {
      expect(await prisma.backgroundJob.findUnique({ where: { id } })).not.toBeNull();
    }
  });
});
