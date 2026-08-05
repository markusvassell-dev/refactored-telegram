import type { PrismaClient } from '@element/database';
import {
  AdobeSignRestClient,
  BlockedAdobeSignProvider,
  BlockedKarbonProvider,
  KarbonRestClient,
  MockAdobeSignProvider,
  MockKarbonProvider,
  type AdobeSignProvider,
  type KarbonProvider,
} from '@element/integrations';
import { decryptSecret, type Env, type Logger } from '@element/shared';
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
  /** Describes what the caller actually got, for display and for the audit log. */
  description: {
    karbon: string;
    adobeSign: string;
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
  overrides?: { karbon?: KarbonProvider; adobeSign?: AdobeSignProvider };
}

export async function resolveProviders(options: ProviderFactoryOptions): Promise<ResolvedProviders> {
  const { prisma, env, testModeState, overrides } = options;

  if (overrides?.karbon && overrides.adobeSign) {
    return {
      karbon: overrides.karbon,
      adobeSign: overrides.adobeSign,
      description: {
        karbon: `${overrides.karbon.name} (injected)`,
        adobeSign: `${overrides.adobeSign.name} (injected)`,
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

  if (testModeState.testMode && !karbonConnection?.isSandbox) {
    karbon =
      overrides?.karbon ??
      new BlockedKarbonProvider(
        'Test Mode is active and no Karbon sandbox connection is configured, so nothing was written to Karbon.',
      );
    karbonDescription = 'blocked (test mode, no sandbox configured)';
  } else if (karbonUsable) {
    karbon = new KarbonRestClient({
      baseUrl: karbonConnection.baseUrl ?? env.KARBON_API_BASE_URL,
      bearerToken: karbonConnection.credentials.bearerToken as string,
      accessKey: karbonConnection.credentials.accessKey as string,
      logger: options.logger,
    });
    karbonDescription = karbonConnection.isSandbox ? 'Karbon sandbox connection' : 'Karbon production connection';
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
      baseUrl: adobeConnection.baseUrl as string,
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

  return {
    karbon,
    adobeSign,
    description: { karbon: karbonDescription, adobeSign: adobeDescription, testMode: testModeState.testMode },
  };
}
