import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { ClientDirectoryService } from '@element/services';
import { PermissionError, PreconditionError, ValidationError, createLogger, type Principal } from '@element/shared';

/**
 * Typing a client's details by hand.
 *
 * `client-lookup.test.ts` covers the other route to a client's name: adopting
 * the one Karbon holds. That one needs no validation, because the value comes
 * from the vendor and the before and after are the whole explanation.
 *
 * This one does, and that is what these pin. A form is a new way for a typo to
 * reach a signed engagement letter — the doc comment on the service said so
 * before the form existed — so the refusals matter more than the successes:
 *
 *   - a value with a knowable shape is checked against it, by **the same rule
 *     the Karbon reader applies**, so a business number cannot be valid typed
 *     and invalid imported;
 *   - a column that mirrors Karbon is never written, because a field that
 *     records what a vendor said and can also be typed over stops being
 *     evidence of anything;
 *   - a blank box stores null, not `''`, because the import's backfill decides
 *     what it may fill by asking whether the stored value is a non-empty
 *     string;
 *   - a legal-name change carries a reason, because that is the string that
 *     prints on every letter the client signs.
 *
 * The trust account number tests are the ones with the most riding on them.
 * Karbon publishes no such field and nothing else in this application writes
 * one, so this service is the only route by which a T3 engagement letter can
 * ever carry the number — and there is no second source to disagree with a
 * mistake.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error' });
const service = new ClientDirectoryService({ prisma, audit, logger });

const suffix = randomUUID().slice(0, 8);
const clientIds: string[] = [];
const userIds: string[] = [];

let reviewer: Principal;
let preparer: Principal;

async function makeUser(email: string, roles: Principal['roles']): Promise<Principal> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, displayName: email.split('@')[0] as string },
    update: {},
  });
  userIds.push(user.id);
  for (const role of roles) {
    await prisma.userRole.upsert({
      where: { userId_role: { userId: user.id, role } },
      create: { userId: user.id, role },
      update: {},
    });
  }
  return { id: user.id, email: user.email, displayName: user.displayName, roles };
}

/** A distinct name per case, so one test's client cannot collide with another's. */
function aName(label: string): string {
  return `${label} ${suffix}-${randomUUID().slice(0, 6)} Ltd.`;
}

async function add(details: Parameters<typeof service.create>[0]['details']) {
  const result = await service.create({ details, actor: reviewer });
  clientIds.push(result.clientId);

  // Marked afterwards, because `isTestFixture` is deliberately not a field the
  // form can set — it decides whether a record is excluded from real work, which
  // is not a detail about the client.
  //
  // Marking it matters beyond tidiness: `checkReadiness` reports a deployment as
  // having no real clients by counting the ones that are *not* fixtures, so a
  // test that leaves unmarked clients behind silently satisfies another test's
  // precondition. That is the kind of coupling that shows up as an unrelated
  // failure weeks later.
  await prisma.client.update({ where: { id: result.clientId }, data: { isTestFixture: true } });

  return result;
}

beforeAll(async () => {
  await prisma.$connect();
  reviewer = await makeUser(`client-edit-reviewer-${suffix}@example.test`, ['REVIEWER']);
  preparer = await makeUser(`client-edit-preparer-${suffix}@example.test`, ['PREPARER']);
});

