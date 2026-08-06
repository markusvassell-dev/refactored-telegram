import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { KarbonRestClient, AdobeSignRestClient } from '@element/integrations';
import {
  NotFoundError,
  PreconditionError,
  ValidationError,
  assertCan,
  decryptSecret,
  encryptSecret,
  sha256Hex,
  type Logger,
  type Principal,
} from '@element/shared';

/**
 * Integration connections.
 *
 * This is the only place a vendor credential enters the application, and the
 * rules it keeps are the ones that make the Integrations screen safe to use:
 *
 *   - **A secret is written but never read back.** The screen shows whether a
 *     credential is stored and a short fingerprint of it, never the value. An
 *     administrator who needs to know the token itself has the vendor's own
 *     console for that; this application is not a password manager.
 *
 *   - **A blank field leaves the stored secret alone.** Rotating one credential
 *     must not silently clear the others, and re-saving a form whose values are
 *     masked must not overwrite real secrets with empty strings.
 *
 *   - **Nothing is logged.** The audit trail records that a credential changed,
 *     by whom, and its fingerprint — never the credential.
 *
 *   - **Turning a sandbox into production is a deliberate act**, and is refused
 *     while Test Mode is on. Test Mode's guarantee is that no production
 *     integration is reachable; a connection that could flip itself to
 *     production underneath it would make that guarantee a convention.
 */

export interface IntegrationConnectionDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  logger: Logger;
  encryptionKey: string;
}

export type IntegrationProviderKey = 'KARBON' | 'ADOBE_SIGN';

/** Which secrets each provider stores, and which of them are required. */
const CREDENTIAL_FIELDS: Record<IntegrationProviderKey, { key: string; label: string; required: boolean }[]> = {
  KARBON: [
    { key: 'bearerToken', label: 'Bearer token', required: true },
    { key: 'accessKey', label: 'Access key', required: true },
  ],
  ADOBE_SIGN: [
    { key: 'clientId', label: 'Client ID', required: true },
    { key: 'clientSecret', label: 'Client secret', required: true },
    { key: 'refreshToken', label: 'Refresh token', required: true },
  ],
};

const DEFAULT_DISPLAY_NAME: Record<IntegrationProviderKey, string> = {
  KARBON: 'Karbon',
  ADOBE_SIGN: 'Adobe Acrobat Sign',
};

export interface ConnectionView {
  provider: IntegrationProviderKey;
  displayName: string;
  isEnabled: boolean;
  isSandbox: boolean;
  baseUrl: string | null;
  lastCheckedAt: Date | null;
  lastCheckOk: boolean | null;
  lastCheckError: string | null;
  rotatedAt: Date | null;
  /** Per credential: whether one is stored, and a fingerprint — never the value. */
  credentials: { key: string; label: string; required: boolean; stored: boolean; fingerprint: string | null }[];
  /** True when every required credential is present. */
  isComplete: boolean;
}

type StoredCredentials = Record<string, string>;

export class IntegrationConnectionService {
  constructor(private readonly deps: IntegrationConnectionDeps) {}

  async list(): Promise<ConnectionView[]> {
    const rows = await this.deps.prisma.integrationConnection.findMany({ orderBy: { provider: 'asc' } });

    return (Object.keys(CREDENTIAL_FIELDS) as IntegrationProviderKey[]).map((provider) => {
      const row = rows.find((candidate) => candidate.provider === provider);
      const stored = this.read(row?.encryptedCredentials ?? null);

      const credentials = CREDENTIAL_FIELDS[provider].map((field) => {
        const value = stored[field.key];
        return {
          ...field,
          stored: Boolean(value),
          // Six characters of a hash: enough to tell two tokens apart when
          // rotating, useless to anybody who obtains it.
          fingerprint: value ? sha256Hex(value).slice(0, 6) : null,
        };
      });

      return {
        provider,
        displayName: row?.displayName ?? DEFAULT_DISPLAY_NAME[provider],
        isEnabled: row?.isEnabled ?? false,
        isSandbox: row?.isSandbox ?? true,
        baseUrl: row?.baseUrl ?? null,
        lastCheckedAt: row?.lastCheckedAt ?? null,
        lastCheckOk: row?.lastCheckOk ?? null,
        lastCheckError: row?.lastCheckError ?? null,
        rotatedAt: row?.rotatedAt ?? null,
        credentials,
        isComplete: credentials.filter((field) => field.required).every((field) => field.stored),
      };
    });
  }

