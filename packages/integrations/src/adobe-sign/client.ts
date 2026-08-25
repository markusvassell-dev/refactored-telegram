import { createHmac, timingSafeEqual } from 'node:crypto';
import { ADOBE_SIGN_DEFAULT_REQUESTS_PER_MINUTE, RateLimiter, retryAfterMs } from '../http/throttle.js';
import { IntegrationError, ValidationError, createLogger, type Logger } from '@element/shared';
import { adobeReminderFrequency } from './types.js';
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
  maxRetries?: number;
  /**
   * Acrobat Sign publishes no fixed number — the rate depends on the service
   * plan — so this paces a bulk sync rather than enforcing a documented limit.
   * `Retry-After` is honoured regardless.
   */
  requestsPerMinute?: number;
  /** Shared across clients when supplied, which is what a bulk sync needs. */
  rateLimiter?: RateLimiter;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * How many agreements a filtered lookup may return before the filter itself is
 * in doubt. The key is deterministic and per engagement, so a working filter
 * answers with none or one.
 */
const MAX_EXTERNAL_ID_CANDIDATES = 5;

/**
 * `AgreementInfo.status`, every value Adobe publishes.
 *
 * It used to hold thirteen entries, four of which Adobe never returns for an
 * agreement (`COMPLETED`, `ABORTED`, `WAITING_FOR_MY_SIGNATURE`,
 * `WAITING_FOR_OTHERS` — the first two do not exist and the last two belong to
 * a participant), and it was missing eleven that Adobe does return. Unmapped
 * values fall back to `CREATED`, which reads as *not sent yet*: a letter
 * sitting in a client's inbox as `OUT_FOR_DELIVERY` reported as though nothing
 * had happened. That is the worst available wrong answer for a status poll,
 * so the fallback now says so out loud (see `mapAgreementStatus`).
 *
 * Adobe has no `DECLINED`. A declined agreement is `CANCELLED`, and the only
 * thing that tells the two apart is a `REJECTED` event — which is why
 * `getAgreement` reads the event list before settling on a status.
 */
const STATUS_MAP: Record<string, AgreementStatus> = {
  OUT_FOR_SIGNATURE: 'OUT_FOR_SIGNATURE',
  OUT_FOR_APPROVAL: 'OUT_FOR_SIGNATURE',
  OUT_FOR_DELIVERY: 'OUT_FOR_SIGNATURE',
  OUT_FOR_ACCEPTANCE: 'OUT_FOR_SIGNATURE',
  OUT_FOR_FORM_FILLING: 'OUT_FOR_SIGNATURE',
  WAITING_FOR_FAXIN: 'OUT_FOR_SIGNATURE',
  WAITING_FOR_VERIFICATION: 'OUT_FOR_SIGNATURE',
  WIDGET_WAITING_FOR_VERIFICATION: 'OUT_FOR_SIGNATURE',
  SIGNED: 'SIGNED',
  APPROVED: 'SIGNED',
  ACCEPTED: 'SIGNED',
  DELIVERED: 'SIGNED',
  FORM_FILLED: 'SIGNED',
  ARCHIVED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  AUTHORING: 'CREATED',
  DRAFT: 'CREATED',
  PREFILL: 'CREATED',
  // Adobe's own transient state between upload and send. Genuinely "created".
  DOCUMENTS_NOT_YET_PROCESSED: 'CREATED',
};

/**
 * `DetailedParticipantSetInfo.status`, every value Adobe publishes.
 *
 * The status that means anything lives on the participant *set*; the
 * participant itself only says `ACTIVE` or `REPLACED`. This map used to carry
 * `SIGNED`, `APPROVED`, `DECLINED` and `DELEGATED`, none of which a set ever
 * reports, and to miss `CANCELLED` — so a cancelled signer read as
 * `NOT_YET_NOTIFIED`, indistinguishable from one who had never been emailed.
 */
