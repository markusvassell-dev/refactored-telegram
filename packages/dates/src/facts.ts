/**
 * The boolean facts date rules depend on.
 *
 * A rule that needs a fact produces a *blocked* date until someone answers it,
 * because the alternative — assuming the common case — silently puts a wrong
 * legal deadline into a signed letter. This catalogue turns a fact key into a
 * question a reviewer can actually answer, and states plainly what each answer
 * changes.
 *
 * Rules are administrator-editable, so a rule may reference a fact that is not
 * catalogued here. `dateFactQuestion` therefore always returns something
 * askable rather than failing.
 */

export interface DateFactDefinition {
  key: string;
  /** Short form, for a table cell or an audit entry. */
  label: string;
  /** Asked of a reviewer, phrased so "yes" is unambiguous. */
  question: string;
  /** What answering changes, so the reviewer knows why it is being asked. */
  help: string;
}

export const DATE_FACTS: readonly DateFactDefinition[] = [
  {
    key: 'isSelfEmployedOrSpouseOfSelfEmployed',
    label: 'Taxpayer (or spouse/common-law partner) has self-employment income',
    question:
      'Did the taxpayer — or their spouse or common-law partner — report self-employment income for this taxation year?',
    help: 'Yes moves the T1 filing deadline to June 15. The balance-due date is unchanged either way.',
  },
  {
    key: 'qualifiesForThreeMonthBalanceDueDay',
    label: 'Corporation qualifies for the three-month balance-due day',
    question: 'Does the corporation qualify for the three-month balance-due day?',
    help:
      'Yes gives a balance-due day three months after the year-end instead of two. This depends on small-business ' +
      'deduction eligibility and associated-corporation taxable income, so it is a judgement, not a lookup.',
  },
] as const;

const BY_KEY = new Map(DATE_FACTS.map((fact) => [fact.key, fact]));

/**
 * Splits `isSelfEmployed` into `is self employed` for an uncatalogued fact.
 * An all-capitals word is left alone, so `hasT1Income` keeps its `T1`.
 */
function humanise(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .split(' ')
    .map((word) => (/^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word))
    .join(' ');
}

export function dateFactQuestion(key: string): DateFactDefinition {
  const known = BY_KEY.get(key);
  if (known) return known;

  return {
    key,
    label: humanise(key),
    question: `Is it true that: ${humanise(key)}?`,
    help: 'This fact is referenced by a date rule but has no catalogued explanation. Confirm the rule before answering.',
  };
}
