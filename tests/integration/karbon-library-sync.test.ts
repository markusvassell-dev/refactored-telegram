import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@element/database';
import { createAuditLogger } from '@element/audit';
import { createLogger } from '@element/shared';
import { MockKarbonProvider, BlockedKarbonProvider } from '@element/integrations';
import { KarbonLibraryService } from '@element/services';

/**
 * Cataloguing a client's Karbon documents.
 *
 * The behaviour worth pinning is not the happy path. It is that a read which
 * partly failed is recorded as incomplete, and that a file Karbon stops listing
 * does not silently vanish from the catalogue — because both cases otherwise
 * present as a smaller number that looks exactly like the truth.
 */

const prisma = new PrismaClient();
const audit = createAuditLogger(prisma);
const logger = createLogger({ level: 'error', base: { service: 'test' } });
const library = new KarbonLibraryService({ prisma, audit, logger });

const clientIds: string[] = [];

async function makeClient(legalName: string, karbonEntityKey: string | null): Promise<string> {
  const client = await prisma.client.create({
    data: { legalName, karbonEntityKey, karbonEntityType: karbonEntityKey ? 'Organization' : null },
    select: { id: true },
  });
  clientIds.push(client.id);
  return client.id;
}

beforeAll(async () => {
  await prisma.$connect();
  // A previous run that died partway leaves clients behind, and the Karbon key
  // is unique, so the next run fails on the fixture rather than on the code.
  await prisma.client.deleteMany({ where: { karbonEntityKey: { startsWith: 'ORG_CAT_' } } });
  await prisma.client.deleteMany({ where: { legalName: { in: ['Unlinked Ltd.'] } } });
});

afterAll(async () => {
  await prisma.karbonClientDocument.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.karbonLibrarySync.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.$disconnect();
});

describe('syncing a client document library', () => {
  it('catalogues documents from every scope, with where each was filed', async () => {
    const clientId = await makeClient('Catalogue Test Holdings Ltd.', 'ORG_CAT_1');

    const karbon = new MockKarbonProvider({
      clients: [
        {
          entityKey: 'ORG_CAT_1',
          entityType: 'Organization',
          legalName: 'Catalogue Test Holdings Ltd.',
          contacts: [{ contactKey: 'CON_CAT_1', fullName: 'Pat Director' }],
        },
      ],
      workItems: [
        { workItemKey: 'WI_CAT_1', title: '2024 T2 Tax Return', clientKey: 'ORG_CAT_1' },
        { workItemKey: 'WI_CAT_2', title: 'Bookkeeping', clientKey: 'ORG_CAT_1' },
      ],
      documents: [
        { documentId: 'DOC_ORG', fileName: 'incorporation.pdf', entityKey: 'ORG_CAT_1' },
        { documentId: 'DOC_CON', fileName: 'id.pdf', entityKey: 'CON_CAT_1' },
        { documentId: 'DOC_WI1', fileName: 'engagement-letter.pdf', workItemKey: 'WI_CAT_1' },
        { documentId: 'DOC_WI2', fileName: 'ledger.xlsx', workItemKey: 'WI_CAT_2' },
      ],
    });

    const result = await library.sync({ clientId, karbon });

    expect(result.documentsFound).toBe(4);
    expect(result.documentsNew).toBe(4);
    expect(result.complete).toBe(true);

    const rows = await prisma.karbonClientDocument.findMany({
      where: { clientId },
      orderBy: { fileName: 'asc' },
    });
    expect(rows).toHaveLength(4);

    const letter = rows.find((row) => row.fileName === 'engagement-letter.pdf');
    // Provenance, not just the file: "which of these is last year's letter" is
    // the question being asked, and a filename cannot answer it.
    expect(letter?.sourceLabel).toBe('2024 T2 Tax Return');
    expect(letter?.sourceEntityType).toBe('WorkItem');
    expect(letter?.inferredTaxYear).toBe(2024);

    // A work item with no year in its title leaves the year unknown rather
    // than inheriting one from somewhere else.
    const ledger = rows.find((row) => row.fileName === 'ledger.xlsx');
    expect(ledger?.inferredTaxYear).toBeNull();
  });

  it('is safe to run twice, and keeps a file Karbon stops listing', async () => {
    const clientId = await makeClient('Rerun Test Ltd.', 'ORG_CAT_2');

    const seed = {
      clients: [
        {
          entityKey: 'ORG_CAT_2',
          entityType: 'Organization' as const,
          legalName: 'Rerun Test Ltd.',
          contacts: [],
        },
      ],
      workItems: [],
      documents: [
        { documentId: 'DOC_KEEP', fileName: 'keep.pdf', entityKey: 'ORG_CAT_2' },
        { documentId: 'DOC_GONE', fileName: 'gone.pdf', entityKey: 'ORG_CAT_2' },
      ],
    };

    const first = await library.sync({ clientId, karbon: new MockKarbonProvider(seed) });
    expect(first.documentsNew).toBe(2);

    // Karbon no longer lists one of them.
    const second = await library.sync({
      clientId,
      karbon: new MockKarbonProvider({ ...seed, documents: [seed.documents[0]!] }),
    });

    expect(second.documentsFound).toBe(1);
    // Nothing new: re-reading must not duplicate the catalogue.
    expect(second.documentsNew).toBe(0);

    const rows = await prisma.karbonClientDocument.findMany({ where: { clientId } });
    // The vanished file keeps its row. Deleting it would make "removed from
    // Karbon" indistinguishable from "never there", and a document leaving a
    // client's file is something somebody needs to be able to notice.
    expect(rows).toHaveLength(2);

    const kept = rows.find((row) => row.karbonFileKey === 'DOC_KEEP');
    const gone = rows.find((row) => row.karbonFileKey === 'DOC_GONE');
    expect(gone!.lastSeenAt.getTime()).toBeLessThan(kept!.lastSeenAt.getTime());
  });

  it('refuses a client with no Karbon link rather than reporting zero documents', async () => {
    const clientId = await makeClient('Unlinked Ltd.', null);

    await expect(library.sync({ clientId, karbon: new MockKarbonProvider() })).rejects.toThrow(/not linked to Karbon/i);

    // And records nothing, so an unlinked client never shows a catalogue that
    // would read as "Karbon holds nothing for them".
    const rows = await prisma.karbonClientDocument.findMany({ where: { clientId } });
    expect(rows).toHaveLength(0);
  });

  it('records a blocked provider as an incomplete read, not an empty client', async () => {
    const clientId = await makeClient('Blocked Provider Ltd.', 'ORG_CAT_3');

    const result = await library.sync({
      clientId,
      karbon: new BlockedKarbonProvider('Karbon is not configured in this environment'),
    });

    expect(result.documentsFound).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.failures).toHaveLength(1);

    const sync = await prisma.karbonLibrarySync.findFirst({
      where: { clientId },
      orderBy: { startedAt: 'desc' },
    });

    // The screen reads this row. Zero documents with `complete: true` would
    // tell a reviewer this client has nothing filed in Karbon — a claim about
    // the firm's data made by an adapter that never looked at it.
    expect(sync?.complete).toBe(false);
    expect(sync?.scopesFailed).toBe(1);
    expect(sync?.finishedAt).not.toBeNull();
  });
});
