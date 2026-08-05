import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Prisma, type PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import {
  COMPILATION_ENCLOSURE_RULES,
  formatFieldValue,
  parseManifest,
  renderDocx,
  requiredFieldTokens,
  validateRenderedDocument,
  type PdfConverter,
  type TemplateManifest,
} from '@element/documents';
import {
  NotFoundError,
  PreconditionError,
  assertCan,
  assertSeparationOfDuties,
  buildFileName,
  coverLetterIdempotencyKey,
  sourceDocumentFingerprint,
  type DocumentType,
  type Logger,
  type Principal,
} from '@element/shared';
import {
  evaluateCoverLetterDeliveryGate,
  evaluateCoverLetterTriggerGate,
  type GateResult,
} from '@element/workflows';
import type { DocumentStore } from './storage.js';
import type { WorkflowService } from './workflow-service.js';

/**
 * Completion cover letters.
 *
 * Three conditions must all hold before one is generated, the enclosure list is
 * built only from documents actually present and selected, every extracted
 * value carries its source evidence, and a person must review and approve
 * before anything is marked ready for delivery. There is no automatic-approval
 * path.
 */

export interface CoverLetterDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  store: DocumentStore;
  pdfConverter: PdfConverter;
  workflow: WorkflowService;
  logger: Logger;
  templateDirectory: string;
}

/** Source document kinds a compilation cover letter needs before it can run. */
export const REQUIRED_COMPILATION_SOURCES = [
  'FINAL_T2_RETURN',
  'COMPILED_FINANCIAL_STATEMENTS',
  'COMPILATION_ENGAGEMENT_REPORT',
] as const;

export class CoverLetterService {
  constructor(private readonly deps: CoverLetterDeps) {}

  /**
   * Chooses the cover-letter template for an engagement.
   *
   * A T2 engagement without compilation must NOT borrow the compilation cover
   * letter. If no approved non-compilation template exists the workflow is
   * blocked and says so.
   */
  async resolveDocumentType(engagementId: string): Promise<{ documentType: DocumentType | null; blockedReason: string | null }> {
    const engagement = await this.deps.prisma.engagement.findUniqueOrThrow({
      where: { id: engagementId },
      select: { engagementType: true, compilationSelected: true },
    });

    if (engagement.engagementType === 'T2') {
      if (engagement.compilationSelected === true) {
        return { documentType: 'COMPILATION_COVER_LETTER', blockedReason: null };
      }
      const available = await this.deps.prisma.documentTemplate.findUnique({
        where: { documentType: 'T2_COVER_LETTER' },
      });
      if (available?.isProductionSupported) {
        return { documentType: 'T2_COVER_LETTER', blockedReason: null };
      }
      return {
        documentType: null,
        blockedReason:
          'This T2 engagement does not include a compilation, and no approved non-compilation T2 cover-letter template exists. An administrator must upload and activate one. The compilation cover letter must not be used.',
      };
    }

    if (engagement.engagementType === 'T1_JOINT' || engagement.engagementType === 'T1_SINGLE') {
      return { documentType: 'T1_COVER_LETTER', blockedReason: null };
    }

    const t3 = await this.deps.prisma.documentTemplate.findUnique({ where: { documentType: 'T3_COVER_LETTER' } });
    if (t3?.isProductionSupported) return { documentType: 'T3_COVER_LETTER', blockedReason: null };

    return {
      documentType: null,
      blockedReason:
        'No approved T3 completion cover-letter template exists. An administrator must upload and activate one.',
    };
  }

