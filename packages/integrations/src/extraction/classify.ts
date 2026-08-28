/**
 * What kind of document is this?
 *
 * The prior-year search stamped every candidate it wrote as
 * `PRIOR_YEAR_ENGAGEMENT_LETTER`, because that was the only thing it was
 * looking for. A scan reads a client's whole library, and calling a trial
 * balance an engagement letter is worse than not scanning it: the kind decides
 * which patterns are run against the text, whether its checkbox states are read
 * as last year's service selections, and what a reviewer is told they are
 * looking at.
 *
 * Content decides. A filename is a tiebreak between two content matches and
 * never a verdict on its own — the same rule the candidate scoring applies, for
 * the same reason: where a firm files something, and what it calls it, are
 * conventions rather than statements about what is inside.
 */

/** Mirrors `SourceDocumentKind` in the schema, without importing the database. */
export type DocumentKind =
  | 'PRIOR_YEAR_ENGAGEMENT_LETTER'
  | 'PRIOR_YEAR_SIGNED_LETTER'
  | 'FINAL_T2_RETURN'
  | 'COMPILED_FINANCIAL_STATEMENTS'
  | 'COMPILATION_ENGAGEMENT_REPORT'
  | 'FEDERAL_FILING_AUTHORIZATION'
  | 'PROVINCIAL_FILING_AUTHORIZATION'
  | 'ADJUSTING_JOURNAL_ENTRIES'
  | 'TRIAL_BALANCE'
  | 'INSTALMENT_SCHEDULE'
  | 'PAYMENT_SUMMARY'
  | 'NOTICE_OF_ASSESSMENT'
  | 'T1_RETURN'
  | 'T183'
  | 'OTHER_SUPPORTING_SCHEDULE'
  | 'UNKNOWN';

export interface ClassificationOutcome {
  kind: DocumentKind;
  /** The phrases that decided it, so a reviewer can see why. */
  markers: string[];
  /** True when only the filename suggested it. Never enough to accept on. */
  filenameOnly: boolean;
}

interface Rule {
  kind: DocumentKind;
  /** All of these must appear. */
  all?: string[];
  /** At least one of these must appear. */
  any?: string[];
  /** None of these may appear. */
  none?: string[];
  /** Higher wins when two rules match. */
  weight: number;
}

/**
 * The titles a letter gives itself.
 *
 * A document that announces its own type in its heading has settled the
 * question, and that is worth more than any phrase found later in it — because
 * of what an engagement letter *is*. It is a list of everything the firm
 * undertakes to produce: the T2 return, the T183CORP authorisation, the
 * compiled statements, the compilation engagement report, the trial balance.
 * Every one of those is another kind in this table, named in the letter's own
 * prose.
 *
 * So the letter matched every rule keyed on the documents it promised, and lost
 * to whichever scored highest — the firm's real T2 letter came out as a
 * compilation report, and with that rule fixed, as a T183CORP authorisation.
 * Patching the rules it collided with treats one collision at a time; a letter
 * that names itself outranking the documents it merely describes is the rule
 * that ends the class.
 */
const ENGAGEMENT_LETTER_TITLES = [
  'corporate income tax (t2) engagement letter',
  't2 engagement letter',
  't1 personal income tax engagement letter',
  't3 trust income tax engagement letter',
];

/**
 * Ordered by how specific the evidence is, not by how common the document is.
 * A signed letter is an engagement letter *plus* evidence of signature, so it
 * has to outweigh the plain letter or every signed copy would read as unsigned.
 */
