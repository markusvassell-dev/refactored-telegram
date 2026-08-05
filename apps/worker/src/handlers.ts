import type { JobHandler, JobType } from '@element/services';
import { extractPdfText, DeterministicExtractor, selectPriorYearDocument } from '@element/integrations';
import { detectCheckboxStates, extractParagraphs, isPdf, parseManifest } from '@element/documents';
import { PreconditionError, ValidationError, sha256Hex, type DocumentType } from '@element/shared';
import type { WorkerContext } from './context.js';

/**
 * Job handlers.
 *
 * Each handler is idempotent: re-running it after a crash must converge on the
 * same state rather than duplicating work. The queue guarantees at-least-once
 * delivery; these handlers provide the effectively-once behaviour.
 */

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value === '') {
    throw new ValidationError(`Job payload is missing "${key}".`);
  }
  return value;
}

export function buildHandlers(context: WorkerContext): Record<JobType, JobHandler> {
  const systemActorId = 'system';

  /**
   * Upserts an engagement-level extracted field.
   *
   * `coverLetterPackageId` is null for engagement-level values. The uniqueness
   * guarantee comes from a NULLS NOT DISTINCT index created in the migration,
   * which Prisma's generated compound-key type cannot express, so the lookup is
   * done explicitly.
   */
  async function upsertEngagementField(
    engagementId: string,
    input: {
      token: string;
      value: string | null;
      valueDecimal: string | null;
      valueDate: Date | null;
      valueBoolean?: boolean | null;
      extractionMethod: 'STRUCTURED_EXPORT' | 'PDF_TEXT' | 'DETERMINISTIC_PATTERN' | 'AI_ASSISTED' | 'OCR_VISION' | 'MANUAL_ENTRY';
      confidence: number;
    },
  ) {
    const existing = await context.prisma.extractedField.findFirst({
      where: {
        engagementId,
        coverLetterPackageId: null,
        token: input.token,
        source: 'PRIOR_YEAR_DOCUMENT',
      },
      select: { id: true },
    });

    if (existing) {
      return context.prisma.extractedField.update({
        where: { id: existing.id },
        data: {
          value: input.value,
          valueDecimal: input.valueDecimal,
          valueBoolean: input.valueBoolean ?? null,
          confidence: input.confidence,
        },
      });
    }

    return context.prisma.extractedField.create({
      data: {
        engagementId,
        token: input.token,
        value: input.value,
        valueDecimal: input.valueDecimal,
        valueDate: input.valueDate,
        valueBoolean: input.valueBoolean ?? null,
        source: 'PRIOR_YEAR_DOCUMENT',
        extractionMethod: input.extractionMethod,
        confidence: input.confidence,
      },
    });
  }

  /** The active manifest for a document type, or null when none is published. */
  async function activeManifest(documentType: DocumentType) {
    const template = await context.prisma.documentTemplate.findUnique({
      where: { documentType },
      include: { versions: { where: { status: 'ACTIVE' }, orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    const version = template?.versions[0];
    return version ? parseManifest(version.manifest) : null;
  }

  function documentTypeFor(engagementType: string): DocumentType {
    switch (engagementType) {
      case 'T1_JOINT':
        return 'T1_JOINT_ENGAGEMENT_LETTER';
      case 'T1_SINGLE':
        return 'T1_SINGLE_ENGAGEMENT_LETTER';
      case 'T3':
        return 'T3_ENGAGEMENT_LETTER';
      default:
        return 'T2_ENGAGEMENT_LETTER';
    }
  }

  return {
    // ---------------------------------------------------------------- Karbon
    KARBON_SYNC: async ({ job, logger }) => {
      const { karbon } = await context.providers();
      const workItemKey = requireString(job.payload, 'workItemKey');

      const item = await karbon.getWorkItem(workItemKey);
      if (!item) {
        logger.warn('Karbon work item not found', { workItemKey });
        return { found: false };
      }

      await context.prisma.karbonWorkItem.upsert({
        where: { karbonKey: item.workItemKey },
        create: {
          karbonKey: item.workItemKey,
          title: item.title,
          workType: item.workType,
          status: item.workStatus,
          assigneeEmail: item.assigneeEmail,
          dueDate: item.dueDate ? new Date(item.dueDate) : null,
          lastSyncedAt: new Date(),
          rawSnapshot: (item.raw ?? {}) as never,
        },
        update: {
          title: item.title,
          workType: item.workType,
          status: item.workStatus,
          assigneeEmail: item.assigneeEmail,
          lastSyncedAt: new Date(),
          rawSnapshot: (item.raw ?? {}) as never,
        },
      });

      return { found: true, workItemKey };
    },

    // -------------------------------------------------- Prior-year documents
    LOCATE_PRIOR_YEAR_DOCUMENTS: async ({ job, logger }) => {
      const engagementId = requireString(job.payload, 'engagementId');
      const { karbon } = await context.providers();

      const engagement = await context.prisma.engagement.findUniqueOrThrow({
        where: { id: engagementId },
        include: { client: true, karbonWorkItem: true, participants: true },
      });

      await context.workflow.transition({
        engagementId,
        to: 'LOCATING_SOURCE_DOCUMENTS',
        reason: 'Searching Karbon for the prior-year letter',
        correlationId: job.correlationId,
      });

      // Search order: current work item, then prior-year work items, then the
      // client-level document area.
      const scopes: { workItemKey?: string; entityKey?: string }[] = [];
      if (engagement.karbonWorkItem?.karbonKey) scopes.push({ workItemKey: engagement.karbonWorkItem.karbonKey });

      if (engagement.client.karbonEntityKey) {
        const priorItems = await karbon.searchWorkItems({
          clientKey: engagement.client.karbonEntityKey,
          year: engagement.taxYear - 1,
          limit: 25,
        });
        for (const item of priorItems) scopes.push({ workItemKey: item.workItemKey });
        scopes.push({ entityKey: engagement.client.karbonEntityKey });
      }

      const documentTypeByEngagement: Record<string, DocumentType> = {
        T1_JOINT: 'T1_JOINT_ENGAGEMENT_LETTER',
        T1_SINGLE: 'T1_SINGLE_ENGAGEMENT_LETTER',
        T2: 'T2_ENGAGEMENT_LETTER',
        T3: 'T3_ENGAGEMENT_LETTER',
      };

      const candidates: Parameters<typeof selectPriorYearDocument>[0][number][] = [];

      for (const scope of scopes) {
        const documents = await karbon.listDocuments(scope);
        for (const document of documents) {
          if (!/\.(docx|pdf)$/i.test(document.fileName)) continue;

          const downloaded = await karbon.downloadDocument(document.documentId).catch(() => null);
          if (!downloaded) continue;

          // File names are a hint only; the text is what actually verifies it.
          const text = /\.pdf$/i.test(document.fileName)
            ? (await extractPdfText(downloaded.content).catch(() => null))?.fullText ?? ''
            : (await extractParagraphs(downloaded.content).catch(() => [])).join('\n');

          candidates.push({
            documentId: document.documentId,
            fileName: document.fileName,
            karbonWorkItemKey: scope.workItemKey ?? null,
            text,
          });
        }
      }

      const outcome = selectPriorYearDocument(candidates, {
        clientLegalName: engagement.client.legalName,
        engagementType: engagement.engagementType,
        documentType: documentTypeByEngagement[engagement.engagementType] as DocumentType,
        priorTaxYear: engagement.taxYear - 1,
        corporationName: engagement.engagementType === 'T2' ? engagement.client.legalName : null,
        trustName: engagement.engagementType === 'T3' ? engagement.client.legalName : null,
        taxpayerNames: engagement.participants
          .filter((p) => p.role === 'TAXPAYER_1' || p.role === 'TAXPAYER_2')
          .map((p) => p.fullLegalName),
        businessNumber: engagement.client.businessNumber,
        t3AccountNumber: engagement.client.trustAccountNumber,
        yearEndIso: engagement.yearEnd?.toISOString().slice(0, 10) ?? null,
        karbonWorkItemKey: engagement.karbonWorkItem?.karbonKey ?? null,
      });

      // Record every candidate so the reviewer can see what was considered.
      for (const ranked of outcome.ranked) {
        const candidate = candidates.find((entry) => entry.documentId === ranked.documentId);
        if (!candidate) continue;

        await context.prisma.sourceDocument.upsert({
          where: {
            engagementId_fileHash_kind: {
              engagementId,
              fileHash: sha256Hex(candidate.text),
              kind: 'PRIOR_YEAR_ENGAGEMENT_LETTER',
            },
          },
          create: {
            engagementId,
            kind: 'PRIOR_YEAR_ENGAGEMENT_LETTER',
            fileName: candidate.fileName,
            karbonDocumentId: candidate.documentId,
            karbonWorkItemKey: candidate.karbonWorkItemKey,
            fileHash: sha256Hex(candidate.text),
            verificationScore: ranked.score,
            verificationDetail: { signals: ranked.signals, disqualifiers: ranked.disqualifiers } as never,
            confirmedAt: outcome.selected?.documentId === ranked.documentId ? new Date() : null,
          },
          update: { verificationScore: ranked.score },
        });
      }

      if (outcome.requiresUserChoice || !outcome.selected) {
        await context.workflow.transition({
          engagementId,
          to: 'SOURCE_DOCUMENT_REVIEW_REQUIRED',
          reason: outcome.reason,
          correlationId: job.correlationId,
        });
        logger.info('Prior-year document needs a human decision', { engagementId, reason: outcome.reason });
        return { requiresUserChoice: true, candidates: outcome.ranked.length };
      }

      await context.workflow.transition({
        engagementId,
        to: 'EXTRACTING_DATA',
        reason: outcome.reason,
        correlationId: job.correlationId,
      });

      await context.queue.enqueue({
        jobType: 'EXTRACT_DOCUMENT_TEXT',
        idempotencyKey: `extract_${engagementId}_${outcome.selected.documentId}`,
        payload: { engagementId, karbonDocumentId: outcome.selected.documentId },
        engagementId,
        correlationId: job.correlationId,
      });

      return { selected: outcome.selected.documentId, score: outcome.selected.score };
    },

    // ------------------------------------------------------------ Extraction
    EXTRACT_DOCUMENT_TEXT: async ({ job }) => {
      const engagementId = requireString(job.payload, 'engagementId');

      // Two ways a document gets here: Karbon located it, or a person attached
      // it. Both produce the same bytes, and everything below this point is
      // identical — the only difference is where they are read from.
      const sourceDocumentId =
        typeof job.payload.sourceDocumentId === 'string' ? job.payload.sourceDocumentId : null;
      const karbonDocumentId =
        typeof job.payload.karbonDocumentId === 'string' ? job.payload.karbonDocumentId : null;

      if (!sourceDocumentId && !karbonDocumentId) {
        throw new ValidationError('Extraction needs either an attached document or a Karbon document id.');
      }

      const engagement = await context.prisma.engagement.findUniqueOrThrow({
        where: { id: engagementId },
        include: { client: true },
      });

      const source = sourceDocumentId
        ? await context.prisma.sourceDocument.findUnique({ where: { id: sourceDocumentId } })
        : await context.prisma.sourceDocument.findFirst({
            where: { engagementId, karbonDocumentId: karbonDocumentId as string },
          });

      let downloaded: { content: Buffer; fileName: string };
      if (sourceDocumentId) {
        const attached = await context.sourceDocuments.contentOf(sourceDocumentId);
        if (!attached) {
          throw new ValidationError('That attached document is no longer in temporary storage. Upload it again.');
        }
        downloaded = attached;
      } else {
        const { karbon } = await context.providers();
        const fetched = await karbon.downloadDocument(karbonDocumentId as string);
        downloaded = { content: Buffer.from(fetched.content), fileName: fetched.fileName };
      }

      const text = isPdf(downloaded.content)
        ? await extractPdfText(downloaded.content)
        : {
            pages: [{ pageNumber: 1, text: (await extractParagraphs(downloaded.content)).join('\n') }],
            fullText: (await extractParagraphs(downloaded.content)).join('\n'),
            requiresOcr: false,
          };

      const extractor = new DeterministicExtractor('ENGAGEMENT_LETTER');
      const wanted = [
        'corporation.legal_name',
        'corporation.business_number',
        'corporation.year_end',
        'signer.officer_name',
        'signer.officer_title',
        'signer.officer_email',
        'pricing.t2_fee',
        'pricing.compilation_fee',
        'pricing.billing_basis',
        'pricing.payment_terms_short',
        'compilation.intended_use',
        'compilation.intended_users',
        'compilation.basis_of_accounting',
        'compilation.report_delivery',
        'taxpayer1.full_legal_name',
        'taxpayer2.full_legal_name',
        'pricing.t1_fee',
        'trust.legal_name',
        'trust.account_number',
        'trust.year_end',
        'representative.name_and_capacity',
        'pricing.t3_fee',
      ];

      const result = await extractor.extract({
        documentId: source?.id ?? (karbonDocumentId as string),
        documentHash: source?.fileHash ?? sha256Hex(downloaded.content),
        text,
        wantedTokens: wanted,
        context: { expectedClientName: engagement.client.legalName, expectedYear: engagement.taxYear - 1 },
      });

      if (result.blockers.length > 0) {
        await context.workflow.needsAttention(engagementId, result.blockers.join(' '), {
          correlationId: job.correlationId,
        });
        return { blocked: true, blockers: result.blockers };
      }

      for (const value of result.values) {
        const field = await upsertEngagementField(engagementId, {
          token: value.token,
          value: value.value,
          valueDecimal: value.numericValue ?? null,
          valueDate: value.dateValue ? new Date(`${value.dateValue}T00:00:00Z`) : null,
          extractionMethod: value.method,
          confidence: value.confidence,
        });

        for (const evidence of value.evidence) {
          await context.prisma.fieldEvidence.create({
            data: {
              extractedFieldId: field.id,
              sourceDocumentId: source?.id ?? null,
              sourceDocumentHash: evidence.sourceDocumentHash ?? null,
              pageNumber: evidence.pageNumber ?? null,
              supportingText: evidence.supportingText ?? null,
            },
          });
        }
      }

      // Read last year's checkbox states so the reviewer can see what was
      // selected, as a suggestion. Nothing is carried forward automatically.
      let checkboxesDetected = 0;
      const manifest = await activeManifest(documentTypeFor(engagement.engagementType));

      if (manifest) {
        for (const detection of detectCheckboxStates(text.fullText, manifest.checkboxes)) {
          if (detection.selected === null) continue;

          const field = await upsertEngagementField(engagementId, {
            token: `service.${detection.code}`,
            value: detection.selected ? 'selected' : 'not selected',
            valueDecimal: null,
            valueDate: null,
            valueBoolean: detection.selected,
            extractionMethod: 'DETERMINISTIC_PATTERN',
            confidence: 1,
          });

          if (detection.evidence) {
            await context.prisma.fieldEvidence.create({
              data: {
                extractedFieldId: field.id,
                sourceDocumentId: source?.id ?? null,
                sourceDocumentHash: source?.fileHash ?? null,
                pageNumber: null,
                supportingText: detection.evidence.slice(0, 400),
              },
            });
          }

          checkboxesDetected += 1;
        }
      }

      await context.audit.record({
        eventType: 'FIELD_EXTRACTED',
        objectType: 'SourceDocument',
        objectId: source?.id ?? karbonDocumentId,
        engagementId,
        correlationId: job.correlationId,
        afterValue: {
          extracted: result.values.length,
          missing: result.missingTokens,
          priorYearSelectionsDetected: checkboxesDetected,
        },
      });

      // Extraction only observes. Preparation is what turns observations into
      // proposed fees, deadlines and selections for a reviewer to confirm.
      await context.queue.enqueue({
        jobType: 'PREPARE_ENGAGEMENT',
        idempotencyKey: `prepare_${engagementId}_${source?.fileHash ?? karbonDocumentId ?? sourceDocumentId}`,
        payload: { engagementId, actorId: job.payload.actorId ?? systemActorId },
        engagementId,
        correlationId: job.correlationId,
      });

      return {
        extracted: result.values.length,
        missing: result.missingTokens.length,
        priorYearSelectionsDetected: checkboxesDetected,
      };
    },

    // ----------------------------------------------------------- Preparation
    PREPARE_ENGAGEMENT: async ({ job }) => {
      const engagementId = requireString(job.payload, 'engagementId');
      const actorId = typeof job.payload.actorId === 'string' ? job.payload.actorId : systemActorId;

      const threshold = await context.settings.highIncreaseThresholdPercent(
        context.env.HIGH_FEE_INCREASE_THRESHOLD_PERCENT,
      );

      const result = await context.preparation.prepare({
        engagementId,
        actorId,
        correlationId: job.correlationId,
        highIncreaseThresholdPercent: threshold,
      });

      // Preparation proposes; a person confirms. The engagement lands in the
      // review queue rather than proceeding straight to generation.
      const current = await context.workflow.currentStatus(engagementId);
      if (current === 'EXTRACTING_DATA') {
        await context.workflow.transition({
          engagementId,
          to: 'SOURCE_DOCUMENT_REVIEW_REQUIRED',
          reason:
            result.conflictsRaised > 0 || result.blockedFees.length > 0 || result.blockedDates.length > 0
              ? 'Prepared with items needing a reviewer decision.'
              : 'Prepared and ready for review.',
          correlationId: job.correlationId,
        });
      }

      return { ...result };
    },

    // ------------------------------------------------------------ Generation
    GENERATE_ENGAGEMENT_LETTER: async ({ job, logger }) => {
      const engagementId = requireString(job.payload, 'engagementId');
      const documentType = requireString(job.payload, 'documentType') as DocumentType;
      const actorId = typeof job.payload.actorId === 'string' ? job.payload.actorId : systemActorId;
      const { testMode } = await context.testMode();

      const current = await context.workflow.currentStatus(engagementId);
      const target = current === 'CHANGES_REQUESTED' || current === 'DRAFT_READY' ? 'REGENERATING' : 'GENERATING';
      await context.workflow.transition({
        engagementId,
        to: target,
        reason: 'Rendering the document',
        correlationId: job.correlationId,
      });

      try {
        const result = await context.generation.generate({
          engagementId,
          documentType,
          actorId,
          correlationId: job.correlationId,
          testMode,
        });

        await context.workflow.transition({
          engagementId,
          to: 'DRAFT_READY',
          reason: `Version ${result.versionNumber} generated`,
          correlationId: job.correlationId,
        });

        await context.queue.enqueue({
          jobType: 'UPLOAD_TO_KARBON',
          idempotencyKey: `upload_${result.documentVersionId}`,
          payload: { engagementId, documentVersionId: result.documentVersionId, actorId },
          engagementId,
          documentVersionId: result.documentVersionId,
          correlationId: job.correlationId,
        });

        logger.info('Draft generated', { engagementId, documentVersionId: result.documentVersionId });
        return { documentVersionId: result.documentVersionId, validationErrors: result.validation.errorCount };
      } catch (error) {
        await context.workflow.transition({
          engagementId,
          to: 'GENERATION_FAILED',
          reason: error instanceof Error ? error.message : 'Generation failed',
          correlationId: job.correlationId,
        });
        throw error;
      }
    },

    CONVERT_PDF: async ({ job }) => {
      const documentVersionId = requireString(job.payload, 'documentVersionId');
      const version = await context.prisma.documentVersion.findUniqueOrThrow({ where: { id: documentVersionId } });
      if (version.generatedPdfReference) return { alreadyConverted: true };

      const docx = await context.store.get(version.generatedDocxReference as string);
      const pdf = await context.pdfConverter.convert(docx);
      const stored = await context.store.put({
        content: pdf.pdf,
        fileName: 'document.pdf',
        mimeType: 'application/pdf',
        scope: version.engagementId.replace(/-/g, ''),
      });

      await context.prisma.documentVersion.update({
        where: { id: documentVersionId },
        data: { generatedPdfReference: stored.reference, pdfHash: stored.hash, pageCount: pdf.pageCount },
      });

      return { pageCount: pdf.pageCount };
    },

    COMPARE_DOCUMENTS: async ({ job }) => {
      const documentVersionId = requireString(job.payload, 'documentVersionId');
      return { documentVersionId, note: 'Comparison is computed on demand in the review workspace.' };
    },

    // ------------------------------------------------------- Karbon delivery
    UPLOAD_TO_KARBON: async ({ job }) => {
      const engagementId = requireString(job.payload, 'engagementId');
      const documentVersionId = requireString(job.payload, 'documentVersionId');
      const { karbon } = await context.providers();
      const { testMode } = await context.testMode();

      const result = await context.notifications.publishDraft({
        engagementId,
        documentVersionId,
        karbon,
        testMode,
        correlationId: job.correlationId,
        actorId: typeof job.payload.actorId === 'string' ? job.payload.actorId : null,
      });

      const current = await context.workflow.currentStatus(engagementId);
      if (current === 'DRAFT_READY') {
        await context.workflow.transition({
          engagementId,
          to: 'REVIEW_REQUIRED',
          reason: 'Draft uploaded and review requested',
          correlationId: job.correlationId,
        });
      }

      return { ...result };
    },

    // ---------------------------------------------------------- Adobe Sign
    CREATE_ADOBE_AGREEMENT: async ({ job }) => {
      const engagementId = requireString(job.payload, 'engagementId');
      const documentVersionId = requireString(job.payload, 'documentVersionId');
      const actorId = requireString(job.payload, 'actorId');

      const { adobeSign } = await context.providers();
      const state = await context.testMode();

      const actor = await context.prisma.user.findUniqueOrThrow({
        where: { id: actorId },
        include: { userRoles: true },
      });

      const result = await context.signing.sendForSignature({
        engagementId,
        documentVersionId,
        actor: {
          id: actor.id,
          email: actor.email,
          displayName: actor.displayName,
          roles: actor.userRoles.map((row) => row.role),
        },
        adobeSign,
        testMode: state.testMode,
        productionSendingEnabled: state.productionSendingEnabled,
        sandboxConfigured: adobeSign.isMock === false || adobeSign.name.includes('mock'),
        correlationId: job.correlationId,
      });

      return { ...result };
    },

    SYNC_ADOBE_STATUS: async ({ job }) => {
      const { adobeSign } = await context.providers();

      const live = await context.prisma.adobeAgreement.findMany({
        where: { status: { in: ['CREATED', 'OUT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'] }, agreementId: { not: null } },
        select: { agreementId: true },
      });

      let synced = 0;
      for (const agreement of live) {
        if (!agreement.agreementId) continue;
        const state = await adobeSign.getAgreement(agreement.agreementId);
        if (!state) continue;
        await context.signing.applyAgreementState(agreement.agreementId, state, job.correlationId);
        synced += 1;

        if (state.status === 'COMPLETED' || state.status === 'SIGNED') {
          await context.queue.enqueue({
            jobType: 'RETRIEVE_SIGNED_DOCUMENTS',
            idempotencyKey: `signed_${agreement.agreementId}`,
            payload: { agreementId: agreement.agreementId },
            correlationId: job.correlationId,
          });
        }
      }

      return { synced };
    },

    RETRIEVE_SIGNED_DOCUMENTS: async ({ job }) => {
      const agreementId = requireString(job.payload, 'agreementId');
      const { adobeSign, karbon } = await context.providers();

      const result = await context.signing.returnSignedDocumentsToKarbon({
        agreementId,
        adobeSign,
        karbon,
        correlationId: job.correlationId,
      });

      const record = await context.prisma.adobeAgreement.findUniqueOrThrow({
        where: { agreementId },
        select: { engagementId: true },
      });

      const current = await context.workflow.currentStatus(record.engagementId);
      if (current === 'SIGNED') {
        await context.workflow.transition({
          engagementId: record.engagementId,
          to: 'COMPLETE',
          reason: 'Signed document and certificate returned to Karbon',
          correlationId: job.correlationId,
        });
      }

      return { ...result };
    },

    // -------------------------------------------------------- Cover letters
    EXTRACT_COVER_LETTER_DATA: async ({ job }) => {
      const engagementId = requireString(job.payload, 'engagementId');
      const sourceDocumentId = requireString(job.payload, 'sourceDocumentId');
      const { karbon } = await context.providers();

      const source = await context.prisma.sourceDocument.findUniqueOrThrow({ where: { id: sourceDocumentId } });
      const engagement = await context.prisma.engagement.findUniqueOrThrow({
        where: { id: engagementId },
        include: { client: true },
      });

      if (!source.karbonDocumentId) throw new PreconditionError('The source document has no Karbon reference.');

      const downloaded = await karbon.downloadDocument(source.karbonDocumentId);
      const text = await extractPdfText(downloaded.content);

      const extractor = new DeterministicExtractor('COVER_LETTER_SOURCE');
      const result = await extractor.extract({
        documentId: source.id,
        documentHash: source.fileHash,
        text,
        wantedTokens: [
          'client.legal_name',
          'client.year_end',
          'amounts.federal_balance',
          'amounts.provincial_balance',
          'amounts.estimated_balance',
        ],
        context: { expectedClientName: engagement.client.legalName, expectedYear: engagement.taxYear },
      });

      await context.prisma.sourceDocument.update({
        where: { id: source.id },
        data: { pageCount: text.pages.length },
      });

      if (result.blockers.length > 0) {
        await context.workflow.needsAttention(engagementId, result.blockers.join(' '), {
          correlationId: job.correlationId,
        });
        return { blocked: true, blockers: result.blockers };
      }

      for (const value of result.values) {
        const field = await upsertEngagementField(engagementId, {
          token: value.token,
          value: value.value,
          valueDecimal: value.numericValue ?? null,
          valueDate: null,
          extractionMethod: value.method,
          confidence: value.confidence,
        });

        for (const evidence of value.evidence) {
          await context.prisma.fieldEvidence.create({
            data: {
              extractedFieldId: field.id,
              sourceDocumentId: source.id,
              sourceDocumentHash: source.fileHash,
              pageNumber: evidence.pageNumber ?? null,
              supportingText: evidence.supportingText ?? null,
            },
          });
        }
      }

      return { extracted: result.values.length, warnings: result.warnings };
    },

    GENERATE_COVER_LETTER: async ({ job }) => {
      const engagementId = requireString(job.payload, 'engagementId');
      const actorId = requireString(job.payload, 'actorId');
      const { testMode } = await context.testMode();

      const actor = await context.prisma.user.findUniqueOrThrow({
        where: { id: actorId },
        include: { userRoles: true },
      });

      // The service enters COVER_LETTER_GENERATING itself, so both this job
      // and a direct call follow the same status path.
      const result = await context.coverLetters.generate({
        engagementId,
        actor: {
          id: actor.id,
          email: actor.email,
          displayName: actor.displayName,
          roles: actor.userRoles.map((row) => row.role),
        },
        correlationId: job.correlationId,
        testMode,
      });

      return { ...result };
    },

    DETECT_STALE_SOURCES: async ({ job }) => {
      const engagementId = requireString(job.payload, 'engagementId');
      return context.coverLetters.detectStaleSources(engagementId, job.correlationId);
    },

    // ------------------------------------------------------------ Bulk / ops
    // The second stage of a bulk rollout. Splitting it in two is what makes a
    // repeated rollout safe: the batch key stops the same batch being queued
    // twice, and this step re-enqueues under the deterministic per-engagement
    // generation key, so a *different* batch covering the same engagement does
    // not produce a second draft.
    BULK_ROLLOUT_ITEM: async ({ job }) => {
      const engagementId = requireString(job.payload, 'engagementId');
      const documentType = requireString(job.payload, 'documentType');
      const result = await context.queue.enqueue({
        jobType: 'GENERATE_ENGAGEMENT_LETTER',
        idempotencyKey: requireString(job.payload, 'generationKey'),
        payload: { engagementId, documentType, actorId: job.payload.actorId ?? systemActorId },
        engagementId,
        correlationId: job.correlationId,
      });
      return { queued: !result.deduplicated, deduplicated: result.deduplicated };
    },

    PURGE_TEMPORARY_FILES: async () => {
      const retentionHours = context.env.DOCUMENT_RETENTION_HOURS;
      const cutoff = new Date(Date.now() - retentionHours * 3_600_000);

      const expired = await context.prisma.sourceDocument.findMany({
        where: { purgeAfter: { lt: new Date() } },
        select: { id: true, storagePath: true },
      });

      let purged = 0;
      for (const document of expired) {
        if (document.storagePath) {
          await context.store.delete(document.storagePath).catch(() => undefined);
          purged += 1;
        }
        await context.prisma.sourceDocument.update({
          where: { id: document.id },
          data: { storagePath: null },
        });
      }

      // Superseded document versions past retention lose their working copies.
      // Karbon keeps the authoritative record.
      const superseded = await context.prisma.documentVersion.findMany({
        where: { status: 'SUPERSEDED', supersededAt: { lt: cutoff } },
        select: { id: true, generatedDocxReference: true, generatedPdfReference: true },
      });

      for (const version of superseded) {
        for (const reference of [version.generatedDocxReference, version.generatedPdfReference]) {
          if (reference) {
            await context.store.delete(reference).catch(() => undefined);
            purged += 1;
          }
        }
      }

      return { purged };
    },
  };
}
