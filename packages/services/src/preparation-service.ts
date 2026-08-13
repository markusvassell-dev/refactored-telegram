import type { ParticipantRole, Prisma, PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { evaluateDateRule, type DateRuleInputs } from '@element/dates';
import { parseManifest, type TemplateManifest } from '@element/documents';
import {
  money,
  sourceRank,
  type DocumentType,
  type EngagementType,
  type ExtractionMethod,
  type FeeKind,
  type Logger,
  type ValueSource,
} from '@element/shared';
import type { PricingService } from './pricing-service.js';
import {
  CLIENT_SIGNING_ORDER,
  FIRM_SIGNING_ORDER,
  REQUIRED_CLIENT_ROLES,
  describeRole,
  isSigningRole,
} from './participant-service.js';

/**
 * Engagement preparation.
 *
 * This is the step between extracting a prior-year letter and generating a new
 * one. It:
 *
 *  1. records what current Karbon information says, as its own source;
 *  2. compares every value that came from more than one place and raises a
 *     conflict rather than silently choosing;
 *  3. seeds the service selections, carrying the prior year forward only as a
 *     *suggestion* that a reviewer must confirm;
 *  4. calculates the fees from the resolved price rule;
 *  5. evaluates the date rules, recording the rule, input and assumptions, and
 *     blocking any deadline whose inputs are not known.
 *
 * It is idempotent: re-running it updates rows rather than duplicating them,
 * and it never overwrites a decision a person has already made.
 */

export interface PreparationDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  pricing: PricingService;
  logger: Logger;
}

export interface PrepareInput {
  engagementId: string;
  actorId: string;
  correlationId: string;
  highIncreaseThresholdPercent: number;
}

export interface PrepareResult {
  karbonFieldsRecorded: number;
  conflictsRaised: number;
  serviceSelectionsSeeded: number;
  feesCalculated: FeeKind[];
  blockedFees: FeeKind[];
  datesCalculated: number;
  blockedDates: string[];
  /** Signers proposed from the client's Karbon contacts, awaiting confirmation. */
  signersProposed: number;
  /** What still stands between this engagement and being sendable. */
  signerNotes: string[];
}

const DOCUMENT_TYPE_BY_ENGAGEMENT: Record<EngagementType, DocumentType> = {
  T1_JOINT: 'T1_JOINT_ENGAGEMENT_LETTER',
  T1_SINGLE: 'T1_SINGLE_ENGAGEMENT_LETTER',
  T2: 'T2_ENGAGEMENT_LETTER',
  T3: 'T3_ENGAGEMENT_LETTER',
};

/** Prior-year fee tokens, by the fee they represent. */
const FEE_TOKEN_BY_KIND: Record<FeeKind, string> = {
  T1_PREPARATION: 'pricing.t1_fee',
  T2_PREPARATION: 'pricing.t2_fee',
  T3_PREPARATION: 'pricing.t3_fee',
  CSRS_4200_COMPILATION: 'pricing.compilation_fee',
};

function feeKindsFor(engagementType: EngagementType, compilationSelected: boolean | null): FeeKind[] {
  switch (engagementType) {
    case 'T2':
      return compilationSelected === true ? ['T2_PREPARATION', 'CSRS_4200_COMPILATION'] : ['T2_PREPARATION'];
    case 'T3':
      return ['T3_PREPARATION'];
    default:
      return ['T1_PREPARATION'];
  }
}

/**
 * Date rules to evaluate, in dependency order, mapped to the template token
 * they populate. A filing deadline must be computed before anything derived
 * from it.
 */
