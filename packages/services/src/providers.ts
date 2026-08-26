import type { PrismaClient } from '@element/database';
import {
  AdobeSignRestClient,
  BlockedAdobeSignProvider,
  BlockedKarbonProvider,
  ReadOnlyKarbonProvider,
  KarbonRestClient,
  MockAdobeSignProvider,
  MockKarbonProvider,
  MicrosoftGraphMailer,
  MockEmailSender,
  BlockedEmailSender,
  RateLimiter,
  KARBON_DOCUMENTED_REQUESTS_PER_MINUTE,
  type AdobeSignProvider,
  type EmailSender,
  type KarbonProvider,
} from '@element/integrations';
import { decryptSecret, isKnownProductionHost, type Env, type Logger } from '@element/shared';
import type { TestModeState } from './settings.js';

/**
 * One Karbon request budget for this process.
 *
 * Karbon's limit is **per account per application**, and `resolveProviders`
 * runs on every request — so a client built per request got a full bucket of
 * 120 tokens each time and the limiter protected nothing. Two previews in the
 * same minute each believed they had the whole budget, the second one spent an
 * allowance the first had already used, and Karbon answered 429 until the
 * retries ran out. Observed exactly that way on the live tenant: the first
 * preview returned, the next stopped working.
 *
 * `KarbonClientConfig.rateLimiter` existed for this from the start — "shared
 * across clients when one is supplied" — and simply was not passed.
 *
 * Honest about its reach: this makes the budget shared **within one process**.
 * The web service and the worker are separate processes drawing on the same
 * account, so the real limit still needs coordination this does not provide.
 * Per-request to per-process is most of the error, not all of it.
 */
const karbonRequestBudget = new RateLimiter({
  requestsPerMinute: KARBON_DOCUMENTED_REQUESTS_PER_MINUTE,
});

/**
 * Provider resolution.
 *
 * This is where Test Mode becomes a structural guarantee rather than a
 * convention: when Test Mode is on and no sandbox connection is configured,
 * the caller is handed an adapter that physically cannot reach production.
 *
 * Every provider reports `isMock`, and the UI shows that state, so nobody can
 * mistake a mocked integration for a working one.
 */

/**
 * Which of the five Adobe outcomes the caller actually got.
 *
 * A machine-readable companion to the description string, and the send gate
 * keys off this rather than the prose. It used to key off the prose:
 *
 * ```ts
 * sandboxConfigured: !providers.description.adobeSign.startsWith('blocked')
 * ```
 *
 * A connection marked sandbox but *unusable* — switched off, or missing a
 * credential — matched neither the blocked branch nor the usable one and fell
 * through to the mock, whose description does not begin with "blocked". So the
 * guard that exists to stop a Test Mode send without a sandbox reported that a
 * sandbox **was** configured, the gate passed, and the letter went to a mock
 * that fabricates an agreement id and answers `SUCCEEDED`.
 *
 * `disabled` is separate from `mock` on purpose, and it is the whole reason
 * this type exists: a connection that is present and switched off is somebody's
 * half-finished configuration, not a decision to work without a vendor, and the
 * two need different sentences because they need different fixes.
 */
export type AdobeSignMode = 'sandbox' | 'production' | 'mock' | 'blocked' | 'disabled';

export interface ResolvedProviders {
  karbon: KarbonProvider;
  adobeSign: AdobeSignProvider;
  mailer: EmailSender;
  /** Describes what the caller actually got, for display and for the audit log. */
  description: {
    karbon: string;
    adobeSign: string;
    mailer: string;
    testMode: boolean;
  };
  /** The same fact as `description.adobeSign`, in a form code may branch on. */
  adobeSignMode: AdobeSignMode;
}

interface StoredCredentials {
  bearerToken?: string;
  accessKey?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  webhookSecret?: string;
}

async function loadCredentials(
  prisma: PrismaClient,
  provider: 'KARBON' | 'ADOBE_SIGN',
  encryptionKey: string,
): Promise<{ credentials: StoredCredentials; isSandbox: boolean; enabled: boolean; baseUrl: string | null } | null> {
  const connection = await prisma.integrationConnection.findUnique({ where: { provider } });
  if (!connection) return null;

  let credentials: StoredCredentials = {};
  if (connection.encryptedCredentials) {
    try {
      credentials = JSON.parse(decryptSecret(connection.encryptedCredentials, encryptionKey)) as StoredCredentials;
    } catch {
      credentials = {};
    }
  }

  return {
    credentials,
    isSandbox: connection.isSandbox,
    enabled: connection.isEnabled,
    baseUrl: connection.baseUrl,
  };
}