  async evaluateTriggerGate(engagementId: string): Promise<GateResult & { documentType: DocumentType | null }> {
    const [engagement, sources, resolution] = await Promise.all([
      this.deps.prisma.engagement.findUniqueOrThrow({
        where: { id: engagementId },
        include: { client: true },
      }),
      this.deps.prisma.sourceDocument.findMany({ where: { engagementId } }),
      this.resolveDocumentType(engagementId),
    ]);

    const selected = sources.filter((source) => source.includedInPackage);
    const presentKinds = new Set(selected.map((source) => source.kind));

    const missingRequired =
      resolution.documentType === 'COMPILATION_COVER_LETTER'
        ? REQUIRED_COMPILATION_SOURCES.filter((kind) => !presentKinds.has(kind))
        : [];

    // The designated internal approval task: the engagement letter workflow
    // must have completed for this engagement.
    const internalApproval = await this.deps.prisma.approval.findFirst({
      where: { engagementId, type: 'FINAL_DOCUMENT', decision: 'APPROVED' },
    });

    const gate = evaluateCoverLetterTriggerGate({
      missingRequiredSourceDocuments: missingRequired,
      internalApprovalTaskComplete: Boolean(internalApproval),
      status: engagement.status,
      hasApprovedCoverLetterTemplate: resolution.documentType !== null,
      clientIdentityMatches: selected.every((source) => (source.verificationScore ?? 1) >= 0.5),
      periodMatches: true,
      allSourceDocumentsFinal: selected.every((source) => source.isFinal),
      anySourceDocumentSuperseded: selected.some((source) => source.supersededById !== null),
      unreadableSourceDocuments: selected.filter((source) => source.pageCount === 0).map((source) => source.fileName),
      missingRequiredAmounts: [],
      missingRequiredDeadlines: [],
    });

    if (resolution.blockedReason) gate.blockers.push(resolution.blockedReason);

    return { ...gate, ok: gate.blockers.length === 0, documentType: resolution.documentType };
  }

  /**
   * Builds the enclosure list.
   *
   * A bullet survives only when the corresponding final document is actually
   * present and selected for delivery. Everything else is removed from the
   * client-facing letter.
   */
  buildEnclosureDecisions(selectedKinds: ReadonlySet<string>): {
    included: { code: string; label: string }[];
    removeAnchors: string[];
  } {
    const included: { code: string; label: string }[] = [];
    const removeAnchors: string[] = [];

    for (const rule of COMPILATION_ENCLOSURE_RULES) {
      // A rule with no required kinds (the engagement letter) is opt-in only.
      const present =
        rule.requiredSourceKinds.length > 0 && rule.requiredSourceKinds.some((kind) => selectedKinds.has(kind));

      if (present) included.push({ code: rule.code, label: rule.label });
      else removeAnchors.push(rule.anchorText);
    }

    return { included, removeAnchors };
  }

