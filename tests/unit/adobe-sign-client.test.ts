import { describe, expect, it } from 'vitest';
import { AdobeSignRestClient, RateLimiter } from '@element/integrations';

/**
 * How the Acrobat Sign client behaves against a tenant that pushes back.
 *
 * The mock adapter always succeeds, so none of this is reachable through it.
 * These are the behaviours that only appear against a real account: a throttle
 * that says how long to wait, a transient failure, and — the one that matters
 * most — a duplicate check that cannot complete.
 *
 * Adobe's guidance is explicit that a 429 should be retried only after the
 * interval named in `Retry-After`. The rate itself depends on the service plan
 * and is not published as a number.
 */

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A fetch that answers the OAuth refresh automatically and everything else
 * from a script, so a test says only what it is actually about.
 */
function scriptedFetch(replies: Reply[]) {
  const calls: { url: string; method: string }[] = [];

  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.includes('/oauth/v2/refresh')) {
      return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    calls.push({ url, method });
    const reply = replies.shift() ?? { status: 200, body: {} };

    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  }) as typeof fetch;

  return { impl, calls };
}

function clientWith(replies: Reply[]) {
  const { impl, calls } = scriptedFetch(replies);
  const client = new AdobeSignRestClient({
    baseUrl: 'https://api.na1.adobesign.test',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    fetchImpl: impl,
    // The limiter has its own tests; this one never makes a test wait.
    rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
  });
  return { client, calls };
}

/** Captures the delays the client asks for without actually waiting them out. */
async function withCapturedDelays<T>(run: () => Promise<T>): Promise<{ result: T; waits: number[] }> {
  const waits: number[] = [];
  const original = globalThis.setTimeout;

  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    if (typeof ms === 'number' && ms > 0) waits.push(ms);
    return original(handler, 0);
  }) as typeof globalThis.setTimeout;

  try {
    return { result: await run(), waits };
  } finally {
    globalThis.setTimeout = original;
  }
}

describe('the duplicate check before creating an agreement', () => {
  const KEY = 'engagement-1_T2_v1';

  it('returns the existing agreement when one was already created', async () => {
    const { client } = clientWith([
      { status: 200, body: { userAgreementList: [{ id: 'AGR-1', externalId: { id: KEY } }] } },
    ]);

    await expect(client.findByExternalId(KEY)).resolves.toBe('AGR-1');
  });

  it('returns null when the list came back and genuinely held no match', async () => {
    const { client } = clientWith([{ status: 200, body: { userAgreementList: [] } }]);
    await expect(client.findByExternalId(KEY)).resolves.toBeNull();
  });

  it('refuses to report "none" when it could not read the list at all', async () => {
    // The defect this covers. `request` returns null on 404, and
    // `null?.userAgreementList` is undefined, so a missing endpoint, a revoked
    // scope or a path typo all became "no existing agreement" — and the caller
    // then created a duplicate. This is the only thing standing between a
    // retried job and a client receiving a second signature request for a
    // letter already sent to them, so it must fail loudly rather than open.
    const { client } = clientWith([{ status: 404 }]);

    await expect(client.findByExternalId(KEY)).rejects.toThrow(/duplicate check could not be completed/i);
  });

  it('does not mistake an agreement carrying a different key for a match', async () => {
    const { client } = clientWith([
      { status: 200, body: { userAgreementList: [{ id: 'AGR-OTHER', externalId: { id: 'someone-else' } }] } },
    ]);

    await expect(client.findByExternalId(KEY)).resolves.toBeNull();
  });
});

describe('being throttled', () => {
  it('waits at least as long as Adobe asked before retrying', async () => {
    const { client, calls } = clientWith([
      { status: 429, headers: { 'retry-after': '5' } },
      { status: 200, body: { userAgreementList: [] } },
    ]);

    const { waits } = await withCapturedDelays(() => client.findByExternalId('k'));

    expect(calls).toHaveLength(2);
    // Five seconds requested; the client's own backoff for attempt 1 is far
    // shorter, so the vendor's number has to win.
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(5_000);
  });

  it('retries a transient failure rather than failing the whole sync', async () => {
    // SYNC_ADOBE_STATUS walks every outstanding agreement in one job. Without a
    // retry, a single 503 partway through abandoned the rest of them.
    const { client, calls } = clientWith([
      { status: 503 },
      { status: 200, body: { userAgreementList: [{ id: 'AGR-2', externalId: { id: 'k' } }] } },
    ]);

    const { result } = await withCapturedDelays(() => client.findByExternalId('k'));

    expect(result).toBe('AGR-2');
    expect(calls).toHaveLength(2);
  });

  it('gives up rather than retrying something that will never succeed', async () => {
    const { client, calls } = clientWith([{ status: 400, body: { message: 'INVALID_REQUEST' } }]);

    await expect(client.findByExternalId('k')).rejects.toThrow(/HTTP 400/);
    expect(calls).toHaveLength(1);
  });
});

describe('a write that is not there', () => {
  it('fails rather than reporting success, because a 404 on a POST is not "nothing"', async () => {
    // Same shape as the Karbon defect: 404 became null for every method, and a
    // caller reading null as an empty result treats a missing operation as a
    // completed one.
    const { client } = clientWith([{ status: 404 }, { status: 404 }, { status: 404 }]);

    await expect(
      client.createAgreement({
        pdf: Buffer.from('%PDF-1.4 test'),
        fileName: 'letter.pdf',
        title: 'T2 Engagement Letter',
        message: 'Please sign.',
        locale: 'en_CA',
        ccEmails: [],
        signers: [{ email: 'client@example.test', name: 'A Client', order: 1, role: 'AUTHORIZED_SIGNING_OFFICER' }],
        idempotencyKey: 'k',
        expiresInDays: 30,
        reminderEveryBusinessDays: 3,
        allowDelegation: false,
        authenticationMethod: 'EMAIL',
        engagementType: 'T2',
      }),
    ).rejects.toThrow();
  });
});
