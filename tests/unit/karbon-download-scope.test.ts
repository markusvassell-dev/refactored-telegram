import { describe, expect, it } from 'vitest';
import { MockKarbonProvider } from '@element/integrations';

/**
 * A download needs the entity that holds the file, and the double must say so.
 *
 * Karbon hands out a download token alongside a file listing, valid about
 * fifteen minutes, so `KarbonRestClient.downloadDocument` re-lists the entity to
 * get a fresh one. Called with no scope there is nothing to list, no token, and
 * a non-retryable error.
 *
 * The worker's extraction called it with no scope for as long as it existed, and
 * every test passed — because this mock ignored the argument. The consequence
 * was perverse: the *confident* path, where the search had correctly identified
 * last year's letter, was the one that failed against a real tenant, while the
 * manual routes worked because they read stored bytes instead. A test double
 * looser than the thing it stands in for does not merely fail to catch a defect,
 * it certifies one.
 *
 * So these assertions are about the double, not the client. They exist to keep
 * the mock honest, because that is what every other test in the suite is
 * actually testing against.
 */
describe('the Karbon mock refuses a scopeless download, as the real client does', () => {
  function provider() {
    return new MockKarbonProvider({
      documents: [
        { documentId: 'doc-1', fileName: 'Prior Year Letter.pdf', workItemKey: 'wi-1', entityKey: null },
        { documentId: 'doc-2', fileName: 'Client Area Letter.pdf', workItemKey: null, entityKey: 'org-1' },
      ],
    });
  }

  it('refuses when no scope is given', async () => {
    await expect(provider().downloadDocument('doc-1')).rejects.toThrow(/download URL/i);
  });

  it('refuses an empty scope, which is the same mistake spelled differently', async () => {
    await expect(provider().downloadDocument('doc-1', {})).rejects.toThrow(/download URL/i);
  });

  it('accepts a work item scope', async () => {
    await expect(provider().downloadDocument('doc-1', { workItemKey: 'wi-1' })).resolves.toMatchObject({
      fileName: 'Prior Year Letter.pdf',
    });
  });

  it('accepts a client entity scope, which is where the search looks last', async () => {
    await expect(provider().downloadDocument('doc-2', { entityKey: 'org-1' })).resolves.toMatchObject({
      fileName: 'Client Area Letter.pdf',
    });
  });

  it('records the scope it was called with, so a caller dropping it is visible', async () => {
    const karbon = provider();
    await karbon.downloadDocument('doc-1', { workItemKey: 'wi-1' });

    const call = karbon.calls.find((entry) => entry.operation === 'downloadDocument');
    expect(call?.payload).toMatchObject({ scope: { workItemKey: 'wi-1' } });
  });
});
