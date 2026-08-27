import { describe, expect, it } from 'vitest';
import { MockKarbonProvider } from '@element/integrations';

/**
 * Reading several files from one scope.
 *
 * `downloadDocument` re-lists the whole scope for every single file, because a
 * download token comes with a listing. Reading a client's whole library that
 * way is two requests per document against a limit shared with everything else
 * the firm has connected — a throttled account rather than a slow job.
 *
 * Karbon publishes that a download token is "valid for 15 minutes from the
 * moment of issue", so one listing's tokens serve the whole batch. Read from
 * the specification rather than inferred: were it single-use, this would
 * silently degrade to the cost it set out to avoid.
 */

function seeded() {
  return new MockKarbonProvider({
    documents: Array.from({ length: 8 }, (_, offset) => ({
      documentId: `doc-${offset + 1}`,
      fileName: `file-${offset + 1}.pdf`,
      workItemKey: 'wi-1',
      content: Buffer.from(`contents ${offset + 1}`),
      mimeType: 'application/pdf',
    })),
  });
}

describe('downloading a batch', () => {
  it('lists once for the whole batch, not once per file', async () => {
    const karbon = seeded();
    const ids = Array.from({ length: 8 }, (_, index) => `doc-${index + 1}`);

    const result = await karbon.downloadDocuments({ workItemKey: 'wi-1' }, ids);

    expect(result.files).toHaveLength(8);
    expect(result.failures).toHaveLength(0);

    const listings = karbon.calls.filter((call) => call.operation === 'listDocuments');
    expect(listings).toHaveLength(1);
  });

  it('returns the bytes of each file it was asked for', async () => {
    const karbon = seeded();
    const result = await karbon.downloadDocuments({ workItemKey: 'wi-1' }, ['doc-3']);

    expect(result.files[0]?.fileName).toBe('file-3.pdf');
    expect(result.files[0]?.content.toString()).toBe('contents 3');
  });

  /**
   * One unreadable file must not lose the rest, and must never be silently
   * dropped: a caller counting what it got back would otherwise report a
   * partial read as a complete one.
   */
  it('names what it could not read rather than dropping it', async () => {
    const karbon = seeded();
    const result = await karbon.downloadDocuments({ workItemKey: 'wi-1' }, ['doc-1', 'not-there', 'doc-2']);

    expect(result.files.map((file) => file.documentId)).toEqual(['doc-1', 'doc-2']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.documentId).toBe('not-there');
    expect(result.failures[0]?.reason).toMatch(/listing/i);
  });

  it('refuses without a scope, exactly as the vendor does', async () => {
    const karbon = seeded();
    const result = await karbon.downloadDocuments({}, ['doc-1']);

    expect(result.files).toHaveLength(0);
    expect(result.failures[0]?.reason).toMatch(/current file listing/i);
  });

  it('asks for nothing when there is nothing to ask for', async () => {
    const karbon = seeded();
    const result = await karbon.downloadDocuments({ workItemKey: 'wi-1' }, []);

    expect(result.files).toHaveLength(0);
    expect(karbon.calls.filter((call) => call.operation === 'listDocuments')).toHaveLength(0);
  });
});
