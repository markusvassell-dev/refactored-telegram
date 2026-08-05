import { describe, expect, it } from 'vitest';
import { calculateFee, calculateT2Fees, resolveRule, type CandidateRule } from '@element/pricing';
import { Decimal, money, roundUpToNearest5 } from '@element/shared';

describe('rounding rule', () => {
  it('always rounds upward to the next multiple of $5', () => {
    // The exact examples from the specification.
    expect(roundUpToNearest5('1030').toFixed(2)).toBe('1030.00');
    expect(roundUpToNearest5('1031').toFixed(2)).toBe('1035.00');
    expect(roundUpToNearest5('1035').toFixed(2)).toBe('1035.00');
    expect(roundUpToNearest5('1036').toFixed(2)).toBe('1040.00');
  });

  it('rounds fractional cents upward too', () => {
    expect(roundUpToNearest5('1030.01').toFixed(2)).toBe('1035.00');
    expect(roundUpToNearest5('0.01').toFixed(2)).toBe('5.00');
    expect(roundUpToNearest5('0').toFixed(2)).toBe('0.00');
  });

  it('refuses to round a negative amount', () => {
    expect(() => roundUpToNearest5('-5')).toThrow(/negative/i);
  });
});

describe('decimal arithmetic', () => {
  it('does not use binary floating point', () => {
    // 0.1 + 0.2 must be exactly 0.3, which binary floating point cannot do.
    expect(money('0.1').plus(money('0.2')).equals(money('0.3'))).toBe(true);
    expect(money(1030.005).toFixed(3)).toBe('1030.005');
  });

  it('parses currency-formatted input', () => {
    expect(money('$1,234.56').toFixed(2)).toBe('1234.56');
  });
});

describe('percentage increase', () => {
  it('applies the specification example exactly', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'PERCENTAGE', percentage: 3 },
      previousFee: '1000',
      previousFeeSource: 'PRIOR_YEAR_DOCUMENT',
    });

    expect(result.unroundedFee?.toFixed(2)).toBe('1030.00');
    expect(result.roundedFee?.toFixed(2)).toBe('1030.00');
    expect(result.increaseAmount?.toFixed(2)).toBe('30.00');
    expect(result.isBlocked).toBe(false);
  });

  it('rounds the calculated result upward when it is not a multiple of five', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'PERCENTAGE', percentage: 3 },
      previousFee: '2000',
    });

    expect(result.unroundedFee?.toFixed(2)).toBe('2060.00');
    expect(result.roundedFee?.toFixed(2)).toBe('2060.00');

    const uneven = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'PERCENTAGE', percentage: 3.25 },
      previousFee: '1000',
    });
    expect(uneven.unroundedFee?.toFixed(2)).toBe('1032.50');
    expect(uneven.roundedFee?.toFixed(2)).toBe('1035.00');
  });

  it('reports the effective percentage after rounding', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'PERCENTAGE', percentage: 3 },
      previousFee: '1010',
    });
    // 1010 * 1.03 = 1040.30 -> 1045.00, an effective 3.4653%.
    expect(result.unroundedFee?.toFixed(2)).toBe('1040.30');
    expect(result.roundedFee?.toFixed(2)).toBe('1045.00');
    expect(result.effectivePercentage?.toFixed(4)).toBe('3.4653');
  });
});

describe('fixed-dollar increase', () => {
  it('applies the specification example exactly', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'FIXED_AMOUNT', fixedAmount: 32 },
      previousFee: '1000',
    });

    expect(result.unroundedFee?.toFixed(2)).toBe('1032.00');
    expect(result.roundedFee?.toFixed(2)).toBe('1035.00');
  });
});

describe('exact target price', () => {
  it('is still rounded upward to the next $5', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'EXACT_TARGET', exactTarget: 1117 },
      previousFee: '1000',
    });

    expect(result.unroundedFee?.toFixed(2)).toBe('1117.00');
    expect(result.roundedFee?.toFixed(2)).toBe('1120.00');
  });

  it('honours an explicit administrator no-rounding exception', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'EXACT_TARGET', exactTarget: 1117, skipRounding: true },
      previousFee: '1000',
    });

    expect(result.roundedFee?.toFixed(2)).toBe('1117.00');
    expect(result.roundingApplied).toBe(false);
  });
});

