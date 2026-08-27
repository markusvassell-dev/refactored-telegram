import { describe, expect, it } from 'vitest';
import { classifyDocument } from '@element/integrations';

/**
 * What kind of document is this?
 *
 * The prior-year search stamped every candidate it wrote as
 * `PRIOR_YEAR_ENGAGEMENT_LETTER`, because that was the only thing it looked
 * for. A scan reads a whole client library, where the kind decides which
 * patterns run against the text and whether its checkboxes are read as last
 * year's service selections — so calling a trial balance an engagement letter
 * is worse than not scanning it at all.
 */

const ENGAGEMENT_LETTER = [
  'Corporate Income Tax (T2) Engagement Letter',
  'To: Northwind Holdings Ltd.',
  'Business Number: 12345 6789 RC0001',
  'We are pleased to confirm our understanding of the services to be provided.',
].join('\n');

describe('classifying by what is inside', () => {
  it('recognises an engagement letter', () => {
    const outcome = classifyDocument('2025 letter.pdf', ENGAGEMENT_LETTER);
    expect(outcome.kind).toBe('PRIOR_YEAR_ENGAGEMENT_LETTER');
    expect(outcome.filenameOnly).toBe(false);
  });

  it('tells a signed copy from an unsigned one', () => {
    const outcome = classifyDocument(
      '2025 letter.pdf',
      `${ENGAGEMENT_LETTER}\nElectronically signed via Adobe Acrobat Sign on April 2, 2025.`,
    );
    expect(outcome.kind).toBe('PRIOR_YEAR_SIGNED_LETTER');
  });

  it('recognises a T2 return', () => {
    const outcome = classifyDocument('return.pdf', 'T2 Corporation Income Tax Return\nSchedule 200\nLine 001');
    expect(outcome.kind).toBe('FINAL_T2_RETURN');
  });

  it('recognises a trial balance, which needs both halves', () => {
    expect(classifyDocument('tb.pdf', 'Trial Balance\nAccount  Debit  Credit\n1000 Cash  5,000').kind).toBe(
      'TRIAL_BALANCE',
    );

    // "Trial balance" mentioned in passing in a letter is not a trial balance.
    expect(classifyDocument('letter.pdf', `${ENGAGEMENT_LETTER}\nWe will prepare a trial balance.`).kind).toBe(
      'PRIOR_YEAR_ENGAGEMENT_LETTER',
    );
  });

  it('recognises a notice of assessment, which now has a kind of its own', () => {
    const outcome = classifyDocument('cra.pdf', 'Notice of Assessment\nTax year-end: 2025-03-31\nBalance owing');
    expect(outcome.kind).toBe('NOTICE_OF_ASSESSMENT');
  });

  it('recognises compiled financial statements', () => {
    const outcome = classifyDocument(
      'fs.pdf',
      'Northwind Holdings Ltd.\nStatement of Financial Position\nAs at March 31, 2025',
    );
    expect(outcome.kind).toBe('COMPILED_FINANCIAL_STATEMENTS');
  });

  it('tells a compilation report on its own from statements carrying one', () => {
    expect(classifyDocument('report.pdf', 'Compilation Engagement Report\nCSRS 4200').kind).toBe(
      'COMPILATION_ENGAGEMENT_REPORT',
    );

    expect(
      classifyDocument('fs.pdf', 'Compilation Engagement Report\nCSRS 4200\nBalance Sheet\nAs at March 31, 2025').kind,
    ).toBe('COMPILED_FINANCIAL_STATEMENTS');
  });

  it('recognises a T183CORP', () => {
    const outcome = classifyDocument(
      'auth.pdf',
      'T183CORP Information Return for Corporations Filing Electronically',
    );
    expect(outcome.kind).toBe('FEDERAL_FILING_AUTHORIZATION');
  });
});

describe('the filename never overrules the contents', () => {
  /**
   * The case that matters. Filed and named as last year's letter, and it is a
   * trial balance. Believing the name would run the letter patterns over it,
   * read its columns as checkbox states, and put whatever came out in front of
   * a reviewer as last year's terms.
   */
  it('classifies by content when the filename says otherwise', () => {
    const outcome = classifyDocument(
      '2024 Engagement Letter.pdf',
      'Trial Balance\nAccount  Debit  Credit\n1000 Cash  5,000',
    );
    expect(outcome.kind).toBe('TRIAL_BALANCE');
    expect(outcome.filenameOnly).toBe(false);
  });

  it('marks a filename-only guess as one, so a caller can refuse it', () => {
    const outcome = classifyDocument('2024 Engagement Letter.pdf', 'Page 1 of 3\n\n\n');
    expect(outcome.kind).toBe('PRIOR_YEAR_ENGAGEMENT_LETTER');
    expect(outcome.filenameOnly).toBe(true);
  });

  it('says nothing rather than guessing', () => {
    const outcome = classifyDocument('scan0142.pdf', 'Payroll remittance\nPD7A\nPeriod ending March 31');
    expect(outcome.kind).toBe('UNKNOWN');
    expect(outcome.markers).toEqual([]);
  });
});
