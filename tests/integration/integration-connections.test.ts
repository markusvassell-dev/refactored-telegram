import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { IntegrationConnectionService } from '@element/services';
import { PermissionError, createLogger, decryptSecret, type Principal } from '@element/shared';

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
  it('lets Karbon be marked production under Test Mode, because the alternative was a lie', async () => {
    // This used to be refused. It sounds stricter and was the opposite: Karbon
    // publishes no sandbox host, so refusing the honest label left marking a
    // production connection "Sandbox" as the only way to make the application
    // work at all — which is what was deployed, and it turned Test Mode's only
    // structural guarantee into a label. The guarantee now lives in the
    // adapter, which serves reads and refuses writes.
    await saveKarbon({ isSandbox: false, testModeActive: true });

    const karbon = (await integrations.list()).find((entry) => entry.provider === 'KARBON');
    expect(karbon?.isSandbox).toBe(false);
  });

  it('still refuses a production Adobe Sign connection, because a write e-mails a client', async () => {
    // The asymmetry is the point: Adobe genuinely offers sandbox accounts, and
    // an Adobe write is a signature request landing in somebody's inbox.
    await expect(
      integrations.save({
        provider: 'ADOBE_SIGN',
        baseUrl: 'https://api.na1.adobesign.com',
        isSandbox: false,
        isEnabled: false,
        credentials: { clientId: 'a', clientSecret: 'b', refreshToken: 'c' },
        testModeActive: true,
        actor: admin,
      }),
    ).rejects.toThrow(/Test Mode is on/i);

    await prisma.integrationConnection.deleteMany({ where: { provider: 'ADOBE_SIGN' } });
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

/**
 * Authorising Adobe Acrobat Sign.
 *
 * The refresh token is the one Adobe credential nobody can look up and paste —
 * Adobe issues it only at the end of an authorisation round trip. Before this
 * existed the setup guide said "complete the authorization-code flow once",
 * which meant assembling a URL by hand, catching a code out of a redirect, and
 * carrying the result back through a terminal and a clipboard. It also told
 * people to register a redirect URI at a route that did not exist.
 */
describe('authorising Adobe Sign', () => {
  const REDIRECT = 'https://app.test/api/integrations/adobe-sign/callback';

  beforeEach(async () => {
    await prisma.integrationConnection.deleteMany({ where: { provider: 'ADOBE_SIGN' } });
  });

  afterAll(async () => {
    await prisma.integrationConnection.deleteMany({ where: { provider: 'ADOBE_SIGN' } });
  });

  async function saveAdobe(overrides: Record<string, unknown> = {}) {
    return integrations.save({
      provider: 'ADOBE_SIGN',
      baseUrl: 'https://api.na1.adobesign.com',
      isSandbox: true,
      isEnabled: false,
      credentials: { clientId: 'adobe-client-id', clientSecret: 'adobe-client-secret' },
      testModeActive: true,
      actor: admin,
      ...overrides,
    });
  }

  it('sends the administrator to the consent host, carrying the state and scopes', async () => {
    await saveAdobe();

    const url = new URL(await integrations.adobeAuthorizeUrl({ redirectUri: REDIRECT, state: 'state-123', actor: admin }));

    // The consent host, not the API host — the API host has no consent screen.
    expect(url.origin).toBe('https://secure.na1.adobesign.com');
    expect(url.searchParams.get('client_id')).toBe('adobe-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('scope')).toContain('agreement_send:self');

    // The client secret is not a query parameter, and a query string ends up in
    // browser history, referrers and vendor access logs.
    expect(url.search).not.toContain('adobe-client-secret');
  });

  it('refuses to start before the client id and secret are saved', async () => {
    await expect(
      integrations.adobeAuthorizeUrl({ redirectUri: REDIRECT, state: 's', actor: admin }),
    ).rejects.toThrow(/Client ID/i);
  });

  it('refuses to start without the region-specific base URL', async () => {
    // Guessing the shard produces an authorisation against the wrong region,
    // which then fails in a way that reads exactly like a bad client secret.
    await saveAdobe({ baseUrl: null });

    await expect(
      integrations.adobeAuthorizeUrl({ redirectUri: REDIRECT, state: 's', actor: admin }),
    ).rejects.toThrow(/base URL/i);
  });

  it('is not something a reader may start', async () => {
    await saveAdobe();

    await expect(
      integrations.adobeAuthorizeUrl({ redirectUri: REDIRECT, state: 's', actor: reader }),
    ).rejects.toThrow(PermissionError);
  });

  it('stores the refresh token Adobe returns, encrypted, and never shows it', async () => {
    await saveAdobe();

    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ refresh_token: 'the-refresh-token', access_token: 'a' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    try {
      await integrations.completeAdobeOAuth({ code: 'auth-code', redirectUri: REDIRECT, actor: admin });
    } finally {
      globalThis.fetch = original;
    }

    const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { provider: 'ADOBE_SIGN' } });
    expect(row.encryptedCredentials).not.toContain('the-refresh-token');
    expect(JSON.parse(decryptSecret(row.encryptedCredentials as string, ENCRYPTION_KEY))).toMatchObject({
      clientId: 'adobe-client-id',
      refreshToken: 'the-refresh-token',
    });

    // Reported to the screen as stored, never as a value.
    const view = (await integrations.list()).find((entry) => entry.provider === 'ADOBE_SIGN');
    const token = view?.credentials.find((field) => field.key === 'refreshToken');
    expect(token?.stored).toBe(true);
    expect(JSON.stringify(view)).not.toContain('the-refresh-token');
  });

  it('keeps the token out of the audit trail', async () => {
    await saveAdobe();

    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ refresh_token: 'secret-token-value' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    try {
      await integrations.completeAdobeOAuth({ code: 'auth-code', redirectUri: REDIRECT, actor: admin });
    } finally {
      globalThis.fetch = original;
    }

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'IntegrationConnection', objectId: 'ADOBE_SIGN' },
      orderBy: { createdAt: 'desc' },
    });
    expect(JSON.stringify(event)).not.toContain('secret-token-value');
    expect(event.reason).toMatch(/authorising/i);
  });

  it('shows Adobe’s own reason when it refuses, because it names the real fault', async () => {
    // A redirect_uri that does not match the registered one is the commonest
    // failure here, and Adobe says so. Swallowing that leaves somebody guessing.
    await saveAdobe();

    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"error":"invalid_request","error_description":"redirect_uri mismatch"}', { status: 400 })) as typeof fetch;

    try {
      await expect(
        integrations.completeAdobeOAuth({ code: 'auth-code', redirectUri: REDIRECT, actor: admin }),
      ).rejects.toThrow(/redirect_uri mismatch/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('stores nothing when Adobe returns no refresh token', async () => {
    await saveAdobe();

    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: 'only-an-access-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

    try {
      await expect(
        integrations.completeAdobeOAuth({ code: 'auth-code', redirectUri: REDIRECT, actor: admin }),
      ).rejects.toThrow(/no refresh token/i);
    } finally {
      globalThis.fetch = original;
    }

    const view = (await integrations.list()).find((entry) => entry.provider === 'ADOBE_SIGN');
    expect(view?.credentials.find((field) => field.key === 'refreshToken')?.stored).toBe(false);
  });
});
