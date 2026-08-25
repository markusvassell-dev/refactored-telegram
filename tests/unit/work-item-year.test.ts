import { describe, expect, it } from 'vitest';
import { deriveTaxYear, rollYearEndForward } from '../../packages/integrations/src/karbon/work-item-year';

/**
 * Which year a rolled-forward engagement is for.
 *
 * Karbon publishes no tax-year field on a work item, so this reads one out of
 * the title — and a wrong answer here does not fail. It produces a
 * correct-looking engagement letter for the wrong period, priced against the
 * wrong prior year and carrying the wrong filing deadline, which is exactly the
 * class of defect that reaches a client.
 *
 * So the assertions below are mostly about **refusing**. The deterministic path
 * — last year's engagement plus one — is the one that should usually win, and
 * that only happens if this returns null whenever it is not certain.
 */

const now = new Date('2026-08-24T00:00:00Z');

describe('deriveTaxYear', () => {
  it('reads a year a title states once', () => {
    expect(deriveTaxYear({ title: 'T2 year end 2026' }, now)).toBe(2026);
    expect(deriveTaxYear({ title: '2025 personal tax' }, now)).toBe(2025);
  });

  it('refuses a title naming two years, rather than picking one', () => {
    // `2025/2026` is the fiscal shorthand a firm writes constantly, and there
    // is no defensible way to choose. The caller falls back to prior year + 1.
    expect(deriveTaxYear({ title: '2025/2026 year end' }, now)).toBeNull();
    expect(deriveTaxYear({ title: 'T2 2026 (was 2025)' }, now)).toBeNull();
  });

  it('repeats of the same year are not ambiguity', () => {
    expect(deriveTaxYear({ title: '2026 T2 — 2026 year end' }, now)).toBe(2026);
  });

  it('ignores four digits that could not be a tax year', () => {
    expect(deriveTaxYear({ title: 'Suite 1200 Centre Street' }, now)).toBeNull();
    expect(deriveTaxYear({ title: 'Year end 2099' }, now)).toBeNull();
    expect(deriveTaxYear({ title: 'Year end 1998' }, now)).toBeNull();
  });

  it('ignores a run of digits that merely contains a year', () => {
    // A business number or an invoice reference is not a period.
    expect(deriveTaxYear({ title: 'BN 820261234RC0001' }, now)).toBeNull();
  });

  it('accepts next year and the one after, because work is opened ahead', () => {
    expect(deriveTaxYear({ title: 'Planning 2028' }, now)).toBe(2028);
    expect(deriveTaxYear({ title: 'Planning 2029' }, now)).toBeNull();
  });

  it('finds nothing in a title with no year at all', () => {
    expect(deriveTaxYear({ title: 'Corporate year end' }, now)).toBeNull();
  });
});

describe('rollYearEndForward', () => {
  it('moves an ordinary year-end on by a year', () => {
    expect(rollYearEndForward(new Date('2025-06-30T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(rollYearEndForward(new Date('2025-12-31T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-12-31');
  });

  it('keeps a leap-day year-end at the end of February', () => {
    // The case worth a function. Adding a year naively lands on 1 March, which
    // silently moves a year-end into the next month — and every deadline
    // computed from it with it.
    expect(rollYearEndForward(new Date('2028-02-29T00:00:00Z')).toISOString().slice(0, 10)).toBe('2029-02-28');
  });

  it('rolls into a leap year without losing the day', () => {
    expect(rollYearEndForward(new Date('2027-02-28T00:00:00Z')).toISOString().slice(0, 10)).toBe('2028-02-28');
  });

  it('is stable when applied repeatedly', () => {
    let date = new Date('2028-02-29T00:00:00Z');
    for (let index = 0; index < 4; index += 1) date = rollYearEndForward(date);
    expect(date.toISOString().slice(0, 10)).toBe('2032-02-28');
  });
});
