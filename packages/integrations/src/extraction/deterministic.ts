import { money } from '@element/shared';
import { pageOf } from './pdf-text.js';
import {
  truncateEvidence,
  type ExtractedValue,
  type ExtractionRequest,
  type ExtractionResult,
  type FieldExtractor,
} from './types.js';

/**
 * Deterministic, pattern-based extraction.
 *
 * These patterns are anchored on the wording of the approved templates and on
 * standard CRA form labels. A pattern either matches exactly or it does not
 * match at all — it never produces a best guess. Anything it cannot find is
 * reported as missing so a human supplies it.
 */

interface Pattern {
  token: string;
  /** Capturing group 1 is the value. */
  regexes: RegExp[];
  kind: 'STRING' | 'MONEY' | 'DATE' | 'YEAR';
}

const MONTHS = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const DATE = `(${MONTHS}\\s+\\d{1,2},\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})`;
const AMOUNT = '\\$?\\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\\.[0-9]{2})?|[0-9]+(?:\\.[0-9]{2})?)';

/**
 * Prior-year engagement letter patterns.
 *
 * These read *client-specific information* out of a prior-year letter. They
 * deliberately do not read legal wording: the approved master template is the
 * only source of that.
 */
const ENGAGEMENT_LETTER_PATTERNS: Pattern[] = [
  { token: 'corporation.legal_name', kind: 'STRING', regexes: [/\bTo:\s*(.+?)(?:\n|Business Number)/i] },
  {
    token: 'corporation.business_number',
    kind: 'STRING',
    regexes: [/Business Number:?\s*([0-9]{5}\s*[0-9]{4}\s*[A-Z]{2}[0-9]{4}|[0-9A-Z ]{9,20})/i],
  },
  { token: 'corporation.year_end', kind: 'DATE', regexes: [new RegExp(`Taxation year-?end:?\\s*${DATE}`, 'i')] },
  { token: 'signer.officer_name', kind: 'STRING', regexes: [/\bAttention:\s*(.+?)(?:\n|$)/i] },
  {
    token: 'signer.officer_title',
    kind: 'STRING',
    regexes: [/\bTitle\s*[\t|]?\s*(.+?)(?:\n|Date)/i],
  },
  {
    token: 'signer.officer_email',
    kind: 'STRING',
    regexes: [/Preferred email\s*[\t|]?\s*([^\s@]+@[^\s@]+\.[^\s@,;]+)/i],
  },
  {
    token: 'pricing.t2_fee',
    kind: 'MONEY',
    regexes: [new RegExp(`T2 preparation fee\\s*[\\t|]?\\s*${AMOUNT}`, 'i')],
  },
  {
    token: 'pricing.compilation_fee',
    kind: 'MONEY',
    regexes: [new RegExp(`CSRS 4200 compilation fee\\s*[\\t|]?\\s*${AMOUNT}`, 'i')],
  },
  {
    token: 'pricing.billing_basis',
    kind: 'STRING',
    regexes: [/Billing basis\s*[\t|]?\s*(.+?)(?:\n|Retainer)/i],
  },
  {
    token: 'pricing.payment_terms_short',
    kind: 'STRING',
    regexes: [/Payment terms\s*[\t|]?\s*(.+?)(?:\n|Additional work)/i],
  },
  { token: 'compilation.intended_use', kind: 'STRING', regexes: [/Intended use\s*[\t|]?\s*(.+?)(?:\n|Intended users)/i] },
  {
    token: 'compilation.intended_users',
    kind: 'STRING',
    regexes: [/Intended users\s*[\t|]?\s*(.+?)(?:\n|Basis of accounting)/i],
  },
  {
    token: 'compilation.basis_of_accounting',
    kind: 'STRING',
    regexes: [/Basis of accounting\s*[\t|]?\s*(.+?)(?:\n|Financial information)/i],
  },
  {
    token: 'compilation.report_delivery',
    kind: 'STRING',
    regexes: [/Report delivery\s*[\t|]?\s*(.+?)(?:\n|$)/i],
  },
  // T1 joint
  { token: 'taxpayer1.full_legal_name', kind: 'STRING', regexes: [/Client\s*[\t|]?\s*(.+?)\s+and\s+/i] },
  { token: 'taxpayer2.full_legal_name', kind: 'STRING', regexes: [/Client\s*[\t|]?\s*.+?\s+and\s+(.+?)(?:\n|Address)/i] },
  { token: 'pricing.t1_fee', kind: 'MONEY', regexes: [new RegExp(`Fixed fee of\\s*${AMOUNT}`, 'i')] },
  // T3
  { token: 'trust.legal_name', kind: 'STRING', regexes: [/Trust or estate\s*[\t|]?\s*(.+?)(?:\n|Address)/i] },
  { token: 'trust.account_number', kind: 'STRING', regexes: [/Trust account number\s*[\t|]?\s*(.+?)(?:\n|Tax year)/i] },
  { token: 'trust.year_end', kind: 'DATE', regexes: [new RegExp(`Tax year-?end\\s*[\\t|]?\\s*${DATE}`, 'i')] },
  {
    token: 'representative.name_and_capacity',
    kind: 'STRING',
    regexes: [/Authorized representative\s*[\t|]?\s*(.+?)(?:\n|Date)/i],
  },
  { token: 'pricing.t3_fee', kind: 'MONEY', regexes: [new RegExp(`Fixed fee of\\s*${AMOUNT}`, 'i')] },
];

