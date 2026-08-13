import type { EngagementType, ParticipantRole, PrismaClient } from '@element/database';
import type { AuditLogger } from '@element/audit';
import {
  NotFoundError,
  PreconditionError,
  ValidationError,
  assertCan,
  type Logger,
  type Principal,
} from '@element/shared';

/**
 * Who signs an engagement letter, and in what order.
 *
 * Until this existed, nothing in the application could create an
 * `EngagementParticipant`. The table was written only by the demo seed, so on a
 * real engagement it was always empty — and that single absence is what made
 * signing impossible. `evaluateSendGate` refuses an engagement with no signers,
 * so `sendForSignature` could never run; the "record signed elsewhere" bridge
 * refused for the same reason, telling the reviewer this engagement "names
 * nobody who must sign" and offering no way to name anybody. A whole approved
 * letter could be produced and then had nowhere to go.
 *
 * ## Proposed, then confirmed
 *
 * Signers are proposed from the client's Karbon contacts, because that is where
 * the firm already maintains them, and retyping a name and address that Karbon
 * holds is how a letter reaches the wrong person. But a proposal is not a
 * decision: a proposed signer arrives `contactConfirmed: false`, and the send
 * gate refuses until a human has looked at each one. Karbon's contact list is
 * evidence about who to write to, not authority to write to them.
 *
 * ## The firm signs first
 *
 * The firm countersigns before the letter reaches the client, so the client
 * receives a letter the firm has already signed. That is the firm's stated
 * requirement and it is the reason `signingOrder` matters here rather than
 * being decoration: order 1 is the firm, order 2 is the client. Adobe releases
 * a document to order 2 only once order 1 has signed.
 *
 * ## One participant per role
 *
 * The table carries `@@unique([engagementId, role])`, so an engagement holds at
 * most one signing officer, one first taxpayer, one firm signer. Every write
 * here keys on `(engagementId, role)` for that reason — a "second" signing
 * officer is a correction of the first, not an addition, and treating it as an
 * addition would fail at the database with an error nobody could act on.
 */

export interface ParticipantServiceDeps {
  prisma: PrismaClient;
  audit: AuditLogger;
  logger: Logger;
}

/** Order 1 is the firm; order 2 is the client. See the note above. */
export const FIRM_SIGNING_ORDER = 1;
export const CLIENT_SIGNING_ORDER = 2;

/**
 * The client-side signing roles each engagement type expects.
 *
 * A T1 joint letter needs both spouses; a T2 needs the authorised signing
 * officer. Used to tell a reviewer which signer is still missing, rather than
 * failing at send time with a generic refusal.
 */
export const REQUIRED_CLIENT_ROLES: Readonly<Record<EngagementType, readonly ParticipantRole[]>> = {
  T1_JOINT: ['TAXPAYER_1', 'TAXPAYER_2'],
  T1_SINGLE: ['TAXPAYER_1'],
  T2: ['AUTHORIZED_SIGNING_OFFICER'],
  T3: ['AUTHORIZED_REPRESENTATIVE'],
};

/** Roles that sign. Everything else on the enum is a recipient or an owner. */
const SIGNING_ROLES: readonly ParticipantRole[] = [
  'TAXPAYER_1',
  'TAXPAYER_2',
  'AUTHORIZED_SIGNING_OFFICER',
  'AUTHORIZED_REPRESENTATIVE',
  'FIRM_SIGNER',
];

export function isSigningRole(role: ParticipantRole): boolean {
  return SIGNING_ROLES.includes(role);
}

/** Shape-only. A signer with an unusable address is worse than a missing one. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface UpsertParticipantInput {
  engagementId: string;
  actor: Principal;
  role: ParticipantRole;
  fullLegalName: string;
  email?: string | null;
  title?: string | null;
  telephone?: string | null;
  /** Set when this person came from the client's Karbon contact list. */
  clientContactId?: string | null;
}

export interface ParticipantView {
  id: string;
  role: ParticipantRole;
  fullLegalName: string;
  email: string | null;
  title: string | null;
  signingOrder: number;
  isSigner: boolean;
  contactConfirmed: boolean;
  /** True when this row came from a Karbon contact rather than being typed. */
  fromKarbon: boolean;
}

