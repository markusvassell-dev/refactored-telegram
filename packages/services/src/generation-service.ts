import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Prisma, type PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import {
  formatFieldValue,
  parseManifest,
  renderDocx,
  requiredFieldTokens,
  validateRenderedDocument,
  type PdfConverter,
  type TemplateManifest,
  type ValidationReport,
} from '@element/documents';
import {
  AppError,
  NotFoundError,
  PreconditionError,
  buildFileName,
  type DocumentType,
  type Logger,
} from '@element/shared';
import { evaluateGenerationGate, type GateResult } from '@element/workflows';
import { resolveFieldValue } from './field-values.js';
import type { DocumentStore } from './storage.js';
import type { WorkflowService } from './workflow-service.js';

/**
 * Document generation.
 *
 * The approved master template supplies every word of legal text. This service
 * only decides which structured values go into it, which conditional sections
 * apply, and which checkboxes are ticked — and it refuses to run at all until
 * the generation gate is satisfied.
 */

export interface GenerationServiceDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  store: DocumentStore;
  pdfConverter: PdfConverter;
  workflow: WorkflowService;
  logger: Logger;
  /** Directory holding the normalised templates. */
  templateDirectory: string;
}

export interface GenerateInput {
  engagementId: string;
  documentType: DocumentType;
  actorId: string;
  correlationId: string;
  testMode: boolean;
  /** Set when regenerating after changes were requested. */
  supersedesVersionId?: string | null;
}

export interface GenerateResult {
  documentVersionId: string;
  versionNumber: number;
  validation: ValidationReport;
  docxReference: string;
  pdfReference: string;
  pageCount: number | null;
  removedSections: string[];
}

export class GenerationService {
  constructor(private readonly deps: GenerationServiceDeps) {}

  /** Loads the active template version and its manifest. */
  private async activeTemplate(documentType: DocumentType): Promise<{
    templateVersionId: string;
    manifest: TemplateManifest;
    docx: Buffer;
  }> {
    const template = await this.deps.prisma.documentTemplate.findUnique({
      where: { documentType },
      include: {
        versions: {
          where: { status: 'ACTIVE' },
          orderBy: { versionNumber: 'desc' },
          take: 1,
        },
      },
    });

    if (!template || !template.isProductionSupported) {
      throw new PreconditionError(
        `There is no approved master template for ${documentType}. An administrator must upload and activate one before this document can be generated.`,
      );
    }

    const version = template.versions[0];
    if (!version) {
      throw new PreconditionError(`No active template version exists for ${documentType}.`);
    }

    const manifest = parseManifest(version.manifest);
    const path = version.normalizedPath
      ? version.normalizedPath
      : join(this.deps.templateDirectory, manifest.sourceFileName);

    const docx = await readFile(path).catch(() => {
      throw new AppError(`The normalised template file for ${documentType} could not be read.`, {
        category: 'INTERNAL',
        userMessage: 'The approved template file is missing on the server. An administrator has been notified.',
      });
    });

    return { templateVersionId: version.id, manifest, docx };
  }

