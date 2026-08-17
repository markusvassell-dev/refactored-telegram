import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { splitEntityName } from '@element/integrations';
import { NotFoundError, PreconditionError, assertCan, type Logger, type Principal } from '@element/shared';

/**
 * Correcting what this application believes a client is called.
 *
 * Nothing here could change a client's legal name. The only code that ever
 * wrote to a client record was the import, and it fills blanks only — so a
 * client stored under its storefront name rather than its numbered company was
 * stuck that way, and would have printed that way on every letter it signed.
 * The import even knew: it read Karbon, computed the difference, reported it,
 * and moved on, exactly as designed. What was missing was the other half of
 * "reported so you can decide" — a way to decide.
 *
 * Deliberately one operation rather than an edit form. The value being adopted
 * is Karbon's own, so the before and after are the entire explanation and no
 * typed reason could add to them; a free-text name field, by contrast, is a new
 * way for a typo to reach a signed document. If the firm ever needs a name that
 * is in neither place, that is a different feature and deserves its own thought.
 */

export interface ClientDirectoryDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  logger: Logger;
}

export interface AdoptKarbonLegalNameResult {
  clientId: string;
  previousLegalName: string;
  legalName: string;
  /** Set when the trading name was also stored, having been blank before. */
  displayNameFilled: string | null;
}

export class ClientDirectoryService {
  constructor(private readonly deps: ClientDirectoryDeps) {}

  async adoptKarbonLegalName(input: {
    clientId: string;
    actor: Principal;
  }): Promise<AdoptKarbonLegalNameResult> {
    assertCan(input.actor, 'client:correct');

    const client = await this.deps.prisma.client.findUnique({
      where: { id: input.clientId },
      select: { id: true, legalName: true, displayName: true, karbonFullName: true },
    });

    if (!client) throw new NotFoundError('That client no longer exists.');

    if (!client.karbonFullName) {
      throw new PreconditionError(
        'No Karbon name has been read for this client, so there is nothing to adopt. Import the clients from Karbon and try again.',
      );
    }

    // The same split the import uses, so the two cannot disagree about what the
    // legal half of a Karbon name is.
    const { legalName, tradeName } = splitEntityName(client.karbonFullName);

    if (legalName.length === 0) {
      throw new PreconditionError(
        `Karbon holds “${client.karbonFullName}” for this client, which does not yield a legal name.`,
      );
    }

    if (legalName === client.legalName) {
      // Refused rather than written. A no-op that reports success teaches the
      // reader that the button did something, and the audit trail would carry an
      // entry for a change that never happened.
      throw new PreconditionError('This client already carries the legal name Karbon holds. Nothing to change.');
    }

    // Only when blank. The trading name is a nicety and the legal name is the
    // point; overwriting a display name somebody chose, in the middle of an
    // operation about a different field, would be the same overreach the import
    // is careful to avoid.
    const displayNameFilled =
      tradeName && (client.displayName === null || client.displayName.trim().length === 0) ? tradeName : null;

    await this.deps.prisma.client.update({
      where: { id: client.id },
      data: {
        legalName,
        ...(displayNameFilled ? { displayName: displayNameFilled } : {}),
      },
    });

    await this.deps.audit.record({
      eventType: 'CLIENT_LEGAL_NAME_CORRECTED',
      objectType: 'Client',
      objectId: client.id,
      userId: input.actor.id,
      beforeValue: { legalName: client.legalName, displayName: client.displayName },
      afterValue: {
        legalName,
        displayName: displayNameFilled ?? client.displayName,
        karbonFullName: client.karbonFullName,
      },
      reason: 'Adopted the legal name Karbon holds for this client.',
    });

    this.deps.logger.info('Client legal name corrected from Karbon', {
      clientId: client.id,
      previousLegalName: client.legalName,
      legalName,
    });

    return {
      clientId: client.id,
      previousLegalName: client.legalName,
      legalName,
      displayNameFilled,
    };
  }
}