const DATE_PLAN: Record<EngagementType, { ruleCode: string; token: string }[]> = {
  T2: [
    { ruleCode: 't2.filing_deadline', token: 'dates.filing_due' },
    { ruleCode: 't2.balance_due_date', token: 'dates.balance_due' },
    { ruleCode: 't2.information_due_date', token: 'dates.client_information_due' },
    { ruleCode: 't2.target_completion_date', token: 'dates.target_completion' },
    { ruleCode: 't2.authorization_due_date', token: 'dates.authorization_due' },
  ],
  T1_JOINT: [
    { ruleCode: 't1.filing_deadline', token: 'dates.filing_deadline' },
    { ruleCode: 't1.payment_deadline', token: 'dates.payment_deadline' },
    { ruleCode: 't1.information_due_date', token: 'dates.client_information_due' },
    { ruleCode: 't1.t183_requested_by', token: 'dates.t183_requested_by' },
  ],
  T1_SINGLE: [
    { ruleCode: 't1.filing_deadline', token: 'dates.filing_deadline' },
    { ruleCode: 't1.payment_deadline', token: 'dates.payment_deadline' },
    { ruleCode: 't1.information_due_date', token: 'dates.client_information_due' },
    { ruleCode: 't1.t183_requested_by', token: 'dates.t183_requested_by' },
  ],
  T3: [
    { ruleCode: 't3.filing_deadline', token: 'dates.filing_deadline' },
    { ruleCode: 't3.payment_deadline', token: 'dates.payment_deadline' },
    { ruleCode: 't3.information_due_date', token: 'dates.client_information_due' },
  ],
};

/** Tokens holding a boolean fact a date rule depends on. */
export const FACT_TOKEN_PREFIX = 'facts.';

export function factToken(key: string): string {
  return `${FACT_TOKEN_PREFIX}${key}`;
}

/** Compares two values the way a reviewer would, ignoring cosmetic differences. */
export function valuesAgree(left: string | null, right: string | null): boolean {
  const normalize = (value: string | null): string =>
    (value ?? '')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-')
      .replace(/[\s,.]+/g, ' ')
      .trim()
      .toLowerCase();

  return normalize(left) === normalize(right);
}

export class PreparationService {
  constructor(private readonly deps: PreparationDeps) {}

  async prepare(input: PrepareInput): Promise<PrepareResult> {
    const engagement = await this.deps.prisma.engagement.findUniqueOrThrow({
      where: { id: input.engagementId },
      include: { client: { include: { contacts: true } } },
    });

    const manifest = await this.activeManifest(DOCUMENT_TYPE_BY_ENGAGEMENT[engagement.engagementType]);

    const karbonFieldsRecorded = await this.recordKarbonValues(engagement);
    const signersProposed = await this.proposeSigners(engagement);
    const conflictsRaised = await this.reconcile(input.engagementId, input.actorId, input.correlationId);
    const serviceSelectionsSeeded = manifest ? await this.seedServiceSelections(input.engagementId, manifest) : 0;
    const dates = await this.calculateDates(engagement);
    const fees = await this.calculateFees(engagement, input);

    await this.deps.audit.record({
      eventType: 'GENERATION_REQUESTED',
      objectType: 'Engagement',
      objectId: input.engagementId,
      engagementId: input.engagementId,
      userId: input.actorId,
      correlationId: input.correlationId,
      reason: 'Engagement prepared: values reconciled, fees calculated, deadlines evaluated.',
      afterValue: {
        karbonFieldsRecorded,
        conflictsRaised,
        serviceSelectionsSeeded,
        feesCalculated: fees.calculated,
        blockedFees: fees.blocked,
        datesCalculated: dates.calculated,
        blockedDates: dates.blocked,
      },
    });

    this.deps.logger.info('Engagement prepared', {
      engagementId: input.engagementId,
      correlationId: input.correlationId,
      conflictsRaised,
      blockedFees: fees.blocked.length,
      blockedDates: dates.blocked.length,
    });

    return {
      karbonFieldsRecorded,
      conflictsRaised,
      serviceSelectionsSeeded,
      feesCalculated: fees.calculated,
      blockedFees: fees.blocked,
      datesCalculated: dates.calculated,
      blockedDates: dates.blocked,
      signersProposed,
      signerNotes: await this.outstandingSigners(input.engagementId, engagement.engagementType),
    };
  }

  private async activeManifest(documentType: DocumentType): Promise<TemplateManifest | null> {
    const template = await this.deps.prisma.documentTemplate.findUnique({
      where: { documentType },
      include: { versions: { where: { status: 'ACTIVE' }, orderBy: { versionNumber: 'desc' }, take: 1 } },
    });

    const version = template?.versions[0];
    return version ? parseManifest(version.manifest) : null;
  }

