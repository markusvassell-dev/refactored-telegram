import { isUniqueConstraintError, type PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { deriveTaxYear, rollYearEndForward } from '@element/integrations';
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
  /**
   * How this engagement came to exist. `MANUAL` was the only value for as long
   * as the form was the only way in; a rollover is not a person typing, and the
   * audit trail should not say it was.
   */
  initiationSource?: string;
  /** Carried through so one rollover reads as one chain of jobs in the log. */
  correlationId?: string | null;
}

export interface RollForwardInput {
  /** Karbon's own work item key. It must already be synchronised here. */
  karbonWorkItemKey: string;
  /** From the matched status trigger, or the work item's own type. */
  engagementType: EngagementType;
  /** `system` when this runs unattended. Recorded, never assigned as preparer. */
  actorId: string;
  isTestMode: boolean;
  initiationSource: string;
  correlationId?: string | null;
}

export interface RollForwardResult {
  engagementId: string;
  /** False when the engagement already existed, which is a success. */
  created: boolean;
  taxYear: number;
  priorYearEngagementId: string | null;
  notes: string[];
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
          // Absent means "assign whoever started it"; an explicit null means
          // "nobody", and the two are not the same. A rollover started by the
          // worker passes null deliberately: `actorId` is then the string
          // `system`, which is fine for the audit trail and is not a user row —
          // assigning it as preparer would violate the foreign key.
          assignedPreparerId:
            input.assignedPreparerId === undefined ? input.actorId : input.assignedPreparerId,
          assignedReviewerId: input.assignedReviewerId ?? null,
          isTestMode: input.isTestMode,
          initiatedBy: input.actorId,
          initiationSource: input.initiationSource ?? 'MANUAL',
          correlationId: input.correlationId ?? null,
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
        initiationSource: input.initiationSource ?? 'MANUAL',
      },
      reason:
        input.initiationSource && input.initiationSource !== 'MANUAL'
          ? `Engagement started automatically (${input.initiationSource}).`
          : 'Engagement started by hand.',
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

  /**
   * Starts next year's engagement from last year's, unattended.
   *
   * This is the link the annual rollover was missing. Everything after it
   * already existed — the prior-year letter is found in Karbon and verified by
   * its text, its values are extracted with evidence, preparation carries them
   * forward as suggestions and prices the fee from last year's — but all of it
   * begins from an engagement, and nothing created one. A Karbon status trigger
   * naming a work item this application had never seen simply reported that no
   * engagement was linked, and stopped.
   *
   * It **delegates to `create`** rather than writing its own insert. The
   * active-template gate, the client resolution, the automatic prior-year link
   * and the unique constraint on client-type-year are the rules that stop an
   * engagement existing in a state it can never leave, and there must be one
   * copy of them. What this adds is only where the inputs come from.
   *
   * Nothing here generates a document. Preparation proposes and a person
   * confirms; that boundary is not moved by the engagement having started
   * itself.
   */
  async rollForward(input: RollForwardInput): Promise<RollForwardResult> {
    const workItem = await this.deps.prisma.karbonWorkItem.findUnique({
      where: { karbonKey: input.karbonWorkItemKey },
      include: { client: { select: { id: true, legalName: true } } },
    });

    if (!workItem) {
      throw new PreconditionError(
        `Karbon work item ${input.karbonWorkItemKey} is not known here, so there is nothing to roll forward. Synchronise it first.`,
      );
    }

    if (!workItem.client) {
      // Named rather than guessed. A work item with no client is either a
      // client this application has not imported or a Karbon record with no
      // client on it, and those need different answers from a person.
      throw new PreconditionError(
        `Karbon work item ${input.karbonWorkItemKey} is not linked to a client here, so there is no history to roll forward. Import the client from Karbon first.`,
      );
    }

    const engagementType = input.engagementType;

    // Already rolled forward.
    //
    // One work item means one engagement, and that is the check that has to
    // come first — before any year is worked out. Deciding the year and *then*
    // looking for a duplicate gets it exactly wrong on the second run: the
    // engagement this job created a moment ago is now the newest one, so the
    // fallback reads it as "last year" and rolls forward again, creating a
    // fresh engagement every time the job is retried.
    //
    // This runs from a queue with at-least-once delivery and from a poll that
    // sees the same work item until its status changes, so converging on the
    // existing engagement is the correct outcome rather than a tolerated
    // failure.
    const alreadyRolled = await this.deps.prisma.engagement.findFirst({
      where: { karbonWorkItem: { karbonKey: input.karbonWorkItemKey } },
      select: { id: true, taxYear: true, priorYearEngagementId: true },
    });

    if (alreadyRolled) {
      return {
        engagementId: alreadyRolled.id,
        created: false,
        taxYear: alreadyRolled.taxYear,
        priorYearEngagementId: alreadyRolled.priorYearEngagementId,
        notes: [`This work item already has a ${alreadyRolled.taxYear} engagement.`],
      };
    }

    // The most recent engagement of this type for this client, whatever year it
    // was. Reading the newest rather than assuming last year matters for a
    // client the firm did not act for in the intervening year: their 2024
    // letter is still the right thing to carry forward into 2026.
    const previous = await this.deps.prisma.engagement.findFirst({
      where: { clientId: workItem.client.id, engagementType },
      orderBy: { taxYear: 'desc' },
      select: { id: true, taxYear: true, yearEnd: true, assignedPreparerId: true, assignedReviewerId: true },
    });

    // Karbon first where it names a year outright, then the deterministic
    // answer. `deriveTaxYear` returns null unless exactly one plausible year
    // appears, because a wrong tax year does not fail — it produces a
    // correct-looking letter for the wrong period.
    const taxYear =
      deriveTaxYear(workItem) ??
      (previous ? previous.taxYear + 1 : new Date().getUTCFullYear());

    // Karbon holds no year-end field at all, so this is the roll-forward or
    // nothing.
    const yearEnd =
      previous?.yearEnd && NEEDS_YEAR_END.includes(engagementType)
        ? rollYearEndForward(previous.yearEnd).toISOString().slice(0, 10)
        : null;

    // A corporate or trust engagement with no year-end cannot be started
    // automatically, and this is the one place the rollover has to refuse.
    //
    // The year-end is only settable when the engagement is created — there is
    // no editor for it afterwards — so creating one without would leave an
    // engagement in exactly the state `create`'s rules exist to prevent: unable
    // to compute a filing or balance-due date, and with no way to fix it.
    //
    // And there is nothing to derive it from. Karbon publishes no year-end
    // field, and a due date is a deadline rather than a period end. Guessing
    // one would not fail; it would produce a letter carrying a plausible,
    // wrong, legal deadline, which is worse than not starting.
    //
    // So it goes back to a person, who is asked for the year-end on the form.
    // A T1 is unaffected: it is always calendar-year and needs none.
    if (!yearEnd && NEEDS_YEAR_END.includes(engagementType)) {
      throw new PreconditionError(
        `${workItem.client.legalName} has no earlier ${engagementType.replace(/_/g, ' ')} engagement here, so there is no year-end to carry forward — and Karbon does not publish one. Start this engagement by hand, where the year-end is asked for; every year after it will roll forward on its own.`,
      );
    }

    // The same client, type and year reached by a different route — started by
    // hand, or by a work item this one supersedes. The unique constraint would
    // refuse the insert anyway; returning it says what happened instead.
    const existing = await this.deps.prisma.engagement.findUnique({
      where: { clientId_engagementType_taxYear: { clientId: workItem.client.id, engagementType, taxYear } },
      select: { id: true },
    });

    if (existing) {
      return {
        engagementId: existing.id,
        created: false,
        taxYear,
        priorYearEngagementId: previous?.id ?? null,
        notes: [`A ${taxYear} ${engagementType.replace(/_/g, ' ')} engagement already existed for this client.`],
      };
    }

    // A client with no history here still gets an engagement. The alternative —
    // refusing — leaves the firm with a work item in Karbon and nothing in this
    // application to explain why.
    //
    // It is *not* flagged with `blockedReason`, and the reason is worth writing
    // down: `WorkflowService.transition` writes `blockedReason: options
    // .blockedReason ?? null` on every move, so anything set here is erased by
    // the first transition — the flag would look right in a test that never
    // transitions and be gone by the time anybody looked.
    //
    // It would also be overstating the case. No prior *engagement* here does not
    // mean no prior *letter*: the Karbon search runs on the client key and last
    // year's work items, so it may well find one for a client the firm acted for
    // before this application existed. What is durably true is structural —
    // `initiationSource` says it started itself and `priorYearEngagementId`
    // stays null — and the fee blocks itself if nothing can be derived, which is
    // the check that actually matters.
    const result = await this.create({
      clientId: workItem.client.id,
      engagementType,
      taxYear,
      yearEnd,
      karbonWorkItemKey: input.karbonWorkItemKey,
      // The same people keep the client. Falling back to nobody rather than to
      // the actor, because the actor here is the system.
      assignedPreparerId: previous?.assignedPreparerId ?? null,
      assignedReviewerId: previous?.assignedReviewerId ?? null,
      actorId: input.actorId,
      isTestMode: input.isTestMode,
      initiationSource: input.initiationSource,
      correlationId: input.correlationId ?? null,
    });

    return {
      engagementId: result.engagementId,
      created: true,
      taxYear,
      priorYearEngagementId: result.priorYearEngagementId,
      notes: previous
        ? result.notes
        : [
            ...result.notes,
            `No earlier ${engagementType.replace(/_/g, ' ')} engagement exists here for this client, so nothing was carried forward. Karbon may still hold last year's letter; the search will say.`,
          ],
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
