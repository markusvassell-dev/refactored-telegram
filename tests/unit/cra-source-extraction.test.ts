import { describe, expect, it } from 'vitest';
import { DeterministicExtractor } from '@element/integrations';

/**
 * Reading a CRA form rather than one of this firm's letters.
 *
 * The engagement-letter patterns are anchored on wording the firm chose — "To:",
 * "Attention:", "Preferred email" — so pointing them at a T2 return finds
 * nothing at all. These are anchored on CRA's own form labels and the standard
 * headings of a compiled statement, which no firm gets to choose.
 *
 * The most valuable thing here is the business number: it is the identifier the
 * acceptance gate needs before it will read anything automatically, and the one
 * a client record most often lacks.
 */

const extractor = new DeterministicExtractor('CRA_SOURCE');

async function read(text: string, wanted: string[]) {
  const result = await extractor.extract({
    documentId: 'doc-1',
    documentHash: 'hash-1',
    text: { pages: [{ pageNumber: 1, text }], fullText: text, requiresOcr: false },
    wantedTokens: wanted,
  });
  return new Map(result.values.map((value) => [value.token, value]));
}

const T2_JACKET = [
  'T2 Corporation Income Tax Return',
  "Corporation's name: Northwind Holdings Ltd.",
  'Business Number (BN): 12345 6789 RC0001',
  'Tax year-end: 2025-03-31',
  'Name of signing officer: Dana Whitfield',
  'Position, office or rank: President',
].join('\n');

const NOTICE_OF_ASSESSMENT = [
  'Notice of Assessment',
  '',
  'Northwind Holdings Ltd.',
  '100 Sample Street',
  '',
  'Business Number (BN): 12345 6789 RC0001',
  'Tax year-end: March 31, 2025',
  'Balance owing: $4,210.00',
].join('\n');

const STATEMENTS = [
  'Northwind Holdings Ltd.',
  'Statement of Financial Position',
  'As at March 31, 2025',
  'Cash 51,204',
].join('\n');

describe('reading a T2 return', () => {
  it('finds the business number, which is what lets a scan trust the document', async () => {
    const values = await read(T2_JACKET, ['corporation.business_number']);
    expect(values.get('corporation.business_number')?.value).toBe('12345 6789 RC0001');
  });

  it('finds the corporation name and year-end', async () => {
    const values = await read(T2_JACKET, ['corporation.legal_name', 'corporation.year_end']);
    expect(values.get('corporation.legal_name')?.value).toBe('Northwind Holdings Ltd.');
    expect(values.get('corporation.year_end')?.dateValue).toBe('2025-03-31');
  });

  it('finds the signing officer from the certification page', async () => {
    const values = await read(T2_JACKET, ['signer.officer_name', 'signer.officer_title']);
    expect(values.get('signer.officer_name')?.value).toBe('Dana Whitfield');
    expect(values.get('signer.officer_title')?.value).toBe('President');
  });
});

describe('reading a notice of assessment', () => {
  it('finds the business number and the year-end', async () => {
    const values = await read(NOTICE_OF_ASSESSMENT, ['corporation.business_number', 'corporation.year_end']);
    expect(values.get('corporation.business_number')?.value).toBe('12345 6789 RC0001');
    expect(values.get('corporation.year_end')?.dateValue).toBe('2025-03-31');
  });
});

describe('reading financial statements', () => {
  it('takes the entity from the line above the statement title', async () => {
    const values = await read(STATEMENTS, ['corporation.legal_name', 'corporation.year_end']);
    expect(values.get('corporation.legal_name')?.value).toBe('Northwind Holdings Ltd.');
    expect(values.get('corporation.year_end')?.dateValue).toBe('2025-03-31');
  });
});

describe('what it deliberately will not read', () => {
  /**
   * A deadline here is computed from a rule and last year's is simply wrong for
   * this year; a fee comes from the pricing engine. A pattern able to supply
   * either would be a route for a stale value to reach a letter past the thing
   * that is supposed to decide it.
   */
  it('reads no deadline and no fee, even from a document containing both', async () => {
    const values = await read(
      [T2_JACKET, 'Filing due date: September 30, 2025', 'T2 preparation fee $1,800.00', 'Balance due: April 30, 2025'].join(
        '\n',
      ),
      ['dates.filing_due', 'dates.balance_due', 'pricing.t2_fee', 'pricing.billing_basis'],
    );

    expect(values.size).toBe(0);
  });

  it('supports only the tokens it can actually find', () => {
    expect(extractor.supports('corporation.business_number')).toBe(true);
    expect(extractor.supports('pricing.t2_fee')).toBe(false);
    expect(extractor.supports('dates.filing_due')).toBe(false);
  });

  it('leaves the letter patterns exactly as they were', async () => {
    const letters = new DeterministicExtractor();
    expect(letters.supports('pricing.t2_fee')).toBe(true);
    expect(letters.supports('pricing.billing_basis')).toBe(true);
  });
});
