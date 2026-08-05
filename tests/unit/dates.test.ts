import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DATE_RULES,
  addBusinessDays,
  addMonths,
  evaluateDateRule,
  federalHolidays,
  toIsoDate,
  utcDate,
} from '@element/dates';

function ruleFor(code: string) {
  const rule = DEFAULT_DATE_RULES.find((candidate) => candidate.code === code);
  if (!rule) throw new Error(`Missing seeded rule ${code}`);
  return rule;
}

describe('calendar arithmetic', () => {
  it('clamps month addition to the end of the target month', () => {
    // 31 August plus six months is 28 February, not 3 March.
    expect(toIsoDate(addMonths(utcDate(2025, 8, 31), 6))).toBe('2026-02-28');
    expect(toIsoDate(addMonths(utcDate(2023, 8, 31), 6))).toBe('2024-02-29');
    expect(toIsoDate(addMonths(utcDate(2026, 3, 31), 2))).toBe('2026-05-31');
  });

  it('skips weekends and statutory holidays when counting business days', () => {
    // 2026-07-01 is Canada Day (a Wednesday).
    expect(toIsoDate(addBusinessDays(utcDate(2026, 6, 30), 1))).toBe('2026-07-02');
    // Friday plus one business day is Monday.
    expect(toIsoDate(addBusinessDays(utcDate(2026, 6, 26), 1))).toBe('2026-06-29');
  });

  it('computes the movable holidays', () => {
    const holidays = federalHolidays(2026).map(toIsoDate);
    expect(holidays).toContain('2026-01-01');
    expect(holidays).toContain('2026-07-01');
    expect(holidays).toContain('2026-12-25');
    // Good Friday 2026 is 3 April.
    expect(holidays).toContain('2026-04-03');
  });
});

describe('T2 deadlines', () => {
  it('adds six months to the year-end for the filing deadline', () => {
    const result = evaluateDateRule('t2.filing_deadline', ruleFor('t2.filing_deadline').definition, {
      yearEnd: utcDate(2026, 3, 31),
    });

    expect(result.isBlocked).toBe(false);
    expect(result.resultIso).toBe('2026-09-30');
    expect(result.requiresConfirmation).toBe(true);
    expect(result.assumptions.join(' ')).toMatch(/six months/i);
  });

  it('blocks the balance-due day until the three-month eligibility is confirmed', () => {
    const unconfirmed = evaluateDateRule('t2.balance_due_date', ruleFor('t2.balance_due_date').definition, {
      yearEnd: utcDate(2026, 3, 31),
    });

    // Eligibility is a fact about the corporation, so the engine refuses to guess.
    expect(unconfirmed.isBlocked).toBe(true);
    expect(unconfirmed.missingFacts).toContain('qualifiesForThreeMonthBalanceDueDay');
    expect(unconfirmed.result).toBeNull();
  });

  it('uses two months by default and three when the corporation qualifies', () => {
    const twoMonth = evaluateDateRule('t2.balance_due_date', ruleFor('t2.balance_due_date').definition, {
      yearEnd: utcDate(2026, 3, 31),
      facts: { qualifiesForThreeMonthBalanceDueDay: false },
    });
    expect(twoMonth.resultIso).toBe('2026-05-31');

    const threeMonth = evaluateDateRule('t2.balance_due_date', ruleFor('t2.balance_due_date').definition, {
      yearEnd: utcDate(2026, 3, 31),
      facts: { qualifiesForThreeMonthBalanceDueDay: true },
    });
    expect(threeMonth.resultIso).toBe('2026-06-30');
    expect(threeMonth.assumptions.join(' ')).toMatch(/three-month/i);
  });
});