describe('no increase', () => {
  it('keeps the prior-year fee and warns that nothing changed', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'NO_INCREASE' },
      previousFee: '1030',
    });

    expect(result.roundedFee?.toFixed(2)).toBe('1030.00');
    expect(result.warnings.map((warning) => warning.code)).toContain('FEE_UNCHANGED');
    expect(result.requiredApproval).toBe('NONE');
  });
});

describe('missing prior-year fee', () => {
  it('blocks rather than guessing or producing a zero-dollar fee', () => {
    for (const method of ['NO_INCREASE', 'PERCENTAGE', 'FIXED_AMOUNT'] as const) {
      const result = calculateFee({
        feeKind: 'T2_PREPARATION',
        rule: { method, percentage: 3, fixedAmount: 32 },
        previousFee: null,
      });

      expect(result.isBlocked).toBe(true);
      expect(result.roundedFee).toBeNull();
      expect(result.blockedReason).toMatch(/no prior-year fee/i);
      expect(result.warnings.map((warning) => warning.code)).toContain('PRIOR_FEE_MISSING');
    }
  });

  it('allows an exact target to stand in for a missing prior-year fee', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'EXACT_TARGET', exactTarget: 1500 },
      previousFee: null,
    });

    expect(result.isBlocked).toBe(false);
    expect(result.roundedFee?.toFixed(2)).toBe('1500.00');
  });
});

describe('approval requirements', () => {
  it('requires partner approval for a decrease', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'EXACT_TARGET', exactTarget: 900 },
      previousFee: '1000',
    });

    expect(result.requiredApproval).toBe('FEE_DECREASE');
    expect(result.warnings.map((warning) => warning.code)).toContain('FEE_DECREASED');
  });

  it('requires partner approval above the configured threshold', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'PERCENTAGE', percentage: 15 },
      previousFee: '1000',
      highIncreaseThresholdPercent: 10,
    });

    expect(result.requiredApproval).toBe('FEE_HIGH_INCREASE');
    expect(result.warnings.map((warning) => warning.code)).toContain('FEE_ABOVE_THRESHOLD');
  });

  it('does not require approval just below the threshold', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'PERCENTAGE', percentage: 5 },
      previousFee: '1000',
      highIncreaseThresholdPercent: 10,
    });

    expect(result.requiredApproval).toBe('NONE');
  });

  it('honours a different administrator-configured threshold', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'PERCENTAGE', percentage: 5 },
      previousFee: '1000',
      highIncreaseThresholdPercent: 3,
    });

    expect(result.requiredApproval).toBe('FEE_HIGH_INCREASE');
  });
});

describe('manual override', () => {
  it('demands a written reason', () => {
    expect(() =>
      calculateFee({
        feeKind: 'T2_PREPARATION',
        rule: { method: 'PERCENTAGE', percentage: 3 },
        previousFee: '1000',
        manualOverride: { amount: new Decimal(1200), reason: '   ' },
      }),
    ).toThrow(/written reason/i);
  });

  it('is still rounded and still subject to approval rules', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'PERCENTAGE', percentage: 3 },
      previousFee: '1000',
      manualOverride: { amount: money('1201'), reason: 'Scope increased materially' },
      highIncreaseThresholdPercent: 10,
    });

    expect(result.roundedFee?.toFixed(2)).toBe('1205.00');
    expect(result.isManualOverride).toBe(true);
    expect(result.requiredApproval).toBe('FEE_HIGH_INCREASE');
  });
});

describe('conflicting prior-year fees', () => {
  it('warns when two documents disagree', () => {
    const result = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'PERCENTAGE', percentage: 3 },
      previousFee: '1000',
      conflictingPreviousFee: '1100',
    });

    expect(result.warnings.map((warning) => warning.code)).toContain('PRIOR_FEE_CONFLICT');
  });
});

