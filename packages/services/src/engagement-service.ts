import { isUniqueConstraintError, type PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import {
  PreconditionError,
  ValidationError,
  type DocumentType,
  type EngagementType,
} from '@element/shared';

/**
 * Starting an engagement by hand.
 *
 * Engagements otherwise only exist because the seed made them, which leaves a
 * firm with no supported way to begin real work until the Karbon connection is
 * verified against a live tenant.
 *
 * The rules here are the ones that stop an engagement being created in a state
 * it can never leave: there must be an approved template to generate from, a
 * corporate or trust engagement needs its year-end, and one engagement exists
 * per client, type and year — a constraint the database also enforces, so the
 * job here is to explain it rather than to guard it.
 */

export interface EngagementServiceDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
}

export interface CreateEngagementInput {
  /** An existing client, or `newClientName` to create one. */
  clientId?: string | null;
  newClientName?: string | null;
  engagementType: EngagementType;
  taxYear: number;
  /** Required for T2 and T3. Ignored for T1, which is always calendar-year. */
  yearEnd?: string | null;
  /** Karbon's own work item key, linked if it is already known here. */
  karbonWorkItemKey?: string | null;
  assignedPreparerId?: string | null;
  assignedReviewerId?: string | null;
  actorId: string;
  isTestMode: boolean;
}

export interface CreateEngagementResult {
  engagementId: string;
  clientId: string;
  clientCreated: boolean;
  /** Set when the prior year was found and linked. */
  priorYearEngagementId: string | null;
  karbonWorkItemLinked: boolean;
  notes: string[];
}

const DOCUMENT_TYPE_BY_ENGAGEMENT: Record<EngagementType, DocumentType> = {
  T1_JOINT: 'T1_JOINT_ENGAGEMENT_LETTER',
  T1_SINGLE: 'T1_SINGLE_ENGAGEMENT_LETTER',
  T2: 'T2_ENGAGEMENT_LETTER',
  T3: 'T3_ENGAGEMENT_LETTER',
};

/** Year-end is a fiscal or trust period end; a T1 is always the calendar year. */
const NEEDS_YEAR_END: readonly EngagementType[] = ['T2', 'T3'];

