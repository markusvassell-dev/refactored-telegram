import type { DocumentType, EngagementType } from '@element/shared';

/**
 * Prior-year document verification.
 *
 * A document is never trusted because of its filename. A candidate must be
 * corroborated by its actual content before it can be used as a source, and
 * when several candidates look plausible the application presents the choice
 * rather than guessing.
 */

export interface VerificationExpectation {
  clientLegalName: string;
  engagementType: EngagementType;
  documentType: DocumentType;
  /** The prior year we are looking for. */
  priorTaxYear: number;
  taxpayerNames?: string[];
  corporationName?: string | null;
  trustName?: string | null;
  businessNumber?: string | null;
  t3AccountNumber?: string | null;
  yearEndIso?: string | null;
  karbonWorkItemKey?: string | null;
}

export interface VerificationCandidate {
  documentId: string;
  fileName: string;
  karbonWorkItemKey?: string | null;
  /** Extracted text of the candidate. */
  text: string;
  /** True when the file is known to be a signed copy. */
  isSigned?: boolean;
  priorAdobeAgreementId?: string | null;
}

export interface VerificationSignal {
  key: string;
  label: string;
  weight: number;
  matched: boolean;
  detail?: string;
}

export interface VerificationOutcome {
  documentId: string;
  fileName: string;
  /** 0 to 1. */
  score: number;
  signals: VerificationSignal[];
  /** True when the score clears the automatic-acceptance threshold. */
  confident: boolean;
  /** Reasons the document cannot be used at all. */
  disqualifiers: string[];
}

const AUTO_ACCEPT_THRESHOLD = 0.7;

const DOCUMENT_TYPE_MARKERS: Record<DocumentType, string[]> = {
  T2_ENGAGEMENT_LETTER: ['corporate income tax (t2) engagement letter', 't2 engagement letter'],
  T1_JOINT_ENGAGEMENT_LETTER: ['t1 personal income tax engagement letter'],
  T1_SINGLE_ENGAGEMENT_LETTER: ['t1 personal income tax engagement letter'],
  T3_ENGAGEMENT_LETTER: ['t3 trust income tax engagement letter'],
  T1_COVER_LETTER: ['personal income tax cover letter'],
  T2_COVER_LETTER: ['corporate income tax cover letter'],
  T3_COVER_LETTER: ['trust income tax cover letter'],
  COMPILATION_COVER_LETTER: ['compilation engagement cover letter'],
};

