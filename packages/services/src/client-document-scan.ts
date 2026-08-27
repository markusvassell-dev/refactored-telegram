import type { PrismaClient, SourceDocumentKind } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { extractParagraphs } from '@element/documents';
import {
  classifyDocument,
  decideBulkAccept,
  extractPdfText,
  selectPriorYearDocument,
  verifyCandidate,
  DeterministicExtractor,
  type ExtractorKind,
  type KarbonProvider,
  type VerificationExpectation,
  type VerificationOutcome,
} from '@element/integrations';
import {
  ENGAGEMENT_LETTER_BY_TYPE,
  sha256Hex,
  type DocumentType,
  type Logger,
} from '@element/shared';
import { parseManifest, requiredFieldTokens } from '@element/documents';
import type { DocumentStore } from './storage.js';
import { putExtractedField } from './extracted-fields.js';
import { mergeDocumentFindings, type DocumentFinding } from './document-merge.js';
import type { JobQueue } from './jobs/queue.js';

/**
 * Reading every document a client has, rather than hunting for one.
 *
 * The prior-year search looks for a single thing — last year's engagement
 * letter — and gives up when it cannot find one, taking preparation with it.
 * That left a firm attaching documents by hand to an application that had
 * already downloaded and read them in order to score them, and then thrown the
 * text away.
 *
 * This reads the same three scopes once, and keeps what it read. Anything that
 * clears the acceptance bar has its values taken; everything else is listed
 * with its score and the reason it was passed over, so a person can accept it
 * by hand rather than guess what the application objected to.
 *
 * Two properties matter more than how much it finds.
 *
 * It never reports a partial read as a complete one. A scope that failed, a
 * file that would not open, and the document cap all land in the scan record,
 * and `complete` is false whenever any of them happened — because ninety-one
 * documents from a complete read and ninety-one from a read that lost two
 * scopes are not the same answer, and the difference is what decides whether
 * "this client has no prior-year letter" means anything.
 *
 * And it decides before it writes. `extracted_field` holds one row per token
 * per source, so forty documents cannot each leave their answer for a reviewer
 * to choose between; the choice happens in `mergeDocumentFindings`, and what
 * survives it is one value with a citation for every document that supports it.
 */

export interface ClientDocumentScanDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  store: DocumentStore;
  queue: JobQueue;
  logger: Logger;
}

export interface ScanInput {
  engagementId: string;
  karbon: KarbonProvider;
  correlationId: string;
  actorId?: string | null;
}

export interface ScanResult {
  scanId: string | null;
  documentsConsidered: number;
  documentsRead: number;
  documentsUnreadable: number;
  documentsAccepted: number;
  tokensFilled: number;
  conflictsRaised: number;
  scopesRead: number;
  scopesFailed: number;
  complete: boolean;
  cappedAt: number | null;
  /** Set when nothing could be attempted at all. */
  reason?: string;
}

/**
 * A ceiling rather than a target.
 *
 * A twenty-year client has hundreds of files, and this is the largest
 * unattended thing the application does, on a rate limit shared with everything
 * else the firm has connected. When the cap bites the scan says so rather than
 * quietly reading a prefix.
 */
export const SCAN_DOCUMENT_LIMIT = 60;

/** Which pattern set can read a document of this kind. */
function extractorFor(kind: SourceDocumentKind): ExtractorKind | null {
  switch (kind) {
    case 'PRIOR_YEAR_ENGAGEMENT_LETTER':
    case 'PRIOR_YEAR_SIGNED_LETTER':
      return 'ENGAGEMENT_LETTER';
    case 'FINAL_T2_RETURN':
    case 'NOTICE_OF_ASSESSMENT':
    case 'COMPILED_FINANCIAL_STATEMENTS':
    case 'COMPILATION_ENGAGEMENT_REPORT':
    case 'FEDERAL_FILING_AUTHORIZATION':
    case 'T1_RETURN':
    case 'T183':
      return 'CRA_SOURCE';
    default:
      // A trial balance and a payment summary carry no field this letter needs.
      // Reading them would be pattern-matching for the sake of it.
      return null;
  }
}

