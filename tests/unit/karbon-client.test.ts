import { describe, expect, it } from 'vitest';
import { KarbonRestClient, RateLimiter, retryAfterMs } from '@element/integrations';

/**
 * How the Karbon client behaves against a tenant that pushes back.
 *
 * None of this is exercised by the mock adapter, which always succeeds. These
 * are the behaviours that only appear against a real account: a documented rate
 * limit, a throttle response that says how long to wait, and an operation the
 * tenant does not have.
 *
 * Karbon documents no more than 120 requests a minute per account per
 * application, and answers 429 with `Retry-After`.
 */

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fetch that answers from a script and records what it was asked. */
function scriptedFetch(replies: Reply[]) {
  const calls: { url: string; method: string }[] = [];

  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    const reply = replies.shift() ?? { status: 200, body: {} };

    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  }) as typeof fetch;

  return { impl, calls };
}

function clientWith(replies: Reply[], overrides: Partial<ConstructorParameters<typeof KarbonRestClient>[0]> = {}) {
  const { impl, calls } = scriptedFetch(replies);
  const client = new KarbonRestClient({
    baseUrl: 'https://api.karbonhq.test/v3',
    bearerToken: 'token',
    accessKey: 'key',
    fetchImpl: impl,
    // A limiter that never makes a test wait; the limiter has its own tests.
    rateLimiter: new RateLimiter({ requestsPerMinute: 100_000 }),
    ...overrides,
  });
  return { client, calls };
}

describe('reading Retry-After', () => {
  it('understands delta-seconds, which is what Karbon sends', () => {
    expect(retryAfterMs('30')).toBe(30_000);
    expect(retryAfterMs('0')).toBe(0);
    expect(retryAfterMs('  45  ')).toBe(45_000);
  });

  it('understands an HTTP-date, which the specification also permits', () => {
    const now = Date.parse('2026-08-06T12:00:00Z');
    expect(retryAfterMs('Thu, 06 Aug 2026 12:00:20 GMT', now)).toBe(20_000);
  });

  it('never asks for a wait in the past', () => {
    const now = Date.parse('2026-08-06T12:00:00Z');
    expect(retryAfterMs('Thu, 06 Aug 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('returns null for nothing and for nonsense, so the caller uses its own backoff', () => {
    // Not zero. Treating an unreadable header as "retry immediately" is the
    // one interpretation that makes a throttled account worse.
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs(undefined)).toBeNull();
    expect(retryAfterMs('')).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
    expect(retryAfterMs('2.5')).toBeNull();
  });
});

describe('the rate limiter', () => {
  /** Virtual time: the limiter must be testable without spending 60 seconds. */
  function virtualClock() {
    let current = 0;
    const waits: number[] = [];
    return {
      waits,
      now: () => current,
      sleep: async (ms: number) => {
        waits.push(ms);
        current += ms;
      },
      advance: (ms: number) => {
        current += ms;
      },
    };
  }

  it('lets a burst through up to the minute budget, which is what the limit means', async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({ requestsPerMinute: 120, now: clock.now, sleep: clock.sleep });

    for (let index = 0; index < 120; index += 1) await limiter.acquire();

    expect(clock.waits).toEqual([]);
  });

  it('makes the caller wait once the budget is spent', async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({ requestsPerMinute: 60, now: clock.now, sleep: clock.sleep });

    for (let index = 0; index < 60; index += 1) await limiter.acquire();
    expect(clock.waits).toEqual([]);

    await limiter.acquire();
    // One token a second at 60/minute.
    expect(clock.waits).toEqual([1_000]);
  });

  it('refills over time rather than only at a window boundary', async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({ requestsPerMinute: 60, now: clock.now, sleep: clock.sleep });

    for (let index = 0; index < 60; index += 1) await limiter.acquire();
    clock.advance(10_000);

    // Ten seconds at one a second: ten more without waiting.
    for (let index = 0; index < 10; index += 1) await limiter.acquire();
    expect(clock.waits).toEqual([]);
  });

  it('serialises waiters, so concurrent workers do not all wake on the same token', async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({ requestsPerMinute: 60, now: clock.now, sleep: clock.sleep });

    for (let index = 0; index < 60; index += 1) await limiter.acquire();

    // Four workers is the default WORKER_CONCURRENCY.
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire(), limiter.acquire()]);

    expect(clock.waits).toHaveLength(4);
    expect(limiter.available).toBeLessThan(1);
  });

  it('refuses a nonsensical budget rather than dividing by zero', () => {
    expect(() => new RateLimiter({ requestsPerMinute: 0 })).toThrow(/positive/i);
  });
});

