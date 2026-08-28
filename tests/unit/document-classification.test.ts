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

/**
 * The letter that describes the service it is offering.
 *
 * Found by running the firm's own 2026 T2 letter through the classifier. That
 * letter offers optional CSRS 4200 compilation, so it names the standard and
 * the report repeatedly — in the paragraph explaining what would happen *if the
 * client selected it*. Read as evidence of what the document is, that wording
 * turned every T2 engagement letter the firm issues into a compilation report.
 *
 * The consequence was not a mislabelled row. The kind chooses the pattern set,
 * so the letter was then read with CRA patterns, which carry no fee — and the
 * prior-year fee is the one value the whole scan exists to recover. The scan
 * reported success and the fee stayed empty, on every T2 file.
 */
const T2_LETTER_OFFERING_COMPILATION = [
  'CORPORATE TAX & COMPILATION SERVICES',
  'CORPORATE INCOME TAX (T2) ENGAGEMENT LETTER',
  'T2 preparation and filing, with optional CSRS 4200 compiled financial information',
  'To: MATADOR PIZZA HILLHURST INC.',
  'This letter confirms the terms under which Element Accounting will provide corporate income tax',
  'services and, only when selected in Schedule A, compilation engagement services.',
  'If Schedule A identifies “Compilation engagement under CSRS 4200” as an included service, our',
  'objective also includes assisting management in preparing compiled financial information and',
  'issuing a compilation engagement report in accordance with Canadian Standard on Related',
  'Services (CSRS) 4200, Compilation Engagements. If that service is not selected, no compilation',
  'engagement is included and no compilation engagement report will be issued.',
  'T2 preparation fee\t$1,800.00',
].join('\n');

describe('a letter that offers compilation is still a letter', () => {
  it('does not read the firm’s own T2 letter as a compilation report', () => {
    const outcome = classifyDocument('2025 Engagement Letter.pdf', T2_LETTER_OFFERING_COMPILATION);
    expect(outcome.kind).toBe('PRIOR_YEAR_ENGAGEMENT_LETTER');
  });

  /**
   * The general case, and the reason the fix is a weight rather than a guard.
   *
   * A letter lists everything the firm will produce, so it collides with a rule
   * for each: the return, the filing authorisation, the statements, the trial
   * balance. Fixing the compilation collision alone just handed the letter to
   * whichever rule scored next — which is what happened, and this is the test
   * that would have said so.
   */
  it('survives naming every document it promises to prepare', () => {
    const letter = [
      'CORPORATE INCOME TAX (T2) ENGAGEMENT LETTER',
      'Our services include:',
      'preparing the T2 Corporation Income Tax Return and the schedules ordinarily required;',
      'preparing the General Index of Financial Information from a trial balance with debit and credit columns;',
      'electronically filing after receiving the signed T183CORP required by the Canada Revenue Agency;',
      'issuing a compilation engagement report under CSRS 4200; and',
      'reviewing the notice of assessment when it arrives.',
    ].join('\n');

    expect(classifyDocument('letter.pdf', letter).kind).toBe('PRIOR_YEAR_ENGAGEMENT_LETTER');
  });

  it('still lets a real T183CORP be a T183CORP', () => {
    // The other side of that weight: the letter must not swallow the documents
    // it describes when one of them turns up on its own.
    const outcome = classifyDocument(
      'auth.pdf',
      'T183CORP Information Return for Corporations Filing Electronically\nAs described in our engagement letter.',
    );
    expect(outcome.kind).toBe('FEDERAL_FILING_AUTHORIZATION');
  });

  it('does not read it as a set of financial statements either', () => {
    // The other rule carrying "compilation engagement report" in its markers.
    // Nothing excludes a letter from it: it simply sits below the letter on
    // weight. That ordering is the whole guarantee, so it is worth a test of its
    // own — raise the statements rule above 8 and this is what notices.
    const outcome = classifyDocument('letter.pdf', `${T2_LETTER_OFFERING_COMPILATION}\nStatement of operations`);
    expect(outcome.kind).toBe('PRIOR_YEAR_ENGAGEMENT_LETTER');
  });

  it('still recognises a real compilation report that cites its engagement letter', () => {
    // The trap in the other direction, and the reason only the *titled* forms
    // are excluded. Were "engagement letter" enough to disqualify a report, this
    // would fall through to the letter rule and be scanned for a fee it does
    // not have — a worse defect than the one being fixed.
    const outcome = classifyDocument(
      'report.pdf',
      [
        'COMPILATION ENGAGEMENT REPORT',
        'On the basis of information provided by management, we have compiled the statement of',
        'assets and liabilities of Northwind Holdings Ltd. as described in our engagement letter.',
      ].join('\n'),
    );
    expect(outcome.kind).toBe('COMPILATION_ENGAGEMENT_REPORT');
  });

  it('no longer treats a bare citation of the standard as a report', () => {
    // Naming CSRS 4200 says which rules would apply, not that this document is
    // the report they produce.
    const outcome = classifyDocument('fees.pdf', 'Fee schedule\nCompilation work is billed under CSRS 4200.');
    expect(outcome.kind).not.toBe('COMPILATION_ENGAGEMENT_REPORT');
  });
});
