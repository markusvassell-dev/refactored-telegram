import { isUniqueConstraintError, type PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { deriveTaxYear, rollYearEndForward } from '@element/integrations';
import {
  ENGAGEMENT_LETTER_BY_TYPE,
  PreconditionError,
  ValidationError,
  assertCan,
  type EngagementType,
  type Logger,
  type Principal,
} from '@element/shared';
import type { DocumentStore } from './storage.js';

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
  /**
   * Required rather than optional, because `delete` uses it to remove the
   * stored bytes. An absent store would leave every generated PDF and uploaded
   * source document on disk after the engagement they belong to was deleted —
   * and it would do it silently, which is the failure this codebase keeps
   * meeting. A service that cannot finish a delete should not be constructible.
   */
  store: DocumentStore;
  logger: Logger;
}

/** Shortest reason accepted for a deletion. Matches the wording and fee editors. */
const MINIMUM_DELETE_REASON_LENGTH = 10;

export interface DeleteEngagementInput {
  engagementId: string;
  reason: string;
  actor: Principal;
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

/**
 * What to propose from. A trigger has a work item key; a person choosing from a
 * list has a client. Either is enough, and where both are present the work item
 * wins because its title is the only place a tax year is ever stated outright.
 */
export interface ProposeInput {
  karbonWorkItemKey?: string | null;
  clientId?: string | null;
  engagementType: EngagementType;
}

/**
 * The engagement this application would create, and why it would choose each
 * part of it.
 *
 * Every derived value carries its basis rather than arriving bare. A tax year
 * read off a work item title and one guessed from the current calendar are both
 * numbers; only one of them is worth confirming without looking.
 */
export interface ProposedEngagement {
  clientId: string;
  clientLegalName: string;
  engagementType: EngagementType;
  taxYear: number;
  taxYearBasis: 'WORK_ITEM_TITLE' | 'PRIOR_YEAR_PLUS_ONE' | 'CURRENT_YEAR';
  /** ISO date, or null when there is none to carry forward. */
  yearEnd: string | null;
  yearEndBasis: 'ROLLED_FROM_PRIOR_YEAR' | 'REQUIRED_FROM_YOU' | 'NOT_APPLICABLE';
  priorYearEngagementId: string | null;
  /** Last year's fee, for context. Not carried forward here — pricing does that. */
  priorYearFee: string | null;
  assignedPreparerId: string | null;
  assignedReviewerId: string | null;
  /** Set when this engagement already exists, so nothing should be created. */
  alreadyExistsId: string | null;
  /** Reasons nothing can be proposed at all. */
  blockers: string[];
  /** Things worth reading before confirming. Never reasons to refuse. */
  notes: string[];
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
    const documentType = ENGAGEMENT_LETTER_BY_TYPE[input.engagementType];
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
  /**
   * What would be created, without creating it.
   *
   * `rollForward` used to interleave deciding with writing, which meant the
   * only way to find out what the application would choose was to let it
   * choose. That is fine for a status trigger and useless for a person looking
   * at a screen before they commit.
   *
   * So the deciding half lives here, reads nothing but the database, and is
   * called by **both** the preview and the trigger. The rule it exists to hold
   * is the one the date-rule and pricing editors already state: a preview that
   * runs different code from the commit can lie about what will happen, and
   * eventually will.
   *
   * Accepts either a Karbon work item or a client outright. The trigger has a
   * work item key; a person choosing a client from a list does not, and
   * requiring one would make this unusable from the page it was written for.
   */
  async propose(input: ProposeInput): Promise<ProposedEngagement> {
    const engagementType = input.engagementType;
    const notes: string[] = [];
    const blockers: string[] = [];

    const workItem = input.karbonWorkItemKey
      ? await this.deps.prisma.karbonWorkItem.findUnique({
          where: { karbonKey: input.karbonWorkItemKey },
          include: { client: { select: { id: true, legalName: true } } },
        })
      : null;

    if (input.karbonWorkItemKey && !workItem) {
      blockers.push(
        `Karbon work item ${input.karbonWorkItemKey} is not known here, so there is nothing to roll forward. Synchronise it first.`,
      );
    }

    if (workItem && !workItem.client) {
      // Named rather than guessed. A work item with no client is either a
      // client this application has not imported or a Karbon record with no
      // client on it, and those need different answers from a person.
      blockers.push(
        `Karbon work item ${input.karbonWorkItemKey} is not linked to a client here, so there is no history to roll forward. Import the client from Karbon first.`,
      );
    }

    const client = workItem?.client
      ? workItem.client
      : input.clientId
        ? await this.deps.prisma.client.findUnique({
            where: { id: input.clientId },
            select: { id: true, legalName: true },
          })
        : null;

    if (!client) {
      if (blockers.length === 0) blockers.push('Choose a client to propose an engagement for.');
      return {
        clientId: input.clientId ?? '',
        clientLegalName: '',
        engagementType,
        taxYear: new Date().getUTCFullYear(),
        taxYearBasis: 'CURRENT_YEAR',
        yearEnd: null,
        yearEndBasis: NEEDS_YEAR_END.includes(engagementType) ? 'REQUIRED_FROM_YOU' : 'NOT_APPLICABLE',
        priorYearEngagementId: null,
        priorYearFee: null,
        assignedPreparerId: null,
        assignedReviewerId: null,
        alreadyExistsId: null,
        blockers,
        notes,
      };
    }

    // Already rolled forward.
    //
    // One work item means one engagement, and that is the check that has to
    // come first — before any year is worked out. Deciding the year and *then*
    // looking for a duplicate gets it exactly wrong on the second run: the
    // engagement created a moment ago is now the newest one, so the fallback
    // reads it as "last year" and rolls forward again, creating a fresh
    // engagement every time the job is retried.
    const alreadyRolled = input.karbonWorkItemKey
      ? await this.deps.prisma.engagement.findFirst({
          where: { karbonWorkItem: { karbonKey: input.karbonWorkItemKey } },
          select: { id: true, taxYear: true, priorYearEngagementId: true, yearEnd: true },
        })
      : null;

    // The most recent engagement of this type for this client, whatever year it
    // was. Reading the newest rather than assuming last year matters for a
    // client the firm did not act for in the intervening year: their 2024
    // letter is still the right thing to carry forward into 2026.
    const previous = await this.deps.prisma.engagement.findFirst({
      where: { clientId: client.id, engagementType, ...(alreadyRolled ? { id: { not: alreadyRolled.id } } : {}) },
      orderBy: { taxYear: 'desc' },
      select: {
        id: true,
        taxYear: true,
        yearEnd: true,
        assignedPreparerId: true,
        assignedReviewerId: true,
        feeCalculations: {
          where: { isBlocked: false },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { roundedFee: true },
        },
      },
    });

    if (alreadyRolled) {
      notes.push(`This work item already has a ${alreadyRolled.taxYear} engagement.`);
      return {
        clientId: client.id,
        clientLegalName: client.legalName,
        engagementType,
        taxYear: alreadyRolled.taxYear,
        taxYearBasis: 'WORK_ITEM_TITLE',
        yearEnd: alreadyRolled.yearEnd ? alreadyRolled.yearEnd.toISOString().slice(0, 10) : null,
        yearEndBasis: alreadyRolled.yearEnd ? 'ROLLED_FROM_PRIOR_YEAR' : 'NOT_APPLICABLE',
        priorYearEngagementId: alreadyRolled.priorYearEngagementId,
        priorYearFee: previous?.feeCalculations[0]?.roundedFee?.toString() ?? null,
        assignedPreparerId: previous?.assignedPreparerId ?? null,
        assignedReviewerId: previous?.assignedReviewerId ?? null,
        alreadyExistsId: alreadyRolled.id,
        blockers,
        notes,
      };
    }

    // Karbon first where it names a year outright, then the deterministic
    // answer. `deriveTaxYear` returns null unless exactly one plausible year
    // appears, because a wrong tax year does not fail — it produces a
    // correct-looking letter for the wrong period.
    const derived = workItem ? deriveTaxYear(workItem) : null;
    const taxYear = derived ?? (previous ? previous.taxYear + 1 : new Date().getUTCFullYear());
    const taxYearBasis: ProposedEngagement['taxYearBasis'] = derived
      ? 'WORK_ITEM_TITLE'
      : previous
        ? 'PRIOR_YEAR_PLUS_ONE'
        : 'CURRENT_YEAR';

    // Karbon holds no year-end field at all, so this is the roll-forward or
    // nothing.
    const needsYearEnd = NEEDS_YEAR_END.includes(engagementType);
    const rolled =
      previous?.yearEnd && needsYearEnd ? rollYearEndForward(previous.yearEnd).toISOString().slice(0, 10) : null;

    const yearEndBasis: ProposedEngagement['yearEndBasis'] = !needsYearEnd
      ? 'NOT_APPLICABLE'
      : rolled
        ? 'ROLLED_FROM_PRIOR_YEAR'
        : 'REQUIRED_FROM_YOU';

    if (yearEndBasis === 'REQUIRED_FROM_YOU') {
      // Not a blocker here, deliberately. The unattended path refuses — see
      // `rollForward` — because nobody is present to answer. A person looking
      // at this can simply type it, and refusing to show them the rest of a
      // correct proposal because one field is unknowable would be perverse.
      notes.push(
        `There is no earlier ${engagementType.replace(/_/g, ' ')} engagement here to carry a year-end forward from, and Karbon publishes no year-end field. Enter it below; every year after this one rolls forward on its own.`,
      );
    }

    // The same client, type and year reached by a different route — started by
    // hand, or by a work item this one supersedes. The unique constraint would
    // refuse the insert anyway; reporting it says what happened instead.
    const existing = await this.deps.prisma.engagement.findUnique({
      where: { clientId_engagementType_taxYear: { clientId: client.id, engagementType, taxYear } },
      select: { id: true },
    });

    if (existing) {
      notes.push(`A ${taxYear} ${engagementType.replace(/_/g, ' ')} engagement already exists for this client.`);
    }

    if (!previous) {
      notes.push(
        `No earlier ${engagementType.replace(/_/g, ' ')} engagement exists here for this client, so nothing is carried forward. Karbon may still hold last year's letter; the search will say.`,
      );
    }

    return {
      clientId: client.id,
      clientLegalName: client.legalName,
      engagementType,
      taxYear,
      taxYearBasis,
      yearEnd: rolled,
      yearEndBasis,
      priorYearEngagementId: previous?.id ?? null,
      priorYearFee: previous?.feeCalculations[0]?.roundedFee?.toString() ?? null,
      assignedPreparerId: previous?.assignedPreparerId ?? null,
      assignedReviewerId: previous?.assignedReviewerId ?? null,
      alreadyExistsId: existing?.id ?? null,
      blockers,
      notes,
    };
  }

