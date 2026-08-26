import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { DocumentStore, EngagementService } from '@element/services';
import { createLogger } from '@element/shared';
import { PreconditionError } from '@element/shared';

/**
 * Starting next year's engagement from last year's, with nobody present.
 *
 * The whole rollover pipeline already existed — find last year's letter in
 * Karbon, extract it, carry the values forward — and every part of it begins
 * from an engagement. Nothing created one. A Karbon status trigger naming next
 * year's work item reported that no engagement was linked, and stopped, which
 * is every rollover there has ever been.
 *
 * These assertions are about the two things that make an unattended creation
 * safe: it must converge when it runs twice, and it must not quietly produce an
 * engagement for the wrong period or under the wrong person.
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
const service = new EngagementService({ prisma, audit, store, logger });

const suffix = randomUUID().slice(0, 8);
const entityKey = `ro-client-${suffix}`;
const workItemKey = `ro-wi-${suffix}`;

let clientId: string;
let preparerId: string;
let reviewerId: string;

async function makeUser(email: string): Promise<string> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, displayName: email.split('@')[0] as string },
    update: {},
  });
  return user.id;
}

/** Last year's engagement, as the firm would have left it. */
async function seedPriorYear(taxYear: number, yearEnd: string) {
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
    select: { id: true },
  });
}

async function setWorkItemTitle(title: string) {
  await prisma.karbonWorkItem.update({ where: { karbonKey: workItemKey }, data: { title } });
}

beforeAll(async () => {
  await prisma.$connect();
  preparerId = await makeUser(`ro-preparer-${suffix}@test.example`);
  reviewerId = await makeUser(`ro-reviewer-${suffix}@test.example`);
});

beforeEach(async () => {
  await prisma.engagement.deleteMany({ where: { client: { karbonEntityKey: entityKey } } });
  await prisma.karbonWorkItem.deleteMany({ where: { karbonKey: workItemKey } });
  await prisma.client.deleteMany({ where: { karbonEntityKey: entityKey } });

  const client = await prisma.client.create({
    data: { karbonEntityKey: entityKey, legalName: `Rollover Test Ltd. ${suffix}` },
    select: { id: true },
  });
  clientId = client.id;

  await prisma.karbonWorkItem.create({
    data: { karbonKey: workItemKey, clientId, title: 'Corporate year end', workType: 'T2' },
  });
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { client: { karbonEntityKey: entityKey } } });
  await prisma.karbonWorkItem.deleteMany({ where: { karbonKey: workItemKey } });
  await prisma.client.deleteMany({ where: { karbonEntityKey: entityKey } });
  await prisma.user.deleteMany({ where: { email: { contains: `-${suffix}@test.example` } } });
  await prisma.$disconnect();
});

const input = {
  karbonWorkItemKey: workItemKey,
  engagementType: 'T2' as const,
  actorId: 'system',
  isTestMode: true,
  initiationSource: 'KARBON_ROLLOVER',
};

