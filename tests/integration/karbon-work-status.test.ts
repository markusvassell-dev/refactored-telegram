import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { MockKarbonProvider } from '@element/integrations';
import type { KarbonProvider, KarbonWriteResult } from '@element/integrations';
import { KarbonWorkStatusService } from '@element/services';
import { createLogger } from '@element/shared';

/**
 * Telling Karbon where an engagement has got to.
 *
 * Two halves of this existed for months and were never joined: the Karbon
 * client has had `updateWorkItemStatus` with no caller, and `karbon_status_map`
 * has been a seeded, empty setting with a reader and no writer. These are the
 * assertions that keep them joined — and, more importantly, that an
 * unconfigured map still writes nothing to a firm's live work items.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error' });
const service = new KarbonWorkStatusService({ prisma, audit, logger });

/** A connection that is not a mock, so the real push path is exercised. */
function recordingKarbon(outcome: KarbonWriteResult['outcome'] = 'SUCCEEDED') {
  const calls: { workItemKey: string; status: string }[] = [];
  const karbon = {
    isMock: false,
    async updateWorkItemStatus(workItemKey: string, status: string): Promise<KarbonWriteResult> {
      calls.push({ workItemKey, status });
      return { outcome, objectId: workItemKey };
    },
  } as unknown as KarbonProvider;
  return { karbon, calls };
}

const clientIds: string[] = [];
const workItemIds: string[] = [];
let nextTaxYear = 2400;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.karbonWorkItem.deleteMany({ where: { id: { in: workItemIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.$disconnect();
});

async function engagementAt(
  status: 'SIGNED' | 'COMPLETE' | 'DRAFT_READY',
): Promise<{ engagementId: string; workItemKey: string }> {
  const suffix = randomUUID().slice(0, 8);
  const client = await prisma.client.create({
    data: { legalName: `Work Status Co ${suffix}`, isTestFixture: true },
  });
  clientIds.push(client.id);

  const workItem = await prisma.karbonWorkItem.create({
    data: { karbonKey: `WI-${suffix}`, title: `Engagement ${suffix}`, clientId: client.id },
  });
  workItemIds.push(workItem.id);

  nextTaxYear += 1;
  const engagement = await prisma.engagement.create({
    data: {
      clientId: client.id,
      engagementType: 'T2',
      taxYear: nextTaxYear,
      yearEnd: new Date(Date.UTC(nextTaxYear, 2, 31)),
      karbonWorkItemId: workItem.id,
      status,
      isTestMode: false,
    },
  });

  return { engagementId: engagement.id, workItemKey: workItem.karbonKey };
}

describe('pushing the engagement status to the Karbon work item', () => {
  beforeEach(() => {
    nextTaxYear += 1;
  });

  it('writes nothing at all when no status is mapped', async () => {
    // The seeded default. A firm that has not said what their statuses are
    // called must not have anything written to their live work items.
    const { engagementId } = await engagementAt('SIGNED');
    const { karbon, calls } = recordingKarbon();

    const result = await service.sync({ karbon, statusMap: {}, testMode: false });

    expect(calls).toHaveLength(0);
    expect(result.pushed).toBe(0);
    expect(result.skippedReason).toMatch(/no application status is mapped/i);

    const after = await prisma.engagement.findUniqueOrThrow({ where: { id: engagementId } });
    expect(after.karbonWorkStatusPushed).toBeNull();
  });

  it('pushes a mapped status once, and not again on the next pass', async () => {
    const { engagementId, workItemKey } = await engagementAt('SIGNED');
    const { karbon, calls } = recordingKarbon();
    const statusMap = { SIGNED: 'Signed by client' };

    // Scoped to this engagement's own work item. The pass deliberately sweeps
    // every engagement whose status is mapped, so counting all calls would be
    // counting whatever the other cases in this file left behind.
    const mine = () => calls.filter((call) => call.workItemKey === workItemKey);

    await service.sync({ karbon, statusMap, testMode: false });
    expect(mine()).toHaveLength(1);
    expect(mine()[0]?.status).toBe('Signed by client');

    const stored = await prisma.engagement.findUniqueOrThrow({ where: { id: engagementId } });
    expect(stored.karbonWorkStatusPushed).toBe('Signed by client');

    // Reconciliation, not a queue: running again must be a no-op rather than a
    // second identical write to the firm's work item.
    await service.sync({ karbon, statusMap, testMode: false });
    expect(mine()).toHaveLength(1);
  });

  it('leaves an engagement alone when its own status is not in the map', async () => {
    const { workItemKey } = await engagementAt('DRAFT_READY');
    const { karbon, calls } = recordingKarbon();

    await service.sync({ karbon, statusMap: { SIGNED: 'Signed by client' }, testMode: false });

    expect(calls.filter((call) => call.workItemKey === workItemKey)).toHaveLength(0);
  });

  it('records nothing as pushed when Karbon refuses, so the next pass retries', async () => {
    // Writing the marker before Karbon accepted would make a failed push look
    // permanently done, and it would never be tried again.
    const { engagementId } = await engagementAt('COMPLETE');
    const { karbon } = recordingKarbon('SKIPPED_UNSUPPORTED');

    await service.sync({ karbon, statusMap: { COMPLETE: 'Completed' }, testMode: false });

    const after = await prisma.engagement.findUniqueOrThrow({ where: { id: engagementId } });
    expect(after.karbonWorkStatusPushed).toBeNull();
  });

  it('writes nothing in Test Mode, or through a mock adapter', async () => {
    const { engagementId } = await engagementAt('SIGNED');
    const statusMap = { SIGNED: 'Signed by client' };

    const live = recordingKarbon();
    const inTestMode = await service.sync({ karbon: live.karbon, statusMap, testMode: true });
    expect(live.calls).toHaveLength(0);
    expect(inTestMode.skippedReason).toMatch(/test mode/i);

    const mock = new MockKarbonProvider();
    const throughMock = await service.sync({ karbon: mock, statusMap, testMode: false });
    expect(throughMock.skippedReason).toMatch(/mock adapter/i);
    expect(mock.calls.filter((call) => call.operation === 'updateWorkItemStatus')).toHaveLength(0);

    const after = await prisma.engagement.findUniqueOrThrow({ where: { id: engagementId } });
    expect(after.karbonWorkStatusPushed).toBeNull();
  });
});