  async rollForward(input: RollForwardInput): Promise<RollForwardResult> {
    const proposal = await this.propose({
      karbonWorkItemKey: input.karbonWorkItemKey,
      engagementType: input.engagementType,
    });

    // The trigger cannot ask anybody anything, so what the page renders as a
    // note is a refusal here.
    if (proposal.blockers.length > 0) {
      throw new PreconditionError(proposal.blockers.join(' '));
    }

    if (proposal.alreadyExistsId) {
      return {
        engagementId: proposal.alreadyExistsId,
        created: false,
        taxYear: proposal.taxYear,
        priorYearEngagementId: proposal.priorYearEngagementId,
        notes: proposal.notes,
      };
    }

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
    if (proposal.yearEndBasis === 'REQUIRED_FROM_YOU') {
      throw new PreconditionError(
        `${proposal.clientLegalName} has no earlier ${input.engagementType.replace(/_/g, ' ')} engagement here, so there is no year-end to carry forward — and Karbon does not publish one. Start this engagement by hand, where the year-end is asked for; every year after it will roll forward on its own.`,
      );
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
      clientId: proposal.clientId,
      engagementType: input.engagementType,
      taxYear: proposal.taxYear,
      yearEnd: proposal.yearEnd,
      karbonWorkItemKey: input.karbonWorkItemKey,
      // The same people keep the client. Falling back to nobody rather than to
      // the actor, because the actor here is the system.
      assignedPreparerId: proposal.assignedPreparerId,
      assignedReviewerId: proposal.assignedReviewerId,
      actorId: input.actorId,
      isTestMode: input.isTestMode,
      initiationSource: input.initiationSource,
      correlationId: input.correlationId ?? null,
    });