describe('a write the tenant does not support', () => {
  it('falls back to a note instead of reporting a task it never created', async () => {
    // The defect this covers: a 404 was turned into `null` for every method, so
    // `createTask` returned SUCCEEDED with no task id. Karbon's task API
    // availability varies by tenant and plan, so 404 is the *expected* shape of
    // "not available here" — and it was the one shape reported as success.
    const { client, calls } = clientWith([
      { status: 404 },
      { status: 200, body: { NoteKey: 'note-1' } },
    ]);

    const result = await client.createTask({
      workItemKey: 'WI-1',
      title: 'Review the T2 engagement letter',
      description: 'Ready for partner review.',
      idempotencyKey: 'idem-1',
    });

    expect(result.outcome).toBe('SKIPPED_UNSUPPORTED');
    expect(result.objectId).toBe('note-1');
    expect(result.message).toMatch(/note was posted instead/i);

    expect(calls[0]).toMatchObject({ method: 'POST' });
    expect(calls[0]?.url).toContain('/Tasks');
    expect(calls[1]?.url).toContain('/Notes');
  });

  it('still reports a genuine task as succeeded', async () => {
    const { client } = clientWith([{ status: 200, body: { TaskKey: 'task-9' } }]);

    const result = await client.createTask({
      workItemKey: 'WI-1',
      title: 'Review',
      idempotencyKey: 'idem-2',
    });

    expect(result).toMatchObject({ outcome: 'SUCCEEDED', objectId: 'task-9' });
  });
});

describe('reading something that is not there', () => {
  it('is still an answer of "nothing", not an error', async () => {
    const { client } = clientWith([{ status: 404 }, { status: 404 }]);
    // Organisation then contact: both absent means no such client.
    await expect(client.getClient('missing-key')).resolves.toBeNull();
  });
});

