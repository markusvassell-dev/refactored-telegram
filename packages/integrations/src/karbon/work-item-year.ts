import type { KarbonWorkItem } from './types.js';

/**
 * Which tax year a Karbon work item is for — when Karbon says so plainly.
 *
 * **Karbon publishes no tax-year field.** A work item carries a title, a work
 * type, a status, a due date and a start date, and nothing else that names a
 * year. So this reads the year out of the title, and the narrowness is the
 * whole design: a wrong tax year does not fail, it produces a correct-looking
 * engagement letter for the wrong period, priced against the wrong prior year
 * and carrying the wrong filing deadline.
 *
 * The rule is therefore: **one plausible year, or nothing.** A title naming two
 * years — `2025/2026 year end`, `T2 2026 (was 2025)` — is ambiguous, and
 * ambiguous means the caller falls back to the deterministic answer, which is
 * the prior year's engagement plus one.
 *
 * Dates are deliberately not read. A due date is a *deadline*: a 2025 T2 is
 * routinely due in 2026, so taking the year from it would be wrong on exactly
 * the engagements that matter most. `matchesYear` in the client searches across
 * title and dates because a loose match is right for *finding* candidates; this
 * is deciding, which is a different job.
 *
 * The window is bounded because a title may hold any number: a street address,
 * a business number, an invoice reference. Only something that could be a tax
 * year is treated as one.
 */

/** Earliest year this could sensibly be, matching the engagement-service floor. */
const EARLIEST = 2000;

export function deriveTaxYear(
  item: Pick<KarbonWorkItem, 'title'>,
  now: Date = new Date(),
): number | null {
  const latest = now.getUTCFullYear() + 2;

  // Four consecutive digits, not part of a longer run: `20261234` is an
  // identifier, not a year, and `2026` inside it is not either.
  const matches = item.title.match(/(?<!\d)\d{4}(?!\d)/g) ?? [];

  const plausible = new Set(
    matches.map(Number).filter((year) => year >= EARLIEST && year <= latest),
  );

  return plausible.size === 1 ? [...plausible][0]! : null;
}

/**
 * The same period, one year on.
 *
 * A year-end rolls forward twelve months rather than being guessed from
 * anything Karbon holds — Karbon has no year-end field at all, and a due date
 * is a deadline rather than a period end.
 *
 * 29 February is the case that makes this worth a function. Adding a year to
 * 2028-02-29 with `setUTCFullYear` lands on 2029-03-01, silently moving a
 * year-end into the next month and with it every deadline computed from it. A
 * February year-end stays the last day of February.
 */
export function rollYearEndForward(previous: Date): Date {
  const year = previous.getUTCFullYear() + 1;
  const month = previous.getUTCMonth();
  const day = previous.getUTCDate();

  // The zeroth day of the next month is the last day of this one.
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return new Date(Date.UTC(year, month, Math.min(day, lastDayOfTargetMonth)));
}
