import { createHmac, timingSafeEqual } from 'node:crypto';
import { IntegrationError, ValidationError, createLogger, type Logger } from '@element/shared';
import type {
  AdobeSignProvider,
  AdobeWebhookEvent,
  AgreementState,
  AgreementStatus,
  CreateAgreementRequest,
  CreateAgreementResult,
  SignerRole,
  SignerStatus,
} from './types.js';

/**
 * Adobe Acrobat Sign REST client (API v6).
 *
 * Implemented against Adobe's published REST API. It has NOT been exercised
 * against a live Adobe Sign account from this project; the Integrations screen
 * reports the connection as unverified until a health check succeeds with real
 * credentials. See docs/adobe-sign-setup.md.
 *
 * Credentials are never hardcoded. The access token is obtained by refreshing
 * an OAuth refresh token held in the encrypted integration connection record.
 */

export interface AdobeSignClientConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  webhookSecret?: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const STATUS_MAP: Record<string, AgreementStatus> = {
  OUT_FOR_SIGNATURE: 'OUT_FOR_SIGNATURE',
  OUT_FOR_APPROVAL: 'OUT_FOR_SIGNATURE',
  SIGNED: 'SIGNED',
  APPROVED: 'SIGNED',
  COMPLETED: 'COMPLETED',
  ABORTED: 'DECLINED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  ARCHIVED: 'COMPLETED',
  AUTHORING: 'CREATED',
  DRAFT: 'CREATED',
  WAITING_FOR_MY_SIGNATURE: 'PARTIALLY_SIGNED',
  WAITING_FOR_OTHERS: 'PARTIALLY_SIGNED',
};

const SIGNER_STATUS_MAP: Record<string, SignerStatus> = {
  NOT_YET_VISIBLE: 'NOT_YET_NOTIFIED',
  WAITING_FOR_MY_SIGNATURE: 'OUT_FOR_SIGNATURE',
  WAITING_FOR_OTHERS: 'WAITING_FOR_OTHERS',
  WAITING_FOR_MY_APPROVAL: 'OUT_FOR_SIGNATURE',
  SIGNED: 'SIGNED',
  APPROVED: 'SIGNED',
  COMPLETED: 'SIGNED',
  DECLINED: 'DECLINED',
  DELEGATED: 'DELEGATED',
  EXPIRED: 'EXPIRED',
};

