/**
 * Calendar primitives.
 *
 * All engagement dates are calendar dates, not instants. They are represented
 * as UTC midnight so that a server timezone change can never shift a filing
 * deadline by a day.
 */

export type IsoDate = string; // YYYY-MM-DD

export function utcDate(year: number, month1to12: number, day: number): Date {
  return new Date(Date.UTC(year, month1to12 - 1, day));
}

export function toIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

export function fromIsoDate(value: IsoDate): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Not an ISO date: ${value}`);
  const [, y, m, d] = match as unknown as [string, string, string, string];
  return utcDate(Number(y), Number(m), Number(d));
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addDays(date: Date, days: number): Date {
  const next = startOfUtcDay(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function daysInMonth(year: number, month0to11: number): number {
  return new Date(Date.UTC(year, month0to11 + 1, 0)).getUTCDate();
}

/**
 * Adds calendar months, clamping to the end of the target month.
 * 2025-08-31 + 6 months = 2026-02-28 (not 2026-03-03).
 */
export function addMonths(date: Date, months: number): Date {
  const base = startOfUtcDay(date);
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth() + months;
  const day = base.getUTCDate();

  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));

  return new Date(Date.UTC(targetYear, targetMonth, clampedDay));
}

export function addYears(date: Date, years: number): Date {
  return addMonths(date, years * 12);
}

export function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Fixed-date Canadian federal statutory holidays plus the movable ones that
 * matter for business-day counting.
 *
 * This list is used for reminder scheduling and "business day" arithmetic only.
 * It is deliberately NOT used to silently shift a statutory filing deadline —
 * deadline weekend/holiday relief is a legal question that a reviewer confirms.
 */
export function federalHolidays(year: number): Date[] {
  const nthWeekday = (month1to12: number, weekday: number, nth: number): Date => {
    const first = utcDate(year, month1to12, 1);
    const offset = (weekday - first.getUTCDay() + 7) % 7;
    return addDays(first, offset + (nth - 1) * 7);
  };

  const mondayBefore = (month1to12: number, day: number): Date => {
    const target = utcDate(year, month1to12, day);
    const back = (target.getUTCDay() + 6) % 7 || 7;
    return addDays(target, -back);
  };

  // Good Friday: the Friday before Easter Sunday (anonymous Gregorian algorithm).
  const easter = ((): Date => {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return utcDate(year, month, day);
  })();

  return [
    utcDate(year, 1, 1), // New Year's Day
    addDays(easter, -2), // Good Friday
    mondayBefore(5, 25), // Victoria Day
    utcDate(year, 7, 1), // Canada Day
    nthWeekday(9, 1, 1), // Labour Day
    utcDate(year, 9, 30), // National Day for Truth and Reconciliation
    nthWeekday(10, 1, 2), // Thanksgiving
    utcDate(year, 11, 11), // Remembrance Day
    utcDate(year, 12, 25), // Christmas Day
    utcDate(year, 12, 26), // Boxing Day
  ];
}

export function isHoliday(date: Date, holidays?: readonly Date[]): boolean {
  const list = holidays ?? federalHolidays(date.getUTCFullYear());
  const iso = toIsoDate(date);
  return list.some((holiday) => toIsoDate(holiday) === iso);
}

export function isBusinessDay(date: Date, holidays?: readonly Date[]): boolean {
  return !isWeekend(date) && !isHoliday(date, holidays);
}

export function addBusinessDays(date: Date, count: number): Date {
  let current = startOfUtcDay(date);
  let remaining = Math.abs(count);
  const step = count >= 0 ? 1 : -1;
  while (remaining > 0) {
    current = addDays(current, step);
    if (isBusinessDay(current)) remaining -= 1;
  }
  return current;
}

/** Rolls forward to the next business day if the date falls on a weekend/holiday. */
export function nextBusinessDay(date: Date): Date {
  let current = startOfUtcDay(date);
  while (!isBusinessDay(current)) current = addDays(current, 1);
  return current;
}

export function isLastDayOfMonth(date: Date): boolean {
  return date.getUTCDate() === daysInMonth(date.getUTCFullYear(), date.getUTCMonth());
}

/** End of the month containing `date`. */
export function endOfMonth(date: Date): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return utcDate(year, month + 1, daysInMonth(year, month));
}
