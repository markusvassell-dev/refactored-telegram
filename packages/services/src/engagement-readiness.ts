import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { ENGAGEMENT_LETTER_BY_TYPE, type ValueSource } from '@element/shared';
import { resolveFieldValue } from './field-values.js';

/**
 * Settling the routine, and proving the rest.
 *
 * Every workspace tab already fills itself — preparation writes the Karbon
 * client values, seeds the service selections from last year, calculates every
 * date from its rule and prices the fee. What stopped an engagement moving was
 * never the filling in; it was that each filled-in row then waited for somebody
 * to press Confirm on something the application had already worked out and had
 * no doubt about.
 *
 * So this does two things.
 *
 * `settle` confirms **only what is unambiguous** — a date whose rule computed
 * cleanly, a service selection identical to last year's. What it refuses to
 * touch is the point of it, and each refusal is a rule somebody would otherwise
 * be tempted to relax:
 *
 *   - a genuine conflict, because `reconcile` raises one only when two sources
 *     actually disagree, and choosing between them is a decision that would end
 *     up recorded against whoever later approves the document;
 *   - a blocked or high-increase fee, because the approval threshold exists so
 *     a partner sees a large movement before a client does;
 *   - the T2 compilation answer, because it decides whether a whole section of
 *     legal scope stays in the letter;
 *   - a blocked date, because the rule returned `isBlocked` precisely to say it
 *     could not work one out.
 *
 * `check` turns the two comparison tabs, which until now displayed information
 * and computed nothing, into a pass or a fail.
 *
 * ## How an automatic confirmation is recorded
 *
 * `confirmedAt` is set and **`confirmedByUserId` is left null**. That is not a
 * shortcut: `confirmedByUserId` is a foreign key to `user`, there is
 * deliberately no `system` user row, and writing `SYSTEM_ACTOR_ID` into it
 * would be a foreign-key violation that fails invisibly — the job burns its
 * retries and the engagement lands in `NEEDS_ATTENTION` carrying a Prisma error
 * nobody reads. `system-actor.ts` says so in as many words.
 *
 * The absence is also the more honest record. A date with a confirmation time
 * and no confirmer says exactly what happened: the application settled this,
 * and no person has read it. The workspace renders that differently from a
 * person's name, because a reviewer approving the document is inheriting these
 * confirmations and has to be able to tell which they are.
 */

export interface EngagementReadinessDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
}

export interface SettleResult {
  datesConfirmed: number;
  serviceSelectionsConfirmed: number;
  /** Assumptions carried by the dates settled, so the panel can surface them. */
  assumptions: string[];
  /** What was deliberately left for a person, in words. */
  leftForAPerson: string[];
}

export interface ReadinessSection {
  key: 'SOURCE_DOCUMENTS' | 'CLIENT_INFORMATION' | 'DATES' | 'SERVICES' | 'PREVIOUS_YEAR' | 'MASTER_TEMPLATE';
  label: string;
  ok: boolean;
  /** Named, actionable, and empty when `ok`. */
  outstanding: string[];
  /**
   * What the section found and is not blocking on. A comparison that only ever
   * speaks up to refuse is indistinguishable from one that never ran, so the
   * findings that are ordinary — a value a stronger source legitimately changed
   * — are still reported.
   */
  noted: string[];
}

export interface ReadinessReport {
  ok: boolean;
  sections: ReadinessSection[];
  /** Dates and selections the application confirmed rather than a person. */
  settledAutomatically: number;
}

export class EngagementReadinessService {
  constructor(private readonly deps: EngagementReadinessDeps) {}