describe('T1 deadlines', () => {
  it('uses 30 April for the general filing deadline', () => {
    const result = evaluateDateRule('t1.filing_deadline', ruleFor('t1.filing_deadline').definition, {
      taxYear: 2026,
      facts: { isSelfEmployedOrSpouseOfSelfEmployed: false },
    });
    expect(result.resultIso).toBe('2027-04-30');
  });

  it('uses 15 June when self-employment income is reported', () => {
    const result = evaluateDateRule('t1.filing_deadline', ruleFor('t1.filing_deadline').definition, {
      taxYear: 2026,
      facts: { isSelfEmployedOrSpouseOfSelfEmployed: true },
    });
    expect(result.resultIso).toBe('2027-06-15');
    expect(result.assumptions.join(' ')).toMatch(/self-employment/i);
  });

  it('keeps the payment deadline at 30 April regardless', () => {
    const result = evaluateDateRule('t1.payment_deadline', ruleFor('t1.payment_deadline').definition, {
      taxYear: 2026,
      facts: { isSelfEmployedOrSpouseOfSelfEmployed: true },
    });
    expect(result.resultIso).toBe('2027-04-30');
  });

  it('blocks when the self-employment fact has not been supplied', () => {
    const result = evaluateDateRule('t1.filing_deadline', ruleFor('t1.filing_deadline').definition, {
      taxYear: 2026,
    });
    expect(result.isBlocked).toBe(true);
    expect(result.missingFacts).toContain('isSelfEmployedOrSpouseOfSelfEmployed');
  });
});

describe('T3 deadlines', () => {
  it('is 90 days after the trust year-end', () => {
    const result = evaluateDateRule('t3.filing_deadline', ruleFor('t3.filing_deadline').definition, {
      yearEnd: utcDate(2026, 12, 31),
    });
    expect(result.resultIso).toBe('2027-03-31');
  });
});

describe('derived firm dates', () => {
  it('works backwards from the filing deadline', () => {
    const result = evaluateDateRule('t2.target_completion_date', ruleFor('t2.target_completion_date').definition, {
      filingDeadline: utcDate(2026, 9, 30),
    });
    // 30 days before 30 September is 31 August, which is a Monday, so the
    // business-day roll leaves it where it is.
    expect(result.resultIso).toBe('2026-08-31');
  });

  it('blocks when the date it depends on is not known yet', () => {
    const result = evaluateDateRule('t2.target_completion_date', ruleFor('t2.target_completion_date').definition, {});
    expect(result.isBlocked).toBe(true);
    expect(result.blockedReason).toMatch(/filing deadline/i);
  });

  it('does not require confirmation for the Adobe expiry', () => {
    const result = evaluateDateRule('signing.expiration_date', ruleFor('signing.expiration_date').definition, {
      dateSent: utcDate(2026, 8, 4),
    });
    expect(result.resultIso).toBe('2026-09-03');
    expect(result.requiresConfirmation).toBe(false);
  });
});

describe('rule engine safety', () => {
  it('does not add a year to last year to get this year', () => {
    // Same rule, two different year-ends: the results are derived from the
    // input, not from an offset applied to a previous result.
    const first = evaluateDateRule('t2.filing_deadline', ruleFor('t2.filing_deadline').definition, {
      yearEnd: utcDate(2025, 2, 28),
    });
    const second = evaluateDateRule('t2.filing_deadline', ruleFor('t2.filing_deadline').definition, {
      yearEnd: utcDate(2026, 2, 28),
    });

    expect(first.resultIso).toBe('2025-08-28');
    expect(second.resultIso).toBe('2026-08-28');
  });

  it('rejects a malformed rule definition rather than producing a date', () => {
    const result = evaluateDateRule('broken', { base: 'NOT_A_BASE' }, { yearEnd: utcDate(2026, 3, 31) });
    expect(result.isBlocked).toBe(true);
    expect(result.result).toBeNull();
  });

  it('records the rule, input and result for every calculation', () => {
    const result = evaluateDateRule('t2.filing_deadline', ruleFor('t2.filing_deadline').definition, {
      yearEnd: utcDate(2026, 3, 31),
    });
    expect(result.ruleCode).toBe('t2.filing_deadline');
    expect(toIsoDate(result.inputDate as Date)).toBe('2026-03-31');
    expect(result.assumptions.length).toBeGreaterThan(0);
  });
});
