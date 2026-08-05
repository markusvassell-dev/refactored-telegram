import type { FeeRuleLevel, Prisma, PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import {
  NotFoundError,
  ValidationError,
  money,
  type EngagementType,
  type FeeKind,
  type FeeMethod,
} from '@element/shared';

/**
 * Editing a pricing rule.
 *
 * Fee resolution across its five levels is complete and well covered, but the
 * rules themselves could only be changed in the database — which made the one
 * number a partner is most likely to revisit each year, the annual increase,
 * the one they could not touch.
 *
 * A rule that can never apply is refused rather than saved: a client-level rule
 * with no client, a percentage rule with no percentage. And a change never
 * revisits a fee somebody already approved — approval is a decision about a
 * specific number, and this recalculates nothing on its own.
 */

export interface FeeRuleDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
}

export interface FeeRuleSummary {
  id: string;
  level: FeeRuleLevel;
  engagementType: EngagementType | null;
  feeKind: FeeKind | null;
  clientId: string | null;
  clientName: string | null;
  clientGroup: string | null;
  partnerUserId: string | null;
  partnerName: string | null;
  method: FeeMethod;
  percentage: string | null;
  fixedAmount: string | null;
  exactTarget: string | null;
  skipRounding: boolean;
  appliesToAncillaryCharges: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isActive: boolean;
  description: string | null;
}

export interface FeeRuleImpact {
  /** Fees calculated under this rule that no one has approved yet. */
  pendingRecalculation: number;
  /** Fees approved under it. A decision about a number; never revisited. */
  approved: number;
}

export interface SaveFeeRuleInput {
  /** Omitted to create a rule. */
  id?: string | null;
  actorId: string;
  reason: string;
  level: FeeRuleLevel;
  engagementType?: EngagementType | null;
  feeKind?: FeeKind | null;
  clientId?: string | null;
  clientGroup?: string | null;
  partnerUserId?: string | null;
  method: FeeMethod;
  percentage?: string | null;
  fixedAmount?: string | null;
  exactTarget?: string | null;
  skipRounding: boolean;
  appliesToAncillaryCharges: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  isActive: boolean;
  description?: string | null;
}

/** What each level must be scoped by, or it can never match anything. */
const REQUIRED_SCOPE: Record<FeeRuleLevel, string | null> = {
  GLOBAL: null,
  ENGAGEMENT_TYPE: 'engagementType',
  PARTNER_OR_GROUP: 'partnerUserId or clientGroup',
  CLIENT: 'clientId',
  ONE_TIME_OVERRIDE: 'clientId',
};

