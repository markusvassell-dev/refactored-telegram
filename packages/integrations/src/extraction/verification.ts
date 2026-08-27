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
  /**
   * The weight actually in play, and how much of it matched.
   *
   * The score is a ratio, and a ratio hides how much was being asked. A client
   * whose record carries no business number and no year-end has those signals
   * excluded from the denominator entirely, so a document matching only the name
   * and the document-type marker scores 1.00 — a perfect mark out of very
   * little. Anything acting on the score needs to see the denominator too.
   */
  applicableWeight: number;
  matchedWeight: number;
  /** The keys that positively matched, so a caller can require a specific one. */
  matchedKeys: string[];
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

/** Phrases that mark the document itself as a draft, wherever they appear. */
const DRAFT_MARKERS = [
  'draft copy',
  'draft - not for',
  'draft — not for',
  'not for signature',
  'not for distribution',
  'for discussion purposes only',
  'draft for review',
  'draft engagement letter',
];

/**
 * Is *this document* a draft?
 *
 * The word alone is not evidence: the approved T2 letter's own wording offers
 * "a draft return or filing summary for management review", and disqualifying
 * every letter containing it would reject genuine prior-year documents. A draft
 * is marked as one — by a standalone DRAFT line, a marker in the letterhead, or
 * one of the stock phrases above.
 */