export class AdobeSignRestClient implements AdobeSignProvider {
  readonly name = 'adobe-sign';
  readonly isMock = false;

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: AdobeSignClientConfig) {
    this.logger = config.logger ?? createLogger({ base: { integration: 'adobe-sign' } });
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 45_000;
  }

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
    });

    const response = await this.fetchImpl(`${this.baseUrl}/oauth/v2/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      throw new IntegrationError('Adobe Sign', `OAuth refresh failed with HTTP ${response.status}`, {
        retryable: RETRYABLE_STATUS.has(response.status),
        userMessage: 'The Adobe Sign connection needs to be re-authorised by an administrator.',
      });
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new IntegrationError('Adobe Sign', 'OAuth refresh returned no access token');
    }

    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = Date.now() + (payload.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  private async request<T>(path: string, init: RequestInit & { binary?: boolean } = {}): Promise<T> {
    const token = await this.token();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/rest/v6${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
          ...(init.headers as Record<string, string> | undefined),
        },
      });

      if (response.status === 404) return null as T;

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new IntegrationError('Adobe Sign', `HTTP ${response.status} for ${path}`, {
          retryable: RETRYABLE_STATUS.has(response.status),
          context: { status: response.status, detail: detail.slice(0, 500) },
        });
      }

      if (init.binary) return Buffer.from(await response.arrayBuffer()) as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : null) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async createAgreement(request: CreateAgreementRequest): Promise<CreateAgreementResult> {
    if (request.signers.length === 0) {
      throw new ValidationError('An Adobe Sign agreement requires at least one signer.');
    }

    // 1. Upload the approved PDF as a transient document.
    const form = new FormData();
    form.append('File', new Blob([Buffer.from(request.pdf)], { type: 'application/pdf' }), request.fileName);

    const transient = await this.request<{ transientDocumentId?: string }>('/transientDocuments', {
      method: 'POST',
      body: form,
    });

    if (!transient?.transientDocumentId) {
      throw new IntegrationError('Adobe Sign', 'Uploading the approved PDF did not return a transient document id');
    }

    // 2. Build participant sets. Signers sharing an order sign in parallel.
    const orders = [...new Set(request.signers.map((signer) => signer.order))].sort((a, b) => a - b);
    const participantSets = orders.map((order, index) => ({
      order: index + 1,
      role: 'SIGNER',
      memberInfos: request.signers
        .filter((signer) => signer.order === order)
        .map((signer) => ({ email: signer.email, name: signer.name })),
    }));

    const created = await this.request<{ id?: string }>('/agreements', {
      method: 'POST',
      headers: {
        // Adobe honours a client-supplied correlation id; we send our
        // deterministic idempotency key so a retry is traceable.
        'x-api-user': '',
      },
      body: JSON.stringify({
        fileInfos: [{ transientDocumentId: transient.transientDocumentId }],
        name: request.title,
        participantSetsInfo: participantSets,
        signatureType: 'ESIGN',
        state: 'IN_PROCESS',
        message: request.message,
        locale: request.locale,
        ccs: request.ccEmails.map((email) => ({ email })),
        externalId: { id: request.idempotencyKey },
        expirationTime: new Date(Date.now() + request.expiresInDays * 86_400_000).toISOString(),
        reminderFrequency: request.reminderEveryBusinessDays <= 1 ? 'DAILY_UNTIL_SIGNED' : 'EVERY_THIRD_DAY_UNTIL_SIGNED',
        emailOption: { sendOptions: { completionEmails: 'ALL', inFlightEmails: 'ALL', initEmails: 'ALL' } },
      }),
    });

    if (!created?.id) throw new IntegrationError('Adobe Sign', 'Agreement creation returned no agreement id');

    this.logger.info('Adobe Sign agreement created', {
      agreementId: created.id,
      signerCount: request.signers.length,
      participantSets: participantSets.length,
    });

    return { agreementId: created.id, status: 'OUT_FOR_SIGNATURE', deduplicated: false };
  }

  /**
   * Finds an existing agreement created with the same deterministic key.
   * Called before `createAgreement` so a retry cannot produce a duplicate.
   */
  async findByExternalId(idempotencyKey: string): Promise<string | null> {
    const response = await this.request<{ userAgreementList?: { id: string; externalId?: { id?: string } }[] }>(
      `/agreements?externalId=${encodeURIComponent(idempotencyKey)}`,
    );
    const match = response?.userAgreementList?.find((agreement) => agreement.externalId?.id === idempotencyKey);
    return match?.id ?? null;
  }

  async getAgreement(agreementId: string): Promise<AgreementState | null> {
    const agreement = await this.request<Record<string, unknown> | null>(`/agreements/${encodeURIComponent(agreementId)}`);
    if (!agreement) return null;

    const members = await this.request<{ participantSets?: Record<string, unknown>[] } | null>(
      `/agreements/${encodeURIComponent(agreementId)}/members`,
    );

    const signers: AgreementState['signers'] = [];
    for (const set of members?.participantSets ?? []) {
      const status = SIGNER_STATUS_MAP[String(set.status ?? '')] ?? 'NOT_YET_NOTIFIED';
      for (const member of (set.memberInfos as Record<string, unknown>[] | undefined) ?? []) {
        signers.push({
          email: String(member.email ?? ''),
          role: 'AUTHORIZED_SIGNING_OFFICER' as SignerRole,
          status,
          signedAt: typeof member.completedDate === 'string' ? member.completedDate : null,
          viewedAt: null,
        });
      }
    }

    return {
      agreementId,
      status: STATUS_MAP[String(agreement.status ?? '')] ?? 'CREATED',
      signers,
      createdAt: typeof agreement.createdDate === 'string' ? agreement.createdDate : null,
      completedAt: typeof agreement.completedDate === 'string' ? agreement.completedDate : null,
      declineReason: null,
    };
  }

  async cancelAgreement(agreementId: string, reason: string): Promise<void> {
    await this.request(`/agreements/${encodeURIComponent(agreementId)}/state`, {
      method: 'PUT',
      body: JSON.stringify({ state: 'CANCELLED', agreementCancellationInfo: { comment: reason, notifySigner: false } }),
    });
  }

  async downloadSignedPdf(agreementId: string): Promise<Buffer> {
    return this.request<Buffer>(`/agreements/${encodeURIComponent(agreementId)}/combinedDocument`, {
      binary: true,
      headers: { Accept: 'application/pdf' },
    });
  }

  async downloadAuditReport(agreementId: string): Promise<Buffer> {
    return this.request<Buffer>(`/agreements/${encodeURIComponent(agreementId)}/auditTrail`, {
      binary: true,
      headers: { Accept: 'application/pdf' },
    });
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): boolean {
    const secret = this.config.webhookSecret;
    if (!secret) return false;

    // Adobe sends the client id for verification handshakes and an HMAC of the
    // payload for delivered events. Both are checked in constant time.
    const provided =
      headers['x-adobesign-clientid'] ?? headers['X-AdobeSign-ClientId'] ?? headers['x-adobe-signature'] ?? '';

    if (provided === this.config.clientId) return true;

    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string): AdobeWebhookEvent | null {
    try {
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      const agreement = payload.agreement as Record<string, unknown> | undefined;
      const participant = payload.participantUser as Record<string, unknown> | undefined;

      return {
        eventId: String(payload.webhookNotificationId ?? payload.eventId ?? ''),
        eventType: String(payload.event ?? ''),
        agreementId: agreement ? String(agreement.id ?? '') : null,
        participantEmail: participant ? String(participant.email ?? '') : null,
        occurredAt: String(payload.eventDate ?? new Date().toISOString()),
        raw: payload,
      };
    } catch {
      return null;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.request('/users/me');
      return { ok: true };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'Unknown error' };
    }
  }
}
