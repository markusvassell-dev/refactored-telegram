import { describe, expect, it } from 'vitest';
import { MockKarbonProvider, ReadOnlyKarbonProvider } from '@element/integrations';

/**
 * A production Karbon connection under Test Mode.
 *
 * The old rule was that Test Mode refused a production connection outright: the
 * blocked adapter returned nothing for reads as well as writes. That sounds
 * stricter and was the opposite. Karbon publishes no sandbox host, so a firm
 * that wanted the application to do anything with Karbon had exactly one lever
 * — mark the production connection "Sandbox" — and that is what was deployed.
 * A rule that can only be satisfied by lying produces a lie, and then the label
 * means nothing anywhere.
 *
 * Reading a firm's own Karbon changes nothing on their side. Writing is what
 * Test Mode exists to prevent.
 */

function readOnly() {
  const inner = new MockKarbonProvider({
    clients: [
      {
        entityKey: 'org-1',
        entityType: 'Organization',
        legalName: 'Ziegeman Pipeline Services Ltd.',
        contacts: [],
      },
    ],
    workItems: [{ workItemKey: 'wi-1', title: 'Year-end review', clientKey: 'org-1' }],
    documents: [{ documentId: 'doc-1', fileName: 'Prior Year Letter.pdf', workItemKey: 'wi-1', entityKey: null }],
  });
  return { inner, karbon: new ReadOnlyKarbonProvider(inner, 'Test Mode is active.') };
}

describe('reads, which change nothing on the firm’s side', () => {
  it('passes every read through to the real tenant', async () => {
    const { karbon } = readOnly();

    await expect(karbon.getWorkItem('wi-1')).resolves.toMatchObject({ title: 'Year-end review' });
    await expect(karbon.getClient('org-1')).resolves.toMatchObject({ legalName: 'Ziegeman Pipeline Services Ltd.' });
    await expect(karbon.searchWorkItems({ limit: 10 })).resolves.toHaveLength(1);
    await expect(karbon.listDocuments({ workItemKey: 'wi-1' })).resolves.toHaveLength(1);
    await expect(karbon.downloadDocument('doc-1')).resolves.toMatchObject({ fileName: 'Prior Year Letter.pdf' });
  });

  it('is the reason the honest label is usable at all', async () => {
    // The client list and the prior-year letter are exactly what a firm needs
    // while setting up. Refusing them is what made "Sandbox" the only setting
    // anybody could pick.
    const { karbon } = readOnly();
    const items = await karbon.searchWorkItems({ limit: 10 });
    expect(items[0]?.clientKey).toBe('org-1');
  });
});

describe('writes, which are what Test Mode exists to prevent', () => {
  it('refuses every one, and says why rather than failing silently', async () => {
    const { karbon, inner } = readOnly();

    const attempts = [
      karbon.uploadDocument({
        workItemKey: 'wi-1',
        fileName: 'x.pdf',
        content: Buffer.from('%PDF-1.4'),
        mimeType: 'application/pdf',
        idempotencyKey: 'k1',
        neverOverwrite: true,
      }),
      karbon.addComment({ workItemKey: 'wi-1', body: 'note', idempotencyKey: 'k2' }),
      karbon.createTask({ workItemKey: 'wi-1', title: 'task', idempotencyKey: 'k3' }),
      karbon.updateWorkItemStatus('wi-1', 'Done'),
      karbon.completeTask('task-1'),
    ];

    for (const attempt of attempts) {
      const result = await attempt;
      expect(result.outcome).toBe('SKIPPED_TEST_MODE');
      expect(result.message).toMatch(/Test Mode/i);
    }

    // Nothing reached the tenant underneath: refused, not merely reported.
    expect(inner.calls.filter((call) => call.operation !== 'searchWorkItems')).toEqual([]);
  });
});

describe('what it reports itself as', () => {
  it('does not claim to be a mock, because what it returns is real', async () => {
    // The client import refuses to invent clients from a mock, and the
    // signature filing refuses to call a mock upload "filed". Both would read
    // this adapter's genuine tenant data as fictional if it claimed otherwise —
    // and the import would then refuse the one case it exists for.
    const { karbon } = readOnly();
    expect(karbon.isMock).toBe(false);
    expect(karbon.name).toBe('karbon-read-only');
  });
});
