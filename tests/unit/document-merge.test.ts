import { describe, expect, it } from 'vitest';
import { mergeDocumentFindings, type DocumentFinding } from '@element/services';

/**
 * One value per token, from however many documents said something about it.
 *
 * `extracted_field` is unique on (engagement, package, token, source) and every
 * scanned document writes the same source, so forty documents do not produce
 * forty rows to choose between — they produce one row with the last writer
 * silently winning. The choice has to be made before anything is written.
 */

function finding(overrides: Partial<DocumentFinding> & { value: string }): DocumentFinding {
  return {
    token: 'corporation.legal_name',
    sourceDocumentId: `doc-${overrides.value}`,
    fileName: `${overrides.value}.pdf`,
    kind: 'PRIOR_YEAR_ENGAGEMENT_LETTER',
    documentScore: 0.95,
    ...overrides,
  };
}

describe('when documents agree', () => {
  it('produces one value with a citation for each document that supports it', () => {
    const merged = mergeDocumentFindings([
      finding({ value: 'Northwind Holdings Ltd.', sourceDocumentId: 'a' }),
      finding({ value: 'Northwind Holdings Ltd.', sourceDocumentId: 'b', kind: 'FINAL_T2_RETURN' }),
      finding({ value: 'Northwind Holdings Ltd.', sourceDocumentId: 'c', kind: 'NOTICE_OF_ASSESSMENT' }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.value).toBe('Northwind Holdings Ltd.');
    expect(merged[0]?.corroborating).toHaveLength(3);
    expect(merged[0]?.disagreement).toBeNull();
  });

  /**
   * Asking a reviewer to adjudicate a full stop teaches them to click through
   * the ones that matter.
   */
  it('treats a cosmetic difference as agreement', () => {
    const merged = mergeDocumentFindings([
      finding({ value: 'ACME Holdings Ltd.', sourceDocumentId: 'a' }),
      finding({ value: 'ACME Holdings Ltd', sourceDocumentId: 'b' }),
    ]);

    expect(merged[0]?.disagreement).toBeNull();
    expect(merged[0]?.corroborating).toHaveLength(2);
  });
});

describe('when documents disagree', () => {
  it('takes the value from the document that scored highest, and reports the rest', () => {
    const merged = mergeDocumentFindings([
      finding({ value: 'Northwind Holdings Ltd.', documentScore: 0.98, sourceDocumentId: 'strong' }),
      finding({ value: 'Northwind Holdings Limited', documentScore: 0.91, sourceDocumentId: 'weak' }),
    ]);

    expect(merged[0]?.value).toBe('Northwind Holdings Ltd.');
    expect(merged[0]?.disagreement).toHaveLength(1);
    expect(merged[0]?.disagreement?.[0]?.value).toBe('Northwind Holdings Limited');
  });

  it('prefers the value more documents agree on when scores tie', () => {
    const merged = mergeDocumentFindings([
      finding({ value: 'Northwind Holdings Ltd.', sourceDocumentId: 'a' }),
      finding({ value: 'Northwind Holdings Ltd.', sourceDocumentId: 'b' }),
      finding({ value: 'Northwood Holdings Ltd.', sourceDocumentId: 'c' }),
    ]);

    expect(merged[0]?.value).toBe('Northwind Holdings Ltd.');
    expect(merged[0]?.corroborating).toHaveLength(2);
  });

  it('prefers a signed letter over a working paper when everything else ties', () => {
    const merged = mergeDocumentFindings([
      finding({ value: 'From the trial balance', kind: 'TRIAL_BALANCE', sourceDocumentId: 'tb' }),
      finding({ value: 'From the signed letter', kind: 'PRIOR_YEAR_SIGNED_LETTER', sourceDocumentId: 'sl' }),
    ]);

    expect(merged[0]?.value).toBe('From the signed letter');
  });

  /**
   * A merge whose answer depended on which Karbon scope happened to answer
   * first would be a value that changed under a reviewer between two readings
   * of the same screen.
   */
  it('resolves identically however the findings are ordered', () => {
    // Everything ties: same score, one document each, same kind. This is the
    // last resort, and without a total order here the answer is whatever order
    // the documents happened to come back in.
    const findings = [
      finding({ value: 'Alpha Ltd.', documentScore: 0.94, sourceDocumentId: 'a' }),
      finding({ value: 'Beta Ltd.', documentScore: 0.94, sourceDocumentId: 'b' }),
      finding({ value: 'Gamma Ltd.', documentScore: 0.94, sourceDocumentId: 'c' }),
    ];

    const answers = new Set<string>();
    for (let round = 0; round < 12; round += 1) {
      const shuffled = [...findings].sort(() => Math.random() - 0.5);
      answers.add(mergeDocumentFindings(shuffled)[0]?.value ?? '');
    }

    expect(answers.size).toBe(1);
  });
});

describe('what it leaves out', () => {
  it('ignores a finding with no value rather than treating blank as an answer', () => {
    const merged = mergeDocumentFindings([
      finding({ value: '   ', sourceDocumentId: 'blank' }),
      finding({ value: 'Northwind Holdings Ltd.', sourceDocumentId: 'real' }),
    ]);

    expect(merged[0]?.corroborating).toHaveLength(1);
    expect(merged[0]?.disagreement).toBeNull();
  });

  it('keeps the typed value from the document whose text won', () => {
    const merged = mergeDocumentFindings([
      finding({
        token: 'corporation.year_end',
        value: 'March 31, 2025',
        dateValue: '2025-03-31',
        documentScore: 0.99,
        sourceDocumentId: 'strong',
      }),
      finding({
        token: 'corporation.year_end',
        value: 'March 30, 2025',
        dateValue: '2025-03-30',
        documentScore: 0.92,
        sourceDocumentId: 'weak',
      }),
    ]);

    expect(merged[0]?.value).toBe('March 31, 2025');
    expect(merged[0]?.dateValue).toBe('2025-03-31');
  });

  it('handles each token independently', () => {
    const merged = mergeDocumentFindings([
      finding({ token: 'corporation.legal_name', value: 'Northwind Holdings Ltd.' }),
      finding({ token: 'corporation.business_number', value: '12345 6789 RC0001' }),
    ]);

    expect(merged.map((entry) => entry.token)).toEqual([
      'corporation.business_number',
      'corporation.legal_name',
    ]);
  });
});
