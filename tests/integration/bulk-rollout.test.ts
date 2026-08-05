import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { BulkRolloutService, JobQueue, PricingService } from '@element/services';
import { createLogger, type Principal } from '@element/shared';

/**
 * The annual rollout.
 *
 * This is the one action in the application that touches many clients at once,
 * so the properties that matter are about restraint: it queues only what is
 * genuinely ready, whatever the caller submitted; running it twice does not
 * produce two drafts; and a dry run tells the truth without doing anything.
 */

const prisma = new PrismaClient();
const logger = createLogger({ level: 'error' });
const audit = createAuditLogger(prisma);
const queue = new JobQueue(prisma, logger);
const pricing = new PricingService(prisma, audit);
const bulk = new BulkRolloutService(prisma, queue, audit);

const clientIds: string[] = [];
let preparer: Principal;
let readOnly: Principal;

const TAX_YEAR = 2911;

/**
 * A client per fixture engagement. One engagement exists per client, type and
 * year, and it keeps each fixture independent of the others.
 */
async function newClient(): Promise<string> {
  const client = await prisma.client.create({
    data: { legalName: `Bulk Rollout Co ${randomUUID().slice(0, 8)}`, isTestFixture: true },
  });
  clientIds.push(client.id);
  return client.id;
}

async function makeUser(email: string, roles: Principal['roles']): Promise<Principal> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, displayName: email.split('@')[0] as string },
    update: {},
  });
  for (const role of roles) {
    await prisma.userRole.upsert({
      where: { userId_role: { userId: user.id, role } },
      create: { userId: user.id, role },
      update: {},
    });
  }
  return { id: user.id, email: user.email, displayName: user.displayName, roles };
}

beforeAll(async () => {
  await prisma.$connect();

  preparer = await makeUser('bulk-preparer@example.test', ['PREPARER']);
  readOnly = await makeUser('bulk-readonly@example.test', ['READ_ONLY']);
});

afterAll(async () => {
  const engagements = await prisma.engagement.findMany({
    where: { clientId: { in: clientIds } },
    select: { id: true },
  });
  await prisma.backgroundJob.deleteMany({ where: { engagementId: { in: engagements.map((row) => row.id) } } });
  await prisma.engagement.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.$disconnect();
});

/**
 * A T2 that the preview will call ready: a prior-year letter, a prior-year fee,
 * and a confirmed compilation answer.
 */
async function readyEngagement(): Promise<string> {
  const engagement = await prisma.engagement.create({
    data: {
      clientId: await newClient(),
      engagementType: 'T2',
      taxYear: TAX_YEAR,
      yearEnd: new Date(Date.UTC(TAX_YEAR, 2, 31)),
      status: 'NOT_STARTED',
      compilationSelected: false,
      isTestMode: true,
    },
  });

  await prisma.sourceDocument.create({
    data: {
      engagementId: engagement.id,
      kind: 'PRIOR_YEAR_ENGAGEMENT_LETTER',
      fileName: 'Prior Year Engagement Letter.pdf',
      fileHash: randomUUID().replace(/-/g, ''),
      confirmedAt: new Date(),
    },
  });

  await pricing.calculate({
    engagementId: engagement.id,
    feeKinds: ['T2_PREPARATION'],
    previousFees: { T2_PREPARATION: { amount: '2000', source: 'PRIOR_YEAR_DOCUMENT' } },
    highIncreaseThresholdPercent: 10,
    actorId: preparer.id,
  });

  return engagement.id;
}

/** A T2 with nothing to price from, which the preview calls blocked. */
async function blockedEngagement(): Promise<string> {
  const engagement = await prisma.engagement.create({
    data: {
      clientId: await newClient(),
      engagementType: 'T2',
      taxYear: TAX_YEAR,
      yearEnd: new Date(Date.UTC(TAX_YEAR, 5, 30)),
      status: 'NOT_STARTED',
      compilationSelected: null,
      isTestMode: true,
    },
  });
  return engagement.id;
}

function run(engagementIds: string[], options: { dryRun?: boolean; actor?: Principal } = {}) {
  return bulk.run({
    batchId: randomUUID(),
    engagementIds,
    actor: options.actor ?? preparer,
    dryRun: options.dryRun ?? false,
    highIncreaseThresholdPercent: 10,
  });
}

describe('who may run a rollout', () => {
  it('refuses a role that cannot start generation', async () => {
    const engagementId = await readyEngagement();

    await expect(run([engagementId], { actor: readOnly })).rejects.toThrow(/permit|permission/i);

    expect(await prisma.backgroundJob.count({ where: { engagementId } })).toBe(0);
  });
});

