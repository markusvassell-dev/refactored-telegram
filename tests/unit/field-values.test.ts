import { describe, expect, it } from 'vitest';
import { normalizeValue, resolveFieldValue, type FieldValueCandidate } from '@element/services';

/**
 * Which value reaches the client, and what a reviewer is allowed to type.
 *
 * A token routinely carries several rows — Karbon's, last year's, a reviewer's
 * — and exactly one of them ends up in a signed letter. These tests pin that
 * choice down, because the failure mode is silent: a plausible wrong name in a
 * document nobody re-reads.
 */

function candidate(partial: Partial<FieldValueCandidate> & { value: string | null }): FieldValueCandidate {
  return { source: 'PRIOR_YEAR_DOCUMENT', ...partial };
}

describe('resolveFieldValue', () => {
  it('returns nothing when there is nothing to return', () => {
    expect(resolveFieldValue([])).toBeNull();
    expect(resolveFieldValue([candidate({ value: null }), candidate({ value: '' })])).toBeNull();
  });

  it('prefers the current Karbon record over last year’s letter', () => {
    const resolved = resolveFieldValue([
      candidate({ value: 'Last Year Ltd.', source: 'PRIOR_YEAR_DOCUMENT' }),
      candidate({ value: 'This Year Ltd.', source: 'KARBON_CLIENT' }),
    ]);

    expect(resolved).toEqual({
      value: 'This Year Ltd.',
      source: 'KARBON_CLIENT',
      basis: 'HIGHEST_PRIORITY_SOURCE',
    });
  });

  it('does not depend on the order the rows were read in', () => {
    const rows = [
      candidate({ value: 'Karbon', source: 'KARBON_CLIENT' }),
      candidate({ value: 'Prior', source: 'PRIOR_YEAR_DOCUMENT' }),
      candidate({ value: 'Typed', source: 'MANUAL_ENTRY' }),
    ];

    const forwards = resolveFieldValue(rows);
    const backwards = resolveFieldValue([...rows].reverse());

    // This is the defect that made the effective value depend on Postgres.
    expect(forwards).toEqual(backwards);
  });

  it('applies a resolved conflict, which is what makes resolving one mean anything', () => {
    const rows = [
      candidate({ value: 'Karbon', source: 'KARBON_CLIENT' }),
      candidate({ value: 'Prior', source: 'PRIOR_YEAR_DOCUMENT' }),
    ];

    const resolved = resolveFieldValue(rows, {
      status: 'RESOLVED',
      resolvedValue: 'Prior',
      resolvedSource: 'PRIOR_YEAR_DOCUMENT',
    });

    expect(resolved).toEqual({
      value: 'Prior',
      source: 'PRIOR_YEAR_DOCUMENT',
      basis: 'CONFLICT_RESOLUTION',
    });
  });

  it('ignores a conflict nobody has decided yet', () => {
    const resolved = resolveFieldValue([candidate({ value: 'Karbon', source: 'KARBON_CLIENT' })], {
      status: 'UNRESOLVED',
      resolvedValue: null,
      resolvedSource: null,
    });

    expect(resolved?.basis).toBe('HIGHEST_PRIORITY_SOURCE');
  });

  it('prefers a value someone confirmed over one nobody has looked at', () => {
    const resolved = resolveFieldValue([
      candidate({ value: 'Unreviewed', source: 'KARBON_CLIENT' }),
      candidate({ value: 'Confirmed', source: 'MANUAL_ENTRY', manuallyConfirmed: true }),
    ]);

    expect(resolved).toEqual({ value: 'Confirmed', source: 'MANUAL_ENTRY', basis: 'MANUALLY_CONFIRMED' });
  });

  it('lets an explicit override beat everything, including a conflict decision', () => {
    const resolved = resolveFieldValue(
      [
        candidate({ value: 'Karbon', source: 'KARBON_CLIENT' }),
        candidate({ value: 'Typed', source: 'MANUAL_ENTRY', manualOverrideValue: 'Corrected', manuallyConfirmed: true }),
      ],
      { status: 'RESOLVED', resolvedValue: 'Karbon', resolvedSource: 'KARBON_CLIENT' },
    );

    expect(resolved).toEqual({ value: 'Corrected', source: 'MANUAL_ENTRY', basis: 'MANUAL_OVERRIDE' });
  });

  it('treats an empty string as no value rather than as a blank answer', () => {
    const resolved = resolveFieldValue([
      candidate({ value: '', source: 'KARBON_CLIENT' }),
      candidate({ value: 'Prior', source: 'PRIOR_YEAR_DOCUMENT' }),
    ]);

    expect(resolved?.value).toBe('Prior');
  });
});

