// Imported from the specific modules rather than the package barrel: the
// barrel re-exports crypto and id helpers that need `node:crypto`, and the
// pricing engine is pure arithmetic that the review UI runs in the browser to
// preview a rule. Pulling the barrel in would drag Node built-ins with it.
import { ValidationError } from '@element/shared/errors';
import {
  Decimal,
  formatMoney,
  money,
  percentageChange,
  roundUpToNearest5,
  type MoneyInput,
} from '@element/shared/money';
import type { FeeKind, FeeMethod, ValueSource } from '@element/shared/domain';

/**
 * The pricing engine.
 *
 * All arithmetic is decimal. The firm's rounding rule is always applied last:
 *
 *   rounded_final_fee = ceiling(calculated_fee / 5) * 5
 *
 * even for an exact desired final price, unless an administrator has created an
 * explicit no-rounding exception policy (`skipRounding`).
 */

export interface PriceRule {
  method: FeeMethod;
  /** Percentage points, e.g. 3 means 3%. */
  percentage?: MoneyInput | null;
  fixedAmount?: MoneyInput | null;
  exactTarget?: MoneyInput | null;
  skipRounding?: boolean;
}

export interface FeeCalculationInput {
  feeKind: FeeKind;
  rule: PriceRule;
  previousFee?: MoneyInput | null;
  previousFeeSource?: ValueSource | null;
  /** Threshold above which partner approval is required. Default 10%. */
  highIncreaseThresholdPercent?: MoneyInput;
  /** Set when a user is deliberately overriding the computed result. */
  manualOverride?: { amount: MoneyInput; reason: string } | null;
  /** A second prior-year fee found in a different document, if any. */
  conflictingPreviousFee?: MoneyInput | null;
  /** Prior-year compilation selection vs this year's, for T2 warnings. */
  compilation?: { priorYearSelected: boolean | null; currentSelected: boolean | null };
}

export type ApprovalRequirement = 'NONE' | 'FEE_DECREASE' | 'FEE_HIGH_INCREASE';

export interface FeeWarning {
  code:
    | 'FEE_UNCHANGED'
    | 'FEE_DECREASED'
    | 'FEE_ABOVE_THRESHOLD'
    | 'PRIOR_FEE_MISSING'
    | 'PRIOR_FEE_CONFLICT'
    | 'COMPILATION_DROPPED'
    | 'COMPILATION_ADDED';
  message: string;
}

export interface FeeCalculationResult {
  feeKind: FeeKind;
  method: FeeMethod;
  previousFee: Decimal | null;
  previousFeeSource: ValueSource | null;
  percentage: Decimal | null;
  fixedAmount: Decimal | null;
  exactTarget: Decimal | null;
  /** Result before rounding. Null when the calculation is blocked. */
  unroundedFee: Decimal | null;
  /** Final fee. Null when the calculation is blocked. */
  roundedFee: Decimal | null;
  increaseAmount: Decimal | null;
  /** Effective percentage increase after rounding. */
  effectivePercentage: Decimal | null;
  roundingApplied: boolean;
  isManualOverride: boolean;
  overrideReason: string | null;
  requiredApproval: ApprovalRequirement;
  warnings: FeeWarning[];
  /** True when no fee can be produced without human input. */
  isBlocked: boolean;
  blockedReason: string | null;
  /** Fees are pre-GST unless configuration says otherwise. */
  isPreTax: boolean;
}

const DEFAULT_HIGH_INCREASE_THRESHOLD = 10;

function optionalMoney(value: MoneyInput | null | undefined): Decimal | null {
  if (value === null || value === undefined || value === '') return null;
  return money(value);
}

/**
 * Applies a price rule to a previous fee.
 *
 * When no prior-year fee exists the engine does not guess and does not produce
 * a zero-dollar fee: it returns a blocked result that the workflow turns into a
 * blocked engagement until a base fee or rate-card selection is confirmed.
 */