function normalize(value: string): string {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function containsName(haystack: string, name: string | null | undefined): boolean {
  if (!name) return false;
  const normalized = normalize(name);
  if (haystack.includes(normalized)) return true;

  // Fall back to distinctive words so "Northwind Holdings Ltd." still matches
  // "Northwind Holdings Ltd" or "NORTHWIND HOLDINGS LTD."
  const words = normalized.split(' ').filter((word) => word.length > 3 && !/^(ltd|inc|corp|the|and)$/.test(word));
  if (words.length === 0) return false;
  const matched = words.filter((word) => haystack.includes(word)).length;
  return matched / words.length >= 0.75;
}

function normalizeIdentifier(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function verifyCandidate(
  candidate: VerificationCandidate,
  expectation: VerificationExpectation,
): VerificationOutcome {
  const text = normalize(candidate.text);
  const identifiers = normalizeIdentifier(candidate.text);
  const signals: VerificationSignal[] = [];
  const disqualifiers: string[] = [];

  const add = (key: string, label: string, weight: number, matched: boolean, detail?: string): void => {
    signals.push({ key, label, weight, matched, detail });
  };

  // Client identity.
  add('client_legal_name', 'Client legal name appears in the document', 3, containsName(text, expectation.clientLegalName));
  add('corporation_name', 'Corporation name appears', 2, containsName(text, expectation.corporationName));
  add('trust_name', 'Trust or estate name appears', 2, containsName(text, expectation.trustName));
  add(
    'taxpayer_names',
    'Taxpayer names appear',
    2,
    (expectation.taxpayerNames ?? []).length > 0 &&
      (expectation.taxpayerNames ?? []).every((name) => containsName(text, name)),
  );

  // Strong identifiers.
  add(
    'business_number',
    'Business number matches',
    3,
    Boolean(expectation.businessNumber) && identifiers.includes(normalizeIdentifier(expectation.businessNumber ?? '')),
  );
  add(
    't3_account_number',
    'T3 account number matches',
    3,
    Boolean(expectation.t3AccountNumber) && identifiers.includes(normalizeIdentifier(expectation.t3AccountNumber ?? '')),
  );

  // Engagement type.
  const markers = DOCUMENT_TYPE_MARKERS[expectation.documentType] ?? [];
  add('document_type', 'Document type marker present', 3, markers.some((marker) => text.includes(marker)));

  // Period.
  add('tax_year', `Prior tax year ${expectation.priorTaxYear} appears`, 2, text.includes(String(expectation.priorTaxYear)));
  add(
    'year_end',
    'Year-end matches',
    2,
    Boolean(expectation.yearEndIso) && text.includes(normalize(formatYearEnd(expectation.yearEndIso as string))),
  );

  // Karbon linkage.
  add(
    'work_item',
    'Found on the expected Karbon work item',
    1,
    Boolean(expectation.karbonWorkItemKey) && candidate.karbonWorkItemKey === expectation.karbonWorkItemKey,
  );

  // Signing status.
  add('signed', 'Document is a signed copy', 1, candidate.isSigned === true);
  add('adobe_agreement', 'Linked to a prior Adobe Sign agreement', 1, Boolean(candidate.priorAdobeAgreementId));

  // Filename is a weak, supporting signal only — never sufficient on its own.
  const fileName = normalize(candidate.fileName);
  add(
    'filename_hint',
    'Filename is consistent',
    0.5,
    fileName.includes(String(expectation.priorTaxYear)) || containsName(fileName, expectation.clientLegalName),
  );

  // Disqualifiers.
  if (/\bdraft\b/.test(text) && !/\bfinal\b/.test(text)) {
    disqualifiers.push('The document appears to be a draft.');
  }
  const currentYear = expectation.priorTaxYear + 1;
  if (text.includes(String(currentYear)) && !text.includes(String(expectation.priorTaxYear))) {
    disqualifiers.push(`The document refers to ${currentYear} rather than the prior year ${expectation.priorTaxYear}.`);
  }

  // Only signals that were actually applicable count toward the denominator,
  // so a T2 engagement is not penalised for having no trust name.
  const applicable = signals.filter((signal) => isApplicable(signal.key, expectation));
  const totalWeight = applicable.reduce((sum, signal) => sum + signal.weight, 0);
  const matchedWeight = applicable
    .filter((signal) => signal.matched)
    .reduce((sum, signal) => sum + signal.weight, 0);

  const score = totalWeight === 0 ? 0 : Number((matchedWeight / totalWeight).toFixed(4));

  return {
    documentId: candidate.documentId,
    fileName: candidate.fileName,
    score,
    signals,
    confident: disqualifiers.length === 0 && score >= AUTO_ACCEPT_THRESHOLD,
    disqualifiers,
  };
}

function isApplicable(key: string, expectation: VerificationExpectation): boolean {
  switch (key) {
    case 'corporation_name':
      return Boolean(expectation.corporationName);
    case 'trust_name':
      return Boolean(expectation.trustName);
    case 'taxpayer_names':
      return (expectation.taxpayerNames ?? []).length > 0;
    case 'business_number':
      return Boolean(expectation.businessNumber);
    case 't3_account_number':
      return Boolean(expectation.t3AccountNumber);
    case 'year_end':
      return Boolean(expectation.yearEndIso);
    case 'work_item':
      return Boolean(expectation.karbonWorkItemKey);
    case 'signed':
    case 'adobe_agreement':
      return false; // Bonus signals; they never penalise a candidate.
    default:
      return true;
  }
}

function formatYearEnd(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

export interface SelectionOutcome {
  /** Set only when exactly one candidate is confidently correct. */
  selected: VerificationOutcome | null;
  /** Presented to the user when the choice is genuinely ambiguous. */
  requiresUserChoice: boolean;
  ranked: VerificationOutcome[];
  reason: string;
}

/**
 * Chooses a prior-year document. When more than one candidate is plausible the
 * application does not guess — it asks.
 */
export function selectPriorYearDocument(
  candidates: readonly VerificationCandidate[],
  expectation: VerificationExpectation,
): SelectionOutcome {
  const ranked = candidates
    .map((candidate) => verifyCandidate(candidate, expectation))
    .sort((a, b) => b.score - a.score);

  const usable = ranked.filter((outcome) => outcome.disqualifiers.length === 0);
  const confident = usable.filter((outcome) => outcome.confident);

  if (confident.length === 0) {
    return {
      selected: null,
      requiresUserChoice: ranked.length > 0,
      ranked,
      reason:
        ranked.length === 0
          ? 'No prior-year document was found. Select one manually or enter the information by hand.'
          : 'No candidate was verified with enough confidence. A person must choose the correct document.',
    };
  }

  if (confident.length > 1) {
    const best = confident[0] as VerificationOutcome;
    const runnerUp = confident[1] as VerificationOutcome;
    // A clear winner is one that is meaningfully ahead of the next candidate.
    if (best.score - runnerUp.score < 0.1) {
      return {
        selected: null,
        requiresUserChoice: true,
        ranked,
        reason: `${confident.length} documents look like the prior-year letter. Choose the correct one.`,
      };
    }
  }

  return {
    selected: confident[0] as VerificationOutcome,
    requiresUserChoice: false,
    ranked,
    reason: 'A single prior-year document was verified against the client, engagement type and year.',
  };
}
