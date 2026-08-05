import { sourceRank, type ValueSource } from '@element/shared';

/**
 * Which value is the effective one when a token has more than one.
 *
 * A token routinely carries several rows: what Karbon says, what last year's
 * letter said, what a reviewer typed. Generation used to iterate those rows and
 * let the last one win, which made the value that reached a client depend on
 * the order Postgres happened to return — and meant a resolved conflict was
 * recorded but never actually applied.
 *
 * One rule, in one place, used by both the review UI and generation, so what a
 * reviewer sees is what the document gets.
 */

export interface FieldValueCandidate {
  value: string | null;
  source: ValueSource;
  /** An explicit correction, which carries a written reason. */
  manualOverrideValue?: string | null;
  manuallyConfirmed?: boolean;
}

/** Why a value won, so the UI can say so rather than leaving it unexplained. */
export type FieldValueBasis =
  | 'MANUAL_OVERRIDE'
  | 'CONFLICT_RESOLUTION'
  | 'MANUALLY_CONFIRMED'
  | 'HIGHEST_PRIORITY_SOURCE';

export interface ResolvedFieldValue {
  value: string;
  source: ValueSource;
  basis: FieldValueBasis;
}

export interface ResolvedConflict {
  status: string;
  resolvedValue: string | null;
  resolvedSource: ValueSource | null;
}

function hasValue(candidate: FieldValueCandidate): boolean {
  return (candidate.manualOverrideValue ?? candidate.value ?? '') !== '';
}

/**
 * Deterministic ordering. Source priority first, then the value itself, so two
 * rows that are equally authoritative still resolve the same way on every run
 * rather than depending on the order they were read in.
 */
function byAuthority(a: FieldValueCandidate, b: FieldValueCandidate): number {
  const ranked = sourceRank(a.source) - sourceRank(b.source);
  if (ranked !== 0) return ranked;
  return (a.value ?? '').localeCompare(b.value ?? '');
}

export function resolveFieldValue(
  candidates: readonly FieldValueCandidate[],
  conflict?: ResolvedConflict | null,
): ResolvedFieldValue | null {
  const usable = candidates.filter(hasValue);

  // 1. An explicit override. Someone stated, with a reason, that this is right.
  const overridden = usable
    .filter((candidate) => (candidate.manualOverrideValue ?? '') !== '')
    .sort(byAuthority)[0];
  if (overridden) {
    return {
      value: overridden.manualOverrideValue as string,
      source: overridden.source,
      basis: 'MANUAL_OVERRIDE',
    };
  }

  // 2. A decision a reviewer recorded against a conflict. Applying it here is
  //    what makes resolving a conflict mean anything.
  if (
    conflict &&
    (conflict.status === 'RESOLVED' || conflict.status === 'ACCEPTED_AS_IS') &&
    conflict.resolvedValue
  ) {
    return {
      value: conflict.resolvedValue,
      source: conflict.resolvedSource ?? 'MANUAL_ENTRY',
      basis: 'CONFLICT_RESOLUTION',
    };
  }

  // 3. A value a person typed and confirmed beats one nobody has looked at.
  const confirmed = usable.filter((candidate) => candidate.manuallyConfirmed === true).sort(byAuthority)[0];
  if (confirmed) {
    return { value: confirmed.value as string, source: confirmed.source, basis: 'MANUALLY_CONFIRMED' };
  }

  // 4. Otherwise the highest-priority source, which is what reconciliation
  //    recommends when it raises a conflict.
  const best = [...usable].sort(byAuthority)[0];
  if (!best) return null;

  return { value: best.value as string, source: best.source, basis: 'HIGHEST_PRIORITY_SOURCE' };
}
