import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { ClientImportService, describeDifferences } from '@element/services';
import { MockKarbonProvider } from '@element/integrations';
import { PermissionError, PreconditionError, createLogger, type Principal } from '@element/shared';

/**
 * Bringing the firm's clients in from Karbon.
 *
 * There was no route from "Karbon holds the client list" to "this application
 * knows a client exists": `KARBON_SYNC` syncs one work item by key and creates
 * no client at all. Populating a firm with hundreds of T1s meant typing each
 * one into a form, which is the task that never gets finished — and an
 * application nobody finishes populating is one nobody uses.
 *
 * The tests are about what makes it safe to run twice: it must not overwrite a
 * client somebody has corrected, and it must not quietly fill the real client
 * list with fictional ones.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error' });
const service = new ClientImportService({ prisma, audit, logger });

const suffix = randomUUID().slice(0, 8);
const entityKeys: string[] = [];
let admin: Principal;
let readOnly: Principal;

/** Three clients on three work items, as a tenant would present them. */
function seed() {
  const keys = [`ci-org-${suffix}-1`, `ci-org-${suffix}-2`, `ci-con-${suffix}-3`];
  for (const key of keys) if (!entityKeys.includes(key)) entityKeys.push(key);

  return {
    clients: [
      {
        entityKey: keys[0]!,
        entityType: 'Organization' as const,
        legalName: 'Ziegeman Pipeline Services Ltd.',
        businessNumber: '11111 1111 RC0001',
        city: 'Calgary',
        province: 'AB',
        contacts: [
          { contactKey: `${keys[0]}-c1`, fullName: 'Dale Ziegeman', email: 'dale@example.test', isPrimary: true },
        ],
      },
      {
        entityKey: keys[1]!,
        entityType: 'Organization' as const,
        legalName: 'Northwind Holdings Ltd.',
        businessNumber: '22222 2222 RC0001',
        contacts: [],
      },
      {
        entityKey: keys[2]!,
        entityType: 'Contact' as const,
        legalName: 'Robin Fournier',
        contacts: [{ contactKey: `${keys[2]}-c1`, fullName: 'Robin Fournier', email: 'robin@example.test' }],
      },
    ],
    workItems: keys.map((key, index) => ({
      workItemKey: `ci-wi-${suffix}-${index}`,
      title: `Year-end ${index}`,
      clientKey: key,
    })),
  };
}

/** A Karbon that reports itself real, since a mock is refused by design. */
function connectedKarbon(): MockKarbonProvider {
  const inner = new MockKarbonProvider(seed());
  return Object.create(inner, { isMock: { value: false, enumerable: true } }) as MockKarbonProvider;
}

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

beforeAll(async () => {
  await prisma.$connect();
  admin = await makeUser(`import-admin-${suffix}@test.example`, ['PREPARER']);
  readOnly = await makeUser(`import-reader-${suffix}@test.example`, ['READ_ONLY']);
});

beforeEach(async () => {
  seed(); // registers the keys for cleanup
  await prisma.client.deleteMany({ where: { karbonEntityKey: { in: entityKeys } } });
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { karbonEntityKey: { in: entityKeys } } });
  await prisma.user.deleteMany({ where: { email: { contains: `-${suffix}@test.example` } } });
  await prisma.$disconnect();
});