export function calculateFee(input: FeeCalculationInput): FeeCalculationResult {
  const previousFee = optionalMoney(input.previousFee);
  const percentage = optionalMoney(input.rule.percentage);
  const fixedAmount = optionalMoney(input.rule.fixedAmount);
  const exactTarget = optionalMoney(input.rule.exactTarget);
  const threshold = optionalMoney(input.highIncreaseThresholdPercent) ?? money(DEFAULT_HIGH_INCREASE_THRESHOLD);
  const skipRounding = input.rule.skipRounding === true;

  const warnings: FeeWarning[] = [];

  if (input.compilation) {
    const { priorYearSelected, currentSelected } = input.compilation;
    if (priorYearSelected === true && currentSelected === false) {
      warnings.push({
        code: 'COMPILATION_DROPPED',
        message: 'Compilation services were selected last year but are not selected this year.',
      });
    }
    if (priorYearSelected === false && currentSelected === true) {
      warnings.push({
        code: 'COMPILATION_ADDED',
        message: 'Compilation services were not selected last year but are selected this year.',
      });
    }
  }

  const conflicting = optionalMoney(input.conflictingPreviousFee);
  if (previousFee && conflicting && !previousFee.equals(conflicting)) {
    warnings.push({
      code: 'PRIOR_FEE_CONFLICT',
      message: `Two documents show different prior-year fees (${formatMoney(previousFee)} and ${formatMoney(conflicting)}). Confirm which is correct.`,
    });
  }

  const blocked = (reason: string): FeeCalculationResult => ({
    feeKind: input.feeKind,
    method: input.rule.method,
    previousFee,
    previousFeeSource: input.previousFeeSource ?? null,
    percentage,
    fixedAmount,
    exactTarget,
    unroundedFee: null,
    roundedFee: null,
    increaseAmount: null,
    effectivePercentage: null,
    roundingApplied: !skipRounding,
    isManualOverride: false,
    overrideReason: null,
    requiredApproval: 'NONE',
    warnings,
    isBlocked: true,
    blockedReason: reason,
    isPreTax: true,
  });

  // A manual override short-circuits the rule but is still rounded and still
  // subject to the decrease / high-increase approval requirements.
  let unrounded: Decimal;

  if (input.manualOverride) {
    if (!input.manualOverride.reason?.trim()) {
      throw new ValidationError('A manual fee override requires a written reason.');
    }
    unrounded = money(input.manualOverride.amount);
  } else {
    switch (input.rule.method) {
      case 'EXACT_TARGET': {
        if (!exactTarget) {
          return blocked('An exact target price is required for the exact-final-price method.');
        }
        unrounded = exactTarget;
        break;
      }
      case 'NO_INCREASE': {
        if (!previousFee) {
          warnings.push({ code: 'PRIOR_FEE_MISSING', message: 'No prior-year fee was found.' });
          return blocked(
            'No prior-year fee was found. Enter a base fee or select an approved rate card before generating.',
          );
        }
        unrounded = previousFee;
        break;
      }
      case 'PERCENTAGE': {
        if (!previousFee) {
          warnings.push({ code: 'PRIOR_FEE_MISSING', message: 'No prior-year fee was found.' });
          return blocked(
            'No prior-year fee was found. Enter a base fee or select an approved rate card before generating.',
          );
        }
        if (percentage === null) {
          return blocked('A percentage is required for the percentage-increase method.');
        }
        unrounded = previousFee.times(percentage.dividedBy(100).plus(1));
        break;
      }
      case 'FIXED_AMOUNT': {
        if (!previousFee) {
          warnings.push({ code: 'PRIOR_FEE_MISSING', message: 'No prior-year fee was found.' });
          return blocked(
            'No prior-year fee was found. Enter a base fee or select an approved rate card before generating.',
          );
        }
        if (fixedAmount === null) {
          return blocked('A dollar amount is required for the fixed-dollar-increase method.');
        }
        unrounded = previousFee.plus(fixedAmount);
        break;
      }
      default: {
        return blocked(`Unsupported price method: ${String(input.rule.method)}`);
      }
    }
  }

  unrounded = unrounded.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  if (unrounded.isNegative()) {
    return blocked('A negative fee cannot be produced.');
  }

  const rounded = skipRounding ? unrounded : roundUpToNearest5(unrounded);

  const increaseAmount = previousFee ? rounded.minus(previousFee) : null;
  const effectivePercentage = previousFee ? percentageChange(previousFee, rounded) : null;

  let requiredApproval: ApprovalRequirement = 'NONE';

  if (previousFee) {
    if (rounded.lessThan(previousFee)) {
      requiredApproval = 'FEE_DECREASE';
      warnings.push({
        code: 'FEE_DECREASED',
        message: `The proposed fee (${formatMoney(rounded)}) is lower than last year (${formatMoney(previousFee)}). A written reason and partner approval are required.`,
      });
    } else if (rounded.equals(previousFee)) {
      warnings.push({ code: 'FEE_UNCHANGED', message: 'The proposed fee is unchanged from last year.' });
    } else if (effectivePercentage && effectivePercentage.greaterThan(threshold)) {
      requiredApproval = 'FEE_HIGH_INCREASE';
      warnings.push({
        code: 'FEE_ABOVE_THRESHOLD',
        message: `The increase of ${effectivePercentage.toFixed(2)}% exceeds the ${threshold.toFixed(2)}% threshold and requires partner approval.`,
      });
    }
  }

  // A fee decrease always requires a written reason, even without an override.
  if (requiredApproval === 'FEE_DECREASE' && !input.manualOverride) {
    warnings.push({
      code: 'FEE_DECREASED',
      message: 'Record the reason for the decrease as a manual override before submitting for approval.',
    });
  }

  return {
    feeKind: input.feeKind,
    method: input.rule.method,
    previousFee,
    previousFeeSource: input.previousFeeSource ?? null,
    percentage,
    fixedAmount,
    exactTarget,
    unroundedFee: unrounded,
    roundedFee: rounded,
    increaseAmount,
    effectivePercentage,
    roundingApplied: !skipRounding,
    isManualOverride: Boolean(input.manualOverride),
    overrideReason: input.manualOverride?.reason ?? null,
    requiredApproval,
    warnings: dedupeWarnings(warnings),
    isBlocked: false,
    blockedReason: null,
    isPreTax: true,
  };
}

function dedupeWarnings(warnings: FeeWarning[]): FeeWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * T2 engagements price the return and the compilation separately.
 * When compilation is not selected, the compilation fee is marked not
 * applicable rather than set to zero.
 */
export interface T2FeeInput {
  t2: Omit<FeeCalculationInput, 'feeKind'>;
  compilation: Omit<FeeCalculationInput, 'feeKind'> | null;
  compilationSelected: boolean | null;
}

export interface T2FeeResult {
  t2: FeeCalculationResult;
  compilation: FeeCalculationResult | null;
  compilationNotApplicable: boolean;
}

export function calculateT2Fees(input: T2FeeInput): T2FeeResult {
  const t2 = calculateFee({ ...input.t2, feeKind: 'T2_PREPARATION' });

  if (input.compilationSelected !== true || !input.compilation) {
    return { t2, compilation: null, compilationNotApplicable: true };
  }

  const compilation = calculateFee({ ...input.compilation, feeKind: 'CSRS_4200_COMPILATION' });
  return { t2, compilation, compilationNotApplicable: false };
}
