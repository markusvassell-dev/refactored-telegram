import {
  NotificationEmailService,
  enqueuePriorYearSearch,
  maybeStartCoverLetter,
  maybeStartGeneration,
  summariseClientImport,
  SYSTEM_ACTOR_ID,
  SYSTEM_PRINCIPAL,
  type JobHandler,
  type JobType,
} from '@element/services';
import { extractPdfText, deriveTaxYear, DeterministicExtractor, selectPriorYearDocument } from '@element/integrations';
import { detectCheckboxStates, extractParagraphs, isPdf, parseManifest } from '@element/documents';
import {
  newCorrelationId,
  PreconditionError,
  ValidationError,
  sha256Hex,
  type DocumentType,
  type EngagementType,
} from '@element/shared';
import type { WorkerContext } from './context.js';

/**
 * Job handlers.
 *
 * Each handler is idempotent: re-running it after a crash must converge on the
 * same state rather than duplicating work. The queue guarantees at-least-once
 * delivery; these handlers provide the effectively-once behaviour.
 */

/**
 * How many work items one trigger may match in a single pass.
 *
 * A ceiling rather than a target. The first time a firm configures a status
 * that a few hundred historical work items already sit in, every one of them is
 * a candidate engagement — and each costs Karbon reads downstream. Capping the
 * pass means the backlog drains over several, which is slower and survivable;
 * uncapped, the first poll after configuration is the largest thing this
 * application has ever done, unattended, on a shared rate limit.
 */
const POLL_WORK_ITEM_LIMIT = 50;

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value === '') {
    throw new ValidationError(`Job payload is missing "${key}".`);
  }
  return value;
}

