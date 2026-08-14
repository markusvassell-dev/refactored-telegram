import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { createLogger, type Principal } from '@element/shared';
import { ParticipantService } from '@element/services';

/**
 * Naming the people who sign.
 *
 * Until this service existed, nothing in the application could create an
 * `EngagementParticipant` — the table was written only by the demo seed. On a
 * real engagement it was therefore always empty, and `evaluateSendGate` refuses
 * an engagement with no signers, so an approved letter had nowhere to go by
 * either route: Adobe could not be asked, and the manual "record signed
 * elsewhere" bridge refused too, telling the reviewer this engagement "names
 * nobody who must sign" while offering no way to name anybody.
 *
 * The behaviour worth pinning is not that a row can be written. It is the
 * confirmation rules, because those are what stand between a reviewer's
 * approval and a client's letter reaching the wrong address.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error', base: { service: 'test' } });
const participants = new ParticipantService({ prisma, audit, logger });

const clientIds: string[] = [];
let editor: Principal;
let sender: Principal;

async function newEngagement(
  engagementType: 'T2' | 'T1_JOINT' = 'T2',
  // Set at creation rather than by transition: the database enforces the state
  // machine on update, and refuses NOT_STARTED -> SENT_FOR_SIGNATURE outright.
  status: 'NOT_STARTED' | 'SENT_FOR_SIGNATURE' = 'NOT_STARTED',
): Promise<string> {
  const client = await prisma.client.create({
    data: { legalName: `Signer Test ${Date.now()}-${Math.random()}`, isTestFixture: true },
  });
  clientIds.push(client.id);

  const engagement = await prisma.engagement.create({
    data: {
      clientId: client.id,
      engagementType,
      taxYear: 2026,
      yearEnd: new Date(Date.UTC(2026, 2, 31)),
      status,
      isTestMode: true,
    },
  });

  return engagement.id;
}

beforeAll(async () => {
  await prisma.$connect();

  const user = await prisma.user.upsert({
    where: { email: 'participant-test@example.test' },
    create: { email: 'participant-test@example.test', displayName: 'Participant Test' },
    update: {},
  });

  editor = { id: user.id, email: user.email, displayName: user.displayName, roles: ['PREPARER'] } as Principal;
  sender = {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: ['PARTNER_OR_FINAL_APPROVER'],
  } as Principal;
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.$disconnect();
});

describe('naming a signer', () => {
  it('creates one, unconfirmed, so nothing can be sent on the strength of typing a name', async () => {
    const engagementId = await newEngagement();

    const result = await participants.upsert({
      engagementId,
      actor: editor,
      role: 'AUTHORIZED_SIGNING_OFFICER',
      fullLegalName: 'Sam Officer',
      email: 'sam@example.test',
      title: 'President',
    });

    expect(result.created).toBe(true);

    const [row] = await participants.list(engagementId);
    expect(row?.fullLegalName).toBe('Sam Officer');
    expect(row?.isSigner).toBe(true);
    // Entering a name is not vouching for it.
    expect(row?.contactConfirmed).toBe(false);
  });

  it('puts the firm ahead of the client, because the firm signs before it goes out', async () => {
    const engagementId = await newEngagement();

    await participants.upsert({
      engagementId,
      actor: editor,
      role: 'AUTHORIZED_SIGNING_OFFICER',
      fullLegalName: 'Sam Officer',
      email: 'sam@example.test',
    });
    await participants.upsert({
      engagementId,
      actor: editor,
      role: 'FIRM_SIGNER',
      fullLegalName: 'Daryn Partner',
      email: 'daryn@firm.test',
    });

    const rows = await participants.list(engagementId);
    const firm = rows.find((row) => row.role === 'FIRM_SIGNER');
    const officer = rows.find((row) => row.role === 'AUTHORIZED_SIGNING_OFFICER');

    // Adobe releases a document to order 2 only once order 1 has signed, so
    // this ordering is the whole of "we sign before the client sees it".
    expect(firm?.signingOrder).toBe(1);
    expect(officer?.signingOrder).toBe(2);
    expect(rows[0]?.role).toBe('FIRM_SIGNER');
  });

  it('corrects the person already holding a role rather than adding a second', async () => {
    const engagementId = await newEngagement();

    await participants.upsert({
      engagementId,
      actor: editor,
      role: 'AUTHORIZED_SIGNING_OFFICER',
      fullLegalName: 'First Guess',
      email: 'first@example.test',
    });
    const second = await participants.upsert({
      engagementId,
      actor: editor,
      role: 'AUTHORIZED_SIGNING_OFFICER',
      fullLegalName: 'Actually This Person',
      email: 'actual@example.test',
    });

    expect(second.created).toBe(false);

    // The table carries @@unique([engagementId, role]); treating a correction
    // as an addition would fail at the database with an error nobody could act
    // on.
    const rows = await participants.list(engagementId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fullLegalName).toBe('Actually This Person');
  });

  it('refuses an email address that could not receive anything', async () => {
    const engagementId = await newEngagement();

    await expect(
      participants.upsert({
        engagementId,
        actor: editor,
        role: 'AUTHORIZED_SIGNING_OFFICER',
        fullLegalName: 'Sam Officer',
        email: 'not-an-address',
      }),
    ).rejects.toThrow(/not a usable email/i);
  });
});

describe('confirming a signer', () => {
  it('clears the confirmation when the details change afterwards', async () => {
    const engagementId = await newEngagement();

    const created = await participants.upsert({
      engagementId,
      actor: editor,
      role: 'AUTHORIZED_SIGNING_OFFICER',
      fullLegalName: 'Sam Officer',
      email: 'sam@example.test',
    });

    await participants.confirm({ engagementId, participantId: created.id, actor: sender, confirmed: true });
    expect((await participants.list(engagementId))[0]?.contactConfirmed).toBe(true);

    // Someone corrects the address after it was approved.
    await participants.upsert({
      engagementId,
      actor: editor,
      role: 'AUTHORIZED_SIGNING_OFFICER',
      fullLegalName: 'Sam Officer',
      email: 'different@example.test',
    });

    // The reviewer approved a different address. Carrying the confirmation
    // forward would let an unreviewed address inherit approval of another one —
    // which is exactly how a client's engagement letter reaches a stranger.
    expect((await participants.list(engagementId))[0]?.contactConfirmed).toBe(false);
  });

  it('refuses to confirm somebody with no address', async () => {
    const engagementId = await newEngagement();

    const created = await participants.upsert({
      engagementId,
      actor: editor,
      role: 'AUTHORIZED_SIGNING_OFFICER',
      fullLegalName: 'Nameless Address',
    });

    await expect(
      participants.confirm({ engagementId, participantId: created.id, actor: sender, confirmed: true }),
    ).rejects.toThrow(/no usable email/i);
  });

  it('needs a different permission from editing', async () => {
    const engagementId = await newEngagement();

    const created = await participants.upsert({
      engagementId,
      actor: editor,
      role: 'AUTHORIZED_SIGNING_OFFICER',
      fullLegalName: 'Sam Officer',
      email: 'sam@example.test',
    });

    // Typing a name is clerical; standing behind where a client's engagement
    // letter will be sent is not.
    await expect(
      participants.confirm({ engagementId, participantId: created.id, actor: editor, confirmed: true }),
    ).rejects.toThrow();
  });
});

describe('what is still outstanding', () => {
  it('names the missing people rather than reporting a count', async () => {
    const engagementId = await newEngagement('T1_JOINT');

    await participants.upsert({
      engagementId,
      actor: editor,
      role: 'TAXPAYER_1',
      fullLegalName: 'Alex Taxpayer',
      email: 'alex@example.test',
    });

    const notes = await participants.outstanding(engagementId);

    // "This cannot be sent" is only useful next to "and here is what is
    // missing".
    expect(notes.join(' ')).toMatch(/second taxpayer/i);
    expect(notes.join(' ')).toMatch(/firm signer/i);
    expect(notes.join(' ')).toMatch(/Alex Taxpayer has not been confirmed/i);
  });
});

describe('once the letter has gone out', () => {
  it('refuses to change who signs it', async () => {
    const engagementId = await newEngagement('T2', 'SENT_FOR_SIGNATURE');

    // Changing the signers now would leave the application describing a
    // different set of people from the one Adobe is actually asking — and who
    // was asked is the record that matters.
    await expect(
      participants.upsert({
        engagementId,
        actor: editor,
        role: 'AUTHORIZED_SIGNING_OFFICER',
        fullLegalName: 'Someone Else',
        email: 'else@example.test',
      }),
    ).rejects.toThrow(/gone out for signature/i);
  });
});