  async generate(input: {
    engagementId: string;
    actor: Principal;
    correlationId: string;
    testMode: boolean;
    /** Set for per-taxpayer T1 cover letters. */
    participantId?: string | null;
  }): Promise<{ coverLetterPackageId: string; documentVersionId: string; enclosures: { code: string; label: string }[] }> {
    assertCan(input.actor, 'generation:start');

    const gate = await this.evaluateTriggerGate(input.engagementId);
    if (!gate.ok || !gate.documentType) {
      throw new PreconditionError(`This cover letter cannot be generated yet: ${gate.blockers.join(' ')}`, {
        blockers: gate.blockers,
      });
    }

    const documentType = gate.documentType;
    const engagement = await this.deps.prisma.engagement.findUniqueOrThrow({
      where: { id: input.engagementId },
      include: { client: true },
    });

    // Enter the generating state here rather than relying on the caller, so a
    // direct call and the background job follow the same status path.
    const currentStatus = await this.deps.workflow.currentStatus(input.engagementId);
    if (currentStatus !== 'COVER_LETTER_GENERATING') {
      await this.deps.workflow.transition({
        engagementId: input.engagementId,
        to: 'COVER_LETTER_GENERATING',
        userId: input.actor.id,
        reason: 'Generating the completion cover letter',
        correlationId: input.correlationId,
      });
    }

    const sources = await this.deps.prisma.sourceDocument.findMany({
      where: { engagementId: input.engagementId, includedInPackage: true },
    });

    const fingerprint = sourceDocumentFingerprint(
      sources.map((source) => ({ id: source.id, fileHash: source.fileHash })),
    );

    const idempotencyKey = coverLetterIdempotencyKey({
      engagementId: input.engagementId,
      documentType,
      participantId: input.participantId ?? null,
      sourceDocumentFingerprint: fingerprint,
    });

    const template = await this.loadTemplate(documentType);
    const enclosures = this.buildEnclosureDecisions(new Set(sources.map((source) => source.kind)));

    const packageRecord = await this.deps.prisma.coverLetterPackage.upsert({
      where: { idempotencyKey },
      create: {
        engagementId: input.engagementId,
        documentType,
        participantId: input.participantId ?? null,
        status: 'GENERATING',
        idempotencyKey,
        sourceFingerprint: fingerprint,
        enclosures: enclosures.included as never,
      },
      update: { status: 'GENERATING', enclosures: enclosures.included as never, staleReason: null, markedStaleAt: null },
    });

    const values = await this.buildValues(input.engagementId, packageRecord.id, template.manifest);

    // Narrative edits a reviewer has made to this letter. Regenerating must not
    // throw away someone's wording — that is what made the narrative
    // uneditable in practice before there was anywhere to keep it.
    const editedSections = await this.deps.prisma.coverLetterNarrative
      .findMany({
        where: { coverLetterPackageId: packageRecord.id, supersededAt: null },
        select: { sectionKey: true, editedText: true },
      })
      .then((edits) => Object.fromEntries(edits.map((edit) => [edit.sectionKey, edit.editedText])));

    const rendered = await renderDocx(template.docx, {
      manifest: template.manifest,
      values,
      selections: await this.buildSelections(input.engagementId, packageRecord.id),
      includedSections: [],
      mode: 'DRAFT',
      removeBlocksMatching: enclosures.removeAnchors,
      editedSections,
    });

    const pdf = await this.deps.pdfConverter.convert(rendered.docx);

    const validation = await validateRenderedDocument({
      docx: rendered.docx,
      manifest: template.manifest,
      requiredTokens: requiredFieldTokens(template.manifest, []),
      values,
      pdfPageCount: pdf.pageCount,
      pdfConverted: true,
      expectedClientName: engagement.client.legalName,
    });

    const fileName = buildFileName({
      year: engagement.taxYear,
      documentType,
      clientLegalName: engagement.client.legalName,
      role: 'COVER_LETTER_DRAFT_DOCX',
      testMode: input.testMode,
    });

    const scope = input.engagementId.replace(/-/g, '');
    const storedDocx = await this.deps.store.put({
      content: rendered.docx,
      fileName,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      scope,
    });
    const storedPdf = await this.deps.store.put({
      content: pdf.pdf,
      fileName: fileName.replace(/\.docx$/, '.pdf'),
      mimeType: 'application/pdf',
      scope,
    });

    const previous = await this.deps.prisma.documentVersion.findFirst({
      where: { engagementId: input.engagementId, documentType },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });

    const documentVersion = await this.deps.prisma.documentVersion.create({
      data: {
        engagementId: input.engagementId,
        coverLetterPackageId: packageRecord.id,
        documentType,
        versionNumber: (previous?.versionNumber ?? 0) + 1,
        status: 'DRAFT',
        templateVersionId: template.templateVersionId,
        sourceFileHash: fingerprint,
        generatedDocxReference: storedDocx.reference,
        generatedPdfReference: storedPdf.reference,
        docxHash: storedDocx.hash,
        pdfHash: storedPdf.hash,
        pageCount: pdf.pageCount,
        renderedFieldValues: { values, enclosures: enclosures.included } as unknown as Prisma.InputJsonValue,
        validationReport: validation as unknown as Prisma.InputJsonValue,
        createdBy: input.actor.id,
      },
    });

    await this.deps.prisma.coverLetterPackage.update({
      where: { id: packageRecord.id },
      data: { status: 'REVIEW_REQUIRED' },
    });

    await this.deps.workflow.transition({
      engagementId: input.engagementId,
      to: 'COVER_LETTER_REVIEW_REQUIRED',
      userId: input.actor.id,
      reason: 'Cover letter generated and awaiting human review',
      correlationId: input.correlationId,
    });

    await this.deps.audit.record({
      eventType: 'COVER_LETTER_GENERATED',
      objectType: 'CoverLetterPackage',
      objectId: packageRecord.id,
      engagementId: input.engagementId,
      userId: input.actor.id,
      correlationId: input.correlationId,
      afterValue: {
        documentType,
        enclosures: enclosures.included.map((item) => item.code),
        sourceFingerprint: fingerprint,
        validationErrors: validation.errorCount,
      },
    });

    return {
      coverLetterPackageId: packageRecord.id,
      documentVersionId: documentVersion.id,
      enclosures: enclosures.included,
    };
  }

  private async loadTemplate(documentType: DocumentType): Promise<{
    templateVersionId: string;
    manifest: TemplateManifest;
    docx: Buffer;
  }> {
    const template = await this.deps.prisma.documentTemplate.findUnique({
      where: { documentType },
      include: { versions: { where: { status: 'ACTIVE' }, orderBy: { versionNumber: 'desc' }, take: 1 } },
    });

    const version = template?.versions[0];
    if (!template?.isProductionSupported || !version) {
      throw new PreconditionError(`No approved cover-letter template is active for ${documentType}.`);
    }

    const manifest = parseManifest(version.manifest);
    const docx = await readFile(version.normalizedPath ?? join(this.deps.templateDirectory, manifest.sourceFileName));
    return { templateVersionId: version.id, manifest, docx };
  }