/** Ordered so the prior year is read first, and the cap bites the least useful. */
function byRelevance(taxYear: number) {
  return (a: { fileName: string; inferredYear: number | null }, b: { fileName: string; inferredYear: number | null }) => {
    const rank = (year: number | null): number => {
      if (year === taxYear - 1) return 0;
      if (year !== null && year >= taxYear - 3) return 1;
      if (year === null) return 2;
      return 3;
    };
    const byRank = rank(a.inferredYear) - rank(b.inferredYear);
    if (byRank !== 0) return byRank;
    return a.fileName.localeCompare(b.fileName);
  };
}

function inferYear(fileName: string): number | null {
  const match = /\b(19|20)\d{2}\b/.exec(fileName);
  return match ? Number(match[0]) : null;
}

export class ClientDocumentScanService {
  constructor(private readonly deps: ClientDocumentScanDeps) {}

  async scan(input: ScanInput): Promise<ScanResult> {
    const engagement = await this.deps.prisma.engagement.findUnique({
      where: { id: input.engagementId },
      include: { client: true, karbonWorkItem: true, participants: true },
    });

    if (!engagement) {
      return { ...empty(), reason: 'The engagement no longer exists.' };
    }

    if (!engagement.client.karbonEntityKey && !engagement.karbonWorkItem?.karbonKey) {
      return {
        ...empty(),
        reason:
          'This engagement is not linked to Karbon — neither the client nor a work item carries a Karbon key — so there is nowhere to read from. Attach documents by hand instead.',
      };
    }

    // Written before the work, so a scan the worker dies in the middle of is an
    // unfinished row rather than no record that it was ever tried.
    const scan = await this.deps.prisma.sourceDocumentScan.create({
      data: { engagementId: engagement.id },
    });

    const failures: { scope: string; reason: string }[] = [];
    const scopes = await this.scopesFor(engagement, input.karbon, failures);

    const expectation = expectationFor(engagement);
    const wantedTokens = await this.wantedTokens(engagement.engagementType);

    const candidates: Parameters<typeof selectPriorYearDocument>[0][number][] = [];
    const findings: DocumentFinding[] = [];
    let considered = 0;
    let read = 0;
    let unreadable = 0;
    let accepted = 0;
    let scopesRead = 0;
    let cappedAt: number | null = null;

    for (const scope of scopes) {
      if (considered >= SCAN_DOCUMENT_LIMIT) {
        cappedAt = SCAN_DOCUMENT_LIMIT;
        break;
      }

      let listing;
      try {
        listing = await input.karbon.listDocuments(scope);
        scopesRead += 1;
      } catch (error) {
        // Recorded, never swallowed. A scope that failed is the difference
        // between "the client has no 2019 letter" and "we could not look".
        failures.push({ scope: describeScope(scope), reason: describe(error) });
        continue;
      }

      const readable = listing
        .filter((document) => /\.(docx|pdf)$/i.test(document.fileName))
        .map((document) => ({ ...document, inferredYear: inferYear(document.fileName) }))
        .sort(byRelevance(engagement.taxYear));

      const room = SCAN_DOCUMENT_LIMIT - considered;
      const take = readable.slice(0, room);
      if (readable.length > take.length) cappedAt = SCAN_DOCUMENT_LIMIT;

      considered += take.length;
      if (take.length === 0) continue;

      const batch = await input.karbon.downloadDocuments(
        scope,
        take.map((document) => document.documentId),
      );

      for (const failure of batch.failures) {
        failures.push({ scope: describeScope(scope), reason: `${failure.documentId}: ${failure.reason}` });
      }

      for (const file of batch.files) {
        const fileHash = sha256Hex(file.content);

        const text = await readText(file.fileName, file.content);
        if (text === null) {
          unreadable += 1;
          await this.recordRefused(engagement.id, {
            documentId: file.documentId,
            fileName: file.fileName,
            fileHash,
            workItemKey: scope.workItemKey ?? null,
            kind: 'UNKNOWN',
            score: null,
            detail: {
              refusals: ['No text could be read from this document, so nothing was checked against it.'],
            },
          });
          continue;
        }

        read += 1;

        const classification = classifyDocument(file.fileName, text);
        const candidate = {
          documentId: file.documentId,
          fileName: file.fileName,
          karbonWorkItemKey: scope.workItemKey ?? null,
          text,
          isSigned: classification.kind === 'PRIOR_YEAR_SIGNED_LETTER',
        };
        candidates.push(candidate);

        const outcome = verifyCandidate(candidate, expectation);

        const decision = decideBulkAccept(outcome, { readable: true });
        const kind = (classification.kind === 'UNKNOWN' ? 'UNKNOWN' : classification.kind) as SourceDocumentKind;

        if (!decision.accepted || classification.filenameOnly) {
          await this.recordRefused(engagement.id, {
            documentId: file.documentId,
            fileName: file.fileName,
            fileHash,
            workItemKey: scope.workItemKey ?? null,
            kind,
            score: outcome.score,
            detail: {
              signals: outcome.signals,
              disqualifiers: outcome.disqualifiers,
              refusals: classification.filenameOnly
                ? [
                    ...decision.refusals,
                    'Only the filename suggested what this document is; nothing in its text did.',
                  ]
                : decision.refusals,
              identityBasis: decision.identityBasis,
              applicableWeight: outcome.applicableWeight,
              matchedWeight: outcome.matchedWeight,
              classification,
            },
          });
          continue;
        }

        accepted += 1;

        // Bytes are kept only for what was accepted: its evidence has to stay
        // openable. A refused document keeps its Karbon id and can be fetched
        // again if a person accepts it later.
        const sourceDocumentId = await this.storeAccepted(engagement.id, {
          content: file.content,
          fileName: file.fileName,
          mimeType: file.mimeType,
          fileHash,
          documentId: file.documentId,
          workItemKey: scope.workItemKey ?? null,
          kind,
          outcome,
          classification,
        });

        const extractorKind = extractorFor(kind);
        if (!extractorKind || !sourceDocumentId) continue;

        const extractor = new DeterministicExtractor(extractorKind);
        const result = await extractor.extract({
          documentId: file.documentId,
          documentHash: fileHash,
          text: { pages: [{ pageNumber: 1, text }], fullText: text, requiresOcr: false },
          wantedTokens: wantedTokens.filter((token) => extractor.supports(token)),
        });

        for (const value of result.values) {
          findings.push({
            token: value.token,
            value: value.value ?? '',
            numericValue: value.numericValue ?? null,
            dateValue: value.dateValue ?? null,
            sourceDocumentId,
            fileName: file.fileName,
            kind,
            documentScore: outcome.score,
            pageNumber: value.evidence[0]?.pageNumber ?? null,
            supportingText: value.evidence[0]?.supportingText ?? null,
          });
        }
      }
    }

    const { tokensFilled, conflictsRaised } = await this.writeFindings(engagement.id, findings, wantedTokens);
    await this.choosePriorYear(engagement.id, candidates, expectation);

    const complete = failures.length === 0 && cappedAt === null;

    const finished = await this.deps.prisma.sourceDocumentScan.update({
      where: { id: scan.id },
      data: {
        finishedAt: new Date(),
        documentsCatalogued: considered,
        documentsConsidered: considered,
        documentsRead: read,
        documentsUnreadable: unreadable,
        documentsAccepted: accepted,
        tokensFilled,
        conflictsRaised,
        scopesRead,
        scopesFailed: failures.length,
        complete,
        cappedAt,
        failureDetail: failures.length > 0 ? (failures as never) : undefined,
      },
    });

    this.deps.logger.info('Scanned a client’s documents', {
      engagementId: engagement.id,
      considered,
      accepted,
      tokensFilled,
      complete,
    });

    await this.deps.audit.record({
      eventType: 'SOURCE_DOCUMENT_SELECTED',
      objectType: 'Engagement',
      objectId: engagement.id,
      engagementId: engagement.id,
      userId: input.actorId ?? null,
      correlationId: input.correlationId,
      reason: complete
        ? `Read ${read} of ${considered} document(s) and accepted ${accepted}.`
        : `Read ${read} of ${considered} document(s), accepted ${accepted}; the read was incomplete.`,
      afterValue: { scanId: finished.id, accepted, tokensFilled, complete },
    });

    return {
      scanId: finished.id,
      documentsConsidered: considered,
      documentsRead: read,
      documentsUnreadable: unreadable,
      documentsAccepted: accepted,
      tokensFilled,
      conflictsRaised,
      scopesRead,
      scopesFailed: failures.length,
      complete,
      cappedAt,
    };
  }