export interface ProviderFactoryOptions {
  prisma: PrismaClient;
  env: Env;
  testModeState: TestModeState;
  logger: Logger;
  /** Injected in tests so a suite can drive the mocks directly. */
  overrides?: { karbon?: KarbonProvider; adobeSign?: AdobeSignProvider; mailer?: EmailSender };
}

export async function resolveProviders(options: ProviderFactoryOptions): Promise<ResolvedProviders> {
  const { prisma, env, testModeState, overrides } = options;

  if (overrides?.karbon && overrides.adobeSign) {
    return {
      karbon: overrides.karbon,
      adobeSign: overrides.adobeSign,
      mailer: overrides.mailer ?? new MockEmailSender(),
      // An injected adapter is whatever the test says it is; `isMock` is the
      // only thing that can be said about it truthfully.
      adobeSignMode: overrides.adobeSign.isMock ? 'mock' : 'sandbox',
      description: {
        karbon: `${overrides.karbon.name} (injected)`,
        adobeSign: `${overrides.adobeSign.name} (injected)`,
        mailer: 'mock mailer (injected)',
        testMode: testModeState.testMode,
      },
    };
  }

  const karbonConnection = await loadCredentials(prisma, 'KARBON', env.ENCRYPTION_KEY);
  const adobeConnection = await loadCredentials(prisma, 'ADOBE_SIGN', env.ENCRYPTION_KEY);

  // ---- Karbon -------------------------------------------------------------
  let karbon: KarbonProvider;
  let karbonDescription: string;

  const karbonUsable =
    karbonConnection?.enabled &&
    karbonConnection.credentials.bearerToken &&
    karbonConnection.credentials.accessKey;

  // The label is not trusted on its own. A connection pointing at
  // api.karbonhq.com is production whatever the box says, and the box was
  // ticked wrong in a real deployment — not carelessly, but because it used to
  // be the only way to make the application work at all. Deriving this from the
  // host means correcting the label is now cosmetic rather than load-bearing:
  // a mislabelled production connection is still treated as production.
  const karbonIsProduction =
    !karbonConnection?.isSandbox ||
    isKnownProductionHost('KARBON', karbonConnection?.baseUrl ?? env.KARBON_API_BASE_URL);

  if (testModeState.testMode && karbonIsProduction && karbonUsable) {
    // Reads are allowed; writes are not. Karbon publishes no sandbox host, so
    // refusing everything left a firm one lever to make the application work at
    // all — marking the production connection "Sandbox" — which turned Test
    // Mode's guarantee into a label. Reading a firm's own Karbon changes
    // nothing on their side; writing is what Test Mode exists to prevent.
    karbon =
      overrides?.karbon ??
      new ReadOnlyKarbonProvider(
        new KarbonRestClient({
          baseUrl: karbonConnection.baseUrl ?? env.KARBON_API_BASE_URL,
          bearerToken: karbonConnection.credentials.bearerToken as string,
          accessKey: karbonConnection.credentials.accessKey as string,
          noteAuthorEmail: env.KARBON_NOTE_AUTHOR_EMAIL,
          logger: options.logger,
          rateLimiter: karbonRequestBudget,
        }),
        'Test Mode is active and this is a production Karbon connection, so nothing was written to Karbon.',
      );
    karbonDescription = 'Karbon production connection, reads only (test mode)';
  } else if (testModeState.testMode && karbonIsProduction) {
    karbon =
      overrides?.karbon ??
      new BlockedKarbonProvider(
        'Test Mode is active and no usable Karbon connection is configured, so nothing was written to Karbon.',
      );
    karbonDescription = 'blocked (test mode, no usable connection)';
  } else if (karbonUsable) {
    karbon = new KarbonRestClient({
      baseUrl: karbonConnection.baseUrl ?? env.KARBON_API_BASE_URL,
      bearerToken: karbonConnection.credentials.bearerToken as string,
      accessKey: karbonConnection.credentials.accessKey as string,
      noteAuthorEmail: env.KARBON_NOTE_AUTHOR_EMAIL,
      logger: options.logger,
      rateLimiter: karbonRequestBudget,
    });
    karbonDescription = karbonIsProduction ? 'Karbon production connection' : 'Karbon sandbox connection';
  } else {
    karbon = overrides?.karbon ?? new MockKarbonProvider();
    karbonDescription = 'mock adapter (no Karbon connection configured)';
  }

  // ---- Adobe Acrobat Sign -------------------------------------------------
  let adobeSign: AdobeSignProvider;
  let adobeDescription: string;
  let adobeMode: AdobeSignMode;

  const adobeUsable =
    adobeConnection?.enabled &&
    adobeConnection.credentials.clientId &&
    adobeConnection.credentials.clientSecret &&
    adobeConnection.credentials.refreshToken &&
    adobeConnection.baseUrl;

  if (testModeState.testMode && !adobeConnection?.isSandbox) {
    // Both reasons land here and the adapter is the same for both — blocked,
    // structurally incapable of reaching Adobe. But the *reason* differs, and
    // so does what somebody does about it: connect a Developer Edition
    // account, or stop pointing Test Mode at production. Conflating them meant
    // one sentence that only ever described half the cases.
    const reason = adobeConnection
      ? 'Test Mode is active and this is a production Adobe Sign connection, so no agreement was created.'
      : 'Test Mode is active and no Adobe Sign connection is configured, so no agreement was created.';

    adobeSign = overrides?.adobeSign ?? new BlockedAdobeSignProvider(reason);
    adobeDescription = adobeConnection
      ? 'blocked (test mode, production connection)'
      : 'blocked (test mode, no connection configured)';
    adobeMode = adobeConnection ? 'production' : 'blocked';
  } else if (adobeUsable) {
    adobeSign = new AdobeSignRestClient({
      baseUrl: (adobeConnection.baseUrl ?? env.ADOBE_SIGN_API_BASE_URL) as string,
      clientId: adobeConnection.credentials.clientId as string,
      clientSecret: adobeConnection.credentials.clientSecret as string,
      refreshToken: adobeConnection.credentials.refreshToken as string,
      webhookSecret: adobeConnection.credentials.webhookSecret ?? env.ADOBE_SIGN_WEBHOOK_SECRET,
      logger: options.logger,
    });
    adobeDescription = adobeConnection.isSandbox ? 'Adobe Sign sandbox connection' : 'Adobe Sign production connection';
    adobeMode = adobeConnection.isSandbox ? 'sandbox' : 'production';
  } else if (adobeConnection) {
    // Present but not usable: switched off, or a credential missing. Falling
    // through to the mock here is what let a Test Mode send be "sent" to
    // nobody while every signal said it had gone out, so this is now its own
    // outcome with its own sentence — the fix is a click, and the reviewer has
    // to be told which click.
    adobeSign =
      overrides?.adobeSign ?? new MockAdobeSignProvider({ webhookSecret: env.ADOBE_SIGN_WEBHOOK_SECRET });
    adobeDescription = adobeConnection.enabled
      ? 'unusable (Adobe Sign connection is missing a credential)'
      : 'disabled (the Adobe Sign connection is switched off)';
    adobeMode = 'disabled';
  } else {
    adobeSign =
      overrides?.adobeSign ?? new MockAdobeSignProvider({ webhookSecret: env.ADOBE_SIGN_WEBHOOK_SECRET });
    adobeDescription = 'mock adapter (no Adobe Sign connection configured)';
    adobeMode = 'mock';
  }

  // ---- Staff notification e-mail ------------------------------------------
  //
  // Staff only, so Test Mode does not block it: nothing here reaches a client,
  // and being able to prove mail works before going live is the point of a
  // test deployment. Test Mode marks every subject instead.
  let mailer: EmailSender;
  let mailerDescription: string;

  if (overrides?.mailer) {
    mailer = overrides.mailer;
    mailerDescription = 'mock mailer (injected)';
  } else if (!env.NOTIFICATION_EMAIL_ENABLED) {
    mailer = new MockEmailSender();
    mailerDescription = 'not sending (NOTIFICATION_EMAIL_ENABLED is off)';
  } else if (!env.NOTIFICATION_EMAIL_SENDER || !env.ENTRA_TENANT_ID || !env.ENTRA_CLIENT_ID || !env.ENTRA_CLIENT_SECRET) {
    // The environment schema refuses this combination, so reaching here means
    // something changed underneath a running process. Refusing loudly beats a
    // mock that silently swallows notices somebody is expecting.
    mailer = new BlockedEmailSender(
      'Notification e-mail is enabled but the Entra ID registration or the sender mailbox is not configured.',
    );
    mailerDescription = 'blocked (enabled but not configured)';
  } else {
    mailer = new MicrosoftGraphMailer({
      tenantId: env.ENTRA_TENANT_ID,
      clientId: env.ENTRA_CLIENT_ID,
      clientSecret: env.ENTRA_CLIENT_SECRET,
      sender: env.NOTIFICATION_EMAIL_SENDER,
      logger: options.logger,
    });
    mailerDescription = `Microsoft 365, sending as ${env.NOTIFICATION_EMAIL_SENDER}`;
  }

  return {
    karbon,
    adobeSign,
    mailer,
    adobeSignMode: adobeMode,
    description: {
      karbon: karbonDescription,
      adobeSign: adobeDescription,
      mailer: mailerDescription,
      testMode: testModeState.testMode,
    },
  };
}
