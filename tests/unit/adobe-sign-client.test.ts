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

  /**
   * Adobe's `UserAgreement` — the shape of the items in `userAgreementList`.
   *
   * Note what is absent: **no `externalId`**. The published summary object has
   * seven properties and none of them is the external id, which is why the
   * client cannot re-filter on it. Every test in this block builds this shape
   * and not a more helpful one, because a fixture carrying a field the vendor
   * does not send is how the defect below survived having tests at all.
   */
  function listedAgreement(id: string) {
    return { id, name: 'T2 Engagement Letter', status: 'OUT_FOR_SIGNATURE', esign: true, hidden: false };
  }

  it('returns the existing agreement when one was already created', async () => {
    // Two replies: the filtered list, then the confirming read of the detail —
    // which is where `externalId` genuinely is published.
    const { client } = clientWith([
      { status: 200, body: { userAgreementList: [listedAgreement('AGR-1')] } },
      { status: 200, body: { id: 'AGR-1', externalId: { id: KEY } } },
    ]);

    await expect(client.findByExternalId(KEY)).resolves.toBe('AGR-1');
  });

  it('finds it even though the listed agreement carries no external id', async () => {
    // The defect, stated as an assertion. The client used to filter the
    // returned list on `agreement.externalId?.id`, a property Adobe does not
    // put on a listed agreement — so the filter never matched, this method
    // returned null for every input ever passed to it, and the duplicate guard
    // its own comment describes had never once fired. A retried send would
    // have posted a second signature request to the client.
    //
    // Against the old code this test fails: no `externalId` on the listed
    // item means no match means null.
    const { client, calls } = clientWith([
      { status: 200, body: { userAgreementList: [listedAgreement('AGR-1')] } },
      { status: 200, body: { id: 'AGR-1', externalId: { id: KEY } } },
    ]);

    await expect(client.findByExternalId(KEY)).resolves.toBe('AGR-1');
    // The filter is Adobe's to apply, and it is asked for by name.
    expect(calls[0]?.url).toContain(`externalId=${encodeURIComponent(KEY)}`);
  });

  it('returns null when the list came back and genuinely held no match', async () => {
    const { client } = clientWith([{ status: 200, body: { userAgreementList: [] } }]);
    await expect(client.findByExternalId(KEY)).resolves.toBeNull();
  });

  it('refuses to report "none" when it could not read the list at all', async () => {
    // The other half of the same defect. `request` returns null on 404, and
    // `null?.userAgreementList` is undefined, so a missing endpoint, a revoked
    // scope or a path typo all became "no existing agreement" — and the caller
    // then created a duplicate. This is the only thing standing between a
    // retried job and a client receiving a second signature request for a
    // letter already sent to them, so it must fail loudly rather than open.
    const { client } = clientWith([{ status: 404 }]);

    await expect(client.findByExternalId(KEY)).rejects.toThrow(/duplicate check could not be completed/i);
  });

  it('does not believe a match Adobe returned but the agreement does not carry', async () => {
    // Trusting a server-side filter is how the opposite failure gets in: a
    // query parameter that is silently ignored hands back somebody else's
    // agreement, and reporting it as a duplicate would suppress a send that
    // has to happen. The candidate is confirmed against the detail record,
    // where `externalId` really is published.
    const { client } = clientWith([
      { status: 200, body: { userAgreementList: [listedAgreement('AGR-OTHER')] } },
      { status: 200, body: { id: 'AGR-OTHER', externalId: { id: 'someone-else' } } },
    ]);

    await expect(client.findByExternalId(KEY)).resolves.toBeNull();
  });

  it('refuses rather than grinding when the filter is plainly not applied', async () => {
    // A deterministic per-engagement key matches nothing or one thing. A pile
    // of results means Adobe handed back the account, and confirming them one
    // at a time would spend the rate allowance to learn that slowly.
    const { client, calls } = clientWith([
      { status: 200, body: { userAgreementList: Array.from({ length: 40 }, (_, i) => listedAgreement(`AGR-${i}`)) } },
    ]);

    await expect(client.findByExternalId(KEY)).rejects.toThrow(/filter is not being applied/i);
    expect(calls).toHaveLength(1);
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
      { status: 200, body: { userAgreementList: [{ id: 'AGR-2', name: 'Letter', status: 'OUT_FOR_SIGNATURE' }] } },
      { status: 200, body: { id: 'AGR-2', externalId: { id: 'k' } } },
    ]);

    const { result } = await withCapturedDelays(() => client.findByExternalId('k'));

    expect(result).toBe('AGR-2');
    // The 503, the retry that succeeded, and the read that confirms the
    // candidate really carries this key.
    expect(calls).toHaveLength(3);
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

