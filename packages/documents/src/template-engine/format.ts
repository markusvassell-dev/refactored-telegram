import { formatMoney, money, type MoneyInput } from '@element/shared';
import type { FieldDataType } from './manifest.js';

/**
 * Value formatting for document rendering.
 *
 * Formatting happens once, at the boundary between structured data and the
 * document. The renderer only ever writes already-formatted strings.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "March 31, 2026" — the style used throughout the approved templates. */
export function formatLongDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : value;
  if (Number.isNaN(date.getTime())) return '';
  const month = MONTHS[date.getUTCMonth()] ?? '';
  return `${month} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

export function formatAmountForTemplate(value: MoneyInput | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  // The templates already print the dollar sign, e.g. "$[AMOUNT]".
  return formatMoney(money(value), { symbol: false });
}

export interface FormatOptions {
  dataType: FieldDataType;
  /** Rendered when the value is absent. Defaults to an empty string. */
  fallback?: string;
}

export function formatFieldValue(value: unknown, options: FormatOptions): string {
  if (value === null || value === undefined || value === '') return options.fallback ?? '';

  switch (options.dataType) {
    case 'DATE':
      return formatLongDate(value as Date | string);
    case 'MONEY':
      return formatAmountForTemplate(value as MoneyInput);
    case 'YEAR':
      return String(value).trim();
    case 'BOOLEAN':
      return value ? 'Yes' : 'No';
    case 'MULTILINE':
      return String(value).replace(/\r\n/g, '\n').trim();
    default:
      return String(value).trim();
  }
}

/** "Not applicable" is written out rather than left blank in fee tables. */
export const NOT_APPLICABLE = 'Not applicable';