  private async scopesFor(
    engagement: { taxYear: number; client: { karbonEntityKey: string | null }; karbonWorkItem: { karbonKey: string } | null },
    karbon: KarbonProvider,
    failures: { scope: string; reason: string }[],
  ): Promise<{ workItemKey?: string; entityKey?: string }[]> {
    const scopes: { workItemKey?: string; entityKey?: string }[] = [];
    if (engagement.karbonWorkItem?.karbonKey) scopes.push({ workItemKey: engagement.karbonWorkItem.karbonKey });

    if (engagement.client.karbonEntityKey) {
      try {
        const priorItems = await karbon.searchWorkItems({
          clientKey: engagement.client.karbonEntityKey,
          year: engagement.taxYear - 1,
          limit: 25,
        });
        for (const item of priorItems) scopes.push({ workItemKey: item.workItemKey });
      } catch (error) {
        failures.push({ scope: 'prior-year work items', reason: describe(error) });
      }
      scopes.push({ entityKey: engagement.client.karbonEntityKey });
    }

    return scopes;
  }

  /** The tokens this engagement's own letter declares, not every type's. */
  private async wantedTokens(engagementType: string): Promise<string[]> {
    const documentType = ENGAGEMENT_LETTER_BY_TYPE[engagementType as keyof typeof ENGAGEMENT_LETTER_BY_TYPE];
    const template = await this.deps.prisma.documentTemplate.findUnique({
      where: { documentType: documentType as DocumentType },
      include: { versions: { where: { status: 'ACTIVE' }, orderBy: { versionNumber: 'desc' }, take: 1 } },
    });

    const version = template?.versions[0];
    if (!version) return [];

    const manifest = parseManifest(version.manifest);
    // Required first, then everything else the manifest declares — the point is
    // that it is *this* letter's list, not the twenty-two-token wishlist
    // spanning T1, T2 and T3 that made every engagement report the other types'
    // fields as missing.
    return [...new Set([...requiredFieldTokens(manifest, []), ...manifest.fields.map((field) => field.token)])];
  }

