import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { DocumentStore, EngagementService } from '@element/services';
import { createLogger } from '@element/shared';

/**
 * Working out what would be created, without creating it.
 *
 * The point of `propose` is that the preview and the Karbon trigger run the
 * same derivation. So these assertions are of two kinds: that each value is
 * derived correctly, and — the one that matters most over time — that
 * `rollForward` agrees with `propose` given the same inputs. That second test
 * fails the moment somebody changes one and not the other, which is the failure
 * this design exists to prevent.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error' });
const store = new DocumentStore({
  prisma,
  rootDirectory: '/tmp/element-engagements-tests/storage',
  retentionHours: 72,
  maxBytes: 25 * 1024 * 1024,
  signingSecret: 'test-signing-secret-test-signing-secret',
});
const engagements = new EngagementService({ prisma, audit, store, logger });

const clientIds: string[] = [];
const workItemIds: string[] = [];
let preparerId: string;
let reviewerId: string;

beforeAll(async () => {
  await prisma.$connect();
  const preparer = await prisma.user.upsert({
    where: { email: 'proposal-preparer@example.test' },
    create: { email: 'proposal-preparer@example.test', displayName: 'Proposal Preparer' },
    update: {},
  });
  preparerId = preparer.id;
  const reviewer = await prisma.user.upsert({
    where: { email: 'proposal-reviewer@example.test' },
    create: { email: 'proposal-reviewer@example.test', displayName: 'Proposal Reviewer' },
    update: {},
  });
  reviewerId = reviewer.id;
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.karbonWorkItem.deleteMany({ where: { id: { in: workItemIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.$disconnect();
});

async function newClient(): Promise<string> {
  const client = await prisma.client.create({
    data: { legalName: `Proposal Co ${randomUUID().slice(0, 8)}`, isTestFixture: true },
  });
  clientIds.push(client.id);
  return client.id;
}

async function priorEngagement(clientId: string, taxYear: number, yearEnd: string) {
  return prisma.engagement.create({
    data: {
      clientId,
      engagementType: 'T2',
      taxYear,
      yearEnd: new Date(`${yearEnd}T00:00:00Z`),
      status: 'COMPLETE',
      assignedPreparerId: preparerId,
      assignedReviewerId: reviewerId,
      isTestMode: true,
    },
  });
}

describe('proposing an engagement', () => {
  it('rolls the year and the year-end forward from the last engagement', async () => {
    const clientId = await newClient();
    await priorEngagement(clientId, 2024, '2024-03-31');

    const proposal = await engagements.propose({ clientId, engagementType: 'T2' });

    expect(proposal.taxYear).toBe(2025);
    expect(proposal.taxYearBasis).toBe('PRIOR_YEAR_PLUS_ONE');
    expect(proposal.yearEnd).toBe('2025-03-31');
    expect(proposal.yearEndBasis).toBe('ROLLED_FROM_PRIOR_YEAR');
    expect(proposal.assignedReviewerId).toBe(reviewerId);
    expect(proposal.alreadyExistsId).toBeNull();
  });

  it('clamps 29 February rather than landing on 1 March', async () => {
    // The kind of wrong that reads as right. A year-end a day out moves the
    // filing deadline with it.
    const clientId = await newClient();
    await priorEngagement(clientId, 2028, '2028-02-29');

    const proposal = await engagements.propose({ clientId, engagementType: 'T2' });

    expect(proposal.yearEnd).toBe('2029-02-28');
  });

  it('asks for the year-end rather than guessing one when there is no history', async () => {
    // Karbon publishes no year-end field and a due date is a deadline, not a
    // period end. A guess here would produce a plausible, wrong, legal filing
    // deadline that nothing downstream would flag.
    const clientId = await newClient();

    const proposal = await engagements.propose({ clientId, engagementType: 'T2' });

    expect(proposal.yearEnd).toBeNull();
    expect(proposal.yearEndBasis).toBe('REQUIRED_FROM_YOU');
    expect(proposal.notes.join(' ')).toMatch(/Karbon publishes no year-end field/i);
    // A note, not a blocker: a person can simply type it.
    expect(proposal.blockers).toHaveLength(0);
  });

  it('needs no year-end for a T1, which is always calendar-year', async () => {
    const clientId = await newClient();

    const proposal = await engagements.propose({ clientId, engagementType: 'T1_JOINT' });

    expect(proposal.yearEndBasis).toBe('NOT_APPLICABLE');
    expect(proposal.blockers).toHaveLength(0);
  });

  it('reports the existing engagement instead of proposing a duplicate', async () => {
    // Only reachable when the *derived* year is one that already exists, which
    // needs a work item naming it — deriving from the prior year always lands
    // on the next one, which by definition does not exist yet.
    const clientId = await newClient();
    const existing = await priorEngagement(clientId, 2025, '2025-03-31');

    const suffix = randomUUID().slice(0, 8);
    const workItem = await prisma.karbonWorkItem.create({
      data: { karbonKey: `WI-dup-${suffix}`, title: 'T2 Engagement 2025', clientId },
    });
    workItemIds.push(workItem.id);

    const proposal = await engagements.propose({
      karbonWorkItemKey: workItem.karbonKey,
      engagementType: 'T2',
    });

    expect(proposal.taxYear).toBe(2025);
    expect(proposal.alreadyExistsId).toBe(existing.id);
    expect(proposal.notes.join(' ')).toMatch(/already exists/i);
  });

  it('writes nothing at all', async () => {
    // The whole reason this is separate from rollForward.
    const clientId = await newClient();
    const before = await prisma.engagement.count({ where: { clientId } });

    await engagements.propose({ clientId, engagementType: 'T2' });
    await engagements.propose({ clientId, engagementType: 'T2' });

    expect(await prisma.engagement.count({ where: { clientId } })).toBe(before);
  });

  it('agrees with rollForward on the same inputs', async () => {
    // The test that keeps the preview honest. If the two derivations ever
    // diverge, the page shows one answer and the trigger creates another.
    const clientId = await newClient();
    await priorEngagement(clientId, 2024, '2024-06-30');

    const suffix = randomUUID().slice(0, 8);
    const workItem = await prisma.karbonWorkItem.create({
      data: { karbonKey: `WI-${suffix}`, title: `T2 Engagement 2025`, clientId },
    });
    workItemIds.push(workItem.id);

    const proposal = await engagements.propose({
      karbonWorkItemKey: workItem.karbonKey,
      engagementType: 'T2',
    });

    const rolled = await engagements.rollForward({
      karbonWorkItemKey: workItem.karbonKey,
      engagementType: 'T2',
      actorId: preparerId,
      isTestMode: true,
      initiationSource: 'test',
    });

    expect(rolled.created).toBe(true);
    expect(rolled.taxYear).toBe(proposal.taxYear);
    expect(rolled.priorYearEngagementId).toBe(proposal.priorYearEngagementId);

    const created = await prisma.engagement.findUniqueOrThrow({ where: { id: rolled.engagementId } });
    expect(created.yearEnd?.toISOString().slice(0, 10)).toBe(proposal.yearEnd);
    expect(created.assignedReviewerId).toBe(proposal.assignedReviewerId);
  });
});