  private async buildValues(
    engagementId: string,
    coverLetterPackageId: string,
    manifest: TemplateManifest,
  ): Promise<Record<string, string>> {
    const [fields, dates] = await Promise.all([
      this.deps.prisma.extractedField.findMany({
        where: { engagementId, OR: [{ coverLetterPackageId }, { coverLetterPackageId: null }] },
      }),
      this.deps.prisma.calculatedDate.findMany({ where: { engagementId } }),
    ]);

    const byToken = new Map(manifest.fields.map((field) => [field.token, field]));
    const values: Record<string, string> = {};

    for (const field of fields) {
      const definition = byToken.get(field.token);
      if (!definition) continue;
      const raw =
        field.manualOverrideValue ??
        (field.valueDecimal ? field.valueDecimal.toString() : null) ??
        (field.valueDate ? field.valueDate.toISOString().slice(0, 10) : null) ??
        field.value;
      if (raw === null) continue;
      values[field.token] = formatFieldValue(raw, { dataType: definition.dataType });
    }

    for (const date of dates) {
      if (!byToken.has(date.token)) continue;
      const effective = date.manualOverride ?? date.result;
      if (effective) values[date.token] = formatFieldValue(effective, { dataType: 'DATE' });
    }

    return values;
  }

  private async buildSelections(engagementId: string, coverLetterPackageId: string): Promise<Record<string, boolean>> {
    const rows = await this.deps.prisma.serviceSelection.findMany({ where: { engagementId } });
    const selections: Record<string, boolean> = {};
    for (const row of rows) selections[row.serviceCode] = row.isSelected;

    const record = await this.deps.prisma.coverLetterPackage.findUnique({ where: { id: coverLetterPackageId } });
    for (const enclosure of (record?.enclosures ?? []) as { code: string }[]) {
      selections[enclosure.code] = true;
    }
    return selections;
  }

  /**
   * Stale-source detection.
   *
   * If any selected source document changed after generation, the cover letter
   * is marked STALE, delivery is prevented, and a new approval is required.
   */
  async detectStaleSources(engagementId: string, correlationId?: string): Promise<{ staleCount: number; details: string[] }> {
    const packages = await this.deps.prisma.coverLetterPackage.findMany({
      where: { engagementId, status: { notIn: ['STALE', 'BLOCKED'] } },
    });

    if (packages.length === 0) return { staleCount: 0, details: [] };

    const sources = await this.deps.prisma.sourceDocument.findMany({
      where: { engagementId, includedInPackage: true },
    });
    const currentFingerprint = sourceDocumentFingerprint(
      sources.map((source) => ({ id: source.id, fileHash: source.fileHash })),
    );

    const details: string[] = [];
    let staleCount = 0;

    for (const record of packages) {
      if (record.sourceFingerprint === currentFingerprint) continue;

      staleCount += 1;
      const reason =
        'A source document changed after this cover letter was generated. It must be regenerated and approved again before delivery.';
      details.push(reason);

      await this.deps.prisma.$transaction([
        this.deps.prisma.coverLetterPackage.update({
          where: { id: record.id },
          data: { status: 'STALE', staleReason: reason, markedStaleAt: new Date(), approvedAt: null, approvedByUserId: null },
        }),
        this.deps.prisma.documentVersion.updateMany({
          where: { coverLetterPackageId: record.id, status: { in: ['DRAFT', 'IN_REVIEW', 'APPROVED'] } },
          data: { status: 'STALE' },
        }),
      ]);

      await this.deps.audit.record({
        eventType: 'COVER_LETTER_MARKED_STALE',
        objectType: 'CoverLetterPackage',
        objectId: record.id,
        engagementId,
        correlationId: correlationId ?? null,
        beforeValue: { sourceFingerprint: record.sourceFingerprint },
        afterValue: { sourceFingerprint: currentFingerprint },
        reason,
      });
    }

    if (staleCount > 0) {
      const current = await this.deps.workflow.currentStatus(engagementId);
      if (current !== 'COVER_LETTER_CHANGES_REQUESTED') {
        await this.deps.workflow.transition({
          engagementId,
          to: 'COVER_LETTER_CHANGES_REQUESTED',
          reason: 'A source document changed after the cover letter was generated.',
          correlationId,
        });
      }
    }

    return { staleCount, details };
  }

