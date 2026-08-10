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
  type AdobeSignProvider,
  type EmailSender,
  type KarbonProvider,
} from '@element/integrations';
import { decryptSecret, isKnownProductionHost, type Env, type Logger } from '@element/shared';
import type { TestModeState } from './settings.js';

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
          logger: options.logger,
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
      logger: options.logger,
    });
    karbonDescription = karbonIsProduction ? 'Karbon production connection' : 'Karbon sandbox connection';
  } else {
    karbon = overrides?.karbon ?? new MockKarbonProvider();
    karbonDescription = 'mock adapter (no Karbon connection configured)';
  }

  // ---- Adobe Acrobat Sign -------------------------------------------------
  let adobeSign: AdobeSignProvider;
  let adobeDescription: string;

  const adobeUsable =
    adobeConnection?.enabled &&
    adobeConnection.credentials.clientId &&
    adobeConnection.credentials.clientSecret &&
    adobeConnection.credentials.refreshToken &&
    adobeConnection.baseUrl;

  if (testModeState.testMode && !adobeConnection?.isSandbox) {
    adobeSign =
      overrides?.adobeSign ??
      new BlockedAdobeSignProvider(
        'Test Mode is active and no Adobe Sign sandbox connection is configured, so no agreement was created.',
      );
    adobeDescription = 'blocked (test mode, no sandbox configured)';
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
  } else {
    adobeSign =
      overrides?.adobeSign ?? new MockAdobeSignProvider({ webhookSecret: env.ADOBE_SIGN_WEBHOOK_SECRET });
    adobeDescription = 'mock adapter (no Adobe Sign connection configured)';
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
    description: {
      karbon: karbonDescription,
      adobeSign: adobeDescription,
      mailer: mailerDescription,
      testMode: testModeState.testMode,
    },
  };
}