describe('rolling an engagement forward', () => {
  it('creates next year from last year, carrying the period and the people', async () => {
    const previous = await seedPriorYear(2025, '2025-06-30');

    const result = await service.rollForward(input);

    expect(result.created).toBe(true);
    expect(result.taxYear).toBe(2026);
    expect(result.priorYearEngagementId).toBe(previous.id);

    const created = await prisma.engagement.findUniqueOrThrow({ where: { id: result.engagementId } });
    expect(created.yearEnd?.toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(created.assignedPreparerId).toBe(preparerId);
    expect(created.assignedReviewerId).toBe(reviewerId);
    expect(created.initiationSource).toBe('KARBON_ROLLOVER');
    expect(created.isTestMode).toBe(true);
    // Linked to the work item that triggered it, which is what lets the Karbon
    // search look in the right place for last year's letter.
    expect(created.karbonWorkItemId).not.toBeNull();
  });

  it('never assigns the system as preparer', async () => {
    // `actorId` is the string `system`, which is a real answer for the audit
    // trail and is not a user row. `assigned_preparer_id` is a foreign key, so
    // writing it there is a constraint violation that surfaces minutes later in
    // a dead-lettered job rather than here.
    await prisma.engagement.create({
      data: { clientId, engagementType: 'T2', taxYear: 2025, yearEnd: new Date('2025-06-30T00:00:00Z'), isTestMode: true },
    });

    const result = await service.rollForward(input);

    // By id: the seeded prior year is also a T2 for this client, and matching on
    // the pair would assert against the wrong row.
    const created = await prisma.engagement.findUniqueOrThrow({ where: { id: result.engagementId } });
    expect(created.assignedPreparerId).toBeNull();
    expect(created.initiatedBy).toBe('system');
  });

  it('converges rather than duplicating, however many times it runs', async () => {
    // It runs from a queue that guarantees at-least-once delivery, and from a
    // poll that sees the same work item until its status changes. Returning the
    // existing engagement is the correct outcome, not a tolerated failure.
    await seedPriorYear(2025, '2025-06-30');

    const first = await service.rollForward(input);
    const second = await service.rollForward(input);
    const third = await service.rollForward(input);

    expect(second.engagementId).toBe(first.engagementId);
    expect(third.engagementId).toBe(first.engagementId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    expect(await prisma.engagement.count({ where: { clientId, engagementType: 'T2' } })).toBe(2);
  });

  it('takes the year Karbon states when the title names exactly one', async () => {
    await seedPriorYear(2024, '2024-09-30');
    await setWorkItemTitle('T2 year end 2026');

    const result = await service.rollForward(input);

    // Karbon says 2026, and the deterministic fallback would have said 2025.
    // Karbon wins, and the year-end still rolls from the engagement that exists.
    expect(result.taxYear).toBe(2026);
  });

  it('falls back to the prior year when the title is ambiguous', async () => {
    await seedPriorYear(2025, '2025-06-30');
    await setWorkItemTitle('2025/2026 year end');

    expect((await service.rollForward(input)).taxYear).toBe(2026);
  });

  it('starts a T1 for a client with no history, and says nothing was carried forward', async () => {
    // A T1 is always calendar-year, so there is no year-end to inherit and
    // nothing stopping it. This is the "create it anyway, flagged" case.
    const result = await service.rollForward({ ...input, engagementType: 'T1_JOINT' });

    expect(result.created).toBe(true);
    expect(result.priorYearEngagementId).toBeNull();
    expect(result.notes.join(' ')).toContain('No earlier');

    const created = await prisma.engagement.findUniqueOrThrow({ where: { id: result.engagementId } });
    expect(created.yearEnd).toBeNull();
    expect(created.initiationSource).toBe('KARBON_ROLLOVER');
  });

  it('refuses a first-ever T2, because there is no year-end anywhere to take', async () => {
    // The one case the rollover cannot do, and it is a data limit rather than a
    // policy: Karbon publishes no year-end field, the year-end is only settable
    // when an engagement is created, and the filing and balance-due dates are
    // computed from it. Creating one without would strand the engagement;
    // guessing one would put a plausible wrong legal deadline on a letter.
    await expect(service.rollForward(input)).rejects.toThrow(/no year-end to carry forward/i);
    await expect(service.rollForward(input)).rejects.toThrow(/by hand/i);

    expect(await prisma.engagement.count({ where: { clientId } })).toBe(0);
  });

  it('refuses a work item that is not linked to a client, naming the fix', async () => {
    await prisma.karbonWorkItem.update({ where: { karbonKey: workItemKey }, data: { clientId: null } });

    await expect(service.rollForward(input)).rejects.toThrow(PreconditionError);
    await expect(service.rollForward(input)).rejects.toThrow(/import the client/i);
  });

  it('refuses a work item this application has never seen', async () => {
    await expect(
      service.rollForward({ ...input, karbonWorkItemKey: `absent-${suffix}` }),
    ).rejects.toThrow(/not known here/i);
  });

  it('records that it started itself, not that somebody typed it', async () => {
    await seedPriorYear(2025, '2025-06-30');
    const result = await service.rollForward(input);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { engagementId: result.engagementId, eventType: 'ENGAGEMENT_CREATED' },
    });

    expect(event.reason).toContain('automatically');
    expect(event.userId).toBe('system');
  });
});