function definition(partial: Partial<Parameters<typeof normalizeValue>[1]> = {}) {
  return { label: 'Field', dataType: 'STRING', enumValues: [], maxLength: null, ...partial };
}

describe('normalizeValue', () => {
  it('treats an empty submission as clearing the value, not as the text ""', () => {
    expect(normalizeValue('   ', definition())).toEqual({
      value: null,
      valueDate: null,
      valueDecimal: null,
      valueBoolean: null,
    });
  });

  it('enforces a maximum length', () => {
    expect(() => normalizeValue('abcdef', definition({ maxLength: 5 }))).toThrow(/5 characters or fewer/);
    expect(normalizeValue('abcde', definition({ maxLength: 5 })).value).toBe('abcde');
  });

  it('accepts an email address and rejects a near miss', () => {
    expect(normalizeValue('officer@example.test', definition({ dataType: 'EMAIL' })).value).toBe(
      'officer@example.test',
    );
    expect(() => normalizeValue('officer@example', definition({ dataType: 'EMAIL' }))).toThrow(/email address/);
  });

  it('requires a complete telephone number', () => {
    expect(normalizeValue('(403) 555-0134', definition({ dataType: 'PHONE' })).value).toBe('(403) 555-0134');
    expect(() => normalizeValue('555-0134', definition({ dataType: 'PHONE' }))).toThrow(/complete telephone/);
  });

  it('stores a date as a real date and rejects one that does not exist', () => {
    const normalized = normalizeValue('2026-03-31', definition({ dataType: 'DATE' }));

    expect(normalized.value).toBe('2026-03-31');
    expect(normalized.valueDate?.toISOString()).toBe('2026-03-31T00:00:00.000Z');

    // February 31 must not be silently shifted into March.
    expect(() => normalizeValue('2026-02-31', definition({ dataType: 'DATE' }))).toThrow(/not a real date/);
    expect(() => normalizeValue('March 31, 2026', definition({ dataType: 'DATE' }))).toThrow(/YYYY-MM-DD/);
  });

  it('keeps money exact and refuses a negative fee', () => {
    const normalized = normalizeValue('$2,065', definition({ dataType: 'MONEY' }));

    expect(normalized.value).toBe('2065.00');
    expect(normalized.valueDecimal).toBe('2065.00');
    expect(() => normalizeValue('-5', definition({ dataType: 'MONEY' }))).toThrow(/cannot be negative/);
    expect(() => normalizeValue('about two thousand', definition({ dataType: 'MONEY' }))).toThrow(/must be an amount/);
  });

  it('accepts a four-digit year and nothing else', () => {
    expect(normalizeValue('2026', definition({ dataType: 'YEAR' })).value).toBe('2026');
    expect(() => normalizeValue('26', definition({ dataType: 'YEAR' }))).toThrow(/four-digit year/);
  });

  it('normalises yes and no into a stored boolean', () => {
    expect(normalizeValue('yes', definition({ dataType: 'BOOLEAN' }))).toMatchObject({
      value: 'Yes',
      valueBoolean: true,
    });
    expect(normalizeValue('No', definition({ dataType: 'BOOLEAN' }))).toMatchObject({
      value: 'No',
      valueBoolean: false,
    });
    expect(() => normalizeValue('maybe', definition({ dataType: 'BOOLEAN' }))).toThrow(/yes or no/);
  });

  it('accepts only a permitted enum value, and corrects its casing', () => {
    const enumValues = ['Trustee', 'Executor'];

    expect(normalizeValue('trustee', definition({ dataType: 'ENUM', enumValues })).value).toBe('Trustee');
    expect(() => normalizeValue('Beneficiary', definition({ dataType: 'ENUM', enumValues }))).toThrow(
      /Trustee, Executor/,
    );
  });

  it('normalises line endings in multiline text', () => {
    expect(normalizeValue('one\r\ntwo', definition({ dataType: 'MULTILINE' })).value).toBe('one\ntwo');
  });
});