  /**
   * Upserts an engagement-level field. `coverLetterPackageId` is null here, and
   * the uniqueness guarantee comes from a NULLS NOT DISTINCT index that
   * Prisma's compound-key type cannot express, so the lookup is explicit.
   */
  private async putField(input: {
    engagementId: string;
    token: string;
    source: ValueSource;
    method: ExtractionMethod;
    value?: string | null;
    valueDate?: Date | null;
    valueBoolean?: boolean | null;
    confidence?: number;
  }): Promise<void> {
    const existing = await this.deps.prisma.extractedField.findFirst({
      where: {
        engagementId: input.engagementId,
        coverLetterPackageId: null,
        token: input.token,
        source: input.source,
      },
      select: { id: true, manuallyConfirmed: true },
    });

    // A value a person has confirmed is never silently rewritten.
    if (existing?.manuallyConfirmed) return;

    const data = {
      value: input.value ?? null,
      valueDate: input.valueDate ?? null,
      valueBoolean: input.valueBoolean ?? null,
      confidence: input.confidence ?? 1,
    };

    if (existing) {
      await this.deps.prisma.extractedField.update({ where: { id: existing.id }, data });
      return;
    }

    await this.deps.prisma.extractedField.create({
      data: {
        engagementId: input.engagementId,
        token: input.token,
        source: input.source,
        extractionMethod: input.method,
        ...data,
      },
    });
  }

  /**
   * Records what current Karbon information says, as its own source, so it can
   * be compared against the prior-year document rather than silently assumed.
   */
  private async recordKarbonValues(engagement: {
    id: string;
    engagementType: EngagementType;
    taxYear: number;
    yearEnd: Date | null;
    client: {
      legalName: string;
      businessNumber: string | null;
      trustAccountNumber: string | null;
      addressLine1: string | null;
      addressLine2: string | null;
      city: string | null;
      province: string | null;
      postalCode: string | null;
      contacts: { fullLegalName: string; firstName: string | null; email: string | null; telephone: string | null; title: string | null; isPrimary: boolean }[];
    };
  }): Promise<number> {
    const address = [
      engagement.client.addressLine1,
      engagement.client.addressLine2,
      [engagement.client.city, engagement.client.province].filter(Boolean).join(', '),
      engagement.client.postalCode,
    ]
      .filter((line) => line && line.trim() !== '')
      .join('\n');

    const primary =
      engagement.client.contacts.find((contact) => contact.isPrimary) ?? engagement.client.contacts[0] ?? null;

    const values: { token: string; value?: string | null; valueDate?: Date | null }[] = [];

    switch (engagement.engagementType) {
      case 'T2':
        values.push(
          { token: 'corporation.legal_name', value: engagement.client.legalName },
          { token: 'corporation.business_number', value: engagement.client.businessNumber },
          { token: 'corporation.year_end', valueDate: engagement.yearEnd },
          { token: 'signer.officer_name', value: primary?.fullLegalName ?? null },
          { token: 'signer.officer_title', value: primary?.title ?? null },
          { token: 'signer.officer_email', value: primary?.email ?? null },
        );
        break;

      case 'T3':
        values.push(
          { token: 'trust.legal_name', value: engagement.client.legalName },
          { token: 'trust.address', value: address },
          { token: 'trust.account_number', value: engagement.client.trustAccountNumber },
          { token: 'trust.year_end', valueDate: engagement.yearEnd },
          { token: 'representative.full_name', value: primary?.fullLegalName ?? null },
          { token: 'representative.first_name', value: primary?.firstName ?? null },
          { token: 'representative.email', value: primary?.email ?? null },
        );
        break;

      default: {
        const [first, second] = engagement.client.contacts;
        values.push(
          { token: 'client.address', value: address },
          { token: 'engagement.tax_year', value: String(engagement.taxYear) },
        );
        if (first) {
          values.push(
            { token: 'taxpayer1.full_legal_name', value: first.fullLegalName },
            { token: 'taxpayer1.first_name', value: first.firstName },
            { token: 'taxpayer1.email', value: first.email },
            { token: 'taxpayer1.telephone', value: first.telephone },
          );
        }
        if (second) {
          values.push(
            { token: 'taxpayer2.full_legal_name', value: second.fullLegalName },
            { token: 'taxpayer2.first_name', value: second.firstName },
            { token: 'taxpayer2.email', value: second.email },
            { token: 'taxpayer2.telephone', value: second.telephone },
          );
        }
        break;
      }
    }

    // The year the letter is issued is always known from the engagement.
    values.push({ token: 'engagement.tax_year', value: String(engagement.taxYear) });

    let recorded = 0;
    for (const entry of values) {
      const hasValue = (entry.value ?? null) !== null || (entry.valueDate ?? null) !== null;
      if (!hasValue) continue;

      await this.putField({
        engagementId: engagement.id,
        token: entry.token,
        source: 'KARBON_CLIENT',
        method: 'STRUCTURED_EXPORT',
        value: entry.value ?? null,
        valueDate: entry.valueDate ?? null,
      });
      recorded += 1;
    }

    return recorded;
  }

