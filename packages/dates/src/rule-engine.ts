import { z } from 'zod';
import { addBusinessDays, addDays, addMonths, endOfMonth, toIsoDate, utcDate, type IsoDate } from './calendar.js';

/**
 * The date-rule engine.
 *
 * Deadlines are never computed by "add one year to last year's date". Every
 * rule is a declarative, configurable, testable definition, and every result
 * records the rule used, the input, the assumptions, and whether a human still
 * has to confirm it.
 *
 * This engine is explicitly NOT the final authority on a legal or tax deadline.
 * Results are proposals that a reviewer confirms before a document is sent.
 */

export const dateBaseSchema = z.enum([
  'YEAR_END',
  'CALENDAR_YEAR_END',
  'DATE_SENT',
  'FILING_DEADLINE',
  'PAYMENT_DEADLINE',
  'CUSTOM_INPUT',
]);
export type DateBase = z.infer<typeof dateBaseSchema>;

const stepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ADD_DAYS'), days: z.number().int() }),
  z.object({ op: z.literal('ADD_BUSINESS_DAYS'), days: z.number().int() }),
  z.object({ op: z.literal('ADD_MONTHS'), months: z.number().int() }),
  z.object({ op: z.literal('ADD_YEARS'), years: z.number().int() }),
  z.object({ op: z.literal('END_OF_MONTH') }),
  z.object({ op: z.literal('FIXED_MONTH_DAY'), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31), yearOffset: z.number().int().default(0) }),
]);
export type DateStep = z.infer<typeof stepSchema>;

const branchSchema = z.object({
  /** Name of a boolean fact about the client, e.g. `isSelfEmployed`. */
  whenFact: z.string().min(1),
  whenValue: z.boolean().default(true),
  steps: z.array(stepSchema).min(1),
  assumption: z.string().min(1),
});

export const dateRuleDefinitionSchema = z.object({
  base: dateBaseSchema,
  /** Applied when no branch matches. */
  steps: z.array(stepSchema).default([]),
  branches: z.array(branchSchema).default([]),
  /** Facts that must be known before this rule may produce a result. */
  requiredFacts: z.array(z.string()).default([]),
  assumption: z.string().optional(),
  /** Weekend/holiday relief is a legal judgement; off unless explicitly set. */
  rollToBusinessDay: z.boolean().default(false),
  requiresConfirmation: z.boolean().default(true),
});

export type DateRuleDefinition = z.infer<typeof dateRuleDefinitionSchema>;

export interface DateRuleInputs {
  /** Fiscal or trust year-end. */
  yearEnd?: Date | null;
  taxYear?: number | null;
  dateSent?: Date | null;
  filingDeadline?: Date | null;
  paymentDeadline?: Date | null;
  customInput?: Date | null;
  /** Named boolean facts, e.g. { isSelfEmployed: true }. */
  facts?: Record<string, boolean | null | undefined>;
}

export interface DateRuleResult {
  ruleCode: string;
  inputDate: Date | null;
  result: Date | null;
  resultIso: IsoDate | null;
  assumptions: string[];
  requiresConfirmation: boolean;
  /**
   * Facts that were needed but not supplied. When non-empty the rule is blocked
   * and approval must not proceed — the engine never guesses.
   */
  missingFacts: string[];
  isBlocked: boolean;
  blockedReason: string | null;
}

function resolveBase(base: DateBase, inputs: DateRuleInputs): Date | null {
  switch (base) {
    case 'YEAR_END':
      return inputs.yearEnd ?? null;
    case 'CALENDAR_YEAR_END':
      return inputs.taxYear ? utcDate(inputs.taxYear, 12, 31) : null;
    case 'DATE_SENT':
      return inputs.dateSent ?? null;
    case 'FILING_DEADLINE':
      return inputs.filingDeadline ?? null;
    case 'PAYMENT_DEADLINE':
      return inputs.paymentDeadline ?? null;
    case 'CUSTOM_INPUT':
      return inputs.customInput ?? null;
    default:
      return null;
  }
}

function applySteps(start: Date, steps: readonly DateStep[]): Date {
  return steps.reduce<Date>((current, step) => {
    switch (step.op) {
      case 'ADD_DAYS':
        return addDays(current, step.days);
      case 'ADD_BUSINESS_DAYS':
        return addBusinessDays(current, step.days);
      case 'ADD_MONTHS':
        return addMonths(current, step.months);
      case 'ADD_YEARS':
        return addMonths(current, step.years * 12);
      case 'END_OF_MONTH':
        return endOfMonth(current);
      case 'FIXED_MONTH_DAY':
        return utcDate(current.getUTCFullYear() + (step.yearOffset ?? 0), step.month, step.day);
      default:
        return current;
    }
  }, start);
}

export function evaluateDateRule(
  ruleCode: string,
  rawDefinition: unknown,
  inputs: DateRuleInputs,
): DateRuleResult {
  const parsed = dateRuleDefinitionSchema.safeParse(rawDefinition);
  if (!parsed.success) {
    return {
      ruleCode,
      inputDate: null,
      result: null,
      resultIso: null,
      assumptions: [],
      requiresConfirmation: true,
      missingFacts: [],
      isBlocked: true,
      blockedReason: `Date rule "${ruleCode}" is not a valid definition.`,
    };
  }

  const definition = parsed.data;
  const facts = inputs.facts ?? {};
  const assumptions: string[] = [];
  if (definition.assumption) assumptions.push(definition.assumption);

  const missingFacts = definition.requiredFacts.filter(
    (fact) => facts[fact] === undefined || facts[fact] === null,
  );

  const inputDate = resolveBase(definition.base, inputs);

  if (!inputDate) {
    return {
      ruleCode,
      inputDate: null,
      result: null,
      resultIso: null,
      assumptions,
      requiresConfirmation: definition.requiresConfirmation,
      missingFacts,
      isBlocked: true,
      blockedReason: `The ${definition.base.toLowerCase().replace(/_/g, ' ')} needed by this rule is not known yet.`,
    };
  }

  if (missingFacts.length > 0) {
    return {
      ruleCode,
      inputDate,
      result: null,
      resultIso: null,
      assumptions,
      requiresConfirmation: definition.requiresConfirmation,
      missingFacts,
      isBlocked: true,
      blockedReason: `This deadline depends on information that has not been confirmed: ${missingFacts.join(', ')}.`,
    };
  }

  const matchedBranch = definition.branches.find((branch) => facts[branch.whenFact] === branch.whenValue);
  const steps = matchedBranch ? matchedBranch.steps : definition.steps;
  if (matchedBranch) assumptions.push(matchedBranch.assumption);

  let result = applySteps(inputDate, steps);

  if (definition.rollToBusinessDay) {
    const rolled = addBusinessDays(addDays(result, -1), 1);
    if (toIsoDate(rolled) !== toIsoDate(result)) {
      assumptions.push('Rolled forward to the next business day.');
      result = rolled;
    }
  }

  return {
    ruleCode,
    inputDate,
    result,
    resultIso: toIsoDate(result),
    assumptions,
    requiresConfirmation: definition.requiresConfirmation,
    missingFacts: [],
    isBlocked: false,
    blockedReason: null,
  };
}
