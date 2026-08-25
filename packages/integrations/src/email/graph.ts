import { IntegrationError, createLogger, type Logger } from '@element/shared';
import { RateLimiter, retryAfterMs } from '../http/throttle.js';
import type { EmailSendResult, EmailSender, OutgoingEmail } from './types.js';

/**
 * Sending staff mail through Microsoft 365, using the firm's own tenant.
 *
 * No new vendor. The firm already has Microsoft 365 and this application
 * already has an Entra ID app registration for sign-in, so mail goes out
 * through the same directory rather than a third party with its own contract,
 * its own outage and its own copy of who works here.
 *
 * This uses the **client credentials** flow, not the delegated sign-in flow the
 * rest of the application uses. Notifications are raised by a background worker
 * where nobody is signed in, so there is no user to act on behalf of. That
 * distinction has a sharp edge, documented in docs/notifications.md and worth
 * repeating here:
 *
 *   The `Mail.Send` **application** permission lets this app send as *any*
 *   mailbox in the tenant. That is far more than sending firm notices needs.
 *   An administrator should restrict it to a single mailbox with an Exchange
 *   application access policy. This client always sends from one configured
 *   address, so the policy costs nothing and removes the over-grant.
 */

export interface GraphMailerConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** The single mailbox this application sends from. */
  sender: string;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  rateLimiter?: RateLimiter;
  /** Overridable so a test never talks to Microsoft. */
  graphBaseUrl?: string;
  loginBaseUrl?: string;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Microsoft's guidance is to back off on 429; the rate itself is not published. */
const DEFAULT_REQUESTS_PER_MINUTE = 30;

export class MicrosoftGraphMailer implements EmailSender {
  readonly name = 'microsoft-365';
  readonly isMock = false;
  readonly isBlocked = false;

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly limiter: RateLimiter;
  private readonly graphBaseUrl: string;
  private readonly loginBaseUrl: string;

  constructor(private readonly config: GraphMailerConfig) {
    this.logger = config.logger ?? createLogger({ base: { integration: 'microsoft-graph-mail' } });
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 20_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.limiter =
      config.rateLimiter ?? new RateLimiter({ requestsPerMinute: DEFAULT_REQUESTS_PER_MINUTE });
    this.graphBaseUrl = (config.graphBaseUrl ?? 'https://graph.microsoft.com').replace(/\/+$/, '');
    this.loginBaseUrl = (config.loginBaseUrl ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');
  }

  /**
   * An application token for the whole tenant.
   *
   * Cached until a minute before it expires, because a token request is itself
   * rate-limited and a rollout can raise a great many notices at once.
   */
  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken;

    const response = await this.fetchImpl(
      `${this.loginBaseUrl}/${encodeURIComponent(this.config.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          grant_type: 'client_credentials',
          scope: `${this.graphBaseUrl}/.default`,
        }),
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new IntegrationError('Microsoft 365', `Token request failed with HTTP ${response.status}`, {
        retryable: RETRYABLE_STATUS.has(response.status),
        // Truncated, and the secret is never in a response body anyway.
        context: { status: response.status, detail: detail.slice(0, 300) },
      });
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new IntegrationError('Microsoft 365', 'The token response carried no access token');
    }

    this.accessToken = payload.access_token;
    this.accessTokenExpiresAt = Date.now() + (payload.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  async send(email: OutgoingEmail): Promise<EmailSendResult> {
    const path = `/v1.0/users/${encodeURIComponent(this.config.sender)}/sendMail`;

    const body = JSON.stringify({
      message: {
        subject: email.subject,
        body: { contentType: 'Text', content: email.body },
        toRecipients: [{ emailAddress: { address: email.to } }],
      },
      // Not kept in the sender's Sent Items. These are machine notices, and a
      // shared mailbox filling with thousands of them helps nobody.
      saveToSentItems: false,
    });

    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      await this.limiter.acquire();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const token = await this.token();
        const response = await this.fetchImpl(`${this.graphBaseUrl}${path}`, {
          method: 'POST',
          signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body,
        });

        // Graph answers 202 Accepted; it has taken the message, not delivered it.
        if (response.status === 202 || response.ok) return { ok: true };

        const detail = await response.text().catch(() => '');

        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
          const requested = retryAfterMs(response.headers.get('retry-after'));
          await delay(Math.max(requested ?? 0, backoffMs(attempt)));
          continue;
        }

        // A refusal is reported, not thrown: the caller records it against the
        // notification so an operator can read what Microsoft actually said.
        return { ok: false, detail: `HTTP ${response.status}: ${detail.slice(0, 300)}` };
      } catch (error) {
        lastError = error;
        if (error instanceof IntegrationError && !error.retryable) {
          return { ok: false, detail: error.message };
        }
        if (attempt >= this.maxRetries) break;
        await delay(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }

    return {
      ok: false,
      detail: lastError instanceof Error ? lastError.message : `Gave up after ${this.maxRetries} attempts`,
    };
  }

  /**
   * Proves the credentials and that the mailbox exists — and **not** that this
   * application may send from it.
   *
   * The distinction is the whole point of this comment, because the code used
   * to claim otherwise. This reads `GET /users/{sender}`, which requires
   * **`User.Read.All`** (or `Directory.Read.All`). That is a *different*
   * application permission from `Mail.Send`, and Microsoft publishes no
   * endpoint that proves `Mail.Send` without actually sending a message.
   *
   * Two things followed from pretending it did, and they point opposite ways:
   *
   *   - A tenant holding `User.Read.All` and no `Mail.Send` passed, the
   *     Integrations screen reported mail as working, and the first real
   *     notification failed.
   *   - An administrator who did exactly what docs/notifications.md advises —
   *     grant `Mail.Send` alone, scoped by an application access policy — got a
   *     403 here and was told *"The Mail.Send application permission is
   *     missing"*. That sends them to re-grant a permission that is already
   *     correct, while the real cause is `User.Read.All`, which nothing ever
   *     told them to add.
   *
   * So this now reports what it observed. `Mail.Send` stays unproven until a
   * notification actually goes out, and the check says so rather than implying
   * a guarantee it cannot give.
   */
  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const token = await this.token();
      const response = await this.fetchImpl(
        `${this.graphBaseUrl}/v1.0/users/${encodeURIComponent(this.config.sender)}?$select=mail,userPrincipalName`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (response.ok) {
        return {
          ok: true,
          detail: `The credentials work and the mailbox ${this.config.sender} exists. Sending is not proven until the first notification goes out — Microsoft publishes no way to test Mail.Send without sending.`,
        };
      }

      const detail = await response.text().catch(() => '');
      if (response.status === 404) {
        return { ok: false, detail: `No mailbox named ${this.config.sender} exists in this tenant.` };
      }
      if (response.status === 403) {
        // Ordered by which is actually likelier. `User.Read.All` is the one
        // this request needs and the one the setup instructions omitted for a
        // long time, so it is named first; `Mail.Send` is not required to
        // answer this call at all and cannot be the cause of a refusal of it.
        return {
          ok: false,
          detail:
            'Microsoft refused this read. It needs the User.Read.All application permission, which is separate from Mail.Send and easy to miss — check that it is granted and admin-consented. Failing that, an application access policy may exclude this mailbox. Mail.Send is not what answers this call, so it is not the cause.',
        };
      }
      return { ok: false, detail: `HTTP ${response.status}: ${detail.slice(0, 300)}` };
    } catch (error) {
      this.logger.error('Microsoft 365 health check failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

function backoffMs(attempt: number): number {
  return 2 ** attempt * 250 + Math.floor(Math.random() * 250);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