  /**
   * Proposes the people who will sign, from the client's Karbon contacts.
   *
   * The same contacts already reach the printed letter — `recordKarbonValues`
   * above writes them into `signer.officer_name`, `taxpayer1.email` and the
   * rest. What was missing was the other half: those people existed as *words
   * in a document* and not as anybody the application could actually send it
   * to. An engagement therefore reached final approval and then had nowhere to
   * go, because `evaluateSendGate` refuses an engagement with no signers and
   * nothing in the application could name one.
   *
   * Three rules make re-running preparation safe:
   *
   *   - **A confirmed signer is never touched.** Confirmation is a person
   *     vouching for where a client's engagement letter will be sent; a later
   *     sync must not quietly replace the address they approved.
   *   - **Proposals are unconfirmed.** Karbon's contact list is evidence about
   *     who to write to, not authority to write to them.
   *   - **A contact with no email is still proposed.** The name is usually
   *     right and the address is the bit that needs a person; proposing the
   *     name and leaving the address blank is more useful than proposing
   *     nothing, and the gate still refuses to send.
   */
  private async proposeSigners(engagement: {
    id: string;
    engagementType: EngagementType;
    client: { contacts: { id: string; fullLegalName: string; email: string | null; title: string | null; isPrimary: boolean }[] };
  }): Promise<number> {
    const contacts = [...engagement.client.contacts].sort(
      (a, b) => Number(b.isPrimary) - Number(a.isPrimary),
    );

    const proposals: { role: ParticipantRole; contact: (typeof contacts)[number] | undefined }[] =
      engagement.engagementType === 'T1_JOINT'
        ? [
            { role: 'TAXPAYER_1', contact: contacts[0] },
            { role: 'TAXPAYER_2', contact: contacts[1] },
          ]
        : engagement.engagementType === 'T1_SINGLE'
          ? [{ role: 'TAXPAYER_1', contact: contacts[0] }]
          : engagement.engagementType === 'T3'
            ? [{ role: 'AUTHORIZED_REPRESENTATIVE', contact: contacts[0] }]
            : [{ role: 'AUTHORIZED_SIGNING_OFFICER', contact: contacts[0] }];

    let proposed = 0;

    for (const proposal of proposals) {
      if (!proposal.contact) continue;

      const existing = await this.deps.prisma.engagementParticipant.findUnique({
        where: { engagementId_role: { engagementId: engagement.id, role: proposal.role } },
        select: { id: true, contactConfirmed: true },
      });

      if (existing?.contactConfirmed) continue;

      const data = {
        clientContactId: proposal.contact.id,
        fullLegalName: proposal.contact.fullLegalName,
        email: proposal.contact.email,
        title: proposal.contact.title,
        isSigner: true,
        signingOrder: CLIENT_SIGNING_ORDER,
        contactConfirmed: false,
      };

      if (existing) {
        await this.deps.prisma.engagementParticipant.update({ where: { id: existing.id }, data });
      } else {
        await this.deps.prisma.engagementParticipant.create({
          data: { ...data, engagementId: engagement.id, role: proposal.role },
        });
      }

      proposed += 1;
    }

    proposed += await this.proposeFirmSigner(engagement.id);
    return proposed;
  }

