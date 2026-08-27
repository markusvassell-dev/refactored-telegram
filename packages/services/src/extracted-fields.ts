import type { ExtractedField, PrismaClient } from '@element/database';
import type { ExtractionMethod, ValueSource } from '@element/shared';

/**
 * The one writer of an engagement-level field value.
 *
 * There were two, and they disagreed about three things.
 *
 * The live one: the worker's copy dropped `valueDate` and `extractionMethod`
 * from its update. A re-read that corrected a year-end wrote the new text and
 * kept the old typed column — and every reader takes
 * `valueDecimal ?? valueDate ?? value`, so the stale one still won. Extraction
 * ran once per engagement, so this had nowhere to show; a button that re-reads
 * every document a client has gives it somewhere.
 *
 * The worker also hardcoded `PRIOR_YEAR_DOCUMENT` as the source even when the
 * caller was the cover-letter extractor, and lacked the guard below.
 *
 * That guard is a defence rather than a fix for anything reachable today: it
 * refuses to rewrite a row a person has confirmed, and nothing currently
 * confirms a row of any source but `MANUAL_ENTRY` — which lives in its own row
 * and wins through `resolveFieldValue` regardless. It is here because the
 * invariant is the one `putField` already stated for the Karbon path, and
 * because confirming an extracted value in place is the obvious next thing to
 * want once a scan is re-runnable.
 *
 * `coverLetterPackageId` is null for engagement-level values. The uniqueness
 * guarantee comes from a NULLS NOT DISTINCT index created in the migration,
 * which Prisma's generated compound-key type cannot express, so the lookup is
 * done explicitly rather than through an upsert.
 */

export interface PutExtractedFieldInput {
  engagementId: string;
  token: string;
  source: ValueSource;
  method: ExtractionMethod;
  value?: string | null;
  valueDecimal?: string | null;
  valueDate?: Date | null;
  valueBoolean?: boolean | null;
  /** Defaults to 1: a deterministic match is either exact or absent. */
  confidence?: number;
  /** Scopes the row to a cover-letter package rather than the engagement. */
  coverLetterPackageId?: string | null;
}

export interface PutExtractedFieldResult {
  /** The row as it now stands, or the confirmed row that was left alone. */
  field: ExtractedField;
  /**
   * False when a person had confirmed this value and it was therefore not
   * rewritten. Callers recording evidence should check this: evidence attached
   * to a value the document did not supply claims support that does not exist.
   */
  written: boolean;
}

export async function putExtractedField(
  prisma: PrismaClient,
  input: PutExtractedFieldInput,
): Promise<PutExtractedFieldResult> {
  const coverLetterPackageId = input.coverLetterPackageId ?? null;

  const existing = await prisma.extractedField.findFirst({
    where: {
      engagementId: input.engagementId,
      coverLetterPackageId,
      token: input.token,
      source: input.source,
    },
  });

  // A value a person has confirmed is never silently rewritten.
  if (existing?.manuallyConfirmed) return { field: existing, written: false };

  const data = {
    value: input.value ?? null,
    valueDecimal: input.valueDecimal ?? null,
    valueDate: input.valueDate ?? null,
    valueBoolean: input.valueBoolean ?? null,
    extractionMethod: input.method,
    confidence: input.confidence ?? 1,
  };

  if (existing) {
    const field = await prisma.extractedField.update({ where: { id: existing.id }, data });
    return { field, written: true };
  }

  const field = await prisma.extractedField.create({
    data: {
      engagementId: input.engagementId,
      coverLetterPackageId,
      token: input.token,
      source: input.source,
      ...data,
    },
  });

  return { field, written: true };
}