    return {
      engagementId: result.engagementId,
      created: true,
      taxYear: proposal.taxYear,
      priorYearEngagementId: result.priorYearEngagementId,
      notes: [...result.notes, ...proposal.notes],
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
   * Removes an engagement, and leaves the audit trail able to say what it was.
   *
   * Deleting the row cascades through nineteen foreign keys: participants,
   * documents, extracted fields, fees, dates, approvals, review comments,
   * wording exceptions, cover letters, workflow history and queued jobs all go
   * with it. Nothing in the schema blocks that, which is exactly why the guard
   * below is the only thing standing between a mistaken click and the
   * destruction of an evidentiary record.
   *
   * **The audit entry is written before the delete**, so a delete that fails
   * still leaves a record of who tried and why. `audit_event` carries no
   * foreign key to engagement — dropped deliberately, because a trail must
   * outlive what it describes — so the entry survives the cascade and stays
   * findable by `engagementId` afterwards.
   *
   * **The snapshot is redacted, and that is intended.** `redact()` masks email
   * addresses and tail-masks anything named like a business number before the
   * entry is stored. Every REVIEWER can read the audit log, which is a wider
   * audience than the engagement itself had, so the masking is a feature of
   * writing history down rather than a defect in it.
   */
  async delete(input: DeleteEngagementInput): Promise<void> {
    assertCan(input.actor, 'engagement:delete');

    const reason = input.reason.trim();
    if (reason.length < MINIMUM_DELETE_REASON_LENGTH) {
      throw new ValidationError(
        'Give a reason for deleting this engagement. It is the only explanation the audit trail will carry.',
      );
    }

    const engagement = await this.deps.prisma.engagement.findUnique({
      where: { id: input.engagementId },
      include: {
        client: { select: { legalName: true } },
        participants: {
          select: { role: true, fullLegalName: true, email: true, signingOrder: true, contactConfirmed: true },
          orderBy: [{ signingOrder: 'asc' }, { role: 'asc' }],
        },
        preparer: { select: { displayName: true } },
        reviewer: { select: { displayName: true } },
        finalApprover: { select: { displayName: true } },
        feeCalculations: {
          select: {
            feeKind: true,
            roundedFee: true,
            previousFee: true,
            isManualOverride: true,
            isBlocked: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
        _count: {
          select: {
            documentVersions: true,
            sourceDocuments: true,
            approvals: true,
            coverLetters: true,
            workflowEvents: true,
            adobeAgreements: true,
            externalSignatures: true,
          },
        },
      },
    });

    if (!engagement) {
      throw new ValidationError('That engagement no longer exists.');
    }

    await this.assertNoSignatureEvidence(input.engagementId);

    // Deliberately a chosen shape rather than the row as it came back.
    // `redact()` decides what to mask from the *key names*, so a raw dump would
    // mask by accident and miss by accident. Everything here is something a
    // person asking "what was deleted, and should it have been?" needs.
    const snapshot = {
      engagementId: engagement.id,
      clientLegalName: engagement.client.legalName,
      engagementType: engagement.engagementType,
      taxYear: engagement.taxYear,
      yearEnd: engagement.yearEnd,
      status: engagement.status,
      karbonWorkItemId: engagement.karbonWorkItemId,
      isTestMode: engagement.isTestMode,
      blockedReason: engagement.blockedReason,
      createdAt: engagement.createdAt,
      updatedAt: engagement.updatedAt,
      assignedPreparer: engagement.preparer?.displayName ?? null,
      assignedReviewer: engagement.reviewer?.displayName ?? null,
      finalApprover: engagement.finalApprover?.displayName ?? null,
      participants: engagement.participants.map((participant) => ({
        role: participant.role,
        fullLegalName: participant.fullLegalName,
        email: participant.email,
        signingOrder: participant.signingOrder,
        contactConfirmed: participant.contactConfirmed,
      })),
      fees: engagement.feeCalculations.map((fee) => ({
        feeKind: fee.feeKind,
        // `roundedFee` is the fee as quoted — the one that would have reached a
        // client. Stringified because a Decimal serialises to an object that
        // reads as nothing useful in a stored snapshot.
        roundedFee: fee.roundedFee?.toString() ?? null,
        previousFee: fee.previousFee?.toString() ?? null,
        isManualOverride: fee.isManualOverride,
        isBlocked: fee.isBlocked,
      })),
      recordCounts: engagement._count,
    };

    await this.deps.audit.record({
      eventType: 'ENGAGEMENT_DELETED',
      objectType: 'Engagement',
      objectId: engagement.id,
      engagementId: engagement.id,
      userId: input.actor.id,
      beforeValue: snapshot,
      reason,
    });

    await this.deps.prisma.engagement.delete({ where: { id: engagement.id } });

    await this.purgeStoredDocuments(engagement.id);
  }

  /**
   * Refuses to delete an engagement that carries evidence of a client having
   * been asked to sign, or having signed.
   *
   * An `ExternalSignature` row is a signature obtained outside this application
   * and recorded against the engagement. A non-mock `AdobeAgreement` past
   * `CREATED` means Adobe actually sent something to somebody. Neither can be
   * reconstructed from a snapshot, and neither is this application's to discard.
   *
   * A mock agreement is deliberately *not* protected. It names no real signer
   * and contacted nobody, and clearing test sends is most of what this button
   * is for.
   */
  private async assertNoSignatureEvidence(engagementId: string): Promise<void> {
    const [externalSignatures, sentAgreements] = await Promise.all([
      this.deps.prisma.externalSignature.count({ where: { engagementId } }),
      this.deps.prisma.adobeAgreement.count({
        where: { engagementId, isMockProvider: false, status: { not: 'CREATED' } },
      }),
    ]);

    if (externalSignatures > 0) {
      throw new PreconditionError(
        'This engagement has a signature recorded against it, so it cannot be deleted. A signed engagement letter is a record the firm has to keep.',
      );
    }

    if (sentAgreements > 0) {
      throw new PreconditionError(
        'This engagement has been sent for signature through Adobe Sign, so it cannot be deleted. Cancel the agreement first; if it is already signed, it must be kept.',
      );
    }
  }

  /**
   * Removes the stored bytes belonging to an engagement.
   *
   * **Two scopes, not one.** Source documents and external-signature evidence
   * are stored under the raw engagement id, while generated documents and cover
   * letters are stored under the same id with its hyphens stripped
   * (`generation-service.ts`, `cover-letter-service.ts`). `sanitizeScope` keeps
   * hyphens, so those are genuinely different scopes and purging one leaves the
   * other behind as unreachable blobs.
   *
   * A failure here never fails the delete. The row and its children are already
   * gone by this point, the expiry sweep reclaims anything left, and reporting
   * a failure for work that mostly succeeded would send somebody looking for an
   * engagement that no longer exists.
   */
  private async purgeStoredDocuments(engagementId: string): Promise<void> {
    for (const scope of [engagementId, engagementId.replace(/-/g, '')]) {
      try {
        await this.deps.store.purgeScope(scope);
      } catch (error) {
        this.deps.logger.error('Could not purge stored documents for a deleted engagement', {
          engagementId,
          scope,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