  /**
   * Builds the token values for a render from the engagement's confirmed data.
   * Only fields the manifest declares are ever written.
   */
  async buildValues(engagementId: string, manifest: TemplateManifest): Promise<{
    values: Record<string, string>;
    selections: Record<string, boolean>;
    includedSections: string[];
  }> {
    const [fields, services, dates, fees, conflicts, engagement] = await Promise.all([
      this.deps.prisma.extractedField.findMany({ where: { engagementId, coverLetterPackageId: null } }),
      this.deps.prisma.serviceSelection.findMany({ where: { engagementId } }),
      this.deps.prisma.calculatedDate.findMany({ where: { engagementId } }),
      this.deps.prisma.feeCalculation.findMany({ where: { engagementId } }),
      this.deps.prisma.fieldConflict.findMany({ where: { engagementId } }),
      this.deps.prisma.engagement.findUniqueOrThrow({
        where: { id: engagementId },
        select: { compilationSelected: true, taxYear: true },
      }),
    ]);

    const values: Record<string, string> = {};
    const byToken = new Map(manifest.fields.map((field) => [field.token, field]));

    // 1. Field values. A token often has several rows — Karbon's, last year's,
    //    a reviewer's — so one shared rule decides which is effective, rather
    //    than whichever row came back last. `resolveFieldValue` is the same
    //    function the review UI uses, so the document gets what the reviewer saw.
    const conflictByToken = new Map(conflicts.map((conflict) => [conflict.token, conflict]));
    const rowsByToken = new Map<string, typeof fields>();
    for (const field of fields) {
      if (!byToken.has(field.token)) continue;
      const bucket = rowsByToken.get(field.token) ?? [];
      bucket.push(field);
      rowsByToken.set(field.token, bucket);
    }

    for (const [token, rows] of rowsByToken) {
      const definition = byToken.get(token);
      if (!definition) continue;

      const resolved = resolveFieldValue(
        rows.map((row) => ({
          value:
            (row.valueDecimal ? row.valueDecimal.toString() : null) ??
            (row.valueDate ? row.valueDate.toISOString().slice(0, 10) : null) ??
            row.value,
          source: row.source,
          manualOverrideValue: row.manualOverrideValue,
          manuallyConfirmed: row.manuallyConfirmed,
        })),
        conflictByToken.get(token) ?? null,
      );

      if (resolved) values[token] = formatFieldValue(resolved.value, { dataType: definition.dataType });
    }

    // 2. Calculated dates.
    for (const date of dates) {
      const definition = byToken.get(date.token);
      if (!definition) continue;
      const effective = date.manualOverride ?? date.result;
      if (!effective) continue;
      values[date.token] = formatFieldValue(effective, { dataType: 'DATE' });
    }

    // 3. Fees.
    const feeTokenByKind: Record<string, string> = {
      T1_PREPARATION: 'pricing.t1_fee',
      T2_PREPARATION: 'pricing.t2_fee',
      T3_PREPARATION: 'pricing.t3_fee',
      CSRS_4200_COMPILATION: 'pricing.compilation_fee',
    };

    for (const fee of fees) {
      const token = feeTokenByKind[fee.feeKind];
      if (!token || !byToken.has(token)) continue;
      if (fee.roundedFee) values[token] = formatFieldValue(fee.roundedFee.toString(), { dataType: 'MONEY' });
    }

    // 4. Tax year, which several templates print directly.
    if (byToken.has('engagement.tax_year')) {
      values['engagement.tax_year'] ??= String(engagement.taxYear);
    }

    // 5. Service selections and conditional sections.
    const selections: Record<string, boolean> = {};
    for (const service of services) selections[service.serviceCode] = service.isSelected;

    const includedSections: string[] = [];
    for (const section of manifest.conditionalSections) {
      const selected = selections[section.controlledBy] === true;
      if (selected) includedSections.push(section.key);
    }

    // The compilation section is driven by the reviewer's explicit confirmation,
    // never by the prior year's selection.
    if (manifest.conditionalSections.some((section) => section.key === 'csrs_4200')) {
      const confirmed = engagement.compilationSelected === true;
      selections['t2.csrs4200'] = confirmed;
      const index = includedSections.indexOf('csrs_4200');
      if (confirmed && index === -1) includedSections.push('csrs_4200');
      if (!confirmed && index !== -1) includedSections.splice(index, 1);
      if (!confirmed && byToken.has('pricing.compilation_fee')) {
        values['pricing.compilation_fee'] = 'Not applicable';
      }
    }

    return { values, selections, includedSections };
  }