  private async storeAccepted(
    engagementId: string,
    input: {
      content: Buffer;
      fileName: string;
      mimeType: string;
      fileHash: string;
      documentId: string;
      workItemKey: string | null;
      kind: SourceDocumentKind;
      outcome: VerificationOutcome;
      classification: ReturnType<typeof classifyDocument>;
    },
  ): Promise<string | null> {
    let stored;
    try {
      stored = await this.deps.store.put({
        content: input.content,
        fileName: input.fileName,
        mimeType: input.mimeType,
        scope: engagementId,
      });
    } catch (error) {
      this.deps.logger.warn('An accepted document could not be stored', {
        engagementId,
        fileName: input.fileName,
        reason: describe(error),
      });
      return null;
    }

    const detail = {
      signals: input.outcome.signals,
      disqualifiers: input.outcome.disqualifiers,
      refusals: [],
      applicableWeight: input.outcome.applicableWeight,
      matchedWeight: input.outcome.matchedWeight,
      classification: input.classification,
    };

    // By Karbon id first. Once the true kind is written, the same file under a
    // different kind would otherwise create a second row on the (engagement,
    // hash, kind) key.
    const existing = await this.deps.prisma.sourceDocument.findFirst({
      where: { engagementId, karbonDocumentId: input.documentId },
      select: { id: true },
    });

    if (existing) {
      await this.deps.prisma.sourceDocument.update({
        where: { id: existing.id },
        data: {
          kind: input.kind,
          fileHash: input.fileHash,
          storagePath: stored.reference,
          byteSize: stored.byteSize,
          mimeType: stored.mimeType,
          purgeAfter: stored.expiresAt,
          verificationScore: input.outcome.score,
          verificationDetail: detail as never,
          // No `confirmedByUserId`: that column is a foreign key to `user` and
          // there is no system row to point at. The absence is also the honest
          // record — the application accepted this, and nobody has read it.
          confirmedAt: new Date(),
        },
      });
      return existing.id;
    }

    const created = await this.deps.prisma.sourceDocument.create({
      data: {
        engagementId,
        kind: input.kind,
        fileName: input.fileName,
        karbonDocumentId: input.documentId,
        karbonWorkItemKey: input.workItemKey,
        fileHash: input.fileHash,
        storagePath: stored.reference,
        byteSize: stored.byteSize,
        mimeType: stored.mimeType,
        purgeAfter: stored.expiresAt,
        verificationScore: input.outcome.score,
        verificationDetail: detail as never,
        confirmedAt: new Date(),
      },
    });

    return created.id;
  }

