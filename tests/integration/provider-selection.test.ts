import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { IntegrationConnectionService, resolveProviders } from '@element/services';
import { createLogger, loadEnv, type Principal } from '@element/shared';

/**
 * Which adapter a request actually gets.
 *
 * This is where Test Mode stops being a promise and becomes a fact, so the
 * question is not what the Integrations screen says but what the application
 * hands to a caller.
 *
 * The failure it now defends against was real. Test Mode used to refuse a
 * production label outright, and the blocked adapter refused reads as well as
 * writes — so a firm that wanted the application to do anything with Karbon had
 * exactly one lever, and it was to mark the production connection "Sandbox".
 * That is what was deployed: real client records reachable, every screen saying
 * TEST MODE.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error' });
const env = loadEnv();

const connections = new IntegrationConnectionService({
  prisma,
  audit,
  logger,
  encryptionKey: env.ENCRYPTION_KEY,
});

const suffix = randomUUID().slice(0, 8);
let admin: Principal;

async function saveKarbon(input: { baseUrl: string; isSandbox: boolean }) {
  await connections.save({
    provider: 'KARBON',
    baseUrl: input.baseUrl,
    isSandbox: input.isSandbox,
    isEnabled: true,
    credentials: { bearerToken: 'token-value', accessKey: 'key-value' },
    testModeActive: false,
    actor: admin,
  });
}

function providersWith(testMode: boolean) {
  return resolveProviders({
    prisma,
    env,
    testModeState: { testMode, productionSendingEnabled: false, banner: testMode ? 'TEST MODE' : null },
    logger,
  });
}

beforeAll(async () => {
  await prisma.$connect();
  const user = await prisma.user.upsert({
    where: { email: `providers-${suffix}@test.example` },
    create: { email: `providers-${suffix}@test.example`, displayName: 'Providers Admin' },
    update: {},
  });
  admin = { id: user.id, email: user.email, displayName: user.displayName, roles: ['ADMINISTRATOR'] };
});

afterEach(async () => {
  await prisma.integrationConnection.deleteMany({ where: { provider: 'KARBON' } });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: `providers-${suffix}@test.example` } });
  await prisma.$disconnect();
});

describe('a production Karbon connection under Test Mode', () => {
  it('serves reads and refuses writes, rather than refusing everything', async () => {
    await saveKarbon({ baseUrl: 'https://api.karbonhq.com/v3', isSandbox: false });

    const { karbon, description } = await providersWith(true);

    expect(karbon.name).toBe('karbon-read-only');
    expect(description.karbon).toMatch(/reads only/i);

    const write = await karbon.addComment({ workItemKey: 'wi-1', body: 'x', idempotencyKey: 'k' });
    expect(write.outcome).toBe('SKIPPED_TEST_MODE');
  });

  it('is treated as production even when the box says sandbox', async () => {
    // The label is not trusted on its own. api.karbonhq.com is production
    // whatever the box says, and the box was ticked wrong in a real deployment
    // — so correcting it is now cosmetic rather than load-bearing.
    await saveKarbon({ baseUrl: 'https://api.karbonhq.com/v3', isSandbox: true });

    const { karbon } = await providersWith(true);

    expect(karbon.name).toBe('karbon-read-only');
    const write = await karbon.uploadDocument({
      target: { workItemKey: 'wi-1' },
      fileName: 'x.pdf',
      content: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
      idempotencyKey: 'k',
      neverOverwrite: true,
    });
    expect(write.outcome).toBe('SKIPPED_TEST_MODE');
  });

  it('does not claim to be a mock, because the data it returns is real', async () => {
    // The client import refuses to invent clients from a mock. If this adapter
    // claimed to be one, the import would refuse the exact case it exists for.
    await saveKarbon({ baseUrl: 'https://api.karbonhq.com/v3', isSandbox: true });

    const { karbon } = await providersWith(true);
    expect(karbon.isMock).toBe(false);
  });

  it('writes for real once Test Mode is off', async () => {
    await saveKarbon({ baseUrl: 'https://api.karbonhq.com/v3', isSandbox: false });

    const { karbon, description } = await providersWith(false);

    expect(karbon.name).toBe('karbon');
    expect(description.karbon).toMatch(/production/i);
  });
});

describe('when there is no usable connection', () => {
  it('blocks under Test Mode rather than pretending with a mock', async () => {
    // Nothing configured is not a sandbox, so Test Mode refuses rather than
    // answering from a mock — an answer that looked real would be worse than
    // no answer. The screens that offer Karbon actions check `isMock` and
    // report the connection as absent, which the blocked adapter also reports.
    const { karbon, description } = await providersWith(true);

    expect(karbon.isMock).toBe(true);
    expect(description.karbon).toMatch(/blocked/i);
  });

  it('hands out a labelled mock when Test Mode is off and nothing is configured', async () => {
    const { karbon, description } = await providersWith(false);

    expect(karbon.isMock).toBe(true);
    expect(description.karbon).toMatch(/mock/i);
  });

  it('blocks rather than reading, when a production connection is not usable', async () => {
    // Enabled is false, so there is nothing to read with — and Test Mode must
    // not fall back to a mock that would answer as though it had.
    await connections.save({
      provider: 'KARBON',
      baseUrl: 'https://api.karbonhq.com/v3',
      isSandbox: false,
      isEnabled: false,
      credentials: { bearerToken: 'token-value', accessKey: 'key-value' },
      testModeActive: false,
      actor: admin,
    });

    const { karbon, description } = await providersWith(true);

    expect(karbon.name).toBe('karbon-blocked');
    expect(description.karbon).toMatch(/blocked/i);
  });
});
