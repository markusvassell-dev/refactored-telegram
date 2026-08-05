import type { ExtractionMethod } from '@element/shared';

/**
 * Field extraction.
 *
 * Extraction priority is fixed and deterministic-first:
 *
 *   1. Native structured data or export
 *   2. Embedded PDF text
 *   3. Deterministic pattern-based extraction
 *   4. AI-assisted structured extraction
 *   5. OCR or vision fallback
 *   6. Manual entry
 *
 * AI is never used when deterministic data is available, never invents a
 * missing value, and its output is always validated against a strict schema
 * before it is stored.
 */

export interface Evidence {
  sourceDocumentId?: string | null;
  sourceDocumentHash?: string | null;
  pageNumber?: number | null;
  /** The supporting text found. Truncated — never a whole document. */
  supportingText?: string | null;
}

export interface ExtractedValue {
  token: string;
  value: string | null;
  /** Typed forms, when the token has one. */
  numericValue?: string | null;
  dateValue?: string | null;
  booleanValue?: boolean | null;
  method: ExtractionMethod;
  /** 0 to 1. Deterministic matches are 1. */
  confidence: number;
  evidence: Evidence[];
}

export interface DocumentText {
  /** Full text, page by page, so evidence can cite a page number. */
  pages: { pageNumber: number; text: string }[];
  fullText: string;
  /** True when the PDF had no embedded text and OCR would be required. */
  requiresOcr: boolean;
}

export interface ExtractionRequest {
  documentId: string;
  documentHash: string;
  text: DocumentText;
  /** Tokens the caller wants. The extractor returns only what it can support. */
  wantedTokens: readonly string[];
  /** Context used to sanity-check what is extracted. */
  context?: {
    expectedClientName?: string | null;
    expectedYear?: number | null;
    expectedYearEnd?: string | null;
  };
}

export interface ExtractionResult {
  values: ExtractedValue[];
  /** Tokens the extractor could not find. These become manual-entry prompts. */
  missingTokens: string[];
  /** Problems that must stop automatic processing and require human review. */
  blockers: string[];
  warnings: string[];
}

export interface FieldExtractor {
  readonly name: string;
  readonly method: ExtractionMethod;
  /** Lower runs first. Mirrors the fixed extraction priority. */
  readonly priority: number;
  supports(token: string): boolean;
  extract(request: ExtractionRequest): Promise<ExtractionResult>;
}

export const MAX_EVIDENCE_TEXT_LENGTH = 400;

export function truncateEvidence(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_EVIDENCE_TEXT_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_EVIDENCE_TEXT_LENGTH)}…`;
}