describe('what is sent when creating an agreement', () => {
  /** Captures the request bodies and headers rather than only the URLs. */
  function recordingFetch() {
    const sent: { url: string; headers: Record<string, string>; body: unknown; form?: FormData }[] = [];

    const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/oauth/v2/refresh')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }

      let body: unknown = null;
      if (typeof init?.body === 'string') body = JSON.parse(init.body);
      sent.push({
        url,
        headers,
        body,
        form: init?.body instanceof FormData ? init.body : undefined,
      });

      if (url.endsWith('/transientDocuments')) {
        return new Response(JSON.stringify({ transientDocumentId: 'TD-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'AGR-NEW' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    return { impl, sent };
  }

  const request = {
    pdf: Buffer.from('%PDF-1.4 test'),
    fileName: 'letter.pdf',
    title: 'T2 Engagement Letter',
    message: 'Please sign.',
    locale: 'en_CA',
    ccEmails: [],
    signers: [{ email: 'client@example.test', name: 'A Client', order: 1, role: 'AUTHORIZED_SIGNING_OFFICER' as const }],
    idempotencyKey: 'engagement-1_T2_v1',
    expiresInDays: 30,
    reminderEveryBusinessDays: 3,
    allowDelegation: false,
    authenticationMethod: 'EMAIL' as const,
    engagementType: 'T2' as const,
  };

  it('never sends an x-api-user header', async () => {
    // It was sent, empty. That header names the user to act *as*, in the form
    // `email:someone@firm.ca`, and an empty value is not one — Adobe rejects
    // it. Omitted, the agreement belongs to the token's own user, which is
    // what lets this application work with `:self` scopes.
    const { impl, sent } = recordingFetch();
    const client = new AdobeSignRestClient({
      baseUrl: 'https://api.na1.adobesign.test',
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      fetchImpl: impl,
      rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    });

    await client.createAgreement(request);

    for (const call of sent) {
      expect(Object.keys(call.headers)).not.toContain('x-api-user');
    }
  });

  it('puts the identity check inside securityOption, where Adobe reads it', async () => {
    // The second time this field has been silently dropped. It was declared on
    // the request and never sent at all; then it was sent at the top of the
    // member object — and Adobe's `ParticipantSetMemberInfo` has exactly two
    // properties, `email` and `securityOption`, so nothing read it there
    // either. Both times a firm that configured knowledge-based authentication
    // would have got plain email verification, and both times the code said
    // the check was applied.
    const { impl, sent } = recordingFetch();
    const client = new AdobeSignRestClient({
      baseUrl: 'https://api.na1.adobesign.test',
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      fetchImpl: impl,
      rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    });

    await client.createAgreement({ ...request, authenticationMethod: 'KBA' });

    const creation = sent.find((call) => call.url.endsWith('/agreements'));
    const member = (
      creation?.body as { participantSetsInfo?: { memberInfos?: Record<string, unknown>[] }[] }
    )?.participantSetsInfo?.[0]?.memberInfos?.[0];

    expect(member?.securityOption).toEqual({ authenticationMethod: 'KBA' });
    expect(member).not.toHaveProperty('authenticationMethod');
  });

  it('sends nothing at all for email verification, which is Adobe\'s own default', async () => {
    // `NONE` would disable the check rather than leave it at the default, so
    // "email" has to mean an absent security option, not an explicit one.
    const { impl, sent } = recordingFetch();
    const client = new AdobeSignRestClient({
      baseUrl: 'https://api.na1.adobesign.test',
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      fetchImpl: impl,
      rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    });

    await client.createAgreement(request);

    const creation = sent.find((call) => call.url.endsWith('/agreements'));
    const member = (
      creation?.body as { participantSetsInfo?: { memberInfos?: Record<string, unknown>[] }[] }
    )?.participantSetsInfo?.[0]?.memberInfos?.[0];

    expect(member).not.toHaveProperty('securityOption');
  });

  it('gives each joint taxpayer their own participant set, sharing one order', async () => {
    // Both taxpayers used to be placed in a single participant set. Adobe
    // describes a set's `order` as the position at which a "signing group"
    // signs, and publishes no rule anywhere for whether every member of such a
    // set must sign or any one of them satisfies it.
    //
    // That unstated rule decided whether a joint T1 engagement letter is
    // actually signed by both taxpayers, and neither answer is visible from
    // the outside: the agreement reports COMPLETED and returns a signed PDF
    // under either reading.
    //
    // One member per set means the same thing under both readings, which is
    // why this asserts the shape rather than the outcome. The shared order is
    // what keeps the two invitations simultaneous.
    const { impl, sent } = recordingFetch();
    const client = new AdobeSignRestClient({
      baseUrl: 'https://api.na3.adobesign.com',
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      fetchImpl: impl,
      rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    });

    await client.createAgreement({
      ...request,
      engagementType: 'T1_JOINT',
      signers: [
        { email: 'one@example.test', name: 'Taxpayer One', order: 1, role: 'TAXPAYER_1' as const },
        { email: 'two@example.test', name: 'Taxpayer Two', order: 1, role: 'TAXPAYER_2' as const },
        { email: 'partner@firm.test', name: 'Firm Partner', order: 2, role: 'FIRM_SIGNER' as const },
      ],
    });

    const creation = sent.find((call) => call.url.endsWith('/agreements'));
    const sets = (creation?.body as { participantSetsInfo?: { order: number; memberInfos: { email: string }[] }[] })
      ?.participantSetsInfo;

    expect(sets).toHaveLength(3);
    // Never more than one member in a set — that is the whole point.
    for (const set of sets ?? []) expect(set.memberInfos).toHaveLength(1);

    expect(sets?.map((set) => ({ order: set.order, email: set.memberInfos[0]?.email }))).toEqual([
      { order: 1, email: 'one@example.test' },
      { order: 1, email: 'two@example.test' },
      { order: 2, email: 'partner@firm.test' },
    ]);
  });

  it('renumbers signing orders to the consecutive sequence Adobe requires', async () => {
    // Adobe rejects a signing order that is not a consecutive increasing
    // sequence, and the orders this application holds are not obliged to be
    // one. Renumbering applies to the distinct values, so signers who shared
    // an order still share one afterwards.
    const { impl, sent } = recordingFetch();
    const client = new AdobeSignRestClient({
      baseUrl: 'https://api.na3.adobesign.com',
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      fetchImpl: impl,
      rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    });

    await client.createAgreement({
      ...request,
      signers: [
        { email: 'a@example.test', name: 'A', order: 5, role: 'AUTHORIZED_SIGNING_OFFICER' as const },
        { email: 'b@example.test', name: 'B', order: 5, role: 'AUTHORIZED_SIGNING_OFFICER' as const },
        { email: 'c@example.test', name: 'C', order: 9, role: 'FIRM_SIGNER' as const },
      ],
    });

    const creation = sent.find((call) => call.url.endsWith('/agreements'));
    const sets = (creation?.body as { participantSetsInfo?: { order: number }[] })?.participantSetsInfo;

    expect(sets?.map((set) => set.order)).toEqual([1, 1, 2]);
  });

  it('refuses phone verification rather than asking Adobe to check a number it has not got', async () => {
    // Adobe's `ParticipantSecurityOption` needs a `phoneInfo` — country code
    // and number — and nothing on an engagement participant carries a
    // telephone number. Sending `PHONE` without one is the failure this
    // project has already hit twice: accepted, not applied, and every signal
    // saying the letter went out verified.
    const { impl, sent } = recordingFetch();
    const client = new AdobeSignRestClient({
      baseUrl: 'https://api.na1.adobesign.test',
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      fetchImpl: impl,
      rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    });

    await expect(client.createAgreement({ ...request, authenticationMethod: 'PHONE' })).rejects.toThrow(
      /telephone number/i,
    );
    // Refused before anything was uploaded, so no orphaned transient document.
    expect(sent).toHaveLength(0);
  });

  it('asks for a reminder cadence Adobe publishes', async () => {
    // `EVERY_THIRD_DAY_UNTIL_SIGNED` is not one of the two values
    // `AgreementInfo.reminderFrequency` permits, and three business days is
    // the default — so that unpublished value was on every agreement this
    // application has ever built.
    const { impl, sent } = recordingFetch();
    const client = new AdobeSignRestClient({
      baseUrl: 'https://api.na1.adobesign.test',
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      fetchImpl: impl,
      rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    });

    await client.createAgreement(request);

    const creation = sent.find((call) => call.url.endsWith('/agreements'));
    expect((creation?.body as { reminderFrequency?: string })?.reminderFrequency).toBe('WEEKLY_UNTIL_SIGNED');
  });

  it('uploads the file under the field name Adobe publishes', async () => {
    // `File`, capitalised, is the required part of the multipart request. The
    // response field is `transientDocumentId`.
    const { impl, sent } = recordingFetch();
    const client = new AdobeSignRestClient({
      baseUrl: 'https://api.na1.adobesign.test',
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      fetchImpl: impl,
      rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    });

    await client.createAgreement(request);

    const upload = sent.find((call) => call.url.endsWith('/transientDocuments'));
    expect(upload?.form?.has('File')).toBe(true);
    // Adobe infers the mime type from the file part, and JSON would be wrong
    // for a multipart body.
    expect(upload?.headers['content-type']).toBeUndefined();
  });

  it('carries the idempotency key in externalId, where the duplicate check looks', async () => {
    // The comment on the removed header claimed the key was being sent as a
    // correlation id. It was not being sent at all by that route; it travels
    // in the body, and `findByExternalId` reads it back from there.
    const { impl, sent } = recordingFetch();
    const client = new AdobeSignRestClient({
      baseUrl: 'https://api.na1.adobesign.test',
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      fetchImpl: impl,
      rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    });

    await client.createAgreement(request);

    const creation = sent.find((call) => call.url.endsWith('/agreements'));
    expect((creation?.body as { externalId?: { id?: string } })?.externalId?.id).toBe('engagement-1_T2_v1');
  });
});

/**
 * Reading an agreement's state back.
 *
 * The fixtures here carry only properties Adobe publishes. That is the whole
 * point of them: the previous implementation read `completedDate` off both the
 * agreement and each participant, and neither object has ever had one, so
 * every date this client reported was null — silently, on every poll and every
 * webhook, since the day it was written.
 */
describe('reading an agreement', () => {
  /** Answers each path from a map rather than in call order. */
  function clientForPaths(paths: Record<string, Reply>) {
    const requested: string[] = [];

    const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/oauth/v2/refresh')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const path = url.replace('https://api.na1.adobesign.test/api/rest/v6', '');
      requested.push(`${init?.method ?? 'GET'} ${path}`);

      const reply = paths[path] ?? { status: 404 };
      return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
      });
    }) as typeof fetch;

    const client = new AdobeSignRestClient({
      baseUrl: 'https://api.na1.adobesign.test',
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      fetchImpl: impl,
      rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    });

    return { client, requested };
  }

  const AGR = 'CBJC-agreement';

  /** `AgreementInfo` as published: note the absence of any completion date. */
  const agreementInfo = (status: string) => ({
    id: AGR,
    name: 'T2 Engagement Letter',
    status,
    createdDate: '2026-01-05T09:00:00Z',
    externalId: { id: 'engagement-1_T2_v1' },
  });

  /** `MembersInfo`: the meaningful status is on the set, not the participant. */
  const members = (setStatus: string, emails: string[]) => ({
    participantSets: [
      {
        id: 'set-1',
        order: 1,
        role: 'SIGNER',
        status: setStatus,
        // `DetailedParticipantInfo` publishes REPLACED/ACTIVE and no dates.
        memberInfos: emails.map((email, index) => ({ id: `p-${index}`, email, status: 'ACTIVE' })),
      },
    ],
  });

  it('takes each signing date from the event list, because the agreement has none', async () => {
    const { client, requested } = clientForPaths({
      [`/agreements/${AGR}`]: { status: 200, body: agreementInfo('SIGNED') },
      [`/agreements/${AGR}/members`]: {
        status: 200,
        body: members('COMPLETED', ['first@example.test', 'second@example.test']),
      },
      [`/agreements/${AGR}/events`]: {
        status: 200,
        body: {
          events: [
            { type: 'CREATED', date: '2026-01-05T09:00:00Z', participantEmail: 'firm@example.test' },
            { type: 'EMAIL_VIEWED', date: '2026-01-05T10:00:00Z', participantEmail: 'first@example.test' },
            { type: 'ACTION_COMPLETED', date: '2026-01-06T11:30:00Z', participantEmail: 'first@example.test' },
            { type: 'ACTION_COMPLETED', date: '2026-01-07T14:15:00Z', participantEmail: 'second@example.test' },
          ],
        },
      },
    });

    const state = await client.getAgreement(AGR);

    expect(state?.status).toBe('SIGNED');
    expect(state?.signers.map((signer) => signer.signedAt)).toEqual([
      '2026-01-06T11:30:00Z',
      '2026-01-07T14:15:00Z',
    ]);
    // The letter's completion note reads "signed by … on …" off these. Without
    // the event list every one of them said "on an unrecorded date".
    expect(state?.completedAt).toBe('2026-01-07T14:15:00Z');
    expect(state?.signers[0]?.viewedAt).toBe('2026-01-05T10:00:00Z');
    expect(requested).toContain(`GET /agreements/${AGR}/events`);
  });

  it('tells a client who refused apart from a partner who withdrew the letter', async () => {
    // Adobe has no DECLINED status. A refusal cancels the agreement, so both
    // arrive as CANCELLED and only the REJECTED event separates them. The
    // difference decides whether the engagement team is told that work has
    // stopped and needs a decision.
    const { client } = clientForPaths({
      [`/agreements/${AGR}`]: { status: 200, body: agreementInfo('CANCELLED') },
      [`/agreements/${AGR}/members`]: { status: 200, body: members('CANCELLED', ['first@example.test']) },
      [`/agreements/${AGR}/events`]: {
        status: 200,
        body: {
          events: [
            {
              type: 'REJECTED',
              date: '2026-01-06T08:00:00Z',
              participantEmail: 'first@example.test',
              comment: 'The fee quoted is not what we agreed.',
            },
          ],
        },
      },
    });

    const state = await client.getAgreement(AGR);

    expect(state?.status).toBe('DECLINED');
    expect(state?.declineReason).toBe('The fee quoted is not what we agreed.');
    expect(state?.signers[0]?.status).toBe('DECLINED');
    expect(state?.completedAt).toBeNull();
  });

  it('reports a cancelled agreement as cancelled when nobody refused it', async () => {
    const { client } = clientForPaths({
      [`/agreements/${AGR}`]: { status: 200, body: agreementInfo('CANCELLED') },
      [`/agreements/${AGR}/members`]: { status: 200, body: members('CANCELLED', ['first@example.test']) },
      [`/agreements/${AGR}/events`]: { status: 200, body: { events: [] } },
    });

    const state = await client.getAgreement(AGR);

    expect(state?.status).toBe('CANCELLED');
    expect(state?.declineReason).toBeNull();
    // Not "never notified": a cancelled participant and one who was never
    // emailed must not look the same in the signing panel.
    expect(state?.signers[0]?.status).toBe('DECLINED');
  });

  it('does not report a letter sitting in a client inbox as though it were never sent', async () => {
    // `OUT_FOR_DELIVERY` is published and was not mapped, and an unmapped
    // status fell through to CREATED — the one answer that means "nothing has
    // happened yet" about a letter the client is looking at.
    const { client } = clientForPaths({
      [`/agreements/${AGR}`]: { status: 200, body: agreementInfo('OUT_FOR_DELIVERY') },
      [`/agreements/${AGR}/members`]: { status: 200, body: members('WAITING_FOR_MY_SIGNATURE', ['first@example.test']) },
      [`/agreements/${AGR}/events`]: { status: 200, body: { events: [] } },
    });

    expect((await client.getAgreement(AGR))?.status).toBe('OUT_FOR_SIGNATURE');
  });

  it('still reports the status when the event list cannot be read', async () => {
    // The status is what decides whether a signed letter is fetched and filed.
    // Losing that because a supplementary endpoint was unavailable would
    // strand a genuinely signed engagement letter, so the dates degrade and
    // the status does not.
    const { client } = clientForPaths({
      [`/agreements/${AGR}`]: { status: 200, body: agreementInfo('SIGNED') },
      [`/agreements/${AGR}/members`]: { status: 200, body: members('COMPLETED', ['first@example.test']) },
      [`/agreements/${AGR}/events`]: { status: 403, body: { code: 'PERMISSION_DENIED' } },
    });

    const state = await client.getAgreement(AGR);

    expect(state?.status).toBe('SIGNED');
    expect(state?.completedAt).toBeNull();
  });
});

