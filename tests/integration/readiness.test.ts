import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { checkReadiness } from '@element/services';

/**
 * Whether a deployment is actually set up.
 *
 * The dashboard is a work queue, and on a freshly deployed instance every one of
 * its counts is legitimately zero — so it reports that there is nothing to do.
 * That is true and useless: there is nothing to do because nothing has been set
 * up, and the two states look identical on screen.
 *
 * These tests pin the distinction, and pin that it disappears once the
 * deployment is ready. A checklist that is always visible stops being read.
 */

const prisma = new PrismaClient();

const CONFIGURED = {
  providerDescription: { karbon: 'Karbon production connection', adobeSign: 'Adobe Sign production connection' },
  testMode: { testMode: false, productionSendingEnabled: true },
  documentStorageDirectory: '/tmp/element-engagements-tests/storage',
};

const clientIds: string[] = [];
let firmSignerUserId: string;

beforeAll(async () => {
  await prisma.$connect();
  const user = await prisma.user.upsert({
    where: { email: 'readiness-test@example.test' },
    create: { email: 'readiness-test@example.test', displayName: 'Readiness Test' },
    update: {},
  });
  firmSignerUserId = user.id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.systemSetting.deleteMany({ where: { key: 'firm_signer_user_id' } });
  await prisma.$disconnect();
});

/** Puts the database into the state a configured deployment would be in. */
async function configure(): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: 'firm_signer_user_id' },
    create: { key: 'firm_signer_user_id', value: firmSignerUserId, description: 'test' },
    update: { value: firmSignerUserId },
  });

  const client = await prisma.client.create({
    data: { legalName: `Readiness Real Client ${randomUUID().slice(0, 8)}`, isTestFixture: false },
  });
  clientIds.push(client.id);
}

async function unconfigure(): Promise<void> {
  await prisma.systemSetting.deleteMany({ where: { key: 'firm_signer_user_id' } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  clientIds.length = 0;
}

describe('what a deployment still needs', () => {
  it('names a mock Karbon as blocking, because nothing is filed anywhere', async () => {
    await configure();

    const items = await checkReadiness({
      ...CONFIGURED,
      prisma,
      providerDescription: { ...CONFIGURED.providerDescription, karbon: 'mock adapter (no Karbon connection configured)' },
    });

    const karbon = items.find((item) => item.key === 'karbon');
    expect(karbon?.severity).toBe('BLOCKER');
    // The point is not that a mock is configured — it is what that costs.
    expect(karbon?.detail).toMatch(/exist only inside this application/i);
    expect(karbon?.href).toBe('/integrations');
  });

  it('names a missing firm signer as blocking', async () => {
    await unconfigure();

    const items = await checkReadiness({ ...CONFIGURED, prisma });

    expect(items.find((item) => item.key === 'firm-signer')?.severity).toBe('BLOCKER');
  });

  it('does not count the seeded sample clients as real ones', async () => {
    await unconfigure();

    // The seed creates fixtures for demonstration. Treating those as the firm's
    // clients would report a deployment as ready when nobody real is in it.
    const fixtures = await prisma.client.count({ where: { isTestFixture: true } });
    expect(fixtures).toBeGreaterThan(0);

    const items = await checkReadiness({ ...CONFIGURED, prisma });
    expect(items.find((item) => item.key === 'clients')?.severity).toBe('BLOCKER');
  });

  it('treats a missing Adobe connection as worth knowing, not blocking', async () => {
    await configure();

    const items = await checkReadiness({
      ...CONFIGURED,
      prisma,
      providerDescription: { ...CONFIGURED.providerDescription, adobeSign: 'mock adapter (no Adobe Sign connection configured)' },
    });

    // Letters can still be signed by recording a signature obtained elsewhere,
    // so this is a smaller thing than an unconnected Karbon.
    expect(items.find((item) => item.key === 'adobe-sign')?.severity).toBe('ATTENTION');
  });

  it('says plainly when Test Mode means nothing reaches a client', async () => {
    await configure();

    const items = await checkReadiness({
      ...CONFIGURED,
      prisma,
      testMode: { testMode: true, productionSendingEnabled: false },
    });

    expect(items.find((item) => item.key === 'test-mode')?.severity).toBe('ATTENTION');
    // Production sending is not separately reported while Test Mode is on;
    // one cause, one row.
    expect(items.find((item) => item.key === 'production-sending')).toBeUndefined();
  });

  it('reports nothing blocking once the deployment is configured', async () => {
    await configure();

    const items = await checkReadiness({ ...CONFIGURED, prisma });
    const blockers = items.filter((item) => item.severity === 'BLOCKER');

    expect(
      blockers,
      `Unexpected blockers: ${JSON.stringify(blockers.map((item) => item.title))}`,
    ).toEqual([]);

    // The cover-letter types that have no approved template are still reported,
    // softly — that is work outstanding, not a broken deployment.
    expect(items.find((item) => item.key === 'awaiting-templates')?.severity).toBe('ATTENTION');
  });
});
