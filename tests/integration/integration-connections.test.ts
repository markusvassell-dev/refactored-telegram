import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { IntegrationConnectionService } from '@element/services';
import { createLogger, decryptSecret, type Principal } from '@element/shared';

/**
 * Storing a vendor credential.
 *
 * This is the only place a Karbon or Adobe Sign secret enters the application,
 * so the tests are about what it will not do: show a secret back, write one to
 * the audit trail, clear one because a field was left blank, or let a
 * connection become production while Test Mode is on.
 */

const ENCRYPTION_KEY = '3'.repeat(64);

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const integrations = new IntegrationConnectionService({
  prisma,
  audit,
  logger: createLogger({ base: { test: 'integration-connections' } }),
  encryptionKey: ENCRYPTION_KEY,
});

const suffix = randomUUID().slice(0, 8);
let admin: Principal;
let reader: Principal;

const BEARER = 'karbon-bearer-token-value';
const ACCESS = 'karbon-access-key-value';

beforeAll(async () => {
  await prisma.$connect();

  const adminUser = await prisma.user.upsert({
    where: { email: `integration-admin-${suffix}@example.test` },
    create: { email: `integration-admin-${suffix}@example.test`, displayName: 'Integration Admin' },
    update: {},
  });
  admin = {
    id: adminUser.id,
    displayName: adminUser.displayName,
    email: adminUser.email,
    roles: ['ADMINISTRATOR'],
  };

  const readerUser = await prisma.user.upsert({
    where: { email: `integration-reader-${suffix}@example.test` },
    create: { email: `integration-reader-${suffix}@example.test`, displayName: 'Integration Reader' },
    update: {},
  });
  reader = {
    id: readerUser.id,
    displayName: readerUser.displayName,
    email: readerUser.email,
    roles: ['READ_ONLY'],
  };
});

beforeEach(async () => {
  await prisma.integrationConnection.deleteMany({ where: { provider: 'KARBON' } });
});

afterAll(async () => {
  await prisma.integrationConnection.deleteMany({ where: { provider: 'KARBON' } });
  await prisma.user.deleteMany({ where: { email: { contains: `-${suffix}@example.test` } } });
  await prisma.$disconnect();
});

function saveKarbon(overrides: Partial<Parameters<IntegrationConnectionService['save']>[0]> = {}) {
  return integrations.save({
    provider: 'KARBON',
    isSandbox: true,
    isEnabled: false,
    credentials: { bearerToken: BEARER, accessKey: ACCESS },
    testModeActive: true,
    actor: admin,
    ...overrides,
  });
}

describe('storing a credential', () => {
  it('encrypts it, and never stores it in a form anything else can read', async () => {
    await saveKarbon();

    const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { provider: 'KARBON' } });

    expect(row.encryptedCredentials).toBeTruthy();
    expect(row.encryptedCredentials).not.toContain(BEARER);
    expect(row.encryptedCredentials).not.toContain(ACCESS);

    // Readable only with the key.
    const decrypted = JSON.parse(decryptSecret(row.encryptedCredentials as string, ENCRYPTION_KEY));
    expect(decrypted).toEqual({ bearerToken: BEARER, accessKey: ACCESS });
  });

  it('never shows the value back, only whether one is stored and a fingerprint', async () => {
    await saveKarbon();

    const [karbon] = await integrations.list();
    const serialised = JSON.stringify(karbon);

    expect(serialised).not.toContain(BEARER);
    expect(serialised).not.toContain(ACCESS);

    const bearer = karbon?.credentials.find((field) => field.key === 'bearerToken');
    expect(bearer?.stored).toBe(true);
    expect(bearer?.fingerprint).toHaveLength(6);
    expect(karbon?.isComplete).toBe(true);
  });

  it('keeps the credential out of the audit trail, recording only that it changed', async () => {
    await saveKarbon();

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'IntegrationConnection', objectId: 'KARBON' },
      orderBy: { createdAt: 'desc' },
    });

    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain(BEARER);
    expect(serialised).not.toContain(ACCESS);
    expect(event.afterValue).toMatchObject({ rotated: ['Bearer token', 'Access key'] });
    expect(event.userId).toBe(admin.id);
  });
});