describe('cancelling an agreement', () => {
  it('sends the ETag Adobe requires, and the field name it publishes', async () => {
    // `If-Match` is published as required on PUT /agreements/{id}/state, and
    // the client sent none — so every cancellation was refused. The
    // cancellation field is `notifyOthers`; `notifySigner` was being sent,
    // which is not published, so recipients were notified or not by Adobe's
    // default while this code read as though it had chosen.
    const sent: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];

    const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/oauth/v2/refresh')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
      sent.push({
        url,
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });

      if (url.endsWith('/state')) return new Response('', { status: 200 });
      return new Response(JSON.stringify({ id: 'AGR-1', status: 'OUT_FOR_SIGNATURE' }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"v3"' },
      });
    }) as typeof fetch;

    const client = new AdobeSignRestClient({
      baseUrl: 'https://api.na1.adobesign.test',
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      fetchImpl: impl,
      rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    });

    await client.cancelAgreement('AGR-1', 'Superseded by a corrected letter.');

    const put = sent.find((call) => call.method === 'PUT');
    expect(put?.headers['if-match']).toBe('"v3"');
    expect(put?.body).toEqual({
      state: 'CANCELLED',
      agreementCancellationInfo: { comment: 'Superseded by a corrected letter.', notifyOthers: false },
    });
  });

  it('does not cancel an agreement it could not read', async () => {
    const { client, calls } = clientWith([{ status: 404 }]);

    await expect(client.cancelAgreement('AGR-GONE', 'reason')).rejects.toThrow(/could not be read/i);
    // No PUT went out against an agreement whose current state is unknown.
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });
});

