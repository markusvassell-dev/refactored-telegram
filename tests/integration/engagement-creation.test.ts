import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { DocumentStore, EngagementService } from '@element/services';
import { createLogger } from '@element/shared';

/**
 * Starting an engagement by hand.
 *
 * These tests are about the states this must refuse to create. An engagement
 * with no approved template can never produce a document; a corporate one
 * without its year-end can never have a filing deadline; a duplicate splits one
 * client's work across two records. Each of those is easy to create by accident
 * and awkward to unpick afterwards.
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
let actorId: string;
let reviewerId: string;
/**
 * Real years, not far-future ones: the service refuses an implausible tax year,
 * which is the point. Each fixture makes its own client, and the uniqueness
 * constraint is per client, so one year serves for almost every case.
 */
const TAX_YEAR = 2026;

beforeAll(async () => {
  await prisma.$connect();

  const actor = await prisma.user.upsert({
    where: { email: 'creation-test@example.test' },
    create: { email: 'creation-test@example.test', displayName: 'Creation Test' },
    update: {},
  });
  actorId = actor.id;

  const reviewer = await prisma.user.upsert({
    where: { email: 'creation-reviewer@example.test' },
    create: { email: 'creation-reviewer@example.test', displayName: 'Creation Reviewer' },
    update: {},
  });
  reviewerId = reviewer.id;
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.$disconnect();
});

async function newClient(): Promise<string> {
  const client = await prisma.client.create({
    data: { legalName: `Creation Test Co ${randomUUID().slice(0, 8)}`, isTestFixture: true },
  });
  clientIds.push(client.id);
  return client.id;
}

function create(overrides: Partial<Parameters<EngagementService['create']>[0]> = {}) {
  return engagements.create({
    engagementType: 'T2',
    taxYear: TAX_YEAR,
    yearEnd: `${TAX_YEAR}-03-31`,
    actorId,
    isTestMode: true,
    ...overrides,
  });
}

describe('creating an engagement', () => {
  it('creates it assigned to the actor, in NOT_STARTED, against the active template', async () => {
    const clientId = await newClient();

    const result = await create({ clientId });

    const engagement = await prisma.engagement.findUniqueOrThrow({
      where: { id: result.engagementId },
      include: { templateVersion: true },
    });

    expect(engagement.status).toBe('NOT_STARTED');
    expect(engagement.assignedPreparerId).toBe(actorId);
    expect(engagement.initiationSource).toBe('MANUAL');
    expect(engagement.initiatedBy).toBe(actorId);
    expect(engagement.isTestMode).toBe(true);
    expect(engagement.templateVersion?.status).toBe('ACTIVE');
    // Nothing is decided for the reviewer: compilation stays unconfirmed.
    expect(engagement.compilationSelected).toBeNull();
  });

  it('records the year-end a corporate deadline is calculated from', async () => {
    const clientId = await newClient();
    const result = await create({ clientId, yearEnd: '2026-06-30' });

    const engagement = await prisma.engagement.findUniqueOrThrow({ where: { id: result.engagementId } });
    expect(engagement.yearEnd?.toISOString().slice(0, 10)).toBe('2026-06-30');
  });

  it('assigns a reviewer when one is chosen', async () => {
    const clientId = await newClient();
    const result = await create({ clientId, assignedReviewerId: reviewerId });

    const engagement = await prisma.engagement.findUniqueOrThrow({ where: { id: result.engagementId } });
    expect(engagement.assignedReviewerId).toBe(reviewerId);
  });

  it('records the creation in the audit trail', async () => {
    const clientId = await newClient();
    const result = await create({ clientId });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { engagementId: result.engagementId, eventType: 'ENGAGEMENT_CREATED' },
    });

    expect(event.userId).toBe(actorId);
    expect(event.afterValue).toMatchObject({ engagementType: 'T2', isTestMode: true });
  });
});