describe('T2 and compilation fees', () => {
  it('calculates them separately', () => {
    const result = calculateT2Fees({
      t2: { rule: { method: 'PERCENTAGE', percentage: 3 }, previousFee: '2000' },
      compilation: { rule: { method: 'PERCENTAGE', percentage: 3.5 }, previousFee: '1000' },
      compilationSelected: true,
    });

    expect(result.t2.roundedFee?.toFixed(2)).toBe('2060.00');
    expect(result.compilation?.roundedFee?.toFixed(2)).toBe('1035.00');
    expect(result.compilationNotApplicable).toBe(false);
  });

  it('marks the compilation fee not applicable when compilation is not selected', () => {
    const result = calculateT2Fees({
      t2: { rule: { method: 'PERCENTAGE', percentage: 3 }, previousFee: '2000' },
      compilation: { rule: { method: 'PERCENTAGE', percentage: 3.5 }, previousFee: '1000' },
      compilationSelected: false,
    });

    // Not zero — not applicable.
    expect(result.compilation).toBeNull();
    expect(result.compilationNotApplicable).toBe(true);
  });

  it('treats an unconfirmed compilation selection as not applicable', () => {
    const result = calculateT2Fees({
      t2: { rule: { method: 'PERCENTAGE', percentage: 3 }, previousFee: '2000' },
      compilation: null,
      compilationSelected: null,
    });
    expect(result.compilationNotApplicable).toBe(true);
  });

  it('warns when the compilation selection changed from last year', () => {
    const dropped = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'PERCENTAGE', percentage: 3 },
      previousFee: '2000',
      compilation: { priorYearSelected: true, currentSelected: false },
    });
    expect(dropped.warnings.map((warning) => warning.code)).toContain('COMPILATION_DROPPED');

    const added = calculateFee({
      feeKind: 'T2_PREPARATION',
      rule: { method: 'PERCENTAGE', percentage: 3 },
      previousFee: '2000',
      compilation: { priorYearSelected: false, currentSelected: true },
    });
    expect(added.warnings.map((warning) => warning.code)).toContain('COMPILATION_ADDED');
  });
});

describe('price rule resolution', () => {
  const base = {
    isActive: true,
    effectiveFrom: new Date('2020-01-01'),
    method: 'PERCENTAGE' as const,
    percentage: 3,
  };

  const rules: CandidateRule[] = [
    { ...base, id: 'global', level: 'GLOBAL' },
    { ...base, id: 'type', level: 'ENGAGEMENT_TYPE', engagementType: 'T2', percentage: 4 },
    { ...base, id: 'group', level: 'PARTNER_OR_GROUP', clientGroup: 'Group A', percentage: 5 },
    { ...base, id: 'client', level: 'CLIENT', clientId: 'client-1', percentage: 6 },
  ];

  it('prefers the most specific applicable rule', () => {
    const resolved = resolveRule(rules, {
      engagementType: 'T2',
      feeKind: 'T2_PREPARATION',
      clientId: 'client-1',
      clientGroup: 'Group A',
    });
    expect(resolved?.id).toBe('client');
  });

  it('falls back through the levels when the specific rules do not apply', () => {
    expect(
      resolveRule(rules, { engagementType: 'T2', feeKind: 'T2_PREPARATION', clientId: 'other', clientGroup: 'Group A' })
        ?.id,
    ).toBe('group');

    expect(
      resolveRule(rules, { engagementType: 'T2', feeKind: 'T2_PREPARATION', clientId: 'other', clientGroup: 'Other' })
        ?.id,
    ).toBe('type');

    expect(
      resolveRule(rules, { engagementType: 'T3', feeKind: 'T3_PREPARATION', clientId: 'other', clientGroup: 'Other' })
        ?.id,
    ).toBe('global');
  });

  it('ignores rules that are inactive or outside their effective window', () => {
    const expired: CandidateRule[] = [
      { ...base, id: 'expired', level: 'CLIENT', clientId: 'client-1', effectiveTo: new Date('2021-01-01') },
      { ...base, id: 'inactive', level: 'CLIENT', clientId: 'client-1', isActive: false },
    ];

    expect(
      resolveRule(expired, {
        engagementType: 'T2',
        feeKind: 'T2_PREPARATION',
        clientId: 'client-1',
        asOf: new Date('2026-01-01'),
      }),
    ).toBeNull();
  });

  it('returns null rather than silently assuming no increase', () => {
    expect(resolveRule([], { engagementType: 'T2', feeKind: 'T2_PREPARATION', clientId: 'x' })).toBeNull();
  });
});
