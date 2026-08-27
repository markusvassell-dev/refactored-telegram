import { describe, expect, it } from 'vitest';
import { extractorFor } from '@element/services';
import { DeterministicExtractor } from '@element/integrations';

/**
 * Which patterns read which document.
 *
 * The scan's table lets a reviewer accept any kind by hand — a notice of
 * assessment, last year's financial statements — where before there was only
 * ever last year's engagement letter to accept. Extraction hardcoded the
 * engagement-letter pattern set, which was consistent while that was the only
 * thing that reached it and silently wrong the moment it was not: a CRA form
 * read with letter patterns finds nothing at best, and matches the wrong label
 * at worst.
 *
 * The mapping is shared rather than copied, because the scan and the
 * accept-by-hand button reading a document two different ways is exactly the
 * disagreement that would go unnoticed.
 */

describe('choosing a pattern set from what the document is', () => {
  it('reads an engagement letter with engagement-letter patterns', () => {
    expect(extractorFor('PRIOR_YEAR_ENGAGEMENT_LETTER')).toBe('ENGAGEMENT_LETTER');
    expect(extractorFor('PRIOR_YEAR_SIGNED_LETTER')).toBe('ENGAGEMENT_LETTER');
  });

  it('reads a CRA form with CRA patterns, not the letter’s', () => {
    for (const kind of ['NOTICE_OF_ASSESSMENT', 'FINAL_T2_RETURN', 'T1_RETURN', 'T183'] as const) {
      expect(extractorFor(kind)).toBe('CRA_SOURCE');
    }
  });

  it('reads nothing from a document that carries nothing the letter needs', () => {
    // Not a gap. A trial balance has no corporation name, no year-end and no
    // fee, so running patterns over it would only produce a report that
    // twenty-two tokens were missing from a document that never had them.
    expect(extractorFor('TRIAL_BALANCE')).toBeNull();
    expect(extractorFor('PAYMENT_SUMMARY')).toBeNull();
  });

  it('names a set the extractor actually accepts', () => {
    // The mapping returning a string the extractor rejects would be a runtime
    // failure in a background job, which is the least visible place to have one.
    for (const kind of ['PRIOR_YEAR_ENGAGEMENT_LETTER', 'NOTICE_OF_ASSESSMENT'] as const) {
      const extractorKind = extractorFor(kind);
      expect(extractorKind).not.toBeNull();
      expect(() => new DeterministicExtractor(extractorKind as never)).not.toThrow();
    }
  });
});
