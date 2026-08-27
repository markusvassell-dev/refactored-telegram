import type { ValueSource } from '@element/shared';
import { resolveFieldValue, type FieldValueBasis, type ResolvedConflict } from './field-values.js';

/**
 * What a token's value actually is, across every table that can supply one.
 *
 * A token's value does not live in one place. Most come from `extracted_field`,
 * but every deadline is computed into `calculated_date` and every fee into
 * `fee_calculation`, and the tax year is a column on the engagement itself.
 *
 * Generation knew that and merged all four. The review form did not: it read
 * `extracted_field` alone, and fetched `calculated_date` selecting the token and
 * deliberately *not* the result, because it only wanted to know which fields to
 * mark read-only. So the five deadlines and the fee were computed, stored, and
 * printed on the letter while the screen that lists what is outstanding reported
 * every one of them missing — and marked them read-only, so nobody could supply
 * what it claimed to be waiting for.
 *
 * Two readers of the same facts disagreeing is not a bug that gets fixed once.
 * This is the single reader, so the form and the document cannot drift again.
 *
 * It resolves and does not format. The document needs "March 31, 2026" and an
 * `<input type="date">` needs "2026-03-31"; sharing the formatting is precisely
 * what would break one of them. Callers format at their own boundary.
 */

/** Which table decided the value. `FIELD` is the only one carrying evidence. */
export type ValueOrigin = 'FIELD' | 'CALCULATED_DATE' | 'CALCULATED_FEE' | 'ENGAGEMENT';

export interface EffectiveValue {
  token: string;
  /** Raw: ISO `YYYY-MM-DD` for a date, a decimal string for money. */
  value: string;
  origin: ValueOrigin;
  /** Only set for `FIELD`; the calculated tables are not a `ValueSource` race. */
  source: ValueSource | null;
  basis: FieldValueBasis | null;
}

/**
 * Row shapes are structural and minimal so a caller's own Prisma selection
 * satisfies them without being widened to match.
 */
export interface ExtractedFieldRow {
  token: string;
  value: string | null;
  valueDecimal: { toString(): string } | null;
  valueDate: Date | null;
  source: ValueSource;
  manualOverrideValue: string | null;
  manuallyConfirmed: boolean;
}

export interface ConflictRow extends ResolvedConflict {
  token: string;
}

export interface CalculatedDateRow {
  token: string;
  result: Date | null;
  manualOverride: Date | null;
}

export interface FeeCalculationRow {
  feeKind: string;
  roundedFee: { toString(): string } | null;
}

/**
 * Which fee prints where. Previously written out twice — once in generation and
 * once as a bare token list in the form — which is how the form came to treat
 * fee tokens as read-only without ever reading a fee.
 */
export const FEE_TOKEN_BY_KIND: Readonly<Record<string, string>> = {
  T1_PREPARATION: 'pricing.t1_fee',
  T2_PREPARATION: 'pricing.t2_fee',
  T3_PREPARATION: 'pricing.t3_fee',
  CSRS_4200_COMPILATION: 'pricing.compilation_fee',
};

/** The same conversion both callers already applied to `valueDate`. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface EffectiveValuesInput {
  /** Only these are resolved. In practice, the tokens the manifest declares. */
  tokens: Iterable<string>;
  fields: readonly ExtractedFieldRow[];
  conflicts: readonly ConflictRow[];
  dates: readonly CalculatedDateRow[];
  fees: readonly FeeCalculationRow[];
  /** Written to `engagement.tax_year` only when nothing else supplied it. */
  taxYear?: number | null;
}

/**
 * Resolves every token to the one value that is effective for it.
 *
 * The precedence is the order generation has always applied, preserved exactly,
 * because that ordering is what currently reaches clients: a field row, then a
 * calculated date over the top of it, then a calculated fee over the top of
 * that, and the tax year only where nothing else spoke.
 */
export function resolveEffectiveValues(input: EffectiveValuesInput): Map<string, EffectiveValue> {
  const wanted = new Set(input.tokens);
  const effective = new Map<string, EffectiveValue>();

  // 1. Field rows. A token routinely carries several — Karbon's, last year's, a
  //    reviewer's — and `resolveFieldValue` is the one rule that decides which
  //    wins, so the form and the document agree about the answer.
  const conflictByToken = new Map(input.conflicts.map((conflict) => [conflict.token, conflict]));
  const rowsByToken = new Map<string, ExtractedFieldRow[]>();
  for (const field of input.fields) {
    if (!wanted.has(field.token)) continue;
    const bucket = rowsByToken.get(field.token) ?? [];
    bucket.push(field);
    rowsByToken.set(field.token, bucket);
  }

  for (const [token, rows] of rowsByToken) {
    const resolved = resolveFieldValue(
      rows.map((row) => ({
        value:
          (row.valueDecimal ? row.valueDecimal.toString() : null) ??
          (row.valueDate ? isoDay(row.valueDate) : null) ??
          row.value,
        source: row.source,
        manualOverrideValue: row.manualOverrideValue,
        manuallyConfirmed: row.manuallyConfirmed,
      })),
      conflictByToken.get(token) ?? null,
    );

    if (resolved) {
      effective.set(token, {
        token,
        value: resolved.value,
        origin: 'FIELD',
        source: resolved.source,
        basis: resolved.basis,
      });
    }
  }

  // 2. Calculated dates, which own their token outright — the date rules decide
  //    a deadline and an extracted one from last year would be last year's.
  for (const date of input.dates) {
    if (!wanted.has(date.token)) continue;
    const settled = date.manualOverride ?? date.result;
    if (!settled) continue;
    effective.set(date.token, {
      token: date.token,
      value: isoDay(settled),
      origin: 'CALCULATED_DATE',
      source: null,
      basis: null,
    });
  }

  // 3. Fees, likewise owned by the pricing engine.
  for (const fee of input.fees) {
    const token = FEE_TOKEN_BY_KIND[fee.feeKind];
    if (!token || !wanted.has(token) || !fee.roundedFee) continue;
    effective.set(token, {
      token,
      value: fee.roundedFee.toString(),
      origin: 'CALCULATED_FEE',
      source: null,
      basis: null,
    });
  }

  // 4. The tax year, which several templates print directly. Only where nothing
  //    else spoke, matching generation's `??=`.
  if (wanted.has('engagement.tax_year') && input.taxYear !== null && input.taxYear !== undefined) {
    if (!effective.has('engagement.tax_year')) {
      effective.set('engagement.tax_year', {
        token: 'engagement.tax_year',
        value: String(input.taxYear),
        origin: 'ENGAGEMENT',
        source: null,
        basis: null,
      });
    }
  }

  return effective;
}
