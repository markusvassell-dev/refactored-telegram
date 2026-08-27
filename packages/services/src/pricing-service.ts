import { Prisma, type PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { resolveUserActor } from './system-actor.js';
import { calculateFee, resolveRule, type CandidateRule, type FeeCalculationResult, type PriceRule } from '@element/pricing';
import {
  PermissionError,
  ValidationError,
  assertSeparationOfDuties,
  can,
  money,
  type FeeKind,
  type Principal,
  type ValueSource,
} from '@element/shared';

/**
 * Pricing service.
 *
 * Applies the resolved price rule, persists the full calculation so a reviewer
 * can see exactly how a number was reached, and records the approval level the
 * result demands.
 */

export interface CalculateEngagementFeesInput {
  engagementId: string;
  feeKinds: readonly FeeKind[];
  /** Prior-year fees, keyed by fee kind, with the source they came from. */
  previousFees: Partial<Record<FeeKind, { amount: string | null; source: ValueSource; evidence?: string | null }>>;
  /** A second prior-year fee found elsewhere, which raises a conflict warning. */
  conflictingPreviousFees?: Partial<Record<FeeKind, string>>;
  compilation?: { priorYearSelected: boolean | null; currentSelected: boolean | null };
  highIncreaseThresholdPercent: number;
  actorId: string;
  /** Overrides the resolved rule for this run only. */
  manualRule?: PriceRule;
}

export class PricingService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditLogger,
  ) {}

  private async loadRules(engagementId: string): Promise<{
    rules: CandidateRule[];
    context: {
      engagementType: string;
      clientId: string;
      clientGroup: string | null;
      partnerUserId: string | null;
    };
  }> {
    const engagement = await this.prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId },
      select: {
        engagementType: true,
        clientId: true,
        client: { select: { clientGroup: true, partnerUserId: true } },
      },
    });

    const rows = await this.prisma.feeRule.findMany({ where: { isActive: true } });

    const rules: CandidateRule[] = rows.map((row) => ({
      id: row.id,
      level: row.level,
      engagementType: row.engagementType,
      feeKind: row.feeKind,
      clientId: row.clientId,
      clientGroup: row.clientGroup,
      partnerUserId: row.partnerUserId,
      isActive: row.isActive,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      method: row.method,
      percentage: row.percentage ? row.percentage.toString() : null,
      fixedAmount: row.fixedAmount ? row.fixedAmount.toString() : null,
      exactTarget: row.exactTarget ? row.exactTarget.toString() : null,
      skipRounding: row.skipRounding,
      appliesToAncillaryCharges: row.appliesToAncillaryCharges,
    }));

    return {
      rules,
      context: {
        engagementType: engagement.engagementType,
        clientId: engagement.clientId,
        clientGroup: engagement.client.clientGroup,
        partnerUserId: engagement.client.partnerUserId,
      },
    };
  }

  async calculate(input: CalculateEngagementFeesInput): Promise<Record<string, FeeCalculationResult>> {
    const { rules, context } = await this.loadRules(input.engagementId);
    const results: Record<string, FeeCalculationResult> = {};

    for (const feeKind of input.feeKinds) {
      const resolved =
        input.manualRule ??
        resolveRule(rules, {
          engagementType: context.engagementType as never,
          feeKind,
          clientId: context.clientId,
          clientGroup: context.clientGroup,
          partnerUserId: context.partnerUserId,
        });

      if (!resolved) {
        // No rule means the reviewer must choose a method. It never means
        // "no increase" — silently repeating last year's fee is a decision,
        // and decisions belong to people.
        results[feeKind] = {
          feeKind,
          method: 'NO_INCREASE',
          previousFee: null,
          previousFeeSource: null,
          percentage: null,
          fixedAmount: null,
          exactTarget: null,
          unroundedFee: null,
          roundedFee: null,
          increaseAmount: null,
          effectivePercentage: null,
          roundingApplied: true,
          isManualOverride: false,
          overrideReason: null,
          requiredApproval: 'NONE',
          warnings: [],
          isBlocked: true,
          blockedReason: 'No pricing rule applies. Choose a price method before generating.',
          isPreTax: true,
        };
        await this.persist(input.engagementId, results[feeKind] as FeeCalculationResult, null, input.actorId);
        continue;
      }

      const previous = input.previousFees[feeKind];
      const result = calculateFee({
        feeKind,
        rule: resolved,
        previousFee: previous?.amount ?? null,
        previousFeeSource: previous?.source ?? null,
        conflictingPreviousFee: input.conflictingPreviousFees?.[feeKind] ?? null,
        highIncreaseThresholdPercent: input.highIncreaseThresholdPercent,
        compilation: input.compilation,
      });

      results[feeKind] = result;
      await this.persist(
        input.engagementId,
        result,
        'id' in resolved ? (resolved as CandidateRule).id : null,
        input.actorId,
        previous?.evidence ?? null,
      );
    }

    return results;
  }

  private async persist(
    engagementId: string,
    result: FeeCalculationResult,
    feeRuleId: string | null,
    actorId: string,
    previousFeeEvidence: string | null = null,
  ): Promise<void> {
    const data = {
      engagementId,
      feeKind: result.feeKind,
      feeRuleId,
      previousFee: result.previousFee ? new Prisma.Decimal(result.previousFee.toFixed(2)) : null,
      previousFeeSource: result.previousFeeSource,
      previousFeeEvidence,
      method: result.method,
      percentage: result.percentage ? new Prisma.Decimal(result.percentage.toFixed(4)) : null,
      fixedAmount: result.fixedAmount ? new Prisma.Decimal(result.fixedAmount.toFixed(2)) : null,
      exactTarget: result.exactTarget ? new Prisma.Decimal(result.exactTarget.toFixed(2)) : null,
      unroundedFee: result.unroundedFee ? new Prisma.Decimal(result.unroundedFee.toFixed(2)) : null,
      roundedFee: result.roundedFee ? new Prisma.Decimal(result.roundedFee.toFixed(2)) : null,
      increaseAmount: result.increaseAmount ? new Prisma.Decimal(result.increaseAmount.toFixed(2)) : null,
      effectivePercentage: result.effectivePercentage ? new Prisma.Decimal(result.effectivePercentage.toFixed(4)) : null,
      roundingApplied: result.roundingApplied,
      isPreTax: result.isPreTax,
      taxNote: 'Fees are quoted before GST. Applicable taxes are shown separately.',
      isManualOverride: result.isManualOverride,
      overrideReason: result.overrideReason,
      requiresApprovalType:
        result.requiredApproval === 'FEE_DECREASE'
          ? ('FEE_DECREASE' as const)
          : result.requiredApproval === 'FEE_HIGH_INCREASE'
            ? ('FEE_HIGH_INCREASE' as const)
            : null,
      warnings: result.warnings as unknown as Prisma.InputJsonValue,
      isBlocked: result.isBlocked,
      blockedReason: result.blockedReason,
      // A foreign key to `user.id`, so it takes a person or nothing.
      // Preparation runs in the worker with `actorId` of `system`, which is a
      // real answer for the audit trail and not a user row — writing it here
      // violated the constraint, and a fee that cannot be persisted takes the
      // whole preparation with it. `resolveUserActor` is where that distinction
      // is explained.
      calculatedByUserId: await resolveUserActor(this.prisma, actorId),
    };

    await this.prisma.feeCalculation.upsert({
      where: { engagementId_feeKind: { engagementId, feeKind: result.feeKind } },
      create: data,
      update: { ...data, approvedByUserId: null, approvedAt: null },
    });

    await this.audit.record({
      eventType: 'FEE_CALCULATED',
      objectType: 'FeeCalculation',
      objectId: `${engagementId}:${result.feeKind}`,
      engagementId,
      userId: actorId,
      afterValue: {
        feeKind: result.feeKind,
        method: result.method,
        previousFee: result.previousFee?.toFixed(2) ?? null,
        unroundedFee: result.unroundedFee?.toFixed(2) ?? null,
        roundedFee: result.roundedFee?.toFixed(2) ?? null,
        requiredApproval: result.requiredApproval,
        blocked: result.isBlocked,
      },
    });
  }

  /**
   * Applies a manual override. A decrease or a large increase still needs
   * elevated approval afterwards — overriding is not approving.
   */
  async override(input: {
    engagementId: string;
    feeKind: FeeKind;
    amount: string;
    reason: string;
    actor: Principal;
    highIncreaseThresholdPercent: number;
  }): Promise<FeeCalculationResult> {
    if (!can(input.actor, 'pricing:prepare')) {
      throw new PermissionError('Your role does not permit changing fees.');
    }
    if (!input.reason.trim()) {
      throw new ValidationError('A manual fee override requires a written reason.');
    }

    const existing = await this.prisma.feeCalculation.findUnique({
      where: { engagementId_feeKind: { engagementId: input.engagementId, feeKind: input.feeKind } },
    });

    const result = calculateFee({
      feeKind: input.feeKind,
      rule: { method: 'EXACT_TARGET', exactTarget: input.amount },
      previousFee: existing?.previousFee ? existing.previousFee.toString() : null,
      previousFeeSource: existing?.previousFeeSource ?? null,
      highIncreaseThresholdPercent: input.highIncreaseThresholdPercent,
      manualOverride: { amount: money(input.amount), reason: input.reason },
    });

    await this.persist(input.engagementId, result, existing?.feeRuleId ?? null, input.actor.id);

    await this.audit.record({
      eventType: 'FEE_OVERRIDDEN',
      objectType: 'FeeCalculation',
      objectId: `${input.engagementId}:${input.feeKind}`,
      engagementId: input.engagementId,
      userId: input.actor.id,
      beforeValue: { roundedFee: existing?.roundedFee?.toString() ?? null },
      afterValue: { roundedFee: result.roundedFee?.toFixed(2) ?? null },
      reason: input.reason,
    });

    return result;
  }

  /** Records elevated approval of a fee decrease or a high increase. */
  async approveFee(input: { engagementId: string; feeKind: FeeKind; approver: Principal }): Promise<void> {
    const calculation = await this.prisma.feeCalculation.findUniqueOrThrow({
      where: { engagementId_feeKind: { engagementId: input.engagementId, feeKind: input.feeKind } },
    });

    if (!calculation.requiresApprovalType) return;

    const permission = calculation.requiresApprovalType === 'FEE_DECREASE' ? 'fee:approve_decrease' : 'fee:approve_high_increase';

    if (!can(input.approver, permission)) {
      throw new PermissionError('Only a partner or final approver can approve this fee change.');
    }

    // A user may not approve a fee they themselves produced.
    //
    // This was conditional on `isManualOverride`, which made the check weakest
    // exactly where it matters most. `calculatedByUserId` is written on every
    // calculation, not only on overrides, so a partner who ran preparation from
    // the web screen and got back a high increase could approve it themselves —
    // while the same partner typing the same figure by hand was refused. The
    // rule-derived increase is the one the threshold exists to put in front of a
    // second person, so it cannot be the one that skips them.
    //
    // Nothing legitimate changes. Preparation normally runs in the worker as
    // the system actor, and `resolveUserActor` stores null for it, so
    // `assertSeparationOfDuties` returns without doing anything — the guard only
    // ever fires when a real person calculated the fee and is now approving it.
    assertSeparationOfDuties({
      approverId: input.approver.id,
      authorId: calculation.calculatedByUserId,
      subject: calculation.isManualOverride ? 'fee override' : 'fee calculation',
    });

    await this.prisma.feeCalculation.update({
      where: { id: calculation.id },
      data: { approvedByUserId: input.approver.id, approvedAt: new Date() },
    });

    await this.audit.record({
      eventType: 'APPROVAL_GRANTED',
      objectType: 'FeeCalculation',
      objectId: calculation.id,
      engagementId: input.engagementId,
      userId: input.approver.id,
      afterValue: { feeKind: input.feeKind, approvalType: calculation.requiresApprovalType },
    });
  }

  /** Fee kinds that are blocked or still awaiting a required approval. */
  async outstanding(engagementId: string): Promise<{ blocked: string[]; awaitingApproval: string[] }> {
    const calculations = await this.prisma.feeCalculation.findMany({ where: { engagementId } });
    return {
      blocked: calculations.filter((row) => row.isBlocked).map((row) => row.feeKind),
      awaitingApproval: calculations
        .filter((row) => row.requiresApprovalType !== null && row.approvedAt === null)
        .map((row) => row.feeKind),
    };
  }
}