  async settle(engagementId: string, correlationId?: string): Promise<SettleResult> {
    const [dates, selections] = await Promise.all([
      this.deps.prisma.calculatedDate.findMany({
        where: {
          engagementId,
          confirmedAt: null,
          isBlocked: false,
          result: { not: null },
        },
        select: { id: true, token: true, assumptions: true },
      }),
      this.deps.prisma.serviceSelection.findMany({
        where: { engagementId, confirmed: false },
        select: {
          id: true,
          serviceCode: true,
          isSelected: true,
          priorYearSelected: true,
        },
      }),
    ]);

    // A selection is only settled when it is what last year said. A changed one
    // is a decision somebody made, or a default that has never been looked at,
    // and neither should be confirmed on their behalf.
    const unchanged = selections.filter(
      (selection) => selection.priorYearSelected !== null && selection.priorYearSelected === selection.isSelected,
    );

    const now = new Date();

    if (dates.length > 0) {
      await this.deps.prisma.calculatedDate.updateMany({
        where: { id: { in: dates.map((date) => date.id) } },
        // No `confirmedByUserId`. See the note above — the column is a foreign
        // key with no system row to point at, and its absence is what marks
        // this as settled rather than read.
        data: { confirmedAt: now },
      });
    }

    if (unchanged.length > 0) {
      await this.deps.prisma.serviceSelection.updateMany({
        where: { id: { in: unchanged.map((selection) => selection.id) } },
        data: { confirmed: true, confirmedAt: now },
      });
    }

    const assumptions = [
      ...new Set(dates.flatMap((date) => (Array.isArray(date.assumptions) ? (date.assumptions as string[]) : []))),
    ];

    const leftForAPerson = await this.describeWhatIsLeft(engagementId);

    if (dates.length > 0 || unchanged.length > 0) {
      await this.deps.audit.record({
        eventType: 'DATE_CONFIRMED',
        objectType: 'Engagement',
        objectId: engagementId,
        engagementId,
        correlationId,
        afterValue: {
          datesConfirmed: dates.map((date) => date.token),
          serviceSelectionsConfirmed: unchanged.map((selection) => selection.serviceCode),
          // Recorded because a reviewer inherits these, and the audit trail is
          // where the question "who agreed to this?" is answered.
          confirmedBy: 'the application, automatically',
          assumptions,
        },
        reason: 'Settled the values the application had no doubt about; everything uncertain was left for a person.',
      });
    }

    return {
      datesConfirmed: dates.length,
      serviceSelectionsConfirmed: unchanged.length,
      assumptions,
      leftForAPerson,
    };
  }

  /** The things `settle` deliberately did not touch, phrased for a reviewer. */
  private async describeWhatIsLeft(engagementId: string): Promise<string[]> {
    const [conflicts, blockedFees, approvalFees, blockedDates, engagement, changedSelections] = await Promise.all([
      this.deps.prisma.fieldConflict.count({
        where: { engagementId, status: 'UNRESOLVED' },
      }),
      this.deps.prisma.feeCalculation.count({
        where: { engagementId, isBlocked: true },
      }),
      this.deps.prisma.feeCalculation.count({
        where: {
          engagementId,
          requiresApprovalType: { not: null },
          approvedAt: null,
        },
      }),
      this.deps.prisma.calculatedDate.findMany({
        where: { engagementId, isBlocked: true },
        select: { token: true, blockedReason: true },
      }),
      this.deps.prisma.engagement.findUniqueOrThrow({
        where: { id: engagementId },
        select: { engagementType: true, compilationSelected: true },
      }),
      this.deps.prisma.serviceSelection.count({
        where: { engagementId, confirmed: false },
      }),
    ]);

    const left: string[] = [];

    if (conflicts > 0) {
      left.push(`${conflicts} value(s) where two sources disagree. Choosing between them is not the application's to do.`);
    }
    if (blockedFees > 0) {
      left.push(`${blockedFees} fee(s) could not be derived and need a figure.`);
    }
    if (approvalFees > 0) {
      left.push(`${approvalFees} fee change(s) need a partner's approval before the letter carries the price.`);
    }
    for (const date of blockedDates) {
      left.push(`${date.token}: ${date.blockedReason ?? 'could not be calculated.'}`);
    }
    if (engagement.engagementType === 'T2' && engagement.compilationSelected === null) {
      left.push(
        'Whether CSRS 4200 compilation services are included this year. It decides whether section 3A stays in the letter, so last year’s answer is evidence rather than an answer.',
      );
    }
    if (changedSelections > 0) {
      left.push(`${changedSelections} service selection(s) differ from last year and need confirming.`);
    }

    return left;
  }