describe('importing clients from Karbon', () => {
  it('adds the clients it finds, with their contacts', async () => {
    const result = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });

    expect(result.found).toBeGreaterThan(0);
    expect(result.created.length).toBe(result.found);

    const created = await prisma.client.findMany({
      where: { karbonEntityKey: { in: result.created.map((entry) => entry.entityKey) } },
      include: { contacts: true },
    });
    expect(created.length).toBe(result.created.length);
    expect(created.every((client) => client.karbonEntityKey && client.legalName.length > 0)).toBe(true);
  });

  it('changes nothing on a dry run', async () => {
    const preview = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: true });

    expect(preview.dryRun).toBe(true);
    expect(preview.created.length).toBeGreaterThan(0);

    const stored = await prisma.client.count({
      where: { karbonEntityKey: { in: preview.created.map((entry) => entry.entityKey) } },
    });
    expect(stored).toBe(0);
  });

  it('keeps the unsplit name Karbon holds, for a client it will not otherwise touch', async () => {
    // The one client field the import overwrites, and the reason it must.
    //
    // A legal name here is protected because somebody may have corrected it.
    // That protection cost the answer: the import read Karbon's string,
    // compared it, reported a difference and discarded it, so nothing
    // afterwards could say what Karbon actually calls the client. Keeping it is
    // what makes the client findable by the only name the firm uses.
    const first = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });
    const target = first.created[0]!;

    await prisma.client.update({
      where: { karbonEntityKey: target.entityKey },
      data: { legalName: 'Corrected Legal Name Ltd.', karbonFullName: null, karbonNameSyncedAt: null },
    });

    await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });

    const after = await prisma.client.findUniqueOrThrow({ where: { karbonEntityKey: target.entityKey } });
    // The correction survives, and Karbon's own name is now recorded beside it.
    expect(after.legalName).toBe('Corrected Legal Name Ltd.');
    expect(after.karbonFullName).toBe('Ziegeman Pipeline Services Ltd.');
    expect(after.karbonNameSyncedAt).not.toBeNull();
  });

  it('does not refresh the Karbon name on a preview, and says so', async () => {
    // A preview writes nothing. Without the note, the first preview after this
    // shipped would look like the new column had silently failed to populate.
    const first = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });
    const target = first.created[0]!;

    await prisma.client.update({
      where: { karbonEntityKey: target.entityKey },
      data: { karbonFullName: null, karbonNameSyncedAt: null },
    });

    const preview = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: true });

    const after = await prisma.client.findUniqueOrThrow({ where: { karbonEntityKey: target.entityKey } });
    expect(after.karbonFullName).toBeNull();
    expect(preview.notes.some((note) => note.includes('does not refresh what Karbon calls each client'))).toBe(true);
  });

  it('running it twice does not duplicate anybody', async () => {
    await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });
    const second = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });

    expect(second.created).toEqual([]);
    expect(second.unchanged + second.differing.length).toBe(second.found);
  });

  it('never overwrites a client somebody has corrected', async () => {
    // Karbon is the system of record for documents, not for the details that
    // go into a legal document. A legal name corrected from the CRA notice
    // must survive a re-import, or the correction has to be made again every
    // time — and nobody would notice it had been undone.
    const first = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });
    const target = first.created[0]!;

    await prisma.client.update({
      where: { karbonEntityKey: target.entityKey },
      data: { legalName: 'Corrected Legal Name Ltd.', businessNumber: '99999 9999 RC0001' },
    });

    const second = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });

    const after = await prisma.client.findUniqueOrThrow({ where: { karbonEntityKey: target.entityKey } });
    expect(after.legalName).toBe('Corrected Legal Name Ltd.');
    expect(after.businessNumber).toBe('99999 9999 RC0001');

    // And the difference is reported rather than swallowed, so somebody can decide.
    const reported = second.differing.find((entry) => entry.entityKey === target.entityKey);
    expect(reported).toBeDefined();
    expect(reported!.differences.some((difference) => difference.field === 'Legal name')).toBe(true);
  });

  it('fills in contacts a client is missing, because that is not overwriting', async () => {
    // The defect this covers, found on the live deployment: the firm's whole
    // book was imported while the Karbon client read was returning no contacts
    // at all — the API omits them unless asked. Every re-run afterwards saw
    // those clients as "already here" and moved on, so the contacts would never
    // have arrived, and a client with no contact has nobody to address an
    // engagement letter to. Re-running the import has to be able to repair it.
    const first = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });
    const target = first.created.find((client) => client.legalName.startsWith('Ziegeman'))!;

    await prisma.clientContact.deleteMany({ where: { client: { karbonEntityKey: target.entityKey } } });
    await prisma.client.update({
      where: { karbonEntityKey: target.entityKey },
      data: { city: null, province: null },
    });

    const second = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });

    const after = await prisma.client.findUniqueOrThrow({
      where: { karbonEntityKey: target.entityKey },
      include: { contacts: true },
    });
    expect(after.contacts).toHaveLength(1);
    expect(after.contacts[0]!.email).toBe('dale@example.test');
    expect(after.city).toBe('Calgary');
    expect(after.province).toBe('AB');

    const reported = second.backfilled.find((entry) => entry.entityKey === target.entityKey);
    expect(reported).toMatchObject({ contactsAdded: 1 });
    expect(reported!.fieldsFilled).toEqual(expect.arrayContaining(['City', 'Province']));
  });

  it('adds a contact once, however many times it runs', async () => {
    // Matched on Karbon's own contact key. Without that, repairing the missing
    // contacts would hand every client a duplicate on each subsequent run.
    await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });
    await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });
    const third = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });

    const clients = await prisma.client.findMany({
      where: { karbonEntityKey: { in: entityKeys } },
      include: { contacts: true },
    });
    for (const client of clients) {
      const keys = client.contacts.map((contact) => contact.karbonContactKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(third.backfilled).toHaveLength(0);
  });

  it('leaves a value somebody supplied alone, even while filling the blanks beside it', async () => {
    // The two rules have to hold at once: repair what is missing, protect what
    // is not. A postal code typed by hand and a missing contact can sit on the
    // same client, and one run must handle both correctly.
    const first = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });
    const target = first.created.find((client) => client.legalName.startsWith('Ziegeman'))!;

    await prisma.clientContact.deleteMany({ where: { client: { karbonEntityKey: target.entityKey } } });
    await prisma.client.update({
      where: { karbonEntityKey: target.entityKey },
      data: { city: 'Airdrie', businessNumber: '99999 9999 RC0001' },
    });

    await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });

    const after = await prisma.client.findUniqueOrThrow({
      where: { karbonEntityKey: target.entityKey },
      include: { contacts: true },
    });
    expect(after.city).toBe('Airdrie');
    expect(after.businessNumber).toBe('99999 9999 RC0001');
    expect(after.contacts).toHaveLength(1);
  });

  it('changes nothing on a dry run, including the backfill', async () => {
    const first = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });
    const target = first.created[0]!;
    await prisma.clientContact.deleteMany({ where: { client: { karbonEntityKey: target.entityKey } } });

    const preview = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: true });

    expect(preview.backfilled.length).toBeGreaterThan(0);
    const after = await prisma.client.findUniqueOrThrow({
      where: { karbonEntityKey: target.entityKey },
      include: { contacts: true },
    });
    expect(after.contacts).toHaveLength(0);
  });

  it('says what an unreadable client key actually is, rather than only that it failed', async () => {
    // A live import reported "2 could not be read" and stopped there — a count
    // with no cause, for two clients no engagement can ever be started for.
    // Karbon has a third client entity, ClientGroup, which this application
    // deliberately does not model; whether that is the explanation is worth a
    // request rather than a guess.
    const karbon = connectedKarbon();
    const ghostKey = `ci-ghost-${suffix}`;
    if (!entityKeys.includes(ghostKey)) entityKeys.push(ghostKey);

    const probed: string[] = [];
    const withDiagnosis = Object.create(karbon, {
      searchWorkItems: {
        value: async () => [{ workItemKey: `ci-wi-ghost-${suffix}`, title: 'Orphan', clientKey: ghostKey }],
      },
      getClient: { value: async () => null },
      describeUnresolvedClient: {
        value: async (key: string) => {
          probed.push(key);
          return 'this key is a Karbon Client Group ("The Ziegeman Group"), not an organisation or a contact.';
        },
      },
    }) as typeof karbon;

    const result = await service.run({ karbon: withDiagnosis, actor: admin, dryRun: true, source: 'WORK_ITEMS' });

    expect(probed).toEqual([ghostKey]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.reason).toMatch(/Client Group/i);
  });

  it('still reports a failure when the diagnosis itself fails', async () => {
    // The diagnostic is a convenience. If it throws, the import must still
    // report the client as unreadable rather than losing the whole run.
    const karbon = connectedKarbon();
    const ghostKey = `ci-ghost2-${suffix}`;
    if (!entityKeys.includes(ghostKey)) entityKeys.push(ghostKey);

    const withBrokenDiagnosis = Object.create(karbon, {
      searchWorkItems: {
        value: async () => [{ workItemKey: `ci-wi-ghost2-${suffix}`, title: 'Orphan', clientKey: ghostKey }],
      },
      getClient: { value: async () => null },
      describeUnresolvedClient: {
        value: async () => {
          throw new Error('the tenant refused the lookup');
        },
      },
    }) as typeof karbon;

    const result = await service.run({
      karbon: withBrokenDiagnosis,
      actor: admin,
      dryRun: true,
      source: 'WORK_ITEMS',
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.entityKey).toBe(ghostKey);
  });

  it('refuses to import from a mock, which would invent clients', async () => {
    // The failure this prevents: fictional sample clients in the real client
    // list, indistinguishable from the firm's own and sitting in the
    // engagement list for ever.
    await expect(
      service.run({ karbon: new MockKarbonProvider(seed()), actor: admin, dryRun: false }),
    ).rejects.toThrow(PreconditionError);

    await expect(
      service.run({ karbon: new MockKarbonProvider(seed()), actor: admin, dryRun: true }),
    ).rejects.toThrow(/not connected/i);
  });

  it('is not something a read-only user may do', async () => {
    await expect(
      service.run({ karbon: connectedKarbon(), actor: readOnly, dryRun: true }),
    ).rejects.toThrow(PermissionError);
  });

  it('looks only as deep as it was asked to, and says the supply was not exhausted', async () => {
    // Clients are derived from work items, so the depth decides how much of the
    // firm's book can be seen at all. Asking for one work item must find one
    // client, not all three — otherwise the limit is decorative.
    const result = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: true, limit: 1 });

    expect(result.found).toBe(1);
    expect(result.notes.join(' ')).toMatch(/more clients beyond them/i);
    // A warning a reader cannot act on is an apology. It must name the control
    // that answers it, which is the whole reason the limit is now settable.
    expect(result.notes.join(' ')).toMatch(/records to examine/i);
  });

  it('says nothing about depth when the supply ran out first', async () => {
    // Three clients against a limit of two hundred: the ceiling never bound, so
    // warning about it would train people to ignore the warning.
    const result = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: true });

    expect(result.found).toBe(3);
    // Specifically no depth warning. Other notes are legitimate — the contact
    // type breakdown is reported on every client-list run — so asserting the
    // whole array is empty would pin unrelated behaviour to this test.
    expect(result.notes.join(' ')).not.toMatch(/more clients beyond them|records to examine/i);
  });

  it('refuses a depth that is not a positive whole number', async () => {
    for (const limit of [0, -5, 1.5]) {
      await expect(
        service.run({ karbon: connectedKarbon(), actor: admin, dryRun: true, limit }),
      ).rejects.toThrow(PreconditionError);
    }
  });

  it('caps a depth beyond what the search can page through, and says it did', async () => {
    // Honouring 50,000 would promise a depth the Karbon client cannot reach,
    // so the number is lowered and the lowering is reported rather than silent.
    const result = await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: true, limit: 50_000 });

    expect(result.notes.join(' ')).toMatch(/5000 is the most one import can examine/i);
    expect(result.found).toBe(3);
  });

  it('finds a client that has no work item at all', async () => {
    // The defect this covers, reported from the live deployment: discovery ran
    // entirely through work items, so a client nobody had opened work for was
    // invisible however deep the search went. Karbon publishes /Organizations
    // and /Contacts for exactly this question and neither was ever called.
    //
    // A dormant client and a brand-new one are both normal for a tax firm, so
    // this is not an edge case — it is a slice of every firm's book.
    const seeded = seed();
    const dormantKey = `ci-org-${suffix}-dormant`;
    entityKeys.push(dormantKey);

    const karbon = Object.create(
      new MockKarbonProvider({
        clients: [
          ...seeded.clients,
          {
            entityKey: dormantKey,
            entityType: 'Organization' as const,
            legalName: 'Dormant Holdings Ltd.',
            contacts: [],
          },
        ],
        // Deliberately unchanged: no work item names the dormant client.
        workItems: seeded.workItems,
      }),
      { isMock: { value: false, enumerable: true } },
    ) as MockKarbonProvider;

    const viaWorkItems = await service.run({ karbon, actor: admin, dryRun: true, source: 'WORK_ITEMS' });
    expect(viaWorkItems.created.map((entry) => entry.entityKey)).not.toContain(dormantKey);

    const viaClientList = await service.run({ karbon, actor: admin, dryRun: true, source: 'CLIENT_LIST' });
    expect(viaClientList.created.map((entry) => entry.entityKey)).toContain(dormantKey);

    // And the narrower source says it is narrow, rather than reporting a count
    // that reads like the whole client list.
    expect(viaWorkItems.notes.join(' ')).toMatch(/only clients somebody has opened work for/i);
  });

  it('defaults to the client list, not to work items', async () => {
    // Which source is the default decides whether a firm's first import is
    // complete or quietly partial, so it is worth pinning rather than assuming.
    const karbon = connectedKarbon();
    await service.run({ karbon, actor: admin, dryRun: true });

    expect(karbon.calls.some((call) => call.operation === 'listClients')).toBe(true);
    expect(karbon.calls.some((call) => call.operation === 'searchWorkItems')).toBe(false);
  });

  it('treats the limit as a total across both entity types', async () => {
    // Found by the live run, not by a test: asking for 25 returned 50, because
    // the limit went to /Organizations and /Contacts whole instead of being
    // shared. A cap that quietly means twice what the caller said is worse than
    // no cap, because the number is trusted.
    const karbon = connectedKarbon();
    const list = await karbon.listClients({ limit: 2 });

    expect(list.clients).toHaveLength(2);
    // Three seeded clients against a limit of two: something was left behind,
    // and the result has to say so rather than leaving the reader to infer it.
    expect(list.more).toBe(true);
  });

  it('says the client list is complete when it is', async () => {
    // The opposite case matters as much. A "there may be more" on a list that is
    // already whole teaches people to ignore the warning.
    const karbon = connectedKarbon();
    const list = await karbon.listClients({ limit: 500 });

    expect(list.clients.length).toBeGreaterThan(0);
    expect(list.more).toBe(false);
  });

  /** The live tenant's two types, one of each, plus the ordinary seed. */
  function karbonWithInactive(): MockKarbonProvider {
    const seeded = seed();
    const inactiveKey = `ci-org-${suffix}-inactive`;
    if (!entityKeys.includes(inactiveKey)) entityKeys.push(inactiveKey);

    return Object.create(
      new MockKarbonProvider({
        clients: [
          ...seeded.clients,
          {
            entityKey: inactiveKey,
            entityType: 'Organization' as const,
            legalName: 'Retired Holdings Ltd.',
            contactType: 'Inactive',
            contacts: [],
          },
        ],
        workItems: seeded.workItems,
      }),
      { isMock: { value: false, enumerable: true } },
    ) as MockKarbonProvider;
  }

  it('does not import a dissolved corporation, which cannot sign anything', async () => {
    // Stronger than Inactive: an inactive client is a judgement about the
    // relationship, a dissolved corporation has no legal existence and cannot be
    // a party to an engagement letter at all.
    const seeded = seed();
    const dissolvedKey = `ci-org-${suffix}-dissolved`;
    if (!entityKeys.includes(dissolvedKey)) entityKeys.push(dissolvedKey);
    const otherKey = `ci-org-${suffix}-other`;
    if (!entityKeys.includes(otherKey)) entityKeys.push(otherKey);

    const karbon = Object.create(
      new MockKarbonProvider({
        clients: [
          ...seeded.clients,
          {
            entityKey: dissolvedKey,
            entityType: 'Organization' as const,
            legalName: 'Wound Up Holdings Ltd.',
            contactType: 'Dissolved',
            contacts: [],
          },
          {
            entityKey: otherKey,
            entityType: 'Organization' as const,
            legalName: 'Unclassified Ltd.',
            contactType: 'Other',
            contacts: [],
          },
        ],
        workItems: seeded.workItems,
      }),
      { isMock: { value: false, enumerable: true } },
    ) as MockKarbonProvider;

    const result = await service.run({ karbon, actor: admin, dryRun: true });

    expect(result.created.map((entry) => entry.entityKey)).not.toContain(dissolvedKey);
    expect(result.skippedByContactType).toEqual([{ contactType: 'Dissolved', count: 1 }]);

    // `Other` says nothing about whether the entry is a client, so excluding it
    // would be the guess the exclusion list exists to rule out.
    expect(result.created.map((entry) => entry.entityKey)).toContain(otherKey);
  });

  it('does not import a client Karbon marks Inactive', async () => {
    const result = await service.run({ karbon: karbonWithInactive(), actor: admin, dryRun: true });

    expect(result.created.map((entry) => entry.legalName)).not.toContain('Retired Holdings Ltd.');
    expect(result.skippedByContactType).toEqual([{ contactType: 'Inactive', count: 1 }]);
  });

  it('never skips silently, and says how to undo it', async () => {
    // A client absent from the list with no explanation is the failure this area
    // keeps producing. Excluding by label is only defensible if the person can
    // see it was applied, to how many, and how to reverse it.
    const result = await service.run({ karbon: karbonWithInactive(), actor: admin, dryRun: true });

    const notes = result.notes.join(' ');
    expect(notes).toMatch(/skipped 1 Inactive/i);
    expect(notes).toMatch(/include every contact type/i);
  });

  it('imports the excluded types when asked to', async () => {
    // A current client left labelled Inactive in Karbon must not be unreachable.
    const result = await service.run({
      karbon: karbonWithInactive(),
      actor: admin,
      dryRun: true,
      includeAllContactTypes: true,
    });

    expect(result.created.map((entry) => entry.legalName)).toContain('Retired Holdings Ltd.');
    expect(result.skippedByContactType).toEqual([]);
  });

  it('matches a contact type regardless of case or padding', async () => {
    // A type is a label somebody typed into Karbon, so "inactive " has to count.
    const seeded = seed();
    const key = `ci-org-${suffix}-lowercase`;
    if (!entityKeys.includes(key)) entityKeys.push(key);

    const karbon = Object.create(
      new MockKarbonProvider({
        clients: [
          ...seeded.clients,
          {
            entityKey: key,
            entityType: 'Organization' as const,
            legalName: 'Lowercase Inactive Ltd.',
            contactType: '  inactive ',
            contacts: [],
          },
        ],
        workItems: seeded.workItems,
      }),
      { isMock: { value: false, enumerable: true } },
    ) as MockKarbonProvider;

    const result = await service.run({ karbon, actor: admin, dryRun: true });

    expect(result.created.map((entry) => entry.entityKey)).not.toContain(key);
    // Reported as the tenant spells it, not as the constant does.
    expect(result.skippedByContactType).toEqual([{ contactType: 'inactive', count: 1 }]);
  });

  it('counts every contact type it saw, including the ones it skipped', async () => {
    // The live tenant labels contacts `Client` and `Inactive`. The breakdown is
    // of what Karbon holds, not of what was imported — a reader working out why
    // 63 became 54 needs the population, and reporting only the kept types would
    // describe the outcome while hiding the cause.
    const result = await service.run({ karbon: karbonWithInactive(), actor: admin, dryRun: true });

    const notes = result.notes.join(' ');
    expect(notes).toMatch(/contact types among them/i);
    expect(notes).toMatch(/3 Client/);
    expect(notes).toMatch(/1 Inactive/);
  });

  it('says when a trading name was separated off a legal name', async () => {
    // Rewriting a legal name silently is not better than importing a wrong one.
    // The reader has to be able to see it happened and spot-check a few, because
    // the value ends up printed on an engagement letter.
    const seeded = seed();
    const key = `ci-org-${suffix}-trade`;
    if (!entityKeys.includes(key)) entityKeys.push(key);

    const karbon = Object.create(
      new MockKarbonProvider({
        clients: [
          ...seeded.clients,
          {
            entityKey: key,
            entityType: 'Organization' as const,
            legalName: '2140071 Alberta Ltd.',
            tradeName: 'JC Spa and Wellness',
            contacts: [],
          },
        ],
        workItems: seeded.workItems,
      }),
      { isMock: { value: false, enumerable: true } },
    ) as MockKarbonProvider;

    const result = await service.run({ karbon, actor: admin, dryRun: false });

    expect(result.notes.join(' ')).toMatch(/1 name\(s\) carried a trading name in brackets/i);

    // The legal entity is what was stored, and the trading name was kept rather
    // than thrown away.
    const stored = await prisma.client.findUniqueOrThrow({ where: { karbonEntityKey: key } });
    expect(stored.legalName).toBe('2140071 Alberta Ltd.');
    expect(stored.displayName).toBe('JC Spa and Wellness');
  });

  it('previews without reading every client it would add', async () => {
    // The defect this covers, reported from the live tenant: a preview of 1,000
    // spent one throttled Karbon read per candidate. At the documented 120
    // requests a minute that is over eight minutes inside a page request, so it
    // never returned — and the depth control offering 5,000 made it worse.
    //
    // A dry run does not need the detail for a client it will only report as
    // "would be added": the client list already carried the key and the name.
    const karbon = connectedKarbon();

    const preview = await service.run({ karbon, actor: admin, dryRun: true });

    expect(preview.created.length).toBe(3);
    // The cost, which is the whole point. Nothing here is already stored, so a
    // correct preview reads none of them individually.
    expect(karbon.calls.filter((call) => call.operation === 'getClient')).toHaveLength(0);
    // And it still reports real names rather than bare keys.
    expect(preview.created.map((entry) => entry.legalName)).toContain('Ziegeman Pipeline Services Ltd.');
  });

  it('still reads the clients it already holds, because those are compared', async () => {
    // The saving applies only to clients that would be created. An existing one
    // has to be fetched to be compared against and to have blanks filled, and
    // skipping that would trade a timeout for a wrong answer.
    await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });

    const karbon = connectedKarbon();
    const second = await service.run({ karbon, actor: admin, dryRun: true });

    expect(second.created).toEqual([]);
    expect(karbon.calls.filter((call) => call.operation === 'getClient').length).toBeGreaterThan(0);
  });

  it('bounds how many stored clients a preview re-reads', async () => {
    // The defect this covers: a preview reads every client it already holds, to
    // compare and to find blanks — so its cost grows with every successful
    // import. Cheap at sixty stored, a timeout once a whole book is in. The same
    // shape as the unqueued import, arriving exactly when the import succeeds.
    await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });

    const karbon = connectedKarbon();
    const result = await service.run({
      karbon,
      actor: admin,
      dryRun: true,
      maxComparedPerPreview: 1,
    });

    // One compared, the rest left alone — and said out loud rather than quietly
    // omitted, because a partial comparison reported as a whole answer is the
    // mistake the client-list count already made once.
    expect(karbon.calls.filter((call) => call.operation === 'getClient')).toHaveLength(1);
    expect(result.notes.join(' ')).toMatch(/Compared 1 of the 3 clients already here/i);
  });

  it('compares every stored client on a real import, which nothing is waiting on', async () => {
    // The bound is about a request, and the import runs in the worker. Capping
    // it there would leave blanks unfilled for no reason.
    await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: false });

    const karbon = connectedKarbon();
    await service.run({ karbon, actor: admin, dryRun: false, maxComparedPerPreview: 1 });

    expect(karbon.calls.filter((call) => call.operation === 'getClient').length).toBeGreaterThan(1);
  });

  it('says what differs, not merely how many do', async () => {
    // The screen promises that differences are reported so you can decide.
    // They were computed, returned and dropped, so it reported a count and
    // nothing to decide with. The legal name matters most of all: it is one of
    // the compared fields and prints verbatim into a legal document.
    const lines = describeDifferences([
      {
        entityKey: 'k1',
        legalName: '2100698 Albeta Ltd.',
        differences: [
          { field: 'Legal name', here: '2100698 Albeta Ltd.', inKarbon: '2100698 Alberta Ltd.' },
          { field: 'City', here: null, inKarbon: 'Calgary' },
        ],
      },
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('2100698 Albeta Ltd.');
    expect(lines[0]).toContain('Legal name');
    // Both sides, because which one is right is the reader's call, not ours.
    expect(lines[0]).toMatch(/here .*Albeta Ltd\./);
    expect(lines[0]).toMatch(/Karbon .*Alberta Ltd\./);
    expect(lines[0]).toContain('City');
  });

  it('cuts a very long difference list short, and says that it did', async () => {
    const many = Array.from({ length: 14 }, (_, index) => ({
      entityKey: `k${index}`,
      legalName: `Client ${index}`,
      differences: [{ field: 'City', here: 'Calgary', inKarbon: 'Edmonton' }],
    }));

    const lines = describeDifferences(many);

    // Ten described, plus one line accounting for the rest — a silent cut would
    // under-report differences somebody is deciding about.
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toContain('4 more client(s)');
  });

  it('records what it did, and says so on a dry run too', async () => {
    await service.run({ karbon: connectedKarbon(), actor: admin, dryRun: true });

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { objectType: 'Client', userId: admin.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(event.reason).toMatch(/previewed/i);
    expect((event.afterValue as { dryRun?: boolean }).dryRun).toBe(true);
  });
});