  /**
   * Saves a connection.
   *
   * Every credential left blank keeps whatever is already stored, so rotating
   * one secret never clears another and re-saving the form does not wipe the
   * connection.
   */
  async save(input: {
    provider: IntegrationProviderKey;
    baseUrl?: string | null;
    isSandbox: boolean;
    isEnabled: boolean;
    /** Only the credentials being set or rotated. Absent or blank means "leave it". */
    credentials: Record<string, string | undefined>;
    testModeActive: boolean;
    actor: Principal;
  }): Promise<{ rotated: string[] }> {
    assertCan(input.actor, 'integration:manage');

    const fields = CREDENTIAL_FIELDS[input.provider];
    if (!fields) throw new ValidationError(`${input.provider} is not an integration this application supports.`);

    const existing = await this.deps.prisma.integrationConnection.findUnique({
      where: { provider: input.provider },
    });
    const stored = this.read(existing?.encryptedCredentials ?? null);

    // Test Mode's guarantee is that no production integration is reachable. A
    // connection that could quietly become production would make that a
    // convention rather than a structural property.
    if (input.testModeActive && !input.isSandbox) {
      throw new PreconditionError(
        'Test Mode is on, so a connection cannot be marked as production. Turn Test Mode off first — deliberately, in Settings — and understand that real client documents become reachable when you do.',
      );
    }

    const next: StoredCredentials = { ...stored };
    const rotated: string[] = [];

    for (const field of fields) {
      const supplied = input.credentials[field.key]?.trim();
      if (!supplied) continue;
      if (stored[field.key] === supplied) continue;

      next[field.key] = supplied;
      rotated.push(field.label);
    }

    const missing = fields.filter((field) => field.required && !next[field.key]);
    if (input.isEnabled && missing.length > 0) {
      throw new ValidationError(
        `Cannot enable this connection: ${missing.map((field) => field.label).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.`,
      );
    }

    const baseUrl = input.baseUrl?.trim() || null;
    if (baseUrl) this.assertUsableBaseUrl(baseUrl);

    await this.deps.prisma.integrationConnection.upsert({
      where: { provider: input.provider },
      create: {
        provider: input.provider,
        displayName: DEFAULT_DISPLAY_NAME[input.provider],
        isEnabled: input.isEnabled,
        isSandbox: input.isSandbox,
        baseUrl,
        encryptedCredentials: this.write(next),
        rotatedAt: rotated.length > 0 ? new Date() : null,
      },
      update: {
        isEnabled: input.isEnabled,
        isSandbox: input.isSandbox,
        baseUrl,
        encryptedCredentials: this.write(next),
        ...(rotated.length > 0 ? { rotatedAt: new Date() } : {}),
        // A credential change invalidates whatever the last check proved.
        ...(rotated.length > 0 ? { lastCheckedAt: null, lastCheckOk: null, lastCheckError: null } : {}),
      },
    });

    await this.deps.audit.record({
      eventType: 'CONFIGURATION_CHANGED',
      objectType: 'IntegrationConnection',
      objectId: input.provider,
      userId: input.actor.id,
      beforeValue: existing
        ? { isEnabled: existing.isEnabled, isSandbox: existing.isSandbox, baseUrl: existing.baseUrl }
        : null,
      afterValue: {
        isEnabled: input.isEnabled,
        isSandbox: input.isSandbox,
        baseUrl,
        // Names and fingerprints only. The values are never written anywhere
        // but the encrypted blob.
        rotated,
        fingerprints: Object.fromEntries(
          Object.entries(next).map(([key, value]) => [key, sha256Hex(value).slice(0, 6)]),
        ),
      },
      reason: rotated.length > 0 ? `Rotated: ${rotated.join(', ')}.` : null,
    });

    return { rotated };
  }

  /**
   * Asks the vendor whether the credentials work, and records the answer.
   *
   * A failure is stored rather than thrown away: "last checked, failed, here is
   * what the vendor said" is what an administrator needs at 8am, and it is the
   * difference between an unverified capability matrix and a verified one.
   */
  async checkConnection(input: {
    provider: IntegrationProviderKey;
    actor: Principal;
  }): Promise<{ ok: boolean; detail?: string }> {
    assertCan(input.actor, 'integration:manage');

    const connection = await this.deps.prisma.integrationConnection.findUnique({
      where: { provider: input.provider },
    });
    if (!connection) throw new NotFoundError('Integration connection');

    const credentials = this.read(connection.encryptedCredentials);
    const missing = CREDENTIAL_FIELDS[input.provider].filter((field) => field.required && !credentials[field.key]);
    if (missing.length > 0) {
      throw new PreconditionError(
        `Nothing to check: ${missing.map((field) => field.label).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.`,
      );
    }

    const result = await this.runCheck(input.provider, connection.baseUrl, credentials);

    await this.deps.prisma.integrationConnection.update({
      where: { provider: input.provider },
      data: {
        lastCheckedAt: new Date(),
        lastCheckOk: result.ok,
        // Bounded: a vendor error body can be long, and this is displayed.
        lastCheckError: result.ok ? null : (result.detail ?? 'The check failed without a reason.').slice(0, 500),
      },
    });

    await this.deps.audit.record({
      eventType: 'CONFIGURATION_CHANGED',
      objectType: 'IntegrationConnection',
      objectId: input.provider,
      userId: input.actor.id,
      afterValue: { healthCheck: result.ok ? 'ok' : 'failed', isSandbox: connection.isSandbox },
      reason: result.ok ? 'Connection check succeeded.' : `Connection check failed: ${result.detail ?? 'no detail'}`,
    });

    return result;
  }