  /** Approves a cover letter. There is no automatic approval path. */
  async approve(input: {
    coverLetterPackageId: string;
    documentVersionId: string;
    actor: Principal;
    comment?: string;
  }): Promise<void> {
    assertCan(input.actor, 'cover_letter:approve');

    const record = await this.deps.prisma.coverLetterPackage.findUniqueOrThrow({
      where: { id: input.coverLetterPackageId },
    });
    const version = await this.deps.prisma.documentVersion.findUniqueOrThrow({
      where: { id: input.documentVersionId },
    });

    assertSeparationOfDuties({
      approverId: input.actor.id,
      authorId: version.createdBy,
      subject: 'cover letter',
    });

    const unconfirmed = await this.deps.prisma.extractedField.findMany({
      where: { coverLetterPackageId: input.coverLetterPackageId, manuallyConfirmed: false },
      select: { token: true },
    });

    const gate = evaluateCoverLetterDeliveryGate({
      isApproved: true,
      isStale: record.status === 'STALE',
      unconfirmedFields: unconfirmed.map((row) => row.token),
      hasFinalDocx: Boolean(version.generatedDocxReference),
      hasFinalPdf: Boolean(version.generatedPdfReference),
    });

    if (!gate.ok) {
      throw new PreconditionError(`This cover letter cannot be approved yet: ${gate.blockers.join(' ')}`, {
        blockers: gate.blockers,
      });
    }

    const sources = await this.deps.prisma.sourceDocument.findMany({
      where: { engagementId: record.engagementId, includedInPackage: true },
      select: { id: true, fileName: true, fileHash: true },
    });

    await this.deps.prisma.$transaction([
      this.deps.prisma.coverLetterPackage.update({
        where: { id: input.coverLetterPackageId },
        data: { status: 'APPROVED', approvedByUserId: input.actor.id, approvedAt: new Date() },
      }),
      this.deps.prisma.documentVersion.update({
        where: { id: input.documentVersionId },
        data: { status: 'APPROVED', approvedBy: input.actor.id, approvedAt: new Date() },
      }),
      this.deps.prisma.approval.create({
        data: {
          engagementId: record.engagementId,
          coverLetterPackageId: input.coverLetterPackageId,
          documentVersionId: input.documentVersionId,
          type: 'COVER_LETTER',
          decision: 'APPROVED',
          userId: input.actor.id,
          actingRole: 'PARTNER_OR_FINAL_APPROVER',
          comment: input.comment ?? null,
          documentHash: version.pdfHash,
          sourceDocumentVersions: sources as never,
        },
      }),
    ]);

    await this.deps.workflow.transition({
      engagementId: record.engagementId,
      to: 'COVER_LETTER_APPROVED',
      userId: input.actor.id,
      reason: 'Cover letter approved',
    });

    await this.deps.audit.record({
      eventType: 'COVER_LETTER_APPROVED',
      objectType: 'CoverLetterPackage',
      objectId: input.coverLetterPackageId,
      engagementId: record.engagementId,
      userId: input.actor.id,
      afterValue: { documentHash: version.pdfHash, sourceDocuments: sources.map((source) => source.fileHash) },
      reason: input.comment ?? null,
    });
  }

  /** Marks an approved cover letter ready for delivery. Never sent via Adobe Sign. */
  async markReadyForDelivery(input: { coverLetterPackageId: string; actor: Principal }): Promise<void> {
    assertCan(input.actor, 'cover_letter:approve');

    const record = await this.deps.prisma.coverLetterPackage.findUnique({
      where: { id: input.coverLetterPackageId },
    });
    if (!record) throw new NotFoundError('Cover letter package');

    if (record.status !== 'APPROVED') {
      throw new PreconditionError('Only an approved cover letter can be marked ready for delivery.');
    }

    await this.deps.prisma.coverLetterPackage.update({
      where: { id: input.coverLetterPackageId },
      data: { status: 'READY_FOR_DELIVERY', readyForDeliveryAt: new Date() },
    });

    await this.deps.workflow.transition({
      engagementId: record.engagementId,
      to: 'READY_FOR_DELIVERY',
      userId: input.actor.id,
      reason: 'Cover letter ready for delivery',
    });
  }
}