describe('listing documents filed against a client rather than a work item', () => {
  /**
   * A client key names an Organization or a Contact, and only Karbon knows
   * which. Because a 404 on a GET is a legitimate "found nothing", asking the
   * wrong collection is indistinguishable from an empty one — so looking only
   * in `/Contacts` reported "no documents" for every organisation. Every
   * corporate client is an organisation, which made the client-level half of
   * the prior-year search silently useless for all T2 work.
   */
  it('finds documents filed against an organisation', async () => {
    const { client, calls } = clientWith([
      { status: 200, body: { value: [{ DocumentId: 'doc-1', FileName: '2025 Engagement Letter.docx' }] } },
    ]);

    const documents = await client.listDocuments({ entityKey: 'org-key' });

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ documentId: 'doc-1', entityKey: 'org-key' });
    expect(calls[0]!.url).toContain('/Organizations/org-key/Documents');
  });

  it('falls back to contacts, because an individual client is not an organisation', async () => {
    const { client, calls } = clientWith([
      { status: 404 },
      { status: 200, body: { value: [{ DocumentId: 'doc-2', FileName: '2025 T1 Letter.pdf' }] } },
    ]);

    const documents = await client.listDocuments({ entityKey: 'contact-key' });

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ documentId: 'doc-2' });
    expect(calls.map((call) => call.url)).toEqual([
      expect.stringContaining('/Organizations/contact-key/Documents'),
      expect.stringContaining('/Contacts/contact-key/Documents'),
    ]);
  });

  it('reports nothing only when both collections say nothing', async () => {
    const { client, calls } = clientWith([{ status: 404 }, { status: 404 }]);

    await expect(client.listDocuments({ entityKey: 'nowhere' })).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('does not go looking in client collections when a work item was named', async () => {
    const { client, calls } = clientWith([{ status: 200, body: { value: [] } }]);

    await client.listDocuments({ workItemKey: 'wi-1' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/WorkItems/wi-1/Documents');
  });
});

describe('being throttled', () => {
  it('waits at least as long as Karbon asked before retrying', async () => {
    const waits: number[] = [];
    const { client, calls } = clientWith(
      [
        { status: 429, headers: { 'retry-after': '2' } },
        { status: 200, body: { value: [] } },
      ],
      {
        // A limiter that records instead of sleeping, so the assertion is about
        // the wait the client chose rather than about elapsed wall-clock time.
        rateLimiter: new RateLimiter({
          requestsPerMinute: 100_000,
          now: () => 0,
          sleep: async () => undefined,
        }),
      },
    );

    const originalSetTimeout = globalThis.setTimeout;
    // The retry delay goes through setTimeout; capture it and fire immediately.
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      if (typeof ms === 'number' && ms > 0) waits.push(ms);
      return originalSetTimeout(handler, 0);
    }) as typeof globalThis.setTimeout;

    try {
      await client.searchWorkItems({ title: 'T2' });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(calls).toHaveLength(2);
    // 2 seconds requested; the client's own backoff for attempt 1 is well under
    // that, so the vendor's number must win.
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(2_000);
  });
});

describe('searching past the first page', () => {
  /** A page of `count` work items, with a nextLink when more follow. */
  function page(count: number, nextSkip: number | null, titlePrefix = 'WI') {
    return {
      status: 200,
      body: {
        value: Array.from({ length: count }, (_, index) => ({
          WorkItemKey: `${titlePrefix}-${index}`,
          Title: `${titlePrefix} ${index}`,
          ClientKey: 'ORG-1',
        })),
        ...(nextSkip === null ? {} : { '@odata.nextLink': `https://api.karbonhq.com/v3/WorkItems?$skip=${nextSkip}` }),
      },
    };
  }

  it('follows the nextLink instead of stopping at one page', async () => {
    // The defect this covers, observed against a real tenant: the client asked
    // for $top=100, got exactly 100 back, and returned them as if that were the
    // whole result set. Karbon caps a page at 100 and hands back a nextLink.
    const { client, calls } = clientWith([page(100, 100), page(100, 200), page(40, null)]);

    const items = await client.searchWorkItems({});

    expect(items).toHaveLength(240);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toContain('%24skip=100');
    expect(calls[2]?.url).toContain('%24skip=200');
  });

  it('stops as soon as it has the number asked for', async () => {
    const { client, calls } = clientWith([page(100, 100), page(100, 200)]);

    const items = await client.searchWorkItems({ limit: 5 });

    expect(items).toHaveLength(5);
    // One page was enough; it must not have kept walking.
    expect(calls).toHaveLength(1);
  });

  it('keeps paging when the tenant ignores the filter, rather than giving up', async () => {
    // This is why paging matters most. The client re-filters locally precisely
    // because a tenant may ignore an unsupported $filter — and if it does, the
    // one matching work item can be on any page. Reading only the first page
    // meant quietly concluding a client had no prior-year letter.
    const wanted = { WorkItemKey: 'WI-MATCH', Title: 'T2 2025', ClientKey: 'ORG-WANTED' };
    const { client } = clientWith([
      page(100, 100, 'OTHER'),
      { status: 200, body: { value: [wanted] } },
    ]);

    const items = await client.searchWorkItems({ clientKey: 'ORG-WANTED' });

    expect(items).toHaveLength(1);
    expect(items[0]?.workItemKey).toBe('WI-MATCH');
  });

  it('stops when a page comes back empty, even if a nextLink is offered', async () => {
    const { client, calls } = clientWith([page(100, 100), page(0, 200)]);

    await client.searchWorkItems({});
    expect(calls).toHaveLength(2);
  });

  it('refuses to page for ever, loudly', async () => {
    // A silent stop at fifty pages would be the original defect with a bigger
    // number. A tenant that keeps offering a nextLink is a fault to report.
    const endless = Array.from({ length: 60 }, (_, index) => page(100, (index + 1) * 100));
    const { client } = clientWith(endless);

    await expect(client.searchWorkItems({})).rejects.toThrow(/exceeded 50 pages/i);
  });

  it('ignores a nextLink pointing somewhere else, taking only the offset', async () => {
    // The link is vendor-supplied. Following it as a URL would let a response
    // redirect this client at any host; only the $skip is read out of it.
    const { client, calls } = clientWith([
      {
        status: 200,
        body: {
          value: [{ WorkItemKey: 'WI-1', Title: 'One' }],
          '@odata.nextLink': 'https://attacker.example/v3/WorkItems?$skip=100',
        },
      },
      { status: 200, body: { value: [] } },
    ]);

    await client.searchWorkItems({});

    expect(calls.every((call) => call.url.startsWith('https://api.karbonhq.test/'))).toBe(true);
  });
});
