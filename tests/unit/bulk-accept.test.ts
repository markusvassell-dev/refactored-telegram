import { describe, expect, it } from 'vitest';
import {
  BULK_ACCEPT_SCORE,
  decideBulkAccept,
  verifyCandidate,
  yearEndRenderings,
  type VerificationExpectation,
} from '@element/integrations';

/**
 * The bar a document must clear to be read automatically.
 *
 * A bulk scan reads everything a client has and takes values out of whatever
 * passes, so this decides what reaches a letter somebody signs. Ninety per cent
 * was the number asked for. These are about the two ways that number, on its
 * own, does not mean what it looks like it means.
 */

const WELL_KNOWN: VerificationExpectation = {
  clientLegalName: 'Northwind Holdings Ltd.',
  corporationName: 'Northwind Holdings Ltd.',
  engagementType: 'T2',
  documentType: 'T2_ENGAGEMENT_LETTER',
  priorTaxYear: 2025,
  businessNumber: '12345 6789 RC0001',
  yearEndIso: '2025-03-31',
  karbonWorkItemKey: 'wi-1',
};

/** A client the firm holds a name for and nothing else. */
const THIN: VerificationExpectation = {
  clientLegalName: 'Northwind Holdings Ltd.',
  corporationName: 'Northwind Holdings Ltd.',
  engagementType: 'T2',
  documentType: 'T2_ENGAGEMENT_LETTER',
  priorTaxYear: 2025,
};

function letter(options: { yearEnd?: string; businessNumber?: string } = {}): string {
  return [
    'Corporate Income Tax (T2) Engagement Letter',
    'To: Northwind Holdings Ltd.',
    options.businessNumber === undefined ? 'Business Number: 12345 6789 RC0001' : options.businessNumber,
    `Taxation year-end: ${options.yearEnd ?? 'March 31, 2025'}`,
    'We are pleased to confirm our understanding for the 2025 taxation year.',
  ].join('\n');
}

function candidate(text: string, fileName = '2025 Engagement Letter.pdf') {
  return { documentId: 'doc-1', fileName, text, karbonWorkItemKey: 'wi-1' };
}

describe('the scale the 90% sits on', () => {
  /**
   * The change that makes 90% reachable at all. This letter is genuine and
   * correct; it simply prints the date the other way round. Before the matcher
   * accepted more than one rendering it scored 0.818 and a 90% gate refused it.
   */
  it('accepts a year-end written in any ordinary way', () => {
    for (const rendering of ['March 31, 2025', '31 March 2025', '2025-03-31', 'Mar 31, 2025', '31/03/2025']) {
      const outcome = verifyCandidate(candidate(letter({ yearEnd: rendering })), WELL_KNOWN);
      expect(outcome.score, `year-end written as "${rendering}"`).toBeGreaterThanOrEqual(BULK_ACCEPT_SCORE);
    }
  });

  it('does not match a year-end that is a different date', () => {
    const outcome = verifyCandidate(candidate(letter({ yearEnd: 'March 30, 2025' })), WELL_KNOWN);
    expect(outcome.matchedKeys).not.toContain('year_end');
  });

  it('renders the same date and only that date', () => {
    const renderings = yearEndRenderings('2025-03-31');
    expect(renderings).toContain('2025-03-31');
    expect(renderings).toContain('31 March 2025');
    expect(renderings.every((value) => value.includes('2025'))).toBe(true);
  });

  /**
   * A filename is documented in this module as "a weak, supporting signal only
   * — never sufficient on its own". While it sat in the denominator it could
   * still *deny* acceptance, which is not what a hint is.
   */
  it('does not penalise a genuine letter for an unhelpful filename or an unexpected work item', () => {
    // A client with no business number on file, so the applicable weight is
    // small enough for half a point to decide the outcome — which is exactly
    // when a hint must not be able to deny acceptance. With both hints back in
    // the denominator this letter scores 0.889 and a 90% gate refuses it.
    const noStrongIdentifier: VerificationExpectation = {
      ...THIN,
      yearEndIso: '2025-03-31',
      karbonWorkItemKey: 'wi-1',
    };

    const outcome = verifyCandidate(
      {
        documentId: 'doc-1',
        fileName: 'Engagement Letter.docx',
        text: letter({ businessNumber: '' }),
        karbonWorkItemKey: 'somewhere-else',
      },
      noStrongIdentifier,
    );

    expect(outcome.matchedKeys).not.toContain('filename_hint');
    expect(outcome.matchedKeys).not.toContain('work_item');
    expect(outcome.score).toBeGreaterThanOrEqual(BULK_ACCEPT_SCORE);
  });

  it('reports the denominator, so a score can be read for what it is worth', () => {
    const rich = verifyCandidate(candidate(letter()), WELL_KNOWN);
    const thin = verifyCandidate(candidate(letter({ businessNumber: '' })), THIN);

    // The same 100% means very different things.
    expect(thin.applicableWeight).toBeLessThan(rich.applicableWeight);
    expect(rich.matchedWeight).toBeLessThanOrEqual(rich.applicableWeight);
  });
});