  /** Removes the stored credentials, keeping the connection row and its history. */
  async clearCredentials(input: {
    provider: IntegrationProviderKey;
    reason: string;
    actor: Principal;
  }): Promise<void> {
    assertCan(input.actor, 'integration:manage');

    const reason = input.reason.trim();
    if (reason.length < 5) throw new ValidationError('Give a reason for removing the credentials.');

    const connection = await this.deps.prisma.integrationConnection.findUnique({
      where: { provider: input.provider },
    });
    if (!connection) throw new NotFoundError('Integration connection');

    await this.deps.prisma.integrationConnection.update({
      where: { provider: input.provider },
      data: {
        encryptedCredentials: null,
        // Disabled at the same moment: a connection that is enabled with no
        // credentials would silently fall back to the mock adapter.
        isEnabled: false,
        lastCheckedAt: null,
        lastCheckOk: null,
        lastCheckError: null,
      },
    });

    await this.deps.audit.record({
      eventType: 'CONFIGURATION_CHANGED',
      objectType: 'IntegrationConnection',
      objectId: input.provider,
      userId: input.actor.id,
      beforeValue: { credentialsStored: Boolean(connection.encryptedCredentials), isEnabled: connection.isEnabled },
      afterValue: { credentialsStored: false, isEnabled: false },
      reason,
    });
  }

  private async runCheck(
    provider: IntegrationProviderKey,
    baseUrl: string | null,
    credentials: StoredCredentials,
  ): Promise<{ ok: boolean; detail?: string }> {
    try {
      if (provider === 'KARBON') {
        const client = new KarbonRestClient({
          baseUrl: baseUrl ?? 'https://api.karbonhq.com/v3',
          bearerToken: credentials.bearerToken as string,
          accessKey: credentials.accessKey as string,
          logger: this.deps.logger,
        });
        return await client.healthCheck();
      }

      if (!baseUrl) {
        return { ok: false, detail: 'Adobe Acrobat Sign needs its region-specific API base URL.' };
      }

      const client = new AdobeSignRestClient({
        baseUrl,
        clientId: credentials.clientId as string,
        clientSecret: credentials.clientSecret as string,
        refreshToken: credentials.refreshToken as string,
        logger: this.deps.logger,
      });
      return await client.healthCheck();
    } catch (error) {
      // A thrown error is a failed check, not a failed page.
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * A base URL that is not `https` would send a bearer token in clear text, and
   * one the URL parser rejects would fail much later inside an HTTP client.
   */
  private assertUsableBaseUrl(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ValidationError(`"${value}" is not a URL. It should look like https://api.karbonhq.com/v3.`);
    }

    if (url.protocol !== 'https:') {
      throw new ValidationError('The API base URL must use https; a bearer token must never travel in clear text.');
    }
  }

  private read(encrypted: string | null): StoredCredentials {
    if (!encrypted) return {};
    try {
      return JSON.parse(decryptSecret(encrypted, this.deps.encryptionKey)) as StoredCredentials;
    } catch {
      // A blob this key cannot decrypt is treated as absent rather than
      // crashing the screen: it is what a rotated ENCRYPTION_KEY looks like,
      // and the operator needs the screen in order to re-enter the credentials.
      this.deps.logger.error('Stored integration credentials could not be decrypted', {
        hint: 'ENCRYPTION_KEY may have been rotated; the credentials must be re-entered.',
      });
      return {};
    }
  }

  private write(credentials: StoredCredentials): string | null {
    const present = Object.entries(credentials).filter(([, value]) => Boolean(value));
    if (present.length === 0) return null;
    return encryptSecret(JSON.stringify(Object.fromEntries(present)), this.deps.encryptionKey);
  }
}
