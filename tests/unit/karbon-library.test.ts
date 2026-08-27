import { describe, expect, it } from 'vitest';
import { KarbonRestClient, MockKarbonProvider, BlockedKarbonProvider } from '@element/integrations';
import { inferTaxYear } from '@element/services';

/**
 * Reading a client's whole Karbon document library.
 *
 * Karbon publishes no operation that returns a client's documents. Its own
 * Documents tab is an aggregate over three entity types, and so is this: a
 * client with 93 documents returns almost none of them from the organization
 * scope alone, because years of returns and signed letters are filed against
 * the work item they belong to.
 *
 * The tests that matter here are not "does it return documents". They are:
 * does it look in every place Karbon files them, and does a read that partly
 * failed ever present itself as a complete answer.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fileList(entityType: string, entityKey: string, files: { key: string; name: string }[]): unknown {
  return {
    EntityKey: entityKey,
    EntityType: entityType,
    Attachments: files.map((file) => ({
      FileContextKey: file.key,
      FileName: file.name,
      FileSize: 1024,
      MimeType: 'application/pdf',
      DownloadUrl: `/V3/Files?token=token-for-${file.key}`,
      DateCreated: '2025-03-01T00:00:00Z',
    })),
  };
}

interface Stub {
  client: KarbonRestClient;
  requests: string[];
}

function buildClient(handler: (url: URL) => Response | null): Stub {
  const requests: string[] = [];

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requests.push(`${url.pathname}${url.search}`);
    const response = handler(url);
    if (response) return response;
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }) as typeof fetch;

  const client = new KarbonRestClient({
    baseUrl: 'https://api.karbonhq.test/v3',
    bearerToken: 'test-token',
    accessKey: 'test-access-key',
    fetchImpl,
  });

  return { client, requests };
}

describe('reading a client library from Karbon', () => {
  it('aggregates the organization, its contacts and every work item', async () => {
    const { client, requests } = buildClient((url) => {
      if (url.pathname.endsWith('/Organizations/ORG1')) {
        return jsonResponse({
          OrganizationKey: 'ORG1',
          FullName: 'Matador Pizza & Spaghetti House Ltd.',
          Contacts: [{ ContactKey: 'CON1', FullName: 'Sam Owner' }],
        });
      }

      if (url.pathname.endsWith('/WorkItems')) {
        return jsonResponse({
          value: [
            { WorkItemKey: 'WI1', Title: '2024 T2 Tax Return', ClientKey: 'ORG1' },
            { WorkItemKey: 'WI2', Title: '2023 T2 Tax Return', ClientKey: 'ORG1' },
          ],
        });
      }

      // EntityKey is honoured, because Karbon honours it: asking
      // /FileList/Organization for a contact key is a 404 there, and a stub
      // that answers it anyway tests a vendor that does not exist.
      const key = url.searchParams.get('EntityKey');

      if (url.pathname.endsWith('/FileList/Organization') && key === 'ORG1') {
        return jsonResponse(fileList('Organization', 'ORG1', [{ key: 'F1', name: 'engagement-2025.pdf' }]));
      }
      if (url.pathname.endsWith('/FileList/Contact') && key === 'CON1') {
        return jsonResponse(fileList('Contact', 'CON1', [{ key: 'F2', name: 'id-verification.pdf' }]));
      }
      if (url.pathname.endsWith('/FileList/WorkItem') && key) {
        return jsonResponse(
          fileList('WorkItem', key, [
            { key: `${key}-A`, name: `${key}-financials.pdf` },
            { key: `${key}-B`, name: `${key}-letter.pdf` },
          ]),
        );
      }

      return null;
    });

    const library = await client.listClientLibrary('ORG1');

    // Organization (1) + contact (1) + two work items (2 each) = 6.
    expect(library.documents).toHaveLength(6);
    expect(library.complete).toBe(true);

    // The point of the whole exercise: work items were actually visited. An
    // implementation that read only the organization's own file area would
    // return one document for a client that has ninety-three.
    expect(requests.filter((path) => path.includes('/FileList/WorkItem'))).toHaveLength(2);
    expect(requests.some((path) => path.includes('/FileList/Contact'))).toBe(true);

    // Provenance survives: "which of these is last year's letter" is
    // unanswerable from a filename alone.
    const labels = library.documents.map((document) => document.sourceLabel);
    expect(labels).toContain('2024 T2 Tax Return');
    expect(labels).toContain('Sam Owner');
  });

  it('reports a scope that failed instead of returning a smaller library', async () => {
    const { client } = buildClient((url) => {
      if (url.pathname.endsWith('/Organizations/ORG1')) {
        return jsonResponse({ OrganizationKey: 'ORG1', FullName: 'Matador Pizza', Contacts: [] });
      }
      if (url.pathname.endsWith('/WorkItems')) {
        return jsonResponse({
          value: [
            { WorkItemKey: 'WI1', Title: '2024 T2', ClientKey: 'ORG1' },
            { WorkItemKey: 'WIBAD', Title: '2023 T2', ClientKey: 'ORG1' },
          ],
        });
      }
      if (url.pathname.endsWith('/FileList/Organization')) {
        return jsonResponse(fileList('Organization', 'ORG1', []));
      }
      if (url.pathname.endsWith('/FileList/WorkItem')) {
        const key = url.searchParams.get('EntityKey');
        if (key === 'WIBAD') {
          return new Response(JSON.stringify({ error: 'server exploded' }), { status: 500 });
        }
        return jsonResponse(fileList('WorkItem', key ?? '', [{ key: 'F1', name: 'good.pdf' }]));
      }
      return null;
    });

    const library = await client.listClientLibrary('ORG1');

    // It still returns what it could read — a partial library is worth having.
    expect(library.documents).toHaveLength(1);

    // What it must never do is call that the client's documents. This flag is
    // the difference between "there is no 2023 letter" and "we could not look
    // for the 2023 letter", and those are opposite conclusions.
    expect(library.complete).toBe(false);
    expect(library.failures).toHaveLength(1);
    expect(library.failures[0]?.entityKey).toBe('WIBAD');
    // The vendor's own words, not a generic message.
    expect(library.failures[0]?.reason).toBeTruthy();
  });

  it('deduplicates a file that Karbon lists under more than one entity', async () => {
    const { client } = buildClient((url) => {
      if (url.pathname.endsWith('/Organizations/ORG1')) {
        return jsonResponse({ OrganizationKey: 'ORG1', FullName: 'Matador Pizza', Contacts: [] });
      }
      if (url.pathname.endsWith('/WorkItems')) {
        return jsonResponse({ value: [{ WorkItemKey: 'WI1', Title: '2024 T2', ClientKey: 'ORG1' }] });
      }
      // The same FileContextKey from both scopes.
      if (url.pathname.includes('/FileList/')) {
        return jsonResponse(fileList('Organization', 'ORG1', [{ key: 'SAME', name: 'letter.pdf' }]));
      }
      return null;
    });

    const library = await client.listClientLibrary('ORG1');
    expect(library.documents).toHaveLength(1);
  });

  it('does not let a blocked provider claim the client has no documents', async () => {
    const blocked = new BlockedKarbonProvider('Karbon is not configured');
    const library = await blocked.listClientLibrary('ORG1');

    expect(library.documents).toHaveLength(0);
    // Zero documents and complete would be a statement about the firm's data,
    // made by an adapter that never looked at it.
    expect(library.complete).toBe(false);
    expect(library.failures).toHaveLength(1);
  });

  it('makes the mock aggregate the same way rather than returning everything at once', async () => {
    const mock = new MockKarbonProvider({
      clients: [
        {
          entityKey: 'ORG1',
          entityType: 'Organization',
          legalName: 'Matador Pizza',
          contacts: [{ contactKey: 'CON1', fullName: 'Sam Owner' }],
        },
      ],
      workItems: [{ workItemKey: 'WI1', title: '2024 T2 Tax Return', clientKey: 'ORG1' }],
      documents: [
        { documentId: 'D1', fileName: 'org.pdf', entityKey: 'ORG1' },
        { documentId: 'D2', fileName: 'work.pdf', workItemKey: 'WI1' },
        // Belongs to a different client. A mock that returned every seeded
        // document would hand this over too, and would be a more capable
        // adapter than Karbon — which is the failure a mock exists to prevent.
        { documentId: 'D3', fileName: 'someone-else.pdf', entityKey: 'ORG2' },
      ],
    });

    const library = await mock.listClientLibrary('ORG1');

    expect(library.documents.map((document) => document.documentId).sort()).toEqual(['D1', 'D2']);
    expect(library.complete).toBe(true);
  });
});

describe('reading a tax year off a work item title', () => {
  const now = new Date('2026-08-13T00:00:00Z');

  it('reads the year from the titles Karbon actually carries', () => {
    expect(inferTaxYear('2024 T2 Tax Return', now)).toBe(2024);
    expect(inferTaxYear('T1 2023 - Personal', now)).toBe(2023);
  });

  it('returns nothing rather than guessing', () => {
    // No year at all.
    expect(inferTaxYear('Bookkeeping', now)).toBeNull();
    // Ambiguous: which year does "2023-2024 file" belong to? Resolving it by a
    // rule nobody agreed to files a document against the wrong engagement, and
    // a reviewer has no reason to doubt a year the application printed.
    expect(inferTaxYear('2023-2024 Working Papers', now)).toBeNull();
    // A number wearing a year's shape.
    expect(inferTaxYear('Invoice 1852', now)).toBeNull();
    // Beyond plausible.
    expect(inferTaxYear('2099 Projection', now)).toBeNull();
  });
});

describe('when the client record itself cannot be read', () => {
  /**
   * The failure that used to be invisible.
   *
   * `getClient` supplies two things this aggregate depends on: the entity type
   * of the client, and its list of contacts. It was called with
   * `.catch(() => null)`, so a transient refusal meant the contact loop
   * iterated nothing — every contact's document area skipped — while
   * `failures` stayed empty and `complete` therefore stayed true.
   *
   * That is the one distinction this whole function exists to preserve: "the
   * client has no 2019 letter" is not the same finding as "we could not look",
   * and the screen's "this list may be missing documents" warning is driven by
   * exactly this flag.
   */
  function clientReadRefused() {
    return buildClient((url) => {
      // The client record is refused; everything else answers normally.
      if (url.pathname.includes('/Organizations/ORG1') || url.pathname.includes('/Contacts/ORG1')) {
        return new Response(JSON.stringify({ message: 'Rate limit exceeded' }), { status: 429 });
      }
      if (url.pathname.includes('/FileList/')) {
        return jsonResponse(fileList('Organization', 'ORG1', [{ key: 'F1', name: 'Something.pdf' }]));
      }
      if (url.pathname.includes('/WorkItems')) return jsonResponse({ value: [] });
      return null;
    });
  }

  it('does not report a partial read as complete', async () => {
    const { client } = clientReadRefused();

    const library = await client.listClientLibrary('ORG1');

    expect(library.complete).toBe(false);
  });

  it('names the client read among the failures, so the reason is readable', async () => {
    const { client } = clientReadRefused();

    const library = await client.listClientLibrary('ORG1');

    const reasons = library.failures.map((failure) => `${failure.label}: ${failure.reason}`).join(' ');
    expect(reasons).toMatch(/client record itself/i);

    // The consequence stated, not just the cause. A reader seeing one failed
    // scope would otherwise assume one scope's worth of documents is missing,
    // when in fact no contact was read at all.
    expect(reasons).toMatch(/no contact/i);
  });
});
