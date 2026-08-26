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
    // Scoped, because Karbon issues a download token only alongside a file
    // listing and the real client re-lists the entity to get one. The mock used
    // to ignore the argument, which is how a caller that passed no scope at all
    // shipped and failed only against a live tenant.
    await expect(
      karbon.downloadDocument('doc-1', { workItemKey: 'wi-1' }),
    ).resolves.toMatchObject({ fileName: 'Prior Year Letter.pdf' });
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
        target: { workItemKey: 'wi-1' },
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

describe('covering the whole provider interface', () => {
  /**
   * The wrapper forwards method by method, so anything added to the interface
   * and not added here does not fail — it goes *missing*.
   *
   * That happened: a diagnostic naming what an unreadable client key actually
   * is was added, passed every test against the real client, and then reported
   * nothing in production. Under Test Mode the provider is this wrapper, and
   * the method being called was `undefined`. An optional method hides it
   * completely — `provider.thing?.()` on a wrapper that forgot to forward looks
   * exactly like a provider that legitimately does not implement it.
   *
   * Comparing against the mock is what makes this self-maintaining: both
   * implement `KarbonProvider`, so a new method reaches the mock and this test
   * starts failing until the wrapper carries it too.
   */
  it('is held to the interface by the compiler, not by a scan of its prototype', () => {
    // The first attempt at this test compared prototypes against the mock and
    // caught the mock's own test helpers — a false alarm that would have been
    // silenced with an ignore list, which is how a guard stops guarding.
    //
    // Making the method REQUIRED on KarbonProvider is the real fix: every
    // provider must implement it or the build fails, which is a stronger
    // guarantee than any runtime check and needs no maintenance. This assertion
    // just pins the behaviour that required-ness buys.
    const { karbon } = readOnly();
    expect(typeof karbon.describeUnresolvedClient).toBe('function');
  });

  it('forwards the unresolved-client diagnostic rather than swallowing it', async () => {
    const { inner, karbon } = readOnly();
    Object.assign(inner, { describeUnresolvedClient: async (key: string) => `diagnosed ${key}` });

    await expect(karbon.describeUnresolvedClient('ghost-1')).resolves.toBe('diagnosed ghost-1');
  });
});