describe('the identity floor', () => {
  /**
   * The exploit the floor exists for. Every applicable signal matches, so the
   * score is a flat 1.00 — on a document that has established nothing beyond a
   * name and a year, and could as easily be the firm's blank template or
   * another client's letter.
   */
  it('refuses a perfect score when nothing identifies whose document it is', () => {
    const outcome = verifyCandidate(candidate(letter({ businessNumber: '' })), THIN);
    expect(outcome.score).toBe(1);

    const decision = decideBulkAccept(outcome, { readable: true });
    expect(decision.accepted).toBe(false);
    expect(decision.identityBasis).toBe('NONE');
    expect(decision.refusals.join(' ')).toMatch(/identifies/i);
  });

  it('accepts the same document once the client record carries a business number', () => {
    const outcome = verifyCandidate(candidate(letter()), WELL_KNOWN);
    const decision = decideBulkAccept(outcome, { readable: true });

    expect(decision.accepted).toBe(true);
    expect(decision.identityBasis).toBe('STRONG_IDENTIFIER');
  });

  it('accepts on the client name plus the year-end when no strong identifier is held', () => {
    const withYearEnd: VerificationExpectation = { ...THIN, yearEndIso: '2025-03-31' };
    const outcome = verifyCandidate(candidate(letter({ businessNumber: '' })), withYearEnd);
    const decision = decideBulkAccept(outcome, { readable: true });

    expect(decision.identityBasis).toBe('NAME_AND_PERIOD');
    expect(decision.accepted).toBe(true);
  });

  /**
   * Every T2 caller sets `corporationName` to the client's legal name, so
   * counting it toward identity would count the same name twice and turn the
   * floor into no floor at all.
   */
  it('never lets the corporation name stand in for an identifier', () => {
    const outcome = verifyCandidate(candidate(letter({ businessNumber: '' })), THIN);
    expect(outcome.matchedKeys).toContain('corporation_name');
    expect(decideBulkAccept(outcome, { readable: true }).identityBasis).toBe('NONE');
  });

  it('refuses just below the bar and accepts at it', () => {
    const outcome = verifyCandidate(candidate(letter()), WELL_KNOWN);

    expect(decideBulkAccept(outcome, { readable: true, minimumScore: outcome.score }).accepted).toBe(true);
    expect(
      decideBulkAccept(outcome, { readable: true, minimumScore: outcome.score + 0.01 }).accepted,
    ).toBe(false);
  });

  it('calls an unreadable document unreadable rather than low-scoring', () => {
    const outcome = verifyCandidate(candidate(''), WELL_KNOWN);
    const decision = decideBulkAccept(outcome, { readable: false });

    expect(decision.accepted).toBe(false);
    expect(decision.refusals.join(' ')).toMatch(/no text could be read/i);
  });

  it('refuses a draft however well it scores', () => {
    const outcome = verifyCandidate(candidate(`DRAFT\n${letter()}`), WELL_KNOWN);
    const decision = decideBulkAccept(outcome, { readable: true });

    expect(decision.accepted).toBe(false);
    expect(decision.refusals.join(' ')).toMatch(/draft/i);
  });
});