export function buildHandlers(context: WorkerContext): Record<JobType, JobHandler> {
  // Named in `@element/services` alongside `resolveUserActor`, which explains
  // why an audit column may hold it and a foreign key may not.
  const systemActorId = SYSTEM_ACTOR_ID;

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
      extractionMethod:
        | 'STRUCTURED_EXPORT'
        | 'PDF_TEXT'
        | 'DETERMINISTIC_PATTERN'
        | 'AI_ASSISTED'
        | 'OCR_VISION'
        | 'MANUAL_ENTRY';
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

  /**
   * Brings this application's copy of one Karbon work item up to date.
   *
   * Shared by `KARBON_SYNC` and the rollover, which needs the work item to
   * exist before it can read a client off it. A rollover triggered by the poll
   * names a work item this application may never have seen, and depending on a
   * separately queued sync having run first would make the outcome depend on
   * job ordering the queue does not promise.
   */
  async function syncWorkItem(
    workItemKey: string,
    logger: { warn: (message: string, context?: Record<string, unknown>) => void },
  ) {
    const { karbon } = await context.providers();

    const item = await karbon.getWorkItem(workItemKey);
    if (!item) {
      logger.warn('Karbon work item not found', { workItemKey });
      return { found: false as const };
    }

    // Which client this work is for.
    //
    // The work item carried a client key from the first release and nothing
    // ever stored it, so `karbonWorkItem.clientId` was null on every row. A
    // work item that names no client is a work item nothing can be rolled
    // forward from — the rollover has to start by asking "whose engagement is
    // this?", and until now the answer was not written down anywhere.
    //
    // It costs no Karbon request: `getWorkItem` already returns `clientKey`.
    // An unknown key links nothing rather than inventing a client, matching
    // how the import treats a key it cannot resolve.
    const client = item.clientKey
      ? await context.prisma.client.findUnique({
          where: { karbonEntityKey: item.clientKey },
          select: { id: true },
        })
      : null;

    const taxYear = deriveTaxYear(item);

    await context.prisma.karbonWorkItem.upsert({
      where: { karbonKey: item.workItemKey },
      create: {
        karbonKey: item.workItemKey,
        clientId: client?.id ?? null,
        title: item.title,
        workType: item.workType,
        status: item.workStatus,
        assigneeEmail: item.assigneeEmail,
        dueDate: item.dueDate ? new Date(item.dueDate) : null,
        taxYear,
        lastSyncedAt: new Date(),
        rawSnapshot: (item.raw ?? {}) as never,
      },
      update: {
        // Only fills, never clears: a client imported after this work item was
        // first seen should link on the next sync, but a sync that could not
        // resolve the key must not unlink one that already resolved.
        ...(client ? { clientId: client.id } : {}),
        ...(taxYear === null ? {} : { taxYear }),
        title: item.title,
        workType: item.workType,
        status: item.workStatus,
        assigneeEmail: item.assigneeEmail,
        // Written on update as well as create. It was only ever set at create,
        // so a deadline moved in Karbon never moved here.
        dueDate: item.dueDate ? new Date(item.dueDate) : null,
        lastSyncedAt: new Date(),
        rawSnapshot: (item.raw ?? {}) as never,
      },
    });

    return { found: true as const, workItemKey, clientLinked: Boolean(client), taxYear };
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
      const workItemKey = requireString(job.payload, 'workItemKey');
      return syncWorkItem(workItemKey, logger);
    },

    /**
     * Starting next year's engagement, from last year's, with nobody present.
     *
     * This is the job the annual rollover was missing. Everything downstream
     * already existed and already chained itself — locate last year's letter,
     * extract it, prepare this year's proposals — but all of it begins from an
     * engagement, and the only thing that ever made one was a form. A Karbon
     * status trigger naming a work item with no engagement reported that fact
     * and stopped.
     *
     * It runs here rather than in the webhook route because it reads Karbon
     * while a vendor waits on the response, which is the failure the client
     * import already learned the expensive way.
     *
     * **It stops at prepared.** Nothing here enqueues generation: preparation
     * proposes and a person confirms, and an engagement starting itself does
     * not move that line.
     */
    /**
     * Asking Karbon which work items have reached a configured status.
     *
     * The documentation has named a "scheduled reconciliation poll" as the
     * fallback for Karbon's webhooks since the capability matrix was written,
     * and there has never been one. That mattered more than it sounds: nothing
     * subscribes to Karbon's webhooks, and the receiver's header name,
     * signature scheme and payload fields were inferred from no specification —
     * so the only route from a Karbon status change into this application was
     * one that has never carried a single request.
     *
     * This is the route that works. `searchWorkItems` is one of the operations
     * proven against the live tenant, and it filters on work type and status
     * server-side and again client-side, so a tenant whose API ignores an
     * unsupported `$filter` cannot make us act on the wrong work item.
     */
    POLL_KARBON_TRIGGERS: async ({ job, logger }) => {
      const triggers = await context.settings.karbonStatusTriggers();

      // Nothing configured is the normal state, and it must cost nothing:
      // Karbon allows about 120 requests a minute across every process the firm
      // runs, and polling for a list nobody has filled in would spend that
      // budget to learn nothing.
      if (triggers.length === 0) {
        return { triggers: 0, examined: 0, queued: 0, note: 'No Karbon status triggers are configured.' };
      }

      const { karbon } = await context.providers();

      // A mock would answer with fictional work items, and this path creates
      // engagements. Inventing a firm's annual rollout out of sample data is
      // not a smaller mistake than failing to run at all.
      if (karbon.isMock) {
        return { triggers: triggers.length, examined: 0, queued: 0, note: 'Karbon is not connected.' };
      }

      let examined = 0;
      let queued = 0;

      for (const trigger of triggers) {
        const found = await karbon.searchWorkItems({
          workStatus: trigger.status,
          workType: trigger.workType || undefined,
          limit: POLL_WORK_ITEM_LIMIT,
        });

        examined += found.length;

        for (const item of found) {
          const result = await context.queue.enqueue({
            jobType: 'ROLL_OVER_ENGAGEMENT',
            // Keyed on the work item and the status that matched, exactly as
            // the webhook's own trigger key is. A work item sitting in that
            // status is not re-examined on every pass; one that moves through a
            // second configured status is.
            idempotencyKey: `rollover_${item.workItemKey}_${trigger.status}`,
            payload: {
              workItemKey: item.workItemKey,
              engagementType: trigger.engagementType,
              triggerStatus: trigger.status,
            },
            correlationId: job.correlationId,
          });

          if (!result.deduplicated) queued += 1;
        }
      }

      if (queued > 0) logger.info('Karbon status triggers matched work items', { examined, queued });

      return { triggers: triggers.length, examined, queued };
    },

    ROLL_OVER_ENGAGEMENT: async ({ job, logger }) => {
      const workItemKey = requireString(job.payload, 'workItemKey');
      const engagementType = requireString(job.payload, 'engagementType') as EngagementType;
      const correlationId = job.correlationId ?? null;

      // The work item has to be here before anything can be read off it. A
      // trigger can name one this application has never seen — the poll finds
      // work items directly from Karbon — so sync it rather than refusing.
      const known = await context.prisma.karbonWorkItem.findUnique({
        where: { karbonKey: workItemKey },
        select: { clientId: true },
      });

      if (!known?.clientId) await syncWorkItem(workItemKey, logger);

      const state = await context.testMode();

      const result = await context.engagements.rollForward({
        karbonWorkItemKey: workItemKey,
        engagementType,
        actorId: systemActorId,
        isTestMode: state.testMode,
        initiationSource: 'KARBON_ROLLOVER',
        correlationId,
      });

      // Straight into the pipeline that already exists, under the same key the
      // reviewer's own button uses, so a rollover and a person pressing it
      // cannot both queue a search for the same engagement.
      const search = await enqueuePriorYearSearch(
        { prisma: context.prisma, queue: context.queue },
        result.engagementId,
        correlationId ?? newCorrelationId(),
      );

      if (!search.enqueued) {
        // Not a failure: an engagement already past extraction is one somebody
        // is working on, and the rollover's job was to make it exist.
        logger.info('Rolled forward without starting a prior-year search', {
          engagementId: result.engagementId,
          reason: search.reason,
        });
      }

      return { ...result, priorYearSearchEnqueued: search.enqueued };
    },

    /**
     * Catalogues everything Karbon holds for a client.
     *
     * A background job because a long-standing client means tens of file-list
     * requests against a rate-limited API — too slow for a request, and it must
     * survive a restart partway through.
     */
    SYNC_CLIENT_DOCUMENTS: async ({ job, logger }) => {
      const clientId = requireString(job.payload, 'clientId');
      const { karbon } = await context.providers();

      const result = await context.karbonLibrary.sync({ clientId, karbon });

      if (!result.complete) {
        // Warned, not failed. A library missing two work items is still worth
        // having; what would be wrong is presenting it as the whole of it, and
        // `complete: false` is already recorded against the sync for the screen
        // to read.
        logger.warn('Client document library is incomplete', {
          clientId,
          scopesFailed: result.scopesFailed,
          documentsFound: result.documentsFound,
        });
      }

      return { ...result };
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

      // The hash of each candidate's *bytes*, kept beside the candidates.
      //
      // `source_document.file_hash` is documented as "SHA-256 of the retrieved
      // file", and the upload path hashes the stored bytes. This handler hashed
      // the extracted *text* instead, which had two consequences. A document
      // located in Karbon and the same file attached by hand never compared
      // equal, defeating the duplicate check they share. And every candidate
      // whose text could not be read hashed to `sha256Hex('')` — so they
      // collided on the unique key of engagement, hash and kind, and all but one
      // vanished. An encrypted signed PDF, which pdf.js refuses to open at all,
      // is the commonest document that reads as empty, and last year's *signed*
      // letter is the commonest thing anybody is looking for.
      const hashByDocumentId = new Map<string, string>();

      for (const scope of scopes) {
        const documents = await karbon.listDocuments(scope);
        for (const document of documents) {
          if (!/\.(docx|pdf)$/i.test(document.fileName)) continue;

          const downloaded = await karbon.downloadDocument(document.documentId, scope).catch(() => null);
          if (!downloaded) continue;

          // File names are a hint only; the text is what actually verifies it.
          const text = /\.pdf$/i.test(document.fileName)
            ? ((await extractPdfText(downloaded.content).catch(() => null))?.fullText ?? '')
            : (await extractParagraphs(downloaded.content).catch(() => [])).join('\n');

          hashByDocumentId.set(document.documentId, sha256Hex(downloaded.content));

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

        const fileHash = hashByDocumentId.get(candidate.documentId) ?? sha256Hex(candidate.text);

        await context.prisma.sourceDocument.upsert({
          where: {
            engagementId_fileHash_kind: {
              engagementId,
              fileHash,
              kind: 'PRIOR_YEAR_ENGAGEMENT_LETTER',
            },
          },
          create: {
            engagementId,
            kind: 'PRIOR_YEAR_ENGAGEMENT_LETTER',
            fileName: candidate.fileName,
            karbonDocumentId: candidate.documentId,
            karbonWorkItemKey: candidate.karbonWorkItemKey,
            fileHash,
            verificationScore: ranked.score,
            verificationDetail: { signals: ranked.signals, disqualifiers: ranked.disqualifiers } as never,
            confirmedAt: outcome.selected?.documentId === ranked.documentId ? new Date() : null,
          },
          update: { verificationScore: ranked.score },
        });
      }

      if (outcome.requiresUserChoice || !outcome.selected) {
        // Fill the picker for the person who now has to choose.
        //
        // This is the moment the whole-library catalogue earns its cost. The
        // targeted search usually settles it alone and the catalogue is never
        // needed; when it cannot, somebody picks from what Karbon holds — and
        // that picker reads `KarbonClientDocument`, which nothing populates
        // until a sync runs. So the reviewer arrived at a chooser with nothing
        // in it, and a link telling them to go and run the sync themselves.
        //
        // Both outcomes reach here — several plausible candidates, or none
        // confident — and both end the same way, with a person deciding. Keyed
        // per client, so several engagements for one client do not each re-read
        // a library that takes tens of requests to assemble.
        if (engagement.client.karbonEntityKey) {
          await context.queue.enqueue({
            jobType: 'SYNC_CLIENT_DOCUMENTS',
            idempotencyKey: `library_for_choice_${engagement.client.id}`,
            payload: { clientId: engagement.client.id },
            correlationId: job.correlationId,
          });
        }

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
      const sourceDocumentId = typeof job.payload.sourceDocumentId === 'string' ? job.payload.sourceDocumentId : null;
      const karbonDocumentId = typeof job.payload.karbonDocumentId === 'string' ? job.payload.karbonDocumentId : null;

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

        // The scope is not optional, and leaving it off was a silent break of
        // the one path that matters most.
        //
        // Karbon hands out a download token alongside a file listing and it
        // expires about fifteen minutes later, so `downloadDocument` re-lists
        // the entity to get a fresh one. Called with no scope it lists nothing,
        // matches nothing, and throws a *non-retryable* error — so the job
        // dead-lettered and the engagement dropped into NEEDS_ATTENTION.
        //
        // Which means the better the search did, the more certainly this
        // failed: a confidently identified prior-year letter takes this branch,
        // while the manual routes pass `sourceDocumentId` and read from local
        // storage, so every path anybody had actually exercised worked.
        //
        // The scope was already in hand. `source` is loaded above and carries
        // the work item the document was found under; the client's entity key
        // is the fallback, matching the two scopes the search itself used.
        const scope = source?.karbonWorkItemKey
          ? { workItemKey: source.karbonWorkItemKey }
          : engagement.client.karbonEntityKey
            ? { entityKey: engagement.client.karbonEntityKey }
            : null;

        if (!scope) {
          // Named rather than left to surface as a missing token, because the
          // two causes need different answers: this one means the link to
          // Karbon is gone, not that the file could not be reached.
          throw new ValidationError(
            `Neither the source document nor ${engagement.client.legalName} carries a Karbon key, so there is no entity to list this file under. Attach the document by hand.`,
          );
        }

        const fetched = await karbon.downloadDocument(karbonDocumentId as string, scope);
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

      const threshold = await context.settings.highIncreaseThresholdPercent(context.env.HIGH_FEE_INCREASE_THRESHOLD_PERCENT);

      const result = await context.preparation.prepare({
        engagementId,
        actorId,
        correlationId: job.correlationId,
        highIncreaseThresholdPercent: threshold,
      });

      // Preparation proposes, and the draft now follows by itself.
      //
      // This used to end here, parking the engagement in
      // `SOURCE_DOCUMENT_REVIEW_REQUIRED` under the rule "preparation proposes;
      // a person confirms". The rule has been changed on purpose: a Karbon
      // status trigger is meant to leave the firm a finished draft, and
      // stopping one step short meant every unattended rollover still waited on
      // somebody to press Generate.
      //
      // Nothing about who decides has moved. `maybeStartGeneration` consults
      // exactly the gate the button consults, so an unconfirmed compilation
      // answer or a fee awaiting approval still refuses; and the draft it
      // produces is still reviewed, approved by a second person, and sent only
      // by a partner.
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

      // Confirm what the application had no doubt about, before the generation
      // gate is consulted. Preparation has just calculated every date from its
      // rule and seeded the services from last year; leaving those sitting
      // unconfirmed is what made an unattended rollover stop with a screen full
      // of Confirm buttons and nothing to decide.
      //
      // It settles only the unambiguous. A conflict, a fee awaiting approval,
      // an unanswered compilation question and a date the rule could not
      // compute all survive this untouched, and each is reported back in
      // `leftForAPerson`.
      const settled = await context.engagementReadiness.settle(engagementId, job.correlationId);

      const generation = await maybeStartGeneration(
        {
          prisma: context.prisma,
          queue: context.queue,
          workflow: context.workflow,
          generation: context.generation,
        },
        engagementId,
        job.correlationId,
      );

      return {
        ...result,
        datesConfirmedAutomatically: settled.datesConfirmed,
        servicesConfirmedAutomatically: settled.serviceSelectionsConfirmed,
        leftForAPerson: settled.leftForAPerson,
        generationStarted: generation.started,
        generationBlocked: generation.reason,
      };
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
      if (current !== 'DRAFT_READY') {
        return { ...result };
      }

      // The last thing checked before a person is asked to read a draft.
      //
      // It runs here rather than at generation because half of it needs a
      // rendered document: whether the draft came from the approved template,
      // whether its bytes match, whether its validation report is clean. The
      // previous-year half needs nothing rendered but belongs in the same
      // answer, so a reviewer is never told a thing is fine by one screen and
      // blocked by another.
      //
      // A failing check does not silently hold the engagement at DRAFT_READY —
      // that would look identical to an upload that never finished. It goes to
      // NEEDS_ATTENTION with the reasons written out, which is the screen the
      // firm already watches for blocked work, and which recovers straight to
      // REVIEW_REQUIRED once the reasons are dealt with.
      const readiness = await context.engagementReadiness.check(engagementId);

      if (!readiness.ok) {
        const reasons = readiness.sections
          .filter((section) => !section.ok)
          .map((section) => `${section.label}: ${section.outstanding.join(' ')}`)
          .join(' ');

        await context.workflow.needsAttention(engagementId, `The draft is not ready for review. ${reasons}`, {
          correlationId: job.correlationId,
        });

        return { ...result, readyForReview: false, readiness: readiness.sections };
      }

      await context.workflow.transition({
        engagementId,
        to: 'REVIEW_REQUIRED',
        reason: 'Draft uploaded, readiness checks passed, and review requested',
        correlationId: job.correlationId,
      });

      return { ...result, readyForReview: true, settledAutomatically: readiness.settledAutomatically };
    },

    // ---------------------------------------------------------- Adobe Sign
    /**
     * Bringing the firm's clients across from Karbon.
     *
     * A background job because the size does not fit a request. Every client
     * created costs one read against a rate-limited API — Karbon documents 120
     * a minute — so a book of several hundred is minutes of work, and a request
     * that dies partway reports nothing at all: no counts, no names, no reason.
     * That is what a firm saw as "Something went wrong".
     *
     * Safe to run more than once by construction: the import never duplicates
     * and continues where the last run stopped, so a retry after a restart is
     * ordinary rather than delicate.
     */
    IMPORT_CLIENTS_FROM_KARBON: async ({ job, logger }) => {
      const actorId = requireString(job.payload, 'actorId');
      const { karbon } = await context.providers();

      const actor = await context.prisma.user.findUniqueOrThrow({
        where: { id: actorId },
        include: { userRoles: true },
      });

      const result = await context.clientImport.run({
        karbon,
        actor: {
          id: actor.id,
          email: actor.email,
          displayName: actor.displayName,
          roles: actor.userRoles.map((row) => row.role),
        },
        dryRun: false,
        limit: typeof job.payload.limit === 'number' ? job.payload.limit : undefined,
        source: job.payload.source === 'WORK_ITEMS' ? 'WORK_ITEMS' : 'CLIENT_LIST',
        includeAllContactTypes: job.payload.includeAllContactTypes === true,
        correlationId: job.correlationId,
      });

      if (result.failed.length > 0) {
        // Warned, not failed. Clients that could not be read are reported with
        // their reasons and the rest of the import stands; failing the job would
        // discard a successful import of hundreds because two keys were stale.
        logger.warn('Some clients could not be read during the import', {
          failed: result.failed.length,
          reasons: result.failed.slice(0, 5).map((entry) => entry.reason),
        });
      }

      return { ...result, userMessage: summariseClientImport(result) };
    },

    SEND_NOTIFICATION_EMAILS: async () => {
      // Delivery is separate from raising the notice: a signature must never
      // fail because a mail server was briefly unreachable, so the notice is
      // written first and sent from here afterwards.
      //
      // The mailer is resolved per drain, like every other provider, so a
      // configuration change takes effect without restarting the worker.
      const { mailer } = await context.providers();
      const state = await context.testMode();

      const result = await new NotificationEmailService({
        prisma: context.prisma,
        mailer,
        logger: context.logger,
        appBaseUrl: context.env.APP_BASE_URL,
        testMode: state.testMode,
      }).drain();

      return { ...result };
    },

    SYNC_ADOBE_STATUS: async ({ job }) => {
      const { adobeSign } = await context.providers();

      // Agreements still in flight, plus any that finished without their signed
      // document reaching Karbon.
      //
      // The second half is the safety net. A webhook that never arrives — or
      // arrives while the worker is down — used to leave an agreement COMPLETED
      // with nothing filed, and this query could not see it again because
      // COMPLETED was not in the list. The engagement then sat finished-but-empty
      // with no path back. Re-enqueueing is free when the work is already done:
      // the idempotency key deduplicates it.
      const live = await context.prisma.adobeAgreement.findMany({
        where: {
          agreementId: { not: null },
          // Never ask Adobe about an id Adobe never issued. A mock agreement
          // would be a guaranteed miss on every pass, for ever — noise that
          // buries the real failures on the System Jobs page and spends the
          // rate allowance to learn nothing.
          isMockProvider: false,
          OR: [
            { status: { in: ['CREATED', 'OUT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'] } },
            { status: { in: ['COMPLETED', 'SIGNED'] }, signedPdfKarbonDocumentId: null },
          ],
        },
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

    /**
     * Files a signature obtained outside this application into Karbon.
     *
     * The counterpart to RETRIEVE_SIGNED_DOCUMENTS. Without it the signed
     * engagement letter existed in exactly one place — this application's own
     * document store, which on a container platform is reclaimed on the next
     * deploy unless a volume is attached — and it is the document that proves a
     * client agreed to a fee.
     */
    FILE_EXTERNAL_SIGNATURE: async ({ job }) => {
      const externalSignatureId = requireString(job.payload, 'externalSignatureId');
      const { karbon } = await context.providers();

      const result = await context.externalSignature.fileToKarbon({
        externalSignatureId,
        karbon,
        correlationId: job.correlationId,
      });

      const record = await context.prisma.externalSignature.findUniqueOrThrow({
        where: { id: externalSignatureId },
        select: { engagementId: true },
      });

      // The engagement completes either way, as it does on the Adobe path. A
      // genuine upload failure throws, and the job retries; what reaches here
      // is either a real filing or a deliberate non-filing — Test Mode, a mock
      // adapter, or an engagement with no Karbon work item. Refusing to
      // complete in those cases would leave every test engagement stuck at
      // SIGNED and make Test Mode useless for exercising the workflow.
      //
      // Nothing is claimed by completing: whether the document actually reached
      // Karbon is recorded separately, as `karbonDocumentId`, and a signature
      // still lacking one is reported as at risk on the Settings screen.
      const current = await context.workflow.currentStatus(record.engagementId);
      if (current === 'SIGNED') {
        await context.workflow.transition({
          engagementId: record.engagementId,
          to: 'COMPLETE',
          reason: result.uploaded
            ? 'Signed document recorded outside the application and filed into Karbon'
            : `Signed document recorded outside the application; not filed into Karbon (${result.messages.join(' ') || 'no reason given'})`,
          correlationId: job.correlationId,
        });
      }

      // Same as the Adobe path: the engagement letter being done is one of the
      // two things a cover letter waits for.
      const started = await maybeStartCoverLetter(context.coverLetterAutostart, record.engagementId, job.correlationId);

      return { ...result, coverLetterStarted: started.started };
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

      // One of the two things a cover letter waits for. The other is the final
      // documents being uploaded, and they arrive in either order — so this is
      // called from both sides and does nothing until the last one lands.
      const started = await maybeStartCoverLetter(context.coverLetterAutostart, record.engagementId, job.correlationId);

      return { ...result, coverLetterStarted: started.started };
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

      // `system` is not a user row and never will be, so looking one up throws
      // — which is what the automatic start would have hit on its first run.
      // The system principal carries `PREPARER` and nothing above it: starting
      // a draft is what runs unattended, approving one is not.
      const actor =
        actorId === SYSTEM_ACTOR_ID
          ? SYSTEM_PRINCIPAL
          : await context.prisma.user
              .findUniqueOrThrow({ where: { id: actorId }, include: { userRoles: true } })
              .then((user) => ({
                id: user.id,
                email: user.email,
                displayName: user.displayName,
                roles: user.userRoles.map((row) => row.role),
              }));

      // The service enters COVER_LETTER_GENERATING itself, so both this job
      // and a direct call follow the same status path.
      const result = await context.coverLetters.generate({
        engagementId,
        actor,
        correlationId: job.correlationId,
        testMode,
      });

      return { ...result };
    },

    /**
     * Filing the finished package into the client's Karbon documents.
     *
     * The last step of the whole workflow, and the one that did not exist:
     * `READY_FOR_DELIVERY` was a status nothing consumed, so an approved cover
     * letter and the final documents it encloses went nowhere.
     */
    DELIVER_COMPLETION_PACKAGE: async ({ job }) => {
      const coverLetterPackageId = requireString(job.payload, 'coverLetterPackageId');
      const { karbon } = await context.providers();
      const { testMode } = await context.testMode();

      const result = await context.completionDelivery.deliver({
        coverLetterPackageId,
        karbon,
        correlationId: job.correlationId,
        testMode,
      });

      return {
        ...result,
        userMessage: result.delivered
          ? `Filed ${Object.keys(result.fileIds).length} document(s) into the client's Karbon documents.`
          : (result.skippedReason ?? 'Nothing was delivered.'),
      };
    },

    /**
     * Bringing the firm's work items into line with where engagements have got to.
     *
     * Reconciles rather than reacting to each transition — see
     * `KarbonWorkStatusService` for why Karbon is kept out of the path that
     * changes an engagement's own status. Unmapped statuses are skipped, so an
     * unconfigured map makes this a no-op rather than a guess.
     */
    SYNC_KARBON_WORK_STATUS: async ({ job }) => {
      const { karbon } = await context.providers();
      const { testMode } = await context.testMode();
      const statusMap = await context.settings.karbonStatusMap();

      const result = await context.karbonWorkStatus.sync({
        karbon,
        statusMap,
        testMode,
        correlationId: job.correlationId,
      });

      return {
        ...result,
        userMessage: result.skippedReason ?? `Pushed ${result.pushed} work status change(s); ${result.skipped} already correct.`,
      };
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

      // `storagePath: { not: null }` is what makes this sweep finish.
      //
      // `purgeAfter` is stamped once when the document is stored and never
      // cleared, so the time filter alone selects every source document that
      // has *ever* expired — and re-selects them on every run, for ever. The
      // file delete was skipped the second time round, but the UPDATE was not:
      // each pass rewrote every historical row, bumping `updatedAt` on all of
      // them. A year in, the nightly purge was writing the whole table to
      // accomplish nothing.
      //
      // A row whose working copy is already gone has nothing left to purge, so
      // excluding it makes the working set "what expired since the last run",
      // which is what the job is for.
      const expired = await context.prisma.sourceDocument.findMany({
        where: { purgeAfter: { lt: new Date() }, storagePath: { not: null } },
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
      // Same shape of fault as above, with a consequence beyond wasted work.
      //
      // The references were never cleared after the bytes were deleted, so
      // every run re-selected the same versions, re-issued the same deletes and
      // counted them into `purged` again — the number this job reports grew on
      // every pass while nothing was actually being purged.
      //
      // Worse, the row went on saying a working copy existed. `linksFor` offers
      // a download whenever the reference is non-null, so Version History
      // showed a link for every purged version and following it found nothing.
      // Clearing the reference is what makes "no working copy" a state the
      // application can see, rather than one it discovers on a 404.
      const superseded = await context.prisma.documentVersion.findMany({
        where: {
          status: 'SUPERSEDED',
          supersededAt: { lt: cutoff },
          OR: [{ generatedDocxReference: { not: null } }, { generatedPdfReference: { not: null } }],
        },
        select: { id: true, generatedDocxReference: true, generatedPdfReference: true },
      });

      for (const version of superseded) {
        for (const reference of [version.generatedDocxReference, version.generatedPdfReference]) {
          if (reference) {
            await context.store.delete(reference).catch(() => undefined);
            purged += 1;
          }
        }

        await context.prisma.documentVersion.update({
          where: { id: version.id },
          data: { generatedDocxReference: null, generatedPdfReference: null },
        });
      }

      // A backstop, now that the bytes are rows rather than files. The passes
      // above delete what the workflow knows about; anything whose owning
      // record was removed — a deleted engagement, an abandoned upload — would
      // otherwise sit in the table for ever with nothing pointing at it.
      const orphaned = await context.store.purgeExpired();

      // The job table itself, which nothing used to sweep. Succeeded rows only
      // — a dead-lettered job is the record of what went wrong and stays until
      // somebody deletes it deliberately.
      const jobsDeleted = await context.queue.purgeSucceededJobs(context.env.JOB_RETENTION_DAYS);

      return {
        purged,
        orphaned,
        jobsDeleted,
        userMessage: `Purged ${purged} working ${purged === 1 ? 'copy' : 'copies'}, ${orphaned} orphaned, and ${jobsDeleted} finished job ${jobsDeleted === 1 ? 'record' : 'records'}.`,
      };
    },
  };
}
