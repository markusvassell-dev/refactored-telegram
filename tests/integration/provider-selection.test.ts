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

async function saveAdobe(input: { isSandbox: boolean; isEnabled: boolean; withRefreshToken?: boolean }) {
  await connections.save({
    provider: 'ADOBE_SIGN',
    baseUrl: 'https://api.na3.adobesign.com',
    isSandbox: input.isSandbox,
    isEnabled: input.isEnabled,
    credentials: {
      clientId: 'client-id-value',
      clientSecret: 'client-secret-value',
      ...(input.withRefreshToken === false ? {} : { refreshToken: 'refresh-token-value' }),
    },
    testModeActive: false,
    actor: admin,
  });
}

afterEach(async () => {
  await prisma.integrationConnection.deleteMany({ where: { provider: { in: ['KARBON', 'ADOBE_SIGN'] } } });
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


/**
 * Which Adobe adapter resolved, and — the part that matters — what the send
 * gate is told about it.
 *
 * The gate used to read this off a description string:
 *
 * ```ts
 * sandboxConfigured: !providers.description.adobeSign.startsWith('blocked')
 * ```
 *
 * A sandbox connection that was merely switched off matched neither the
 * blocked branch nor the usable one, fell through to the mock, and the mock's
 * description does not begin with "blocked". So the guard that exists to stop
 * a Test Mode send without a sandbox reported that a sandbox **was**
 * configured, the gate passed, and the letter went to an adapter that
 * fabricates an agreement id and answers SUCCEEDED.
 */
describe('which Adobe adapter a caller gets', () => {
  it('reports a switched-off connection as disabled, not as a mock', async () => {
    // The assertion that pins the defect. Before the change this resolved to
    // `mock`, which the gate read as "a sandbox is configured".
    await saveAdobe({ isSandbox: true, isEnabled: false });

    const { adobeSignMode, description } = await providersWith(true);

    expect(adobeSignMode).toBe('disabled');
    expect(description.adobeSign).toMatch(/switched off/i);
  });

  it('will not let a connection be enabled without every credential', async () => {
    // A stronger guard than the one above, and it means "enabled but missing a
    // credential" cannot be reached through the application at all. The
    // disabled branch still covers it, because a row edited directly in the
    // database can still get there.
    await expect(saveAdobe({ isSandbox: true, isEnabled: true, withRefreshToken: false })).rejects.toThrow(
      /Refresh token is not set/i,
    );

    await saveAdobe({ isSandbox: true, isEnabled: false, withRefreshToken: false });
    expect((await providersWith(true)).adobeSignMode).toBe('disabled');
  });

  it('reports a usable sandbox connection as sandbox', async () => {
    await saveAdobe({ isSandbox: true, isEnabled: true });

    const { adobeSignMode, adobeSign } = await providersWith(true);

    expect(adobeSignMode).toBe('sandbox');
    expect(adobeSign.isMock).toBe(false);
  });

  it('blocks rather than mocks when no connection exists and Test Mode is on', async () => {
    // Safer than a mock, and already the behaviour: an adapter that cannot
    // reach Adobe at all beats one that fabricates success. The mode says
    // which, so the gate can name the fix.
    const { adobeSignMode, adobeSign } = await providersWith(true);

    expect(adobeSignMode).toBe('blocked');
    await expect(adobeSign.findByExternalId('k')).rejects.toThrow();
  });

  it('hands out a labelled mock when Test Mode is off and nothing is configured', async () => {
    const { adobeSignMode, adobeSign } = await providersWith(false);

    expect(adobeSignMode).toBe('mock');
    expect(adobeSign.isMock).toBe(true);
  });

  it('blocks a production connection under Test Mode, and says which reason', async () => {
    // Same blocked adapter as "no connection", different mode — because the
    // two need different sentences: connect a Developer Edition account, or
    // stop pointing Test Mode at production.
    await saveAdobe({ isSandbox: false, isEnabled: true });

    const { adobeSignMode, adobeSign, description } = await providersWith(true);

    expect(adobeSignMode).toBe('production');
    expect(description.adobeSign).toMatch(/production connection/i);
    // Structurally incapable of reaching Adobe, not merely discouraged.
    await expect(adobeSign.findByExternalId('k')).rejects.toThrow();
  });
});