  private async recordRefused(
    engagementId: string,
    input: {
      documentId: string;
      fileName: string;
      fileHash: string;
      workItemKey: string | null;
      kind: SourceDocumentKind;
      score: number | null;
      detail: unknown;
    },
  ): Promise<void> {
    const existing = await this.deps.prisma.sourceDocument.findFirst({
      where: { engagementId, karbonDocumentId: input.documentId },
      select: { id: true, confirmedAt: true },
    });

    if (existing) {
      // A document somebody has already accepted is not un-accepted by a later
      // scan disagreeing with them.
      await this.deps.prisma.sourceDocument.update({
        where: { id: existing.id },
        data: existing.confirmedAt
          ? { verificationScore: input.score }
          : { kind: input.kind, verificationScore: input.score, verificationDetail: input.detail as never },
      });
      return;
    }

    await this.deps.prisma.sourceDocument.create({
      data: {
        engagementId,
        kind: input.kind,
        fileName: input.fileName,
        karbonDocumentId: input.documentId,
        karbonWorkItemKey: input.workItemKey,
        fileHash: input.fileHash,
        verificationScore: input.score,
        verificationDetail: input.detail as never,
      },
    });
  }

  private async writeFindings(
    engagementId: string,
    findings: DocumentFinding[],
    wantedTokens: string[],
  ): Promise<{ tokensFilled: number; conflictsRaised: number }> {
    const declared = new Set(wantedTokens);
    const merged = mergeDocumentFindings(findings);

    let tokensFilled = 0;
    let conflictsRaised = 0;

    for (const entry of merged) {
      const { field, written } = await putExtractedField(this.deps.prisma, {
        engagementId,
        token: entry.token,
        source: 'PRIOR_YEAR_DOCUMENT',
        method: 'DETERMINISTIC_PATTERN',
        value: entry.value,
        valueDecimal: entry.numericValue,
        valueDate: entry.dateValue ? new Date(`${entry.dateValue}T00:00:00Z`) : null,
      });

      if (!written) continue;
      tokensFilled += 1;

      await this.deps.prisma.fieldEvidence.deleteMany({ where: { extractedFieldId: field.id } });
      for (const support of entry.corroborating) {
        await this.deps.prisma.fieldEvidence.create({
          data: {
            extractedFieldId: field.id,
            sourceDocumentId: support.sourceDocumentId,
            pageNumber: support.pageNumber ?? null,
            supportingText: support.supportingText ?? null,
          },
        });
      }

      // Only for a token the letter actually prints. The generation gate blocks
      // on any unresolved conflict, so a scan that asked fifteen questions about
      // values nothing renders would make the automatic path unusable — which is
      // the screenful of decisions `settle` exists to prevent.
      if (!entry.disagreement || !declared.has(entry.token)) continue;

      await this.deps.prisma.fieldConflict.create({
        data: {
          engagementId,
          extractedFieldId: field.id,
          token: entry.token,
          origin: 'CROSS_DOCUMENT',
          candidates: [
            {
              value: entry.value,
              source: 'PRIOR_YEAR_DOCUMENT',
              documentScore: entry.corroborating[0]?.documentScore ?? null,
              fileName: entry.corroborating[0]?.fileName ?? null,
            },
            ...entry.disagreement.map((group) => ({
              value: group.value,
              source: 'PRIOR_YEAR_DOCUMENT',
              documentScore: group.findings[0]?.documentScore ?? null,
              fileName: group.findings[0]?.fileName ?? null,
            })),
          ] as never,
          recommendedValue: entry.value,
          recommendedSource: 'PRIOR_YEAR_DOCUMENT',
          status: 'UNRESOLVED',
        },
      });

      conflictsRaised += 1;
    }

    return { tokensFilled, conflictsRaised };
  }

