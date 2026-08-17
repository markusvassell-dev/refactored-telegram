import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { ClientDirectoryService } from '@element/services';
import { PermissionError, PreconditionError, createLogger, type Principal } from '@element/shared';
import { clientSearchWhere } from '../../apps/web/src/lib/client-search';

/**
 * Finding a client, and correcting the name that would print on their letter.
 *
 * The live tenant produced the case these tests are built on. Karbon holds
 * `2409116 Alberta Ltd. (Lava Grill Seton)`. This application already held that
 * client — under `Lava Grill Seton`, because it was created before names were
 * separated — and the import will not overwrite a legal name somebody may have
 * corrected on purpose. So it reported a difference and moved on, and the wrong
 * name stayed, with nothing in the application able to change it.
 *
 * Two halves, both required: the name Karbon holds has to be kept so it can be
 * searched and shown, and there has to be a way to accept it.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error' });
const service = new ClientDirectoryService({ prisma, audit, logger });

const suffix = randomUUID().slice(0, 8);
const KARBON_FULL_NAME = '2409116 Alberta Ltd. (Lava Grill Seton)';

let reviewer: Principal;
let preparer: Principal;
let clientId: string;

async function makeUser(email: string, roles: Principal['roles']): Promise<Principal> {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, displayName: email.split('@')[0] as string },
    update: {},
  });
  for (const role of roles) {
    await prisma.userRole.upsert({
      where: { userId_role: { userId: user.id, role } },
      create: { userId: user.id, role },
      update: {},
    });
  }
  return { id: user.id, email: user.email, displayName: user.displayName, roles };
}

/** The client as the live tenant actually held it: stored under the trade name. */
async function seedMisnamedClient(overrides: Record<string, unknown> = {}): Promise<string> {
  const created = await prisma.client.create({
    data: {
      karbonEntityKey: `lookup-${suffix}`,
      karbonEntityType: 'Organization',
      legalName: 'Lava Grill Seton',
      karbonFullName: KARBON_FULL_NAME,
      karbonContactType: 'Client',
      karbonNameSyncedAt: new Date(),
      businessNumber: '87654 3210 RC0001',
      ...overrides,
    },
    select: { id: true },
  });
  return created.id;
}

beforeAll(async () => {
  await prisma.$connect();
  reviewer = await makeUser(`lookup-reviewer-${suffix}@test.example`, ['REVIEWER']);
  preparer = await makeUser(`lookup-preparer-${suffix}@test.example`, ['PREPARER']);
});

beforeEach(async () => {
  // The audit trail is immutable — a delete is refused by a database trigger,
  // which is the whole point of it. Each test gets a client with a new id
  // instead, so audit events scoped to that id start empty without anything
  // being removed.
  await prisma.client.deleteMany({ where: { karbonEntityKey: { startsWith: `lookup-${suffix}` } } });
  clientId = await seedMisnamedClient();
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { karbonEntityKey: { startsWith: `lookup-${suffix}` } } });
  await prisma.user.deleteMany({ where: { email: { contains: `-${suffix}@test.example` } } });
  await prisma.$disconnect();
});

describe('looking a client up', () => {
  it('finds a client by the legal name Karbon holds, which is not the one stored here', async () => {
    // The whole point. Searching this application's own columns for "2409116"
    // finds nothing, because the legal name stored is "Lava Grill Seton" — the
    // numbered company exists only in the mirror of Karbon's string.
    const found = await prisma.client.findMany({ where: clientSearchWhere('2409116') });

    expect(found.map((row) => row.id)).toContain(clientId);
  });

  it('finds the same client by the name the firm actually uses', async () => {
    const found = await prisma.client.findMany({ where: clientSearchWhere('lava grill') });

    expect(found.map((row) => row.id)).toContain(clientId);
  });

  it('finds a client by part of its business number', async () => {
    const found = await prisma.client.findMany({ where: clientSearchWhere('87654') });

    expect(found.map((row) => row.id)).toContain(clientId);
  });

  it('finds a client by its Karbon key', async () => {
    const found = await prisma.client.findMany({ where: clientSearchWhere(`lookup-${suffix}`) });

    expect(found.map((row) => row.id)).toContain(clientId);
  });

  it('does not match a client it should not', async () => {
    const found = await prisma.client.findMany({ where: clientSearchWhere(`no-such-client-${suffix}`) });

    expect(found).toEqual([]);
  });
});

describe('correcting a client legal name from Karbon', () => {
  it('adopts the legal half of the name Karbon holds', async () => {
    const result = await service.adoptKarbonLegalName({ clientId, actor: reviewer });

    expect(result.previousLegalName).toBe('Lava Grill Seton');
    expect(result.legalName).toBe('2409116 Alberta Ltd.');

    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.legalName).toBe('2409116 Alberta Ltd.');
  });

  it('keeps the trading name rather than losing it', async () => {
    // Separating a name must never discard half of it. The display name was
    // blank here, so the trading half has somewhere to go.
    const result = await service.adoptKarbonLegalName({ clientId, actor: reviewer });

    expect(result.displayNameFilled).toBe('Lava Grill Seton');

    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.displayName).toBe('Lava Grill Seton');
  });

  it('leaves a display name somebody already chose alone', async () => {
    await prisma.client.deleteMany({ where: { karbonEntityKey: `lookup-${suffix}` } });
    const chosen = await seedMisnamedClient({ displayName: 'Lava Grill (Seton location)' });

    const result = await service.adoptKarbonLegalName({ clientId: chosen, actor: reviewer });

    expect(result.displayNameFilled).toBeNull();
    const after = await prisma.client.findUniqueOrThrow({ where: { id: chosen } });
    expect(after.displayName).toBe('Lava Grill (Seton location)');
  });

  it('writes the change to the audit trail, with both names', async () => {
    // A legal name is what a client signs against. A change to it that leaves
    // no trace is indistinguishable from the import having done it, and the
    // import is documented as never doing it.
    await service.adoptKarbonLegalName({ clientId, actor: reviewer });

    const event = await prisma.auditEvent.findFirst({
      where: { objectType: 'Client', objectId: clientId, eventType: 'CLIENT_LEGAL_NAME_CORRECTED' },
    });

    expect(event).not.toBeNull();
    expect(event!.userId).toBe(reviewer.id);
    expect(event!.beforeValue).toMatchObject({ legalName: 'Lava Grill Seton' });
    expect(event!.afterValue).toMatchObject({ legalName: '2409116 Alberta Ltd.' });
  });

  it('refuses somebody without the permission, and changes nothing', async () => {
    await expect(service.adoptKarbonLegalName({ clientId, actor: preparer })).rejects.toBeInstanceOf(PermissionError);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(after.legalName).toBe('Lava Grill Seton');
  });

  it('refuses when no Karbon name has been read for the client', async () => {
    await prisma.client.update({ where: { id: clientId }, data: { karbonFullName: null } });

    await expect(service.adoptKarbonLegalName({ clientId, actor: reviewer })).rejects.toBeInstanceOf(
      PreconditionError,
    );
  });

  it('refuses a no-op rather than reporting a change that did not happen', async () => {
    await prisma.client.update({
      where: { id: clientId },
      data: { legalName: '2409116 Alberta Ltd.' },
    });

    await expect(service.adoptKarbonLegalName({ clientId, actor: reviewer })).rejects.toBeInstanceOf(
      PreconditionError,
    );

    const events = await prisma.auditEvent.count({
      where: { objectType: 'Client', objectId: clientId, eventType: 'CLIENT_LEGAL_NAME_CORRECTED' },
    });
    expect(events).toBe(0);
  });
});