const SIGNER_STATUS_MAP: Record<string, SignerStatus> = {
  NOT_YET_VISIBLE: 'NOT_YET_NOTIFIED',
  WAITING_FOR_OTHERS: 'WAITING_FOR_OTHERS',
  WAITING_FOR_AUTHORING: 'WAITING_FOR_OTHERS',
  WAITING_FOR_PREFILL: 'WAITING_FOR_OTHERS',
  WAITING_FOR_MY_SIGNATURE: 'OUT_FOR_SIGNATURE',
  WAITING_FOR_MY_APPROVAL: 'OUT_FOR_SIGNATURE',
  WAITING_FOR_MY_ACCEPTANCE: 'OUT_FOR_SIGNATURE',
  WAITING_FOR_MY_ACKNOWLEDGEMENT: 'OUT_FOR_SIGNATURE',
  WAITING_FOR_MY_FORM_FILLING: 'OUT_FOR_SIGNATURE',
  WAITING_FOR_MY_VERIFICATION: 'OUT_FOR_SIGNATURE',
  // Awaiting a delegation, not evidence one happened. `DELEGATED` is set from
  // the `ACTION_DELEGATED` event, which is the only thing that says a named
  // signer handed the letter to somebody else — and on an engagement letter
  // that is a fact the firm has to know about.
  WAITING_FOR_MY_DELEGATION: 'OUT_FOR_SIGNATURE',
  COMPLETED: 'SIGNED',
  EXPIRED: 'EXPIRED',
  // Not "never notified". A cancelled agreement cancels its participants, and
  // the two must not look the same to somebody reading the signing panel.
  CANCELLED: 'DECLINED',
};

/**
 * Event types that mean this participant has finished their part.
 *
 * Taken from `AgreementEvent.type`. `ACTION_COMPLETED` is the ordinary one;
 * the rest are the same act performed in a hosted session, offline, or with a
 * digital certificate.
 */
const SIGNING_EVENT_TYPES = new Set([
  'ACTION_COMPLETED',
  'ACTION_COMPLETED_HOSTED',
  'ACTION_COMPLETED_OFFLINE',
  'ACTION_COMPLETED_OFFLINE_HOSTED',
  'SIGNED',
  'DIGSIGNED',
  'PRESIGNED',
  'WRITTEN_SIGNED',
]);

/** Agreement statuses that mean everybody who had to act has acted. */
const TERMINAL_SIGNED = new Set<AgreementStatus>(['SIGNED', 'COMPLETED']);

interface ParticipantHistory {
  signedAt: string | null;
  viewedAt: string | null;
  declined: boolean;
  delegated: boolean;
}

interface AgreementHistory {
  /** Keyed by lower-cased email: Adobe does not promise a casing. */
  byEmail: Map<string, ParticipantHistory>;
  lastSignedAt: string | null;
  declineReason: string | null;
}

export class AdobeSignRestClient implements AdobeSignProvider {
  readonly name = 'adobe-sign';
  readonly isMock = false;

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly limiter: RateLimiter;

  constructor(private readonly config: AdobeSignClientConfig) {
    this.logger = config.logger ?? createLogger({ base: { integration: 'adobe-sign' } });
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 45_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.limiter =
      config.rateLimiter ??
      new RateLimiter({
        requestsPerMinute: config.requestsPerMinute ?? ADOBE_SIGN_DEFAULT_REQUESTS_PER_MINUTE,
      });
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

  private async request<T>(
    path: string,
    init: RequestInit & {
      binary?: boolean;
      /**
       * Called with the successful response before its body is read, for the
       * one thing this client needs from a response that is not in its body:
       * the `ETag` that `PUT /agreements/{id}/state` requires back as
       * `If-Match`.
       */
      onResponse?: (response: Response) => void;
    } = {},
  ): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      // Every attempt spends a token, retries included: a retry is a request as
      // far as the plan's allowance is concerned.
      await this.limiter.acquire();

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

        // A read that found nothing is an answer. A write that 404s is not: it
        // means the operation is not there, and returning null would let a
        // caller read that as success.
        if (response.status === 404 && method === 'GET') return null as T;

        if (!response.ok) {
          const detail = await response.text().catch(() => '');

          if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
            // Adobe's guidance is explicit: on 429, retry only after the
            // interval `Retry-After` names. Backing off on a shorter schedule
            // of our own spends the allowance while the throttle is still in
            // force, and the attempts themselves prolong it.
            const requested = retryAfterMs(response.headers.get('retry-after'));
            await delay(Math.max(requested ?? 0, backoffMs(attempt)));
            continue;
          }

          throw new IntegrationError('Adobe Sign', `HTTP ${response.status} for ${path}`, {
            retryable: RETRYABLE_STATUS.has(response.status),
            context: { status: response.status, detail: detail.slice(0, 500) },
          });
        }