const EARLIEST_TAX_YEAR = 2000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class EngagementService {
  constructor(private readonly deps: EngagementServiceDeps) {}

  async create(input: CreateEngagementInput): Promise<CreateEngagementResult> {
    const notes: string[] = [];

    const taxYear = Number(input.taxYear);
    const latestTaxYear = new Date().getUTCFullYear() + 2;
    if (!Number.isInteger(taxYear) || taxYear < EARLIEST_TAX_YEAR || taxYear > latestTaxYear) {
      throw new ValidationError(`The tax year must be between ${EARLIEST_TAX_YEAR} and ${latestTaxYear}.`);
    }

    const yearEnd = this.resolveYearEnd(input.engagementType, input.yearEnd ?? null, notes);

    // Refuse an engagement that could never produce a document. This is not a
    // permanent restriction: it lifts by itself once a template is approved and
    // activated for the type.
    const documentType = DOCUMENT_TYPE_BY_ENGAGEMENT[input.engagementType];
    const template = await this.deps.prisma.documentTemplate.findUnique({
      where: { documentType },
      include: { versions: { where: { status: 'ACTIVE' }, take: 1, select: { id: true } } },
    });

    if (!template?.versions.length) {
      throw new PreconditionError(
        `No approved template is active for ${input.engagementType.replace(/_/g, ' ')}, so an engagement of this type could not be generated. An administrator must publish one first.`,
      );
    }

    const { clientId, clientCreated } = await this.resolveClient(input);

    const priorYear = await this.deps.prisma.engagement.findUnique({
      where: {
        clientId_engagementType_taxYear: {
          clientId,
          engagementType: input.engagementType,
          taxYear: taxYear - 1,
        },
      },
      select: { id: true },
    });

    if (priorYear) notes.push(`Linked to the ${taxYear - 1} engagement for this client.`);

    const karbonWorkItem = input.karbonWorkItemKey
      ? await this.deps.prisma.karbonWorkItem.findUnique({
          where: { karbonKey: input.karbonWorkItemKey.trim() },
          select: { id: true },
        })
      : null;

    if (input.karbonWorkItemKey && !karbonWorkItem) {
      // Recorded, not invented: an unknown key is left unlinked rather than
      // creating a work item this application has never seen in Karbon.
      notes.push(
        `Karbon work item ${input.karbonWorkItemKey.trim()} is not known here yet, so nothing was linked. It will link itself once Karbon is synchronised.`,
      );
    }

    let engagement;
    try {
      engagement = await this.deps.prisma.engagement.create({
        data: {
          clientId,
          engagementType: input.engagementType,
          taxYear,
          yearEnd,
          status: 'NOT_STARTED',
          templateVersionId: template.versions[0]?.id ?? null,
          priorYearEngagementId: priorYear?.id ?? null,
          karbonWorkItemId: karbonWorkItem?.id ?? null,
          assignedPreparerId: input.assignedPreparerId ?? input.actorId,
          assignedReviewerId: input.assignedReviewerId ?? null,
          isTestMode: input.isTestMode,
          initiatedBy: input.actorId,
          initiationSource: 'MANUAL',
        },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await this.deps.prisma.engagement.findUnique({
          where: {
            clientId_engagementType_taxYear: { clientId, engagementType: input.engagementType, taxYear },
          },
          select: { id: true },
        });
        throw new PreconditionError(
          `This client already has a ${taxYear} ${input.engagementType.replace(/_/g, ' ')} engagement.`,
          { existingEngagementId: existing?.id ?? null },
        );
      }
      throw error;
    }

    await this.deps.audit.record({
      eventType: 'ENGAGEMENT_CREATED',
      objectType: 'Engagement',
      objectId: engagement.id,
      engagementId: engagement.id,
      userId: input.actorId,
      afterValue: {
        engagementType: input.engagementType,
        taxYear,
        clientCreated,
        priorYearLinked: Boolean(priorYear),
        karbonWorkItemLinked: Boolean(karbonWorkItem),
        isTestMode: input.isTestMode,
      },
      reason: 'Engagement started by hand.',
    });

    return {
      engagementId: engagement.id,
      clientId,
      clientCreated,
      priorYearEngagementId: priorYear?.id ?? null,
      karbonWorkItemLinked: Boolean(karbonWorkItem),
      notes,
    };
  }

  private resolveYearEnd(
    engagementType: EngagementType,
    raw: string | null,
    notes: string[],
  ): Date | null {
    const value = raw?.trim() ?? '';

    if (!NEEDS_YEAR_END.includes(engagementType)) {
      if (value) notes.push('A T1 engagement is always calendar-year, so the year-end was not recorded.');
      return null;
    }

    if (!value) {
      throw new ValidationError(
        `A ${engagementType} engagement needs its year-end: the filing and balance-due dates are calculated from it.`,
      );
    }

    if (!ISO_DATE.test(value)) throw new ValidationError('The year-end must be a date in YYYY-MM-DD form.');

    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new ValidationError('That year-end is not a real date.');
    }

    return parsed;
  }

  /**
   * Picks the existing client or creates one.
   *
   * A new client whose name already exists is refused rather than created: two
   * clients with the same legal name are almost always one client entered
   * twice, and the engagements would then be split across both.
   */
  private async resolveClient(
    input: CreateEngagementInput,
  ): Promise<{ clientId: string; clientCreated: boolean }> {
    const newName = input.newClientName?.trim() ?? '';

    if (input.clientId && newName) {
      throw new ValidationError('Choose an existing client or name a new one, not both.');
    }

    if (input.clientId) {
      const client = await this.deps.prisma.client.findUnique({
        where: { id: input.clientId },
        select: { id: true },
      });
      if (!client) throw new ValidationError('That client no longer exists.');
      return { clientId: client.id, clientCreated: false };
    }

    if (!newName) throw new ValidationError('Choose an existing client or name a new one.');

    const duplicate = await this.deps.prisma.client.findFirst({
      where: { legalName: { equals: newName, mode: 'insensitive' } },
      select: { id: true, legalName: true },
    });

    if (duplicate) {
      throw new PreconditionError(
        `A client named "${duplicate.legalName}" already exists. Select it rather than creating a second record.`,
        { existingClientId: duplicate.id },
      );
    }

    const created = await this.deps.prisma.client.create({
      data: { legalName: newName },
      select: { id: true },
    });

    return { clientId: created.id, clientCreated: true };
  }
}
