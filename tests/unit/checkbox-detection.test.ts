import { describe, expect, it } from 'vitest';
import { detectCheckboxStates } from '@element/documents';
import { DATE_FACTS, dateFactQuestion } from '@element/dates';

/**
 * Reading last year's selections out of last year's letter.
 *
 * The result is only ever a suggestion shown to a reviewer, so the important
 * property is not "detects as much as possible" — it is "never claims to know
 * something it does not". An undetectable checkbox must come back as `null`,
 * not as `false`, because `false` would quietly drop a service the client
 * actually bought.
 */

const CHECKED = '☒'; // BALLOT BOX WITH X
const UNCHECKED = '☐'; // BALLOT BOX

const CHECKBOXES = [
  { code: 't2.federal_return', label: 'Federal T2 return', anchorText: 'Federal T2 corporate income tax return', defaultChecked: true, alwaysChecked: false },
  { code: 't2.csrs4200', label: 'Compilation', anchorText: 'Compilation engagement under CSRS 4200', defaultChecked: false, alwaysChecked: false },
  { code: 't2.gifi', label: 'GIFI', anchorText: 'General Index of Financial Information', defaultChecked: false, alwaysChecked: false },
];

describe('detectCheckboxStates', () => {
  it('reads a ticked and an unticked box from the same document', () => {
    const text = [
      `${CHECKED} Federal T2 corporate income tax return`,
      `${UNCHECKED} Compilation engagement under CSRS 4200`,
      `${CHECKED} General Index of Financial Information`,
    ].join('\n');

    const detected = detectCheckboxStates(text, CHECKBOXES);

    expect(detected.map((entry) => [entry.code, entry.selected])).toEqual([
      ['t2.federal_return', true],
      ['t2.csrs4200', false],
      ['t2.gifi', true],
    ]);
  });

  it('returns null rather than false when the anchor is not in the document', () => {
    const detected = detectCheckboxStates(`${CHECKED} Something else entirely`, CHECKBOXES);

    for (const entry of detected) {
      expect(entry.selected).toBeNull();
      expect(entry.evidence).toBeNull();
    }
  });

  it('returns null when the anchor is found but carries no checkbox glyph', () => {
    const text = 'Federal T2 corporate income tax return';
    const [federal] = detectCheckboxStates(text, CHECKBOXES);

    expect(federal?.selected).toBeNull();
  });

  it('ignores an anchor that points at a token, because a filled letter has no tokens left', () => {
    const detected = detectCheckboxStates(`${CHECKED} Anything`, [
      { code: 'x', label: 'x', anchorText: 'Fee of [[pricing.t2_fee]]', defaultChecked: false, alwaysChecked: false },
    ]);

    expect(detected[0]?.selected).toBeNull();
  });

  it('uses the glyph closest to the anchor when both appear nearby', () => {
    // A preceding line's unticked box must not win over this line's ticked one.
    const text = `${UNCHECKED} Other service ${CHECKED} General Index of Financial Information`;
    const gifi = detectCheckboxStates(text, CHECKBOXES).find((entry) => entry.code === 't2.gifi');

    expect(gifi?.selected).toBe(true);
    expect(gifi?.evidence).toContain('General Index of Financial Information');
  });

  it('matches through smart quotes, dashes and collapsed whitespace', () => {
    const text = `${CHECKED} General   Index\nof Financial Information`;
    const gifi = detectCheckboxStates(text, CHECKBOXES).find((entry) => entry.code === 't2.gifi');

    expect(gifi?.selected).toBe(true);
  });

  it('records evidence a reviewer can check', () => {
    const text = `${CHECKED} Federal T2 corporate income tax return`;
    const [federal] = detectCheckboxStates(text, CHECKBOXES);

    expect(federal?.evidence).toContain('Federal T2 corporate income tax return');
    expect(federal?.evidence).toContain(CHECKED);
  });
});

describe('date fact catalogue', () => {
  it('gives every catalogued fact a question and an explanation', () => {
    for (const fact of DATE_FACTS) {
      expect(fact.question.endsWith('?')).toBe(true);
      expect(fact.help.length).toBeGreaterThan(20);
    }
  });

  it('still produces an askable question for a fact an administrator invented', () => {
    const fact = dateFactQuestion('hasNonResidentBeneficiary');

    expect(fact.key).toBe('hasNonResidentBeneficiary');
    expect(fact.question).toContain('has non resident beneficiary');
    expect(fact.help).toContain('no catalogued explanation');
  });
});