function isMarkedDraft(rawText: string): boolean {
  const text = rawText.toLowerCase();

  if (DRAFT_MARKERS.some((marker) => text.includes(marker))) return true;

  // A line that is nothing but "draft", which is how a watermark or a stamp
  // extracts.
  if (rawText.split(/\r?\n/).some((line) => /^\s*[*_\-–—]*\s*draft\s*[*_\-–—.!]*\s*$/i.test(line))) return true;

  return false;
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
    Boolean(expectation.yearEndIso) && matchesYearEnd(text, expectation.yearEndIso as string),
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
  if (isMarkedDraft(candidate.text)) {
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
    applicableWeight: totalWeight,
    matchedWeight,
    matchedKeys: signals.filter((signal) => signal.matched).map((signal) => signal.key),
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
    case 'signed':
    case 'adobe_agreement':
      return false; // Bonus signals; they never penalise a candidate.
    case 'filename_hint':
    case 'work_item':
      // Also bonuses, for the same reason, and this file already says so about
      // the filename: "a weak, supporting signal only — never sufficient on its
      // own". A hint that can *deny* acceptance is not a hint. Leaving them in
      // the denominator meant a genuine prior-year letter with an unhelpful
      // filename scored 0.909 instead of 1.000, and one filed on an unexpected
      // work item lost a further point — enough to put a real letter under a
      // 90% bar while proving nothing about whose document it is.
      return false;
    default:
      return true;
  }
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * Every way the same year-end is legitimately written down.
 *
 * This used to be one rendering — "March 31, 2025" and nothing else — which
 * made a signal worth two points turn on a typographical choice the firm does
 * not control. A prior-year letter printing "31 March 2025" scored 0.818 rather
 * than 1.000 and would be refused by a 90% gate, for being correct in the wrong
 * house style.
 *
 * Deterministic and exhaustive rather than fuzzy: each of these is the same
 * date, and nothing here matches a date that is not.
 */
export function yearEndRenderings(iso: string): string[] {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return [iso];

  const year = date.getUTCFullYear();
  const monthIndex = date.getUTCMonth();
  const day = date.getUTCDate();
  const month = MONTH_NAMES[monthIndex] as string;
  const abbreviated = month.slice(0, 3);
  const mm = String(monthIndex + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');

  return [
    `${year}-${mm}-${dd}`,
    `${year}${mm}${dd}`,
    `${month} ${day}, ${year}`,
    `${month} ${day} ${year}`,
    `${day} ${month} ${year}`,
    `${day} ${month}, ${year}`,
    `${abbreviated} ${day}, ${year}`,
    `${abbreviated}. ${day}, ${year}`,
    `${day} ${abbreviated} ${year}`,
    `${dd}/${mm}/${year}`,
    `${mm}/${dd}/${year}`,
    `${dd}-${mm}-${year}`,
    `${mm}-${dd}-${year}`,
  ];
}

function matchesYearEnd(normalizedText: string, iso: string): boolean {
  return yearEndRenderings(iso).some((rendering) => normalizedText.includes(normalize(rendering)));
}

/**
 * Whether a document may be read automatically during a bulk scan.
 *
 * A scan reads everything a client has and takes values out of whatever clears
 * this bar, so the bar decides what ends up on a letter somebody signs. Ninety
 * per cent was asked for and is here — but the ratio alone will not do the job,
 * for a reason that runs backwards.
 *
 * `isApplicable` drops a signal from the denominator when the client record
 * lacks the thing it checks. A client with a business number and a year-end on
 * file is scored out of sixteen and a half points; a client with only a legal
 * name is scored out of ten and a half. So the *less* is known about a client,
 * the easier a high score becomes: a document carrying the name, the
 * document-type marker and the year scores a flat 1.00 while proving almost
 * nothing about whose document it is. It could be the firm's blank template, or
 * another client's letter with a similar name.
 *
 * Hence the floor. A strong identifier must have *positively matched* — not
 * merely have been inapplicable. A signal that is absent can never be evidence,
 * so absence removes it from the numerator and from the set of things that can
 * establish identity: it stops being able to help at all.
 *
 * Additive by design. `AUTO_ACCEPT_THRESHOLD` and `confident` are untouched:
 * those govern *identifying the prior-year letter*, which is a different
 * question from *may I read values out of this*, and raising them would quietly
 * change what "confirmed" means for a file somebody attached by hand.
 */
export const BULK_ACCEPT_SCORE = 0.9;

/** For a message, not for money — the repo's decimal helpers are for the latter. */
function asPercentage(ratio: number): string {
  return `${(ratio * 100).toFixed(0)}%`;
}

/** The identifiers that can establish whose document this is. */
const STRONG_IDENTIFIERS = ['business_number', 't3_account_number'] as const;

export type IdentityBasis = 'STRONG_IDENTIFIER' | 'NAME_AND_PERIOD' | 'NONE';

export interface AcceptanceDecision {
  accepted: boolean;
  score: number;
  identityBasis: IdentityBasis;
  /** Why not, in words a reviewer can act on. Empty when accepted. */
  refusals: string[];
}

export interface BulkAcceptInput {
  /** False when the file had no readable text layer, or none was extracted. */
  readable: boolean;
  minimumScore?: number;
}

export function decideBulkAccept(outcome: VerificationOutcome, input: BulkAcceptInput): AcceptanceDecision {
  const minimumScore = input.minimumScore ?? BULK_ACCEPT_SCORE;
  const matched = new Set(outcome.matchedKeys);
  const refusals: string[] = [];

  const identityBasis: IdentityBasis = STRONG_IDENTIFIERS.some((key) => matched.has(key))
    ? 'STRONG_IDENTIFIER'
    : matched.has('client_legal_name') && matched.has('year_end')
      ? 'NAME_AND_PERIOD'
      : 'NONE';

  if (outcome.disqualifiers.length > 0) refusals.push(...outcome.disqualifiers);

  // An unreadable file is unreadable, never "below the bar". Reporting a scanned
  // PDF as a low score sends somebody looking for a better document when what
  // they need is to know it has no text in it.
  if (!input.readable) {
    refusals.push('No text could be read from this document, so nothing was checked against it.');
  }

  if (input.readable && outcome.score < minimumScore) {
    refusals.push(
      `Scored ${asPercentage(outcome.score)} against this client, below the ${asPercentage(
        minimumScore,
      )} needed to read it automatically.`,
    );
  }

  if (input.readable && identityBasis === 'NONE') {
    refusals.push(
      outcome.applicableWeight < 8
        ? 'There is too little on this client’s record to check a document against — no business number and no year-end — so nothing here identifies it as theirs.'
        : 'Nothing identifies this document as this client’s: neither a matching business number nor both the client name and the year-end.',
    );
  }

  return { accepted: refusals.length === 0, score: outcome.score, identityBasis, refusals };
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