describe('what it refuses to create', () => {
  it('refuses a type with no approved template, naming the reason', async () => {
    const clientId = await newClient();

    // T1 single is deliberately unavailable: no approved single-taxpayer
    // template exists, and none will be invented.
    await expect(create({ clientId, engagementType: 'T1_SINGLE', yearEnd: null })).rejects.toThrow(
      /No approved template is active/i,
    );
  });

  it('refuses a corporate engagement with no year-end', async () => {
    const clientId = await newClient();

    await expect(create({ clientId, yearEnd: null })).rejects.toThrow(/needs its year-end/i);
    await expect(create({ clientId, yearEnd: '   ' })).rejects.toThrow(/needs its year-end/i);
  });

  it('refuses a year-end that is not a real date', async () => {
    const clientId = await newClient();

    await expect(create({ clientId, yearEnd: '2026-02-31' })).rejects.toThrow(/not a real date/i);
    await expect(create({ clientId, yearEnd: 'March 31, 2026' })).rejects.toThrow(/YYYY-MM-DD/i);
  });

  it('refuses an implausible tax year rather than storing it', async () => {
    const clientId = await newClient();

    await expect(create({ clientId, taxYear: 1899 })).rejects.toThrow(/tax year must be between/i);
    await expect(create({ clientId, taxYear: 9999 })).rejects.toThrow(/tax year must be between/i);
  });

  it('refuses a second engagement for the same client, type and year', async () => {
    const clientId = await newClient();

    await create({ clientId });

    await expect(create({ clientId })).rejects.toThrow(/already has a 2026 T2 engagement/i);
  });

  it('refuses both a chosen client and a new name, which is ambiguous', async () => {
    const clientId = await newClient();

    await expect(create({ clientId, newClientName: 'Something Else Ltd.' })).rejects.toThrow(/not both/i);
  });

  it('refuses neither', async () => {
    await expect(create({})).rejects.toThrow(/Choose an existing client or name a new one/i);
  });
});

describe('the client', () => {
  it('creates one when a new name is given', async () => {
    const name = `Brand New Co ${randomUUID().slice(0, 8)}`;

    const result = await create({ newClientName: `  ${name}  ` });
    clientIds.push(result.clientId);

    expect(result.clientCreated).toBe(true);

    const client = await prisma.client.findUniqueOrThrow({ where: { id: result.clientId } });
    expect(client.legalName).toBe(name);
  });

  it('refuses a name that already exists, whatever its casing', async () => {
    const clientId = await newClient();
    const existing = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });

    await expect(create({ newClientName: existing.legalName.toUpperCase() })).rejects.toThrow(
      /already exists.*Select it/is,
    );
  });
});

describe('what it links automatically', () => {
  it('links the prior year when this client already has one', async () => {
    const clientId = await newClient();

    const priorYear = await create({ clientId, taxYear: TAX_YEAR - 1, yearEnd: `${TAX_YEAR - 1}-03-31` });
    const thisYear = await create({ clientId });

    const engagement = await prisma.engagement.findUniqueOrThrow({ where: { id: thisYear.engagementId } });
    expect(engagement.priorYearEngagementId).toBe(priorYear.engagementId);
    expect(thisYear.notes.join(' ')).toContain(`${TAX_YEAR - 1} engagement`);
  });

  it('links a Karbon work item this application already knows', async () => {
    const clientId = await newClient();
    const karbonKey = `WI-${randomUUID().slice(0, 8)}`;

    const workItem = await prisma.karbonWorkItem.create({
      data: { karbonKey, clientId, title: 'Corporate Tax', taxYear: TAX_YEAR },
    });

    const result = await create({ clientId, karbonWorkItemKey: karbonKey });
    expect(result.karbonWorkItemLinked).toBe(true);

    const engagement = await prisma.engagement.findUniqueOrThrow({ where: { id: result.engagementId } });
    expect(engagement.karbonWorkItemId).toBe(workItem.id);

    await prisma.karbonWorkItem.delete({ where: { id: workItem.id } });
  });

  it('leaves an unknown Karbon key unlinked rather than inventing a work item', async () => {
    const clientId = await newClient();

    const result = await create({ clientId, karbonWorkItemKey: 'WI-DOES-NOT-EXIST' });

    expect(result.karbonWorkItemLinked).toBe(false);
    expect(result.notes.join(' ')).toContain('not known here yet');
    expect(await prisma.karbonWorkItem.count({ where: { karbonKey: 'WI-DOES-NOT-EXIST' } })).toBe(0);
  });
});

describe('a T1 engagement', () => {
  it('is calendar-year, so a supplied year-end is not recorded', async () => {
    const clientId = await newClient();

    const result = await create({ clientId, engagementType: 'T1_JOINT', yearEnd: '2026-12-31' });

    const engagement = await prisma.engagement.findUniqueOrThrow({ where: { id: result.engagementId } });
    expect(engagement.yearEnd).toBeNull();
    expect(result.notes.join(' ')).toContain('calendar-year');
  });

  it('does not require a year-end at all', async () => {
    const clientId = await newClient();

    const result = await create({ clientId, engagementType: 'T1_JOINT', yearEnd: null });
    expect(result.engagementId).toBeTruthy();
  });
});