afterAll(async () => {
  await prisma.engagement.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('adding a client Karbon does not hold', () => {
  it('stores the details, links nothing to Karbon, and records who added it', async () => {
    const legalName = aName('Newly Onboarded');
    const created = await add({ legalName, city: 'Calgary', province: 'AB' });

    const stored = await prisma.client.findUniqueOrThrow({ where: { id: created.clientId } });
    expect(stored.legalName).toBe(legalName);
    expect(stored.city).toBe('Calgary');

    // Not a gap to be filled in later by typing one. A mistyped entity key
    // points this client's document reads at a different firm's client.
    expect(stored.karbonEntityKey).toBeNull();
    expect(stored.karbonFullName).toBeNull();

    const event = await prisma.auditEvent.findFirst({
      where: { objectType: 'Client', objectId: created.clientId, eventType: 'CLIENT_CREATED' },
    });
    expect(event?.userId).toBe(reviewer.id);
  });

  it('refuses a duplicate legal name, and says to edit the existing one instead', async () => {
    const legalName = aName('Only One Of These');
    await add({ legalName });

    await expect(service.create({ details: { legalName }, actor: reviewer })).rejects.toThrow(PreconditionError);

    // The message has to carry the remedy. A refusal that only says no leaves
    // the obvious workaround — a near-identical name — which is the outcome
    // being prevented.
    await expect(service.create({ details: { legalName }, actor: reviewer })).rejects.toThrow(/Edit the existing one/i);
  });
});

describe('the shapes that are checked, because a wrong value beats review', () => {
  it('stores a trust account number of the right shape, tidied', async () => {
    // The only route by which a T3 letter can carry this number at all.
    const created = await add({ legalName: aName('The Family Trust'), trustAccountNumber: 't 1234-5678' });

    const stored = await prisma.client.findUniqueOrThrow({ where: { id: created.clientId } });
    expect(stored.trustAccountNumber).toBe('T12345678');
  });

  it('refuses a trust account number that is not one', async () => {
    await expect(
      service.create({ details: { legalName: aName('Bad Trust'), trustAccountNumber: '12345678' }, actor: reviewer }),
    ).rejects.toThrow(ValidationError);

    await expect(
      service.create({ details: { legalName: aName('Bad Trust'), trustAccountNumber: 'TRUST-1' }, actor: reviewer }),
    ).rejects.toThrow(/T followed by eight digits/i);
  });

  it('applies the same business-number rule the Karbon reader applies', async () => {
    const created = await add({ legalName: aName('Nine Digits Co'), businessNumber: '123456789 RC0001' });
    const stored = await prisma.client.findUniqueOrThrow({ where: { id: created.clientId } });
    expect(stored.businessNumber).toBe('123456789 RC0001');

    // `readBusinessNumber` refuses a client code for exactly this reason: a
    // wrong business number on a signed T2 letter is worse than a blank one.
    // The form must not be the loophole.
    await expect(
      service.create({ details: { legalName: aName('Client Code Co'), businessNumber: 'GORD-001' }, actor: reviewer }),
    ).rejects.toThrow(/not a business number/i);
  });

  it('refuses a postal code Canada Post could not issue, and tidies a real one', async () => {
    const created = await add({ legalName: aName('Tidy Postcode Co'), postalCode: 't2x1a1' });
    const stored = await prisma.client.findUniqueOrThrow({ where: { id: created.clientId } });
    expect(stored.postalCode).toBe('T2X 1A1');

    // D, F, I, O, Q and U never appear in a Canadian postal code.
    await expect(
      service.create({ details: { legalName: aName('Bad Postcode Co'), postalCode: 'D2X 1A1' }, actor: reviewer }),
    ).rejects.toThrow(/not a Canadian postal code/i);
  });

  it('leaves a non-Canadian postal code alone rather than refusing it', async () => {
    // A validator that made a correct foreign address unenterable would be
    // worse than none: people work around it by typing something false.
    const created = await add({
      legalName: aName('Overseas Holdings'),
      postalCode: 'SW1A 1AA',
      country: 'United Kingdom',
    });

    const stored = await prisma.client.findUniqueOrThrow({ where: { id: created.clientId } });
    expect(stored.postalCode).toBe('SW1A 1AA');
  });

  it('reports every problem at once rather than one per submission', async () => {
    await expect(
      service.create({
        details: { legalName: aName('Several Problems'), businessNumber: 'NOPE', trustAccountNumber: 'ALSO-NOPE' },
        actor: reviewer,
      }),
    ).rejects.toThrow(/business number[\s\S]*trust account number/i);
  });
});

describe('editing what is held', () => {
  it('clears a field to null rather than an empty string', async () => {
    const created = await add({ legalName: aName('Clearable Co'), city: 'Calgary' });

    await service.update({
      clientId: created.clientId,
      details: { legalName: created.legalName, city: '' },
      actor: reviewer,
    });

    const stored = await prisma.client.findUniqueOrThrow({ where: { id: created.clientId } });

    // Load-bearing. The import's backfill fills a column only when the stored
    // value is not a non-empty string, so null means "Karbon may supply this"
    // and anything else means "leave it alone". `''` would sit between the two.
    expect(stored.city).toBeNull();
  });

  it('refuses a legal-name change with no reason, and records one that has it', async () => {
    const created = await add({ legalName: aName('Renaming Co') });
    const renamed = aName('Renamed Co');

    await expect(
      service.update({ clientId: created.clientId, details: { legalName: renamed }, actor: reviewer }),
    ).rejects.toThrow(/needs a reason/i);

    const result = await service.update({
      clientId: created.clientId,
      details: { legalName: renamed },
      reason: 'Amalgamated on 1 July, per the articles.',
      actor: reviewer,
    });

    expect(result.changed).toEqual(['legalName']);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'Client', objectId: created.clientId, eventType: 'CLIENT_UPDATED' },
      orderBy: { createdAt: 'desc' },
    });

    // Only what moved. A before/after carrying eleven identical fields buries
    // the one that changed, and the audit detail view renders these verbatim.
    expect(Object.keys(event.afterValue as Record<string, unknown>)).toEqual(['legalName']);
    expect(event.reason).toMatch(/Amalgamated/);
  });

  it('does not need a reason to fix a postcode', async () => {
    const created = await add({ legalName: aName('Postcode Fix Co'), postalCode: 'T2X 1A1' });

    const result = await service.update({
      clientId: created.clientId,
      details: { legalName: created.legalName, postalCode: 'T3H 5R8' },
      actor: reviewer,
    });

    expect(result.changed).toEqual(['postalCode']);
  });

  it('refuses a submission that changes nothing', async () => {
    const created = await add({ legalName: aName('Unchanged Co'), city: 'Calgary' });

    await expect(
      service.update({
        clientId: created.clientId,
        details: { legalName: created.legalName, city: 'Calgary' },
        actor: reviewer,
      }),
    ).rejects.toThrow(/Nothing was changed/i);
  });

  it('warns, and does not refuse, when a draft already carries the old name', async () => {
    const created = await add({ legalName: aName('Has A Draft Co') });

    const engagement = await prisma.engagement.create({
      data: {
        clientId: created.clientId,
        engagementType: 'T2',
        taxYear: 2399,
        yearEnd: new Date(Date.UTC(2399, 11, 31)),
        status: 'DRAFT_READY',
        isTestMode: true,
      },
    });
    await prisma.documentVersion.create({
      data: { engagementId: engagement.id, documentType: 'T2_ENGAGEMENT_LETTER', versionNumber: 1 },
    });

    // Not refused: a legal name genuinely changes on amalgamation, and refusing
    // would leave the firm unable to record something that really happened.
    const result = await service.update({
      clientId: created.clientId,
      details: { legalName: aName('Has A Draft Renamed') },
      reason: 'Continued into a new jurisdiction.',
      actor: reviewer,
    });

    expect(result.staleDraftWarning).toMatch(/already have a draft/i);
    expect(result.staleDraftWarning).toMatch(/regenerate/i);
  });

  it('ignores a Karbon mirror column submitted alongside the real ones', async () => {
    const created = await add({ legalName: aName('Mirror Co') });

    await prisma.client.update({
      where: { id: created.clientId },
      data: { karbonEntityKey: `KEY-${suffix}-mirror`, karbonFullName: 'What Karbon Says Ltd.' },
    });

    await service.update({
      clientId: created.clientId,
      details: {
        legalName: created.legalName,
        city: 'Edmonton',
        // Not on `ClientDetailsInput`, and must not be written whatever a
        // request posts. Cast because the type is the first line of defence and
        // this test is checking the second.
        ...({ karbonFullName: 'Typed Over Ltd.', karbonEntityKey: 'TYPED-KEY' } as Record<string, string>),
      },
      actor: reviewer,
    });

    const stored = await prisma.client.findUniqueOrThrow({ where: { id: created.clientId } });
    expect(stored.karbonFullName).toBe('What Karbon Says Ltd.');
    expect(stored.karbonEntityKey).toBe(`KEY-${suffix}-mirror`);
    expect(stored.city).toBe('Edmonton');
  });
});

describe('who may do it', () => {
  it('refuses a preparer and allows a reviewer', async () => {
    await expect(
      service.create({ details: { legalName: aName('Preparer Attempt') }, actor: preparer }),
    ).rejects.toThrow(PermissionError);

    const created = await add({ legalName: aName('Reviewer Attempt') });

    await expect(
      service.update({
        clientId: created.clientId,
        details: { legalName: created.legalName, city: 'Red Deer' },
        actor: preparer,
      }),
    ).rejects.toThrow(PermissionError);
  });
});