const RULES: Rule[] = [
  {
    kind: 'PRIOR_YEAR_SIGNED_LETTER',
    all: ['engagement letter'],
    any: [
      'electronically signed',
      'adobe acrobat sign',
      'signature of authorized signing officer',
      'digitally signed by',
      'signed by:',
    ],
    weight: 12,
  },
  {
    // A letter that states its own type, above every kind it goes on to list.
    kind: 'PRIOR_YEAR_ENGAGEMENT_LETTER',
    any: ENGAGEMENT_LETTER_TITLES,
    weight: 11,
  },
  {
    // Untitled, so it carries no more weight than the documents it mentions —
    // a page saying only "engagement letter" is a weak claim, and a real return
    // or authorisation naming one still wins.
    kind: 'PRIOR_YEAR_ENGAGEMENT_LETTER',
    any: ['engagement letter'],
    weight: 8,
  },
  {
    kind: 'FEDERAL_FILING_AUTHORIZATION',
    any: ['t183corp', 't183 corp', 'information return for corporations filing electronically'],
    weight: 9,
  },
  {
    kind: 'T183',
    any: ['t183', 'information return for electronic filing of an individual income tax'],
    weight: 7,
  },
  {
    kind: 'NOTICE_OF_ASSESSMENT',
    any: ['notice of assessment', 'notice of reassessment', 'avis de cotisation'],
    weight: 9,
  },
  {
    kind: 'FINAL_T2_RETURN',
    any: [
      't2 corporation income tax return',
      't2 short return',
      'schedule 200',
      'corporation income tax return',
    ],
    weight: 9,
  },
  {
    kind: 'T1_RETURN',
    any: ['t1 general', 'income tax and benefit return'],
    weight: 8,
  },
  {
    kind: 'COMPILATION_ENGAGEMENT_REPORT',
    /*
     * A report reports; naming the standard is a citation.
     *
     * `csrs 4200` on its own used to be enough, and every T2 engagement letter
     * that offers optional compilation cites it — in the paragraph explaining
     * what the firm *would* do if the client selected the service. That read a
     * letter as a report, and since the kind picks the pattern set, the letter
     * was then scanned for corporation names instead of for the prior-year fee.
     * The scan reported success and the fee stayed empty.
     */
    any: ['compilation engagement report', 'we have compiled'],
    // Statements *with* a compilation report are the statements; the report on
    // its own is the report. No engagement-letter guard is needed here — a
    // titled letter already outranks this rule, and a guard that cannot change
    // an outcome reads as protection while providing none.
    none: ['balance sheet', 'statement of financial position'],
    weight: 9,
  },
  {
    kind: 'COMPILED_FINANCIAL_STATEMENTS',
    any: [
      'statement of financial position',
      'balance sheet',
      'statement of operations',
      'notice to reader',
      'compilation engagement report',
    ],
    // No letter guard here, deliberately. This rule sits below the letter on
    // weight, so a letter describing the statements it may produce already loses
    // to it — a guard would read as protection while being unable to change any
    // outcome. What keeps that true is the weights, so the test says so.
    weight: 7,
  },
  {
    kind: 'TRIAL_BALANCE',
    all: ['trial balance'],
    any: ['debit', 'credit'],
    weight: 9,
  },
  {
    kind: 'ADJUSTING_JOURNAL_ENTRIES',
    any: ['adjusting journal entr', 'adjusting entries'],
    weight: 9,
  },
  {
    kind: 'INSTALMENT_SCHEDULE',
    any: ['instalment schedule', 'instalment payments', 'installment schedule'],
    weight: 8,
  },
  {
    kind: 'PAYMENT_SUMMARY',
    any: ['payment summary', 'statement of account'],
    weight: 6,
  },
];

/** Filenames are a tiebreak only. Deliberately few, and deliberately obvious. */
const FILENAME_HINTS: { kind: DocumentKind; any: string[] }[] = [
  { kind: 'PRIOR_YEAR_ENGAGEMENT_LETTER', any: ['engagement letter', 'engagementletter'] },
  { kind: 'FINAL_T2_RETURN', any: ['t2 return', 't2return', 't2 jacket'] },
  { kind: 'COMPILED_FINANCIAL_STATEMENTS', any: ['financial statements', 'financialstatements', ' fs '] },
  { kind: 'TRIAL_BALANCE', any: ['trial balance', 'trialbalance', ' tb '] },
  { kind: 'NOTICE_OF_ASSESSMENT', any: ['notice of assessment', 'noa'] },
];

function normalise(value: string): string {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function classifyDocument(fileName: string, text: string): ClassificationOutcome {
  const body = normalise(text);
  const name = ` ${normalise(fileName)} `;

  const matches: { rule: Rule; markers: string[] }[] = [];

  for (const rule of RULES) {
    if (rule.none?.some((phrase) => body.includes(phrase))) continue;

    const required = rule.all ?? [];
    if (!required.every((phrase) => body.includes(phrase))) continue;

    const optional = rule.any ?? [];
    const hit = optional.filter((phrase) => body.includes(phrase));
    if (optional.length > 0 && hit.length === 0) continue;

    matches.push({ rule, markers: [...required, ...hit] });
  }

  if (matches.length > 0) {
    matches.sort((a, b) => b.rule.weight - a.rule.weight || a.rule.kind.localeCompare(b.rule.kind));

    const best = matches[0] as { rule: Rule; markers: string[] };
    const tied = matches.filter((match) => match.rule.weight === best.rule.weight);

    if (tied.length > 1) {
      // Two kinds fit the content equally. *Now* the filename may speak.
      const named = tied.find((match) => FILENAME_HINTS.some(
        (hint) => hint.kind === match.rule.kind && hint.any.some((phrase) => name.includes(phrase)),
      ));
      if (named) return { kind: named.rule.kind, markers: named.markers, filenameOnly: false };
    }

    return { kind: best.rule.kind, markers: best.markers, filenameOnly: false };
  }

  // Nothing in the text. A filename alone is recorded as such, so a caller can
  // refuse to act on it — which is what the acceptance gate does.
  for (const hint of FILENAME_HINTS) {
    const matched = hint.any.filter((phrase) => name.includes(phrase));
    if (matched.length > 0) return { kind: hint.kind, markers: matched, filenameOnly: true };
  }

  return { kind: 'UNKNOWN', markers: [], filenameOnly: false };
}
