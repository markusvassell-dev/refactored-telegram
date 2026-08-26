import { describe, expect, it } from 'vitest';
import { buildAdobeTag, resolveSignerIndices } from '@element/documents';

/**
 * Which participant a signature field belongs to.
 *
 * Adobe addresses fields by participant *set*: `signer1` means whoever holds the
 * earliest signing order, not a particular person. The manifests used to carry
 * that index as a literal, written by hand at authoring time — T1 joint had the
 * taxpayers at `signer1`/`signer2` and the firm at `signer3`.
 *
 * The firm now signs first. Under the old hardcoded tags that one change would
 * have pointed every field at the wrong person, with nothing to notice: the
 * document would render, Adobe would accept it, the agreement would complete,
 * and the taxpayer's signature would sit in the block labelled for the firm.
 * Nothing throws on the way through. That is why the index is computed here and
 * why these tests exist.
 */

describe('resolving which Adobe participant set a role occupies', () => {
  it('gives every signer their own set, so joint taxpayers are signer2 and signer3', () => {
    // This used to assert that both taxpayers resolved to index 2, because the
    // client put every signer sharing an order into one participant set and
    // this function mirrored that.
    //
    // It no longer does. Adobe publishes no rule for whether every member of a
    // multi-member set must sign or any one of them satisfies it, and on a
    // joint T1 that unstated rule decides whether both spouses actually signed.
    // Each signer now gets their own set, which means the same thing under
    // either reading — and one set per person means one index per person.
    const indices = resolveSignerIndices([
      { role: 'FIRM_SIGNER', signingOrder: 1 },
      { role: 'TAXPAYER_1', signingOrder: 2 },
      { role: 'TAXPAYER_2', signingOrder: 2 },
    ]);

    expect(indices.get('FIRM_SIGNER')).toBe(1);
    expect(indices.get('TAXPAYER_1')).toBe(2);
    expect(indices.get('TAXPAYER_2')).toBe(3);
  });

  it('agrees with the client whatever sequence the participants arrive in', () => {
    // The two sides of this are a database query in one package and a request
    // body in another. Prisma orders by `signingOrder` and promises nothing
    // about ties, so if the index depended on the sequence rows came back in,
    // the tags and the sets could disagree between two runs of the same
    // engagement — and a signature block collecting the wrong person's
    // signature still produces a perfectly ordinary signed PDF.
    const forwards = resolveSignerIndices([
      { role: 'FIRM_SIGNER', signingOrder: 1 },
      { role: 'TAXPAYER_1', signingOrder: 2 },
      { role: 'TAXPAYER_2', signingOrder: 2 },
    ]);
    const backwards = resolveSignerIndices([
      { role: 'TAXPAYER_2', signingOrder: 2 },
      { role: 'TAXPAYER_1', signingOrder: 2 },
      { role: 'FIRM_SIGNER', signingOrder: 1 },
    ]);

    expect([...backwards.entries()].sort()).toEqual([...forwards.entries()].sort());
  });

  it('collapses gaps in the orders rather than passing them through', () => {
    // Removing a signer can leave orders like 1 and 3. Adobe numbers its sets
    // consecutively from 1, so a raw signing order is not an index — passing 3
    // through would address a set that does not exist, and Adobe ignores a tag
    // it cannot resolve rather than rejecting it.
    const indices = resolveSignerIndices([
      { role: 'FIRM_SIGNER', signingOrder: 1 },
      { role: 'TAXPAYER_1', signingOrder: 3 },
    ]);

    expect(indices.get('FIRM_SIGNER')).toBe(1);
    expect(indices.get('TAXPAYER_1')).toBe(2);
  });

  it('is unaffected by the order the participants arrive in', () => {
    const indices = resolveSignerIndices([
      { role: 'TAXPAYER_1', signingOrder: 2 },
      { role: 'FIRM_SIGNER', signingOrder: 1 },
    ]);

    expect(indices.get('FIRM_SIGNER')).toBe(1);
    expect(indices.get('TAXPAYER_1')).toBe(2);
  });

  it('omits a role nobody holds, leaving the caller to decide whether that is fatal', () => {
    const indices = resolveSignerIndices([{ role: 'FIRM_SIGNER', signingOrder: 1 }]);

    // Whether this matters depends on the anchor being required, which is the
    // renderer's decision, not this function's.
    expect(indices.has('TAXPAYER_2')).toBe(false);
  });
});

describe('building the tag', () => {
  it('writes the Adobe syntax for each field kind', () => {
    expect(buildAdobeTag('SIGNATURE', 2)).toBe('{{Sig_es_:signer2:signature}}');
    expect(buildAdobeTag('DATE', 1)).toBe('{{Dte_es_:signer1:date}}');
  });

  it('writes nothing for an auto-placed field', () => {
    // T2 uses this: no tag at all, so Adobe positions its own signature block.
    expect(buildAdobeTag('AUTO_PLACED', 1)).toBeNull();
  });

  it('refuses an index that is not a positive integer', () => {
    // Adobe silently ignores a tag naming a set that cannot exist, and a
    // silently ignored signature field is an unsigned agreement — so this fails
    // loudly at render rather than quietly at signing.
    expect(() => buildAdobeTag('SIGNATURE', 0)).toThrow(/positive integer/i);
    expect(() => buildAdobeTag('SIGNATURE', -1)).toThrow(/positive integer/i);
  });
});