describe('a signer who did not sign it themselves', () => {
  it('says so, because this application asked for delegation to be off', async () => {
    // `allowDelegation: false` is what every send asks for, and the client
    // cannot yet express it to Adobe — it logs a warning and sends nothing. So
    // if a named signer hands an engagement letter to somebody else, the only
    // place it shows is the event list. The participant set still reads
    // WAITING_FOR_OTHERS, which is why the events have to outrank it.
    const impl = (async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes('/oauth/v2/refresh')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const body = url.endsWith('/events')
        ? { events: [{ type: 'ACTION_DELEGATED', date: '2026-01-06T09:00:00Z', participantEmail: 'first@example.test' }] }
        : url.endsWith('/members')
          ? {
              participantSets: [
                {
                  id: 'set-1',
                  order: 1,
                  role: 'SIGNER',
                  status: 'WAITING_FOR_OTHERS',
                  memberInfos: [{ id: 'p-0', email: 'first@example.test', status: 'ACTIVE' }],
                },
              ],
            }
          : { id: 'AGR-1', status: 'OUT_FOR_SIGNATURE', createdDate: '2026-01-05T09:00:00Z' };

      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const client = new AdobeSignRestClient({
      baseUrl: 'https://api.na1.adobesign.test',
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      fetchImpl: impl,
      rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    });

    expect((await client.getAgreement('AGR-1'))?.signers[0]?.status).toBe('DELEGATED');
  });
});
