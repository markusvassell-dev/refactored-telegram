import { Decimal } from 'decimal.js';

/**
 * Money.
 *
 * Every financial value in this application is decimal, never binary floating
 * point. Values are persisted as NUMERIC(12,2) and carried in memory as
 * `Decimal`.
 */

// Enough precision for intermediate percentage arithmetic; results are always
// quantised back to 2 decimal places before storage.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export type MoneyInput = Decimal | string | number;

export function money(value: MoneyInput): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Not a finite monetary value: ${value}`);
    // Route through a string so a float literal cannot smuggle in binary error.
    return new Decimal(value.toFixed(6));
  }
  const trimmed = value.trim().replace(/[$,\s]/g, '');
  if (trimmed === '') throw new Error('Empty monetary value');
  const parsed = new Decimal(trimmed);
  if (!parsed.isFinite()) throw new Error(`Not a finite monetary value: ${value}`);
  return parsed;
}

/** Quantises to cents using half-up rounding. Storage precision. */
export function toCents(value: MoneyInput): Decimal {
  return money(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * The firm's rounding rule: always round **upward** to the next multiple of $5.
 *
 *   rounded = ceiling(fee / 5) * 5
 *
 * $1,030 -> $1,030   $1,031 -> $1,035   $1,035 -> $1,035   $1,036 -> $1,040
 */
export function roundUpToNearest5(value: MoneyInput): Decimal {
  const amount = money(value);
  if (amount.isNegative()) {
    throw new Error('Fee rounding is not defined for negative amounts');
  }
  return amount.dividedBy(5).ceil().times(5).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function formatMoney(value: MoneyInput, options: { symbol?: boolean } = {}): string {
  const amount = toCents(value);
  const formatted = amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return options.symbol === false ? formatted : `$${formatted}`;
}

/** Percentage change from `from` to `to`, as a Decimal percentage (e.g. 3.5). */
export function percentageChange(from: MoneyInput, to: MoneyInput): Decimal | null {
  const base = money(from);
  if (base.isZero()) return null;
  return money(to).minus(base).dividedBy(base).times(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

export function isZero(value: MoneyInput): boolean {
  return money(value).isZero();
}

export function maxMoney(a: MoneyInput, b: MoneyInput): Decimal {
  const left = money(a);
  const right = money(b);
  return left.greaterThan(right) ? left : right;
}
