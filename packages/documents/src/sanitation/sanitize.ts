import { blockText } from '../ooxml/xml.js';
import { getPartText, mediaParts, readDocx, type DocxParts } from '../ooxml/package.js';
import type { TemplateManifest } from '../template-engine/manifest.js';

/**
 * Client-facing document sanitation and validation.
 *
 * A document cannot be approved until every check here passes. These are the
 * last line of defence between an internal draft and a client's inbox.
 */

const HIGHLIGHT_PATTERN = /<w:highlight\b[^>]*\/>|<w:highlight\b[^>]*>[\s\S]*?<\/w:highlight>/g;
const SHADING_PATTERN = /<w:shd\b[^>]*w:fill="(FFFF00|FFFF99|FFF200)"[^>]*\/>/gi;

/** Removes every text highlight and yellow shading from a document part. */
export function stripHighlights(xml: string): string {
  return xml.replace(HIGHLIGHT_PATTERN, '').replace(SHADING_PATTERN, '');
}

export function countHighlights(xml: string): number {
  return (xml.match(HIGHLIGHT_PATTERN) ?? []).length;
}

export type ValidationSeverity = 'ERROR' | 'WARNING';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  detail?: string;
}

export interface ValidationInput {
  docx: Uint8Array | Buffer;
  manifest: TemplateManifest;
  /** Tokens the manifest requires for the sections actually included. */
  requiredTokens: readonly string[];
  /** Values used for the render, so blank required fields can be detected. */
  values: Record<string, string>;
  /** Page count of the converted PDF, when available. */
  pdfPageCount?: number | null;
  /** True when PDF conversion succeeded. */
  pdfConverted?: boolean;
  /** Dates the reviewer has not yet confirmed. */
  unconfirmedDates?: readonly string[];
  /** Fees the reviewer has not yet confirmed. */
  unconfirmedFees?: readonly string[];
  /** Expected client legal name and year, checked for presence in the output. */
  expectedClientName?: string | null;
  expectedYearText?: string | null;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
  /** Concatenated document text used for the checks, for diagnostics. */
  textLength: number;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function validateRenderedDocument(input: ValidationInput): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];
  let parts: DocxParts;

  try {
    parts = await readDocx(input.docx);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          severity: 'ERROR',
          code: 'DOCX_UNREADABLE',
          message: 'The generated Word file could not be opened.',
          detail: error instanceof Error ? error.message : undefined,
        },
      ],
      errorCount: 1,
      warningCount: 0,
      textLength: 0,
    };
  }

  const partTexts = parts.textParts.map((path) => ({ path, xml: getPartText(parts, path) }));
  const fullText = partTexts.map(({ xml }) => blockText(xml)).join('\n');
  const lowerText = fullText.toLowerCase();

  // ---- Unresolved placeholders -------------------------------------------
  for (const pattern of input.manifest.sanitation.placeholderPatterns) {
    const regex = new RegExp(pattern, 'g');
    const matches = [...fullText.matchAll(regex)].map((match) => match[0]);
    if (matches.length > 0) {
      issues.push({
        severity: 'ERROR',
        code: 'UNRESOLVED_PLACEHOLDER',
        message: `${matches.length} unresolved placeholder(s) remain in the document.`,
        detail: [...new Set(matches)].slice(0, 10).join(', '),
      });
    }
  }

  // ---- Highlighting ------------------------------------------------------
  const highlightCount = partTexts.reduce((total, { xml }) => total + countHighlights(xml), 0);
  if (input.manifest.sanitation.removeAllHighlights && highlightCount > 0) {
    issues.push({
      severity: 'ERROR',
      code: 'HIGHLIGHT_PRESENT',
      message: `${highlightCount} highlighted run(s) remain. Client-facing documents must not contain placeholder highlighting.`,
    });
  }

  // ---- Internal-only content ---------------------------------------------
  for (const forbidden of input.manifest.sanitation.forbiddenText) {
    if (lowerText.includes(forbidden.toLowerCase())) {
      issues.push({
        severity: 'ERROR',
        code: 'INTERNAL_CONTENT_PRESENT',
        message: 'Internal-only content is still present in the client-facing document.',
        detail: forbidden,
      });
    }
  }

  // ---- Required branding and headings ------------------------------------
  for (const required of input.manifest.sanitation.requiredText) {
    if (!lowerText.includes(required.toLowerCase())) {
      issues.push({
        severity: 'ERROR',
        code: 'REQUIRED_TEXT_MISSING',
        message: 'Required document content is missing. The template may have been damaged during rendering.',
        detail: required,
      });
    }
  }

  const media = mediaParts(parts);
  for (const requiredMedia of input.manifest.sanitation.requiredMediaParts) {
    if (!media.includes(requiredMedia)) {
      issues.push({
        severity: 'ERROR',
        code: 'BRANDING_MISSING',
        message: 'The firm logo is missing from the generated document.',
        detail: requiredMedia,
      });
    }
  }

  // ---- Required fields ----------------------------------------------------
  const blankRequired = input.requiredTokens.filter((token) => {
    const value = input.values[token];
    return value === undefined || value.trim() === '';
  });
  if (blankRequired.length > 0) {
    issues.push({
      severity: 'ERROR',
      code: 'REQUIRED_FIELD_BLANK',
      message: `${blankRequired.length} required field(s) are blank.`,
      detail: blankRequired.join(', '),
    });
  }

  // ---- Field-level validation --------------------------------------------
  for (const field of input.manifest.fields) {
    const value = input.values[field.token];
    if (!value || value.trim() === '') continue;

    if (field.dataType === 'EMAIL' && !EMAIL_SHAPE.test(value.trim())) {
      issues.push({
        severity: 'ERROR',
        code: 'INVALID_EMAIL',
        message: `"${field.label}" is not a valid email address.`,
      });
    }
    if (field.dataType === 'YEAR' && !/^(19|20)\d{2}$/.test(value.trim())) {
      issues.push({
        severity: 'ERROR',
        code: 'INVALID_YEAR',
        message: `"${field.label}" is not a valid four-digit year.`,
      });
    }
    if (field.maxLength && value.length > field.maxLength) {
      issues.push({
        severity: 'WARNING',
        code: 'FIELD_TOO_LONG',
        message: `"${field.label}" is longer than the template allows and may wrap unexpectedly.`,
      });
    }
  }

  // ---- Unconfirmed dates and fees ----------------------------------------
  if (input.unconfirmedDates?.length) {
    issues.push({
      severity: 'ERROR',
      code: 'UNCONFIRMED_DATE',
      message: 'Every calculated date must be confirmed by a reviewer before approval.',
      detail: input.unconfirmedDates.join(', '),
    });
  }
  if (input.unconfirmedFees?.length) {
    issues.push({
      severity: 'ERROR',
      code: 'UNCONFIRMED_FEE',
      message: 'Every fee must be confirmed before approval.',
      detail: input.unconfirmedFees.join(', '),
    });
  }

  // ---- Correct client and year appear throughout --------------------------
  if (input.expectedClientName && !lowerText.includes(input.expectedClientName.toLowerCase())) {
    issues.push({
      severity: 'ERROR',
      code: 'CLIENT_NAME_MISSING',
      message: 'The expected client name does not appear in the generated document.',
    });
  }
  if (input.expectedYearText && !fullText.includes(input.expectedYearText)) {
    issues.push({
      severity: 'ERROR',
      code: 'YEAR_MISSING',
      message: 'The expected tax year or year-end does not appear in the generated document.',
    });
  }

  // ---- Duplicate signature fields ----------------------------------------
  const signatureTags = [...fullText.matchAll(/\{\{[^}]*_es_:[^}]*\}\}/g)].map((match) => match[0]);
  const duplicateTags = signatureTags.filter((tag, index) => signatureTags.indexOf(tag) !== index);
  if (duplicateTags.length > 0) {
    issues.push({
      severity: 'ERROR',
      code: 'DUPLICATE_SIGNATURE_FIELD',
      message: 'The same signature field appears more than once.',
      detail: [...new Set(duplicateTags)].join(', '),
    });
  }

  // ---- PDF conversion and page count -------------------------------------
  if (input.pdfConverted === false) {
    issues.push({ severity: 'ERROR', code: 'PDF_CONVERSION_FAILED', message: 'PDF conversion did not succeed.' });
  }

  const range = input.manifest.sanitation.expectedPageRange;
  if (range && typeof input.pdfPageCount === 'number') {
    const [min, max] = range;
    if (input.pdfPageCount < min || input.pdfPageCount > max) {
      issues.push({
        severity: 'WARNING',
        code: 'UNEXPECTED_PAGE_COUNT',
        message: `The document is ${input.pdfPageCount} pages; ${min}-${max} was expected. Check that nothing was lost or duplicated.`,
      });
    }
  }

  const errorCount = issues.filter((issue) => issue.severity === 'ERROR').length;
  const warningCount = issues.length - errorCount;

  return { ok: errorCount === 0, issues, errorCount, warningCount, textLength: fullText.length };
}
