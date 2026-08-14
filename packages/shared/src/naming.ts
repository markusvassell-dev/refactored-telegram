import type { DocumentType } from './domain.js';

/**
 * Output file naming.
 *
 * [YYYY] [DOCUMENT TYPE] - [CLIENT LEGAL NAME] - DRAFT.docx
 *
 * File names are a convenience for humans browsing Karbon. They are never used
 * on their own to identify a document — see the document verification service.
 */

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  T1_JOINT_ENGAGEMENT_LETTER: 'T1 ENGAGEMENT LETTER',
  T1_SINGLE_ENGAGEMENT_LETTER: 'T1 ENGAGEMENT LETTER',
  T2_ENGAGEMENT_LETTER: 'T2 ENGAGEMENT LETTER',
  T3_ENGAGEMENT_LETTER: 'T3 ENGAGEMENT LETTER',
  T1_COVER_LETTER: 'T1',
  T2_COVER_LETTER: 'T2',
  T3_COVER_LETTER: 'T3',
  COMPILATION_COVER_LETTER: 'COMPILATION ENGAGEMENT',
};

export type FileRole =
  | 'DRAFT_DOCX'
  | 'DRAFT_PDF'
  | 'APPROVED_PDF'
  | 'FOR_SIGNATURE_PDF'
  | 'SIGNED_PDF'
  | 'SIGNING_CERTIFICATE'
  | 'COVER_LETTER_DRAFT_DOCX'
  | 'COVER_LETTER_DRAFT_PDF'
  | 'COVER_LETTER_FINAL_DOCX'
  | 'COVER_LETTER_FINAL_PDF';

const ROLE_SUFFIX: Record<FileRole, { suffix: string; extension: string }> = {
  DRAFT_DOCX: { suffix: 'DRAFT', extension: 'docx' },
  DRAFT_PDF: { suffix: 'DRAFT', extension: 'pdf' },
  APPROVED_PDF: { suffix: 'APPROVED', extension: 'pdf' },
  // The copy carrying Adobe's signature tags. Named distinctly because it is
  // not the document a reviewer reads -- opening it shows tag text where the
  // signature lines belong, and mistaking it for the approved draft would put
  // that in front of a client.
  FOR_SIGNATURE_PDF: { suffix: 'FOR SIGNATURE', extension: 'pdf' },
  SIGNED_PDF: { suffix: 'SIGNED', extension: 'pdf' },
  SIGNING_CERTIFICATE: { suffix: 'SIGNING CERTIFICATE', extension: 'pdf' },
  COVER_LETTER_DRAFT_DOCX: { suffix: 'COVER LETTER - DRAFT', extension: 'docx' },
  COVER_LETTER_DRAFT_PDF: { suffix: 'COVER LETTER - DRAFT', extension: 'pdf' },
  COVER_LETTER_FINAL_DOCX: { suffix: 'COVER LETTER - FINAL', extension: 'docx' },
  COVER_LETTER_FINAL_PDF: { suffix: 'COVER LETTER - FINAL', extension: 'pdf' },
};

/** File roles that must never overwrite an existing Karbon document. */
export const IMMUTABLE_FILE_ROLES: readonly FileRole[] = [
  'APPROVED_PDF',
  'SIGNED_PDF',
  'SIGNING_CERTIFICATE',
  'COVER_LETTER_FINAL_DOCX',
  'COVER_LETTER_FINAL_PDF',
];

const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;
const FIRST_PRINTABLE_CODE_POINT = 0x20;

/** Strips characters that are illegal or awkward in Windows/SharePoint names. */
export function sanitizeFileNameComponent(value: string): string {
  const printable = Array.from(value)
    .filter((character) => (character.codePointAt(0) ?? 0) >= FIRST_PRINTABLE_CODE_POINT)
    .join('');

  return printable
    .replace(ILLEGAL_FILENAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export interface BuildFileNameInput {
  year: number;
  documentType: DocumentType;
  clientLegalName: string;
  role: FileRole;
  /** Disambiguates per-taxpayer cover letters within a joint T1 engagement. */
  participantLabel?: string | null;
  /** Test Mode prefixes every generated file so it cannot be mistaken for production output. */
  testMode?: boolean;
}

export function buildFileName(input: BuildFileNameInput): string {
  const role = ROLE_SUFFIX[input.role];
  const segments: string[] = [
    `${input.year} ${DOCUMENT_TYPE_LABELS[input.documentType]}`,
    sanitizeFileNameComponent(input.clientLegalName),
  ];
  if (input.participantLabel) {
    segments.push(sanitizeFileNameComponent(input.participantLabel));
  }
  segments.push(role.suffix);

  const base = segments
    .map((segment) => segment.replace(/\s+/g, ' ').trim())
    .filter((segment) => segment.length > 0)
    .join(' - ');

  const prefix = input.testMode ? 'TEST ' : '';
  return `${prefix}${base}.${role.extension}`;
}

/**
 * Candidate filename patterns used when *searching* Karbon for a prior-year
 * document. Configurable, and never sufficient on its own — a candidate must
 * still pass content verification.
 */
export const DEFAULT_PRIOR_YEAR_FILENAME_PATTERNS: readonly string[] = [
  '{year} {typeLabel}',
  '{typeLabel} {year}',
  '{year} engagement letter',
  'engagement letter {year}',
  '{clientName} {year}',
];

export function expandFilenamePatterns(
  patterns: readonly string[],
  vars: { year: number; typeLabel: string; clientName: string },
): string[] {
  return patterns.map((pattern) =>
    pattern
      .replaceAll('{year}', String(vars.year))
      .replaceAll('{typeLabel}', vars.typeLabel)
      .replaceAll('{clientName}', vars.clientName)
      .toLowerCase(),
  );
}