describe('rotating one credential', () => {
  it('leaves the others alone when their fields are blank', async () => {
    await saveKarbon();

    await saveKarbon({ credentials: { bearerToken: 'a-new-bearer-token', accessKey: '' } });

    const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { provider: 'KARBON' } });
    const decrypted = JSON.parse(decryptSecret(row.encryptedCredentials as string, ENCRYPTION_KEY));

    expect(decrypted.bearerToken).toBe('a-new-bearer-token');
    expect(decrypted.accessKey).toBe(ACCESS);
  });

  it('does not wipe a connection when the form is re-saved with everything blank', async () => {
    await saveKarbon();

    const outcome = await saveKarbon({ credentials: {} });

    expect(outcome.rotated).toEqual([]);
    const [karbon] = await integrations.list();
    expect(karbon?.isComplete).toBe(true);
  });

  it('reports what was rotated, and nothing when a value is resubmitted unchanged', async () => {
    const first = await saveKarbon();
    expect(first.rotated).toEqual(['Bearer token', 'Access key']);

    const second = await saveKarbon();
    expect(second.rotated).toEqual([]);
  });

  it('invalidates the last check, because it proved a credential that is gone', async () => {
    await saveKarbon();
    await prisma.integrationConnection.update({
      where: { provider: 'KARBON' },
      data: { lastCheckedAt: new Date(), lastCheckOk: true },
    });

    await saveKarbon({ credentials: { bearerToken: 'rotated-again' } });

    const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { provider: 'KARBON' } });
    expect(row.lastCheckedAt).toBeNull();
    expect(row.lastCheckOk).toBeNull();
  });
});

describe('what it refuses', () => {
  it('refuses to mark a connection production while Test Mode is on', async () => {
    await expect(saveKarbon({ isSandbox: false, testModeActive: true })).rejects.toThrow(/Test Mode is on/i);
  });

  it('allows production once Test Mode is off, because that is then a deliberate act', async () => {
    await saveKarbon({ isSandbox: false, testModeActive: false });

    const [karbon] = await integrations.list();
    expect(karbon?.isSandbox).toBe(false);
  });

  it('refuses to enable a connection whose credentials are incomplete', async () => {
    await expect(
      saveKarbon({ isEnabled: true, credentials: { bearerToken: BEARER } }),
    ).rejects.toThrow(/Access key (is|are) not set/i);
  });

  it('refuses a base URL that is not https, which would send a token in clear text', async () => {
    await expect(saveKarbon({ baseUrl: 'http://api.karbonhq.com/v3' })).rejects.toThrow(/must use https/i);
  });

  it('refuses a base URL that is not a URL at all', async () => {
    await expect(saveKarbon({ baseUrl: 'api.karbonhq.com' })).rejects.toThrow(/is not a URL/i);
  });

  it('refuses somebody who cannot manage integrations', async () => {
    await expect(saveKarbon({ actor: reader })).rejects.toThrow();
  });

  it('refuses to check a connection whose credentials are not set', async () => {
    await saveKarbon({ credentials: { bearerToken: BEARER } });

    await expect(integrations.checkConnection({ provider: 'KARBON', actor: admin })).rejects.toThrow(
      /Nothing to check/i,
    );
  });
});

describe('checking a connection', () => {
  it('records a failure rather than throwing it away, because the detail is the point', async () => {
    // Unroutable host: the check must come back as a recorded failure, not an
    // unhandled error that leaves the screen with nothing to show.
    await saveKarbon({ baseUrl: 'https://karbon.invalid/v3' });

    const result = await integrations.checkConnection({ provider: 'KARBON', actor: admin });
    expect(result.ok).toBe(false);

    const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { provider: 'KARBON' } });
    expect(row.lastCheckOk).toBe(false);
    expect(row.lastCheckedAt).not.toBeNull();
    expect(row.lastCheckError).toBeTruthy();
    expect((row.lastCheckError as string).length).toBeLessThanOrEqual(500);
  }, 60_000);

  it('records the attempt in the audit trail either way', async () => {
    await saveKarbon({ baseUrl: 'https://karbon.invalid/v3' });
    await integrations.checkConnection({ provider: 'KARBON', actor: admin });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'IntegrationConnection', objectId: 'KARBON' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event.afterValue).toMatchObject({ healthCheck: 'failed' });
  }, 60_000);
});

describe('removing credentials', () => {
  it('clears them and disables the connection, so it cannot silently use a mock while enabled', async () => {
    await saveKarbon({ isEnabled: true });

    await integrations.clearCredentials({
      provider: 'KARBON',
      reason: 'Rotating the tenant credentials.',
      actor: admin,
    });

    const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { provider: 'KARBON' } });
    expect(row.encryptedCredentials).toBeNull();
    expect(row.isEnabled).toBe(false);
    expect(row.lastCheckedAt).toBeNull();
  });

  it('refuses without a reason', async () => {
    await saveKarbon();
    await expect(
      integrations.clearCredentials({ provider: 'KARBON', reason: '', actor: admin }),
    ).rejects.toThrow(/Give a reason/i);
  });
});

describe('a credential blob this key cannot read', () => {
  it('is treated as absent rather than crashing the screen', async () => {
    await saveKarbon();

    // What a rotated ENCRYPTION_KEY looks like. The screen has to keep working:
    // it is where the operator re-enters the credentials.
    await prisma.integrationConnection.update({
      where: { provider: 'KARBON' },
      data: { encryptedCredentials: 'v1.integration-secret.aaaa.bbbb.cccc' },
    });

    const [karbon] = await integrations.list();
    expect(karbon?.credentials.every((field) => !field.stored)).toBe(true);
    expect(karbon?.isComplete).toBe(false);
  });
});
