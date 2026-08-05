import type { EngagementType, FeeKind } from '@element/shared/domain';
import type { PriceRule } from './engine.js';

/**
 * Pricing-rule precedence.
 *
 * 1. Global default
 * 2. Engagement-type default
 * 3. Partner or client-group rule
 * 4. Client-specific rule
 * 5. One-time manual override
 *
 * The most specific applicable rule wins. Engagement-type defaults with
 * client-specific overrides are the normal model.
 */

export const RULE_LEVELS = ['GLOBAL', 'ENGAGEMENT_TYPE', 'PARTNER_OR_GROUP', 'CLIENT', 'ONE_TIME_OVERRIDE'] as const;
export type FeeRuleLevel = (typeof RULE_LEVELS)[number];

export function levelSpecificity(level: FeeRuleLevel): number {
  return RULE_LEVELS.indexOf(level);
}

export interface CandidateRule extends PriceRule {
  id: string;
  level: FeeRuleLevel;
  engagementType?: EngagementType | null;
  feeKind?: FeeKind | null;
  clientId?: string | null;
  clientGroup?: string | null;
  partnerUserId?: string | null;
  isActive: boolean;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  /**
   * When false (the default) the rule does not automatically increase
   * retainers, hourly rates, additional-work rates or out-of-pocket expenses.
   */
  appliesToAncillaryCharges?: boolean;
}

export interface RuleContext {
  engagementType: EngagementType;
  feeKind: FeeKind;
  clientId: string;
  clientGroup?: string | null;
  partnerUserId?: string | null;
  asOf?: Date;
}

function isApplicable(rule: CandidateRule, context: RuleContext, asOf: Date): boolean {
  if (!rule.isActive) return false;
  if (rule.effectiveFrom.getTime() > asOf.getTime()) return false;
  if (rule.effectiveTo && rule.effectiveTo.getTime() < asOf.getTime()) return false;

  if (rule.feeKind && rule.feeKind !== context.feeKind) return false;
  if (rule.engagementType && rule.engagementType !== context.engagementType) return false;

  switch (rule.level) {
    case 'GLOBAL':
      return true;
    case 'ENGAGEMENT_TYPE':
      return rule.engagementType === context.engagementType;
    case 'PARTNER_OR_GROUP':
      return (
        (Boolean(rule.partnerUserId) && rule.partnerUserId === context.partnerUserId) ||
        (Boolean(rule.clientGroup) && rule.clientGroup === context.clientGroup)
      );
    case 'CLIENT':
      return rule.clientId === context.clientId;
    case 'ONE_TIME_OVERRIDE':
      return rule.clientId === context.clientId;
    default:
      return false;
  }
}

/**
 * Returns the winning rule, or null when nothing applies. A null result means
 * the reviewer must choose a method explicitly — it never means "no increase".
 */
export function resolveRule(rules: readonly CandidateRule[], context: RuleContext): CandidateRule | null {
  const asOf = context.asOf ?? new Date();
  const applicable = rules.filter((rule) => isApplicable(rule, context, asOf));
  if (applicable.length === 0) return null;

  return applicable.reduce((best, candidate) => {
    const bestScore = levelSpecificity(best.level);
    const candidateScore = levelSpecificity(candidate.level);
    if (candidateScore !== bestScore) return candidateScore > bestScore ? candidate : best;

    // Same level: the rule that came into effect most recently wins.
    if (candidate.effectiveFrom.getTime() !== best.effectiveFrom.getTime()) {
      return candidate.effectiveFrom.getTime() > best.effectiveFrom.getTime() ? candidate : best;
    }
    // Fully deterministic tie-break so the same inputs always give the same rule.
    return candidate.id > best.id ? candidate : best;
  });
}

/** Charges that are never auto-increased unless a rule opts in explicitly. */
export const ANCILLARY_CHARGE_CODES = [
  'retainer',
  'hourly_rate',
  'additional_work_rate',
  'out_of_pocket',
  'special_charge',
] as const;

export type AncillaryChargeCode = (typeof ANCILLARY_CHARGE_CODES)[number];

export function shouldAutoIncreaseAncillary(rule: CandidateRule | null): boolean {
  return rule?.appliesToAncillaryCharges === true;
}
