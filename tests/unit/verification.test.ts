import { describe, expect, it } from 'vitest';
import { selectPriorYearDocument, verifyCandidate } from '@element/integrations';

/**
 * Deciding whether a document is the one it is supposed to be.
 *
 * This is the check that stands between "a file called
 * `2025 Engagement Letter.docx`" and last year's fee being carried into a
 * client's letter. A filename is a hint; the contents are the evidence.
 */

const EXPECTATION = {
  clientLegalName: 'Northwind Sample Holdings Ltd.',
  engagementType: 'T2' as const,
  documentType: 'T2_ENGAGEMENT_LETTER' as const,
  priorTaxYear: 2025,
  corporationName: 'Northwind Sample Holdings Ltd.',
  businessNumber: '11111 1111 RC0001',
  yearEndIso: '2025-03-31',
};

const GENUINE_LETTER = [
  'CORPORATE INCOME TAX (T2) ENGAGEMENT LETTER',
  'Between Northwind Sample Holdings Ltd. and the firm',
  'Business number: 11111 1111 RC0001',
  'For the taxation year ended March 31, 2025',
  'We will prepare the federal T2 return, including providing a draft return or filing summary for management review.',
].join('\n');

function verify(text: string, fileName = '2025 Northwind Engagement Letter.docx') {
  return verifyCandidate({ documentId: 'doc-1', fileName, text }, EXPECTATION);
}

describe('verifying a candidate document', () => {
  it('accepts a genuine prior-year letter confidently', () => {
    const outcome = verify(GENUINE_LETTER);

    expect(outcome.disqualifiers).toEqual([]);
    expect(outcome.score).toBeGreaterThanOrEqual(0.7);
    expect(outcome.confident).toBe(true);
  });

  it('does not call a letter a draft merely for mentioning a draft return', () => {
    // The approved T2 template's own wording offers "a draft return or filing
    // summary for management review". Disqualifying on the word alone would
    // reject genuine letters.
    expect(verify(GENUINE_LETTER).disqualifiers).toEqual([]);
  });

  it('does disqualify a document marked as a draft', () => {
    for (const marker of [
      'DRAFT',
      'Draft copy — do not circulate',
      'This is a draft for review',
      'NOT FOR SIGNATURE',
    ]) {
      const outcome = verify(`${marker}\n${GENUINE_LETTER}`);
      expect(outcome.disqualifiers, marker).toContain('The document appears to be a draft.');
      expect(outcome.confident, marker).toBe(false);
    }
  });

  it('disqualifies a letter for the wrong year', () => {
    const currentYear = GENUINE_LETTER.replace(/2025/g, '2026');

    const outcome = verify(currentYear);
    expect(outcome.disqualifiers.join(' ')).toMatch(/refers to 2026 rather than the prior year 2025/);
  });

  it('scores another client’s letter far below the acceptance threshold', () => {
    const other = GENUINE_LETTER.replace(/Northwind Sample Holdings Ltd\./g, 'Someone Else Entirely Inc.').replace(
      '11111 1111 RC0001',
      '99999 9999 RC0001',
    );

    const outcome = verify(other, 'Someone Else Entirely.docx');

    // No disqualifier fires — it simply matches nothing. This is why matching
    // "no disqualifiers" is not the same as "this is the right document".
    expect(outcome.disqualifiers).toEqual([]);
    expect(outcome.confident).toBe(false);
    expect(outcome.score).toBeLessThan(0.7);
  });

  it('never accepts on the filename alone', () => {
    const outcome = verify('This document has nothing to do with anything.', '2025 Northwind Sample Holdings Ltd.docx');

    expect(outcome.confident).toBe(false);
    expect(outcome.signals.find((signal) => signal.key === 'filename_hint')?.matched).toBe(true);
    expect(outcome.signals.find((signal) => signal.key === 'filename_hint')?.weight).toBeLessThan(1);
  });

  it('matches a client name through punctuation and casing differences', () => {
    const outcome = verify(GENUINE_LETTER.replace('Northwind Sample Holdings Ltd.', 'NORTHWIND SAMPLE HOLDINGS LTD'));

    expect(outcome.signals.find((signal) => signal.key === 'client_legal_name')?.matched).toBe(true);
  });

  it('matches a business number however it is spaced', () => {
    const outcome = verify(GENUINE_LETTER.replace('11111 1111 RC0001', '111111111RC0001'));

    expect(outcome.signals.find((signal) => signal.key === 'business_number')?.matched).toBe(true);
  });

  it('does not penalise a T2 for having no trust name', () => {
    const outcome = verify(GENUINE_LETTER);

    // The trust signal is recorded but must not count against a corporation.
    const trust = outcome.signals.find((signal) => signal.key === 'trust_name');
    expect(trust?.matched).toBe(false);
    expect(outcome.score).toBeGreaterThanOrEqual(0.7);
  });
});

describe('choosing between candidates', () => {
  it('picks the genuine letter over a same-named document for another client', () => {
    const outcome = selectPriorYearDocument(
      [
        { documentId: 'wrong', fileName: '2025 Engagement Letter.docx', text: 'Someone Else Entirely Inc. agreement' },
        { documentId: 'right', fileName: 'letter.docx', text: GENUINE_LETTER },
      ],
      EXPECTATION,
    );

    expect(outcome.selected?.documentId).toBe('right');
  });

  it('asks a person when nothing is convincing', () => {
    const outcome = selectPriorYearDocument(
      [{ documentId: 'weak', fileName: '2025.docx', text: 'An unrelated memorandum.' }],
      EXPECTATION,
    );

    expect(outcome.selected).toBeNull();
    expect(outcome.requiresUserChoice).toBe(true);
    expect(outcome.reason).toBeTruthy();
  });

  it('reports every candidate it considered, so the choice can be reviewed', () => {
    const outcome = selectPriorYearDocument(
      [
        { documentId: 'a', fileName: 'a.docx', text: GENUINE_LETTER },
        { documentId: 'b', fileName: 'b.docx', text: 'Unrelated.' },
      ],
      EXPECTATION,
    );

    expect(outcome.ranked.map((entry) => entry.documentId).sort()).toEqual(['a', 'b']);
  });
});
