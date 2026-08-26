import type { PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import { splitEntityName } from '@element/integrations';
import {
  NotFoundError,
  PreconditionError,
  ValidationError,
  assertCan,
  describeBusinessNumberProblem,
  describeLegalNameProblem,
  describePostalCodeProblem,
  describeTrustAccountNumberProblem,
  normaliseOptional,
  normalisePostalCode,
  normaliseTrustAccountNumber,
  type Logger,
  type Principal,
} from '@element/shared';

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
 * `adoptKarbonLegalName` is deliberately one operation rather than an edit form.
 * The value being adopted is Karbon's own, so the before and after are the
 * entire explanation and no typed reason could add to them; a free-text name
 * field, by contrast, is a new way for a typo to reach a signed document.
 *
 * ## Typing details by hand
 *
 * `create` and `update` are the "name that is in neither place" case that the
 * paragraph above said would deserve its own thought. Two things made it
 * necessary rather than convenient:
 *
 *   - **A trust account number is written by nothing.** It feeds
 *     `trust.account_number` on a T3 engagement letter and Karbon has no such
 *     field, so until now a T3 letter could not carry one by any route.
 *   - **A business number arrives only if Karbon happens to hold a
 *     number-shaped value.** `readBusinessNumber` correctly returns null rather
 *     than passing a client code through, which leaves a corporation whose BN is
 *     not in Karbon with no way to get one onto its letter.
 *
 * And a client Karbon does not hold at all — an entity the firm has just taken
 * on — could not be created here in any way.
 *
 * The typo worry is answered rather than waved away. Every field with a knowable
 * shape is checked against it (`@element/shared/client-fields`, the same rule
 * the Karbon reader applies), a legal-name change needs a typed reason, and the
 * columns that mirror Karbon are never writable — because a field that records
 * what the vendor said and can also be typed over stops being evidence of
 * anything, and `karbonFullName` is precisely the evidence that makes a wrong
 * stored name visible.
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

/**
 * The details a person may type. Every column here is one the firm owns.
 *
 * `karbonEntityKey`, `karbonEntityType`, `karbonFullName`, `karbonContactType`
 * and `karbonNameSyncedAt` are absent on purpose — see the note above — as is
 * `isTestFixture`, which decides whether a record is excluded from real work
 * and is not a detail about the client.
 */
export interface ClientDetailsInput {
  legalName: string;
  displayName?: string | null;
  businessNumber?: string | null;
  trustAccountNumber?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
  country?: string | null;
  clientGroup?: string | null;
}

/** The columns `create` and `update` write, and the only ones they write. */
const EDITABLE_FIELDS = [
  'legalName',
  'displayName',
  'businessNumber',
  'trustAccountNumber',
  'addressLine1',
  'addressLine2',
  'city',
  'province',
  'postalCode',
  'country',
  'clientGroup',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

type ClientDetails = { legalName: string } & Record<Exclude<EditableField, 'legalName'>, string | null>;

export interface UpdateClientResult {
  clientId: string;
  legalName: string;
  /** The fields that actually changed, for the message a person reads. */
  changed: EditableField[];
  /**
   * Set when the legal name moved and drafts already carry the old one. A
   * warning rather than a refusal: a legal name genuinely changes on
   * amalgamation or continuance, and refusing would leave the firm unable to
   * record something that really happened.
   */
  staleDraftWarning: string | null;
}

export class ClientDirectoryService {
  constructor(private readonly deps: ClientDirectoryDeps) {}

  /**
   * Normalises and checks one submission.
   *
   * Every problem is collected rather than the first one thrown, because a
   * person who fixes a postal code only to be told about the business number is
   * being made to submit the form twice to learn what it wanted.
   */
  private validate(input: ClientDetailsInput): ClientDetails {
    const problems: string[] = [];

    const legalName = input.legalName?.trim() ?? '';
    const legalNameProblem = describeLegalNameProblem(legalName);
    if (legalNameProblem) problems.push(legalNameProblem);

    const country = normaliseOptional(input.country);

    const businessNumber = normaliseOptional(input.businessNumber);
    if (businessNumber) {
      const problem = describeBusinessNumberProblem(businessNumber);
      if (problem) problems.push(problem);
    }

    const trustAccountNumberRaw = normaliseOptional(input.trustAccountNumber);
    if (trustAccountNumberRaw) {
      const problem = describeTrustAccountNumberProblem(trustAccountNumberRaw);
      if (problem) problems.push(problem);
    }

    const postalCodeRaw = normaliseOptional(input.postalCode);
    if (postalCodeRaw) {
      const problem = describePostalCodeProblem(postalCodeRaw, country);
      if (problem) problems.push(problem);
    }

    if (problems.length > 0) {
      throw new ValidationError(problems.join(' '), { problems });
    }

    return {
      legalName,
      displayName: normaliseOptional(input.displayName),
      businessNumber,
      trustAccountNumber: trustAccountNumberRaw ? normaliseTrustAccountNumber(trustAccountNumberRaw) : null,
      addressLine1: normaliseOptional(input.addressLine1),
      addressLine2: normaliseOptional(input.addressLine2),
      city: normaliseOptional(input.city),
      province: normaliseOptional(input.province),
      postalCode: postalCodeRaw ? normalisePostalCode(postalCodeRaw, country) : null,
      country,
      clientGroup: normaliseOptional(input.clientGroup),
    };
  }

  /**
   * A client the firm acts for that Karbon does not hold.
   *
   * Created with no `karbonEntityKey`, and that is not a gap to fill later by
   * typing one: a mistyped key would point this client's document reads at a
   * different firm's client. The link has a correct source, which is the import.
   */
  async create(input: { details: ClientDetailsInput; actor: Principal }): Promise<{ clientId: string; legalName: string }> {
    assertCan(input.actor, 'client:manage');

    const details = this.validate(input.details);

    // Two clients under one legal name silently split that client's engagement
    // history in two — prior-year lookups find the wrong half, and nothing
    // reports it. Worth the friction of being told, and the message says what to
    // do instead rather than only refusing.
    const existing = await this.deps.prisma.client.findFirst({
      where: { legalName: details.legalName },
      select: { id: true, karbonEntityKey: true },
    });

    if (existing) {
      throw new PreconditionError(
        `A client is already stored under “${details.legalName}”${
          existing.karbonEntityKey ? ', imported from Karbon' : ''
        }. Adding a second would split that client's engagement history between the two. Edit the existing one instead.`,
        { existingClientId: existing.id },
      );
    }

    const client = await this.deps.prisma.client.create({ data: details });

    await this.deps.audit.record({
      eventType: 'CLIENT_CREATED',
      objectType: 'Client',
      objectId: client.id,
      userId: input.actor.id,
      afterValue: { ...details },
      reason: 'Client added by hand. Not linked to Karbon.',
    });

    this.deps.logger.info('Client created by hand', { clientId: client.id });

    return { clientId: client.id, legalName: client.legalName };
  }

  /**
   * Corrects the details this application holds for a client.
   *
   * A legal-name change needs a typed reason and nothing else does. That field
   * is the one the doc comment above worried about and the one that prints on a
   * signed document; demanding a sentence to fix a postcode would be friction
   * that teaches people to type "." into reason boxes, which costs the trail
   * more than it gains.
   */
  async update(input: {
    clientId: string;
    details: ClientDetailsInput;
    reason?: string | null;
    actor: Principal;
  }): Promise<UpdateClientResult> {
    assertCan(input.actor, 'client:manage');

    const before = await this.deps.prisma.client.findUnique({
      where: { id: input.clientId },
      select: {
        id: true,
        legalName: true,
        displayName: true,
        businessNumber: true,
        trustAccountNumber: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        province: true,
        postalCode: true,
        country: true,
        clientGroup: true,
      },
    });

    if (!before) throw new NotFoundError('That client no longer exists.');

    const details = this.validate(input.details);

    const changed = EDITABLE_FIELDS.filter((field) => (before[field] ?? null) !== (details[field] ?? null));

    if (changed.length === 0) {
      // Refused rather than written, for the same reason `adoptKarbonLegalName`
      // refuses a no-op: an audit entry for a change that never happened is a
      // false record, and reporting success teaches the reader the button did
      // something.
      throw new PreconditionError('Nothing was changed.');
    }

    const reason = normaliseOptional(input.reason);

    if (changed.includes('legalName') && (reason === null || reason.length < 10)) {
      throw new ValidationError(
        `Changing a legal name needs a reason. “${before.legalName}” is what prints on every letter this client signs, and the trail has to say why it moved.`,
      );
    }

    const staleDraftWarning = changed.includes('legalName')
      ? await this.describeStaleDrafts(before.id, before.legalName)
      : null;

    await this.deps.prisma.client.update({ where: { id: before.id }, data: details });

    // Only what moved. The audit detail view renders these as JSON, and a
    // before/after carrying eleven identical fields buries the one that changed.
    const beforeChanged = Object.fromEntries(changed.map((field) => [field, before[field] ?? null]));
    const afterChanged = Object.fromEntries(changed.map((field) => [field, details[field] ?? null]));

    await this.deps.audit.record({
      eventType: 'CLIENT_UPDATED',
      objectType: 'Client',
      objectId: before.id,
      userId: input.actor.id,
      beforeValue: beforeChanged,
      afterValue: afterChanged,
      reason: reason ?? `Client details edited: ${changed.join(', ')}.`,
    });

    this.deps.logger.info('Client details edited', { clientId: before.id, changed });

    return { clientId: before.id, legalName: details.legalName, changed, staleDraftWarning };
  }

  /**
   * Whether a rendered draft already carries the old name.
   *
   * The name is baked into a generated document, so a change here does not
   * reach one that already exists. Saying so is the difference between a
   * correction that lands and one that quietly does not.
   */
  private async describeStaleDrafts(clientId: string, previousLegalName: string): Promise<string | null> {
    const affected = await this.deps.prisma.engagement.count({
      where: {
        clientId,
        documentVersions: { some: {} },
        status: { notIn: ['COMPLETE', 'DELIVERED', 'SIGNED'] },
      },
    });

    if (affected === 0) return null;

    return `${affected} engagement(s) already have a draft carrying “${previousLegalName}”. A generated document does not change when this record does — regenerate them before anyone approves one.`;
  }

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