  /** Evaluates whether generation may proceed at all. */
  async evaluateGate(engagementId: string, documentType: DocumentType): Promise<GateResult> {
    const [template, engagement, fees, conflicts] = await Promise.all([
      this.deps.prisma.documentTemplate.findUnique({
        where: { documentType },
        include: { versions: { where: { status: 'ACTIVE' }, take: 1 } },
      }),
      this.deps.prisma.engagement.findUniqueOrThrow({
        where: { id: engagementId },
        select: { compilationSelected: true, engagementType: true },
      }),
      this.deps.prisma.feeCalculation.findMany({ where: { engagementId, isBlocked: true } }),
      this.deps.prisma.fieldConflict.count({ where: { engagementId, status: 'UNRESOLVED' } }),
    ]);

    let missingRequiredFields: string[] = [];
    if (template?.versions[0]) {
      const manifest = parseManifest(template.versions[0].manifest);
      const built = await this.buildValues(engagementId, manifest);
      missingRequiredFields = requiredFieldTokens(manifest, built.includedSections).filter(
        (token) => !built.values[token] || built.values[token]?.trim() === '',
      );
    }

    return evaluateGenerationGate({
      documentTypeIsProductionSupported: template?.isProductionSupported === true,
      hasActiveTemplateVersion: Boolean(template?.versions[0]),
      compilationSelected: engagement.compilationSelected,
      requiresCompilationConfirmation: engagement.engagementType === 'T2',
      blockedFeeKinds: fees.map((fee) => fee.feeKind),
      unresolvedConflicts: conflicts,
      missingRequiredFields,
    });
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const engagement = await this.deps.prisma.engagement.findUnique({
      where: { id: input.engagementId },
      include: { client: true },
    });
    if (!engagement) throw new NotFoundError('Engagement');

    const gate = await this.evaluateGate(input.engagementId, input.documentType);
    if (!gate.ok) {
      throw new PreconditionError(`This document cannot be generated yet: ${gate.blockers.join(' ')}`, {
        blockers: gate.blockers,
      });
    }

    const { templateVersionId, manifest, docx: templateDocx } = await this.activeTemplate(input.documentType);
    const { values, selections, includedSections } = await this.buildValues(input.engagementId, manifest);

    // Approved wording exceptions are applied; unapproved ones never are.
    const approvedExceptions = await this.deps.prisma.wordingException.findMany({
      where: { engagementId: input.engagementId, approvedAt: { not: null }, rejectedAt: null },
      select: { sectionAnchor: true, revisedWording: true },
    });

    const rendered = await renderDocx(templateDocx, {
      manifest,
      values,
      selections,
      includedSections,
      mode: 'DRAFT',
      wordingExceptions: approvedExceptions,
    });

    const pdf = await this.deps.pdfConverter.convert(rendered.docx);

    const [unconfirmedDates, unconfirmedFees] = await Promise.all([
      this.deps.prisma.calculatedDate.findMany({
        where: { engagementId: input.engagementId, requiresConfirmation: true, confirmedAt: null },
        select: { token: true },
      }),
      this.deps.prisma.feeCalculation.findMany({
        where: { engagementId: input.engagementId, requiresApprovalType: { not: null }, approvedAt: null },
        select: { feeKind: true },
      }),
    ]);

    const validation = await validateRenderedDocument({
      docx: rendered.docx,
      manifest,
      requiredTokens: requiredFieldTokens(manifest, includedSections),
      values,
      pdfPageCount: pdf.pageCount,
      pdfConverted: true,
      unconfirmedDates: unconfirmedDates.map((row) => row.token),
      unconfirmedFees: unconfirmedFees.map((row) => row.feeKind),
      expectedClientName: engagement.client.legalName,
      expectedYearText: String(engagement.taxYear),
    });

    // Store the working copies.
    const baseName = buildFileName({
      year: engagement.taxYear,
      documentType: input.documentType,
      clientLegalName: engagement.client.legalName,
      role: 'DRAFT_DOCX',
      testMode: input.testMode,
    });

    const scope = input.engagementId.replace(/-/g, '');
    const storedDocx = await this.deps.store.put({
      content: rendered.docx,
      fileName: baseName,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      scope,
    });
    const storedPdf = await this.deps.store.put({
      content: pdf.pdf,
      fileName: baseName.replace(/\.docx$/, '.pdf'),
      mimeType: 'application/pdf',
      scope,
    });

    // A new version is always created; an existing one is never rewritten.
    const previous = await this.deps.prisma.documentVersion.findFirst({
      where: { engagementId: input.engagementId, documentType: input.documentType },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, versionNumber: true },
    });

    const versionNumber = (previous?.versionNumber ?? 0) + 1;

    const documentVersion = await this.deps.prisma.documentVersion.create({
      data: {
        engagementId: input.engagementId,
        documentType: input.documentType,
        versionNumber,
        status: 'DRAFT',
        templateVersionId,
        sourceFileHash: manifest.normalizedFileHash ?? manifest.sourceFileHash,
        generatedDocxReference: storedDocx.reference,
        generatedPdfReference: storedPdf.reference,
        docxHash: storedDocx.hash,
        pdfHash: storedPdf.hash,
        pageCount: pdf.pageCount,
        renderedFieldValues: { values, selections, includedSections } as unknown as Prisma.InputJsonValue,
        validationReport: validation as unknown as Prisma.InputJsonValue,
        changeSummary:
          rendered.removedSections.length > 0
            ? `Removed sections: ${rendered.removedSections.join(', ')}`
            : null,
        createdBy: input.actorId,
      },
    });

    if (previous) {
      await this.deps.prisma.documentVersion.updateMany({
        where: { id: previous.id, status: { in: ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED'] } },
        data: { status: 'SUPERSEDED', supersededAt: new Date() },
      });
    }

    await this.deps.audit.record({
      eventType: 'GENERATION_REQUESTED',
      objectType: 'DocumentVersion',
      objectId: documentVersion.id,
      engagementId: input.engagementId,
      userId: input.actorId,
      correlationId: input.correlationId,
      afterValue: {
        documentType: input.documentType,
        versionNumber,
        templateVersionId,
        removedSections: rendered.removedSections,
        validationErrors: validation.errorCount,
        docxHash: storedDocx.hash,
        pdfHash: storedPdf.hash,
        testMode: input.testMode,
      },
    });

    this.deps.logger.info('Generated document version', {
      engagementId: input.engagementId,
      documentVersionId: documentVersion.id,
      versionNumber,
      validationErrors: validation.errorCount,
    });

    return {
      documentVersionId: documentVersion.id,
      versionNumber,
      validation,
      docxReference: storedDocx.reference,
      pdfReference: storedPdf.reference,
      pageCount: pdf.pageCount,
      removedSections: rendered.removedSections,
    };
  }
}
