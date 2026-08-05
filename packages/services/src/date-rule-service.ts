import type { Prisma, PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { dateRuleDefinitionSchema, type DateRuleDefinition } from '@element/dates';
import { NotFoundError, ValidationError, type EngagementType } from '@element/shared';

/**
 * Editing a date rule.
 *
 * A date rule is the firm's interpretation of a statutory deadline. It is
 * meant to be changed — a partner who disagrees with an assumption should not
 * need a developer — but a change alters what this application will tell every
 * future client, so it carries a written reason and is recorded in full.
 *
 * What it will not do is change a date a reviewer has already confirmed.
 * Confirmed dates are decisions; the new rule applies to what has not been
 * decided yet, and the affected count is reported before the change is saved.
 */

export interface DateRuleDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
}

export interface DateRuleSummary {
  id: string;
  code: string;
  label: string;
  engagementType: EngagementType | null;
  definition: DateRuleDefinition | null;
  /** Set when the stored definition does not parse — it produces no dates. */
  definitionError: string | null;
  requiresConfirmation: boolean;
  isActive: boolean;
  notes: string | null;
  updatedAt: Date;
}

export interface DateRuleImpact {
  /** Unconfirmed dates this rule produced, which the next run will recalculate. */
  pendingRecalculation: number;
  /** Dates a reviewer already confirmed. These are never rewritten. */
  confirmed: number;
}

export interface UpdateDateRuleInput {
  code: string;
  actorId: string;
  reason: string;
  label: string;
  notes: string | null;
  isActive: boolean;
  requiresConfirmation: boolean;
  definition: unknown;
}

export class DateRuleService {
  constructor(private readonly deps: DateRuleDeps) {}

  async list(): Promise<DateRuleSummary[]> {
    const rows = await this.deps.prisma.dateRule.findMany({ orderBy: { code: 'asc' } });
    return rows.map((row) => this.toSummary(row));
  }

  async get(code: string): Promise<DateRuleSummary> {
    const row = await this.deps.prisma.dateRule.findUnique({ where: { code } });
    if (!row) throw new NotFoundError(`Date rule ${code}`);
    return this.toSummary(row);
  }

  /**
   * How much of what has already been calculated this rule still governs.
   *
   * Shown before a change is made, because "this affects 14 engagements" is
   * the difference between an informed edit and a surprise.
   */
  async impactOf(code: string): Promise<DateRuleImpact> {
    const [pendingRecalculation, confirmed] = await Promise.all([
      this.deps.prisma.calculatedDate.count({ where: { ruleCode: code, confirmedAt: null } }),
      this.deps.prisma.calculatedDate.count({ where: { ruleCode: code, confirmedAt: { not: null } } }),
    ]);

    return { pendingRecalculation, confirmed };
  }

  async update(input: UpdateDateRuleInput): Promise<{ code: string; impact: DateRuleImpact }> {
    const reason = input.reason.trim();
    if (reason.length < 10) {
      throw new ValidationError('Give a reason for this change, in a sentence a colleague would understand.');
    }

    const label = input.label.trim();
    if (!label) throw new ValidationError('A date rule needs a label.');

    const existing = await this.deps.prisma.dateRule.findUnique({ where: { code: input.code } });
    if (!existing) throw new NotFoundError(`Date rule ${input.code}`);

    // Validated here regardless of what the form did: the definition arrives
    // as JSON from a browser, and a rule that does not parse produces no dates
    // at all rather than wrong ones.
    const parsed = dateRuleDefinitionSchema.safeParse(input.definition);
    if (!parsed.success) {
      throw new ValidationError('That definition is not valid.', {
        blockers: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'definition'}: ${issue.message}`),
      });
    }

    const definition = parsed.data;

    if (definition.steps.length === 0 && definition.branches.length === 0) {
      throw new ValidationError('A rule needs at least one step, or it would return its own starting date.');
    }

    const impact = await this.impactOf(input.code);

    await this.deps.prisma.dateRule.update({
      where: { code: input.code },
      data: {
        label,
        notes: input.notes?.trim() || null,
        isActive: input.isActive,
        requiresConfirmation: definition.requiresConfirmation && input.requiresConfirmation,
        definition: definition as unknown as Prisma.InputJsonValue,
      },
    });

    await this.deps.audit.record({
      eventType: 'CONFIGURATION_CHANGED',
      objectType: 'DateRule',
      objectId: input.code,
      userId: input.actorId,
      reason,
      // The whole definition, before and after. A deadline interpretation
      // changing is exactly the kind of thing someone will need to reconstruct.
      beforeValue: {
        label: existing.label,
        notes: existing.notes,
        isActive: existing.isActive,
        requiresConfirmation: existing.requiresConfirmation,
        definition: existing.definition,
      },
      afterValue: {
        label,
        notes: input.notes?.trim() || null,
        isActive: input.isActive,
        requiresConfirmation: definition.requiresConfirmation && input.requiresConfirmation,
        definition,
        pendingRecalculation: impact.pendingRecalculation,
        confirmedAndUntouched: impact.confirmed,
      },
    });

    return { code: input.code, impact };
  }

  private toSummary(row: {
    id: string;
    code: string;
    label: string;
    engagementType: EngagementType | null;
    definition: unknown;
    requiresConfirmation: boolean;
    isActive: boolean;
    notes: string | null;
    updatedAt: Date;
  }): DateRuleSummary {
    const parsed = dateRuleDefinitionSchema.safeParse(row.definition);

    return {
      id: row.id,
      code: row.code,
      label: row.label,
      engagementType: row.engagementType,
      definition: parsed.success ? parsed.data : null,
      definitionError: parsed.success
        ? null
        : parsed.error.issues.map((issue) => `${issue.path.join('.') || 'definition'}: ${issue.message}`).join('; '),
      requiresConfirmation: row.requiresConfirmation,
      isActive: row.isActive,
      notes: row.notes,
      updatedAt: row.updatedAt,
    };
  }
}