/** Final-document patterns used to build a completion cover letter. */
const COVER_LETTER_PATTERNS: Pattern[] = [
  {
    token: 'amounts.federal_balance',
    kind: 'MONEY',
    regexes: [
      new RegExp(`Balance unpaid[^\\n]{0,40}${AMOUNT}`, 'i'),
      new RegExp(`Total (?:amount )?(?:payable|owing)[^\\n]{0,40}${AMOUNT}`, 'i'),
    ],
  },
  {
    token: 'amounts.provincial_balance',
    kind: 'MONEY',
    regexes: [new RegExp(`Provincial (?:tax|income tax)[^\\n]{0,60}${AMOUNT}`, 'i')],
  },
  {
    token: 'client.year_end',
    kind: 'DATE',
    regexes: [new RegExp(`(?:Tax year-?end|Year ended|As at)\\s*:?\\s*${DATE}`, 'i')],
  },
  {
    token: 'client.legal_name',
    kind: 'STRING',
    regexes: [/Corporation'?s? name\s*:?\s*(.+?)(?:\n|$)/i, /^\s*(.+?)\s*\n\s*Balance Sheet/im],
  },
  {
    token: 'amounts.estimated_balance',
    kind: 'MONEY',
    regexes: [new RegExp(`(?:Balance owing|Refund|Amount enclosed)[^\\n]{0,40}${AMOUNT}`, 'i')],
  },
];

/**
 * CRA forms and accounting statements.
 *
 * The engagement-letter patterns are anchored on this firm's own wording — "To:",
 * "Attention:", "Preferred email" — so pointing them at a T2 return finds
 * nothing. These are anchored on CRA's form labels and the standard headings of
 * a compiled statement instead, which are not this firm's choices to make and so
 * are stable across every client.
 *
 * Deliberately narrow. It reads identity and period and nothing else: no dates
 * and no fees. A deadline here is computed from a rule, and last year's is
 * simply wrong for this year; a fee comes from the pricing engine. A pattern
 * that could supply either would be a way for a stale value to reach a letter
 * past the thing that is supposed to decide it.
 */
const CRA_SOURCE_PATTERNS: Pattern[] = [
  {
    token: 'corporation.legal_name',
    kind: 'STRING',
    regexes: [
      // The T2 jacket's own label.
      /Corporation'?s? name\s*:?\s*(.+?)(?:\n|$)/i,
      // Statements name the entity on the line above the statement title.
      /^\s*(.+?)\s*\n\s*(?:Balance Sheet|Statement of Financial Position|Trial Balance)/im,
      // A notice of assessment addresses the corporation directly.
      /(?:Notice of (?:Re)?[Aa]ssessment)[\s\S]{0,120}?\n\s*([A-Z][^\n]{3,80}(?:Ltd\.?|Inc\.?|Corp\.?|Limited|Incorporated))/,
    ],
  },
  {
    token: 'corporation.business_number',
    kind: 'STRING',
    regexes: [
      // The highest-value pattern in the set: this is the identifier the
      // acceptance gate wants, and the one a client record most often lacks.
      /Business Number\s*\(?BN\)?\s*:?\s*([0-9]{5}\s?[0-9]{4}\s?[A-Z]{2}\s?[0-9]{4})/i,
      /\b([0-9]{9}\s?RC\s?[0-9]{4})\b/,
      /\bBN\s*\/?\s*(?:RC)?\s*:?\s*([0-9]{5}\s?[0-9]{4}\s?RC\s?[0-9]{4})\b/i,
    ],
  },
  {
    token: 'corporation.year_end',
    kind: 'DATE',
    regexes: [
      new RegExp(`Tax(?:ation)? year[- ]end\\s*:?\\s*${DATE}`, 'i'),
      new RegExp(`(?:Year ended|For the year ended|As at)\\s*:?\\s*${DATE}`, 'i'),
    ],
  },
  {
    token: 'signer.officer_name',
    kind: 'STRING',
    regexes: [
      /Name of (?:the )?(?:authorized )?signing officer\s*:?\s*(.+?)(?:\n|$)/i,
      /I,\s*(.+?),\s*(?:am|certify)/i,
    ],
  },
  {
    token: 'signer.officer_title',
    kind: 'STRING',
    regexes: [/Position, office or rank\s*:?\s*(.+?)(?:\n|$)/i],
  },
];

function parseValue(raw: string, kind: Pattern['kind']): Partial<ExtractedValue> {
  const trimmed = raw.replace(/\s+/g, ' ').trim();

  if (kind === 'MONEY') {
    try {
      return { value: trimmed, numericValue: money(trimmed).toFixed(2) };
    } catch {
      return { value: trimmed };
    }
  }

  if (kind === 'DATE') {
    const parsed = new Date(`${trimmed} UTC`);
    return Number.isNaN(parsed.getTime())
      ? { value: trimmed }
      : { value: trimmed, dateValue: parsed.toISOString().slice(0, 10) };
  }

  return { value: trimmed };
}

/** Which pattern set to run. The default keeps every existing caller unchanged. */
export type ExtractorKind = 'ENGAGEMENT_LETTER' | 'COVER_LETTER_SOURCE' | 'CRA_SOURCE';

const PATTERNS_BY_KIND: Record<ExtractorKind, Pattern[]> = {
  ENGAGEMENT_LETTER: ENGAGEMENT_LETTER_PATTERNS,
  COVER_LETTER_SOURCE: COVER_LETTER_PATTERNS,
  CRA_SOURCE: CRA_SOURCE_PATTERNS,
};

export class DeterministicExtractor implements FieldExtractor {
  readonly name = 'deterministic-patterns';
  readonly method = 'DETERMINISTIC_PATTERN' as const;
  readonly priority = 3;

  private readonly patterns: Pattern[];

  constructor(kind: ExtractorKind = 'ENGAGEMENT_LETTER') {
    this.patterns = PATTERNS_BY_KIND[kind];
  }

  supports(token: string): boolean {
    return this.patterns.some((pattern) => pattern.token === token);
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const values: ExtractedValue[] = [];
    const warnings: string[] = [];
    const blockers: string[] = [];

    if (request.text.requiresOcr) {
      blockers.push(
        'This document has no readable text layer. It must be reviewed by a person, or OCR must be enabled.',
      );
      return { values: [], missingTokens: [...request.wantedTokens], blockers, warnings };
    }

    for (const token of request.wantedTokens) {
      const pattern = this.patterns.find((candidate) => candidate.token === token);
      if (!pattern) continue;

      for (const regex of pattern.regexes) {
        const match = regex.exec(request.text.fullText);
        const captured = match?.[1];
        if (!captured || captured.trim() === '') continue;

        const parsed = parseValue(captured, pattern.kind);
        values.push({
          token,
          value: parsed.value ?? null,
          numericValue: parsed.numericValue ?? null,
          dateValue: parsed.dateValue ?? null,
          booleanValue: null,
          method: this.method,
          // A deterministic pattern match is exact by construction.
          confidence: 1,
          evidence: [
            {
              sourceDocumentId: request.documentId,
              sourceDocumentHash: request.documentHash,
              pageNumber: pageOf(request.text, match[0]),
              supportingText: truncateEvidence(match[0]),
            },
          ],
        });
        break;
      }
    }

    // Sanity checks against the engagement context. A mismatch stops the
    // pipeline rather than quietly producing a document for the wrong client.
    const context = request.context;
    if (context?.expectedClientName) {
      const haystack = request.text.fullText.toLowerCase();
      const expected = context.expectedClientName.toLowerCase();
      const distinctive = expected.split(/\s+/).filter((word) => word.length > 3);
      const matched = distinctive.filter((word) => haystack.includes(word)).length;
      if (distinctive.length > 0 && matched / distinctive.length < 0.5) {
        blockers.push(
          `The client name in this document does not appear to match "${context.expectedClientName}". A person must confirm the document before it is used.`,
        );
      }
    }

    if (context?.expectedYear && !request.text.fullText.includes(String(context.expectedYear))) {
      warnings.push(`The expected tax year ${context.expectedYear} does not appear in this document.`);
    }

    if (/\bDRAFT\b/i.test(request.text.fullText)) {
      blockers.push('This document appears to be a draft. Only final documents may be used.');
    }

    const found = new Set(values.map((value) => value.token));
    const missingTokens = request.wantedTokens.filter((token) => !found.has(token));

    return { values, missingTokens, blockers, warnings };
  }
}
