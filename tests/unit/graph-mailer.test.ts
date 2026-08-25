import { describe, expect, it } from 'vitest';
import { MicrosoftGraphMailer, RateLimiter } from '@element/integrations';
import { loadEnv } from '@element/shared';

/**
 * Sending staff mail through the firm's own Microsoft 365 tenant.
 *
 * Client credentials, not the delegated sign-in flow: notices are raised by a
 * background worker where nobody is signed in, so there is no user to act on
 * behalf of.
 */

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function scriptedFetch(replies: Reply[]) {
  const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];

  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/oauth2/v2.0/token')) {
      calls.push({ url, method: 'POST', body: String(init?.body ?? ''), headers: {} });
      return new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }

    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      headers,
    });

    const reply = replies.shift() ?? { status: 202 };
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  }) as typeof fetch;

  return { impl, calls };
}

function mailerWith(replies: Reply[]) {
  const { impl, calls } = scriptedFetch(replies);
  const mailer = new MicrosoftGraphMailer({
    tenantId: '6cb41f97-d366-4050-8563-b9f5a8256180',
    clientId: '6723d301-9353-4718-ae5e-52b24f3560eb',
    clientSecret: 'a-secret',
    sender: 'engagements@firm.test',
    fetchImpl: impl,
    rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    graphBaseUrl: 'https://graph.microsoft.test',
    loginBaseUrl: 'https://login.microsoftonline.test',
  });
  return { mailer, calls };
}

const message = { to: 'partner@firm.test', subject: 'Engagement letter signed', body: 'The client has signed.' };

describe('sending through Graph', () => {
  it('treats 202 Accepted as sent, which is what Graph answers', async () => {
    const { mailer, calls } = mailerWith([{ status: 202 }]);

    await expect(mailer.send(message)).resolves.toMatchObject({ ok: true });

    const send = calls.find((call) => call.url.includes('/sendMail'));
    expect(send?.url).toContain('/v1.0/users/engagements%40firm.test/sendMail');
    expect(send?.method).toBe('POST');
  });

  it('sends from the one configured mailbox, never from the recipient', async () => {
    // The Mail.Send application permission can send as anybody in the tenant.
    // This client only ever uses the configured address, which is what makes
    // an Exchange application access policy restricting it to that mailbox
    // free of cost.
    const { mailer, calls } = mailerWith([{ status: 202 }]);
    await mailer.send(message);

    const send = calls.find((call) => call.url.includes('/sendMail'));
    expect(send?.url).toContain('engagements%40firm.test');
    expect(send?.url).not.toContain('partner');
  });

  it('asks for an application token, not a user one', async () => {
    const { mailer, calls } = mailerWith([{ status: 202 }]);
    await mailer.send(message);

    const token = calls.find((call) => call.url.includes('/oauth2/v2.0/token'));
    expect(String(token?.body)).toContain('grant_type=client_credentials');
    expect(String(token?.body)).toContain('.default');
  });

  it('reuses the token rather than fetching one per message', async () => {
    // A rollout raises a great many notices at once, and the token endpoint is
    // itself rate-limited.
    const { mailer, calls } = mailerWith([{ status: 202 }, { status: 202 }]);

    await mailer.send(message);
    await mailer.send(message);

    expect(calls.filter((call) => call.url.includes('/oauth2/v2.0/token'))).toHaveLength(1);
  });

  it('does not keep machine notices in the sender’s Sent Items', async () => {
    const { mailer, calls } = mailerWith([{ status: 202 }]);
    await mailer.send(message);

    const send = calls.find((call) => call.url.includes('/sendMail'));
    expect((send?.body as { saveToSentItems?: boolean })?.saveToSentItems).toBe(false);
  });

  it('reports a refusal rather than throwing, so it can be recorded', async () => {
    const { mailer } = mailerWith([{ status: 403, body: { error: { message: 'insufficient privileges' } } }]);

    const result = await mailer.send(message);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('403');
  });
});

/**
 * What the health check may and may not claim.
 *
 * It reads `GET /users/{sender}`, which needs `User.Read.All` — a different
 * application permission from `Mail.Send`, and one the setup instructions did
 * not mention for a long time. Microsoft publishes no way to prove `Mail.Send`
 * short of sending a message, so the check's job is to report what it saw
 * rather than what one would like that to imply.
 */
describe('the health check', () => {
  it('blames the permission the read actually needs, not the one it does not', async () => {
    // The defect, as an assertion. An administrator who granted Mail.Send
    // alone — which is exactly what docs/notifications.md advises — gets this
    // 403, and used to be told "The Mail.Send application permission is
    // missing". That sends them to re-grant a permission that is already
    // correct. Mail.Send is not what answers this call and cannot be why it
    // was refused.
    const { mailer } = mailerWith([{ status: 403 }]);

    const result = await mailer.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/User\.Read\.All/);
    // Named, but only to rule it out.
    expect(result.detail).toMatch(/not the cause/i);
    expect(result.detail).toMatch(/policy/i);
  });

  it('explains a 404 as the mailbox not existing', async () => {
    const { mailer } = mailerWith([{ status: 404 }]);

    const result = await mailer.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no mailbox named/i);
  });

  it('passes, and says plainly that sending is still unproven', async () => {
    // A pass here used to read as "mail works". It does not: a tenant with
    // User.Read.All and no Mail.Send passes this and fails the first real
    // notification. Whoever reads the Integrations screen has to be told which
    // of the two they are looking at.
    const { mailer } = mailerWith([{ status: 200, body: { mail: 'engagements@firm.test' } }]);

    const result = await mailer.healthCheck();
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/not proven|unproven/i);
    expect(result.detail).toMatch(/Mail\.Send/);
  });
});

describe('what the environment refuses', () => {
  const MINIMUM = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://user:pass@host:5432/db',
    ENCRYPTION_KEY: '0'.repeat(64),
    SESSION_SECRET: '0'.repeat(64),
  } satisfies NodeJS.ProcessEnv;

  it('refuses mail with no sender mailbox, because there is no safe default', () => {
    expect(() =>
      loadEnv({
        ...MINIMUM,
        NOTIFICATION_EMAIL_ENABLED: 'true',
        ENTRA_TENANT_ID: '6cb41f97-d366-4050-8563-b9f5a8256180',
        ENTRA_CLIENT_ID: '6723d301-9353-4718-ae5e-52b24f3560eb',
        ENTRA_CLIENT_SECRET: 'secret',
      }),
    ).toThrow(/no sender mailbox/i);
  });

  it('refuses mail without the Entra registration it sends through', () => {
    expect(() =>
      loadEnv({ ...MINIMUM, NOTIFICATION_EMAIL_ENABLED: 'true', NOTIFICATION_EMAIL_SENDER: 'a@firm.test' }),
    ).toThrow(/ENTRA_TENANT_ID/);
  });

  it('is off by default, so no deployment starts mailing by surprise', () => {
    expect(loadEnv({ ...MINIMUM }).NOTIFICATION_EMAIL_ENABLED).toBe(false);
  });
});
