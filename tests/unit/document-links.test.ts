import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@element/database';
import { DocumentStore } from '@element/services';
import { decodeReference, encodeReference } from '../../apps/web/src/lib/document-reference';

/**
 * The link a reviewer follows to read the document they are approving.
 *
 * Being able to read the document is what makes an approval meaningful, so
 * these links exist — but a storage reference must never become a shareable,
 * guessable URL. The download route checks the session *and* this signature
 * independently, so the properties that matter here are: a signature cannot be
 * transplanted onto a different reference, cannot be forged, and stops working
 * when it expires.
 */

/**
 * Link signing is pure — it hashes a reference and an expiry against the
 * deployment secret and never reads a byte. These tests deliberately keep no
 * database, so the store gets a client it will never call.
 */
const noDatabase = {} as PrismaClient;

const store = new DocumentStore({
  prisma: noDatabase,
  rootDirectory: '/tmp/element-engagements-tests/storage',
  retentionHours: 72,
  maxBytes: 1024,
  signingSecret: 'test-signing-secret-test-signing-secret',
});

const REFERENCE = 'engagement-abc/8f14e45f-ea8f-4b4c-9a3a-000000000000-T2_Engagement_Letter.pdf';

describe('reference encoding', () => {
  it('survives a round trip through a URL path segment', () => {
    const encoded = encodeReference(REFERENCE);

    expect(encoded).not.toContain('/');
    expect(decodeReference(encoded)).toBe(REFERENCE);
  });

  it('round trips a reference containing characters a URL would otherwise eat', () => {
    const awkward = 'scope/a b+c&d=e/Letter (final).docx';

    expect(decodeReference(encodeReference(awkward))).toBe(awkward);
  });
});

describe('signed download links', () => {
  it('verifies a link it just issued', () => {
    const link = store.createSignedLink(REFERENCE, 900);

    expect(store.verifySignedLink(REFERENCE, link.expires, link.signature)).toBe(true);
  });

  it('rejects a signature moved onto a different document', () => {
    const link = store.createSignedLink(REFERENCE, 900);

    expect(store.verifySignedLink('engagement-abc/someone-elses-letter.pdf', link.expires, link.signature)).toBe(false);
  });

  it('rejects an extended expiry, so a link cannot be made to outlive its signature', () => {
    const link = store.createSignedLink(REFERENCE, 900);

    expect(store.verifySignedLink(REFERENCE, link.expires + 3600, link.signature)).toBe(false);
  });

  it('rejects a link that has already expired', () => {
    // Signed correctly, but for a moment that has passed.
    const expires = Math.floor(Date.now() / 1000) - 1;
    const valid = store.createSignedLink(REFERENCE, -1);

    expect(valid.expires).toBeLessThanOrEqual(expires + 1);
    expect(store.verifySignedLink(REFERENCE, valid.expires, valid.signature)).toBe(false);
  });

  it('rejects a forged signature and a malformed one alike', () => {
    const link = store.createSignedLink(REFERENCE, 900);

    expect(store.verifySignedLink(REFERENCE, link.expires, 'f'.repeat(link.signature.length))).toBe(false);
    expect(store.verifySignedLink(REFERENCE, link.expires, '')).toBe(false);
    expect(store.verifySignedLink(REFERENCE, link.expires, `${link.signature}00`)).toBe(false);
  });

  it('rejects a non-numeric expiry rather than treating it as zero', () => {
    const link = store.createSignedLink(REFERENCE, 900);

    expect(store.verifySignedLink(REFERENCE, Number.NaN, link.signature)).toBe(false);
  });

  it('cannot be verified by a different deployment secret', () => {
    const other = new DocumentStore({
      prisma: noDatabase,
      rootDirectory: '/tmp/element-engagements-tests/storage',
      retentionHours: 72,
      maxBytes: 1024,
      signingSecret: 'a-completely-different-signing-secret-value',
    });

    const link = store.createSignedLink(REFERENCE, 900);

    expect(other.verifySignedLink(REFERENCE, link.expires, link.signature)).toBe(false);
  });
});
