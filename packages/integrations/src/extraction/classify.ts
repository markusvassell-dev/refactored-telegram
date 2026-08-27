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
    weight: 10,
  },
  {
    kind: 'PRIOR_YEAR_ENGAGEMENT_LETTER',
    any: [
      'corporate income tax (t2) engagement letter',
      't2 engagement letter',
      't1 personal income tax engagement letter',
      't3 trust income tax engagement letter',
      'engagement letter',
    ],
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
    any: ['compilation engagement report', 'csrs 4200'],
    // Statements *with* a compilation report are the statements; the report on
    // its own is the report.
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
