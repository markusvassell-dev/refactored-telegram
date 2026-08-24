import { describe, expect, it } from 'vitest';
import { clientLabel, hasNoLegalName } from '../../apps/web/src/lib/client-name';

/**
 * A client must never render as nothing.
 *
 * `legalName` is a required column that is not guaranteed to hold anything:
 * the Karbon detail mapper writes `String(raw.FullName ?? raw.Name ?? '')`, so
 * a response carrying no name is stored as an empty string rather than
 * refused. Every client list in the application sorts by `legalName`, which
 * puts those empty strings first — so a handful of them fill the top of the
 * clients table and of the "existing client" menu on a new engagement, where an
 * `<option>` with no text cannot be picked deliberately at all.
 *
 * These assertions are about that: what a caller gets to render, never an empty
 * string, and never a name this file invented.
 */
describe('clientLabel', () => {
  it('uses the legal name when there is one', () => {
    expect(
      clientLabel({ legalName: '2140071 Alberta Ltd.', karbonFullName: '2140071 Alberta Ltd. (JC Spa)' }),
    ).toBe('2140071 Alberta Ltd.');
  });

  it('never returns an empty string, whatever is missing', () => {
    const blanks = [
      { legalName: '' },
      { legalName: '   ' },
      { legalName: '', displayName: null, karbonFullName: null, karbonEntityKey: null },
    ];

    for (const client of blanks) {
      expect(clientLabel(client).trim().length).toBeGreaterThan(0);
    }
  });

  it("falls back to Karbon's own name, and says the legal name is what is missing", () => {
    const label = clientLabel({
      legalName: '',
      displayName: 'JC Spa',
      karbonFullName: '2140071 Alberta Ltd. (JC Spa and Wellness)',
      karbonEntityKey: 'ORG-1',
    });

    expect(label).toContain('2140071 Alberta Ltd. (JC Spa and Wellness)');
    expect(label).toContain('no legal name');
  });

  it('prefers the display name to the entity key, and the key to nothing', () => {
    expect(clientLabel({ legalName: '', displayName: 'JC Spa', karbonEntityKey: 'ORG-1' })).toContain('JC Spa');
    expect(clientLabel({ legalName: '', displayName: null, karbonEntityKey: 'ORG-1' })).toContain('ORG-1');
  });

  it('invents nothing: a client with no name anywhere is described, not named', () => {
    const label = clientLabel({ legalName: '' });
    expect(label).toBe('No legal name recorded');
  });
});

describe('hasNoLegalName', () => {
  it('is true only for a blank, so the flag marks the client the label compensated for', () => {
    expect(hasNoLegalName({ legalName: '' })).toBe(true);
    expect(hasNoLegalName({ legalName: '  ' })).toBe(true);
    expect(hasNoLegalName({ legalName: '2140071 Alberta Ltd.' })).toBe(false);
  });
});