  /**
   * Names the person who signs on the firm's behalf, before the client does.
   *
   * Read from a setting so it is decided once rather than on every engagement,
   * and overridable on an individual one — the partner who owns a client is not
   * always the person who signs for the firm.
   */
  private async proposeFirmSigner(engagementId: string): Promise<number> {
    const existing = await this.deps.prisma.engagementParticipant.findUnique({
      where: { engagementId_role: { engagementId, role: 'FIRM_SIGNER' } },
      select: { id: true, contactConfirmed: true },
    });

    if (existing?.contactConfirmed) return 0;

    const configured = await this.deps.prisma.systemSetting.findUnique({
      where: { key: 'firm_signer_user_id' },
      select: { value: true },
    });

    const userId = typeof configured?.value === 'string' ? configured.value : null;
    if (!userId) return 0;

    const user = await this.deps.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true, email: true },
    });

    // A setting pointing at a user who has since been removed is a
    // configuration problem, not a reason to invent a signer.
    if (!user) {
      this.deps.logger.warn('The configured firm signer no longer exists', { engagementId, userId });
      return 0;
    }

    const data = {
      fullLegalName: user.displayName,
      email: user.email,
      isSigner: true,
      // Order 1: the firm signs before the letter reaches the client.
      signingOrder: FIRM_SIGNING_ORDER,
      contactConfirmed: false,
    };

    if (existing) {
      await this.deps.prisma.engagementParticipant.update({ where: { id: existing.id }, data });
    } else {
      await this.deps.prisma.engagementParticipant.create({
        data: { ...data, engagementId, role: 'FIRM_SIGNER' },
      });
    }

    return 1;
  }

  /** Mirrors `ParticipantService.outstanding`, without a circular dependency. */
  private async outstandingSigners(engagementId: string, engagementType: EngagementType): Promise<string[]> {
    const participants = await this.deps.prisma.engagementParticipant.findMany({
      where: { engagementId },
      select: { role: true, email: true, contactConfirmed: true, fullLegalName: true },
    });

    const byRole = new Set(participants.map((participant) => participant.role));
    const notes: string[] = [];

    for (const role of REQUIRED_CLIENT_ROLES[engagementType]) {
      if (!byRole.has(role)) notes.push(`No ${describeRole(role)} has been named.`);
    }
    if (!byRole.has('FIRM_SIGNER')) {
      notes.push('No firm signer has been named, so nobody signs before this goes to the client.');
    }

    for (const participant of participants) {
      if (!isSigningRole(participant.role)) continue;
      if (!participant.email) notes.push(`${participant.fullLegalName} has no email address.`);
      else if (!participant.contactConfirmed) notes.push(`${participant.fullLegalName} has not been confirmed.`);
    }

    return notes;
  }

  /**
   * Raises a conflict for every token whose sources disagree.
   *
   * The current Karbon value is *recommended* because it is the highest-priority
   * source, but nothing is chosen automatically — a reviewer confirms, and the
   * value and its source are recorded.
   */
  private async reconcile(engagementId: string, actorId: string, correlationId: string): Promise<number> {
    const fields = await this.deps.prisma.extractedField.findMany({
      where: { engagementId, coverLetterPackageId: null },
    });

    const byToken = new Map<string, typeof fields>();
    for (const field of fields) {
      // A fact is a reviewer's answer, not a competing observation.
      if (field.token.startsWith(FACT_TOKEN_PREFIX)) continue;
      const bucket = byToken.get(field.token) ?? [];
      bucket.push(field);
      byToken.set(field.token, bucket);
    }

    let raised = 0;

    for (const [token, candidates] of byToken) {
      const withValues = candidates.filter((field) => this.displayValue(field) !== null);
      if (withValues.length < 2) continue;

      const distinct = new Set(withValues.map((field) => this.displayValue(field) as string));
      const agree = [...distinct].every((value) => valuesAgree(value, [...distinct][0] as string));
      if (distinct.size < 2 || agree) {
        // They agree; clear any stale unresolved conflict for this token.
        await this.deps.prisma.fieldConflict.deleteMany({ where: { engagementId, token, status: 'UNRESOLVED' } });
        continue;
      }

      const ranked = [...withValues].sort((a, b) => sourceRank(a.source) - sourceRank(b.source));
      const recommended = ranked[0];
      if (!recommended) continue;

      const payload = ranked.map((field) => ({
        value: this.displayValue(field),
        source: field.source,
        confidence: field.confidence,
      }));

      const existing = await this.deps.prisma.fieldConflict.findFirst({
        where: { engagementId, token, status: 'UNRESOLVED' },
      });

      // A conflict a person already resolved is left alone — but their decision
      // applies to the values it was made about. If a source has since changed,
      // the decision no longer covers what is on the table, so the question is
      // asked again rather than a stale answer being applied silently.
      const resolved = await this.deps.prisma.fieldConflict.findFirst({
        where: { engagementId, token, status: { in: ['RESOLVED', 'ACCEPTED_AS_IS'] } },
      });

      if (resolved) {
        const decidedAbout = new Set(
          (Array.isArray(resolved.candidates) ? (resolved.candidates as { value?: unknown }[]) : [])
            .map((candidate) => String(candidate.value ?? '')),
        );
        const onTheTable = new Set(payload.map((candidate) => String(candidate.value ?? '')));
        const unchanged =
          decidedAbout.size === onTheTable.size && [...onTheTable].every((value) => decidedAbout.has(value));

        if (unchanged) continue;

        await this.deps.prisma.fieldConflict.update({
          where: { id: resolved.id },
          data: {
            status: 'UNRESOLVED',
            candidates: payload as unknown as Prisma.InputJsonValue,
            recommendedValue: this.displayValue(recommended),
            recommendedSource: recommended.source,
          },
        });

        await this.deps.audit.record({
          eventType: 'CONFLICT_RESOLVED',
          objectType: 'FieldConflict',
          objectId: resolved.id,
          engagementId,
          userId: actorId,
          correlationId,
          reason: 'A source changed after this conflict was resolved, so the decision no longer applies.',
          beforeValue: { resolvedValue: resolved.resolvedValue, resolvedSource: resolved.resolvedSource },
          afterValue: { candidates: payload },
        });

        raised += 1;
        continue;
      }

      if (existing) {
        await this.deps.prisma.fieldConflict.update({
          where: { id: existing.id },
          data: {
            candidates: payload as unknown as Prisma.InputJsonValue,
            recommendedValue: this.displayValue(recommended),
            recommendedSource: recommended.source,
          },
        });
      } else {
        await this.deps.prisma.fieldConflict.create({
          data: {
            engagementId,
            token,
            extractedFieldId: recommended.id,
            candidates: payload as unknown as Prisma.InputJsonValue,
            recommendedValue: this.displayValue(recommended),
            recommendedSource: recommended.source,
            status: 'UNRESOLVED',
          },
        });
        raised += 1;
      }
    }

    if (raised > 0) {
      await this.deps.audit.record({
        eventType: 'CONFLICT_RESOLVED',
        objectType: 'Engagement',
        objectId: engagementId,
        engagementId,
        userId: actorId,
        correlationId,
        reason: `${raised} conflicting value(s) require a reviewer decision.`,
        afterValue: { conflictsRaised: raised },
      });
    }

    return raised;
  }

  private displayValue(field: {
    value: string | null;
    valueDecimal: Prisma.Decimal | null;
    valueDate: Date | null;
    manualOverrideValue: string | null;
  }): string | null {
    if (field.manualOverrideValue) return field.manualOverrideValue;
    if (field.value) return field.value;
    if (field.valueDecimal) return field.valueDecimal.toString();
    if (field.valueDate) return field.valueDate.toISOString().slice(0, 10);
    return null;
  }

  /**
   * Seeds one selection per checkbox the template declares.
   *
   * The prior year is carried forward as `priorYearSelected` only — a
   * suggestion. `isSelected` starts from the template default, and `confirmed`
   * stays false until a reviewer says so.
   */
  private async seedServiceSelections(engagementId: string, manifest: TemplateManifest): Promise<number> {
    const priorYear = await this.deps.prisma.extractedField.findMany({
      where: { engagementId, coverLetterPackageId: null, token: { startsWith: 'service.' } },
    });

    const priorByCode = new Map(
      priorYear.map((field) => [field.token.slice('service.'.length), field.valueBoolean]),
    );

    let seeded = 0;

    for (const [index, checkbox] of manifest.checkboxes.entries()) {
      const priorSelected = priorByCode.get(checkbox.code) ?? null;
      const existing = await this.deps.prisma.serviceSelection.findUnique({
        where: { engagementId_serviceCode: { engagementId, serviceCode: checkbox.code } },
      });

      if (existing?.confirmed) {
        // A confirmed selection is a decision; only refresh the suggestion.
        await this.deps.prisma.serviceSelection.update({
          where: { id: existing.id },
          data: { priorYearSelected: priorSelected },
        });
        continue;
      }

      await this.deps.prisma.serviceSelection.upsert({
        where: { engagementId_serviceCode: { engagementId, serviceCode: checkbox.code } },
        create: {
          engagementId,
          serviceCode: checkbox.code,
          label: checkbox.label,
          // A box the template always ships ticked is not a choice.
          isSelected: checkbox.alwaysChecked ? true : (priorSelected ?? checkbox.defaultChecked),
          priorYearSelected: priorSelected,
          confirmed: checkbox.alwaysChecked,
          displayOrder: index,
        },
        update: {
          label: checkbox.label,
          priorYearSelected: priorSelected,
          displayOrder: index,
        },
      });
      seeded += 1;
    }

    return seeded;
  }

  /**
   * Evaluates the date rules in dependency order, feeding each result forward.
   * A rule whose inputs are unknown produces a blocked date, never a guess.
   */
  private async calculateDates(engagement: {
    id: string;
    engagementType: EngagementType;
    taxYear: number;
    yearEnd: Date | null;
  }): Promise<{ calculated: number; blocked: string[] }> {
    const facts = await this.deps.prisma.extractedField.findMany({
      where: { engagementId: engagement.id, token: { startsWith: FACT_TOKEN_PREFIX } },
    });

    const factMap: Record<string, boolean | null> = {};
    for (const fact of facts) {
      factMap[fact.token.slice(FACT_TOKEN_PREFIX.length)] = fact.valueBoolean;
    }

    const inputs: DateRuleInputs = {
      yearEnd: engagement.yearEnd,
      taxYear: engagement.taxYear,
      dateSent: new Date(),
      facts: factMap,
    };

    const plan = DATE_PLAN[engagement.engagementType] ?? [];
    const rules = await this.deps.prisma.dateRule.findMany({
      where: { code: { in: plan.map((entry) => entry.ruleCode) }, isActive: true },
    });
    const ruleByCode = new Map(rules.map((rule) => [rule.code, rule]));

    let calculated = 0;
    const blocked: string[] = [];

    // The date the letter is issued is a proposal a reviewer confirms.
    await this.putDate(engagement.id, {
      token: 'dates.sent',
      ruleCode: null,
      dateRuleId: null,
      result: new Date(),
      assumptions: ['Proposed as today; confirm the date the letter is actually issued.'],
      requiresConfirmation: true,
      isBlocked: false,
      blockedReason: null,
    });
    calculated += 1;

    for (const entry of plan) {
      const rule = ruleByCode.get(entry.ruleCode);
      if (!rule) continue;

      const outcome = evaluateDateRule(rule.code, rule.definition, inputs);

      await this.putDate(engagement.id, {
        token: entry.token,
        ruleCode: rule.code,
        dateRuleId: rule.id,
        result: outcome.result,
        inputDate: outcome.inputDate,
        assumptions: outcome.isBlocked
          ? [outcome.blockedReason ?? 'This deadline cannot be calculated yet.']
          : outcome.assumptions,
        requiresConfirmation: rule.requiresConfirmation,
        isBlocked: outcome.isBlocked,
        blockedReason: outcome.blockedReason,
      });

      if (outcome.isBlocked) blocked.push(entry.token);
      else calculated += 1;

      // Feed the result forward so a derived rule can use it.
      if (!outcome.result) continue;
      if (entry.token === 'dates.filing_due' || entry.token === 'dates.filing_deadline') {
        inputs.filingDeadline = outcome.result;
      }
      if (entry.token === 'dates.payment_deadline' || entry.token === 'dates.balance_due') {
        inputs.paymentDeadline = outcome.result;
      }
    }

    return { calculated, blocked };
  }

  private async putDate(
    engagementId: string,
    input: {
      token: string;
      ruleCode: string | null;
      dateRuleId: string | null;
      result: Date | null;
      inputDate?: Date | null;
      assumptions: string[];
      requiresConfirmation: boolean;
      isBlocked: boolean;
      blockedReason: string | null;
    },
  ): Promise<void> {
    const existing = await this.deps.prisma.calculatedDate.findUnique({
      where: { engagementId_token: { engagementId, token: input.token } },
    });

    // A confirmed or manually overridden date is a decision; leave it alone.
    if (existing && (existing.confirmedAt !== null || existing.manualOverride !== null)) return;

    const data = {
      dateRuleId: input.dateRuleId,
      ruleCode: input.ruleCode,
      inputDate: input.inputDate ?? null,
      result: input.result,
      assumptions: input.assumptions as unknown as Prisma.InputJsonValue,
      requiresConfirmation: input.requiresConfirmation,
      isBlocked: input.isBlocked,
      blockedReason: input.blockedReason,
    };

    if (existing) {
      await this.deps.prisma.calculatedDate.update({ where: { id: existing.id }, data });
      return;
    }

    await this.deps.prisma.calculatedDate.create({
      data: { engagementId, token: input.token, source: 'CALCULATED', ...data },
    });
  }

  /**
   * Calculates every fee the engagement needs, taking the prior-year amount
   * from the extracted values. A fee with no prior-year amount comes back
   * blocked rather than guessed.
   */
  private async calculateFees(
    engagement: { id: string; engagementType: EngagementType; compilationSelected: boolean | null },
    input: PrepareInput,
  ): Promise<{ calculated: FeeKind[]; blocked: FeeKind[] }> {
    const feeKinds = feeKindsFor(engagement.engagementType, engagement.compilationSelected);

    const fields = await this.deps.prisma.extractedField.findMany({
      where: {
        engagementId: engagement.id,
        coverLetterPackageId: null,
        token: { in: Object.values(FEE_TOKEN_BY_KIND) },
      },
    });

    const previousFees: Parameters<PricingService['calculate']>[0]['previousFees'] = {};
    const conflictingPreviousFees: Record<string, string> = {};

    for (const feeKind of feeKinds) {
      const token = FEE_TOKEN_BY_KIND[feeKind];
      const candidates = fields
        .filter((field) => field.token === token)
        .map((field) => ({ field, amount: this.parseAmount(this.displayValue(field)) }))
        .filter((entry) => entry.amount !== null);

      const chosen = candidates.sort((a, b) => sourceRank(a.field.source) - sourceRank(b.field.source))[0];

      previousFees[feeKind] = {
        amount: chosen?.amount ?? null,
        source: chosen?.field.source ?? 'PRIOR_YEAR_DOCUMENT',
        evidence: chosen ? `${token} from ${chosen.field.source}` : null,
      };

      const disagreeing = candidates.find((entry) => entry.amount !== chosen?.amount);
      if (disagreeing?.amount) conflictingPreviousFees[feeKind] = disagreeing.amount;
    }

    // A compilation prior-year fee is a useful signal even when compilation is
    // not selected this year, because the pricing engine warns on the change.
    const priorCompilation = fields.find((field) => field.token === FEE_TOKEN_BY_KIND.CSRS_4200_COMPILATION);

    const results = await this.deps.pricing.calculate({
      engagementId: engagement.id,
      feeKinds,
      previousFees,
      conflictingPreviousFees,
      compilation: {
        priorYearSelected: priorCompilation ? true : null,
        currentSelected: engagement.compilationSelected,
      },
      highIncreaseThresholdPercent: input.highIncreaseThresholdPercent,
      actorId: input.actorId,
    });

    const calculated: FeeKind[] = [];
    const blocked: FeeKind[] = [];

    for (const feeKind of feeKinds) {
      const result = results[feeKind];
      if (!result) continue;
      if (result.isBlocked) blocked.push(feeKind);
      else calculated.push(feeKind);
    }

    return { calculated, blocked };
  }

  private parseAmount(raw: string | null): string | null {
    if (!raw) return null;
    try {
      const amount = money(raw);
      return amount.isNegative() ? null : amount.toFixed(2);
    } catch {
      return null;
    }
  }
}
