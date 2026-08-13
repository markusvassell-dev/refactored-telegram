import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import type { KarbonDocumentLibrary, KarbonProvider } from '@element/integrations';
import { NotFoundError, PreconditionError, assertCan, type Logger, type Principal } from '@element/shared';

/**
 * A client's Karbon documents, catalogued.
 *
 * A client of any age has years of documents in Karbon — prior returns, working
 * papers, signed letters, notices of assessment — and until now the application
 * could see exactly one of them at a time, and only if it already knew which
 * work item to look in. Preparing an engagement meant leaving the app, opening
 * Karbon, finding the file and uploading it back. This catalogues the lot, so
 * the documents a reviewer needs are listed where they are working.
 *
 * ## Metadata, not bytes
 *
 * Nothing is downloaded here. Karbon issues a download token alongside a file
 * listing and it expires roughly fifteen minutes later, so a stored URL is a
 * link that passes every test and fails for the first person who opens it an
 * hour afterwards. Selecting a document fetches a current listing to get a
 * fresh token. That also keeps a firm's whole document history out of this
 * application's temporary storage, which exists to be purged.
 *
 * ## Why a partial answer is a wrong answer
 *
 * Karbon has no operation that returns a client's documents. Its own Documents
 * tab is an aggregate over the organization, its contacts and every work item,
 * and so is this — which for a long-standing client can be fifty-odd requests,
 * any of which can fail.
 *
 * Ninety-one documents from a complete read and ninety-one from a read that
 * lost two work items to a timeout are not the same answer, and the difference
 * is invisible in the number. So `complete` is recorded on every sync and
 * carried to the screen: a reviewer who cannot find last year's letter needs to
 * know whether it is absent or merely unlooked-for.
 */

export interface KarbonLibraryDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  logger: Logger;
}

export interface LibrarySyncResult {
  clientId: string;
  documentsFound: number;
  documentsNew: number;
  scopesRead: number;
  scopesFailed: number;
  complete: boolean;
  failures: { label: string; reason: string }[];
}

/**
 * Tax year read from a work item title — "2024 T2 Tax Return", "T1 2023".
 *
 * Returns null rather than a guess. A document filed under the wrong year is
 * offered as last year's letter when it is not, and a reviewer scanning a list
 * has no reason to doubt a year the application printed. Absent is recoverable;
 * wrong is not.
 */
export function inferTaxYear(label: string, now: Date = new Date()): number | null {
  const matches = [...label.matchAll(/\b(19|20)\d{2}\b/g)].map((match) => Number(match[0]));
  if (matches.length === 0) return null;

  // A title carrying two years ("2023-2024 file") is ambiguous about which year
  // the work belongs to, so it is left unknown rather than resolved by a rule
  // nobody agreed to.
  const distinct = [...new Set(matches)];
  if (distinct.length > 1) return null;

  const year = distinct[0] as number;
  // A "year" outside the plausible range is something else wearing a year's
  // shape — an invoice number, an address, a phone extension.
  if (year < 1990 || year > now.getFullYear() + 1) return null;
  return year;
}

export class KarbonLibraryService {
  constructor(private readonly deps: KarbonLibraryDeps) {}

