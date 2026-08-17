import { describe, expect, it } from 'vitest';
import { KarbonRestClient, RateLimiter, retryAfterMs, splitEntityName } from '@element/integrations';
import { toUserMessage } from '@element/shared';

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

interface RecordedCall {
  url: string;
  method: string;
  /** Parsed when the request carried JSON, so a body can be asserted on. */
  json?: Record<string, unknown>;
  /** Present when the request was multipart, which is how Karbon takes a file. */
  form?: FormData;
}

/** A fetch that answers from a script and records what it was asked. */
function scriptedFetch(replies: Reply[]) {
  const calls: RecordedCall[] = [];

  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET' };
    if (typeof init?.body === 'string') {
      try {
        call.json = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        // Not JSON; the url and method are still worth recording.
      }
    } else if (init?.body instanceof FormData) {
      call.form = init.body;
    }
    calls.push(call);

    const reply = replies.shift() ?? { status: 200, body: {} };

    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  }) as typeof fetch;

  return { impl, calls };
}

/** `GET /v3/FileList/{EntityType}` answers with this shape. */
function fileList(entityKey: string, entityType: string, files: Record<string, unknown>[]) {
  return { status: 200, body: { EntityKey: entityKey, EntityType: entityType, Attachments: files } };
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

  it('is spent in common by every client that shares it', async () => {
    // The defect this covers, seen on the live tenant as "it worked once and
    // then stopped working". Karbon's limit is per account, and the provider
    // factory runs per request — so each request built a client with its own
    // full bucket. The first preview stayed inside the account budget; the
    // second believed it had a fresh 120, spent an allowance already gone, and
    // Karbon answered 429 until the retries ran out.
    //
    // A limiter that resets per caller is not a limiter. Two clients handed the
    // same one have to draw down the same tokens.
    const clock = virtualClock();
    const shared = new RateLimiter({ requestsPerMinute: 10, now: clock.now, sleep: clock.sleep });

    const first = new KarbonRestClient({
      baseUrl: 'https://api.karbonhq.test/v3',
      bearerToken: 't',
      accessKey: 'k',
      rateLimiter: shared,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    const second = new KarbonRestClient({
      baseUrl: 'https://api.karbonhq.test/v3',
      bearerToken: 't',
      accessKey: 'k',
      rateLimiter: shared,
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });

    // Ten requests split across the two clients is the whole budget.
    for (let index = 0; index < 5; index += 1) await first.getWorkItem(`a-${index}`);
    for (let index = 0; index < 5; index += 1) await second.getWorkItem(`b-${index}`);
    expect(clock.waits).toEqual([]);

    // The eleventh has to wait, whichever client asks for it. Before the fix
    // this passed instantly, because the second client had its own budget.
    await second.getWorkItem('over');
    expect(clock.waits.length).toBe(1);
  });

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

describe('what a Karbon failure tells the person who caused it', () => {
  /**
   * The defect this covers, and why several rounds of diagnosis were guesswork.
   * Every Karbon failure reached the screen as `IntegrationError`'s default —
   * "The Karbon integration is currently unavailable" — one sentence that fits a
   * 429, a malformed request and an expired token equally. The status and
   * Karbon's own response body were captured in `context` and read by nothing.
   *
   * Asserted through `toUserMessage`, because the user-facing string is the
   * thing that was wrong; the internal message was always fine.
   */
  it('says the status and repeats what Karbon said', async () => {
    const { client } = clientWith([
      { status: 400, body: { Message: "The field 'EntityKey' is required." } },
    ]);

    const error = await client.getWorkItem('WI-1').then(
      () => null,
      (thrown: unknown) => thrown,
    );

    const shown = toUserMessage(error);
    expect(shown).toContain('400');
    expect(shown).toContain('/WorkItems/WI-1');
    expect(shown).toContain("The field 'EntityKey' is required.");
    // The old generic sentence must not be what a reader gets.
    expect(shown).not.toBe('The Karbon integration is currently unavailable.');
  });

  it('distinguishes being throttled from being wrong', async () => {
    // A 429 means wait; a 400 means fix something. A message that reads the same
    // for both is why "it worked once and then stopped" took so long to place.
    const { client } = clientWith([
      { status: 429, body: 'Rate limit exceeded' },
      { status: 429, body: 'Rate limit exceeded' },
      { status: 429, body: 'Rate limit exceeded' },
    ]);

    const error = await client.getWorkItem('WI-1').then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(toUserMessage(error)).toContain('429');
  });

  it('says so plainly when Karbon explained nothing', async () => {
    const { client } = clientWith([{ status: 403 }]);

    const error = await client.getWorkItem('WI-1').then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(toUserMessage(error)).toMatch(/sent no explanation/i);
  });
});

describe('an operation Karbon does not publish at all', () => {
  /**
   * Karbon's v3 surface has no operation that creates a task. There is no
   * `/WorkItems/{key}/Tasks`; `/IntegrationTasks` is GET-only and
   * `/IntegrationTasks/{key}` is GET and PUT, both of which act on tasks Karbon
   * created for a registered integration partner.
   *
   * The client used to POST to the non-existent path and read the 404 as "this
   * tenant does not have the task feature". The note it then posted was right,
   * the diagnosis was not, and it cost a request and a 404 in the logs on every
   * single review.
   */
  it('makes no request, because there is no endpoint to request', async () => {
    const { client, calls } = clientWith([]);

    const result = await client.createTask({
      workItemKey: 'WI-1',
      title: 'Review the T2 engagement letter',
      description: 'Ready for partner review.',
      idempotencyKey: 'idem-1',
    });

    expect(result.outcome).toBe('SKIPPED_UNSUPPORTED');
    expect(result.message).toMatch(/no API for creating a task/i);
    expect(calls).toHaveLength(0);
  });

  it('reports no object id, so nothing downstream treats a note as a task handle', async () => {
    // It used to return the substitute note's key here. Anything that stored
    // that and later tried to complete "the task" would be holding a note key.
    const { client } = clientWith([]);

    const result = await client.createTask({ workItemKey: 'WI-1', title: 'Review', idempotencyKey: 'idem-2' });

    expect(result.objectId).toBeNull();
  });

  it('says the same about completing one, rather than PUTting to a path that is not there', async () => {
    const { client, calls } = clientWith([]);

    const result = await client.completeTask('task-9');

    expect(result.outcome).toBe('SKIPPED_UNSUPPORTED');
    expect(calls).toHaveLength(0);
  });
});

describe('posting a note', () => {
  it('sends the fields Karbon requires, and links through Timelines', async () => {
    // Every note came back HTTP 400: the body carried none of the three
    // required fields and invented RelatedEntityKey/RelatedEntityType, which
    // Karbon does not define. It links a note through a Timelines array.
    const { client, calls } = clientWith([
      { status: 200, body: { value: [{ Id: 'u1', Name: 'A Partner', EmailAddress: 'partner@firm.test' }] } },
      { status: 200, body: { NoteKey: 'note-1' } },
    ]);

    const result = await client.addComment({ workItemKey: 'WI-1', body: 'Ready for review.', idempotencyKey: 'idem-3' });

    expect(result).toMatchObject({ outcome: 'SUCCEEDED', objectId: 'note-1' });
    expect(calls[1]?.url).toContain('/Notes');
    expect(calls[1]?.json).toMatchObject({
      AuthorEmailAddress: 'partner@firm.test',
      Subject: expect.any(String),
      Body: 'Ready for review.',
      Timelines: [{ EntityType: 'WorkItem', EntityKey: 'WI-1' }],
    });
    expect(calls[1]?.json).not.toHaveProperty('RelatedEntityKey');
  });

  it('prefers the author the firm configured over whoever the tenant lists first', async () => {
    // Discovery attributes notes to whichever user `/Users` returns first —
    // there is no active flag and no ordering guarantee, so that can be someone
    // who has left. A configured address must win, and must skip the lookup.
    const { client, calls } = clientWith([{ status: 200, body: { NoteKey: 'note-2' } }], {
      noteAuthorEmail: 'engagements@firm.test',
    });

    await client.addComment({ workItemKey: 'WI-1', body: 'Ready.', idempotencyKey: 'idem-4' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/Notes');
    expect(calls[0]?.json).toMatchObject({ AuthorEmailAddress: 'engagements@firm.test' });
  });

  it('refuses rather than posting an unattributed note when no author can be found', async () => {
    const { client } = clientWith([{ status: 200, body: { value: [] } }]);

    await expect(
      client.addComment({ workItemKey: 'WI-1', body: 'Ready.', idempotencyKey: 'idem-5' }),
    ).rejects.toThrow(/author/i);
  });
});

describe('reading a client', () => {
  /**
   * The defect this covers, seen on the clients screen for the whole firm:
   * every imported client had zero contacts, no address and no business
   * number. Nothing errored. `GET /Organizations/{key}` simply does not return
   * any of those — contacts need `$expand=Contacts`, and the address, e-mail
   * and telephone live on a Business Card, which needs `$expand=BusinessCards`.
   * The mapper was reading `AddressLines` and `BusinessNumber`, which Karbon
   * does not publish on an organisation at all.
   *
   * A client with no contact has nobody to address an engagement letter to.
   */
  it('asks Karbon to include the contacts and business cards', async () => {
    const { client, calls } = clientWith([{ status: 200, body: { OrganizationKey: 'org-1', FullName: 'Astrella Resources Ltd.' } }]);

    await client.getClient('org-1');

    expect(calls[0]!.url).toContain('/Organizations/org-1');
    expect(decodeURIComponent(calls[0]!.url)).toContain('$expand=Contacts,BusinessCards');
  });

  it('reads the address off the primary business card, not off the organisation', async () => {
    const { client } = clientWith([
      {
        status: 200,
        body: {
          OrganizationKey: 'org-1',
          FullName: 'Astrella Resources Ltd.',
          BusinessCards: [
            { IsPrimaryCard: false, Addresses: [{ AddressLine1: 'Wrong card' }] },
            {
              IsPrimaryCard: true,
              Addresses: [{ AddressLine1: '100 Main St', City: 'Calgary', StateProvinceCounty: 'AB', ZipCode: 'T2P 1A1' }],
            },
          ],
        },
      },
    ]);

    const found = await client.getClient('org-1');

    expect(found).toMatchObject({
      legalName: 'Astrella Resources Ltd.',
      addressLine1: '100 Main St',
      city: 'Calgary',
      province: 'AB',
      postalCode: 'T2P 1A1',
    });
  });

  it('maps the contacts Karbon returns, using the fields it actually sends', async () => {
    const { client } = clientWith([
      {
        status: 200,
        body: {
          OrganizationKey: 'org-1',
          FullName: 'Astrella Resources Ltd.',
          Contacts: [
            {
              ContactKey: 'c-1',
              FullName: 'Jane River',
              PreferredName: 'Jane',
              Salutation: 'Ms',
              EmailAddress: 'jane@astrella.test',
              PhoneNumber: '403-555-0100',
            },
          ],
        },
      },
    ]);

    const found = await client.getClient('org-1');

    expect(found?.contacts).toHaveLength(1);
    expect(found?.contacts[0]).toMatchObject({
      contactKey: 'c-1',
      fullName: 'Jane River',
      firstName: 'Jane',
      title: 'Ms',
      email: 'jane@astrella.test',
      telephone: '403-555-0100',
      // The sole contact on a client is the one a letter is addressed to.
      isPrimary: true,
    });
  });

  it('never renders a structured phone number as [object Object]', async () => {
    // Karbon declares PhoneNumber as `oneOf`, so it can arrive either way, and
    // the wrong branch would put "[object Object]" on a client's letter.
    const { client } = clientWith([
      {
        status: 200,
        body: {
          OrganizationKey: 'org-1',
          FullName: 'Astrella Resources Ltd.',
          Contacts: [{ ContactKey: 'c-1', FullName: 'Jane River', PhoneNumber: { Number: '403-555-0100' } }],
        },
      },
    ]);

    const found = await client.getClient('org-1');
    expect(found?.contacts[0]?.telephone).toBe('403-555-0100');
  });

  it('refuses a business number that is not number-shaped', async () => {
    // Karbon publishes no business-number field. UserDefinedIdentifier is free
    // text and is usually a client code or the company name — putting that on a
    // T2 engagement letter as the CRA business number would be worse than
    // leaving it blank, because blank is visibly missing and wrong is not.
    const { client } = clientWith([
      { status: 200, body: { OrganizationKey: 'org-1', FullName: 'Astrella', UserDefinedIdentifier: 'ASTRELLA-01' } },
    ]);

    expect((await client.getClient('org-1'))?.businessNumber).toBeNull();
  });

  it('accepts one that is', async () => {
    const { client } = clientWith([
      { status: 200, body: { OrganizationKey: 'org-1', FullName: 'Astrella', UserDefinedIdentifier: '123456789RC0001' } },
    ]);

    expect((await client.getClient('org-1'))?.businessNumber).toBe('123456789RC0001');
  });

  it('falls back to the contact endpoint for an individual, expanding there too', async () => {
    const { client, calls } = clientWith([
      { status: 404 },
      {
        status: 200,
        body: {
          ContactKey: 'c-9',
          FullName: 'Sam Taylor',
          BusinessCards: [
            {
              IsPrimaryCard: true,
              Addresses: [{ AddressLine1: '5 Elm Row', City: 'Edmonton' }],
              EmailAddresses: ['sam@example.test'],
              PhoneNumbers: ['780-555-0111'],
            },
          ],
        },
      },
    ]);

    const found = await client.getClient('c-9');

    expect(decodeURIComponent(calls[1]!.url)).toContain('$expand=BusinessCards');
    expect(found).toMatchObject({ entityType: 'Contact', legalName: 'Sam Taylor', city: 'Edmonton', businessNumber: null });
    expect(found?.contacts[0]).toMatchObject({ email: 'sam@example.test', telephone: '780-555-0111', isPrimary: true });
  });
});

describe('reading something that is not there', () => {
  it('is still an answer of "nothing", not an error', async () => {
    const { client } = clientWith([{ status: 404 }, { status: 404 }]);
    // Organisation then contact: both absent means no such client.
    await expect(client.getClient('missing-key')).resolves.toBeNull();
  });
});

describe('listing the files on an entity', () => {
  /**
   * This asked `/v3/WorkItems/{key}/Documents` and `/v3/{Organizations,Contacts}
   * /{key}/Documents`. None of those paths exist. Because a 404 on a GET is a
   * legitimate "found nothing", every work item and every client record in the
   * firm's tenant reported zero documents — a working integration by every
   * signal the app had, finding nothing, for ever. Karbon serves files from
   * `/v3/FileList/{EntityType}?EntityKey=...`.
   */
  it('asks the FileList endpoint for a work item, not a Documents sub-collection', async () => {
    const { client, calls } = clientWith([
      fileList('wi-1', 'WorkItem', [
        {
          FileContextKey: 'file-1',
          FileName: '2025 Engagement Letter.docx',
          FileSize: 7316,
          MimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          DateCreated: '2025-07-18T23:44:26Z',
          DownloadUrl: '/V3/Files?token=abc',
        },
      ]),
    ]);

    const documents = await client.listDocuments({ workItemKey: 'wi-1' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/FileList/WorkItem');
    expect(calls[0]!.url).toContain('EntityKey=wi-1');
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      documentId: 'file-1',
      fileName: '2025 Engagement Letter.docx',
      byteSize: 7316,
      workItemKey: 'wi-1',
    });
  });

  it('tries Organization before Contact, because a corporate client is an organisation', async () => {
    // A client key names one or the other and only Karbon knows which. Asking
    // just one made the client-level half of the prior-year search useless for
    // whichever kind it did not ask about.
    const { client, calls } = clientWith([
      { status: 404 },
      fileList('contact-key', 'Contact', [{ FileContextKey: 'file-2', FileName: '2025 T1 Letter.pdf' }]),
    ]);

    const documents = await client.listDocuments({ entityKey: 'contact-key' });

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ documentId: 'file-2', entityKey: 'contact-key' });
    expect(calls.map((call) => call.url)).toEqual([
      expect.stringContaining('/FileList/Organization'),
      expect.stringContaining('/FileList/Contact'),
    ]);
  });

  it('stops at the first entity type that answers, even when it answers empty', async () => {
    // An empty list from the right endpoint is a real answer: the organisation
    // has no files. Carrying on to Contact would be asking a question already
    // answered, and would spend a request from a shared 120-a-minute budget.
    const { client, calls } = clientWith([fileList('org-key', 'Organization', [])]);

    await expect(client.listDocuments({ entityKey: 'org-key' })).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('reports nothing only when neither entity type recognises the key', async () => {
    const { client, calls } = clientWith([{ status: 404 }, { status: 404 }]);

    await expect(client.listDocuments({ entityKey: 'nowhere' })).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });
});

describe('downloading a file', () => {
  /**
   * There is no download-by-id operation. `/v3/Documents/{id}/Content` does not
   * exist. Karbon issues a signed token alongside a file listing — documented
   * as valid for fifteen minutes — and `GET /v3/Files?token=...` spends it.
   */
  it('lists the entity to get a fresh token, then spends it', async () => {
    const { client, calls } = clientWith([
      fileList('wi-1', 'WorkItem', [
        { FileContextKey: 'file-1', FileName: 'Letter.pdf', MimeType: 'application/pdf', DownloadUrl: '/V3/Files?token=jwt-abc' },
      ]),
      { status: 200, body: {} },
    ]);

    const file = await client.downloadDocument('file-1', { workItemKey: 'wi-1' });

    expect(calls[0]!.url).toContain('/FileList/WorkItem');
    expect(calls[1]!.url).toContain('/Files');
    expect(calls[1]!.url).toContain('token=jwt-abc');
    expect(file).toMatchObject({ fileName: 'Letter.pdf', mimeType: 'application/pdf' });
  });

  it('takes only the token from the vendor URL, never the host', async () => {
    // DownloadUrl is vendor-supplied. Fetching it as given would let a response
    // point this client, carrying the firm's credentials, at any host at all.
    const { client, calls } = clientWith([
      fileList('wi-1', 'WorkItem', [
        { FileContextKey: 'file-1', FileName: 'Letter.pdf', DownloadUrl: 'https://attacker.example/v3/Files?token=jwt-abc' },
      ]),
      { status: 200, body: {} },
    ]);

    await client.downloadDocument('file-1', { workItemKey: 'wi-1' });

    expect(calls.every((call) => call.url.startsWith('https://api.karbonhq.test/'))).toBe(true);
  });

  it('fails plainly when the file is not in the listing, rather than fetching nothing', async () => {
    const { client } = clientWith([fileList('wi-1', 'WorkItem', [])]);

    await expect(client.downloadDocument('file-missing', { workItemKey: 'wi-1' })).rejects.toThrow(/download URL/i);
  });
});

describe('uploading a file', () => {
  it('posts multipart to /Files, carrying the work item key as a form field', async () => {
    // `POST /v3/WorkItems/{key}/Documents` answered 404: it does not exist. A
    // signed engagement letter reaching a client's permanent file depends on
    // this one being right.
    const { client, calls } = clientWith([
      // The collision check reads the existing files first.
      fileList('WI-1', 'WorkItem', []),
      { status: 201, body: { Id: 'file-9', Name: 'Signed.pdf' } },
    ]);

    const result = await client.uploadDocument({
      workItemKey: 'WI-1',
      fileName: 'Signed.pdf',
      content: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
      idempotencyKey: 'idem-6',
      neverOverwrite: true,
    });

    expect(result).toMatchObject({ outcome: 'SUCCEEDED', objectId: 'file-9' });
    expect(calls[1]).toMatchObject({ method: 'POST' });
    expect(calls[1]!.url).toContain('/Files');
    expect(calls[1]!.url).not.toContain('/WorkItems');
    expect(calls[1]!.form?.get('workitem_keys')).toBe('WI-1');
    expect(calls[1]!.form?.get('file')).toBeInstanceOf(Blob);
  });

  it('never replaces a file already on the work item', async () => {
    // The collision check depends on the listing being real. While it pointed
    // at a path that did not exist it returned an empty list every time, so
    // `neverOverwrite` would have found no collision no matter what was there —
    // a guard that could not fire, protecting signed documents.
    const { client, calls } = clientWith([
      fileList('WI-1', 'WorkItem', [{ FileContextKey: 'existing-1', FileName: 'Signed.pdf' }]),
    ]);

    const result = await client.uploadDocument({
      workItemKey: 'WI-1',
      fileName: 'Signed.pdf',
      content: Buffer.from('%PDF-1.4'),
      mimeType: 'application/pdf',
      idempotencyKey: 'idem-7',
      neverOverwrite: true,
    });

    expect(result).toMatchObject({ outcome: 'SKIPPED_DUPLICATE', objectId: 'existing-1' });
    expect(result.message).toMatch(/already exists/i);
    // One call: the listing. Nothing was uploaded.
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
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

describe('splitting the client-list budget between two endpoints', () => {
  /** Pages of client-list rows, so a limit can be observed being honoured. */
  function listingClient(organizations: number, contacts: number) {
    const rows = (prefix: string, count: number, keyField: string) =>
      Array.from({ length: count }, (_, index) => ({ [keyField]: `${prefix}-${index}`, FullName: `${prefix} ${index}` }));

    return clientWith([
      { status: 200, body: { value: rows('org', organizations, 'OrganizationKey') } },
      { status: 200, body: { value: rows('con', contacts, 'ContactKey') } },
    ]).client;
  }

  it('returns no more than the total asked for, on an odd limit', async () => {
    // Observed against the live tenant: a limit of 25 returned 26, because each
    // half was rounded up. Small, and still a limit that does not mean what it
    // says — which is the whole reason the limit became a total.
    const client = listingClient(40, 40);

    const list = await client.listClients({ limit: 25 });

    expect(list.clients.length).toBeLessThanOrEqual(25);
    // Both endpoints are still represented; the fix must not become "take them
    // all from organisations", which would hide every individual client.
    expect(list.clients.some((entry) => entry.entityType === 'Organization')).toBe(true);
    expect(list.clients.some((entry) => entry.entityType === 'Contact')).toBe(true);
    expect(list.more).toBe(true);
  });

  it('splits an even limit exactly in half', async () => {
    const client = listingClient(40, 40);

    const list = await client.listClients({ limit: 20 });

    expect(list.clients.filter((entry) => entry.entityType === 'Organization')).toHaveLength(10);
    expect(list.clients.filter((entry) => entry.entityType === 'Contact')).toHaveLength(10);
  });
});

describe('separating a trading name from a legal name', () => {
  /**
   * The defect this covers, found in a live import preview. Karbon's `FullName`
   * routinely holds the numbered company and the name over the door in one
   * string, and the whole string was written to `legalName` — the value that
   * prints onto an engagement letter.
   *
   * `2140071 Alberta Ltd. (JC Spa and Wellness)` is not a legal name. The legal
   * entity is `2140071 Alberta Ltd.`; the rest is a trade name. A letter naming
   * the bracketed form names a party that does not exist.
   *
   * It would also have been silent: the difference report only fires for clients
   * already present, so the 184 the preview was about to create carried the
   * bracketed form with nothing to compare against.
   */
  it('splits the three shapes the live tenant actually holds', () => {
    expect(splitEntityName('1987371 Alberta Ltd. (Massage Addict)')).toEqual({
      legalName: '1987371 Alberta Ltd.',
      tradeName: 'Massage Addict',
    });
    expect(splitEntityName('2140071 Alberta Ltd. (JC Spa and Wellness)')).toEqual({
      legalName: '2140071 Alberta Ltd.',
      tradeName: 'JC Spa and Wellness',
    });
    expect(splitEntityName('2409116 Alberta Ltd. (Lava Grill Seton)')).toEqual({
      legalName: '2409116 Alberta Ltd.',
      tradeName: 'Lava Grill Seton',
    });
  });

  it('leaves a name without brackets exactly as it is', () => {
    expect(splitEntityName('Ziegeman Pipeline Services Ltd.')).toEqual({
      legalName: 'Ziegeman Pipeline Services Ltd.',
      tradeName: null,
    });
  });

  it('leaves brackets that are part of the legal name alone', () => {
    // `Smith (Holdings) Ltd.` is one legal entity. Only a *trailing*
    // parenthetical is separated, because mangling a legal name is the harm this
    // exists to prevent rather than a smaller version of it.
    expect(splitEntityName('Smith (Holdings) Ltd.')).toEqual({
      legalName: 'Smith (Holdings) Ltd.',
      tradeName: null,
    });
  });

  it('leaves a status annotation alone, because a dash is not a bracket', () => {
    // The same tenant holds this. A dash appears inside real company names, so
    // stripping annotations too would be guessing where the rest is matching.
    expect(splitEntityName('2100698 Albeta Ltd. - DISSOLVED')).toEqual({
      legalName: '2100698 Albeta Ltd. - DISSOLVED',
      tradeName: null,
    });
  });

  it('refuses to leave a client with no legal name at all', () => {
    // A name that is only a parenthetical has no legal half to keep. Splitting
    // it would produce an empty legal name, which is worse than an odd one.
    expect(splitEntityName('(Trading Name Only)')).toEqual({
      legalName: '(Trading Name Only)',
      tradeName: null,
    });
    expect(splitEntityName('Something Ltd. ()')).toEqual({
      legalName: 'Something Ltd. ()',
      tradeName: null,
    });
  });

  it('keeps nested brackets whole rather than guessing', () => {
    expect(splitEntityName('Acme Ltd. (a (very) odd name)')).toEqual({
      legalName: 'Acme Ltd. (a (very) odd name)',
      tradeName: null,
    });
  });
});

describe('mapping a client whose name carries a trading name', () => {
  it('writes the legal entity to legalName and the trading name to displayName', async () => {
    const { client } = clientWith([
      {
        status: 200,
        body: { OrganizationKey: 'org-1', FullName: '2140071 Alberta Ltd. (JC Spa and Wellness)' },
      },
    ]);

    const found = await client.getClient('org-1');

    expect(found).toMatchObject({
      legalName: '2140071 Alberta Ltd.',
      tradeName: 'JC Spa and Wellness',
      displayName: 'JC Spa and Wellness',
    });
  });

  it("does not let the trading name displace Karbon's own preferred name", async () => {
    const { client } = clientWith([
      {
        status: 200,
        body: {
          OrganizationKey: 'org-1',
          FullName: '2140071 Alberta Ltd. (JC Spa and Wellness)',
          PreferredName: 'JC Spa',
        },
      },
    ]);

    const found = await client.getClient('org-1');

    expect(found).toMatchObject({ legalName: '2140071 Alberta Ltd.', displayName: 'JC Spa' });
  });

  it('cleans the signer name on an individual too', async () => {
    // A Contact's own entry becomes the proposed signer and is written into the
    // signature block, so the bracketed form must not reach it either.
    const { client } = clientWith([
      { status: 404, body: null },
      { status: 200, body: { ContactKey: 'con-1', FullName: 'Robin Fournier (Fournier Welding)' } },
    ]);

    const found = await client.getClient('con-1');

    expect(found?.legalName).toBe('Robin Fournier');
    expect(found?.contacts[0]).toMatchObject({ fullName: 'Robin Fournier' });
  });
});