describe('what a rollout will queue', () => {
  it('queues a ready engagement as a bulk item, not a direct generation', async () => {
    const engagementId = await readyEngagement();

    const result = await run([engagementId]);

    expect(result).toMatchObject({ queued: 1, deduplicated: 0, dryRun: false });
    expect(result.refused).toHaveLength(0);

    const job = await prisma.backgroundJob.findFirstOrThrow({ where: { engagementId } });
    // The two-stage shape is what makes a repeated rollout safe.
    expect(job.jobType).toBe('BULK_ROLLOUT_ITEM');
    expect((job.payload as { generationKey?: string }).generationKey).toMatch(/^gen_/);
  });

  it('refuses a blocked engagement even when its id is submitted', async () => {
    const engagementId = await blockedEngagement();

    const result = await run([engagementId]);

    expect(result.queued).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]?.engagementId).toBe(engagementId);
    expect(result.refused[0]?.reason).toMatch(/prior-year|CSRS|missing/i);

    // A disabled checkbox is a courtesy; this is the control.
    expect(await prisma.backgroundJob.count({ where: { engagementId } })).toBe(0);
  });

  it('queues the ready ones and names the refused, rather than failing the batch', async () => {
    const ready = await readyEngagement();
    const blocked = await blockedEngagement();

    const result = await run([ready, blocked]);

    expect(result.queued).toBe(1);
    expect(result.refused.map((entry) => entry.engagementId)).toEqual([blocked]);
    expect(result.refused[0]?.clientName).toContain('Bulk Rollout Co');
  });

  it('reports an engagement that has since been deleted rather than throwing', async () => {
    const result = await run([randomUUID()]);

    expect(result.queued).toBe(0);
    expect(result.refused[0]?.reason).toMatch(/no longer exists/i);
  });
});

describe('running the same rollout twice', () => {
  it('does not queue a second draft, even under a different batch', async () => {
    const engagementId = await readyEngagement();

    const first = await run([engagementId]);
    expect(first.queued).toBe(1);

    // A different batch id — a fresh preview, the same engagement.
    const second = await run([engagementId]);
    expect(second.queued).toBe(1);

    // Two bulk items were queued, but they resolve to one generation key, which
    // is what stops a second draft being produced.
    const jobs = await prisma.backgroundJob.findMany({ where: { engagementId } });
    const generationKeys = new Set(jobs.map((job) => (job.payload as { generationKey?: string }).generationKey));
    expect(generationKeys.size).toBe(1);
  });

  it('is a no-op when the same preview is submitted twice', async () => {
    const engagementId = await readyEngagement();
    const batchId = randomUUID();

    const input = {
      batchId,
      engagementIds: [engagementId],
      actor: preparer,
      dryRun: false,
      highIncreaseThresholdPercent: 10,
    };

    expect((await bulk.run(input)).queued).toBe(1);

    const second = await bulk.run(input);
    expect(second.queued).toBe(0);
    expect(second.deduplicated).toBe(1);

    expect(await prisma.backgroundJob.count({ where: { engagementId } })).toBe(1);
  });
});

describe('a dry run', () => {
  it('reports what would happen and queues nothing', async () => {
    const ready = await readyEngagement();
    const blocked = await blockedEngagement();

    const result = await run([ready, blocked], { dryRun: true });

    expect(result).toMatchObject({ queued: 1, deduplicated: 0, dryRun: true });
    expect(result.refused).toHaveLength(1);

    expect(await prisma.backgroundJob.count({ where: { engagementId: ready } })).toBe(0);
  });

  it('records nothing in the audit trail, because nothing happened', async () => {
    const engagementId = await readyEngagement();
    const before = await prisma.auditEvent.count({ where: { objectType: 'BulkRollout' } });

    await run([engagementId], { dryRun: true });

    expect(await prisma.auditEvent.count({ where: { objectType: 'BulkRollout' } })).toBe(before);
  });

  it('reports an engagement already queued as such rather than as new work', async () => {
    const engagementId = await readyEngagement();
    await run([engagementId]);

    const result = await run([engagementId], { dryRun: true });

    expect(result.queued).toBe(0);
    expect(result.deduplicated).toBe(1);
  });
});

describe('the audit trail', () => {
  it('records the outcome of a real run', async () => {
    const ready = await readyEngagement();
    const blocked = await blockedEngagement();
    const batchId = randomUUID();

    await bulk.run({
      batchId,
      engagementIds: [ready, blocked],
      actor: preparer,
      dryRun: false,
      highIncreaseThresholdPercent: 10,
    });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'BulkRollout', objectId: batchId },
    });

    expect(event.userId).toBe(preparer.id);
    expect(event.afterValue).toMatchObject({ queued: 1, refused: 1, selected: 2 });
  });
});
