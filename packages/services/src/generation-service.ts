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
  NotFoundError,
  PreconditionError,
  buildFileName,
  type DocumentType,
  type Logger,
} from '@element/shared';
import { evaluateGenerationGate, type GateResult } from '@element/workflows';
import { resolveEffectiveValues } from './effective-values.js';
import { readTemplateSource } from './template-source.js';
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

    // `normalizedPath` is a filesystem path for a seeded version and a store
    // reference for an uploaded one, so locating the bytes is not a `readFile`.
    const docx = await readTemplateSource(
      { normalizedPath: version.normalizedPath, sourceFileName: manifest.sourceFileName },
      { store: this.deps.store, templateDirectory: this.deps.templateDirectory },
    );

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

    // 1-4. Which value is effective for each token, across all four tables that
    //      can supply one. Shared with the review form so the two cannot drift:
    //      the form previously read only `extracted_field` and reported every
    //      calculated deadline and fee as missing while printing them here.
    const effective = resolveEffectiveValues({
      tokens: byToken.keys(),
      fields,
      conflicts,
      dates,
      fees,
      taxYear: engagement.taxYear,
    });

    for (const [token, resolved] of effective) {
      const definition = byToken.get(token);
      if (!definition) continue;

      // Formatted by *origin*, not by declared type. A calculated date is
      // rendered as a long date whatever the manifest calls the field — the T2
      // manifest declares `dates.target_completion` as STRING, and formatting a
      // date by that would print a raw JavaScript date onto a signed letter.
      const dataType =
        resolved.origin === 'CALCULATED_DATE'
          ? 'DATE'
          : resolved.origin === 'CALCULATED_FEE'
            ? 'MONEY'
            : definition.dataType;

      values[token] =
        resolved.origin === 'ENGAGEMENT' ? resolved.value : formatFieldValue(resolved.value, { dataType });
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

    // The signature copy: the same values, rendered again with Adobe's tags
    // where the blank signature lines are.
    //
    // Two files exist because a reviewer approves a document they can read and
    // Adobe needs one carrying tags. Both are rendered here, from the same
    // values in the same operation, so what goes out for signature provably
    // came from the inputs that were approved. Rendering it at send time
    // instead would produce bytes nobody had seen.
    //
    // Skipped when nobody has been named yet — naming signers is a separate
    // step, and a reviewer may reasonably want to read a draft first. The send
    // gate refuses when this copy is missing, so skipping delays sending rather
    // than letting an untagged document out.
    const signers = await this.deps.prisma.engagementParticipant.findMany({
      where: { engagementId: input.engagementId, isSigner: true },
      orderBy: { signingOrder: 'asc' },
      select: { role: true, signingOrder: true },
    });

    let storedSignaturePdf: { reference: string; hash: string } | null = null;

    if (manifest.signatureAnchors.length > 0 && signers.length > 0) {
      try {
        const signatureRender = await renderDocx(templateDocx, {
          manifest,
          values,
          selections,
          includedSections,
          mode: 'FOR_SIGNATURE',
          wordingExceptions: approvedExceptions,
          signers,
        });

        const signaturePdf = await this.deps.pdfConverter.convert(signatureRender.docx);

        storedSignaturePdf = await this.deps.store.put({
          content: signaturePdf.pdf,
          fileName: buildFileName({
            year: engagement.taxYear,
            documentType: input.documentType,
            clientLegalName: engagement.client.legalName,
            role: 'FOR_SIGNATURE_PDF',
            testMode: input.testMode,
          }),
          mimeType: 'application/pdf',
          scope,
        });
      } catch (error) {
        // Thrown when a required anchor has no participant to fill it — a
        // half-named engagement, which is ordinary mid-preparation. Recorded
        // rather than raised: failing generation here would stop a reviewer
        // reading the draft that tells them who is missing.
        this.deps.logger.warn('Could not render the signature copy', {
          engagementId: input.engagementId,
          documentType: input.documentType,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

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
        signaturePdfReference: storedSignaturePdf?.reference ?? null,
        signaturePdfHash: storedSignaturePdf?.hash ?? null,
        pageCount: pdf.pageCount,
        // The signers are part of what this render was built from — the tags in
        // the signature copy address participant sets by position — so they
        // belong in the audit-grade snapshot alongside the values. The send gate
        // compares the roster against this to catch an edit made afterwards.
        renderedFieldValues: {
          values,
          selections,
          includedSections,
          signers: signers.map((signer) => ({ role: signer.role, signingOrder: signer.signingOrder })),
        } as unknown as Prisma.InputJsonValue,
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
        signaturePdfHash: storedSignaturePdf?.hash ?? null,
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