/** The single value each method needs, or it produces nothing. */
const REQUIRED_VALUE: Record<FeeMethod, 'percentage' | 'fixedAmount' | 'exactTarget' | null> = {
  NO_INCREASE: null,
  PERCENTAGE: 'percentage',
  FIXED_AMOUNT: 'fixedAmount',
  EXACT_TARGET: 'exactTarget',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class FeeRuleService {
  constructor(private readonly deps: FeeRuleDeps) {}

  async list(): Promise<FeeRuleSummary[]> {
    const rows = await this.deps.prisma.feeRule.findMany({
      orderBy: [{ level: 'asc' }, { createdAt: 'desc' }],
      include: { client: { select: { legalName: true } } },
    });

    const partnerIds = [...new Set(rows.map((row) => row.partnerUserId).filter(Boolean))] as string[];
    const partners = await this.deps.prisma.user.findMany({
      where: { id: { in: partnerIds } },
      select: { id: true, displayName: true },
    });
    const partnerNames = new Map(partners.map((partner) => [partner.id, partner.displayName]));

    return rows.map((row) => ({
      id: row.id,
      level: row.level,
      engagementType: row.engagementType,
      feeKind: row.feeKind,
      clientId: row.clientId,
      clientName: row.client?.legalName ?? null,
      clientGroup: row.clientGroup,
      partnerUserId: row.partnerUserId,
      partnerName: row.partnerUserId ? (partnerNames.get(row.partnerUserId) ?? null) : null,
      method: row.method,
      percentage: row.percentage?.toString() ?? null,
      fixedAmount: row.fixedAmount?.toString() ?? null,
      exactTarget: row.exactTarget?.toString() ?? null,
      skipRounding: row.skipRounding,
      appliesToAncillaryCharges: row.appliesToAncillaryCharges,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      isActive: row.isActive,
      description: row.description,
    }));
  }

  async get(id: string): Promise<FeeRuleSummary> {
    const all = await this.list();
    const rule = all.find((candidate) => candidate.id === id);
    if (!rule) throw new NotFoundError(`Pricing rule ${id}`);
    return rule;
  }

  /**
   * What this rule already governs.
   *
   * Approved fees are counted separately because they are never revisited: an
   * approval is a decision about a specific number, not about the rule.
   */
  async impactOf(id: string): Promise<FeeRuleImpact> {
    const [pendingRecalculation, approved] = await Promise.all([
      this.deps.prisma.feeCalculation.count({ where: { feeRuleId: id, approvedAt: null } }),
      this.deps.prisma.feeCalculation.count({ where: { feeRuleId: id, approvedAt: { not: null } } }),
    ]);

    return { pendingRecalculation, approved };
  }

  async save(input: SaveFeeRuleInput): Promise<{ id: string; created: boolean; impact: FeeRuleImpact }> {
    const reason = input.reason.trim();
    if (reason.length < 10) {
      throw new ValidationError('Give a reason for this change, in a sentence a colleague would understand.');
    }

    const data = this.validate(input);

    const existing = input.id
      ? await this.deps.prisma.feeRule.findUnique({ where: { id: input.id } })
      : null;

    if (input.id && !existing) throw new NotFoundError(`Pricing rule ${input.id}`);

    const impact = existing ? await this.impactOf(existing.id) : { pendingRecalculation: 0, approved: 0 };

    const saved = existing
      ? await this.deps.prisma.feeRule.update({ where: { id: existing.id }, data, select: { id: true } })
      : await this.deps.prisma.feeRule.create({
          data: { ...data, createdBy: input.actorId },
          select: { id: true },
        });

    await this.deps.audit.record({
      eventType: 'CONFIGURATION_CHANGED',
      objectType: 'FeeRule',
      objectId: saved.id,
      userId: input.actorId,
      reason,
      beforeValue: existing
        ? {
            level: existing.level,
            engagementType: existing.engagementType,
            feeKind: existing.feeKind,
            method: existing.method,
            percentage: existing.percentage?.toString() ?? null,
            fixedAmount: existing.fixedAmount?.toString() ?? null,
            exactTarget: existing.exactTarget?.toString() ?? null,
            skipRounding: existing.skipRounding,
            appliesToAncillaryCharges: existing.appliesToAncillaryCharges,
            isActive: existing.isActive,
          }
        : undefined,
      afterValue: {
        level: data.level,
        engagementType: data.engagementType,
        feeKind: data.feeKind,
        method: data.method,
        percentage: data.percentage,
        fixedAmount: data.fixedAmount,
        exactTarget: data.exactTarget,
        skipRounding: data.skipRounding,
        appliesToAncillaryCharges: data.appliesToAncillaryCharges,
        isActive: data.isActive,
        created: !existing,
        pendingRecalculation: impact.pendingRecalculation,
        approvedAndUntouched: impact.approved,
      },
    });

    return { id: saved.id, created: !existing, impact };
  }

  /**
   * Refuses a rule that could never do anything.
   *
   * Both failures here are silent in production: a rule scoped to nothing never
   * matches, and a method with no value produces no fee. Neither announces
   * itself — the engagement simply stays blocked.
   */
  private validate(input: SaveFeeRuleInput): Prisma.FeeRuleUncheckedCreateInput {
    const scope = REQUIRED_SCOPE[input.level];

    if (input.level === 'ENGAGEMENT_TYPE' && !input.engagementType) {
      throw new ValidationError('An engagement-type rule needs an engagement type, or it can never apply.');
    }
    if (input.level === 'PARTNER_OR_GROUP' && !input.partnerUserId && !input.clientGroup) {
      throw new ValidationError('A partner or group rule needs a partner or a client group, or it can never apply.');
    }
    if ((input.level === 'CLIENT' || input.level === 'ONE_TIME_OVERRIDE') && !input.clientId) {
      throw new ValidationError(`A ${input.level.replace(/_/g, ' ').toLowerCase()} rule needs a client (${scope}).`);
    }

    const wanted = REQUIRED_VALUE[input.method];
    const raw = wanted ? (input[wanted] ?? '') : '';

    let amount: string | null = null;
    if (wanted) {
      if (!raw.toString().trim()) {
        throw new ValidationError(`A ${input.method.replace(/_/g, ' ').toLowerCase()} rule needs a ${wanted}.`);
      }
      try {
        const parsed = money(raw.toString());
        if (parsed.isNegative()) throw new ValidationError(`The ${wanted} cannot be negative.`);
        amount = parsed.toFixed(wanted === 'percentage' ? 4 : 2);
      } catch (error) {
        if (error instanceof ValidationError) throw error;
        throw new ValidationError(`The ${wanted} must be a number.`);
      }
    }

    const effectiveFrom = this.parseDate(input.effectiveFrom, 'effective-from date') ?? new Date();
    const effectiveTo = this.parseDate(input.effectiveTo, 'effective-to date');

    if (effectiveTo && effectiveTo.getTime() < effectiveFrom.getTime()) {
      throw new ValidationError('A rule cannot stop applying before it starts.');
    }

    return {
      level: input.level,
      // Scope fields are cleared for levels that do not use them, so a rule
      // narrowed by mistake cannot keep matching on a leftover value.
      engagementType: input.level === 'GLOBAL' ? null : (input.engagementType ?? null),
      feeKind: input.feeKind ?? null,
      clientId: input.level === 'CLIENT' || input.level === 'ONE_TIME_OVERRIDE' ? (input.clientId ?? null) : null,
      clientGroup: input.level === 'PARTNER_OR_GROUP' ? (input.clientGroup?.trim() || null) : null,
      partnerUserId: input.level === 'PARTNER_OR_GROUP' ? (input.partnerUserId ?? null) : null,
      method: input.method,
      percentage: input.method === 'PERCENTAGE' ? amount : null,
      fixedAmount: input.method === 'FIXED_AMOUNT' ? amount : null,
      exactTarget: input.method === 'EXACT_TARGET' ? amount : null,
      skipRounding: input.skipRounding,
      appliesToAncillaryCharges: input.appliesToAncillaryCharges,
      effectiveFrom,
      effectiveTo,
      isActive: input.isActive,
      description: input.description?.trim() || null,
    };
  }

  private parseDate(raw: string | null | undefined, what: string): Date | null {
    const value = raw?.trim() ?? '';
    if (!value) return null;
    if (!ISO_DATE.test(value)) throw new ValidationError(`The ${what} must be in YYYY-MM-DD form.`);

    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new ValidationError(`That ${what} is not a real date.`);
    }
    return parsed;
  }
}
