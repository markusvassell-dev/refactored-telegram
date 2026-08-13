import type { PrismaClient, SourceDocumentKind } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { countPdfPages, extractParagraphs, isPdf } from '@element/documents';
import { extractPdfText, verifyCandidate, type VerificationOutcome } from '@element/integrations';
import { ValidationError, type DocumentType, type EngagementType } from '@element/shared';
import type { DocumentStore } from './storage.js';

/**
 * Attaching a source document by hand.
 *
 * Everything downstream — pricing, deadlines, the prior-year comparison — reads
 * a prior-year letter that something has already located. Every automatic path
 * to one runs through Karbon, so until that connection is verified against a
 * live tenant there is no way to hand this application the file it needs.
 *
 * An uploaded file is put through exactly the same checks as one Karbon
 * supplied: its bytes must match its declared type, and its *contents* are
 * scored against the client, engagement type and year. A document is never
 * trusted because someone chose it in a file picker.
 */

export interface SourceDocumentDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  store: DocumentStore;
}

/**
 * Why a document could not be read, in words the person holding it can act on.
 *
 * pdf.js reports these as exception *names* rather than codes, and its message
 * text ("No password given") reads like an accusation of a missing input rather
 * than a description of the file. What a reviewer needs is which of two things
 * happened — the file is locked, or the file is broken — because the responses
 * are completely different: print it flat and re-attach, or go and find a good
 * copy.
 */
export function describeUnreadable(error: unknown, content: Buffer): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);

  // What the bytes actually are, not which branch happened to run.
  //
  // `DocumentStore.put` has already refused anything whose bytes disagree with
  // its declared type, so by the time this runs the file really is a PDF or a
  // DOCX. That narrows the possibilities usefully: it opened as the right
  // format and then could not be parsed.
  const looksZip = content.length > 1 && content[0] === 0x50 && content[1] === 0x4b;

  if (name === 'PasswordException' || /password/i.test(message)) {
    return (
      'This PDF needs a password to open, so nothing could be read from it. It is attached and stored, but its ' +
      'contents have not been checked — confirm what it is yourself, or attach a copy saved without the password.'
    );
  }

  if (name === 'InvalidPDFException' || /invalid pdf|xref|corrupt/i.test(message)) {
    return (
      'This file could not be opened as a PDF — it is damaged, or its internal structure is one this reader does ' +
      'not understand. It is attached and stored, but nothing has been read from it. Check the copy in Karbon opens ' +
      'correctly.'
    );
  }

  if (looksZip) {
    return (
      'This Word file could not be read; it may be damaged. It is attached and stored, but nothing has been read ' +
      `from it (${message}).`
    );
  }

  // Quotes the reader's own words. The branches above name causes seen often
  // enough to be worth naming; this one has not, so it hands over what actually
  // happened rather than inventing an explanation that sends somebody hunting
  // the wrong fault.
  return `This document could not be read (${message}). It is attached and stored, but nothing has been read from it, so confirm what it is yourself.`;
}

export interface UploadSourceDocumentInput {
  engagementId: string;
  actorId: string;
  fileName: string;
  mimeType: string;
  content: Uint8Array;
  kind: SourceDocumentKind;
  /**
   * Where this came from, when it came from Karbon rather than a file picker.
   *
   * Kept so a reviewer can tell a document pulled from the client's Karbon file
   * from one somebody found on their desktop, and so the same file arriving by
   * both routes can be recognised as the same file.
   */
  karbonDocumentId?: string | null;
  karbonWorkItemKey?: string | null;
}

export interface UploadSourceDocumentResult {
  sourceDocumentId: string;
  fileHash: string;
  /** True when this exact file was already attached under this kind. */
  duplicate: boolean;
  verificationScore: number | null;
  /** Reasons this document cannot be the one it claims to be. */
  disqualifiers: string[];
  /** True when the contents support it strongly enough to proceed unattended. */
  confident: boolean;
  confirmed: boolean;
  pageCount: number | null;
  notes: string[];
}

const DOCUMENT_TYPE_BY_ENGAGEMENT: Record<EngagementType, DocumentType> = {
  T1_JOINT: 'T1_JOINT_ENGAGEMENT_LETTER',
  T1_SINGLE: 'T1_SINGLE_ENGAGEMENT_LETTER',
  T2: 'T2_ENGAGEMENT_LETTER',
  T3: 'T3_ENGAGEMENT_LETTER',
};

/**
 * Kinds whose contents can be scored against an expectation. A trial balance
 * or a filing authorization is not an engagement letter and must not be judged
 * as though it were — it is stored and left for a person to confirm.
 */
const VERIFIABLE_KINDS: readonly SourceDocumentKind[] = ['PRIOR_YEAR_ENGAGEMENT_LETTER', 'PRIOR_YEAR_SIGNED_LETTER'];

export class SourceDocumentService {
  constructor(private readonly deps: SourceDocumentDeps) {}