export class ParticipantService {
  constructor(private readonly deps: ParticipantServiceDeps) {}

  async list(engagementId: string): Promise<ParticipantView[]> {
    const rows = await this.deps.prisma.engagementParticipant.findMany({
      where: { engagementId },
      orderBy: [{ signingOrder: 'asc' }, { role: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      fullLegalName: row.fullLegalName,
      email: row.email,
      title: row.title,
      signingOrder: row.signingOrder,
      isSigner: row.isSigner,
      contactConfirmed: row.contactConfirmed,
      fromKarbon: row.clientContactId !== null,
    }));
  }

  /**
   * Adds a signer, or corrects the one already holding that role.
   *
   * Editing resets `contactConfirmed`. Changing the address a legal document
   * will be sent to is exactly the moment a previous confirmation stops meaning
   * anything, and carrying it forward would let an unreviewed address inherit a
   * reviewer's approval of a different one.
   */
  async upsert(input: UpsertParticipantInput): Promise<{ id: string; created: boolean }> {
    assertCan(input.actor, 'field:edit_structured');

    const engagement = await this.deps.prisma.engagement.findUnique({
      where: { id: input.engagementId },
      select: { id: true, engagementType: true, status: true },
    });
    if (!engagement) throw new NotFoundError(`Engagement ${input.engagementId}`);

    this.assertEditable(engagement.status);

    const fullLegalName = input.fullLegalName.trim();
    if (!fullLegalName) throw new ValidationError('A signer needs a full legal name.');

    const email = input.email?.trim() || null;
    // A signer must be reachable. A blank address is caught at the gate rather
    // than here, so a half-finished row can be saved and completed later — but
    // a malformed one is rejected now, while the person who typed it is looking
    // at it.
    if (email && !EMAIL_SHAPE.test(email)) {
      throw new ValidationError(`"${email}" is not a usable email address.`);
    }

    const signs = isSigningRole(input.role);

    const data = {
      fullLegalName,
      email,
      title: input.title?.trim() || null,
      telephone: input.telephone?.trim() || null,
      clientContactId: input.clientContactId ?? null,
      isSigner: signs,
      signingOrder: input.role === 'FIRM_SIGNER' ? FIRM_SIGNING_ORDER : CLIENT_SIGNING_ORDER,
      contactConfirmed: false,
    };

    const existing = await this.deps.prisma.engagementParticipant.findUnique({
      where: { engagementId_role: { engagementId: input.engagementId, role: input.role } },
      select: { id: true },
    });

    const row = existing
      ? await this.deps.prisma.engagementParticipant.update({ where: { id: existing.id }, data })
      : await this.deps.prisma.engagementParticipant.create({
          data: { ...data, engagementId: input.engagementId, role: input.role },
        });

    await this.deps.audit.record({
      eventType: 'PARTICIPANT_RECORDED',
      objectType: 'EngagementParticipant',
      objectId: row.id,
      engagementId: input.engagementId,
      userId: input.actor.id,
      afterValue: {
        role: input.role,
        fullLegalName,
        email,
        signingOrder: data.signingOrder,
        isSigner: signs,
        // Recorded because it is the difference between a name a person typed
        // and one the firm's own CRM supplied.
        fromKarbon: data.clientContactId !== null,
      },
    });

    return { id: row.id, created: existing === null };
  }

  /**
   * Records that a human has checked this signer's name and address.
   *
   * Separate from editing, and deliberately a different permission: entering a
   * name is clerical, and vouching for where a client's engagement letter will
   * be sent is not.
   */
  async confirm(input: {
    engagementId: string;
    participantId: string;
    actor: Principal;
    confirmed: boolean;
  }): Promise<void> {
    assertCan(input.actor, 'signing:send');

    const participant = await this.deps.prisma.engagementParticipant.findUnique({
      where: { id: input.participantId },
      select: { id: true, engagementId: true, email: true, fullLegalName: true, role: true },
    });

    if (!participant || participant.engagementId !== input.engagementId) {
      throw new NotFoundError(`Participant ${input.participantId}`);
    }

    if (input.confirmed && !EMAIL_SHAPE.test(participant.email ?? '')) {
      throw new PreconditionError(
        `${participant.fullLegalName} has no usable email address, so there is nothing to confirm. Add one first.`,
      );
    }

    await this.deps.prisma.engagementParticipant.update({
      where: { id: participant.id },
      data: { contactConfirmed: input.confirmed },
    });

    await this.deps.audit.record({
      eventType: 'PARTICIPANT_CONFIRMED',
      objectType: 'EngagementParticipant',
      objectId: participant.id,
      engagementId: input.engagementId,
      userId: input.actor.id,
      afterValue: { role: participant.role, email: participant.email, confirmed: input.confirmed },
    });
  }

  async remove(input: { engagementId: string; participantId: string; actor: Principal }): Promise<void> {
    assertCan(input.actor, 'field:edit_structured');

    const participant = await this.deps.prisma.engagementParticipant.findUnique({
      where: { id: input.participantId },
      select: { id: true, engagementId: true, role: true, fullLegalName: true },
    });

    if (!participant || participant.engagementId !== input.engagementId) {
      throw new NotFoundError(`Participant ${input.participantId}`);
    }

    const engagement = await this.deps.prisma.engagement.findUniqueOrThrow({
      where: { id: input.engagementId },
      select: { status: true },
    });
    this.assertEditable(engagement.status);

    await this.deps.prisma.engagementParticipant.delete({ where: { id: participant.id } });

    await this.deps.audit.record({
      eventType: 'PARTICIPANT_RECORDED',
      objectType: 'EngagementParticipant',
      objectId: participant.id,
      engagementId: input.engagementId,
      userId: input.actor.id,
      beforeValue: { role: participant.role, fullLegalName: participant.fullLegalName },
      afterValue: { removed: true },
    });
  }

  /**
   * Which expected signers are still missing or unconfirmed.
   *
   * Shown on the engagement rather than discovered at send time, because "this
   * cannot be sent" is only useful alongside "and here is what is missing".
   */
  async outstanding(engagementId: string): Promise<string[]> {
    const engagement = await this.deps.prisma.engagement.findUnique({
      where: { id: engagementId },
      select: { engagementType: true },
    });
    if (!engagement) return [];

    const participants = await this.deps.prisma.engagementParticipant.findMany({
      where: { engagementId },
      select: { role: true, email: true, contactConfirmed: true, fullLegalName: true },
    });

    const byRole = new Map(participants.map((participant) => [participant.role, participant]));
    const notes: string[] = [];

    for (const role of REQUIRED_CLIENT_ROLES[engagement.engagementType]) {
      if (!byRole.has(role)) notes.push(`No ${describeRole(role)} has been named.`);
    }

    if (!byRole.has('FIRM_SIGNER')) {
      notes.push('No firm signer has been named, so nobody signs before this goes to the client.');
    }

    for (const participant of participants) {
      if (!isSigningRole(participant.role)) continue;
      if (!EMAIL_SHAPE.test(participant.email ?? '')) {
        notes.push(`${participant.fullLegalName} has no usable email address.`);
      } else if (!participant.contactConfirmed) {
        notes.push(`${participant.fullLegalName} has not been confirmed.`);
      }
    }

    return notes;
  }

  /**
   * Signers are settled before a document goes out, not after.
   *
   * Once an agreement exists, changing who signs it here would leave the
   * application describing a different set of people from the one Adobe is
   * actually asking — and the record of who was asked is the point.
   */
  private assertEditable(status: string): void {
    const closed = ['SENDING_FOR_SIGNATURE', 'SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED', 'SIGNED', 'COMPLETE'];
    if (closed.includes(status)) {
      throw new PreconditionError(
        `Signers cannot be changed once the letter has gone out for signature (this one is ${status
          .replace(/_/g, ' ')
          .toLowerCase()}). Cancel the signature request first.`,
      );
    }
  }
}

export function describeRole(role: ParticipantRole): string {
  switch (role) {
    case 'TAXPAYER_1':
      return 'first taxpayer';
    case 'TAXPAYER_2':
      return 'second taxpayer';
    case 'AUTHORIZED_SIGNING_OFFICER':
      return 'authorised signing officer';
    case 'AUTHORIZED_REPRESENTATIVE':
      return 'authorised representative';
    case 'FIRM_SIGNER':
      return 'firm signer';
    default:
      return role.replace(/_/g, ' ').toLowerCase();
  }
}