  /**
   * Whether this engagement is fit to put in front of a reviewer.
   *
   * Six sections, one per workspace tab, each either settled or carrying a
   * named, actionable list. The panel and the gate read the same report, so a
   * reviewer can never be told a thing is fine by one and blocked by the other.
   */
  async check(engagementId: string): Promise<ReadinessReport> {
    const engagement = await this.deps.prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId },
      select: {
        id: true,
        engagementType: true,
        compilationSelected: true,
        templateVersionId: true,
      },
    });

    const [sources, conflicts, dates, selections, fields, latestVersion, exceptions] = await Promise.all([
      this.deps.prisma.sourceDocument.findMany({
        where: { engagementId },
        select: {
          fileName: true,
          confirmedAt: true,
          karbonDocumentId: true,
          isFinal: true,
        },
      }),
      // Every conflict, not only the unresolved ones: a resolved conflict is
      // what `resolveFieldValue` applies, so the previous-year comparison needs
      // it to see the value that will actually reach the letter.
      this.deps.prisma.fieldConflict.findMany({
        where: { engagementId },
        select: {
          token: true,
          status: true,
          resolvedValue: true,
          resolvedSource: true,
        },
      }),
      this.deps.prisma.calculatedDate.findMany({
        where: { engagementId },
        select: {
          token: true,
          confirmedAt: true,
          confirmedByUserId: true,
          isBlocked: true,
          blockedReason: true,
        },
      }),
      this.deps.prisma.serviceSelection.findMany({
        where: { engagementId },
        select: { serviceCode: true, confirmed: true, confirmedByUserId: true },
      }),
      // `coverLetterPackageId: null` scopes this to the engagement letter. A
      // cover-letter package carries its own fields under the same tokens, and
      // comparing across the two would compare a letter with a covering note.
      this.deps.prisma.extractedField.findMany({
        where: { engagementId, coverLetterPackageId: null },
        select: {
          token: true,
          value: true,
          source: true,
          manualOverrideValue: true,
          manuallyConfirmed: true,
        },
      }),
      this.deps.prisma.documentVersion.findFirst({
        where: { engagementId, coverLetterPackageId: null },
        orderBy: { versionNumber: 'desc' },
        select: {
          validationReport: true,
          templateVersionId: true,
          sourceFileHash: true,
        },
      }),
      this.deps.prisma.wordingException.count({
        where: { engagementId, approvedAt: null, rejectedAt: null },
      }),
    ]);

    const unresolvedConflicts = conflicts.filter((conflict) => conflict.status === 'UNRESOLVED');

    const sections: ReadinessSection[] = [];

    // ---- Source documents -------------------------------------------------
    // A candidate located in Karbon but never confirmed is the state the search
    // parks in when it cannot decide, and it is the commonest thing waiting.
    const unconfirmedSources = sources.filter((source) => source.karbonDocumentId && !source.confirmedAt);
    sections.push({
      key: 'SOURCE_DOCUMENTS',
      label: 'Source Documents',
      ok: unconfirmedSources.length === 0,
      outstanding: unconfirmedSources.map(
        (source) => `${source.fileName} was found in Karbon but nobody has confirmed it is last year's letter.`,
      ),
      noted: sources.filter((source) => source.confirmedAt).map((source) => `${source.fileName} confirmed as a source document.`),
    });

    // ---- Client information ----------------------------------------------
    sections.push({
      key: 'CLIENT_INFORMATION',
      label: 'Client Information',
      ok: unresolvedConflicts.length === 0,
      outstanding: unresolvedConflicts.map((conflict) => `${conflict.token}: two sources disagree and one must be chosen.`),
      noted: conflicts
        .filter((conflict) => conflict.status !== 'UNRESOLVED')
        .map((conflict) => `${conflict.token}: resolved to "${conflict.resolvedValue ?? '—'}".`),
    });

    // ---- Dates -------------------------------------------------------------
    const blockedDates = dates.filter((date) => date.isBlocked);
    const unconfirmedDates = dates.filter((date) => !date.isBlocked && date.confirmedAt === null);
    sections.push({
      key: 'DATES',
      label: 'Dates and Deadlines',
      ok: blockedDates.length === 0 && unconfirmedDates.length === 0,
      outstanding: [
        ...blockedDates.map((date) => `${date.token}: ${date.blockedReason ?? 'could not be calculated.'}`),
        ...unconfirmedDates.map((date) => `${date.token} is not confirmed.`),
      ],
      noted: dates
        .filter((date) => date.confirmedAt !== null && date.confirmedByUserId === null)
        .map((date) => `${date.token} was confirmed automatically.`),
    });

    // ---- Services ----------------------------------------------------------
    const unconfirmedSelections = selections.filter((selection) => !selection.confirmed);
    const compilationOutstanding = engagement.engagementType === 'T2' && engagement.compilationSelected === null;
    sections.push({
      key: 'SERVICES',
      label: 'Services',
      ok: unconfirmedSelections.length === 0 && !compilationOutstanding,
      outstanding: [
        ...(compilationOutstanding
          ? ['Whether CSRS 4200 compilation services are included this year has not been answered.']
          : []),
        ...unconfirmedSelections.map((selection) => `${selection.serviceCode} is not confirmed.`),
      ],
      noted: selections
        .filter((selection) => selection.confirmed && selection.confirmedByUserId === null)
        .map((selection) => `${selection.serviceCode} was carried forward from last year automatically.`),
    });

    // ---- Previous-year comparison -----------------------------------------
    //
    // The tab has always promised "the value taken from the prior-year letter,
    // alongside the value proposed for this year" and only ever shown the first
    // column. This computes the second.
    //
    // Which value is "proposed for this year" is not re-derived here.
    // `resolveFieldValue` is the one rule the review screen and generation both
    // use, and a comparison that reasoned about source priority on its own
    // could pass a token the document then renders differently — the exact
    // class of disagreement that rule exists to prevent.
    //
    // Three outcomes, and only one of them stops the engagement:
    //
    //   - **carried forward** — this year's value equals last year's *and*
    //     something other than last year's letter vouches for it, or a person
    //     has. Ordinary.
    //   - **superseded** — a stronger source or a person's decision changed it.
    //     Reported with both values, because a fee or a year-end moving is
    //     exactly what a reviewer wants to see, and refused for nobody.
    //   - **carried forward unchecked** — last year's letter is the *only*
    //     thing supplying a value that will be printed and signed this year,
    //     and no person has looked at it. That is the finding worth blocking
    //     on: it is how a stale client name or an out-of-date address reaches a
    //     client over the firm's signature, and until now nothing said it was
    //     happening. Confirming the value on the Client Information tab clears
    //     it — as does Karbon simply having the value.
    const conflictByToken = new Map(conflicts.map((conflict) => [conflict.token, conflict]));
    const fieldsByToken = new Map<string, typeof fields>();
    for (const field of fields) {
      const bucket = fieldsByToken.get(field.token);
      if (bucket) bucket.push(field);
      else fieldsByToken.set(field.token, [field]);
    }

    const previousYearOutstanding: string[] = [];
    const previousYearNoted: string[] = [];

    for (const [token, candidates] of fieldsByToken) {
      const prior = candidates.find((field) => field.source === 'PRIOR_YEAR_DOCUMENT');
      if (!prior?.value) continue;

      const conflict = conflictByToken.get(token);
      const effective = resolveFieldValue(
        candidates.map((field) => ({
          value: field.value,
          source: field.source as ValueSource,
          manualOverrideValue: field.manualOverrideValue,
          manuallyConfirmed: field.manuallyConfirmed,
        })),
        conflict
          ? {
              status: conflict.status,
              resolvedValue: conflict.resolvedValue,
              resolvedSource: conflict.resolvedSource as ValueSource | null,
            }
          : null,
      );

      if (!effective) {
        previousYearOutstanding.push(`${token} was "${prior.value}" last year and has no value this year.`);
        continue;
      }

      if (effective.value !== prior.value) {
        previousYearNoted.push(`${token}: "${prior.value}" last year, "${effective.value}" this year.`);
        continue;
      }

      // The value matches last year's. Whether that is corroboration or an
      // unread carry-forward depends on where it came from.
      const corroborated =
        effective.source !== 'PRIOR_YEAR_DOCUMENT' ||
        effective.basis !== 'HIGHEST_PRIORITY_SOURCE' ||
        prior.manuallyConfirmed === true;

      if (corroborated) {
        previousYearNoted.push(`${token} carried forward as "${prior.value}".`);
      } else {
        previousYearOutstanding.push(
          `${token} is "${prior.value}" only because last year's letter said so — no current source has it and nobody has confirmed it.`,
        );
      }
    }

    sections.push({
      key: 'PREVIOUS_YEAR',
      label: 'Previous-Year Comparison',
      ok: previousYearOutstanding.length === 0,
      outstanding: previousYearOutstanding,
      noted: previousYearNoted,
    });

    // ---- Master-template comparison ---------------------------------------
    //
    // The tab prints a template name, a version and a source hash, and verifies
    // none of them. Three objective checks, each of which can genuinely fail:
    // the draft came from the version that is currently approved; that
    // version's bytes are the ones it was rendered from; and nothing in the
    // document departs from it without an approval.
    const masterOutstanding: string[] = [];
    const masterNoted: string[] = [];

    const template = await this.deps.prisma.documentTemplate.findFirst({
      where: { documentType: this.documentTypeFor(engagement.engagementType) },
      select: {
        name: true,
        versions: {
          where: { status: 'ACTIVE' },
          take: 1,
          select: {
            id: true,
            versionNumber: true,
            sourceFileHash: true,
            normalizedFileHash: true,
          },
        },
      },
    });

    const active = template?.versions[0];

    if (!active) {
      masterOutstanding.push('No approved template version is active for this engagement type.');
    } else {
      masterNoted.push(`Approved master template: ${template?.name ?? 'template'} v${active.versionNumber}.`);

      if (engagement.templateVersionId && engagement.templateVersionId !== active.id) {
        masterOutstanding.push(
          'This engagement is linked to a template version that is no longer the approved one. Regenerate the draft.',
        );
      }

      if (latestVersion?.templateVersionId && latestVersion.templateVersionId !== active.id) {
        masterOutstanding.push('The latest draft was rendered from a superseded template version. Regenerate it.');
      } else if (latestVersion?.sourceFileHash) {
        // Generation records `normalizedFileHash ?? sourceFileHash`, so the
        // comparison has to fall back the same way or a template with no
        // normalised copy reports a mismatch that is not one.
        const expected = active.normalizedFileHash ?? active.sourceFileHash;
        if (latestVersion.sourceFileHash !== expected) {
          masterOutstanding.push(
            'The draft was rendered from template bytes that no longer match the approved version. Regenerate it.',
          );
        } else {
          masterNoted.push('The draft matches the approved template byte for byte.');
        }
      }
    }

    if (exceptions > 0) {
      masterOutstanding.push(`${exceptions} wording change(s) have not been approved.`);
    }

    const report = (latestVersion?.validationReport ?? null) as {
      errorCount?: number;
    } | null;
    if (report && (report.errorCount ?? 0) > 0) {
      masterOutstanding.push(`The rendered document failed ${report.errorCount} validation check(s). See Document Preview.`);
    } else if (report) {
      masterNoted.push('The rendered document passed every validation check.');
    }

    sections.push({
      key: 'MASTER_TEMPLATE',
      label: 'Master-Template Comparison',
      ok: masterOutstanding.length === 0,
      outstanding: masterOutstanding,
      noted: masterNoted,
    });

    const settledAutomatically =
      dates.filter((date) => date.confirmedAt !== null && date.confirmedByUserId === null).length +
      selections.filter((selection) => selection.confirmed && selection.confirmedByUserId === null).length;

    return {
      ok: sections.every((section) => section.ok),
      sections,
      settledAutomatically,
    };
  }

  private documentTypeFor(engagementType: string) {
    return ENGAGEMENT_LETTER_BY_TYPE[engagementType as keyof typeof ENGAGEMENT_LETTER_BY_TYPE];
  }
}