  async upload(input: UploadSourceDocumentInput): Promise<UploadSourceDocumentResult> {
    if (input.content.byteLength === 0) throw new ValidationError('Choose a file to upload.');

    const engagement = await this.deps.prisma.engagement.findUniqueOrThrow({
      where: { id: input.engagementId },
      include: { client: true, karbonWorkItem: true, participants: true },
    });

    // `put` is the single choke point every stored byte passes through: it
    // checks the bytes really are the type they claim to be, enforces the size
    // limit, and blocks path traversal.
    const stored = await this.deps.store.put({
      content: input.content,
      fileName: input.fileName,
      mimeType: input.mimeType,
      scope: input.engagementId,
    });

    const existing = await this.deps.prisma.sourceDocument.findUnique({
      where: {
        engagementId_fileHash_kind: {
          engagementId: input.engagementId,
          fileHash: stored.hash,
          kind: input.kind,
        },
      },
      select: { id: true, verificationScore: true, confirmedAt: true, pageCount: true },
    });

    if (existing) {
      // The bytes are identical to something already attached, so there is
      // nothing new to read. The freshly stored copy is discarded rather than
      // left behind as an orphan.
      await this.deps.store.delete(stored.reference);

      return {
        sourceDocumentId: existing.id,
        fileHash: stored.hash,
        duplicate: true,
        verificationScore: existing.verificationScore,
        disqualifiers: [],
        confident: false,
        confirmed: existing.confirmedAt !== null,
        pageCount: existing.pageCount,
        notes: ['This exact file is already attached to this engagement.'],
      };
    }

    const buffer = Buffer.from(input.content);
    const pdf = isPdf(buffer);

    const notes: string[] = [];
    let text = '';
    let pageCount: number | null = null;

    // Reading a document can fail outright, and that is not a reason to refuse
    // to hold it.
    //
    // These three calls were unguarded, so a file the reader could not open
    // threw out of the whole action and surfaced as "Something went wrong" with
    // the reason visible only in a log. The commonest cause is the commonest
    // document: a *signed* PDF, which Acrobat routinely encrypts with an owner
    // password to lock permissions, and which pdf.js refuses to open at all.
    // Attaching last year's signed engagement letter is the main thing anybody
    // does here, so the one document most likely to be chosen was the one
    // guaranteed to fail.
    //
    // Unreadable is a fact about the document, recorded as a note. It is not a
    // free pass: `text` stays empty, so verification below scores nothing, the
    // document is attached *unconfirmed*, and a person still has to say what it
    // is. A file that cannot be read is never quietly treated as verified.
    try {
      text = pdf ? (await extractPdfText(buffer)).fullText : (await extractParagraphs(buffer)).join('\n');
    } catch (error) {
      notes.push(describeUnreadable(error, buffer));
    }

    if (pdf) {
      // Counted separately: a PDF whose text will not come out often still
      // reports its page count, and losing that to the same failure would be
      // discarding something that did work.
      try {
        pageCount = countPdfPages(buffer);
      } catch {
        pageCount = null;
      }
    }

    if (notes.length === 0 && text.trim().length === 0) {
      notes.push(
        'No text could be read from this file. It may be a scan, which this application does not read without OCR enabled.',
      );
    }

    const verification = VERIFIABLE_KINDS.includes(input.kind)
      ? verifyCandidate(
          { documentId: stored.reference, fileName: input.fileName, text, isSigned: input.kind === 'PRIOR_YEAR_SIGNED_LETTER' },
          {
            clientLegalName: engagement.client.legalName,
            engagementType: engagement.engagementType,
            documentType: DOCUMENT_TYPE_BY_ENGAGEMENT[engagement.engagementType],
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
          },
        )
      : null;

    // Choosing a file is a deliberate act, but it is not evidence about what
    // the file contains. Confirmation needs the contents to actually support
    // it: a different client's letter carries no disqualifier — it simply
    // matches almost nothing — and must not be accepted as this year's prior
    // year on the strength of someone picking it in a dialog.
    const disqualifiers = verification?.disqualifiers ?? [];
    const confirmed = verification ? verification.confident : true;

    if (!confirmed) {
      notes.push(
        disqualifiers.length > 0
          ? 'Attached but not confirmed: its contents contradict what this engagement expects.'
          : 'Attached but not confirmed: its contents do not match this client, engagement type and year closely enough. Check it is the right document.',
      );
    }

    const created = await this.deps.prisma.sourceDocument.create({
      data: {
        engagementId: input.engagementId,
        kind: input.kind,
        fileName: input.fileName,
        fileHash: stored.hash,
        byteSize: stored.byteSize,
        mimeType: stored.mimeType,
        storagePath: stored.reference,
        karbonDocumentId: input.karbonDocumentId ?? null,
        karbonWorkItemKey: input.karbonWorkItemKey ?? null,
        pageCount,
        verificationScore: verification?.score ?? null,
        verificationDetail: verification
          ? ({ signals: verification.signals, disqualifiers: verification.disqualifiers } as never)
          : undefined,
        confirmedByUserId: confirmed ? input.actorId : null,
        confirmedAt: confirmed ? new Date() : null,
        purgeAfter: stored.expiresAt,
      },
      select: { id: true },
    });

    await this.deps.audit.record({
      eventType: 'SOURCE_DOCUMENT_SELECTED',
      objectType: 'SourceDocument',
      objectId: created.id,
      engagementId: input.engagementId,
      userId: input.actorId,
      afterValue: {
        kind: input.kind,
        fileHash: stored.hash,
        byteSize: stored.byteSize,
        verificationScore: verification?.score ?? null,
        disqualifiers,
        confirmed,
      },
      reason: 'Source document uploaded by hand.',
    });

    return {
      sourceDocumentId: created.id,
      fileHash: stored.hash,
      duplicate: false,
      verificationScore: verification?.score ?? null,
      disqualifiers,
      confident: verification?.confident ?? false,
      confirmed,
      pageCount,
      notes,
    };
  }

  /** Reads back an attached document's bytes. Used by extraction. */
  async contentOf(sourceDocumentId: string): Promise<{ content: Buffer; fileName: string } | null> {
    const source = await this.deps.prisma.sourceDocument.findUnique({
      where: { id: sourceDocumentId },
      select: { fileName: true, storagePath: true },
    });

    if (!source?.storagePath) return null;

    return { content: await this.deps.store.get(source.storagePath), fileName: source.fileName };
  }
}

export type { VerificationOutcome };