  /** The one document that is *the* prior-year letter, for the comparison tab. */
  private async choosePriorYear(
    engagementId: string,
    candidates: Parameters<typeof selectPriorYearDocument>[0][number][],
    expectation: VerificationExpectation,
  ): Promise<void> {
    if (candidates.length === 0) return;

    const selection = selectPriorYearDocument(candidates, expectation);
    if (!selection.selected) return;

    await this.deps.prisma.sourceDocument.updateMany({
      where: { engagementId, karbonDocumentId: selection.selected.documentId, confirmedAt: null },
      data: { confirmedAt: new Date() },
    });
  }
}

function empty(): ScanResult {
  return {
    scanId: null,
    documentsConsidered: 0,
    documentsRead: 0,
    documentsUnreadable: 0,
    documentsAccepted: 0,
    tokensFilled: 0,
    conflictsRaised: 0,
    scopesRead: 0,
    scopesFailed: 0,
    complete: false,
    cappedAt: null,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeScope(scope: { workItemKey?: string; entityKey?: string }): string {
  return scope.workItemKey ? `work item ${scope.workItemKey}` : `client ${scope.entityKey ?? 'unknown'}`;
}

async function readText(fileName: string, content: Buffer): Promise<string | null> {
  try {
    if (/\.pdf$/i.test(fileName)) {
      const extracted = await extractPdfText(content);
      // A scanned page has no text layer, and there is no OCR here. Saying so is
      // the point: reporting it as a low score sends somebody hunting for a
      // better document when what they need to know is that it has no text.
      if (extracted.requiresOcr || extracted.fullText.trim() === '') return null;
      return extracted.fullText;
    }

    const paragraphs = await extractParagraphs(content);
    const text = paragraphs.join('\n');
    return text.trim() === '' ? null : text;
  } catch {
    return null;
  }
}

function expectationFor(engagement: {
  engagementType: string;
  taxYear: number;
  yearEnd: Date | null;
  client: { legalName: string; businessNumber: string | null; trustAccountNumber: string | null };
  karbonWorkItem: { karbonKey: string } | null;
  participants: { role: string; fullLegalName: string }[];
}): VerificationExpectation {
  return {
    clientLegalName: engagement.client.legalName,
    engagementType: engagement.engagementType as VerificationExpectation['engagementType'],
    documentType: ENGAGEMENT_LETTER_BY_TYPE[
      engagement.engagementType as keyof typeof ENGAGEMENT_LETTER_BY_TYPE
    ] as DocumentType,
    priorTaxYear: engagement.taxYear - 1,
    corporationName: engagement.engagementType === 'T2' ? engagement.client.legalName : null,
    trustName: engagement.engagementType === 'T3' ? engagement.client.legalName : null,
    taxpayerNames: engagement.participants
      .filter((participant) => participant.role === 'TAXPAYER_1' || participant.role === 'TAXPAYER_2')
      .map((participant) => participant.fullLegalName),
    businessNumber: engagement.client.businessNumber,
    t3AccountNumber: engagement.client.trustAccountNumber,
    yearEndIso: engagement.yearEnd?.toISOString().slice(0, 10) ?? null,
    karbonWorkItemKey: engagement.karbonWorkItem?.karbonKey ?? null,
  };
}