  /**
   * Reads everything Karbon holds for a client and records it.
   *
   * Existing rows are updated rather than replaced, and a file Karbon no longer
   * lists keeps its row with a stale `lastSeenAt`. Deleting it would make a
   * document vanishing from Karbon indistinguishable from one that was never
   * there — and a document disappearing from a client's file is exactly the
   * kind of thing somebody needs to notice.
   */
  async sync(input: {
    clientId: string;
    karbon: KarbonProvider;
    actor?: Principal;
    maxWorkItems?: number;
  }): Promise<LibrarySyncResult> {
    if (input.actor) assertCan(input.actor, 'source_document:select');

    const client = await this.deps.prisma.client.findUnique({
      where: { id: input.clientId },
      select: { id: true, legalName: true, karbonEntityKey: true },
    });

    if (!client) throw new NotFoundError(`Client ${input.clientId}`);

    if (!client.karbonEntityKey) {
      throw new PreconditionError(
        `${client.legalName} is not linked to Karbon, so there is no document area to read. Set the client's Karbon entity key first.`,
      );
    }

    const sync = await this.deps.prisma.karbonLibrarySync.create({
      data: { clientId: client.id },
      select: { id: true },
    });

    let library: KarbonDocumentLibrary;
    try {
      library = await input.karbon.listClientLibrary(client.karbonEntityKey, {
        maxWorkItems: input.maxWorkItems,
      });
    } catch (error) {
      // The whole read failed, which is a fact worth keeping: a sync row that
      // stays unfinished for ever is harder to interpret than one that says why.
      await this.deps.prisma.karbonLibrarySync.update({
        where: { id: sync.id },
        data: {
          finishedAt: new Date(),
          complete: false,
          scopesFailed: 1,
          failureDetail: [
            { label: client.legalName, reason: error instanceof Error ? error.message : String(error) },
          ] as never,
        },
      });
      throw error;
    }

    const seenAt = new Date();
    let documentsNew = 0;

    for (const document of library.documents) {
      if (!document.documentId) continue;

      const existing = await this.deps.prisma.karbonClientDocument.findUnique({
        where: { clientId_karbonFileKey: { clientId: client.id, karbonFileKey: document.documentId } },
        select: { id: true },
      });

      const label = document.sourceLabel ?? client.legalName;
      const data = {
        fileName: document.fileName,
        sourceEntityType: document.sourceEntityType ?? 'Organization',
        sourceEntityKey: document.workItemKey ?? document.entityKey ?? client.karbonEntityKey,
        sourceLabel: label,
        byteSize: document.byteSize ?? null,
        mimeType: document.mimeType ?? null,
        uploadedAt: document.uploadedAt ? new Date(document.uploadedAt) : null,
        inferredTaxYear: inferTaxYear(label),
        lastSeenAt: seenAt,
      };

      if (existing) {
        await this.deps.prisma.karbonClientDocument.update({ where: { id: existing.id }, data });
      } else {
        documentsNew += 1;
        await this.deps.prisma.karbonClientDocument.create({
          data: { ...data, clientId: client.id, karbonFileKey: document.documentId },
        });
      }
    }

    const failures = library.failures.map((failure) => ({ label: failure.label, reason: failure.reason }));

    await this.deps.prisma.karbonLibrarySync.update({
      where: { id: sync.id },
      data: {
        finishedAt: new Date(),
        scopesRead: library.scopes.length,
        scopesFailed: library.failures.length,
        documentsFound: library.documents.length,
        documentsNew,
        complete: library.complete,
        failureDetail: failures.length > 0 ? (failures as never) : undefined,
      },
    });

    // Reading a firm's own Karbon changes nothing there, but which documents a
    // client has is worth an audit trail: it is the evidence behind what was
    // offered to a reviewer, and behind what was not.
    await this.deps.audit.record({
      eventType: 'KARBON_LIBRARY_SYNCED',
      objectType: 'Client',
      objectId: client.id,
      userId: input.actor?.id,
      afterValue: {
        documentsFound: library.documents.length,
        documentsNew,
        scopesRead: library.scopes.length,
        scopesFailed: library.failures.length,
        complete: library.complete,
      },
    });

    if (!library.complete) {
      this.deps.logger.warn('Karbon library read was incomplete; documents may be missing', {
        clientId: client.id,
        scopesFailed: library.failures.length,
      });
    }

    return {
      clientId: client.id,
      documentsFound: library.documents.length,
      documentsNew,
      scopesRead: library.scopes.length,
      scopesFailed: library.failures.length,
      complete: library.complete,
      failures,
    };
  }
}