        init.onResponse?.(response);

        if (init.binary) return Buffer.from(await response.arrayBuffer()) as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : null) as T;
      } catch (error) {
        lastError = error;
        if (error instanceof IntegrationError && !error.retryable) throw error;
        if (attempt >= this.maxRetries) break;
        await delay(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    throw new IntegrationError('Adobe Sign', `Request to ${path} failed after ${this.maxRetries} attempts`, {
      retryable: true,
      cause: lastError,
    });
  }

  async createAgreement(request: CreateAgreementRequest): Promise<CreateAgreementResult> {
    if (request.signers.length === 0) {
      throw new ValidationError('An Adobe Sign agreement requires at least one signer.');
    }

    // Refused rather than sent. Adobe's phone verification needs a
    // `phoneInfo` — country code and number — on each participant's security
    // option, and nothing on this request carries a signer's telephone number.
    // Sending `PHONE` without one asks Adobe to verify against a number it
    // does not have, and every signal here would say the letter went out
    // verified.
    if (request.authenticationMethod === 'PHONE') {
      throw new ValidationError(
        'Phone verification cannot be used: Adobe needs each signer\'s telephone number, and engagement participants do not record one. Use email verification or knowledge-based authentication.',
      );
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
    //
    // Each member carries the identity check the request asked for — inside
    // `securityOption`, which is the only place Adobe publishes it.
    // `ParticipantSetMemberInfo` has exactly two properties, `email` and
    // `securityOption`, so the previous attempt at this fix put
    // `authenticationMethod` at the top of the member object where nothing
    // reads it. That is the second time this field has been silently dropped:
    // once by never being sent, once by being sent somewhere Adobe does not
    // look. Both times the code said the check was applied.
    const authentication =
      request.authenticationMethod === 'EMAIL'
        ? undefined // Adobe's own default; sending NONE would disable the check.
        : { securityOption: { authenticationMethod: request.authenticationMethod } };

    if (!request.allowDelegation) {
      // Said out loud on every send rather than assumed. See the note on
      // `allowDelegation` in types.ts: the caller has asked for something this
      // client cannot yet express, and silence would read as compliance.
      this.logger.warn('Delegation was requested off, but this client cannot yet tell Adobe that', {
        idempotencyKey: request.idempotencyKey,
      });
    }

    const orders = [...new Set(request.signers.map((signer) => signer.order))].sort((a, b) => a - b);
    const participantSets = orders.map((order, index) => ({
      order: index + 1,
      role: 'SIGNER',
      // `name` is not on Adobe's published `ParticipantSetMemberInfo`, which
      // has only `email` and `securityOption`. It is sent anyway because an
      // unrecognised key costs nothing and the name improves the invitation if
      // Adobe does read it — but nothing here may assume the signer is
      // addressed by the name this application holds. Adobe addresses people
      // by the name on their own account.
      memberInfos: request.signers
        .filter((signer) => signer.order === order)
        .map((signer) => ({ email: signer.email, name: signer.name, ...authentication })),
    }));

    const created = await this.request<{ id?: string }>('/agreements', {
      method: 'POST',
      // No `x-api-user`. That header names the user to act *as*, in the form
      // `email:someone@firm.ca`, and requires an `:account` scope to use. It
      // was being sent empty, which is not a valid value — and the comment
      // above it described a correlation id it was not sending.
      //
      // Omitted, the agreement is created as the token's own user, which is
      // what this application wants: every agreement it creates belongs to the
      // one identity it authenticates as, so `agreement_read:self` and
      // `agreement_write:self` are sufficient. The idempotency key travels in
      // `externalId` on the body, where `findByExternalId` looks for it.
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
        // Adobe publishes two cadences. `EVERY_THIRD_DAY_UNTIL_SIGNED` was
        // sent here and is not one of them — and three business days is the
        // default, so that was every agreement this application has ever
        // built.
        reminderFrequency: adobeReminderFrequency(request.reminderEveryBusinessDays).value,
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
   *
   * This is the only thing standing between a retried job and a client
   * receiving a second signature request for a letter they have already been
   * sent. It must therefore never answer "no existing agreement" unless it
   * actually looked and found none.
   *
   * It used to fail two different ways, and both ended in a duplicate:
   *
   * 1. `request` returns null on 404, `null?.userAgreementList` is undefined,
   *    and the whole thing became `null` — "nothing found" — for a missing
   *    endpoint, a revoked scope, or a path typo alike. A failed lookup now
   *    throws instead.
   * 2. It then re-filtered the returned list on `externalId`, which Adobe's
   *    `UserAgreement` **does not carry**. That summary object publishes seven
   *    properties and no external id, so the filter never matched anything and
   *    this method returned `null` for every input, forever. The guard the
   *    comment above describes has never once fired.
   *
   * The filter is Adobe's to apply: `externalId` is a published query
   * parameter on `GET /agreements`. But trusting a server-side filter is how
   * the opposite failure gets in — a parameter silently ignored returns the
   * whole account and the first row would be somebody else's agreement, which
   * would suppress a send rather than duplicate one. So the candidate is
   * confirmed against `AgreementInfo.externalId`, which *is* published, before
   * it is believed. One extra read, and only on the rare path where a
   * candidate exists at all.
   */
  async findByExternalId(idempotencyKey: string): Promise<string | null> {
    const response = await this.request<{
      userAgreementList?: { id?: string }[];
    } | null>(`/agreements?externalId=${encodeURIComponent(idempotencyKey)}`);

    if (response === null || response === undefined) {
      throw new IntegrationError(
        'Adobe Sign',
        'The duplicate check could not be completed: the agreement list could not be read.',
        {
          retryable: true,
          context: { reason: 'agreement-list-unavailable' },
        },
      );
    }

    // An absent list is a genuine "none", but only once the request itself has
    // been established as having succeeded.
    const candidates = (response.userAgreementList ?? []).filter(
      (agreement): agreement is { id: string } => typeof agreement.id === 'string' && agreement.id !== '',
    );
    if (candidates.length === 0) return null;

    // A deterministic per-engagement key matches nothing or one thing. A pile
    // of results means Adobe ignored the parameter and handed back the
    // account, and confirming them one at a time would spend the rate
    // allowance to learn that slowly. Refuse, retryably, and say which it was.
    if (candidates.length > MAX_EXTERNAL_ID_CANDIDATES) {
      throw new IntegrationError(
        'Adobe Sign',
        `The duplicate check could not be completed: filtering by external id returned ${candidates.length} agreements, so the filter is not being applied.`,
        { retryable: false, context: { reason: 'external-id-filter-ignored', returned: candidates.length } },
      );
    }

    for (const candidate of candidates) {
      const detail = await this.request<{ externalId?: { id?: string } } | null>(
        `/agreements/${encodeURIComponent(candidate.id)}`,
      );

      if (detail?.externalId?.id === idempotencyKey) return candidate.id;
    }

    // Adobe answered, and nothing it returned actually carries this key. Either
    // the filter was ignored — in which case reporting a match would suppress a
    // send that has to happen — or the agreements were created elsewhere. Both
    // are "no agreement of ours exists", which is the safe answer: the caller
    // creates one, and creating a second is the failure this check exists to
    // prevent only when the first one is genuinely ours.
    this.logger.warn('Adobe returned agreements for an external id that none of them carry', {
      idempotencyKey,
      returned: candidates.length,
    });
    return null;
  }

  async getAgreement(agreementId: string): Promise<AgreementState | null> {
    const agreement = await this.request<Record<string, unknown> | null>(`/agreements/${encodeURIComponent(agreementId)}`);
    if (!agreement) return null;

    const members = await this.request<{ participantSets?: Record<string, unknown>[] } | null>(
      `/agreements/${encodeURIComponent(agreementId)}/members`,
    );

    // Every date this method reports comes from here.
    //
    // `AgreementInfo` publishes `createdDate` and nothing else about timing —
    // no `completedDate` — and `DetailedParticipantInfo` publishes no dates at
    // all. Both were being read anyway, so `completedAt` and every signer's
    // `signedAt` were null on every poll and every webhook, for ever. What that
    // looked like from the outside was the letter's own completion note:
    // "signed by A Client on an unrecorded date".
    const history = await this.agreementHistory(agreementId);

    const signers: AgreementState['signers'] = [];
    for (const set of members?.participantSets ?? []) {
      const status = this.mapSignerStatus(String(set.status ?? ''), agreementId);
      for (const member of (set.memberInfos as Record<string, unknown>[] | undefined) ?? []) {
        const email = String(member.email ?? '');
        const acted = history.byEmail.get(email.toLowerCase());
        signers.push({
          email,
          role: 'AUTHORIZED_SIGNING_OFFICER' as SignerRole,
          // The events outrank the set status: a set still reads
          // WAITING_FOR_OTHERS after one of its members has refused.
          status: acted?.declined
            ? 'DECLINED'
            : acted?.delegated && acted.signedAt === null
              ? 'DELEGATED'
              : status,
          signedAt: acted?.signedAt ?? null,
          viewedAt: acted?.viewedAt ?? null,
        });
      }
    }

    // Adobe has no `DECLINED` agreement status: a refusal cancels the
    // agreement, so a client who declines and a partner who withdraws the
    // letter arrive here identically. The `REJECTED` event is what separates
    // them, and the distinction matters — one of them notifies the engagement
    // team that work has stopped and needs a decision.
    const vendorStatus = this.mapAgreementStatus(String(agreement.status ?? ''), agreementId);
    const status = vendorStatus === 'CANCELLED' && history.declineReason !== null ? 'DECLINED' : vendorStatus;

    return {
      agreementId,
      status,
      signers,
      createdAt: typeof agreement.createdDate === 'string' ? agreement.createdDate : null,
      completedAt: TERMINAL_SIGNED.has(status) ? history.lastSignedAt : null,
      declineReason: history.declineReason,
    };
  }

  /**
   * When each participant acted, and why one of them refused.
   *
   * `GET /agreements/{id}/events` is the only published place any of this
   * lives. It needs no scope beyond the `agreement_read` this client already
   * holds.
   *
   * A failure here degrades to "no dates known" rather than failing the whole
   * read. The status is what drives the workflow — it decides whether the
   * signed PDF is fetched and filed — and losing that because a supplementary
   * endpoint was unavailable would strand a genuinely signed letter. The
   * warning says which agreement, so a persistent failure is visible rather
   * than merely quiet.
   */
  private async agreementHistory(agreementId: string): Promise<AgreementHistory> {
    const empty: AgreementHistory = { byEmail: new Map(), lastSignedAt: null, declineReason: null };

    let response: { events?: Record<string, unknown>[] } | null;
    try {
      response = await this.request<{ events?: Record<string, unknown>[] } | null>(
        `/agreements/${encodeURIComponent(agreementId)}/events`,
      );
    } catch (error) {
      this.logger.warn('Adobe Sign agreement events could not be read; signing dates are unknown', {
        agreementId,
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }

    if (!response?.events) return empty;

    const history: AgreementHistory = { byEmail: new Map(), lastSignedAt: null, declineReason: null };

    for (const event of response.events) {
      const type = String(event.type ?? '');
      const date = typeof event.date === 'string' ? event.date : null;
      const email = String(event.participantEmail ?? '').toLowerCase();
      if (!email) continue;

      const entry = history.byEmail.get(email) ?? {
        signedAt: null,
        viewedAt: null,
        declined: false,
        delegated: false,
      };

      if (SIGNING_EVENT_TYPES.has(type) && date) {
        // Last one wins: a participant who is replaced and signs again acted
        // most recently, and that is the date the letter should carry.
        entry.signedAt = date;
        if (history.lastSignedAt === null || date > history.lastSignedAt) history.lastSignedAt = date;
      }

      // The nearest published signal that the letter reached a human. It is the
      // notification email being opened, not the document, so it is evidence of
      // delivery rather than of reading.
      if (type === 'EMAIL_VIEWED' && date && entry.viewedAt === null) entry.viewedAt = date;

      // This application asks for delegation to be off and cannot yet tell
      // Adobe so (see `allowDelegation`). If it happens anyway, the person who
      // signed an engagement letter is not the person the firm named, and the
      // signing panel has to say so.
      if (type === 'ACTION_DELEGATED' || type === 'ACTION_AUTO_DELEGATED' || type === 'ACTION_REPLACED_SIGNER') {
        entry.delegated = true;
      }

      if (type === 'REJECTED') {
        entry.declined = true;
        const comment = typeof event.comment === 'string' ? event.comment.trim() : '';
        history.declineReason = comment === '' ? 'No reason was given.' : comment;
      }

      history.byEmail.set(email, entry);
    }

    return history;
  }

  private mapAgreementStatus(vendorStatus: string, agreementId: string): AgreementStatus {
    const mapped = STATUS_MAP[vendorStatus];
    if (mapped) return mapped;

    // `CREATED` reads as "not sent yet", which for an unrecognised status is a
    // confident wrong answer. It is still the safest fallback — it keeps the
    // agreement inside the reconciliation poll's query rather than dropping it
    // — but it must not be silent, because the only way a new Adobe status
    // ever gets mapped is somebody seeing this line.
    this.logger.warn('Adobe Sign returned an agreement status this client does not map', {
      agreementId,
      vendorStatus,
    });
    return 'CREATED';
  }

  private mapSignerStatus(vendorStatus: string, agreementId: string): SignerStatus {
    const mapped = SIGNER_STATUS_MAP[vendorStatus];
    if (mapped) return mapped;

    this.logger.warn('Adobe Sign returned a participant status this client does not map', {
      agreementId,
      vendorStatus,
    });
    return 'NOT_YET_NOTIFIED';
  }

  async cancelAgreement(agreementId: string, reason: string): Promise<void> {
    // `If-Match` is published as **required** on this operation, and Adobe
    // answers a request without one with `RESOURCE_MODIFIED`. The ETag comes
    // from a read of the same resource, so the cancel is two calls: fetch the
    // current version, then change it.
    let etag: string | null = null;
    const current = await this.request<Record<string, unknown> | null>(
      `/agreements/${encodeURIComponent(agreementId)}`,
      { onResponse: (response) => void (etag = response.headers.get('etag')) },
    );

    if (!current) {
      throw new IntegrationError('Adobe Sign', `Agreement ${agreementId} could not be read, so it was not cancelled.`, {
        retryable: false,
        context: { reason: 'agreement-not-found' },
      });
    }

    if (etag === null) {
      // `*` is the HTTP-standard "whatever the current version is", which is
      // the right intent here — this is a deliberate cancel, not an optimistic
      // update. Logged because it means the read did not behave as documented.
      this.logger.warn('Adobe Sign returned no ETag for an agreement; cancelling against any version', { agreementId });
    }

    await this.request(`/agreements/${encodeURIComponent(agreementId)}/state`, {
      method: 'PUT',
      headers: { 'If-Match': etag ?? '*' },
      // `notifyOthers`, not `notifySigner`. The latter is not a published
      // property of `AgreementCancellationInfo`, so it was ignored and the
      // recipients were notified or not according to Adobe's default — while
      // this code read as though it had chosen.
      body: JSON.stringify({ state: 'CANCELLED', agreementCancellationInfo: { comment: reason, notifyOthers: false } }),
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

// ---------------------------------------------------------------------------

function backoffMs(attempt: number): number {
  const base = 2 ** attempt * 250;
  return base + Math.floor(Math.random() * 250);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
